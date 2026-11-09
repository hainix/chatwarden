import { randomBytes } from 'node:crypto';
import type { EvidenceBuffer, RoomRoster } from './evidence.js';
import { safeWarn } from './log.js';
import type { SubjectIndex } from './subjects.js';
import type {
  Clock,
  Logger,
  ReportCategory,
  ReportExcerptLine,
  Store,
  StoredReport,
  SubjectId,
} from './types.js';

// Report intake. A player reports another from a seat; the relay snapshots the chat it witnessed itself
// (the evidence buffer) and stores it with the report. Nothing here returns an identifier to a player: a
// result carries a report id, a remaining count, or a refusal reason. Behaviour follows Moxgate's
// `handleReport`, with identities mapped onto canonical subjects.

export type { StoredReport } from './types.js';

const DAY_MS = 24 * 3_600_000;
const WEEK_MS = 7 * DAY_MS;

/** Reports one person may file in any 24 hours. */
export const REPORTS_PER_DAY = 10;

/** Bad-faith dismissals inside the window that suspend a reporter. */
export const SUSPEND_AFTER = 3;

/** How long (30 days, from `actioned_at`) a bad-faith dismissal weighs. */
export const SUSPEND_WINDOW_MS = 30 * DAY_MS;

/** A note is trimmed, then cut to this many characters. */
export const REPORT_NOTE_MAX = 500;

/** Every category a report can carry; anything else is stored as `'other'`. */
export const REPORT_CATEGORIES: readonly ReportCategory[] = ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'];

/** Why a report was not taken. In the order they are checked. */
export type ReportRefusal = 'off' | 'not_player' | 'self' | 'suspended' | 'rate' | 'duplicate';

export interface ReportInput {
  roomId: string;
  /** The seat the reporter sits in. */
  reporterSeat: string;
  /** The seat reported. Ignored when `lineId` names a line still in the evidence buffer. */
  targetSeat: string;
  category: ReportCategory;
  note?: string;
  lineId?: string;
}

export type ReportResult =
  /** `remaining` is how many more reports the reporter may file today, this one counted. */
  | { ok: true; reportId: string; remaining: number }
  /** `remaining` is present on `'rate'` (always 0). */
  | { ok: false; refused: ReportRefusal; remaining?: number };

/** What `onReport` is told about the reported person (across merged aliases) besides the report itself. */
export interface ReportCounts {
  /** Reports against the person in the last 7 days, this one included. */
  reports7d: number;
  /** Distinct rooms among those reports. */
  rooms7d: number;
  /** Distinct automatic chat restrictions (source `auto_filter`) placed on the person in the last 7 days. */
  auto7d: number;
}

export interface ReportServiceDeps {
  roster: RoomRoster;
  buffer: EvidenceBuffer;
  subjects: SubjectIndex;
  store: Store;
  clock: Clock;
  /** Read per call, so a kill switch works live. Defaults to always on. */
  enabled?: () => boolean;
  /**
   * Called once for each stored report, after the result is decided. Fenced: a synchronous throw or an async
   * rejection is logged and never reaches the reporter. It receives a copy of the report.
   * Carries subject ids: staff channels only, never send to a player.
   */
  onReport?: (report: StoredReport, counts: ReportCounts) => void;
  logger?: Logger;
}

const newId = (): string => randomBytes(16).toString('base64url');

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

const present = (id: SubjectId | null | undefined): id is SubjectId => typeof id === 'string' && id !== '';

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';

const isUniqueViolation = (err: unknown): boolean => err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

const refuse = (refused: ReportRefusal, remaining?: number): ReportResult =>
  remaining === undefined ? { ok: false, refused } : { ok: false, refused, remaining };

/** Trimmed, cut to {@link REPORT_NOTE_MAX} without splitting a surrogate pair; null when nothing is left. */
function cleanNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let note = raw.trim();
  if (note.length > REPORT_NOTE_MAX) {
    note = note.slice(0, REPORT_NOTE_MAX);
    const last = note.charCodeAt(note.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) note = note.slice(0, -1);
  }
  return note === '' ? null : note;
}

const copyReport = (r: StoredReport): StoredReport => ({
  ...r,
  tags: { ...r.tags },
  excerpt: r.excerpt.map((l) => ({ ...l, audience: l.audience === null ? null : [...l.audience] })),
  people: [...r.people],
});

