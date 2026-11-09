import { randomBytes } from 'node:crypto';
import { safeWarn } from './log.js';
import type { SubjectIndex } from './subjects.js';
import type { Clock, Logger, Store, SubjectId } from './types.js';

// Slur attempts the filter blocked are "strikes". Three inside an hour earn an automatic chat timeout, longer for a
// repeat offender. This module only COUNTS and DECIDES the duration; the caller applies the sanction
// (`applySanction` with source `auto_filter`, `automated: true`), so the policy here stays a function of the
// strike history. Behaviour follows Moxgate's strikes module.

/** Strikes inside this window count: 1 hour. */
export const STRIKE_WINDOW_MS = 3_600_000;

/** This many strikes inside the window earn a restriction. */
export const STRIKES_TO_RESTRICT = 3;

/** The first automatic chat restriction lasts 30 minutes. */
export const STRIKE_FIRST_RESTRICT_MS = 30 * 60_000;

/** A repeat within {@link REPEAT_LOOKBACK_MS} lasts 24 hours. */
export const REPEAT_RESTRICT_MS = 24 * 3_600_000;

/** An earlier automatic chat restriction that started within this long (7 days) makes the next one longer. */
export const REPEAT_LOOKBACK_MS = 7 * 24 * 3_600_000;

const newId = (): string => randomBytes(16).toString('base64url');

const present = (id: SubjectId | null): id is SubjectId => typeof id === 'string' && id !== '';

/** What `record` tells the chat path. */
export interface StrikeDecision {
  autoRestrict: null | { durationMs: number };
}

export class StrikeService {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly subjects: SubjectIndex;
  private readonly logger: Logger | undefined;

  /**
   * Strike times (epoch ms) by the subject id the strike was filed under: the canonical subject at write time.
   * That id may have been merged away since, so every lookup folds in the keys that now canonicalise to the
   * same person. Entries older than the window are pruned on every `record`.
   */
  private tally = new Map<SubjectId, number[]>();

  /**
   * Start of the latest automatic chat restriction, by stored subject id (folded like `tally`). A strike counts
   * only if it is newer than this, so a restriction consumes the strikes that earned it. Entries older than
   * the repeat look-back can neither escalate nor consume anything, so they are pruned.
   */
  private lastAutoStart = new Map<SubjectId, number>();

  /** The fallback tally for strikes with no subject, or whose write failed: rateKey -> strike times. */
  private byRateKey = new Map<string, number[]>();

  constructor(store: Store, clock: Clock, subjects: SubjectIndex, opts?: { logger?: Logger }) {
    this.store = store;
    this.clock = clock;
    this.subjects = subjects;
    this.logger = opts?.logger;
  }

