import {
  APPEAL_OUTCOMES,
  APPEAL_RATE_ELEVATED,
  APPEAL_RATE_HIGH,
  APPEAL_REASON_CODES,
  APPEAL_REASON_DEFAULT,
  APPEAL_REASONS,
  APPEAL_STATEMENT_MAX,
  APPEAL_STATS_MIN_SANCTIONS,
  normalizeStatement,
  SANCTION_KIND_ORDER,
  statementLength,
} from './appeals.js';
import type {
  AppealCause,
  AppealDecideResult,
  AppealDecision,
  AppealDetail,
  AppealFileResult,
  AppealOutcome,
  AppealPage,
  AppealReasonCode,
  AppealRuleStats,
  AppealStats,
  AppealSummary,
  PlayerAppeal,
  ResolvedAppeals,
} from './appeals.js';
import { isValidAuditActor } from './audit.js';
import { randomId } from './crypto.js';
import type { KitEvent } from './events.js';
import { safeWarn } from './log.js';
import { appealReduction } from './noticePlan.js';
import { appliesInRecord } from './notices.js';
import type { NoticeService } from './notices.js';
import { parseRuleRef } from './rules.js';
import type { RuleRef } from './rules.js';
import { APPEALS_START_TOKEN, MAX_SANCTION_DURATION_MS, writeSanction } from './sanctions.js';
import type { SanctionIndex } from './sanctions.js';
import { b64urlDecode, b64urlEncode } from './staffReports.js';
import type { SubjectIndex } from './subjects.js';
import type { AppealRow, Clock, Logger, Matcher, RawWho, SanctionRow, Store, SubjectId } from './types.js';

// The appeals service: filing (the player side) here; deciding and the staff reads are added to the same class. It holds no state of its own:
// every fact is in the store, so two processes on one database agree.

const WEEK_MS = 7 * 24 * 3_600_000;
/** The most appeals `mine` answers. */
export const MINE_MAX = 50;

/** The store methods appeals need. A store without all of them cannot keep appeals. */
export const APPEAL_STORE_METHODS = [
  'insertAppeal',
  'loadAppeal',
  'listAppeals',
  'listAppealsBy',
  'countAppealsBy',
  'countOpenAppeals',
  'decideAppeal',
  'closeAppealsForGroup',
  'appealCountsByRule',
  'countSanctionsByRule',
  'loadSanctionSubjectRow',
] as const;

/** True when the store has every method appeals need. */
export function hasAppealMethods(store: Store): boolean {
  const s = store as unknown as Record<string, unknown>;
  return APPEAL_STORE_METHODS.every((m) => typeof s[m] === 'function');
}

export interface AppealServiceDeps {
  store: Store;
  subjects: SubjectIndex;
  notices: NoticeService;
  clock: Clock;
  logger?: Logger | undefined;
  /** The appeal settings in force, read live. */
  settings: () => ResolvedAppeals;
  /** The person behind a player's connection details, FOUND and never created. */
  personOf: (who: RawWho) => SubjectId | null;
  /** Announce an event after a commit. Fenced by the caller of the service. */
  emit: (event: KitEvent) => void;
  /** The term matcher, to say whether a statement trips it (read on every list and get, so a term added later masks an older statement). */
  matcher?: Matcher | undefined;
  /** The in-memory sanction index: a revoked or replaced group leaves it, a replacement joins it, after the commit. */
  index: SanctionIndex;
  /** True when `retention.appealStatementsMs` is 0: a statement is cleared in the decision (and as an appeal is made moot). */
  clearStatements: () => boolean;
  /**
   * Told, inside the decision's transaction and fenced, when an appeal was granted (`reduce` or `revoke`) and its sanction came from a
   * report: the AI's casebook marks that decision reversed. A throw is logged and never fails the decision.
   */
  onGranted?: (appeal: AppealRow, outcome: 'reduce' | 'revoke') => void;
  /** The strike count that tips an automatic restriction (`limits.strikes.count`), read live: the cause of an appeal on one says it. */
  strikesCount: () => number;
  /** The strike window (`limits.strikes.windowMs`): the strikes of an overturned automatic restriction are the ones in the window before its start. */
  strikeWindowMs: number;
  /**
   * Told, after the commit and fenced, that an automatic restriction (`source: 'auto_filter'`) was overturned and recorded: the in-memory strike tally forgets the
   * strikes that earned it (`StrikeService.forgive`). A throw is logged by class and never fails the decision.
   */
  forgive?: (subject: SubjectId, startsAt: number) => void;
}

