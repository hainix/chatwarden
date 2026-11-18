import { scopeOfTags } from './contexts.js';
import { randomId } from './crypto.js';
import type { EvidenceBuffer, RoomRoster } from './evidence.js';
import { FILTER_LIMITS } from './filters.js';
import type { Limits } from './limits.js';
import { safeWarn } from './log.js';
import { defaultReporting, findReason, legacyCategoryOf, OTHER_REASON_ID } from './reporting.js';
import type { ResolvedReporting } from './reporting.js';
import type { SubjectIndex } from './subjects.js';
import type {
  Clock,
  Logger,
  ReportCategory,
  ReportEntity,
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

// REPORTS_PER_DAY, SUSPEND_AFTER and SUSPEND_WINDOW_MS are the DEFAULTS of `limits.reports`.

/** Reports one person may file in any 24 hours. */
export const REPORTS_PER_DAY = 10;

/** Bad-faith dismissals inside the window that suspend a reporter. */
export const SUSPEND_AFTER = 3;

/** How long (30 days, from `actioned_at`) a bad-faith dismissal weighs. */
export const SUSPEND_WINDOW_MS = 30 * DAY_MS;

/** A note is trimmed, then cut to this many characters. */
export const REPORT_NOTE_MAX = 500;

/** The 0.1.1 categories. A report's stored `category` is always one of these (see `legacyCategoryOf`); they stay valid ids for `ReportInput.category`. */
export const REPORT_CATEGORIES: readonly ReportCategory[] = ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'];

/** Why a report was not taken. In the order they are checked. */
export type ReportRefusal =
  | 'off'
  /** The `reason_required` flow, and no reason was given. */
  | 'reason_required'
  /** A reason that is not an enabled id in the profile's reporting reasons (in every flow). */
  | 'reason_unknown'
  /** `entity` is not `{ kind, ref, label }` as described by {@link ReportInput.entity}. Checked right after the reason, before anything is spent or stored. */
  | 'entity_invalid'
  | 'not_player'
  | 'self'
  | 'suspended'
  | 'rate'
  | 'duplicate';

/** How long after a report its reporter may add their one follow-up: 10 minutes. */
export const REPORT_DETAIL_WINDOW_MS = 10 * 60_000;

/** The follow-up a reporter may add to their report: a reason, a note, or both. Both are optional; a blank one is "not given". */
export interface ReportDetailInput {
  reason?: string | null;
  note?: string | null;
}

/** Why a follow-up was not taken, in the order they are checked. */
export type ReportDetailRefusal = 'off' | 'not_found' | 'not_reporter' | 'too_late' | 'already_added' | 'reason_unknown';

export type ReportDetailResult = { ok: true } | { ok: false; refused: ReportDetailRefusal };

/**
 * What only the kit's own callers may add to a report at intake. The public {@link ReportInput} has no field for them, and the facade's `cw.reports.submit` takes none, so a
 * player's body can never set them: `urgent` (a system rule that files an urgent report) and `evidenceRef` (the game's own id for the evidence behind it, read from its server
 * side, a closed alphabet with no dot or slash). A reason flagged urgent makes the report urgent whatever this says.
 * @internal
 */
export interface ReportIntakeExtras {
  urgent?: boolean;
  evidenceRef?: string | null;
}

/** An evidence ref the kit will store: 1 to 128 of `A-Z a-z 0-9 _ : -` (no dot, no slash). Anything else is dropped, never stored. */
export const EVIDENCE_REF_RE = /^[A-Za-z0-9_:-]{1,128}$/;

export interface ReportInput {
  roomId: string;
  /** The seat the reporter sits in. */
  reporterSeat: string;
  /** The seat reported. Ignored when `lineId` names a line still in the evidence buffer. */
  targetSeat: string;
  /**
   * Why the player is reporting: an enabled id from the profile's reporting reasons. Optional: with the default `one_tap` flow
   * and with `reason_first` a report with no reason (missing, null or blank) is taken; with `reason_required` it is refused
   * `reason_required`. An id that is not an enabled reason is `reason_unknown`, in every flow. It is a hint for the moderator
   * and never decides the case.
   */
  reason?: string | null;
  /**
   * The 0.1.1 name for `reason`, still accepted as an alias (the six old ids are valid; `disruption` reads as `griefing`) and still
   * lenient: an unknown, non-text or switched-off id is taken as `other`. `reason` wins when both are given; a blank `reason` falls back to this.
   */
  category?: string | null;
  note?: string;
  lineId?: string;
  /**
   * The game's own id for the evidence behind this report (a match, a replay): an opaque string of 1 to 128 of `A-Z a-z 0-9 _ : -` (no dot, no slash), given by the game's SERVER and never
   * read from a player's request (the chat route takes it from `ChatMember.evidenceRef`, set in the `join` hook). An invalid value is dropped and logged by class, and the report is
   * still taken. The kit never fetches it; staff see it as `evidence` with a link built from `reporting.evidenceUrl`. It is in no event, queue summary, webhook or Discord post.
   */
  evidenceRef?: string | null;
  /**
   * The clan, guild, team, deck or other entity the report is about: `{ kind, ref, label }`, `kind` a word of the game's (`^[a-z][a-z_]{0,23}$`), `ref` its opaque id (1 to 64 of `A-Za-z0-9_:-`), `label` its name as players see it
   * (1 to 64 characters, no control, direction or zero-width character, except a ZWNJ or ZWJ between two letters; trimmed). The report is filed against the owner's seat (`targetSeat` or the line's author) as always, so the person is the case; the entity is stored with the report and shown as one extra
   * row. Anything else (a missing key, an extra key, a bad value) is refused `entity_invalid` before the budget is touched. Omitted or null: none. No event, log line or webhook carries it.
   */
  entity?: ReportEntity | null;
}

/** The kinds, refs and labels `ReportInput.entity` may hold. */
const ENTITY_KIND_RE = /^[a-z][a-z_]{0,23}$/;
const ENTITY_REF_RE = /^[A-Za-z0-9_:-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const ENTITY_LABEL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// Direction controls and zero-width or soft-hyphen characters: they reorder or hide what a moderator reads in the case row (as `phrases` refuses them), so a label holding one anywhere is refused, edges included.
const ENTITY_LABEL_INVISIBLE = /[\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
// The two joiners are the exception, only between letters: Persian writes a ZWNJ between two letters, and Indic scripts put a ZWJ after a virama (a mark that belongs to the letter before it). A joiner at an edge, beside a space, a digit or another joiner is refused.
const ENTITY_LABEL_JOINER = /[\u200c\u200d]/;
const ENTITY_LABEL_JOINER_BETWEEN_LETTERS = /(?<=[\p{L}\p{M}])[\u200c\u200d](?=\p{L})/gu;
const ENTITY_LABEL_MAX = 64;

/**
 * A report's entity as the kit stores it (a new object, the label trimmed), `null` for none (`undefined` and `null`), or `'invalid'`. Exactly the own keys kind, ref and label; never echoes a value.
 * @internal
 */
export function readEntity(raw: unknown): ReportEntity | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const proto: unknown = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return 'invalid';
  const keys = Object.keys(raw);
  if (keys.length !== 3 || !['kind', 'ref', 'label'].every((k) => keys.includes(k))) return 'invalid';
  const { kind, ref, label } = raw as Record<string, unknown>;
  if (typeof kind !== 'string' || !ENTITY_KIND_RE.test(kind)) return 'invalid';
  if (typeof ref !== 'string' || !ENTITY_REF_RE.test(ref)) return 'invalid';
  if (typeof label !== 'string') return 'invalid';
  const name = label.trim();
  if (name === '' || name.length > ENTITY_LABEL_MAX || ENTITY_LABEL_CONTROL.test(name) || ENTITY_LABEL_INVISIBLE.test(label) || ENTITY_LABEL_JOINER.test(label.replace(ENTITY_LABEL_JOINER_BETWEEN_LETTERS, ''))) return 'invalid';
  return { kind, ref, label: name };
}

/**
 * The `{ kind, ref }` of an entity a rename is about (a label is never part of it), `null` for none, or `'invalid'`.
 * @internal
 */
export function readEntityRef(raw: unknown): { kind: string; ref: string } | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const proto: unknown = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return 'invalid';
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !['kind', 'ref'].every((k) => keys.includes(k))) return 'invalid';
  const { kind, ref } = raw as Record<string, unknown>;
  if (typeof kind !== 'string' || !ENTITY_KIND_RE.test(kind) || typeof ref !== 'string' || !ENTITY_REF_RE.test(ref)) return 'invalid';
  return { kind, ref };
}

