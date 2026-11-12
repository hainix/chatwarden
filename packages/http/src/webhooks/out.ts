import { randomUUID } from 'node:crypto';
import { errorClass, KIT_EVENT_TYPES, safeWarn } from '@chatwarden/core';
import type { Chatwarden, Clock, KitEvent, Logger } from '@chatwarden/core';
import { checkSecret, DELIVERY_HEADER, SIGNATURE_HEADER, sign, TIMESTAMP_HEADER } from './sign.js';

/** How many times a failed delivery is retried after the first attempt: 6 attempts in all. */
export const MAX_RETRIES = 5;
/** The most deliveries one endpoint holds while waiting for the one in flight; on overflow the oldest is dropped. */
export const QUEUE_MAX = 1000;
/** Each attempt is aborted after this long. */
export const ATTEMPT_TIMEOUT_MS = 10_000;
/** The first backoff; each retry doubles it (1, 2, 4, 8, 16 s), with plus or minus 20 percent jitter. */
export const BACKOFF_BASE_MS = 1000;
/** The shortest a `retry-after` on a 429 is honoured as: a receiver cannot make us retry at once. */
export const RETRY_AFTER_FLOOR_MS = 1000;
/** The longest a `retry-after` on a 429 is honoured. */
export const RETRY_AFTER_CAP_MS = 60_000;

/** One receiver of the kit's events. */
export interface WebhookEndpoint {
  /**
   * Where deliveries are POSTed. `https:` only, except `http://localhost` and `http://127.0.0.1` for development. No
   * credentials in the URL. Checked once, when {@link webhooksOut} is called (`RangeError`); it is never logged.
   */
  url: string;
  /** Signs every delivery (HMAC-SHA256). At least 32 characters (`RangeError` otherwise). Never logged. */
  secret: string;
  /** The event types to send, or `'*'` for every event. */
  events: readonly KitEvent['type'][] | '*';
  /**
   * Add the report's excerpt to `report.created` (and to no other event). It is fetched through the staff report API
   * (`cw.reports.get`) when the event is raised.
   *
   * WARNING: the excerpt is CHAT TEXT: the raw lines players typed (blocked ones included), with the seat and handle that
   * wrote each. It is private conversation and may hold abuse. Turn it on only for a receiver you control and are
   * allowed to show chat text to (a private moderation channel, say). Off by default; the reporter's note is never sent.
   */
  includeExcerpts?: boolean;
  /**
   * Add `accounts: string[]` to `rename.required` (and to no other event): the account ids the kit holds for that person, as the game passed them
   * (`RawWho.accountId`), found with `cw.people.accountIds` when the event is raised, so the game knows which of its players to rename. A guest has
   * none (`[]`). Without it the event names only the person's staff ref, which means nothing to the game.
   *
   * WARNING: an account id is the GAME'S own identifier for a player. Turn it on only for a receiver the game controls (its own server), never a
   * shared or third-party channel. It is never in a log, and never in any other event. Off by default.
   */
  includeAccounts?: boolean;
}

export interface WebhooksOutOptions {
  endpoints: readonly WebhookEndpoint[];
  /** The `fetch` to POST with. Default: the global one. */
  fetch?: typeof fetch;
  /** The time source for signatures and timestamps. Default: `Date.now`. */
  clock?: Clock;
  /** Where failures are logged: the event type, the HTTP status or the error class, and the attempt count; never the URL, secret or body. Defaults to `console.warn`. */
  logger?: Logger;
  /** Jitter source in [0, 1). Default `Math.random`; a test passes a fixed one. */
  random?: () => number;
}

export interface WebhooksOut {
  /** Unsubscribe, clear every timer, abort the attempt in flight and drop the queues. Safe to call more than once. */
  dispose(): void;
}

const systemClock: Clock = { now: () => Date.now() };
/** Drop warnings are coalesced: at most one line per endpoint in this window. */
const DROP_LOG_WINDOW_MS = 60_000;
const IMF_DATE_RE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function parseUrl(value: unknown): URL | null {
  try {
    return typeof value === 'string' ? new URL(value) : null;
  } catch {
    return null;
  }
}

