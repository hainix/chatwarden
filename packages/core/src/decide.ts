import { createHash } from 'node:crypto';
import { safeWarn } from './log.js';
import { ownLines } from './notices.js';
import type { NoticeService } from './notices.js';
import type { CommunityRules, RuleRef } from './rules.js';
import { SANCTION_KINDS, SANCTION_SOURCES, validateSanctionInput, writeSanction } from './sanctions.js';
import type { SanctionIndex } from './sanctions.js';
import type { SubjectIndex } from './subjects.js';
import type { Clock, Logger, ReportExcerptLine, ReportRecord, SanctionKind, SanctionRow, Source, Store, SubjectId } from './types.js';

// The one path every moderator decision on a report takes. A decision closes the report, writes each sanction and
// its player notice, and records itself, all in ONE store transaction: it lands whole or not at all. The same
// decision sent twice (a double click, a retry) is recognised by its key and answered from the stored result, so it
// never sanctions or notifies twice. The sanction index and the pushes only see a decision once it has committed.

/** The longest moderator reason, after trimming. */
export const DECISION_REASON_MAX = 500;

/** One sanction a decision applies. */
export interface DecisionAction {
  /** The person to sanction; stored as their canonical subject. */
  subject: SubjectId;
  kind: SanctionKind;
  /** Milliseconds from now; null is permanent. Must be null for a warning. */
  durationMs: number | null;
  /** The Community Rule cited. Must be citable (active), or `'uncovered'` with a `gapNote`. */
  rule: RuleRef;
  /** Private note on what the rules did not cover. Required under `'uncovered'` for a moderator; otherwise absent. */
  gapNote?: string;
  /** Also sanction the subject's latest IP (at most 24 h). Not for a warning. */
  includeIp?: boolean;
  /** Up to five of THIS person's own lines in the report, shown to them in the notice. */
  lineIds?: string[];
}

export interface DecisionInput {
  reportId: string;
  /**
   * `fair`: the report was right (status `actioned`). `unfair`: it was wrong (`dismissed`). `bad_faith`: it was
   * wrong and made in bad faith (`dismissed` with the bad-faith mark, which counts toward the reporter's suspension).
   * `unfair` and `bad_faith` may act on the reporter or another person in the report, never on the reported target.
   */
  verdict: 'fair' | 'unfair' | 'bad_faith';
  actions: DecisionAction[];
  actor: string;
  /** Private; required, at most 500 characters after trimming. Never shown to a player. */
  reason: string;
  /** Defaults to `'moderator'`. */
  source?: Source;
}

/** What one applied action produced. Moderator-facing: `subject` is an identifier and never goes to a player. */
export interface DecisionGroup {
  subject: SubjectId;
  groupId: string;
  refCode: string;
  noticeId: string;
}

export type DecisionResult =
  | { ok: true; groups: DecisionGroup[]; replay: boolean }
  | { ok: false; error: 'not_found' | 'already_decided' | 'invalid' };

export interface DecisionServiceDeps {
  store: Store;
  subjects: SubjectIndex;
  rules: CommunityRules;
  notices: NoticeService;
  clock: Clock;
  /** Kept current with the sanctions a decision writes, once the decision has committed. */
  index?: SanctionIndex;
  logger?: Logger;
}

const VERDICTS: readonly DecisionInput['verdict'][] = ['fair', 'unfair', 'bad_faith'];

const INVALID: DecisionResult = Object.freeze({ ok: false, error: 'invalid' }) as DecisionResult;

/** A decision input that is malformed. Internal: every one becomes `{ ok: false, error: 'invalid' }`. */
class InvalidDecision extends Error {
  constructor() {
    super('decide: invalid decision');
    this.name = 'InvalidDecision';
  }
}

const bad = (): never => {
  throw new InvalidDecision();
};

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** An action with every default applied and its subject made canonical. */
interface NormalAction {
  subject: SubjectId;
  kind: SanctionKind;
  durationMs: number | null;
  rule: RuleRef;
  gapNote: string | undefined;
  includeIp: boolean;
  lineIds: string[];
}

