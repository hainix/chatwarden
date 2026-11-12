import { randomId } from './crypto.js';
import { hashWho } from './hasher.js';
import { safeWarn, ThrottledWarn } from './log.js';
import { evidenceName, NameEvidenceLimiter, profanityView } from './names.js';
import type { NameCheckResult, NameReason, ResolvedNames } from './names.js';
import type { Clock, Hasher, Logger, Matcher, ProfanityFilter, RawWho, Store, SubjectId } from './types.js';

// The name check behind `cw.names`: the matcher, an optional profanity pass, optional kept evidence (capped), and the evidence-free
// `flagged` read for staff paths. A name is never logged and never echoed; the answer carries a reason id and a rule number.

export interface NameServiceDeps {
  store: Store;
  clock: Clock;
  logger: Logger | undefined;
  hasher: Hasher;
  /** The slur filter's rule (`autoRestrictRule`): what a refusal cites. */
  rule: number;
  matcher: Matcher | undefined;
  /** The settings in force now (read on every call: a policy change takes effect at once). */
  settings: () => ResolvedNames;
  /** The profanity filter for names, or undefined when there is none. May throw (a package that cannot build one). */
  filter: () => ProfanityFilter | undefined;
  /** The person behind a caller, FOUND and never created. */
  personOf: (who: RawWho) => SubjectId | null;
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** Why a name is refused, and the matcher's term id for a `name_not_allowed`. */
interface Verdict {
  reason: NameReason;
  termId: string | null;
}

export class NameService {
  private readonly d: NameServiceDeps;
  private readonly limiter = new NameEvidenceLimiter();
  private readonly flaggedWarn: ThrottledWarn;
  private readonly evidenceWarn: ThrottledWarn;

  constructor(deps: NameServiceDeps) {
    this.d = deps;
    this.flaggedWarn = new ThrottledWarn(deps.logger, deps.clock);
    this.evidenceWarn = new ThrottledWarn(deps.logger, deps.clock);
  }

  check(text: string, opts?: { who?: RawWho }): NameCheckResult {
    if (typeof text !== 'string') throw new TypeError('names.check: the name must be a string');
    const verdict = this.verdict(text);
    if (verdict === null) return { ok: true };
    this.keep(text, verdict, opts);
    return { ok: false, reason: verdict.reason, rule: this.d.rule };
  }

  /** The matcher's reading alone: no profanity, no store, no person. False for anything it cannot read. Never throws. */
  flagged(text: string): boolean {
    if (typeof text !== 'string') return false;
    try {
      return this.matched(text) !== null;
    } catch (err) {
      this.flaggedWarn.warn('chatwarden.names_matcher_failed', { error: errName(err) });
      return false;
    }
  }

  /** The matcher's term id for a name it refuses, or null. Throws what the matcher throws. */
  private matched(text: string): { termId: string | null } | null {
    const m = this.d.matcher;
    if (m === undefined) return null;
    const hit = typeof m.matchName === 'function' ? m.matchName(text) : m.match(text);
    if (hit === null || hit === undefined) return null;
    return { termId: typeof hit.termId === 'string' ? hit.termId : null };
  }

  private verdict(text: string): Verdict | null {
    try {
      const hit = this.matched(text);
      if (hit !== null) return { reason: 'name_not_allowed', termId: hit.termId };
    } catch (err) {
      safeWarn(this.d.logger, 'chatwarden.names_matcher_failed', { error: errName(err) });
    }
    if (!this.d.settings().profanity) return null;
    try {
      const filter = this.d.filter();
      if (filter === undefined) return null;
      if (filter.apply(text).hit) return { reason: 'name_profane', termId: null };
      const spaced = profanityView(text);
      if (spaced !== text && filter.apply(spaced).hit) return { reason: 'name_profane', termId: null };
    } catch (err) {
      safeWarn(this.d.logger, 'chatwarden.names_filter_failed', { error: errName(err) });
    }
    return null;
  }

  /** Keep a blocked name as evidence, when the adopter opted in and the hourly caps allow. Fenced: nothing in here reaches the caller. */
  private keep(text: string, verdict: Verdict, opts: { who?: RawWho } | undefined): void {
    try {
      if (!this.d.settings().keepBlocked) return;
      const store = this.d.store;
      if (typeof store.insertBlockedName !== 'function') {
        this.evidenceWarn.warn('chatwarden.names_evidence_unavailable', {});
        return;
      }
      const now = this.d.clock.now();
      const name = evidenceName(text);
      const who = this.whoOf(opts);
      const subject = who === undefined ? null : this.d.personOf(who);
      const key = this.keyOf(subject, who, name);
      if (!this.limiter.allow(key, now)) return;
      store.transaction(() => store.insertBlockedName?.({ id: randomId(), subject, name, termId: verdict.termId, reason: verdict.reason, at: now }));
      this.limiter.record(key, now);
    } catch (err) {
      safeWarn(this.d.logger, 'chatwarden.names_evidence_failed', { error: errName(err) });
    }
  }

  /** The caller, as far as it is usable: an object. A getter that throws is the caller's fault and is absorbed by `keep`'s fence. */
  private whoOf(opts: { who?: RawWho } | undefined): RawWho | undefined {
    if (typeof opts !== 'object' || opts === null) return undefined;
    const who: unknown = opts.who;
    return typeof who === 'object' && who !== null ? (who as RawWho) : undefined;
  }

  /** What the hourly cap counts a person by: the person found, else the caller's own identifiers, else the name. Never the raw values. */
  private keyOf(subject: SubjectId | null, who: RawWho | undefined, name: string): string {
    if (subject !== null) return `s:${subject}`;
    if (who !== undefined) {
      const ids = hashWho(this.d.hasher, who);
      if (ids.clientKey !== null || ids.accountId !== null || ids.ipHash !== null) {
        return `w:${ids.clientKey ?? ''}|${typeof ids.accountId === 'string' ? this.d.hasher.clientKey(`account:${ids.accountId}`) : ''}|${ids.ipHash ?? ''}`;
      }
    }
    return `n:${this.d.hasher.clientKey(`name:${name.toLowerCase()}`)}`;
  }
}