/** A decision step that must roll the transaction back and answer something other than success. */
class Stop extends Error {
  readonly why: 'already_decided' | 'gone';
  constructor(why: 'already_decided' | 'gone') {
    super(why);
    this.why = why;
  }
}

const OUTCOME_STATUS = { uphold: 'upheld', reduce: 'reduced', revoke: 'revoked' } as const;
const OUTCOME_NOTICE = { uphold: 'appeal_upheld', reduce: 'appeal_reduced', revoke: 'appeal_revoked' } as const;
const INVALID = { ok: false, error: 'invalid' } as const;
const INVALID_REASON = Symbol('invalid_reason');

interface CheckedDecision {
  appealId: string;
  outcome: AppealOutcome;
  actor: string;
  reason: string;
  /** The fixed reason, resolved: the one given, or the default when the key was absent. */
  reasonCode: AppealReasonCode;
  to: { kind: 'warning' | 'chat' | 'area' | 'ban'; durationMs: number | null } | null;
}

/**
 * The decision as the service reads it: null when it is not well formed (`invalid`), the marker {@link INVALID_REASON} when the shape is fine but the
 * reason code is not one the outcome offers (`invalid_reason`), else the checked decision. Each field is read once, and the code is read only after the
 * shape passed (an absent key, or `undefined`, is the one way to ask for the default; `null` is not).
 */
function checkDecision(input: AppealDecision): CheckedDecision | typeof INVALID_REASON | null {
  if (typeof input !== 'object' || input === null) return null;
  const { appealId, outcome, actor, reason, to } = input as unknown as Record<string, unknown>;
  if (typeof appealId !== 'string' || appealId === '') return null;
  if (typeof outcome !== 'string' || !(APPEAL_OUTCOMES as readonly string[]).includes(outcome)) return null;
  if (!isValidAuditActor(actor)) return null;
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why === '' || why.length > 500) return null;
  let code: AppealReasonCode;
  const given: unknown = (input as unknown as Record<string, unknown>).reasonCode;
  if (given === undefined) {
    code = APPEAL_REASON_DEFAULT;
  } else {
    // A string that is one of the seven AND one this outcome offers: compared against the frozen lists, never by property lookup (so 'toString' is not a code).
    if (typeof given !== 'string' || !(APPEAL_REASON_CODES as readonly string[]).includes(given)) return INVALID_REASON;
    if (!(APPEAL_REASONS[outcome as AppealOutcome] as readonly string[]).includes(given)) return INVALID_REASON;
    code = given as AppealReasonCode;
  }
  if (outcome !== 'reduce') return to === undefined ? { appealId, outcome: outcome as AppealOutcome, actor, reason: why, reasonCode: code, to: null } : null;
  if (typeof to !== 'object' || to === null) return null;
  const { kind, durationMs } = to as Record<string, unknown>;
  if (typeof kind !== 'string' || !(SANCTION_KIND_ORDER as readonly string[]).includes(kind)) return null;
  if (kind === 'warning') {
    if (durationMs !== null) return null;
  } else if (durationMs !== null && (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_SANCTION_DURATION_MS)) {
    return null;
  }
  return { appealId, outcome: 'reduce', actor, reason: why, reasonCode: code, to: { kind: kind as 'warning' | 'chat' | 'area' | 'ban', durationMs: durationMs as number | null } };
}

/** The stored reason code of a decided appeal when it is one the kit knows (a moot appeal, an older row and anything else read null). */
function knownReasonCode(r: AppealRow): AppealReasonCode | null {
  const code = r.reasonCode;
  return r.status !== 'moot' && typeof code === 'string' && (APPEAL_REASON_CODES as readonly string[]).includes(code) ? (code as AppealReasonCode) : null;
}

