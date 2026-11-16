import { errorClass, safeWarn } from '@chatwarden/core';
import type { Clock, Logger } from '@chatwarden/core';

// The kit's outbound delivery rules, as a queue of any job (K5 design 5.4): `webhooksOut` has always had them, and the Coop and EOS adapters
// follow the same ones, so the three cannot drift. One job in flight, in order; a failed attempt is retried with a doubling backoff and jitter;
// a receiver's wait is honoured within a floor and a cap; the queue is bounded and drops the oldest; a failure for good and a drop are each
// logged as a class and a count and nothing else. The queue knows nothing of HTTP: `send` makes one attempt and says how it went.

/** How many times a failed delivery is retried after the first attempt: 6 attempts in all. */
export const MAX_RETRIES = 5;
/** The most jobs one queue holds while waiting for the one in flight; on overflow the oldest is dropped. */
export const QUEUE_MAX = 1000;
/** Each attempt is aborted after this long. */
export const ATTEMPT_TIMEOUT_MS = 10_000;
/** The first backoff; each retry doubles it (1, 2, 4, 8, 16 s), with plus or minus 20 percent jitter. */
export const BACKOFF_BASE_MS = 1000;
/** The shortest a receiver's retry-after is honoured as: a receiver cannot make us retry at once. */
export const RETRY_AFTER_FLOOR_MS = 1000;
/** The longest a receiver's retry-after is honoured. */
export const RETRY_AFTER_CAP_MS = 60_000;

/** Drop warnings are coalesced: at most one line per queue in this window. */
const DROP_LOG_WINDOW_MS = 60_000;

/** How one attempt went. `afterMs` is the receiver's own wait (a 429's retry-after), clamped to 1..60 s here. */
export type Attempt =
  | { kind: 'ok' }
  | { kind: 'final'; status: number }
  | { kind: 'retry'; status?: number; error?: string; afterMs?: number };

export interface DeliveryQueueOptions<Job> {
  /**
   * Make ONE attempt. `signal` aborts after {@link ATTEMPT_TIMEOUT_MS} and when the queue is disposed. A throw or a rejection is a retry,
   * logged by class only; so an abort should simply reject.
   */
  send(job: Job, signal: AbortSignal): Promise<Attempt>;
  clock: Clock;
  /** Jitter source in [0, 1). */
  random: () => number;
  /** Where failures and drops are logged. The queue logs `<event>_failed` and `<event>_dropped`, never a job. */
  logger?: Logger;
  /** The log event prefix, such as `chatwarden.webhook`. */
  event: string;
  /** The most jobs held waiting (not counting the one in flight). Default {@link QUEUE_MAX}. */
  max?: number;
  /**
   * Short fields from the job to put on a `<event>_failed` line (a type name, say): strings, numbers and booleans only, never text a player
   * wrote, a handle, an id of a person or a secret. A throw is ignored.
   */
  detail?: (job: Job) => Record<string, string | number | boolean>;
}

export interface DeliveryQueue<Job> {
  /** Queue a job. Ignored after `dispose`. The first job on an idle queue starts at once. */
  push(job: Job): void;
  /** Abort the attempt in flight, clear every timer, drop the queue and log the drops not yet logged. Safe to call more than once. */
  dispose(): void;
  /** How many jobs are waiting (the one in flight is not counted). */
  size(): number;
}

/** A wait the receiver asked for, within the floor and the cap; undefined when it is absent or not a finite number. */
function clampWait(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, RETRY_AFTER_FLOOR_MS), RETRY_AFTER_CAP_MS);
}

