import type { AiOutcomeHook } from './ai/casebook.js';
import { ROLES } from './audit.js';
import type { Role } from './audit.js';
import { sha256Hex } from './crypto.js';
import { safeWarn } from './log.js';
import { ownLines } from './notices.js';
import type { NoticeService } from './notices.js';
import type { CommunityRules, RuleRef } from './rules.js';
import { SANCTION_KINDS, SANCTION_SOURCES, validateSanctionInput, writeSanction } from './sanctions.js';
import type { SanctionIndex } from './sanctions.js';
import type { SubjectIndex } from './subjects.js';
import { CONDUCT_LEVELS } from './types.js';
import type { AiOutcomeInsert, Clock, ConductLevel, Logger, ReportExcerptLine, ReportRecord, SanctionKind, SanctionRow, Source, Store, SubjectId } from './types.js';

// The one path every moderator decision on a report takes. A decision closes the report, writes each sanction and
// its player notice, and records itself, all in ONE store transaction: it lands whole or not at all. The same
// decision sent twice (a double click, a retry) is recognised by its key and answered from the stored result, so it
// never sanctions or notifies twice. The sanction index and the pushes only see a decision once it has committed.

/** The longest moderator reason, after trimming. */
export const DECISION_REASON_MAX = 500;

/**
 * The reason stored for a `no_action` decision that has no actions and no typed reason (a one-click "nothing wrong
 * here"). One recognisable value, so "a human dismissed it and gave no reason" is told apart from a considered note.
 * @experimental
 */
export const NO_ACTION_DEFAULT_REASON = 'No action needed';

/**
 * True for the standard dismissal reason (trimmed); false for anything else, including null.
 * @experimental
 */
export function isDefaultNoActionReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.trim() === NO_ACTION_DEFAULT_REASON;
}

/** The longest bad-faith evidence note, after trimming. */
export const DECISION_EVIDENCE_MAX = 500;

/** One sanction a decision applies. */
export interface DecisionAction {
  /** The person to sanction; stored as their canonical subject. */
  subject: SubjectId;
  kind: SanctionKind;
  /** Milliseconds from now; null is permanent. Must be null for a warning or a note. */
  durationMs: number | null;
  /** The Community Rule cited. Must be citable (active), or `'uncovered'` with a `gapNote`. */
  rule: RuleRef;
  /** Private note on what the rules did not cover. Required under `'uncovered'` for a moderator; otherwise absent. */
  gapNote?: string;
  /** Also sanction the subject's latest IP (at most 24 h). Not for a warning or a note. */
  includeIp?: boolean;
  /** Up to five of THIS person's own lines in the report, shown to them in the notice (a note has no notice). */
  lineIds?: string[];
}

export interface DecisionInput {
  reportId: string;
  /**
   * What the moderator decided:
   * - `upheld`: rules were broken and an action was taken (status `actioned`). The reporter is told "action taken".
   * - `noted`: the behaviour is recorded as a Note and nothing is done to the player (status `actioned`). Needs at
   *   least one action and every action must be of kind `note`.
   * - `no_action`: the behaviour was within the rules (status `dismissed`). Neutral for the reporter: an honest
   *   report that does not hold up is never held against them.
   * - `bad_faith`: there is evidence of deliberate abuse of the report tool (`dismissed` with the bad-faith mark,
   *   which counts toward the reporter's suspension). Requires `evidence`.
   *
   * `no_action` and `bad_faith` may act on the reporter or another person in the report, never on the reported
   * target. The K2 names `fair` and `unfair` are gone: they answer `invalid`.
   */
  verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith';
  /**
   * The written evidence for a `bad_faith` verdict: required for it (1..500 characters after trimming) and
   * forbidden for every other verdict. Stored on the report as `badFaithEvidence`. Private: staff only, never shown
   * to a player, and not part of the decision's idempotency key.
   */
  evidence?: string;
  actions: DecisionAction[];
  actor: string;
  /**
   * Private; at most 500 characters after trimming. Never shown to a player. Required, except for a `no_action`
   * decision with NO actions, where an absent or blank reason is stored as {@link NO_ACTION_DEFAULT_REASON}.
   */
  reason?: string;
  /** Defaults to `'moderator'`. */
  source?: Source;
  /**
   * AI levels 1 and 2. Optional: the casebook records how every decision compared with the report's AI read whether or not this is
   * given (the server decides, from the stored read and the decision). It only tells the casebook which read the moderator saw, whether
   * they clicked accept, the conduct level of their form and their role. It never changes the decision, its key or its answer, and a
   * part that is not well formed is ignored. Agreement is computed from the stored read and the decision, never from this echo.
   * @experimental
   */
  ai?: DecisionAiEcho;
}