/** A refusal that must roll the filing's transaction back (the row was written to test the unique group and the rate). */
class Refuse extends Error {
  readonly refused: 'already_appealed' | 'rate' | 'not_appealable';
  readonly retryAfterMs: number | undefined;
  constructor(refused: 'already_appealed' | 'rate' | 'not_appealable', retryAfterMs?: number) {
    super(refused);
    this.refused = refused;
    this.retryAfterMs = retryAfterMs;
  }
}

const errName = (err: unknown): string => {
  try {
    return err instanceof Error ? err.name : typeof err;
  } catch {
    return 'unknown';
  }
};

/** The stored rule text as a rule reference, or null for none or a value that is not one. */
export function ruleRefOf(text: string | null): RuleRef | null {
  if (text === null) return null;
  try {
    return parseRuleRef(text);
  } catch {
    return null;
  }
}

const NOT_FOUND = { ok: false, refused: 'not_found' } as const;

export class AppealService {
  private readonly d: AppealServiceDeps;

  constructor(deps: AppealServiceDeps) {
    this.d = deps;
  }

  /** Appeals are on in the profile in force AND the store can keep them. */
  enabled(): boolean {
    return this.d.settings().enabled && hasAppealMethods(this.d.store);
  }

  private warn(err: unknown): void {
    safeWarn(this.d.logger, 'chatwarden.appeal_failed', { error: errName(err) });
  }

  file(who: RawWho, input: { noticeId: string; statement: string }): AppealFileResult {
    if (!this.enabled()) return { ok: false, refused: 'off' };
    try {
      return this.fileInner(who, input);
    } catch (err) {
      // A store failure reads as "no such notice": the player is told nothing about the kit's health, the operator gets the class.
      this.warn(err);
      return NOT_FOUND;
    }
  }

  private fileInner(who: RawWho, input: { noticeId: string; statement: string }): AppealFileResult {
    if (typeof who !== 'object' || who === null || typeof input !== 'object' || input === null) return NOT_FOUND;
    const noticeId: unknown = input.noticeId;
    const subject = this.d.personOf(who);
    if (subject === null || typeof noticeId !== 'string' || noticeId === '') return NOT_FOUND;
    const notice = this.d.notices.ownRow(subject, noticeId);
    if (notice === null) return NOT_FOUND;
    const now = this.d.clock.now();
    if (notice.groupId === null || !appliesInRecord(notice, now)) return { ok: false, refused: 'not_appealable' };

    const statement = normalizeStatement(input.statement);
    if (statement === '' || statementLength(statement) > APPEAL_STATEMENT_MAX) return { ok: false, refused: 'statement_invalid' };

    const group = this.d.store.loadSanctionSubjectRow?.(notice.groupId) ?? null;
    // The notice outlived its sanction rows (retention): there is nothing left to appeal.
    if (group === null || group.revokedAt !== undefined) return { ok: false, refused: 'not_appealable' };

    const person = this.d.subjects.canonical(subject);
    const aliases = this.d.subjects.aliasesOf(person);
    const cap = this.d.settings().perPlayerPerWeek;
    const row: AppealRow = {
      id: randomId(16),
      subject: person,
      groupId: notice.groupId,
      noticeId: notice.id,
      reportId: group.reportId ?? null,
      rule: group.rule,
      kind: group.kind,
      statement,
      status: 'open',
      createdAt: now,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      replacementGroupId: null,
    };
    const since = now - WEEK_MS + 1; // a row exactly a week old has left the window
    try {
      this.d.store.transaction(() => {
        // The unique group decides "already appealed" in the same statement that writes the row, so of two filings exactly one wins; the
        // rate is then counted with the new row in it. Either refusal rolls the row back: a refusal writes nothing. The sanction is read
        // again here: a revoke by another process may have committed since the read above, and its hook cannot have closed a row that
        // did not exist yet.
        const live = this.d.store.loadSanctionSubjectRow?.(row.groupId) ?? null;
        if (live === null || live.revokedAt !== undefined) throw new Refuse('not_appealable');
        if (this.d.store.insertAppeal?.(row) !== true) throw new Refuse('already_appealed');
        const count = this.d.store.countAppealsBy?.(aliases, since) ?? { count: 0, oldestAt: null };
        if (count.count > cap) throw new Refuse('rate', Math.max(1, (count.oldestAt ?? now) + WEEK_MS - now));
      });
    } catch (err) {
      if (err instanceof Refuse) {
        if (err.refused === 'rate') return { ok: false, refused: 'rate', retryAfterMs: err.retryAfterMs ?? 1 };
        return { ok: false, refused: err.refused };
      }
      throw err;
    }

    try {
      this.d.emit({ type: 'appeal.created', appealId: row.id, createdAt: row.createdAt, target: person, kind: row.kind, rule: ruleRefOf(row.rule) });
    } catch (err) {
      safeWarn(this.d.logger, 'chatwarden.event_failed', { error: errName(err) });
    }
    return { ok: true, appeal: toPlayerAppeal(row) };
  }

