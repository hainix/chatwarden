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
/** The most (room, player) states the limiter holds; the oldest go. */
export const PACE_KEYS_MAX = 50_000;

const SLOW_MODE_RANGE = [500, 600_000] as const;
const BURST_LINES_RANGE = [2, 100] as const;
const BURST_WINDOW_RANGE = [1000, 600_000] as const;
const DUPLICATE_RANGE = [1000, 3_600_000] as const;

const PACE_KEYS: readonly string[] = ['slowModeMs', 'burst', 'duplicateWindowMs'];
const BURST_KEYS: readonly string[] = ['lines', 'windowMs'];

/**
 * Values the hub offers behind "Use suggested values". Never applied by themselves.
 * @experimental
 */
export const PACE_SUGGESTIONS: Readonly<Record<'relaxed' | 'standard' | 'strict', ResolvedPace>> = Object.freeze({
  relaxed: Object.freeze({ slowModeMs: null, burst: Object.freeze({ lines: 10, windowMs: 10_000 }), duplicateWindowMs: 10_000 }),
  standard: Object.freeze({ slowModeMs: null, burst: Object.freeze({ lines: 6, windowMs: 10_000 }), duplicateWindowMs: 15_000 }),
  strict: Object.freeze({ slowModeMs: 2000, burst: Object.freeze({ lines: 5, windowMs: 10_000 }), duplicateWindowMs: 30_000 }),
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

function whole(v: unknown, range: readonly [number, number], path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < range[0] || v > range[1]) {
    throw new ProfileError(path, `must be a whole number from ${range[0]} to ${range[1]}`);
  }
  return v;
}

function checkBurst(v: unknown, path: string): { lines: number; windowMs: number } {
  if (!isPlain(v)) throw new ProfileError(path, 'must be an object with lines and windowMs, or null');
  for (const k of Object.keys(v)) if (!BURST_KEYS.includes(k)) throw new ProfileError(`${path}.${k}`, 'is not a known setting');
  const lines = given(v, 'lines');
  if (lines === undefined) throw new ProfileError(`${path}.lines`, 'is required');
  const windowMs = given(v, 'windowMs');
  if (windowMs === undefined) throw new ProfileError(`${path}.windowMs`, 'is required');
  return { lines: whole(lines, BURST_LINES_RANGE, `${path}.lines`), windowMs: whole(windowMs, BURST_WINDOW_RANGE, `${path}.windowMs`) };
}

/** Check the shape and ranges of `input` and return what is set: a key is present only when it was given a value (`null` included). */
function checked(input: unknown, path: string): PaceSettings {
  if (!isPlain(input)) throw new ProfileError(path, 'must be an object');
  for (const k of Object.keys(input)) if (!PACE_KEYS.includes(k)) throw new ProfileError(`${path}.${k}`, 'is not a known setting');
  const out: PaceSettings = {};
  const slow = given(input, 'slowModeMs');
  if (slow !== undefined) out.slowModeMs = slow === null ? null : whole(slow, SLOW_MODE_RANGE, `${path}.slowModeMs`);
  const burst = given(input, 'burst');
  if (burst !== undefined) out.burst = burst === null ? null : checkBurst(burst, `${path}.burst`);
  const dup = given(input, 'duplicateWindowMs');
  if (dup !== undefined) out.duplicateWindowMs = dup === null ? null : whole(dup, DUPLICATE_RANGE, `${path}.duplicateWindowMs`);
  return out;
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