/** An endpoint as it is used: a private copy, validated once. The adopter's object is never read again. */
interface Endpoint {
  readonly href: string;
  readonly secret: string;
  readonly events: readonly KitEvent['type'][] | '*';
  readonly includeExcerpts: boolean;
  readonly includeAccounts: boolean;
}

function checkEndpoint(raw: unknown, index: number): Endpoint {
  const at = `webhooksOut: endpoints[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new RangeError(`${at} must be an object`);
  const e = raw as Partial<WebhookEndpoint>;
  // Every field is read exactly once, here.
  const { secret, events, includeExcerpts, includeAccounts } = e;
  const url = parseUrl(e.url);
  const local = url !== null && url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url === null || (url.protocol !== 'https:' && !local) || url.username !== '' || url.password !== '') {
    throw new RangeError(`${at}.url must be an https URL (http only for localhost and 127.0.0.1) without credentials`);
  }
  checkSecret(secret, `${at}.secret`);
  if (events !== '*') {
    if (!Array.isArray(events) || events.length === 0 || !events.every((t) => (KIT_EVENT_TYPES as readonly unknown[]).includes(t))) {
      throw new RangeError(`${at}.events must be '*' or a non-empty list of event types`);
    }
  }
  if (includeExcerpts !== undefined && typeof includeExcerpts !== 'boolean') {
    throw new RangeError(`${at}.includeExcerpts must be a boolean`);
  }
  if (includeAccounts !== undefined && typeof includeAccounts !== 'boolean') {
    throw new RangeError(`${at}.includeAccounts must be a boolean`);
  }
  return {
    href: url.href,
    secret,
    events: events === '*' ? '*' : Object.freeze([...new Set(events as readonly KitEvent['type'][])]),
    includeExcerpts: includeExcerpts === true,
    includeAccounts: includeAccounts === true,
  };
}

/** One event, ready to send. The body is fixed at the moment the event was raised; every attempt sends these bytes. */
interface Delivery {
  id: string;
  type: KitEvent['type'];
  body: string;
  /** The timestamp of the last attempt of THIS delivery (0 before the first). A retry is signed later than it. */
  lastTimestamp: number;
}

type Attempt =
  | { kind: 'ok' }
  | { kind: 'final'; status: number }
  | { kind: 'retry'; status?: number; error?: string; afterMs?: number };

/**
 * Send the kit's events to signed webhooks.
 *
 * Each delivery is `POST <url>` with a JSON body `{ id, type, at, data }`: `id` is a UUID for the delivery (the same on
 * every retry, also sent as `x-chatwarden-delivery`, so a receiver can deduplicate), `type` the event type, `at` the
 * time it was raised (epoch ms) and `data` the event, which holds ids, codes and times and no chat text. Headers
 * `x-chatwarden-timestamp` (unix seconds) and `x-chatwarden-signature` (`v1=<hex>`, HMAC-SHA256 over
 * `${timestamp}.${body}` with the endpoint's secret) sign each ATTEMPT afresh, so a retry is never outside the
 * receiver's 5 minute window; verify them with `verify` (this package). Events carry subject ids: send them to staff
 * channels only. `includeExcerpts` puts chat text in the body: read its warning. `includeAccounts` puts the game's own account ids in a
 * `rename.required` body (nothing else): read its warning. The appeal events (`appeal.created`, `appeal.decided`) and `rename.required` carry ids,
 * codes and times only, never a statement, a reason or a handle, and `events` accepts them like any other type.
 *
 * Delivery: a 2xx succeeds. A network error, a timeout (10 s per attempt), a 5xx or a 429 is retried, up to 5 times
 * (6 attempts), after 1, 2, 4, 8 and 16 seconds with plus or minus 20 percent jitter; a 429's `retry-after` (seconds or
 * an HTTP date) replaces the wait, capped at 60 s. Any other status (a 4xx, a redirect: none is followed) is final. A
 * delivery that fails for good is logged (`chatwarden.webhook_failed`: event type, status or error class, attempts)
 * and dropped. The queue is in memory (lost on restart), one per endpoint, delivered in order, one delivery at a time,
 * and bounded at 1000 waiting; past that the oldest is dropped. Drops are logged as a count
 * (`chatwarden.webhook_dropped`): the first at once, then at most once a minute per endpoint, and what is left when
 * `dispose()` runs. A 429's `retry-after` is honoured from 1 s (a receiver cannot make us retry at once) to 60 s.
 * The endpoints are copied when this is called: changing your config object afterwards changes nothing.
 *
 * Everything is checked once, here: a bad URL or a secret under 32 characters throws `RangeError` (the message never
 * holds the value) and subscribes nothing. Call `dispose()` on shutdown.
 */
export function webhooksOut(cw: Pick<Chatwarden, 'on' | 'reports' | 'people'>, options: WebhooksOutOptions): WebhooksOut {
  if (typeof options !== 'object' || options === null || !Array.isArray(options.endpoints) || options.endpoints.length === 0) {
    throw new RangeError('webhooksOut: endpoints must be a non-empty list');
  }
  const endpoints = options.endpoints.map(checkEndpoint);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const { logger } = options;

  let disposed = false;
  const unsubscribes: Array<() => void> = [];
  const timers = new Set<{ timer: ReturnType<typeof setTimeout>; wake: () => void }>();
  const aborts = new Set<AbortController>();
  const queues: Delivery[][] = [];
  const flushers: Array<() => void> = [];

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

  /** A receiver's `retry-after` is honoured between 1 s (it cannot make us retry at once) and 60 s. */
  const floorAndCap = (ms: number): number => Math.min(Math.max(ms, RETRY_AFTER_FLOOR_MS), RETRY_AFTER_CAP_MS);

  /** How long a 429 asks us to wait, or undefined for no usable `retry-after`. */
  const retryAfter = (value: string | null): number | undefined => {
    if (value === null) return undefined;
    if (/^\d{1,12}$/.test(value)) return floorAndCap(Number(value) * 1000);
    if (IMF_DATE_RE.test(value)) {
      const at = Date.parse(value);
      if (Number.isFinite(at)) return floorAndCap(at - clock.now());
    }
    return undefined;
  };

  for (const endpoint of endpoints) {
    const queue: Delivery[] = [];
    let busy = false;
    let dropped = 0;
    let lastDropLog: number | null = null;
    let dropTimer: ReturnType<typeof setTimeout> | undefined;

    /** Log the drops counted since the last line, as one count. */
    const flushDrops = (): void => {
      if (dropTimer !== undefined) clearTimeout(dropTimer);
      dropTimer = undefined;
      if (dropped === 0) return;
      safeWarn(logger, 'chatwarden.webhook_dropped', { count: dropped });
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
    flushers.push(flushDrops);

    const attempt = async (d: Delivery): Promise<Attempt> => {
      // A fresh timestamp for every attempt, and strictly later than this delivery's last, so a retry (same body) in the same
      // second is not a replay. Different deliveries have different bodies and signatures: they never push each other later.
      const timestamp = Math.max(Math.floor(clock.now() / 1000), d.lastTimestamp + 1);
      d.lastTimestamp = timestamp;
      const controller = new AbortController();
      aborts.add(controller);
      const timeout = setTimeout(() => controller.abort(new DOMException('The attempt timed out.', 'TimeoutError')), ATTEMPT_TIMEOUT_MS);
      try {
        const res = await fetchFn(endpoint.href, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [TIMESTAMP_HEADER]: String(timestamp),
            [SIGNATURE_HEADER]: sign(endpoint.secret, timestamp, d.body),
            [DELIVERY_HEADER]: d.id,
          },
          body: d.body,
          redirect: 'manual',
          signal: controller.signal,
        });
        const status = res.status;
        const wait = status === 429 ? retryAfter(res.headers.get('retry-after')) : undefined;
        try {
          // Free the connection; the body is of no use.
          await res.body?.cancel();
        } catch {
          // ignore
        }
        if (status >= 200 && status < 300) return { kind: 'ok' };
        if (status === 429 || status >= 500) return { kind: 'retry', status, ...(wait === undefined ? {} : { afterMs: wait }) };
        return { kind: 'final', status };
      } catch (err) {
        return { kind: 'retry', error: errorClass(err) };
      } finally {
        clearTimeout(timeout);
        aborts.delete(controller);
      }
    };

    const fail = (d: Delivery, attempts: number, last: { status?: number; error?: string }): void => {
      safeWarn(logger, 'chatwarden.webhook_failed', {
        type: d.type,
        ...(last.status === undefined ? {} : { status: last.status }),
        ...(last.error === undefined ? {} : { error: last.error }),
        attempts,
      });
    };

    const deliver = async (d: Delivery): Promise<void> => {
      for (let tried = 1; ; tried++) {
        const result = await attempt(d);
        if (disposed) return;
        if (result.kind === 'ok') return;
        if (result.kind === 'final') return fail(d, tried, { status: result.status });
        if (tried > MAX_RETRIES) {
          return fail(d, tried, { ...(result.status === undefined ? {} : { status: result.status }), ...(result.error === undefined ? {} : { error: result.error }) });
        }
        await sleep(result.afterMs ?? backoff(tried - 1));
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
            safeWarn(logger, 'chatwarden.webhook_failed', { type: next.type, error: errorClass(err), attempts: 0 });
          }
        }
      } finally {
        busy = false;
      }
    };

    const onEvent = (event: KitEvent): void => {
      if (disposed) return;
      try {
        let data: Record<string, unknown> = { ...event };
        if (endpoint.includeExcerpts && event.type === 'report.created') {
          try {
            const report = cw.reports.get(event.reportId);
            if (report !== null) {
              data = {
                ...data,
                excerpt: report.excerpt.map((l) => ({
                  lineId: l.lineId,
                  ts: l.ts,
                  seatId: l.seatId,
                  handle: l.handle,
                  text: l.raw,
                  blocked: l.blocked,
                })),
              };
            }
          } catch (err) {
            safeWarn(logger, 'chatwarden.webhook_excerpt_failed', { error: errorClass(err) });
          }
        }
        if (endpoint.includeAccounts && event.type === 'rename.required') {
          try {
            // Fetched now, when the event is raised: the body is fixed from here on, and nothing is cached between events.
            data = { ...data, accounts: cw.people.accountIds(event.target) };
          } catch (err) {
            safeWarn(logger, 'chatwarden.webhook_accounts_failed', { error: errorClass(err) });
          }
        }
        const id = randomUUID();
        const body = JSON.stringify({ id, type: event.type, at: clock.now(), data });
        if (queue.length >= QUEUE_MAX) {
          queue.shift();
          noteDrop();
        }
        queue.push({ id, type: event.type, body, lastTimestamp: 0 });
        void drain();
      } catch (err) {
        safeWarn(logger, 'chatwarden.webhook_failed', { type: event.type, error: errorClass(err), attempts: 0 });
      }
    };

    // One typed `'*'` subscription per endpoint; the endpoint's own list is checked in the listener.
    const wanted: ReadonlySet<string> | null = endpoint.events === '*' ? null : new Set<string>(endpoint.events);
    unsubscribes.push(
      cw.on('*', (event) => {
        if (wanted === null || wanted.has(event.type)) onEvent(event);
      }),
    );
    queues.push(queue);
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      for (const entry of timers) {
        clearTimeout(entry.timer);
        entry.wake();
      }
      timers.clear();
      for (const controller of aborts) controller.abort();
      aborts.clear();
      for (const queue of queues) queue.length = 0;
      queues.length = 0;
      // The drops not logged yet, once, and no timer left behind.
      for (const flush of flushers.splice(0)) flush();
    },
  };
}