  /**
   * Decide an open appeal, once. One store transaction: the sanction is revoked (reduce, revoke), the replacement written (reduce), the
   * player's notices made, and the appeal moved from open only, so a second decision, or one made while another process decides, finds it
   * decided and changes nothing. Checks, in order: a well-formed decision (`invalid`), the appeal (`not_found`, `already_decided`), the
   * sanction still standing (`gone`, which also makes the appeal moot), independence (`same_decider`), and for a reduction that `to` is
   * lighter (`invalid`). A STORE failure rejects and writes nothing. After the commit, each fenced: the player is told, the sanction index
   * updated and `appeal.decided` emitted.
   */
  async decide(input: AppealDecision): Promise<AppealDecideResult> {
    if (!this.enabled()) return { ok: false, error: 'not_found' };
    const d = checkDecision(input);
    if (d === null) return INVALID;
    if (d === INVALID_REASON) return { ok: false, error: 'invalid_reason' };
    try {
      return this.decideChecked(d);
    } catch (err) {
      this.warn(err);
      throw err;
    }
  }

  private decideChecked(d: CheckedDecision): AppealDecideResult {
    const { store, subjects, clock, notices } = this.d;
    const now = clock.now();
    const appeal = store.loadAppeal?.(d.appealId) ?? null;
    if (appeal === null) return { ok: false, error: 'not_found' };
    // A moot appeal means its sanction was revoked first: that is `gone`. Any other closed appeal was decided.
    if (appeal.status === 'moot') return { ok: false, error: 'gone' };
    if (appeal.status !== 'open') return { ok: false, error: 'already_decided' };
    const group = store.loadSanctionSubjectRow?.(appeal.groupId) ?? null;
    // The sanction is gone (retention) or was revoked by a path that did not make the appeal moot: nothing is left to rule on.
    if (group === null || group.revokedAt !== undefined) return this.mootGone(appeal, d.actor, now);
    if (!this.d.settings().allowSelfReview && !group.automated && group.actor === d.actor) return { ok: false, error: 'same_decider' };
    const plan = d.outcome === 'reduce' ? appealReduction(group, d.to) : null;
    if (d.outcome === 'reduce' && plan === null) return INVALID;

    const person = subjects.canonical(appeal.subject);
    const clear = this.d.clearStatements();
    const pending = !this.d.index.isEnabled();
    let written: ReturnType<typeof writeSanction> | null = null;
    // What the overturn record said, for the announcements after the commit (null: none was recorded).
    let overturn: { termId: string | null; filterKey: string | null } | null = null;
    try {
      store.transaction(() => {
        if (d.outcome !== 'uphold') {
          // Straight to the store, not `revokeSanction`: that would make this very appeal moot before it is decided.
          if (store.revokeSanctionGroup(appeal.groupId, d.actor, now, d.reason) === 0) throw new Stop('gone');
          notices.withdrawGroup(appeal.groupId);
        }
        if (plan !== null) {
          written = writeSanction(
            store,
            subjects,
            {
              kind: plan.kind,
              subject: person,
              includeIp: false,
              durationMs: plan.durationMs,
              reason: d.reason,
              actor: d.actor,
              source: 'moderator',
              automated: false,
              rule: appeal.rule === null ? 'uncovered' : (ruleRefOf(appeal.rule) ?? 'uncovered'),
              roomId: group.roomId,
              startsAt: group.startsAt,
              // The same report as the original, so the replacement stays in the scoped views the original was in.
              ...(typeof group.reportId === 'string' && group.reportId !== '' ? { reportId: group.reportId } : {}),
              startsAtToken: APPEALS_START_TOKEN,
            },
            now,
            pending,
          );
          notices.createForSanction(
            { groupId: written.groupId, refCode: written.refCode, kind: plan.kind, until: plan.kind === 'warning' ? null : written.endsAt, rule: ruleRefOf(appeal.rule), subject: person },
            [],
            { notify: false },
          );
        }
        notices.createMessage(person, OUTCOME_NOTICE[d.outcome], { rule: ruleRefOf(appeal.rule), refCode: group.refCode, notify: false });
        const moved = store.decideAppeal?.(appeal.id, {
          status: OUTCOME_STATUS[d.outcome],
          at: now,
          by: d.actor,
          reason: d.reason,
          reasonCode: d.reasonCode,
          replacementGroupId: written === null ? null : (written as ReturnType<typeof writeSanction>).groupId,
          ...(clear ? { clearStatement: true } : {}),
        });
        if (moved !== true) throw new Stop('already_decided');
        if (d.outcome !== 'uphold') overturn = this.recordOverturn(appeal, group, person, now);
        if (d.outcome !== 'uphold' && appeal.reportId !== null) {
          try {
            this.d.onGranted?.(appeal, d.outcome);
          } catch (err) {
            this.warn(err);
          }
        }
      });
    } catch (err) {
      if (err instanceof Stop) {
        if (err.why !== 'gone') return { ok: false, error: 'already_decided' };
        // The revoke found nothing to revoke. When another process decided this appeal first (and so revoked or replaced the group), this
        // call lost the race and the answer is `already_decided`; only an appeal still open has really lost its sanction.
        const now_ = store.loadAppeal?.(appeal.id) ?? null;
        if (now_ !== null && now_.status !== 'open') return { ok: false, error: now_.status === 'moot' ? 'gone' : 'already_decided' };
        return this.mootGone(appeal, d.actor, now);
      }
      throw err;
    }

    // Committed. Each of these is fenced: none can fail a decision that is already made.
    const fenced = (what: () => void): void => {
      try {
        what();
      } catch (err) {
        safeWarn(this.d.logger, 'chatwarden.event_failed', { error: errName(err) });
      }
    };
    if (d.outcome !== 'uphold') fenced(() => this.d.index.remove(appeal.groupId));
    const made = written as ReturnType<typeof writeSanction> | null;
    if (made !== null) fenced(() => this.d.index.add(made.rows, now));
    fenced(() => notices.announce(person));
    // An automatic restriction that was overturned: the live tally forgets the strikes that earned it (the store already set them aside).
    const recorded = overturn as { termId: string | null; filterKey: string | null } | null;
    if (recorded !== null && group.source === 'auto_filter') fenced(() => this.d.forgive?.(person, group.startsAt));
    if (recorded !== null) {
      fenced(() =>
        this.d.emit({
          type: 'sanction.overturned',
          groupId: appeal.groupId,
          at: now,
          source: group.source,
          ...(recorded.termId === null ? {} : { termId: recorded.termId }),
          ...(recorded.filterKey === null ? {} : { filterKey: recorded.filterKey }),
        }),
      );
    }
    fenced(() => this.d.emit({ type: 'appeal.decided', appealId: appeal.id, at: now, target: person, outcome: d.outcome, rule: ruleRefOf(appeal.rule), reason: d.reasonCode }));
    return { ok: true, status: OUTCOME_STATUS[d.outcome], ...(made === null ? {} : { replacementGroupId: made.groupId }) };
  }

