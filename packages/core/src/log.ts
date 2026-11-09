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
