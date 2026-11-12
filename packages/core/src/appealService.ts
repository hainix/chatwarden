import { APPEAL_STATEMENT_MAX, normalizeStatement, statementLength } from './appeals.js';
import type { AppealFileResult, PlayerAppeal, ResolvedAppeals } from './appeals.js';
import { randomId } from './crypto.js';
import type { KitEvent } from './events.js';
import { safeWarn } from './log.js';
import { appliesInRecord } from './notices.js';
import type { NoticeService } from './notices.js';
import { parseRuleRef } from './rules.js';
import type { RuleRef } from './rules.js';
import type { SubjectIndex } from './subjects.js';
import type { AppealRow, Clock, Logger, RawWho, Store, SubjectId } from './types.js';

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
}

/** A refusal that must roll the filing's transaction back (the row was written to test the unique group and the rate). */
class Refuse extends Error {
  readonly refused: 'already_appealed' | 'rate';
  readonly retryAfterMs: number | undefined;
  constructor(refused: 'already_appealed' | 'rate', retryAfterMs?: number) {
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
        // rate is then counted with the new row in it. Either refusal rolls the row back: a refusal writes nothing.
        if (this.d.store.insertAppeal?.(row) !== true) throw new Refuse('already_appealed');
        const count = this.d.store.countAppealsBy?.(aliases, since) ?? { count: 0, oldestAt: null };
        if (count.count > cap) throw new Refuse('rate', Math.max(1, (count.oldestAt ?? now) + WEEK_MS - now));
      });
    } catch (err) {
      if (err instanceof Refuse) return err.refused === 'rate' ? { ok: false, refused: 'rate', retryAfterMs: err.retryAfterMs ?? 1 } : { ok: false, refused: 'already_appealed' };
      throw err;
    }

    try {
      this.d.emit({ type: 'appeal.created', appealId: row.id, createdAt: row.createdAt, target: person, kind: row.kind, rule: ruleRefOf(row.rule) });
    } catch (err) {
      safeWarn(this.d.logger, 'chatwarden.event_failed', { error: errName(err) });
    }
    return { ok: true, appeal: toPlayerAppeal(row) };
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
