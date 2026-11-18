import { PACE_KEYS_MAX } from './pace.js';
import type { ResolvedPace } from './pace.js';
import { allOff, commitState, decide, longestWindow, repeatDigest } from './paceDecide.js';
import type { KeyState, PaceVerdict } from './paceDecide.js';
import type { Clock } from './types.js';

export { normalizeForRepeat } from './paceDecide.js';
export type { KeyState, PaceVerdict } from './paceDecide.js';

// The pacer: the in-memory limiter behind slow mode, the burst limit and repeat refusal. Clocked: it reads the settings
// through a function on every call, holds no line text (a repeat is remembered as a short digest of the normalized line), and its
// `check` is timing-pure: a refusal changes nothing the next check reads. The one write `check` makes is the `floodSignalAt`
// bookkeeping, set when it returns `signalFlood: true`, so a flood is reported at most once per burst window. The decisions themselves
// are the pure functions of `paceDecide.ts`, which the shared pacer (state in the store) calls too.
//
// State is per process, a map of maps by room (so a room goes in one delete), swept every SWEEP_EVERY checks against the longest
// window the room has configured, and capped at PACE_KEYS_MAX keys (the oldest go).

/** Sweep quiet keys after this many `check` calls (the same cadence as `slidingWindow`). */
const SWEEP_EVERY = 256;
/** When the cap is hit, this many of the oldest keys go at once, so the scan is paid for once per batch and not once per new key. */
const EVICT_BATCH = Math.ceil(PACE_KEYS_MAX / 8);
/** Who a line is paced as: the room, and the canonical subject (or `seat:<seatId>` for a guest). */
export interface PaceKey {
  roomId: string;
  who: string;
}

export interface Pacer {
  /**
   * Should this line be refused? Reads state, changes no timing state. Order: `slow_mode` (or `probation`), `flood`, `duplicate`. `floorMs` is a probation floor for THIS player: the least time
   * between their lines, applied on top of the room's own slow mode (the stricter wins; the refusal is `probation` only when the floor is what is longer). Absent: none.
   */
  check(key: PaceKey, line: string, floorMs?: number): PaceVerdict;
  /** Record that a line was accepted: it now counts toward the next check. A no-op while every check is off and there is no `floorMs` (pass the same one `check` got). */
  commit(key: PaceKey, line: string, floorMs?: number): void;
  /** Is any check on for this room right now? When not, `check` and `commit` do nothing and the caller need not build a key. */
  active(roomId: string): boolean;
  /** The line `check` accepted will not be committed (the fixed rate refused it): drop the digest memo that holds its text. */
  discard(): void;
  /** Is a line's text held in the digest memo (between a `check` that passed and its `commit` or `discard`)? A diagnostic. */
  holdsText(): boolean;
  /** Forget every key of a room in one step. */
  dropRoom(roomId: string): void;
  /** Forget the state of these people (the `who` of a key) in every room: used when a person is erased. */
  forgetPeople(people: ReadonlySet<string>): void;
  /** Keys held. A diagnostic: it stays at or under {@link PACE_KEYS_MAX}. */
  size(): number;
}

const touchedAt = (s: KeyState): number => (s.floodSignalAt !== null && s.floodSignalAt > s.lastAt ? s.floodSignalAt : s.lastAt);

/**
 * `tap` is a test seam: it is handed the state (rooms by key) once, so a test can look at what a pacer holds. Nothing in the kit passes it.
 * @internal
 */