export type ReportResult =
  /**
   * `remaining` is how many more reports the reporter may file today, this one counted. `detailUntil` (epoch ms) is the last instant
   * `addDetail` still takes a follow-up (the filing time plus `REPORT_DETAIL_WINDOW_MS`); a screen can stop offering one after it.
   */
  | { ok: true; reportId: string; remaining: number; detailUntil?: number }
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

/**
 * What a chat filter's `flag` files: a report nobody wrote. `originKey` is the counter key that made it (`[a-z0-9_.:-]{1,48}`, never text from a
 * line); `target` is the speaker's canonical subject (a guest has none and cannot be reported); `reportedReason` is `spam` for a link, phrase or
 * ratio hit and `personal_info` for a personal-info hit.
 */
export interface SystemReportInput {
  origin: 'filter';
  originKey: string;
  roomId: string;
  target: SubjectId;
  lineId: string | null;
  reportedReason: 'spam' | 'personal_info';
  /** The rule that files the report says it is urgent (a boolean `true`; anything else is not). Only this internal caller can: no player body reaches it. @internal */
  urgent?: boolean;
}

/**
 * What {@link ReportService.fileSystem} answered: `filed` (one open report now exists), `open_exists` (one is already open for this person and
 * room, nothing filed), `capped` (the instance already filed `flagCapPerDay` filter reports today), `no_subject` (a guest: nobody to report),
 * `off` (moderation is off, the input is malformed or the store failed).
 */