export class ReportService {
  private readonly roster: RoomRoster;
  private readonly buffer: EvidenceBuffer;
  private readonly subjects: SubjectIndex;
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly enabled: () => boolean;
  private readonly onReport: ReportServiceDeps['onReport'];
  private readonly logger: Logger | undefined;

  constructor(deps: ReportServiceDeps) {
    this.roster = deps.roster;
    this.buffer = deps.buffer;
    this.subjects = deps.subjects;
    this.store = deps.store;
    this.clock = deps.clock;
    this.enabled = deps.enabled ?? (() => true);
    this.onReport = deps.onReport;
    this.logger = deps.logger;
  }

  /**
   * File a report. Never rejects. Refusals, checked in this order:
   *
   * - `off`: moderation is disabled, the reporter's seat has no occupant or no subject (nothing to count or
   *   dedupe their reports by), or the store failed (logged by event and error class only).
   * - `not_player`: the target seat has no occupant, or the occupant (or the line's author) has no subject.
   * - `self`: reporter and target are the same canonical subject.
   * - `suspended`: three or more of the reporter's reports were dismissed as bad faith within 30 days.
   * - `rate`: ten reports by the reporter in the last 24 h (`remaining` is 0).
   * - `duplicate`: the same reporter reported the same target in the same room already.
   *
   * The reporter, the target and the duplicate check all match by CANONICAL subject, so merged aliases are
   * one person. The target is the author of `lineId` when that line is still in the evidence buffer (the seat may
   * have changed hands since) and the reporter could have seen it (a line sent to a limited audience that left
   * the reporter's seat out is ignored), otherwise the seat's current occupant. The excerpt is the room's evidence
   * snapshot: each line stores `p`, its writer's index in the report's `people` list, and no identity.
   */
  async submit(input: ReportInput): Promise<ReportResult> {
    try {
      return this.run(input);
    } catch (err) {
      this.warn('reports.submit_failed', { error: errName(err) });
      return refuse('off');
    }
  }

  // --- internals -----------------------------------------------------------

  private run(input: ReportInput): ReportResult {
    if (!this.enabled()) return refuse('off');

    const { roomId } = input;
    const reporterOcc = this.roster.occupant(roomId, input.reporterSeat);
    if (reporterOcc === null || !present(reporterOcc.subject)) return refuse('off');
    const reporter = this.subjects.canonical(reporterOcc.subject);

    let line = typeof input.lineId === 'string' ? this.buffer.get(roomId, input.lineId) : undefined;
    // A reporter cannot cite a line they never saw: one sent to a limited audience that left their seat out is
    // ignored, and the target falls back to the targetSeat occupant.
    if (line !== undefined && line.audience !== null && !line.audience.includes(input.reporterSeat)) line = undefined;
    let target: { subject: SubjectId | null; seat: string; handle: string };
    if (line !== undefined) {
      target = { subject: line.subject, seat: line.seatId, handle: line.handle };
    } else {
      const occ = this.roster.occupant(roomId, input.targetSeat);
      if (occ === null) return refuse('not_player');
      target = { subject: occ.subject, seat: input.targetSeat, handle: occ.handle };
    }
    if (!present(target.subject)) return refuse('not_player');
    const targetPerson = this.subjects.canonical(target.subject);
    if (targetPerson === reporter) return refuse('self');

    const now = this.clock.now();
    let row: StoredReport;
    let remaining: number;
    try {
      const limits = this.checkLimits(reporter, targetPerson, roomId, now);
      if ('refusal' in limits) return limits.refusal;
      remaining = Math.max(0, REPORTS_PER_DAY - limits.used - 1);

      const snapshot = this.buffer.snapshot(roomId);
      const people: SubjectId[] = [];
      const index = new Map<SubjectId, number>();
      const excerpt: ReportExcerptLine[] = snapshot.map((l) => {
        let p: number | null = null;
        if (present(l.subject)) {
          const person = this.subjects.canonical(l.subject);
          const seen = index.get(person);
          if (seen === undefined) {
            p = people.length;
            index.set(person, p);
            people.push(person);
          } else {
            p = seen;
          }
        }
        return {
          lineId: l.lineId,
          ts: l.ts,
          seatId: l.seatId,
          handle: l.handle,
          raw: l.raw,
          delivered: l.delivered,
          blocked: l.blocked,
          audience: l.audience,
          p,
        };
      });

      row = {
        id: newId(),
        createdAt: now,
        roomId,
        tags: this.roster.tags(roomId),
        reporterSubject: reporter,
        reporterSeat: input.reporterSeat,
        reporterHandle: reporterOcc.handle,
        targetSubject: targetPerson,
        targetSeat: target.seat,
        targetHandle: target.handle,
        category: REPORT_CATEGORIES.includes(input.category) ? input.category : 'other',
        note: cleanNote(input.note),
        lineId: line === undefined ? null : line.lineId,
        excerpt,
        people,
        status: 'open',
      };
      const toStore = row;
      const written = this.store.transaction(() => this.store.insertReport(toStore));
      // The UNIQUE index is the backstop for a repeat the pair check missed.
      if (!written) return refuse('duplicate');
    } catch (err) {
      if (isUniqueViolation(err)) return refuse('duplicate');
      this.warn('reports.store_failed', { error: errName(err) });
      return refuse('off');
    }

    this.notify(row, targetPerson, now);
    return { ok: true, reportId: row.id, remaining };
  }

