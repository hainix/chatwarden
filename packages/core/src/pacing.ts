import { sha256Hex } from './crypto.js';
import { DUPLICATE_MIN_CHARS, DUPLICATE_RECENT, PACE_KEYS_MAX } from './pace.js';
import type { PaceReason, ResolvedPace } from './pace.js';
import type { Clock } from './types.js';

// The pacer: the in-memory limiter behind slow mode, the burst limit and repeat refusal. Pure and clocked: it reads the settings
// through a function on every call, holds no line text (a repeat is remembered as a short digest of the normalized line), and its
// `check` is timing-pure: a refusal changes nothing the next check reads. The one write `check` makes is the `floodSignalAt`
// bookkeeping, set when it returns `signalFlood: true`, so a flood is reported at most once per burst window.
//
// State is per process, a map of maps by room (so a room goes in one delete), swept every SWEEP_EVERY checks against the longest
// window the room has configured, and capped at PACE_KEYS_MAX keys (the oldest go).

/** Sweep quiet keys after this many `check` calls (the same cadence as `slidingWindow`). */
const SWEEP_EVERY = 256;
/** When the cap is hit, this many of the oldest keys go at once, so the scan is paid for once per batch and not once per new key. */
const EVICT_BATCH = Math.ceil(PACE_KEYS_MAX / 8);
/** Hex characters of the digest kept for a repeat: enough that two different lines do not meet, far too few to recover a line. */
const DIGEST_CHARS = 16;

/** Who a line is paced as: the room, and the canonical subject (or `seat:<seatId>` for a guest). */
export interface PaceKey {
  roomId: string;
  who: string;
}

/** The answer to one line. `retryAfterMs` is a whole number from 1 up to the window of the check that refused. */
export type PaceVerdict = { ok: true } | { ok: false; reason: PaceReason; retryAfterMs: number; signalFlood: boolean };

export interface Pacer {
  /** Should this line be refused? Reads state, changes no timing state. Order: `slow_mode`, `flood`, `duplicate`. */
  check(key: PaceKey, line: string): PaceVerdict;
  /** Record that a line was accepted: it now counts toward the next check. A no-op while every check is off. */
  commit(key: PaceKey, line: string): void;
  /** Is any check on for this room right now? When not, `check` and `commit` do nothing and the caller need not build a key. */
  active(roomId: string): boolean;
  /** The line `check` accepted will not be committed (the fixed rate refused it): drop the digest memo that holds its text. */
  discard(): void;
  /** Is a line's text held in the digest memo (between a `check` that passed and its `commit` or `discard`)? A diagnostic. */
  holdsText(): boolean;
  /** Forget every key of a room in one step. */
  dropRoom(roomId: string): void;
  /** Keys held. A diagnostic: it stays at or under {@link PACE_KEYS_MAX}. */
  size(): number;
}

/** What the pacer keeps for one player in one room. @internal */
export interface KeyState {
  /** When the last committed line was accepted. */
  lastAt: number;
  /** The times of the last committed lines, oldest first (at most the burst's `lines`). */
  stamps: number[];
  /** Digests of the last {@link DUPLICATE_RECENT} committed lines of enough length, oldest first. */
  recent: Array<{ h: string; at: number }>;
  /** When `check` last reported a flood for this key, or null. */
  floodSignalAt: number | null;
}

/**
 * NFKC, lower-case, then only letters, digits and the combining marks that belong to them: what "the same line again" means. Marks stay
 * because in many scripts (Devanagari, Thai) the vowel signs are marks, and without them different words look alike. Variation
 * selectors (U+FE00 to U+FE0F, which pick text or emoji presentation) are marks too but carry no meaning of their own, so they go
 * first: `1\uFE0F\u20E3` and `1\u20E3` are one line, and an emoji line leaves nothing to count. Never stored.
 */
export function normalizeForRepeat(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\uFE00-\uFE0F]/g, '').replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}

/** Letters and digits in a normalized line: marks do not count toward the minimum length, so a line of marks alone is never a repeat. */
const baseChars = (normalized: string): number => Array.from(normalized.replace(/\p{M}/gu, '')).length;

const OK: PaceVerdict = Object.freeze({ ok: true }) as PaceVerdict;

const allOff = (p: ResolvedPace): boolean => p.slowModeMs === null && p.burst === null && p.duplicateWindowMs === null;

/** A refusal with a whole-number wait of at least 1 and at most the refusing check's own window (a clock that stepped back cannot exceed it). */
function refusal(reason: PaceReason, waitMs: number, windowMs: number, signalFlood: boolean): PaceVerdict {
  const wait = Number.isFinite(waitMs) ? Math.min(windowMs, Math.max(1, Math.ceil(waitMs))) : windowMs;
  return { ok: false, reason, retryAfterMs: wait, signalFlood };
}

