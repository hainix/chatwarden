import { errorClass, ThrottledWarn } from './log.js';
import { allOff, commitState, decide, repeatDigest, shouldSignalFlood } from './paceDecide.js';
import type { KeyState, PaceVerdict } from './paceDecide.js';
import type { ResolvedPace } from './pace.js';
import type { PaceKey, Pacer } from './pacing.js';
import type { Clock, Logger, PaceStateRow, Store } from './types.js';

// The shared pacer: the same decisions as the in-memory pacer (`pacing.ts`), with each player's state in the store instead of the process, so two processes on one store judge one player's
// lines together. A check is one indexed read; a commit is one atomic update (`store.paceUpdate`), so two processes committing for one player serialise and both lines are counted. A line's
// text is never stored: a repeat is its 16-character digest. A store failure fails open (the line goes on) and is logged by class, at most once a minute.
//
// Honest limit: a check and its commit are two steps, so two processes judging one player's lines in the same millisecond can both pass `check`; the commit then merges both, and the next
// line is judged on both. The same strength as the in-memory pacer between its own `check` and `commit`.

/** Rows untouched for this long are swept: the longest window any check can have. */
const SWEEP_AGE_MS = 3_600_000;
/** Sweep after this many commits (the in-memory pacer's cadence too). */
const SWEEP_EVERY = 256;

const REQUIRED = ['paceLoad', 'paceUpdate', 'paceDropRoom', 'paceSweep'] as const;

/** Throws a plain message naming the first pace method the store lacks. Used by `createSharedPacer` and by `createChatwarden` for its `sharedPacing` option. */
export function assertPaceStore(store: Store): void {
  for (const m of REQUIRED) {
    if (typeof (store as unknown as Record<string, unknown>)[m] !== 'function') {
      throw new Error(`sharedPacing needs a store with paceLoad, paceUpdate, paceDropRoom and paceSweep: this store has no ${m}`);
    }
  }
}

/** `KeyState` as the stored row's body. */
const rowOf = (key: PaceKey, s: KeyState, touchedAt: number): PaceStateRow => ({ roomId: key.roomId, who: key.who, ...s, touchedAt });

/** What a stored row holds of the state (the row's own key and touch time are not part of it). */
const stateOf = (r: PaceStateRow): KeyState => ({ lastAt: r.lastAt, stamps: r.stamps, recent: r.recent, floodSignalAt: r.floodSignalAt });

export function createSharedPacer(opts: { clock: Clock; settings: (roomId: string) => ResolvedPace; store: Store; logger?: Logger; floorMax?: () => number }): Pacer {
  if (typeof opts !== 'object' || opts === null) throw new TypeError('createSharedPacer: options must be an object');
  if (typeof opts.settings !== 'function') throw new TypeError('createSharedPacer: settings must be a function');
  if (typeof opts.clock !== 'object' || opts.clock === null || typeof opts.clock.now !== 'function') throw new TypeError('createSharedPacer: clock must have a now function');
  assertPaceStore(opts.store);
  const { clock, settings, store } = opts;
  // The store's pace methods, checked above to be there.
  const load = (roomId: string, who: string): PaceStateRow | null => store.paceLoad!(roomId, who);
  const update = (roomId: string, who: string, fn: (prev: PaceStateRow | null) => PaceStateRow): PaceStateRow => store.paceUpdate!(roomId, who, fn);
  const dropRoom = (roomId: string): number => store.paceDropRoom!(roomId);
  const sweepRows = (before: number): number => store.paceSweep!(before);
  const warn = new ThrottledWarn(opts.logger, clock);
  let commits = 0;

  /** Run a store step; a failure is logged by class (at most once a minute) and answered with `fallback`. */
  const guarded = <T>(step: () => T, fallback: T): T => {
    try {
      return step();
    } catch (err) {
      warn.warn('chatwarden.pace_failed', { error: errorClass(err) });
      return fallback;
    }
  };

  // The digest `check` made of the line it just accepted, so `commit` of the same line does not hash it again; held only from the check to the commit (or discard) that follows it.
  let memo: { line: string; h: string | null } | null = null;
  const repeatHash = (line: string): string | null => (memo !== null && memo.line === line ? memo.h : repeatDigest(line));

  const pacer: Pacer = {
    active: (roomId) => !allOff(settings(roomId)),

    check(key, line, floorMs) {
      const now = clock.now();
      memo = null;
      const pace = settings(key.roomId);
      const floor = floorMs !== undefined && Number.isFinite(floorMs) && floorMs > 0 ? floorMs : 0;
      // Nothing is on for this room and the player has no probation floor: the store is not asked.
      if (allOff(pace) && floor === 0) return { ok: true };
      const stored = guarded(() => load(key.roomId, key.who), null);
      let asked: { h: string | null } | null = null;
      const decision = decide(stored === null ? null : stateOf(stored), pace, now, () => {
        asked = { h: repeatDigest(line) };
        return asked.h;
      }, floorMs);
      let verdict: PaceVerdict = decision.verdict;
      if (!verdict.ok && verdict.reason === 'flood' && verdict.signalFlood && pace.burst !== null && stored !== null) {
        // Signal once per burst window across processes: the update re-reads the row and signals only if nobody has since.
        const windowMs = pace.burst.windowMs;
        let signalled = false;
        guarded(
          () =>
            update(key.roomId, key.who, (prev) => {
              const cur = prev ?? stored;
              signalled = shouldSignalFlood(cur.floodSignalAt, now, windowMs);
              return signalled ? { ...cur, roomId: key.roomId, who: key.who, floodSignalAt: now, touchedAt: now } : cur;
            }),
          null,
        );
        verdict = { ...verdict, signalFlood: signalled };
      }
      if (verdict.ok && asked !== null) memo = { line, h: (asked as { h: string | null }).h };
      return verdict;
    },

    commit(key, line, floorMs) {
      const now = clock.now();
      const pace = settings(key.roomId);
      if (allOff(pace) && !(floorMs !== undefined && Number.isFinite(floorMs) && floorMs > 0)) return;
      const h = pace.duplicateWindowMs === null ? null : repeatHash(line);
      memo = null;
      guarded(
        () =>
          update(key.roomId, key.who, (prev) => {
            const next = commitState(prev === null ? null : stateOf(prev), pace, now, h);
            return rowOf(key, next, now);
          }),
        null,
      );
      if (++commits % SWEEP_EVERY === 0) guarded(() => sweepRows(now - SWEEP_AGE_MS), 0);
    },

    discard() {
      memo = null;
    },

    holdsText: () => memo !== null,

    dropRoom(roomId) {
      guarded(() => dropRoom(roomId), 0);
    },

    // The store erases a person's rows itself (`eraseSubjects`): the pacer holds nothing to forget.
    forgetPeople() {},

    // Nothing is held in memory.
    size: () => 0,
  };
  return pacer;
}