  /**
   * Record the overturn of a granted appeal, inside the decision's transaction: the group, the strikes that earned an automatic restriction, and the report a
   * decision came from. Null when the store cannot record it, or already had (another process recorded this group first); a throw is the store failing and rolls
   * the decision back like any other store failure.
   */
  private recordOverturn(appeal: AppealRow, group: SanctionRow, person: SubjectId, now: number): { termId: string | null; filterKey: string | null } | null {
    const { store, subjects } = this.d;
    if (store.recordOverturn === undefined) return null;
    const automatic = group.source === 'auto_filter';
    const termId = automatic ? (group.termId ?? null) : null;
    const report = appeal.reportId === null ? null : store.loadReport(appeal.reportId);
    const filterKey = report !== null && report.origin === 'filter' && typeof report.originKey === 'string' ? report.originKey : null;
    const recorded = store.recordOverturn({
      groupId: appeal.groupId,
      at: now,
      subject: person,
      aliases: subjects.aliasesOf(person),
      source: group.source,
      termId,
      filterKey,
      reportId: appeal.reportId,
      strikes: automatic ? { from: group.startsAt - this.d.strikeWindowMs, to: group.startsAt } : null,
    });
    return recorded ? { termId, filterKey } : null;
  }

  /** The sanction is gone: close the appeal as moot (committed, unlike a refusal) and say so. Nothing is announced or marked. */
  private mootGone(appeal: AppealRow, by: string, now: number): AppealDecideResult {
    this.d.store.transaction(() => this.d.store.closeAppealsForGroup?.(appeal.groupId, by, now, this.d.clearStatements()));
    return { ok: false, error: 'gone' };
  }

