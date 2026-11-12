// The fixed-window counter shared by the player routes (names check) and the chat routes (lines, mutes, reports, stream opens). It holds
// a `Map` and nothing else: no `node:` import, so it runs in a browser tab like the rest of `@chatwarden/http/chat`.

/** A rate limit: at most `max` calls per `windowMs` per key. */
export interface NamesRateLimit {
  max: number;
  windowMs: number;
}

/** A limiter never holds more keys than this. */
export const MAX_LIMITER_KEYS = 10_000;

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

/**
 * A limit from the adopter, or `fallback` when none is given. A `RangeError` naming `label` (never the value) unless both fields are
 * positive whole numbers. The result is a copy.
 */
export function checkLimit(limit: unknown, fallback: NamesRateLimit, label: string): NamesRateLimit {
  if (limit === undefined) return fallback;
  const l = limit as { max?: unknown; windowMs?: unknown } | null;
  if (typeof l !== 'object' || l === null || !isPositiveInt(l.max) || !isPositiveInt(l.windowMs)) {
    throw new RangeError(`${label} needs a positive whole max and windowMs`);
  }
  return { max: l.max, windowMs: l.windowMs };
}

/**
 * A fixed-window counter per key, bounded. Entries live in insertion order, which is also window-start order (a reset
 * re-inserts), so expired ones are swept from the front in O(1) each. At the cap, the oldest live key goes.
 */
export class Limiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: NamesRateLimit;
  constructor(limit: NamesRateLimit) {
    this.limit = limit;
  }

  /** 0 when the call is allowed (and counted); otherwise the milliseconds until the window reopens. */
  hit(key: string, now: number): number {
    const { max, windowMs } = this.limit;
    for (const [k, w] of this.windows) {
      if (now - w.start < windowMs) break;
      this.windows.delete(k);
    }
    const w = this.windows.get(key);
    if (w === undefined || now - w.start >= windowMs) {
      this.windows.delete(key);
      if (this.windows.size >= MAX_LIMITER_KEYS) {
        const oldest = this.windows.keys().next();
        if (oldest.done !== true) this.windows.delete(oldest.value);
      }
      this.windows.set(key, { start: now, count: 1 });
      return 0;
    }
    if (w.count < max) {
      w.count++;
      return 0;
    }
    return Math.min(windowMs, Math.max(1, w.start + windowMs - now));
  }
}
