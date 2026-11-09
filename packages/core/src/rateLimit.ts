import type { Clock } from './types.js';

// Per-key sliding-window limiter, the same arithmetic as Moxgate's: a hit older than `windowMs` is gone
// (`now - t < windowMs` keeps it), a key already holding `limit` hits is refused, otherwise the hit is
// recorded. A refused hit is not recorded. Unlike Moxgate's probabilistic sweep, quiet keys are dropped on
// a fixed cadence so memory stays bounded and behaviour is deterministic under test.

/** Sweep every key out of the map after this many `check` calls. */
const SWEEP_EVERY = 256;

export interface SlidingWindow {
  /** True when `key` is under the limit (the hit is recorded), false when it is over (nothing recorded). */
  check(key: string): boolean;
  /** Keys currently held. A diagnostic: it stays small however many keys have come and gone. */
  size(): number;
}

export function slidingWindow(opts: { limit: number; windowMs: number; clock: Clock }): SlidingWindow {
  const { limit, windowMs, clock } = opts;
  const buckets = new Map<string, number[]>();
  let calls = 0;

  const sweep = (now: number): void => {
    for (const [key, hits] of buckets) {
      const last = hits[hits.length - 1];
      if (last === undefined || now - last >= windowMs) buckets.delete(key);
    }
  };

  return {
    check(key) {
      const now = clock.now();
      if (++calls % SWEEP_EVERY === 0) sweep(now);
      const live = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
      if (live.length >= limit) {
        buckets.set(key, live);
        return false;
      }
      live.push(now);
      buckets.set(key, live);
      return true;
    },
    size: () => buckets.size,
  };
}
