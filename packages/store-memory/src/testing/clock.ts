// A clock you move by hand. Nothing in the test kit moves time by itself, so a test is the same on every run.
import type { Clock } from '@chatwarden/core';
import { durationMs } from './duration.js';
import type { Duration } from './duration.js';

/** Where a fake clock starts unless told otherwise: the constant the repository's own tests use. */
const START = 1_800_000_000_000;

/**
 * A clock you move by hand. `now()` is what `createChatwarden` reads.
 * @experimental
 */
export interface FakeClock extends Clock {
  now(): number;
  /** Go to exactly this time (any non-negative finite number, forwards or back). */
  set(epochMs: number): void;
  /** Move forward, never back, and return the new time. A negative or invalid duration is a `RangeError` and moves nothing. */
  advance(by: Duration): number;
}

function instant(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError('A time is a non-negative number of milliseconds since the epoch.');
  return value;
}

/**
 * A fake clock starting at `startMs` (default 1_800_000_000_000).
 * @experimental
 */
export function createFakeClock(startMs: number = START): FakeClock {
  let current = instant(startMs);
  return {
    now: () => current,
    set(epochMs) {
      current = instant(epochMs);
    },
    advance(by) {
      current += durationMs(by);
      return current;
    },
  };
}
