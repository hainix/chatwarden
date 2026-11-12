import { deepFreeze } from './freeze.js';
import { ProfileError } from './profileError.js';

// The pace settings: how a room paces a player's lines (a gap, a burst limit, no repeats). Pure data and validation, no state and no
// clock; the limiter that applies them is pacing.ts. Every setting is off until set, so a kit that sets none behaves as before.

/** The reasons a line can be refused for pacing, in the order they are checked. */
export const PACE_REASONS = ['slow_mode', 'flood', 'duplicate'] as const;
export type PaceReason = (typeof PACE_REASONS)[number];

/**
 * How a room paces a player's lines. Every field optional on input; `null` or absent is off.
 * @experimental
 */
export interface PaceSettings {
  /** The least time between one player's lines in a room, ms. 500 to 600 000. */
  slowModeMs?: number | null;
  /** At most `lines` lines in any `windowMs`. `lines` 2 to 100, `windowMs` 1 000 to 600 000. */
  burst?: { lines: number; windowMs: number } | null;
  /** The same normalized line again inside this many ms is refused. 1 000 to 3 600 000. */
  duplicateWindowMs?: number | null;
}

/**
 * What the kit reads: every field filled, `null` meaning off.
 * @experimental
 */
export interface ResolvedPace {
  slowModeMs: number | null;
  burst: { lines: number; windowMs: number } | null;
  duplicateWindowMs: number | null;
}

/** A normalized line shorter than this (in characters) is never a duplicate, so "gg" and "ok" stay free. */
export const DUPLICATE_MIN_CHARS = 3;
/** How many of a player's most recent line hashes a repeat is compared with. */
export const DUPLICATE_RECENT = 8;
/**
 * The most (room, player) states the limiter holds; the oldest go. A state is small (a time, a digest or two) but a burst of 100 lines
 * keeps up to 100 times and 8 digests per player, roughly 1.5 KB: at the cap with the largest settings that is about 70 MB, so a game
 * that sets `burst.lines` high and has very many players in one process should budget for it.
 */
export const PACE_KEYS_MAX = 50_000;

/** The allowed whole-number range of each number setting. */
const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  slowModeMs: [500, 600_000],
  lines: [2, 100],
  windowMs: [1000, 600_000],
  duplicateWindowMs: [1000, 3_600_000],
};
const BURST_KEYS = ['lines', 'windowMs'] as const;
const PACE_KEYS = ['slowModeMs', 'burst', 'duplicateWindowMs'] as const;

/**
 * Values the hub offers behind "Use suggested values". Never applied by themselves.
 * @experimental
 */
export const PACE_SUGGESTIONS: Readonly<Record<'relaxed' | 'standard' | 'strict', ResolvedPace>> = deepFreeze({
  relaxed: { slowModeMs: null, burst: { lines: 10, windowMs: 10_000 }, duplicateWindowMs: 10_000 },
  standard: { slowModeMs: null, burst: { lines: 6, windowMs: 10_000 }, duplicateWindowMs: 15_000 },
  strict: { slowModeMs: 2000, burst: { lines: 5, windowMs: 10_000 }, duplicateWindowMs: 30_000 },
});

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** An own, defined value: a key left out, `undefined` and an inherited property all read as "not given". */
function given(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** `o` must be a plain object with no key outside `allowed`; a refusal names the key. */
function plain(o: unknown, allowed: readonly string[], path: string, what: string): Record<string, unknown> {
  if (!isPlain(o)) throw new ProfileError(path, what);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ProfileError(`${path}.${k}`, 'is not a known setting');
  return o;
}

function whole(v: unknown, key: string, path: string): number {
  const [lo, hi] = RANGES[key]!;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < lo || v > hi) throw new ProfileError(path, `must be a whole number from ${lo} to ${hi}`);
  return v;
}

function checkBurst(v: unknown, path: string): { lines: number; windowMs: number } {
  const o = plain(v, BURST_KEYS, path, 'must be an object with lines and windowMs, or null');
  for (const k of BURST_KEYS) if (given(o, k) === undefined) throw new ProfileError(`${path}.${k}`, 'is required');
  return { lines: whole(o['lines'], 'lines', `${path}.lines`), windowMs: whole(o['windowMs'], 'windowMs', `${path}.windowMs`) };
}

/**
 * Check the shape and ranges of `input` and return what is set, as a new object that shares nothing with it: a key is present only
 * when it was given a value (`null` included), and each value was read from `input` exactly once, so what was validated is what is
 * returned even for an object with getters. Throws ProfileError like {@link resolvePace}. For a caller that must keep the override a
 * room was given (`cw.rooms.setPace`).
 * @experimental
 */
export function checkPace(input: PaceSettings, path = 'pace'): PaceSettings {
  return checked(input, path);
}

function checked(input: unknown, path: string): PaceSettings {
  const o = plain(input, PACE_KEYS, path, 'must be an object');
  const out: Record<string, unknown> = {};
  for (const k of PACE_KEYS) {
    const v = given(o, k);
    if (v !== undefined) out[k] = v === null ? null : k === 'burst' ? checkBurst(v, `${path}.${k}`) : whole(v, k, `${path}.${k}`);
  }
  return out as PaceSettings;
}

/**
 * Validate and fill. Throws ProfileError naming the field (`pace.burst.lines`), never echoing the value. `path` names the settings in
 * the error (default `pace`). The result is a new object that shares nothing with the input.
 * @experimental
 */
export function resolvePace(input: PaceSettings | undefined, path = 'pace'): ResolvedPace {
  if (input === undefined) return { slowModeMs: null, burst: null, duplicateWindowMs: null };
  const set = checked(input, path);
  return { slowModeMs: set.slowModeMs ?? null, burst: set.burst ?? null, duplicateWindowMs: set.duplicateWindowMs ?? null };
}

/**
 * `over` on top of `base`: a field left out inherits, `null` turns it off, a value sets it. `burst` is replaced whole, never merged by
 * member. `over` is validated (a ProfileError with the path `pace...`). Neither argument is changed or shared with the result.
 * @experimental
 */
export function mergePace(base: ResolvedPace, over: PaceSettings): ResolvedPace {
  const set = checked(over, 'pace');
  return {
    slowModeMs: set.slowModeMs !== undefined ? set.slowModeMs : base.slowModeMs,
    burst: set.burst !== undefined ? set.burst : base.burst === null ? null : { lines: base.burst.lines, windowMs: base.burst.windowMs },
    duplicateWindowMs: set.duplicateWindowMs !== undefined ? set.duplicateWindowMs : base.duplicateWindowMs,
  };
}