  /**
   * Rebuild the in-memory state from the store. Call once at start up, after the subject index is loaded.
   * The tally is the strikes of the last hour; `lastAutoStart` is the latest start of every `chat` sanction
   * with source `auto_filter` per subject (revoked or expired rows count: a moderator lifting a timeout does
   * not undo the behaviour). Rejects when the store read throws.
   */
  load(): Promise<void> {
    try {
      const now = this.clock.now();
      const tally = new Map<SubjectId, number[]>();
      for (const row of this.store.loadStrikes(now - STRIKE_WINDOW_MS)) {
        const times = tally.get(row.subject);
        if (times === undefined) tally.set(row.subject, [row.at]);
        else times.push(row.at);
      }
      const last = new Map<SubjectId, number>();
      for (const { subject, startsAt } of this.store.loadAutoChatStarts()) {
        if (startsAt < now - REPEAT_LOOKBACK_MS) continue;
        last.set(subject, Math.max(last.get(subject) ?? startsAt, startsAt));
      }
      this.tally = tally;
      this.lastAutoStart = last;
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /**
   * Record one strike and return the automatic restriction it triggers, if any. SYNCHRONOUS and never throws.
   *
   * With a subject, the strike row is written inside `store.transaction`, then the in-memory tally of the
   * CANONICAL subject (so merged aliases count together) is updated. Three strikes newer than the subject's
   * latest automatic chat restriction within an hour give 30 minutes, or 24 hours when that latest restriction
   * started within 7 days. The decision itself consumes the strikes: `lastAutoStart` becomes now.
   *
   * With no subject, or when the write fails (logged, no line text or identifier), the strike goes to a
   * separate tally keyed by `rateKey` instead, and a firing there is always the first-offence duration. The two
   * tallies are independent, so a player whose strikes split across them can slip under three in either; that
   * is the accepted cost of never throwing from the chat path.
   *
   * `rawLine` is the line the subject typed themselves; it is stored (private, purged after 30 days) for K2's
   * notice. A strike is never keyed or counted by IP.
   */
  record(subject: SubjectId | null, rateKey: string, roomId: string, termId: string, rawLine: string): StrikeDecision {
    try {
      const now = this.clock.now();
      if (present(subject)) {
        try {
          return this.recordForSubject(subject, roomId, termId, rawLine, now);
        } catch (err) {
          this.warn('strikes.write_failed', { error: err instanceof Error ? err.name : typeof err });
        }
      }
      const decision = this.recordByRateKey(rateKey, now);
      if (decision.autoRestrict !== null && present(subject)) this.consume(subject, now);
      return decision;
    } catch (err) {
      // Nothing above should throw (the clock, the subject index). The chat path must still get an answer.
      this.warn('strikes.record_failed', { error: err instanceof Error ? err.name : typeof err });
      return { autoRestrict: null };
    }
  }

  // --- internals -----------------------------------------------------------

  private recordForSubject(subject: SubjectId, roomId: string, termId: string, rawLine: string, now: number): StrikeDecision {
    const person = this.subjects.canonical(subject);
    this.store.transaction(() => {
      this.store.insertStrike({ id: newId(), at: now, subject: person, roomId, termId, rawLine });
    });

    this.prune(now);
    const times = this.foldTally(person);
    times.push(now);
    const last = this.foldLastAutoStart(person);
    const count = times.reduce((n, t) => (t >= now - STRIKE_WINDOW_MS && (last === undefined || t > last) ? n + 1 : n), 0);
    if (count < STRIKES_TO_RESTRICT) return { autoRestrict: null };

    const escalate = last !== undefined && last >= now - REPEAT_LOOKBACK_MS;
    this.tally.delete(person);
    this.lastAutoStart.set(person, now);
    return { autoRestrict: { durationMs: escalate ? REPEAT_RESTRICT_MS : STRIKE_FIRST_RESTRICT_MS } };
  }

  /** The person's strike times under their canonical id, moving in the times filed under merged-away ids. */
  private foldTally(person: SubjectId): number[] {
    let own = this.tally.get(person);
    if (own === undefined) {
      own = [];
      this.tally.set(person, own);
    }
    for (const [key, times] of this.tally) {
      if (key === person || this.subjects.canonical(key) !== person) continue;
      own.push(...times);
      this.tally.delete(key);
    }
    return own;
  }

  /** The person's latest automatic chat restriction start, over every id that is now them; undefined if none. */
  private foldLastAutoStart(person: SubjectId): number | undefined {
    let best = this.lastAutoStart.get(person);
    for (const [key, at] of this.lastAutoStart) {
      if (key === person || this.subjects.canonical(key) !== person) continue;
      if (best === undefined || at > best) best = at;
      this.lastAutoStart.delete(key);
    }
    if (best !== undefined) this.lastAutoStart.set(person, best);
    return best;
  }

  /** Drop every strike older than the window and every restriction start older than the look-back. */
  private prune(now: number): void {
    for (const [key, times] of this.tally) {
      const fresh = times.filter((t) => t >= now - STRIKE_WINDOW_MS);
      if (fresh.length === 0) this.tally.delete(key);
      else if (fresh.length !== times.length) this.tally.set(key, fresh);
    }
    for (const [key, at] of this.lastAutoStart) {
      if (at < now - REPEAT_LOOKBACK_MS) this.lastAutoStart.delete(key);
    }
  }

  /** The fallback: Moxgate's in-memory tally. First-offence duration only; no history to escalate from. */
  private recordByRateKey(rateKey: string, now: number): StrikeDecision {
    // Prune every key, not just this one, so entries for players who went quiet cannot pile up.
    for (const [key, times] of this.byRateKey) {
      const fresh = times.filter((t) => t >= now - STRIKE_WINDOW_MS);
      if (fresh.length === 0) this.byRateKey.delete(key);
      else if (fresh.length !== times.length) this.byRateKey.set(key, fresh);
    }
    const times = this.byRateKey.get(rateKey) ?? [];
    times.push(now);
    if (times.length < STRIKES_TO_RESTRICT) {
      this.byRateKey.set(rateKey, times);
      return { autoRestrict: null };
    }
    this.byRateKey.delete(rateKey);
    return { autoRestrict: { durationMs: STRIKE_FIRST_RESTRICT_MS } };
  }

  /** A fallback firing against a known subject still starts a restriction, so it consumes that subject's strikes. */
  private consume(subject: SubjectId, now: number): void {
    const person = this.subjects.canonical(subject);
    this.foldLastAutoStart(person);
    this.lastAutoStart.set(person, now);
    this.tally.delete(person);
  }

  private warn(event: string, detail: Record<string, string | number | boolean>): void {
    safeWarn(this.logger, event, detail);
  }
}
