import { errorClass, safeWarn } from './log.js';
import type { Clock, Logger, SubjectId } from './types.js';

// How old a player's account is, for the room modes (an emergency makes new accounts read-only) and probation: the adopter's `signals.accountAgeDays` hook, fenced and cached per person for
// ten minutes. A guest, a person with no account id, a throw, and an answer that is not a number of days at or above 0 are all "unknown" (`null`): the caller decides what unknown means
// (`rooms.unknownAge`). Holds no id: the cache is keyed by the canonical person and holds a number.

/** How long an age is kept before the hook is asked again. */
export const ACCOUNT_AGE_TTL_MS = 10 * 60_000;
/** The most people held; when it is reached the oldest eighth go. */
const CACHE_MAX = 20_000;

export type AccountAgeHook = (accountIds: readonly string[]) => number | null | undefined;

export interface AccountAgesDeps {
  /** `signals.accountAgeDays`. Absent: every age is unknown. */
  hook: AccountAgeHook | undefined;
  /** The account ids the game gave for a person (their canonical subject's). */
  accountIds: (subject: SubjectId) => string[];
  canonical: (subject: SubjectId) => SubjectId;
  clock: Clock;
  logger: Logger | undefined;
}

export class AccountAges {
  private readonly d: AccountAgesDeps;
  private readonly cache = new Map<SubjectId, { age: number | null; at: number }>();

  constructor(deps: AccountAgesDeps) {
    this.d = deps;
  }

  /** The age in days, or `null` when it is not known. Never throws. */
  ageOf(subject: SubjectId | null): number | null {
    if (subject === null || this.d.hook === undefined) return null;
    try {
      const person = this.d.canonical(subject);
      const now = this.d.clock.now();
      const held = this.cache.get(person);
      if (held !== undefined && now >= held.at && now - held.at < ACCOUNT_AGE_TTL_MS) return held.age;
      const ids = this.d.accountIds(person);
      let age: number | null = null;
      if (ids.length > 0) {
        try {
          const answer: unknown = this.d.hook(ids);
          age = typeof answer === 'number' && Number.isFinite(answer) && answer >= 0 ? answer : null;
        } catch (err) {
          safeWarn(this.d.logger, 'chatwarden.account_age_failed', { error: errorClass(err) });
        }
      }
      this.remember(person, age, now);
      return age;
    } catch (err) {
      safeWarn(this.d.logger, 'chatwarden.account_age_failed', { error: errorClass(err) });
      return null;
    }
  }

  /** Forget these people (their whole alias set): used when a person is erased. */
  forget(people: ReadonlySet<SubjectId>): void {
    for (const person of people) this.cache.delete(person);
  }

  private remember(person: SubjectId, age: number | null, at: number): void {
    if (!this.cache.has(person) && this.cache.size >= CACHE_MAX) {
      let drop = Math.ceil(CACHE_MAX / 8);
      for (const key of this.cache.keys()) {
        this.cache.delete(key);
        if (--drop <= 0) break;
      }
    }
    this.cache.set(person, { age, at });
  }
}