export function createPacer(opts: { clock: Clock; settings: (roomId: string) => ResolvedPace; /** The longest probation floor in force (0 when probation is off): a room's state is kept at least that long. */ floorMax?: () => number; tap?: (rooms: ReadonlyMap<string, ReadonlyMap<string, Readonly<KeyState>>>) => void }): Pacer {
  const { clock, settings } = opts;
  const floorMax = (): number => {
    try {
      const v = opts.floorMax?.() ?? 0;
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      return 0;
    }
  };
  const rooms = new Map<string, Map<string, KeyState>>();
  opts.tap?.(rooms);
  let keys = 0;
  let calls = 0;

  const sweep = (now: number): void => {
    for (const [roomId, room] of rooms) {
      let longest: number;
      try {
        longest = longestWindow(settings(roomId));
      } catch {
        continue;
      }
      longest = Math.max(longest, floorMax());
      if (longest === 0) {
        keys -= room.size;
        rooms.delete(roomId);
        continue;
      }
      for (const [who, state] of room) {
        if (now - touchedAt(state) >= longest) {
          room.delete(who);
          keys -= 1;
        }
      }
      if (room.size === 0) rooms.delete(roomId);
    }
  };

  /** Over the cap: drop the oldest keys, a batch at a time. */
  const evict = (): void => {
    const all: Array<{ roomId: string; who: string; at: number }> = [];
    for (const [roomId, room] of rooms) for (const [who, state] of room) all.push({ roomId, who, at: touchedAt(state) });
    all.sort((a, b) => a.at - b.at);
    const drop = Math.min(all.length, keys - PACE_KEYS_MAX + EVICT_BATCH);
    for (let i = 0; i < drop; i += 1) {
      const { roomId, who } = all[i]!;
      const room = rooms.get(roomId);
      if (room?.delete(who) === true) keys -= 1;
      if (room !== undefined && room.size === 0) rooms.delete(roomId);
    }
  };

  /**
   * The digest `check` made of the line it just accepted, so `commit` of the same line does not hash it again. It holds that one line
   * only from the check to the commit that follows it in the same call (and is replaced or cleared by the next call): the keyed state
   * below never holds text.
   */
  let memo: { line: string; h: string | null } | null = null;
  /** A line as the digest a repeat is compared by (null for one too short); the memo's, when it is the memoed line. */
  const repeatHash = (line: string): string | null => (memo !== null && memo.line === line ? memo.h : repeatDigest(line));

  const pacer: Pacer = {
    active: (roomId) => !allOff(settings(roomId)),

    check(key, line, floorMs) {
      const now = clock.now();
      memo = null;
      if (++calls % SWEEP_EVERY === 0) sweep(now);
      const pace = settings(key.roomId);
      const state = rooms.get(key.roomId)?.get(key.who) ?? null;
      let asked: { h: string | null } | null = null;
      const decision = decide(state, pace, now, () => {
        asked = { h: repeatDigest(line) };
        return asked.h;
      }, floorMs);
      // The one write a check makes: the flood signal's time, so the next refusal inside the window does not signal again.
      if (decision.signalAt !== null && state !== null) state.floodSignalAt = decision.signalAt;
      // A line that passed after its digest was made keeps the digest until its commit (or discard), so it is hashed once.
      if (decision.verdict.ok && asked !== null) memo = { line, h: (asked as { h: string | null }).h };
      return decision.verdict;
    },

    commit(key, line, floorMs) {
      const now = clock.now();
      const pace = settings(key.roomId);
      if (allOff(pace) && !(floorMs !== undefined && Number.isFinite(floorMs) && floorMs > 0)) return;
      let room = rooms.get(key.roomId);
      let state = room?.get(key.who);
      const next = commitState(state ?? null, pace, now, pace.duplicateWindowMs === null ? null : repeatHash(line));
      if (state === undefined) {
        if (keys >= PACE_KEYS_MAX) evict();
        if (room === undefined || !rooms.has(key.roomId)) {
          room = new Map();
          rooms.set(key.roomId, room);
        }
        state = next;
        room.set(key.who, state);
        keys += 1;
      } else Object.assign(state, next);
      memo = null;
    },

    discard() {
      memo = null;
    },

    holdsText: () => memo !== null,

    dropRoom(roomId) {
      const room = rooms.get(roomId);
      if (room === undefined) return;
      keys -= room.size;
      rooms.delete(roomId);
    },

    forgetPeople(people) {
      if (people.size === 0) return;
      for (const [roomId, room] of rooms) {
        for (const who of people) {
          if (room.delete(who)) keys -= 1;
        }
        if (room.size === 0) rooms.delete(roomId);
      }
    },

    size: () => keys,
  };

  return pacer;
}