  // --- staff reads ----------------------------------------------------------------------------------------------------------

  /** Whether `statement` trips the term filter now. A matcher that throws reads as not flagged (logged by class), like the chat path. */
  private flagged(statement: string | null): boolean {
    if (statement === null || this.d.matcher === undefined) return false;
    try {
      return this.d.matcher.match(statement) !== null;
    } catch (err) {
      this.warn(err);
      return false;
    }
  }

  private summaryOf(r: AppealRow): AppealSummary {
    const g = this.d.store.loadSanctionSubjectRow?.(r.groupId) ?? null;
    return {
      id: r.id,
      createdAt: r.createdAt,
      status: r.status,
      person: this.d.subjects.canonical(r.subject),
      // The sanction rows can be gone (retention): the appeal still lists, from its own row.
      sanction:
        g === null
          ? { groupId: r.groupId, refCode: '', kind: r.kind, rule: ruleRefOf(r.rule), startsAt: r.createdAt, endsAt: null, decidedBy: '', automated: false }
          : { groupId: g.groupId, refCode: g.refCode, kind: g.kind, rule: ruleRefOf(g.rule), startsAt: g.startsAt, endsAt: g.endsAt, decidedBy: g.actor, automated: g.automated },
      statementFlagged: this.flagged(r.statement),
    };
  }

  /**
   * The inbox, oldest first: `open` (default), `decided` or `all`; `limit` 1 to 200 (default 50); `cursor` the `next` of the previous page.
   * A summary never carries the statement. A moot appeal is not listed. `RangeError` for a bad status, limit or cursor. Empty with appeals off.
   */
  list(q: { status?: 'open' | 'decided' | 'all'; limit?: number; cursor?: string | null }): AppealPage {
    if (!this.enabled()) return { items: [], next: null };
    const query: { status?: unknown; limit?: unknown; cursor?: unknown } = typeof q === 'object' && q !== null ? q : {};
    const status = query.status === undefined ? 'open' : query.status;
    if (status !== 'open' && status !== 'decided' && status !== 'all') throw new RangeError('appeals.list: status must be open, decided or all');
    const limit = query.limit === undefined ? 50 : query.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('appeals.list: limit must be an integer from 1 to 200');
    const after = query.cursor === undefined || query.cursor === null ? undefined : decodeCursor(query.cursor);
    try {
      const rows = this.d.store.listAppeals?.({ status, limit, ...(after === undefined ? {} : { after }) }) ?? [];
      const last = rows[rows.length - 1];
      return { items: rows.map((r) => this.summaryOf(r)), next: rows.length === limit && last !== undefined ? b64urlEncode(`${last.createdAt}:${last.id}`) : null };
    } catch (err) {
      this.warn(err);
      return { items: [], next: null };
    }
  }