interface Normal {
  reportId: string;
  verdict: DecisionInput['verdict'];
  actor: string;
  reason: string;
  source: Source;
  /** Sorted by canonical subject, then kind. */
  actions: NormalAction[];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Check the SHAPE of an input and settle its defaults. Throws {@link InvalidDecision} for anything malformed. Does
 * not look at the report, the rules or the sanction rules: that is the plan's job.
 */
function normalize(subjects: SubjectIndex, input: DecisionInput): Normal {
  if (typeof input !== 'object' || input === null) return bad();
  if (!nonEmpty(input.reportId)) return bad();
  if (!VERDICTS.includes(input.verdict)) return bad();
  if (!Array.isArray(input.actions)) return bad();
  if (typeof input.actor !== 'string' || input.actor.trim() === '') return bad();
  if (typeof input.reason !== 'string') return bad();
  const reason = input.reason.trim();
  if (reason === '' || reason.length > DECISION_REASON_MAX) return bad();
  const source: unknown = input.source === undefined ? 'moderator' : input.source;
  if (!SANCTION_SOURCES.includes(source as Source)) return bad();

  const actions: NormalAction[] = input.actions.map((a) => {
    if (typeof a !== 'object' || a === null) return bad();
    if (!nonEmpty(a.subject)) return bad();
    if (!SANCTION_KINDS.includes(a.kind)) return bad();
    if (a.durationMs !== null && typeof a.durationMs !== 'number') return bad();
    const rule: unknown = a.rule;
    if (rule !== 'uncovered' && !(typeof rule === 'number' && Number.isSafeInteger(rule) && rule >= 1)) return bad();
    if (a.gapNote !== undefined && typeof a.gapNote !== 'string') return bad();
    if (a.includeIp !== undefined && typeof a.includeIp !== 'boolean') return bad();
    let lineIds: string[] = [];
    if (a.lineIds !== undefined) {
      if (!Array.isArray(a.lineIds) || a.lineIds.some((id) => typeof id !== 'string')) return bad();
      lineIds = [...new Set(a.lineIds)].sort(byText);
    }
    return {
      subject: subjects.canonical(a.subject),
      kind: a.kind,
      durationMs: a.durationMs,
      rule: rule as RuleRef,
      gapNote: a.gapNote === undefined ? undefined : a.gapNote.trim(),
      includeIp: a.includeIp === true,
      lineIds,
    };
  });
  actions.sort((x, y) => byText(x.subject, y.subject) || byText(x.kind, y.kind));
  // The same kind twice for one person would sanction them twice for one report.
  for (let i = 1; i < actions.length; i++) {
    const p = actions[i - 1];
    const c = actions[i];
    if (p !== undefined && c !== undefined && p.subject === c.subject && p.kind === c.kind) return bad();
  }
  return { reportId: input.reportId, verdict: input.verdict, actor: input.actor.trim(), reason, source: source as Source, actions };
}

/** JSON with sorted keys, no whitespace, and no `undefined`: the same value always gives the same text. */
function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJSON(x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(o).sort(byText)) {
    if (o[k] !== undefined) parts.push(`${JSON.stringify(k)}:${canonicalJSON(o[k])}`);
  }
  return `{${parts.join(',')}}`;
}

function keyOf(n: Normal): string {
  const actions = n.actions.map((a) => ({
    subject: a.subject,
    kind: a.kind,
    durationMs: a.durationMs,
    rule: a.rule,
    gapNote: a.gapNote,
    includeIp: a.includeIp,
    lineIds: a.lineIds,
  }));
  return createHash('sha256')
    .update(`${n.reportId}\u0000${n.verdict}\u0000${canonicalJSON(actions)}`)
    .digest('hex');
}

/**
 * The idempotency key of a decision: SHA-256 of the report id, the verdict and the actions sorted by canonical
 * subject then kind (canonical JSON). The actor and the reason are not part of it: the same decision sent by a
 * second moderator, or with reworded text, is still the same decision. Throws on a malformed input.
 */
export function decisionKey(subjects: SubjectIndex, input: DecisionInput): string {
  return keyOf(normalize(subjects, input));
}