export type SystemReportResult = 'filed' | 'open_exists' | 'capped' | 'no_subject' | 'off';

const ORIGIN_KEY = /^[a-z0-9_.:-]{1,48}$/;
const SYSTEM_REASONS: readonly string[] = ['spam', 'personal_info'];

export interface ReportServiceDeps {
  roster: RoomRoster;
  buffer: EvidenceBuffer;
  subjects: SubjectIndex;
  store: Store;
  clock: Clock;
  /** Read per call, so a kill switch works live. Defaults to always on. */
  enabled?: () => boolean;
  /** The reporting settings in force, read per call so an edit applies to the next report. Defaults to the built-in reporting defaults. */
  reporting?: () => ResolvedReporting;
  /**
   * Called once for each stored report, after the result is decided. Fenced: a synchronous throw or an async
   * rejection is logged and never reaches the reporter. It receives a copy of the report.
   * Carries subject ids: staff channels only, never send to a player.
   */
  onReport?: (report: StoredReport, counts: ReportCounts) => void;
  logger?: Logger;
  /**
   * The report limits, already validated (see `resolveLimits`): reports per reporter per 24 h, bad-faith
   * dismissals that suspend a reporter, and how long a dismissal weighs. Default: 10, 3 and 30 days.
   */
  limits?: Limits['reports'];
  /** The most reports a filter may file in one UTC day, read per call. Defaults to the filters' default (50). */
  flagCap?: () => number;
  /** Told once with the id of each report `fileSystem` filed, after it is stored (the facade announces `report.created`). Fenced. */
  onSystemReport?: (reportId: string) => void;
}

const newId = (): string => randomId(16);

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