  /**
   * One person's appeals as summaries, newest first, at most 50, a moot one left out. Listed while appeals are off too (what was filed stays
   * visible on the person's page until retention removes it, as with `renamesOf`); empty for a store that cannot keep appeals, an unknown
   * person and on a store failure. Staff only.
   */
  forPerson(subject: SubjectId): AppealSummary[] {
    if (!hasAppealMethods(this.d.store) || typeof subject !== 'string' || subject === '') return [];
    try {
      const person = this.d.subjects.canonical(subject);
      return (this.d.store.listAppealsBy?.(this.d.subjects.aliasesOf(person), MINE_MAX) ?? []).filter((r) => r.status !== 'moot').map((r) => this.summaryOf(r));
    } catch (err) {
      this.warn(err);
      return [];
    }
  }

  /** One appeal in full (the statement included), or null for an unknown id, a store failure, or with appeals off. */
  get(id: string): AppealDetail | null {
    if (!this.enabled() || typeof id !== 'string' || id === '') return null;
    try {
      const r = this.d.store.loadAppeal?.(id) ?? null;
      if (r === null) return null;
      const aliases = this.d.subjects.aliasesOf(this.d.subjects.canonical(r.subject));
      const notice = this.d.store.loadNotices(aliases).find((n) => n.id === r.noticeId);
      return {
        ...this.summaryOf(r),
        statement: r.statement,
        decided:
          r.decidedAt === null || r.decidedBy === null
            ? null
            : { by: r.decidedBy, at: r.decidedAt, reason: r.decisionReason ?? '', reasonCode: knownReasonCode(r), replacementGroupId: r.replacementGroupId },
        reportId: r.reportId,
        cause: this.causeOf(r),
        shown: notice === undefined ? [] : notice.excerpt.map((l) => ({ text: l.text, day: l.day })),
      };
    } catch (err) {
      this.warn(err);
      return null;
    }
  }

  /**
   * Why the sanction behind an appeal was made. From the sanction's subject row (its source, term and report) and the report row. Never throws: rows that are gone
   * (retention) and a store that fails both read as `other`, the failure logged by class.
   */
  private causeOf(r: AppealRow): AppealCause {
    const { store } = this.d;
    try {
      const group = store.loadSanctionSubjectRow?.(r.groupId) ?? null;
      if (group === null) return { source: 'other', via: 'api' };
      if (group.source === 'auto_filter') return { source: 'term', termId: group.termId ?? null, strikes: this.d.strikesCount() };
      const reportId = typeof group.reportId === 'string' && group.reportId !== '' ? group.reportId : null;
      const report = reportId === null ? null : store.loadReport(reportId);
      if (reportId !== null && report !== null) {
        const decidedBy = group.source === 'ai' ? 'ai' : 'human';
        return report.origin === 'filter' && typeof report.originKey === 'string'
          ? { source: 'filter', reportId, filterKey: report.originKey, decidedBy }
          : { source: 'report', reportId, decidedBy };
      }
      return { source: 'other', via: group.source === 'coop' ? 'coop' : 'api' };
    } catch (err) {
      this.warn(err);
      return { source: 'other', via: 'api' };
    }
  }

  /** How many appeals are waiting. 0 with appeals off or on a store failure. */
  openCount(): number {
    if (!this.enabled()) return 0;
    try {
      return this.d.store.countOpenAppeals?.() ?? 0;
    } catch (err) {
      this.warn(err);
      return 0;
    }
  }