/** Make a delivery queue. Nothing runs until the first `push`. */
export function createDeliveryQueue<Job>(opts: DeliveryQueueOptions<Job>): DeliveryQueue<Job> {
  const { send, clock, random, logger, event, detail } = opts;
  const max = opts.max ?? QUEUE_MAX;
  const queue: Job[] = [];
  let busy = false;
  let disposed = false;
  let dropped = 0;
  let lastDropLog: number | null = null;
  let dropTimer: ReturnType<typeof setTimeout> | undefined;
  const timers = new Set<{ timer: ReturnType<typeof setTimeout>; wake: () => void }>();
  const aborts = new Set<AbortController>();
  const attemptTimeouts = new Set<ReturnType<typeof setTimeout>>();

  /** Sleep `ms`, or until dispose. */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const entry = {
        timer: setTimeout(() => {
          timers.delete(entry);
          resolve();
        }, ms),
        wake: resolve,
      };
      timers.add(entry);
    });

  const backoff = (retry: number): number => Math.round(BACKOFF_BASE_MS * 2 ** retry * (1 + (random() * 0.4 - 0.2)));

  /** Log the drops counted since the last line, as one count. */
  const flushDrops = (): void => {
    if (dropTimer !== undefined) clearTimeout(dropTimer);
    dropTimer = undefined;
    if (dropped === 0) return;
    safeWarn(logger, `${event}_dropped`, { count: dropped });
    dropped = 0;
    lastDropLog = clock.now();
  };

  /** Count a drop. The first logs at once; after that at most one line per 60 s (the rest waits for the window or dispose). */
  const noteDrop = (): void => {
    dropped++;
    const since = lastDropLog === null ? Infinity : clock.now() - lastDropLog;
    if (since >= DROP_LOG_WINDOW_MS) flushDrops();
    else if (dropTimer === undefined) {
      dropTimer = setTimeout(flushDrops, DROP_LOG_WINDOW_MS - since);
      dropTimer.unref?.();
    }
  };

  /** One attempt, under its own timeout and abort. A throw is a retry, by class. */
  const attempt = async (job: Job): Promise<Attempt> => {
    const controller = new AbortController();
    aborts.add(controller);
    const timeout = setTimeout(() => controller.abort(new DOMException('The attempt timed out.', 'TimeoutError')), ATTEMPT_TIMEOUT_MS);
    attemptTimeouts.add(timeout);
    try {
      return await send(job, controller.signal);
    } catch (err) {
      return { kind: 'retry', error: errorClass(err) };
    } finally {
      clearTimeout(timeout);
      attemptTimeouts.delete(timeout);
      aborts.delete(controller);
    }
  };

  const fail = (job: Job, attempts: number, last: { status?: number; error?: string }): void => {
    let extra: Record<string, string | number | boolean>;
    try {
      extra = detail?.(job) ?? {};
    } catch {
      extra = {};
    }
    safeWarn(logger, `${event}_failed`, {
      ...extra,
      ...(last.status === undefined ? {} : { status: last.status }),
      ...(last.error === undefined ? {} : { error: last.error }),
      attempts,
    });
  };

  const deliver = async (job: Job): Promise<void> => {
    for (let tried = 1; ; tried++) {
      const result = await attempt(job);
      if (disposed) return;
      if (result.kind === 'ok') return;
      if (result.kind === 'final') return fail(job, tried, { status: result.status });
      if (tried > MAX_RETRIES) {
        return fail(job, tried, { ...(result.status === undefined ? {} : { status: result.status }), ...(result.error === undefined ? {} : { error: result.error }) });
      }
      await sleep(clampWait(result.afterMs) ?? backoff(tried - 1));
      if (disposed) return;
    }
  };

  const drain = async (): Promise<void> => {
    if (busy || disposed) return;
    busy = true;
    try {
      for (let next = queue.shift(); next !== undefined && !disposed; next = queue.shift()) {
        try {
          await deliver(next);
        } catch (err) {
          fail(next, 0, { error: errorClass(err) });
        }
      }
    } finally {
      busy = false;
    }
  };

  return {
    push(job) {
      if (disposed) return;
      if (queue.length >= max) {
        queue.shift();
        noteDrop();
      }
      queue.push(job);
      void drain();
    },
    size: () => queue.length,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of timers) {
        clearTimeout(entry.timer);
        entry.wake();
      }
      timers.clear();
      for (const controller of aborts) controller.abort();
      aborts.clear();
      // A send that ignores its signal never returns to clear its own timeout.
      for (const timeout of attemptTimeouts) clearTimeout(timeout);
      attemptTimeouts.clear();
      queue.length = 0;
      // The drops not logged yet, once, and no timer left behind.
      flushDrops();
    },
  };
}