/**
 * When a reporter's suspension ends, or null when they are not suspended. `marks` are the `actionedAt` times of the
 * reporter's bad-faith dismissals that are still inside the window (the rows `loadBadFaithMarks` returns for it).
 * Suspended means `suspendAfter` or more of them; the suspension lifts once enough of the oldest have aged out for the
 * count to fall below `suspendAfter`, that is one millisecond after the window has passed the first mark that must go
 * (a mark counts while `actionedAt >= now - suspendWindowMs`). The single place the rule lives: intake refuses with it
 * and the staff view reports it.
 */
export function reporterSuspendedUntil(
  marks: readonly number[],
  limits: Pick<Limits['reports'], 'suspendAfter' | 'suspendWindowMs'>,
): number | null {
  if (marks.length < limits.suspendAfter) return null;
  const sorted = [...marks].sort((a, b) => a - b);
  return sorted[sorted.length - limits.suspendAfter]! + limits.suspendWindowMs + 1;
}

export class ReportService {
  private readonly roster: RoomRoster;
  private readonly buffer: EvidenceBuffer;
  private readonly subjects: SubjectIndex;
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly enabled: () => boolean;
  private readonly reporting: () => ResolvedReporting;
  private readonly onReport: ReportServiceDeps['onReport'];
  private readonly logger: Logger | undefined;
  private readonly limits: Limits['reports'];
  private readonly flagCap: () => number;
  private readonly onSystemReport: ReportServiceDeps['onSystemReport'];

  constructor(deps: ReportServiceDeps) {
    this.flagCap = deps.flagCap ?? (() => FILTER_LIMITS.flagCapDefault);
    this.onSystemReport = deps.onSystemReport;
    this.roster = deps.roster;
    this.buffer = deps.buffer;
    this.subjects = deps.subjects;
    this.store = deps.store;
    this.clock = deps.clock;
    this.enabled = deps.enabled ?? (() => true);
    this.reporting = deps.reporting ?? defaultReporting;
    this.onReport = deps.onReport;
    this.logger = deps.logger;
    this.limits = deps.limits ?? {
      perDay: REPORTS_PER_DAY,
      suspendAfter: SUSPEND_AFTER,
      suspendWindowMs: SUSPEND_WINDOW_MS,
    };
  }

  /**
   * File a report. Never rejects. Refusals, checked in this order:
   *
   * - `off`: moderation is disabled, the reporter's seat has no occupant or no subject (nothing to count or
   *   dedupe their reports by), or the store failed (logged by event and error class only).
   * - `reason_required`: the flow is `reason_required` and the report names no reason (see {@link ReportInput.reason}).
   * - `reason_unknown`: `reason` is not an enabled reason, in every flow. A refused reason uses up nothing: it never counts toward
   *   the daily allowance. The 0.1.1 `category` alias is not refused for this: an id that is not an enabled reason (or not text) is
   *   taken as `other`, as it was in 0.1.1. A blank `reason` falls back to `category`.
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
  async submit(input: ReportInput, extras?: ReportIntakeExtras): Promise<ReportResult> {
    try {
      return this.run(input, extras);
    } catch (err) {
      this.warn('reports.submit_failed', { error: errName(err) });
      return refuse('off');
    }
  }

  /**
   * Add the reporter's one follow-up to their report: a reason, a note, or both. Never rejects. Refusals, in this order:
   *
   * - `off`: moderation is disabled, the store cannot take a follow-up (it has no `addReportDetail`), or it failed (logged by
   *   event and error class only).
   * - `not_found`: no such report.
   * - `not_reporter`: `reporterSeat` is not the seat the report was filed from, or that seat, in the report's room, no longer
   *   holds the reporter (the same canonical person; a merged alias counts). The player must still be in the room.
   * - `too_late`: more than ten minutes after the report (`REPORT_DETAIL_WINDOW_MS`; exactly ten is still in time), or the
   *   report has been decided.
   * - `already_added`: the follow-up was already taken once.
   * - `reason_unknown`: the reason is not an enabled reason.
   *
   * A reason given replaces the report's reported reason (it is only a hint); a note replaces its note (trimmed and cut like a
   * report note). One left out (missing, null or blank) keeps what the report had. A follow-up that gives neither is `ok: true`
   * and changes nothing, and does not use up the one allowed. It never changes the target, the excerpt or the line, and
   * announces nothing.
   */
  async addDetail(reportId: string, reporterSeat: string, detail: ReportDetailInput): Promise<ReportDetailResult> {
    try {
      return this.runDetail(reportId, reporterSeat, detail);
    } catch (err) {
      this.warn('reports.detail_failed', { error: errName(err) });
      return { ok: false, refused: 'off' };
    }
  }