/**
 * What a decision tells the casebook about the AI. `readId` (with `accepted`) is the echo of the read the moderator saw: an id that is
 * not one of this report's finished reads falls back to the newest. `accepted` is a claim that they accepted the pre-fill in one click:
 * it counts only when the decision is the pre-fill. `severity` is the conduct level their form settled on: it counts only when it fits
 * the verdict. Without the echo no example text is kept. `role` is the moderator's, for the `ai.outcome` audit row (without it none is
 * written).
 * @experimental
 */
export interface DecisionAiEcho {
  readId?: string;
  accepted?: boolean;
  severity?: ConductLevel;
  role?: Role;
}

/**
 * What one applied action produced. Moderator-facing: `subject` is an identifier.
 * Carries subject ids: staff channels only, never send to a player.
 */
export interface DecisionGroup {
  subject: SubjectId;
  groupId: string;
  refCode: string;
  /** The kind of the action that made this group. */
  kind: SanctionKind;
  /** The player's notice for this action; null for a `note`, which tells the player nothing. */
  noticeId: string | null;
}

/**
 * The answer to `decide`. Each group in `groups` carries a subject id. Carries subject ids: staff channels only, never send to a player. Show the player their
 * notice (`notices.pending`), never this.
 */
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
  /**
   * Whether an `upheld` decision tells the reporter ("action taken"). Default true. Off: the reporter hears
   * nothing, and the people acted on are still told.
   */
  reporterFeedback?: boolean;
  /** AI casebook: the outcome row for a decision made with an AI echo. Fenced; null records nothing. */
  aiOutcome?: AiOutcomeHook;
}

/**
 * What one applied action wrote, for the facade's events. Internal: it never reaches the staff-facing result. No
 * reason, evidence or gap note: ids, codes, kinds and times only.
 */
export interface AppliedGroup {
  groupId: string;
  refCode: string;
  kind: SanctionKind;
  /** When it ends; null for a permanent one and for a warning or note. */
  until: number | null;
  rule: RuleRef;
  source: Source;
  /** The canonical person sanctioned. */
  target: SubjectId;
  /** A rule-gap row was written for the group (an uncovered rule cited by a moderator). */
  gap: boolean;
}

/**
 * A decision as the facade sees it: the staff-facing `result`, plus, when THIS call committed the decision (not a
 * replay, not a refusal), what to announce. Internal.
 */
export interface DecisionOutcome {
  result: DecisionResult;
  committed: {
    reportId: string;
    verdict: DecisionInput['verdict'];
    at: number;
    applied: AppliedGroup[];
    /** The casebook recorded an outcome with this decision; `role` is the moderator's, for the audit row (null when the echo had none). */
    aiOutcome: { agreement: AiOutcomeInsert['agreement']; role: Role | null; actor: string } | null;
  } | null;
}

const VERDICTS: readonly DecisionInput['verdict'][] = ['upheld', 'noted', 'no_action', 'bad_faith'];