  /**
   * Suspended, rate, duplicate, in that order: the refusal, or how many reports the reporter filed in the last
   * 24 h when the report may go ahead. Throws on a store failure.
   */
  private checkLimits(
    reporter: SubjectId,
    target: SubjectId,
    roomId: string,
    now: number,
  ): { refusal: ReportResult } | { used: number } {
    const marks = this.store.loadBadFaithMarks(now - SUSPEND_WINDOW_MS);
    let bad = 0;
    for (const m of marks) if (this.subjects.canonical(m.reporter) === reporter) bad++;
    if (bad >= SUSPEND_AFTER) return { refusal: refuse('suspended') };

    const used = this.reportsByInLastDay(reporter, now);
    if (used >= REPORTS_PER_DAY) return { refusal: refuse('rate', 0) };

    for (const pair of this.store.loadRoomReportPairs(roomId)) {
      if (this.subjects.canonical(pair.reporter) === reporter && this.subjects.canonical(pair.target) === target) {
        return { refusal: refuse('duplicate') };
      }
    }
    return { used };
  }

  /** Reports this person filed after `now - 24 h` (a report exactly 24 h old no longer counts). */
  private reportsByInLastDay(reporter: SubjectId, now: number): number {
    let n = 0;
    for (const a of this.store.loadReportActivity(now - DAY_MS)) {
      if (a.createdAt > now - DAY_MS && this.subjects.canonical(a.reporter) === reporter) n++;
    }
    return n;
  }

  /** Counts about the reported person, then the hook. Fenced: nothing here can affect the result. */
  private notify(row: StoredReport, targetPerson: SubjectId, now: number): void {
    const hook = this.onReport;
    if (hook === undefined) return;
    let counts: ReportCounts;
    try {
      const since = now - WEEK_MS;
      let reports7d = 0;
      const rooms = new Set<string>();
      for (const a of this.store.loadReportActivity(since)) {
        if (a.createdAt < since || this.subjects.canonical(a.target) !== targetPerson) continue;
        reports7d++;
        rooms.add(a.roomId);
      }
      const groups = new Set<string>();
      for (const g of this.store.loadAutoChatGroups(since)) {
        if (this.subjects.canonical(g.subject) === targetPerson) groups.add(g.groupId);
      }
      counts = { reports7d, rooms7d: rooms.size, auto7d: groups.size };
    } catch (err) {
      this.warn('reports.counts_failed', { error: errName(err) });
      return;
    }
    try {
      const told: unknown = hook(copyReport(row), counts);
      // An async hook is type-legal against `=> void`; its rejection must not escape as an unhandled one.
      if (isThenable(told)) {
        told.then(undefined, (err: unknown) => {
          this.warn('reports.on_report_failed', { error: errName(err) });
        });
      }
    } catch (err) {
      this.warn('reports.on_report_failed', { error: errName(err) });
    }
  }

  private warn(event: string, detail: Record<string, string | number | boolean>): void {
    safeWarn(this.logger, event, detail);
  }
}