  /**
   * File the report of a chat filter's `flag`: a report with no reporter (`reporterSubject` is `filter:<report id>`, the seat and handle are empty,
   * no note), the room's evidence snapshot as its excerpt, status open, `origin: 'filter'` and the counter key. Nothing happens to the speaker until a
   * person decides it. Never rejects. Answers, in this order:
   *
   * - `off`: moderation is disabled, the input is malformed (an origin other than `filter`, a key outside `[a-z0-9_.:-]{1,48}`, no room, a reason
   *   other than `spam` or `personal_info`), or the store failed (logged by event and error class only).
   * - `no_subject`: `target` is empty (a guest).
   * - `capped`: the instance already filed `flagCapPerDay` filter reports since the start of this UTC day (counted from the store, so every process
   *   sharing it shares the count).
   * - `open_exists`: this person already has an OPEN filter report in this room (a partial unique index backs the check).
   * - `filed`.
   *
   * The report is announced like any other (`onReport`, then `onSystemReport`).
   */
  async fileSystem(input: SystemReportInput): Promise<SystemReportResult> {
    try {
      return this.runSystem(input);
    } catch (err) {
      if (isUniqueViolation(err)) return 'open_exists';
      this.warn('reports.system_failed', { error: errName(err) });
      return 'off';
    }
  }

  // --- internals -----------------------------------------------------------

  private runSystem(input: SystemReportInput): SystemReportResult {
    if (!this.enabled()) return 'off';
    if (typeof input !== 'object' || input === null) return 'off';
    if (input.origin !== 'filter' || typeof input.originKey !== 'string' || !ORIGIN_KEY.test(input.originKey)) return 'off';
    if (typeof input.roomId !== 'string' || input.roomId === '') return 'off';
    if (typeof input.reportedReason !== 'string' || !SYSTEM_REASONS.includes(input.reportedReason)) return 'off';
    if (!present(input.target)) return 'no_subject';
    const person = this.subjects.canonical(input.target);
    const now = this.clock.now();
    const { roomId } = input;

    const { excerpt, people } = this.snapshotOf(roomId);
    const tags = this.roster.tags(roomId);
    const line = typeof input.lineId === 'string' ? this.buffer.get(roomId, input.lineId) : undefined;
    // The seat and handle the person last spoke from in this room, when the buffer still shows one: for the staff view, never for a player.
    let seen: { seatId: string; handle: string } | undefined = line === undefined ? undefined : { seatId: line.seatId, handle: line.handle };
    if (seen === undefined) {
      for (const l of this.buffer.snapshot(roomId)) {
        if (present(l.subject) && this.subjects.canonical(l.subject) === person) seen = { seatId: l.seatId, handle: l.handle };
      }
    }
    const id = newId();
    const row: StoredReport = {
      id,
      createdAt: now,
      roomId,
      tags,
      reporterSubject: `filter:${id}`,
      reporterSeat: '',
      reporterHandle: '',
      targetSubject: person,
      targetSeat: seen?.seatId ?? '',
      targetHandle: seen?.handle ?? '',
      category: legacyCategoryOf(input.reportedReason),
      reportedReason: input.reportedReason,
      note: null,
      lineId: line === undefined ? null : line.lineId,
      excerpt,
      people,
      status: 'open',
      origin: 'filter',
      originKey: input.originKey,
      urgent: input.urgent === true,
      evidenceRef: null,
      scope: scopeOfTags(tags),
    };
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
    const cap = this.flagCap();
    const outcome = this.store.transaction((): SystemReportResult => {
      if (this.store.countOriginReports('filter', dayStart) >= cap) return 'capped';
      return this.store.insertReport(row) ? 'filed' : 'open_exists';
    });
    if (outcome !== 'filed') return outcome;
    this.notify(row, person, now);
    this.systemFiled(id);
    return 'filed';
  }