/** One action, checked and ready to write. */
interface Planned {
  action: NormalAction;
  lines: ReportExcerptLine[];
}

const lineIsSound = (l: ReportExcerptLine): boolean =>
  typeof l.raw === 'string' && Number.isFinite(l.ts) && !Number.isNaN(new Date(l.ts).getTime());

const errName = (err: unknown): string => {
  try {
    return err instanceof Error ? err.name : typeof err;
  } catch {
    return 'unknown';
  }
};

export class DecisionService {
  private readonly store: Store;
  private readonly subjects: SubjectIndex;
  private readonly rules: CommunityRules;
  private readonly notices: NoticeService;
  private readonly clock: Clock;
  private readonly index: SanctionIndex | undefined;
  private readonly logger: Logger | undefined;

  constructor(deps: DecisionServiceDeps) {
    this.store = deps.store;
    this.subjects = deps.subjects;
    this.rules = deps.rules;
    this.notices = deps.notices;
    this.clock = deps.clock;
    this.index = deps.index;
    this.logger = deps.logger;
  }

  /**
   * Decide a report. Validation runs completely before the first write: any problem answers
   * `{ ok: false, error: 'invalid' }` with nothing written (and no throw). Otherwise ONE transaction closes the
   * report, writes every sanction and notice, and records the decision; a store failure rolls all of it back and
   * rejects with the store's error.
   *
   * - `not_found`: no such report.
   * - The same decision again (same report, verdict and actions, by canonical subject) answers
   *   `{ ok: true, replay: true }` with the first call's groups and writes nothing, even though the report is closed.
   * - `already_decided`: the report is closed and this is a different decision.
   *
   * After the commit the sanctions join the index and each notified person (every target, and the reporter on a
   * `fair` decision with at least one action) is told once. Both are fenced: they never fail the decision.
   */
  decide(input: DecisionInput): Promise<DecisionResult> {
    try {
      return Promise.resolve(this.run(input));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // --- internals -----------------------------------------------------------

  private run(input: DecisionInput): DecisionResult {
    let norm: Normal;
    try {
      norm = normalize(this.subjects, input);
    } catch {
      return INVALID;
    }
    const report = this.store.loadReport(norm.reportId);
    if (report === null) return { ok: false, error: 'not_found' };

    const key = keyOf(norm);
    const prior = this.store.findDecision(key);
    if (prior !== null) return this.replayOf(prior.resultJson);
    if (report.status !== 'open') return { ok: false, error: 'already_decided' };

    let plan: Planned[];
    try {
      plan = this.plan(norm, report);
    } catch {
      // Planning reads nothing from the store, so whatever it threw, nothing has been written.
      return INVALID;
    }
    return this.commit(norm, report, key, plan);
  }

  /** Check every action against the report, the rules and the sanction rules. Throws on the first problem. */
  private plan(norm: Normal, report: ReportRecord): Planned[] {
    const target = this.subjects.canonical(report.targetSubject);
    const reporter = this.subjects.canonical(report.reporterSubject);
    // A dismissal cannot punish the person the report was about; it may act on the reporter or on others who wrote.
    const allowed = new Set<SubjectId>([reporter, ...report.people.map((p) => this.subjects.canonical(p))]);
    allowed.delete(target);

    return norm.actions.map((a) => {
      if (norm.verdict !== 'fair' && !allowed.has(a.subject)) return bad();
      if (!this.rules.isCitable(a.rule)) return bad();
      validateSanctionInput(this.sanctionInput(norm, a));
      const lines = a.lineIds.length === 0 ? [] : ownLines(report, a.subject, a.lineIds, this.subjects);
      if (!lines.every(lineIsSound)) return bad();
      return { action: a, lines };
    });
  }

  private sanctionInput(norm: Normal, a: NormalAction) {
    return {
      kind: a.kind,
      subject: a.subject,
      includeIp: a.includeIp,
      durationMs: a.durationMs,
      reason: norm.reason,
      actor: norm.actor,
      source: norm.source,
      automated: false,
      rule: a.rule,
      ...(a.gapNote === undefined ? {} : { gapNote: a.gapNote }),
    };
  }

  private commit(norm: Normal, report: ReportRecord, key: string, plan: Planned[]): DecisionResult {
    const now = this.clock.now();
    const pending = this.index !== undefined && !this.index.isEnabled();
    const reporter = this.subjects.canonical(report.reporterSubject);
    const status = norm.verdict === 'fair' ? 'actioned' : 'dismissed';

    const done = this.store.transaction(() => {
      if (!this.store.closeReport(report.id, status, norm.verdict === 'bad_faith', norm.actor, now, norm.reason)) {
        return null;
      }
      const groups: DecisionGroup[] = [];
      const rows: SanctionRow[] = [];
      for (const { action: a, lines } of plan) {
        // No index here: the rows reach it only after the transaction has committed.
        const written = writeSanction(this.store, this.subjects, this.sanctionInput(norm, a), now, pending);
        const noticeId = this.notices.createForSanction(
          {
            groupId: written.groupId,
            refCode: written.refCode,
            kind: a.kind,
            until: a.kind === 'warning' ? null : written.endsAt,
            rule: a.rule,
            subject: a.subject,
          },
          lines,
          { notify: false },
        );
        groups.push({ subject: a.subject, groupId: written.groupId, refCode: written.refCode, noticeId });
        rows.push(...written.rows);
      }
      const told = new Set<SubjectId>(groups.map((g) => g.subject));
      if (norm.verdict === 'fair' && groups.length > 0) {
        this.notices.createReportOutcome(reporter, { notify: false });
        told.add(reporter);
      }
      this.store.insertDecision(key, report.id, now, JSON.stringify({ groups }));
      return { groups, rows, told };
    });

    if (done === null) {
      // Someone closed the report between our read and our write (another process). Same decision? Then it is a replay.
      const again = this.store.findDecision(key);
      return again === null ? { ok: false, error: 'already_decided' } : this.replayOf(again.resultJson);
    }

    // The decision is durable. Nothing below may fail it.
    try {
      this.index?.add(done.rows, now);
    } catch (err) {
      this.warn('decide.index_failed', { error: errName(err) });
    }
    for (const subject of done.told) {
      try {
        this.notices.announce(subject);
      } catch (err) {
        this.warn('decide.announce_failed', { error: errName(err) });
      }
    }
    return { ok: true, groups: done.groups, replay: false };
  }

  private replayOf(resultJson: string): DecisionResult {
    const parsed: unknown = JSON.parse(resultJson);
    const groups = (parsed as { groups?: unknown } | null)?.groups;
    if (!Array.isArray(groups)) throw new Error('decide: a recorded decision is unreadable');
    return { ok: true, groups: groups as DecisionGroup[], replay: true };
  }

  private warn(event: string, detail: Record<string, string | number | boolean>): void {
    safeWarn(this.logger, event, detail);
  }
}

export interface RevokeDeps {
  notices: NoticeService;
  clock: Clock;
  /** Dropped from once the revoke has committed. */
  index?: SanctionIndex;
}

/**
 * Revoke a sanction group and withdraw its player notices, atomically: both land or neither does. An unseen
 * withdrawn notice is never shown; a seen one leaves "My record". The index drops the group only after the commit.
 * `revoked` is false for an unknown or already revoked group (the first revoker is kept); `withdrawn` counts the
 * notices this call withdrew. Synchronous in effect, like `revokeSanction`.
 */
export function revokeAndWithdraw(
  store: Store,
  groupId: string,
  actor: string,
  reason: string,
  deps: RevokeDeps,
): Promise<{ revoked: boolean; withdrawn: number }> {
  try {
    const now = deps.clock.now();
    const out = store.transaction(() => ({
      revoked: store.revokeSanctionGroup(groupId, actor, now, reason) > 0,
      withdrawn: deps.notices.withdrawGroup(groupId),
    }));
    deps.index?.remove(groupId);
    return Promise.resolve(out);
  } catch (err) {
    return Promise.reject(err);
  }
}