/** `no_action` and `bad_faith` dismiss the report; `upheld` and `noted` action it. */
const isDismissal = (verdict: DecisionInput['verdict']): boolean => verdict === 'no_action' || verdict === 'bad_faith';

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
  /** The trimmed bad-faith evidence; null for every other verdict. */
  evidence: string | null;
  source: Source;
  /** Sorted by canonical subject, then kind. */
  actions: NormalAction[];
  /** The AI echo, or null when absent or not well formed. Not part of the key. */
  ai: { readId: string | null; accepted: boolean; severity: ConductLevel | null; role: Role | null };
}

/** The longest read id an echo may carry. */
const AI_READ_ID_MAX = 128;

/**
 * The AI echo of an input. Anything that is not well formed is ignored, never an error (the decision matters more): a malformed echo
 * (a bad read id, or an `accepted` that is not a boolean) is as if there were none, but a good role is kept for the audit row.
 */
function normalizeAi(v: unknown): Normal['ai'] {
  const none: Normal['ai'] = { readId: null, accepted: false, severity: null, role: null };
  if (typeof v !== 'object' || v === null) return none;
  const o = v as Record<string, unknown>;
  const role = (ROLES as readonly unknown[]).includes(o['role']) ? (o['role'] as Role) : null;
  const readId = o['readId'];
  if (typeof readId !== 'string' || readId === '' || readId.length > AI_READ_ID_MAX || typeof o['accepted'] !== 'boolean') return { ...none, role };
  const severity = (CONDUCT_LEVELS as readonly unknown[]).includes(o['severity']) ? (o['severity'] as ConductLevel) : null;
  return { readId, accepted: o['accepted'], severity, role };
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
  // A reason that is neither absent nor a string is malformed for every verdict.
  if (input.reason !== undefined && typeof input.reason !== 'string') return bad();
  let reason = input.reason === undefined ? '' : input.reason.trim();
  // The one-click dismissal: a no_action that acts on nobody may leave the reason out.
  if (reason === '' && input.verdict === 'no_action' && input.actions.length === 0) reason = NO_ACTION_DEFAULT_REASON;
  if (reason === '' || reason.length > DECISION_REASON_MAX) return bad();
  // Evidence is required for bad_faith and forbidden otherwise (even an empty string): the verdict says what it is for.
  let evidence: string | null = null;
  if (input.verdict === 'bad_faith') {
    if (typeof input.evidence !== 'string') return bad();
    evidence = input.evidence.trim();
    if (evidence === '' || evidence.length > DECISION_EVIDENCE_MAX) return bad();
  } else if (input.evidence !== undefined) {
    return bad();
  }
  const source: unknown = input.source === undefined ? 'moderator' : input.source;
  if (!SANCTION_SOURCES.includes(source as Source)) return bad();

  const actions: NormalAction[] = input.actions.map((a) => {
    if (typeof a !== 'object' || a === null) return bad();
    if (!nonEmpty(a.subject)) return bad();
    if (!SANCTION_KINDS.includes(a.kind)) return bad();
    // NaN and +-Infinity would serialise as null in the key and alias a permanent decision: refuse them before keying.
    if (a.durationMs !== null && !(typeof a.durationMs === 'number' && Number.isFinite(a.durationMs))) return bad();
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
  // A `noted` decision needs at least one action, and every action must be a `note`.
  if (input.verdict === 'noted' && (actions.length === 0 || actions.some((a) => a.kind !== 'note'))) return bad();
  actions.sort((x, y) => byText(x.subject, y.subject) || byText(x.kind, y.kind));
  // The same kind twice for one person would sanction them twice for one report.
  for (let i = 1; i < actions.length; i++) {
    const p = actions[i - 1];
    const c = actions[i];
    if (p !== undefined && c !== undefined && p.subject === c.subject && p.kind === c.kind) return bad();
  }
  return {
    reportId: input.reportId,
    verdict: input.verdict,
    actor: input.actor.trim(),
    reason,
    evidence,
    source: source as Source,
    actions,
    ai: normalizeAi(input.ai),
  };
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
  return sha256Hex(`${n.reportId}\u0000${n.verdict}\u0000${canonicalJSON(actions)}`);
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

const refused = (result: DecisionResult): DecisionOutcome => ({ result, committed: null });

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
  private readonly reporterFeedback: boolean;
  private readonly aiOutcome: AiOutcomeHook | undefined;

  constructor(deps: DecisionServiceDeps) {
    this.store = deps.store;
    this.subjects = deps.subjects;
    this.rules = deps.rules;
    this.notices = deps.notices;
    this.clock = deps.clock;
    this.index = deps.index;
    this.logger = deps.logger;
    this.reporterFeedback = deps.reporterFeedback ?? true;
    this.aiOutcome = deps.aiOutcome;
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
   * After the commit the sanctions join the index and each notified person (every target of a non-note action, and
   * the reporter on an `upheld` decision with at least one non-note action) is told once. A `note` makes no notice and
   * tells nobody. Both are fenced: they never fail the decision.
   *
   * The result's groups carry subject ids. Carries subject ids: staff channels only, never send to a player.
   */
  decide(input: DecisionInput): Promise<DecisionResult> {
    return this.decideDetailed(input).then((o) => o.result);
  }

  /**
   * {@link decide}, plus what the commit wrote for the facade's events (`committed` is null for a replay and for every
   * refusal). Internal: the staff-facing answer is `result`, unchanged.
   */
  decideDetailed(input: DecisionInput): Promise<DecisionOutcome> {
    try {
      return Promise.resolve(this.run(input));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // --- internals -----------------------------------------------------------

  private run(input: DecisionInput): DecisionOutcome {
    let norm: Normal;
    try {
      norm = normalize(this.subjects, input);
    } catch {
      return refused(INVALID);
    }
    const report = this.store.loadReport(norm.reportId);
    if (report === null) return refused({ ok: false, error: 'not_found' });

    const key = keyOf(norm);
    const prior = this.store.findDecision(key);
    if (prior !== null) return refused(this.replayOf(prior.resultJson));
    if (report.status !== 'open') return refused({ ok: false, error: 'already_decided' });

    let plan: Planned[];
    try {
      plan = this.plan(norm, report);
    } catch {
      // Planning reads nothing from the store, so whatever it threw, nothing has been written.
      return refused(INVALID);
    }
    return this.commit(norm, report, key, plan);
  }

  /** Check every action against the report, the rules and the sanction rules. Throws on the first problem. */
  private plan(norm: Normal, report: ReportRecord): Planned[] {
    const target = this.subjects.canonical(report.targetSubject);
    const reporter = this.subjects.canonical(report.reporterSubject);
    // A decision acts only on people in the report: its target, its reporter, or someone who wrote in the excerpt.
    const scope = new Set<SubjectId>([target, reporter, ...report.people.map((p) => this.subjects.canonical(p))]);

    return norm.actions.map((a) => {
      if (!scope.has(a.subject)) return bad();
      // A dismissal cannot punish the person the report was about.
      if (isDismissal(norm.verdict) && a.subject === target) return bad();
      if (!this.rules.isCitable(a.rule)) return bad();
      validateSanctionInput(this.sanctionInput(norm, a, report.roomId));
      const lines = a.lineIds.length === 0 ? [] : ownLines(report, a.subject, a.lineIds, this.subjects);
      if (!lines.every(lineIsSound)) return bad();
      return { action: a, lines };
    });
  }

  private sanctionInput(norm: Normal, a: NormalAction, roomId: string) {
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
      roomId: roomId === '' ? null : roomId,
      ...(a.gapNote === undefined ? {} : { gapNote: a.gapNote }),
    };
  }

  private commit(norm: Normal, report: ReportRecord, key: string, plan: Planned[]): DecisionOutcome {
    const now = this.clock.now();
    const pending = this.index !== undefined && !this.index.isEnabled();
    const reporter = this.subjects.canonical(report.reporterSubject);
    const status = isDismissal(norm.verdict) ? 'dismissed' : 'actioned';
    const outcome = this.outcomeFor(norm, report, now);

    const done = this.store.transaction(() => {
      if (!this.store.closeReport(report.id, status, norm.verdict === 'bad_faith', norm.actor, now, norm.reason, norm.evidence)) {
        return null;
      }
      const groups: DecisionGroup[] = [];
      const applied: AppliedGroup[] = [];
      const rows: SanctionRow[] = [];
      const told = new Set<SubjectId>();
      for (const { action: a, lines } of plan) {
        // No index here: the rows reach it only after the transaction has committed.
        const written = writeSanction(this.store, this.subjects, this.sanctionInput(norm, a, report.roomId), now, pending);
        // A note is on the record and tells the player nothing: no notice, so nobody to announce to either.
        const noticeId =
          a.kind === 'note'
            ? null
            : this.notices.createForSanction(
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
        if (noticeId !== null) told.add(a.subject);
        groups.push({ subject: a.subject, groupId: written.groupId, refCode: written.refCode, kind: a.kind, noticeId });
        applied.push({
          groupId: written.groupId,
          refCode: written.refCode,
          kind: a.kind,
          until: a.kind === 'warning' || a.kind === 'note' ? null : written.endsAt,
          rule: a.rule,
          source: norm.source,
          target: a.subject,
          gap: (written.rows[0]?.gapNote ?? null) !== null,
        });
        rows.push(...written.rows);
      }
      // Reporter feedback only on `upheld` with at least one NON-note action: a note is staff-only and must never
      // tell the reporter anything, however many of them sit beside the other actions.
      if (this.reporterFeedback && norm.verdict === 'upheld' && plan.some(({ action }) => action.kind !== 'note')) {
        this.notices.createReportOutcome(reporter, { notify: false });
        told.add(reporter);
      }
      this.store.insertDecision(key, report.id, now, JSON.stringify({ groups }));
      // The casebook row lands with the decision or not at all. A casebook that cannot be written never fails the decision.
      let recorded: AiOutcomeInsert['agreement'] | null = null;
      if (outcome !== null) {
        try {
          if (this.store.insertAiOutcome?.(outcome) === true) recorded = outcome.agreement;
        } catch (err) {
          this.warn('decide.ai_outcome_failed', { error: errName(err) });
        }
      }
      return { groups, applied, rows, told, recorded };
    });

    if (done === null) {
      // Someone closed the report between our read and our write (another process). Same decision? Then it is a replay.
      const again = this.store.findDecision(key);
      return refused(again === null ? { ok: false, error: 'already_decided' } : this.replayOf(again.resultJson));
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
    return {
      result: { ok: true, groups: done.groups, replay: false },
      committed: {
        reportId: report.id,
        verdict: norm.verdict,
        at: now,
        applied: done.applied,
        aiOutcome: done.recorded === null ? null : { agreement: done.recorded, role: norm.ai.role, actor: norm.actor },
      },
    };
  }

  /** The casebook row for this decision, or null: no echo, no hook, no AI store method, or the hook declines or fails. */
  private outcomeFor(norm: Normal, report: ReportRecord, now: number): AiOutcomeInsert | null {
    if (this.aiOutcome === undefined || typeof this.store.insertAiOutcome !== 'function') return null;
    try {
      return this.aiOutcome({
        report,
        target: this.subjects.canonical(report.targetSubject),
        verdict: norm.verdict,
        actions: norm.actions.map((a) => ({ subject: a.subject, kind: a.kind, durationMs: a.durationMs, rule: a.rule, lineIds: a.lineIds })),
        ai: { readId: norm.ai.readId, accepted: norm.ai.accepted, severity: norm.ai.severity },
        now,
      });
    } catch (err) {
      this.warn('decide.ai_outcome_failed', { error: errName(err) });
      return null;
    }
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