  /** The room's evidence snapshot as a report excerpt, and the distinct canonical people who wrote in it (first seen first). */
  private snapshotOf(roomId: string): { excerpt: ReportExcerptLine[]; people: SubjectId[] } {
    const people: SubjectId[] = [];
    const index = new Map<SubjectId, number>();
    const excerpt: ReportExcerptLine[] = this.buffer.snapshot(roomId).map((l) => {
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
      return { lineId: l.lineId, ts: l.ts, seatId: l.seatId, handle: l.handle, raw: l.raw, delivered: l.delivered, blocked: l.blocked, audience: l.audience, p, ...(l.retracted === true ? { retracted: true as const } : {}) };
    });
    return { excerpt, people };
  }

  /** Tell the facade a system report is stored. Fenced: nothing here can change the answer. */
  private systemFiled(reportId: string): void {
    const hook = this.onSystemReport;
    if (hook === undefined) return;
    try {
      const told: unknown = hook(reportId);
      if (isThenable(told)) {
        told.then(undefined, (err: unknown) => {
          this.warn('reports.on_report_failed', { error: errName(err) });
        });
      }
    } catch (err) {
      this.warn('reports.on_report_failed', { error: errName(err) });
    }
  }

  /**
   * The reason a report names: `{ id }` (an enabled one; null for none), or why it cannot be taken. A blank reason is none; the
   * `category` alias is read when there is no `reason`. A match is exact, after trimming; an old `disruption` finds `griefing`.
   */
  private readReason(input: { reason?: unknown; category?: unknown }): { id: string | null } | 'required' | 'unknown' {
    const reporting = this.reporting();
    const none = reporting.flow === 'reason_required' ? 'required' : { id: null };
    const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (!blank(input.reason)) {
      // The new field is strict: anything that is not an enabled reason is refused.
      if (typeof input.reason !== 'string') return 'unknown';
      const found = findReason(reporting.reasons, input.reason.trim());
      return found !== undefined && found.enabled ? { id: found.id } : 'unknown';
    }
    if (blank(input.category)) return none;
    // The 0.1.1 alias keeps its 0.1.1 behaviour: an id that is not an enabled reason (or not text at all) is taken as `other`.
    const found = typeof input.category === 'string' ? findReason(reporting.reasons, input.category.trim()) : undefined;
    return found !== undefined && found.enabled ? { id: found.id } : { id: OTHER_REASON_ID };
  }