/** The longest window a room has configured, or 0 when every check is off. */
function longestWindow(p: ResolvedPace): number {
  return Math.max(p.slowModeMs ?? 0, p.burst?.windowMs ?? 0, p.duplicateWindowMs ?? 0);
}

const touchedAt = (s: KeyState): number => (s.floodSignalAt !== null && s.floodSignalAt > s.lastAt ? s.floodSignalAt : s.lastAt);

/**
 * `tap` is a test seam: it is handed the state (rooms by key) once, so a test can look at what a pacer holds. Nothing in the kit passes it.
 * @internal
 */
export function createPacer(opts: { clock: Clock; settings: (roomId: string) => ResolvedPace; tap?: (rooms: ReadonlyMap<string, ReadonlyMap<string, Readonly<KeyState>>>) => void }): Pacer {
  const { clock, settings } = opts;
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

  const digest = (normalized: string): string => sha256Hex(normalized).slice(0, DIGEST_CHARS);
  /**
   * The digest `check` made of the line it just accepted, so `commit` of the same line does not hash it again. It holds that one line
   * only from the check to the commit that follows it in the same call (and is replaced or cleared by the next call): the keyed state
   * below never holds text.
   */
  let memo: { line: string; h: string | null } | null = null;
  /** A normalized line long enough to be called a repeat, as its digest; null for one that is not. */
  const repeatHash = (line: string): string | null => {
    if (memo !== null && memo.line === line) return memo.h;
    const normalized = normalizeForRepeat(line);
    return baseChars(normalized) < DUPLICATE_MIN_CHARS ? null : digest(normalized);
  };

  const pacer: Pacer = {
    active: (roomId) => !allOff(settings(roomId)),

    check(key, line) {
      const now = clock.now();
      memo = null;
      if (++calls % SWEEP_EVERY === 0) sweep(now);
      const pace = settings(key.roomId);
      if (allOff(pace)) return OK;
      const state = rooms.get(key.roomId)?.get(key.who);
      if (state === undefined) return OK;

      const { slowModeMs, burst, duplicateWindowMs } = pace;
      // State stamped after `now` (the clock stepped back) is stale, not "in the future": it never refuses, so a step back cannot lock
      // a player out. The refusal clamp below is then a guard only.
      if (slowModeMs !== null && state.lastAt <= now && now - state.lastAt < slowModeMs) {
        return refusal('slow_mode', state.lastAt + slowModeMs - now, slowModeMs, false);
      }

      if (burst !== null) {
        const live = state.stamps.filter((t) => t <= now && now - t < burst.windowMs).sort((a, b) => a - b);
        if (live.length >= burst.lines) {
          // Enough must age out to leave room for one more: with exactly `lines` live that is the oldest, with more (a burst
          // narrowed after the lines were sent) it is the one that leaves `lines - 1`.
          const oldest = live[live.length - burst.lines]!;
          const signal = state.floodSignalAt === null || now < state.floodSignalAt || now - state.floodSignalAt >= burst.windowMs;
          if (signal) state.floodSignalAt = now;
          return refusal('flood', oldest + burst.windowMs - now, burst.windowMs, signal);
        }
      }

      if (duplicateWindowMs !== null && state.recent.length > 0) {
        const h = repeatHash(line);
        if (h !== null) {
          const seen = state.recent.find((e) => e.h === h && e.at <= now && now - e.at < duplicateWindowMs);
          if (seen !== undefined) return refusal('duplicate', seen.at + duplicateWindowMs - now, duplicateWindowMs, false);
          memo = { line, h };
        } else memo = { line, h: null };
      }
      return OK;
    },

    commit(key, line) {
      const now = clock.now();
      const pace = settings(key.roomId);
      if (allOff(pace)) return;
      let room = rooms.get(key.roomId);
      let state = room?.get(key.who);
      if (state === undefined) {
        if (keys >= PACE_KEYS_MAX) evict();
        if (room === undefined || !rooms.has(key.roomId)) {
          room = new Map();
          rooms.set(key.roomId, room);
        }
        state = { lastAt: now, stamps: [], recent: [], floodSignalAt: null };
        room.set(key.who, state);
        keys += 1;
      }
      state.lastAt = now;

      const { burst, duplicateWindowMs } = pace;
      if (burst === null) state.stamps = [];
      else state.stamps = [...state.stamps.filter((t) => t <= now && now - t < burst.windowMs), now].slice(-burst.lines);

      if (duplicateWindowMs === null) state.recent = [];
      else {
        const h = repeatHash(line);
        const kept = state.recent.filter((e) => e.h !== h && e.at <= now && now - e.at < duplicateWindowMs);
        if (h !== null) kept.push({ h, at: now });
        state.recent = kept.slice(-DUPLICATE_RECENT);
      }
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

    size: () => keys,
  };

  return pacer;
}
