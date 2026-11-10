import type { Logger } from './types.js';

type Detail = Record<string, string | number | boolean>;

/**
 * Log one warning without ever letting the logger hurt the caller. The one place a service or the facade logs.
 *
 * With no `logger`, falls back to `console.warn`. A logger that throws, or that is async and rejects, is
 * swallowed: a broken logger must not break chat, a door, a report, or (from a timer) crash the process.
 * Callers pass an event name and, at most, the error class: never an identifier.
 */
export function safeWarn(logger: Logger | undefined, event: string, detail?: Detail): void {
  try {
    let out: unknown;
    if (logger !== undefined) {
      out = logger.warn(event, detail);
    } else if (detail === undefined) {
      console.warn(event);
    } else {
      console.warn(event, detail);
    }
    if (typeof (out as { then?: unknown } | null | undefined)?.then === 'function') {
      (out as PromiseLike<unknown>).then(undefined, () => undefined);
    }
  } catch {
    // A broken logger is not allowed to break the caller.
  }
}

/**
 * The only thing about a caught value that may be logged: an `Error`'s name (its class), or the `typeof` of anything
 * else. Never the message, which can carry an id, a URL or user text. Never throws: a hostile `name` getter or a revoked
 * proxy gives `'unknown'`.
 */
export function errorClass(err: unknown): string {
  try {
    return err instanceof Error ? err.name : typeof err;
  } catch {
    return 'unknown';
  }
}

/**
 * A warning for a path that can fail on every call at high frequency (a typing indicator during a store outage): the
 * first failure is logged, then at most one more per `intervalMs`, which carries `suppressed`, the number of failures
 * held back since the last line. The clock is the kit's, so a test or a replay controls it.
 */
export class ThrottledWarn {
  private last: number | null = null;
  private held = 0;

  private readonly logger: Logger | undefined;
  private readonly clock: { now(): number };
  private readonly intervalMs: number;

  constructor(logger: Logger | undefined, clock: { now(): number }, intervalMs = 60_000) {
    this.logger = logger;
    this.clock = clock;
    this.intervalMs = intervalMs;
  }

  warn(event: string, detail: Detail): void {
    let now: number;
    try {
      now = this.clock.now();
    } catch {
      now = 0;
    }
    if (this.last !== null && now - this.last < this.intervalMs && now >= this.last) {
      this.held++;
      return;
    }
    const out: Detail = this.held > 0 ? { ...detail, suppressed: this.held } : detail;
    this.last = now;
    this.held = 0;
    safeWarn(this.logger, event, out);
  }
}