  private runDetail(reportId: string, reporterSeat: string, detail: ReportDetailInput | null | undefined): ReportDetailResult {
    if (!this.enabled()) return { ok: false, refused: 'off' };
    const store = this.store;
    if (typeof store.addReportDetail !== 'function') return { ok: false, refused: 'off' };
    const report = typeof reportId === 'string' && reportId !== '' ? store.loadReport(reportId) : null;
    if (report === null) return { ok: false, refused: 'not_found' };

    // The reporter, in the room and the seat the report was filed from. Looked up in the report's own room.
    const occ = typeof reporterSeat === 'string' && reporterSeat === report.reporterSeat ? this.roster.occupant(report.roomId, reporterSeat) : null;
    if (occ === null || !present(occ.subject) || this.subjects.canonical(occ.subject) !== this.subjects.canonical(report.reporterSubject)) {
      return { ok: false, refused: 'not_reporter' };
    }
    const now = this.clock.now();
    if (report.status !== 'open' || now - report.createdAt > REPORT_DETAIL_WINDOW_MS) return { ok: false, refused: 'too_late' };
    if ((report.detailAt ?? null) !== null) return { ok: false, refused: 'already_added' };

    const d: ReportDetailInput = typeof detail === 'object' && detail !== null ? detail : {};
    const picked = this.readReason({ reason: d.reason });
    if (picked === 'unknown') return { ok: false, refused: 'reason_unknown' };
    // In the `reason_required` flow a follow-up with no reason is not a refusal: the report has its reason already.
    const reason = picked === 'required' || picked.id === null ? null : picked.id;
    const note = cleanNote(d.note);
    if (reason === null && note === null) return { ok: true };

    const finalReason = reason ?? report.reportedReason ?? null;
    const written = store.transaction(() =>
      store.addReportDetail?.(report.id, {
        reportedReason: finalReason,
        category: legacyCategoryOf(finalReason),
        note: note ?? report.note,
        at: now,
      }),
    );
    return written === true ? { ok: true } : { ok: false, refused: 'already_added' };
  }

  private run(input: ReportInput, extras?: ReportIntakeExtras): ReportResult {
    if (!this.enabled()) return refuse('off');

    const { roomId } = input;
    const reporterOcc = this.roster.occupant(roomId, input.reporterSeat);
    if (reporterOcc === null || !present(reporterOcc.subject)) return refuse('off');
    const reporter = this.subjects.canonical(reporterOcc.subject);

    const given = this.readReason(input);
    if (given === 'required') return refuse('reason_required');
    if (given === 'unknown') return refuse('reason_unknown');
    // The entity is checked before anything is read, spent or stored: a malformed one is the game's bug, and the report is not taken.
    const entity = readEntity(input.entity);
    if (entity === 'invalid') return refuse('entity_invalid');

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
      remaining = Math.max(0, this.limits.perDay - limits.used - 1);

      const { excerpt, people } = this.snapshotOf(roomId);
      const tags = this.roster.tags(roomId);

      row = {
        id: newId(),
        createdAt: now,
        roomId,
        tags,
        reporterSubject: reporter,
        reporterSeat: input.reporterSeat,
        reporterHandle: reporterOcc.handle,
        targetSubject: targetPerson,
        targetSeat: target.seat,
        targetHandle: target.handle,
        category: legacyCategoryOf(given.id),
        reportedReason: given.id,
        note: cleanNote(input.note),
        lineId: line === undefined ? null : line.lineId,
        excerpt,
        people,
        status: 'open',
        // A snapshot: the reason's flag as it is now, or the kit's own caller said so. Never from the player's input.
        urgent: (given.id !== null && findReason(this.reporting().reasons, given.id)?.urgent === true) || extras?.urgent === true,
        evidenceRef: this.cleanEvidenceRef(extras?.evidenceRef ?? input.evidenceRef),
        scope: scopeOfTags(tags),
        entity,
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
    return { ok: true, reportId: row.id, remaining, detailUntil: row.createdAt + REPORT_DETAIL_WINDOW_MS };
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
    const marks = this.store.loadBadFaithMarks(now - this.limits.suspendWindowMs);
    const bad: number[] = [];
    for (const m of marks) if (this.subjects.canonical(m.reporter) === reporter) bad.push(m.actionedAt);
    if (reporterSuspendedUntil(bad, this.limits) !== null) return { refusal: refuse('suspended') };

    const used = this.reportsByInLastDay(reporter, now);
    if (used >= this.limits.perDay) return { refusal: refuse('rate', 0) };

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

  /** The evidence ref to store: a valid one as it is, else null (a bad one, not a string, is logged by class only and never echoed). */
  private cleanEvidenceRef(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && EVIDENCE_REF_RE.test(value)) return value;
    this.warn('reports.evidence_ref_dropped', { reason: 'invalid' });
    return null;
  }

  private warn(event: string, detail: Record<string, string | number | boolean>): void {
    safeWarn(this.logger, event, detail);
  }
}