  /**
   * Per rule over the last 30, 90 (default) or 365 days: the sanctions given, the appeals filed, how many were revoked (`granted`, the
   * only ones that count as wrong) and how many reduced (`lightened`, shown beside the rate, never in it). The rate is granted over
   * sanctions, null below ten sanctions; `high` from 0.30, `elevated` from 0.15. `RangeError` for any other window.
   */
  stats(q?: { days?: 30 | 90 | 365 }): AppealStats {
    const days: unknown = q === undefined || q === null || q.days === undefined ? 90 : q.days;
    if (days !== 30 && days !== 90 && days !== 365) throw new RangeError('appeals.stats: days must be 30, 90 or 365');
    const empty: AppealStats = { windowDays: days, perRule: [], overall: { sanctions: 0, appealed: 0, granted: 0, lightened: 0, rate: null } };
    if (!this.enabled()) return empty;
    try {
      const since = this.d.clock.now() - days * 86_400_000;
      const byRule = new Map<number | 'uncovered', { sanctions: number; appealed: number; granted: number; lightened: number }>();
      const slot = (rule: string | null) => {
        const key: number | 'uncovered' = rule === null || rule === 'uncovered' ? 'uncovered' : (ruleRefOf(rule) as number | 'uncovered' | null) ?? 'uncovered';
        let c = byRule.get(key);
        if (c === undefined) byRule.set(key, (c = { sanctions: 0, appealed: 0, granted: 0, lightened: 0 }));
        return c;
      };
      for (const r of this.d.store.countSanctionsByRule?.(since) ?? []) slot(r.rule).sanctions += r.count;
      for (const r of this.d.store.appealCountsByRule?.(since) ?? []) {
        const c = slot(r.rule);
        c.appealed += r.appealed;
        c.granted += r.granted;
        c.lightened += r.lightened;
      }
      const perRule: AppealRuleStats[] = [...byRule.entries()]
        .sort(([a], [b]) => (a === 'uncovered' ? 1 : b === 'uncovered' ? -1 : a - b))
        .map(([rule, c]) => ({ rule, ...c, ...rateOf(c.granted, c.sanctions) }));
      const sum = perRule.reduce((t, r) => ({ sanctions: t.sanctions + r.sanctions, appealed: t.appealed + r.appealed, granted: t.granted + r.granted, lightened: t.lightened + r.lightened }), { sanctions: 0, appealed: 0, granted: 0, lightened: 0 });
      return { windowDays: days, perRule, overall: { ...sum, rate: rateOf(sum.granted, sum.sanctions).rate } };
    } catch (err) {
      this.warn(err);
      return empty;
    }
  }

  /**
   * The rules whose revoke-on-appeal rate over 90 days is `elevated` or `high`, as rule numbers and bands only, for the AI read. A reduction is
   * not a revoke, so a rule with many reduces and no revokes is never listed. Empty with appeals off.
   */
  cautions(): Array<{ rule: number; band: 'elevated' | 'high' }> {
    if (!this.enabled()) return [];
    return this.stats({ days: 90 }).perRule.flatMap((r) => (typeof r.rule === 'number' && (r.band === 'elevated' || r.band === 'high') ? [{ rule: r.rule, band: r.band }] : []));
  }

  mine(who: RawWho): PlayerAppeal[] {
    if (!this.enabled()) return [];
    try {
      if (typeof who !== 'object' || who === null) return [];
      const subject = this.d.personOf(who);
      if (subject === null) return [];
      const person = this.d.subjects.canonical(subject);
      return (this.d.store.listAppealsBy?.(this.d.subjects.aliasesOf(person), MINE_MAX) ?? []).filter((r) => r.status !== 'moot').map(toPlayerAppeal);
    } catch (err) {
      this.warn(err);
      return [];
    }
  }
}

/** The rate and its band: null below the minimum number of sanctions; `high` from 0.30, `elevated` from 0.15. */
function rateOf(granted: number, sanctions: number): { rate: number | null; band: 'normal' | 'elevated' | 'high' | null } {
  if (sanctions < APPEAL_STATS_MIN_SANCTIONS) return { rate: null, band: null };
  const rate = granted / sanctions;
  return { rate, band: rate >= APPEAL_RATE_HIGH ? 'high' : rate >= APPEAL_RATE_ELEVATED ? 'elevated' : 'normal' };
}

/** The cursor of a page: base64url of `createdAt:id`. A value that is not one we issued is a `RangeError`. */
function decodeCursor(cursor: unknown): { createdAt: number; id: string } {
  const text = typeof cursor === 'string' ? b64urlDecode(cursor) : null;
  const sep = text === null ? -1 : text.indexOf(':');
  if (text === null || sep < 1 || sep === text.length - 1 || !/^\d{1,16}$/.test(text.slice(0, sep))) throw new RangeError('appeals.list: invalid cursor');
  return { createdAt: Number(text.slice(0, sep)), id: text.slice(sep + 1) };
}

/** What a player may see of an appeal row: no staff ref, reason, sanction or person id. A moot appeal is never shown to a player. */
export function toPlayerAppeal(r: AppealRow): PlayerAppeal {
  return {
    id: r.id,
    noticeId: r.noticeId,
    status: r.status as PlayerAppeal['status'],
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  };
}
