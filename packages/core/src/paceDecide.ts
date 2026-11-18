import { sha256Hex } from './crypto.js';
import { DUPLICATE_MIN_CHARS, DUPLICATE_RECENT } from './pace.js';
import type { PaceReason, ResolvedPace } from './pace.js';

// The pure half of pacing: what a line gets given a player's state, and what the state becomes when a line is committed. No clock, no map, no store: the in-memory pacer
// (`pacing.ts`) and the shared pacer (`pacingShared.ts`, state in the store) both call these two functions, so the two cannot drift. Holds no line text: a repeat is a short
// digest of the normalized line.

/** Hex characters of the digest kept for a repeat: enough that two different lines do not meet, far too few to recover a line. */
export const DIGEST_CHARS = 16;

/** The answer to one line. `retryAfterMs` is a whole number from 1 up to the window of the check that refused. */
export type PaceVerdict = { ok: true } | { ok: false; reason: PaceReason; retryAfterMs: number; signalFlood: boolean };

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
 * first: `1️⃣` and `1⃣` are one line, and an emoji line leaves nothing to count. Never stored.
 */
export function normalizeForRepeat(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[︀-️]/g, '').replace(/[^\p{L}\p{N}\p{M}]/gu, '');
}

/** Letters and digits in a normalized line: marks do not count toward the minimum length, so a line of marks alone is never a repeat. */
const baseChars = (normalized: string): number => Array.from(normalized.replace(/\p{M}/gu, '')).length;

/** The digest of a normalized line: {@link DIGEST_CHARS} hex characters. */
export const digestOf = (normalized: string): string => sha256Hex(normalized).slice(0, DIGEST_CHARS);

/** A line as the digest a repeat is compared by, or null when it is too short to be called a repeat (`DUPLICATE_MIN_CHARS` letters and digits). */
export function repeatDigest(line: string): string | null {
  const normalized = normalizeForRepeat(line);
  return baseChars(normalized) < DUPLICATE_MIN_CHARS ? null : digestOf(normalized);
}

/** What `decide` says: the verdict and, for a flood that is to be signalled, the time to record as `floodSignalAt` (else null). */
export interface PaceDecision {
  verdict: PaceVerdict;
  signalAt: number | null;
}

const OK: PaceDecision = Object.freeze({ verdict: Object.freeze({ ok: true }) as PaceVerdict, signalAt: null });

/** Is every check off? */
export const allOff = (p: ResolvedPace): boolean => p.slowModeMs === null && p.burst === null && p.duplicateWindowMs === null;

/** The longest window a room has configured, or 0 when every check is off. */
export const longestWindow = (p: ResolvedPace): number => Math.max(p.slowModeMs ?? 0, p.burst?.windowMs ?? 0, p.duplicateWindowMs ?? 0);

/** A refusal with a whole-number wait of at least 1 and at most the refusing check's own window (a clock that stepped back cannot exceed it). */
function refusal(reason: PaceReason, waitMs: number, windowMs: number, signalFlood: boolean, signalAt: number | null = null): PaceDecision {
  const wait = Number.isFinite(waitMs) ? Math.min(windowMs, Math.max(1, Math.ceil(waitMs))) : windowMs;
  return { verdict: { ok: false, reason, retryAfterMs: wait, signalFlood }, signalAt };
}

/** Is a flood to be signalled now? Once per burst window per player: when none was signalled, or the last is a window old, or is stamped after now (the clock stepped back). */
export function shouldSignalFlood(floodSignalAt: number | null, now: number, windowMs: number): boolean {
  return floodSignalAt === null || now < floodSignalAt || now - floodSignalAt >= windowMs;
}

const validFloor = (floorMs: number | undefined): number => (floorMs !== undefined && Number.isFinite(floorMs) && floorMs > 0 ? floorMs : 0);

/**
 * Should this line be refused? Pure: it reads `state` (null for a player with none) and changes nothing. Order: `slow_mode` (or `probation`), `flood`, `duplicate`. `digest` is asked for
 * only when the repeat check needs it (the check is on and something is recent), at most once. `floorMs` is a probation floor for this player: the least time between their lines, applied
 * on top of the room's own slow mode (the stricter wins; the refusal is `probation` only when the floor is what is longer).
 *
 * State stamped after `now` (the clock stepped back) is stale, not "in the future": it never refuses, so a step back cannot lock a player out.
 */
export function decide(state: Readonly<KeyState> | null, pace: ResolvedPace, now: number, digest: () => string | null, floorMs?: number): PaceDecision {
  const floor = validFloor(floorMs);
  if (allOff(pace) && floor === 0) return OK;
  if (state === null) return OK;

  const { burst, duplicateWindowMs } = pace;
  // The room's slow mode and the player's probation floor: the longer wins, and it is called probation only when the floor is what is longer.
  const slowModeMs = Math.max(pace.slowModeMs ?? 0, floor);
  if (slowModeMs > 0 && state.lastAt <= now && now - state.lastAt < slowModeMs) {
    return refusal(floor > (pace.slowModeMs ?? 0) ? 'probation' : 'slow_mode', state.lastAt + slowModeMs - now, slowModeMs, false);
  }

  if (burst !== null) {
    const live = state.stamps.filter((t) => t <= now && now - t < burst.windowMs).sort((a, b) => a - b);
    if (live.length >= burst.lines) {
      // Enough must age out to leave room for one more: with exactly `lines` live that is the oldest, with more (a burst
      // narrowed after the lines were sent) it is the one that leaves `lines - 1`.
      const oldest = live[live.length - burst.lines]!;
      const signal = shouldSignalFlood(state.floodSignalAt, now, burst.windowMs);
      return refusal('flood', oldest + burst.windowMs - now, burst.windowMs, signal, signal ? now : null);
    }
  }

  if (duplicateWindowMs !== null && state.recent.length > 0) {
    const h = digest();
    if (h !== null) {
      const seen = state.recent.find((e) => e.h === h && e.at <= now && now - e.at < duplicateWindowMs);
      if (seen !== undefined) return refusal('duplicate', seen.at + duplicateWindowMs - now, duplicateWindowMs, false);
    }
  }
  return OK;
}

/**
 * The state after a line was accepted and committed: `now` as the last line, the burst's last `lines` stamps inside the window, the digest (`h`, null for a line too short to count) among the
 * last 8 inside the repeat window (the same line again replaces its entry), and the flood signal time carried over. Pure: `prev` is not changed. A check that is off keeps nothing.
 */
export function commitState(prev: Readonly<KeyState> | null, pace: ResolvedPace, now: number, h: string | null): KeyState {
  const { burst, duplicateWindowMs } = pace;
  const stamps = burst === null ? [] : [...(prev?.stamps ?? []).filter((t) => t <= now && now - t < burst.windowMs), now].slice(-burst.lines);
  let recent: Array<{ h: string; at: number }> = [];
  if (duplicateWindowMs !== null) {
    const kept = (prev?.recent ?? []).filter((e) => e.h !== h && e.at <= now && now - e.at < duplicateWindowMs).map((e) => ({ h: e.h, at: e.at }));
    if (h !== null) kept.push({ h, at: now });
    recent = kept.slice(-DUPLICATE_RECENT);
  }
  return { lastAt: now, stamps, recent, floodSignalAt: prev?.floodSignalAt ?? null };
}
