import { createHmac } from 'node:crypto';
import { errorClass, safeWarn } from '@chatwarden/core';
import type { Logger, NoticeDelivery } from '@chatwarden/core';
import { checkSecret, DELIVERY_HEADER, SIGNATURE_HEADER } from '../webhooks/sign.js';

// The delivery webhook (0.2.1): `createChatwarden({ notices: { deliver: webhook.deliver } })` hands every sanction notice and appeal outcome of a person with an account to the game's own
// receiver, signed. It is NOT the events webhook (`webhooksOut`): that one carries ids to staff channels, this one carries the player's own notice text and link to the game's mail or push system,
// so it has its own small, fixed rules. Node only (`node:crypto`); it is not in the browser-safe `service` index.
//
//   POST <url>   content-type: application/json
//   x-chatwarden-signature: sha256=<lowercase hex of HMAC-SHA256(secret, body)>   (the body alone, as sent)
//   x-chatwarden-delivery:  <the notice id>   (the same on every retry: a receiver deduplicates on it)
//
// 2xx is delivered. A network error, a timeout (10 s an attempt), 408, 429 and 5xx are retried after 1, 3 and 6 minutes (four attempts, ten minutes in all; `retryDelaysMs` changes it); any other
// status (a 4xx, a redirect: none is followed) is final. Whatever is not delivered then is dropped: the queue is in memory and is lost on a restart. At most 1000 deliveries wait at once; past that the
// oldest is dropped and counted. The log holds classes and counts: never the body, the URL, the account, the text or the link.

/** What `createDeliveryWebhook` takes. */
export interface DeliveryWebhookOptions {
  /** Where deliveries are POSTed: `https:`, or `http:` for `localhost` and `127.0.0.1`; no credentials. Checked once (`RangeError`, the message never holds the value). Never logged. */
  url: string;
  /** Signs every delivery (HMAC-SHA256). At least 32 characters (`RangeError`). Never logged. */
  secret: string;
  /** The `fetch` to POST with. Default: the global one. */
  fetch?: typeof fetch;
  /** Arms a timer. Default `setTimeout` (unref'd, so a waiting retry never keeps a process alive). A test passes a fake. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Clears what `setTimeout` armed. */
  clearTimeout?: (timer: unknown) => void;
  /** Where failures are logged (event, error class or status, counts). Defaults to `console.warn`. */
  logger?: Logger;
  /** The waits before each retry, in ms. Default `[60000, 180000, 360000]`. An empty list means one attempt. */
  retryDelaysMs?: readonly number[];
}

/** What it gives back. */
export interface DeliveryWebhook {
  /** Hand over one delivery. Returns at once with nothing to await, and never throws: a delivery it cannot take is dropped (and counted in the log, by class). */
  deliver(d: NoticeDelivery): void;
  /** Clear every timer, abort what is in flight, drop what waits (logging how many) and ignore later deliveries. Safe to call twice. */
  dispose(): void;
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([60_000, 180_000, 360_000]);
const ATTEMPT_TIMEOUT_MS = 10_000;
/** The most deliveries that may be in flight or waiting for a retry at once. */
const MAX_WAITING = 1000;
const DROP_LOG_EVERY_MS = 60_000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function checkUrl(value: unknown): string {
  let url: URL | null;
  try {
    url = typeof value === 'string' ? new URL(value) : null;
  } catch {
    url = null;
  }
  const local = url !== null && url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url === null || (url.protocol !== 'https:' && !local) || url.username !== '' || url.password !== '') {
    throw new RangeError('delivery url must be an https address (http only for localhost and 127.0.0.1) without credentials');
  }
  return url.href;
}

function checkDelays(value: unknown): readonly number[] {
  if (value === undefined) return DEFAULT_RETRY_DELAYS_MS;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1)) {
    throw new RangeError('delivery retryDelaysMs must be a list of whole numbers of milliseconds, each 1 or more');
  }
  return Object.freeze([...(value as number[])]);
}

/** One delivery, from the moment it is handed over until it is delivered, dropped or disposed. The body is fixed then. */
interface Chain {
  readonly id: string;
  readonly body: string;
  attempts: number;
  /** The timer in force: the attempt's timeout while it is in flight, the retry's wait while it sleeps. */
  timer: unknown;
  abort: AbortController | undefined;
  cancelled: boolean;
}

type Outcome = { kind: 'ok' } | { kind: 'final'; status: number } | { kind: 'retry'; status?: number; error?: string };

/** The delivery webhook. Everything is checked once, here (`RangeError`); nothing is read from the options again. */
export function createDeliveryWebhook(o: DeliveryWebhookOptions): DeliveryWebhook {
  if (typeof o !== 'object' || o === null) throw new TypeError('createDeliveryWebhook: options must be an object');
  const href = checkUrl(o.url);
  const { secret } = o;
  checkSecret(secret, 'delivery secret');
  const delays = checkDelays(o.retryDelaysMs);
  const { logger } = o;
  const arm =
    o.setTimeout ??
    ((fn: () => void, ms: number): unknown => {
      const timer = setTimeout(fn, ms);
      (timer as { unref?: () => void }).unref?.();
      return timer;
    });
  const disarm = o.clearTimeout ?? ((timer: unknown): void => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const fetchFn = o.fetch;

  const chains = new Set<Chain>();
  let disposed = false;
  let droppedSinceLog = 0;
  let lastDropLog = Number.NEGATIVE_INFINITY;

  const noteDrops = (n: number): void => {
    droppedSinceLog += n;
    const now = Date.now();
    if (now - lastDropLog < DROP_LOG_EVERY_MS) return;
    lastDropLog = now;
    const count = droppedSinceLog;
    droppedSinceLog = 0;
    safeWarn(logger, 'chatwarden.delivery_webhook_dropped', { count });
  };

  const cancel = (c: Chain): void => {
    c.cancelled = true;
    if (c.timer !== undefined) disarm(c.timer);
    c.timer = undefined;
    c.abort?.abort();
    c.abort = undefined;
  };

  const finish = (c: Chain): void => {
    chains.delete(c);
  };

  /** One attempt, then what follows from its outcome. Never rejects. */
  const send = async (c: Chain): Promise<void> => {
    c.attempts += 1;
    const abort = new AbortController();
    c.abort = abort;
    c.timer = arm(() => abort.abort(), ATTEMPT_TIMEOUT_MS);
    let outcome: Outcome;
    try {
      const res = await (fetchFn ?? globalThis.fetch)(href, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: `sha256=${createHmac('sha256', secret).update(c.body, 'utf8').digest('hex')}`,
          [DELIVERY_HEADER]: c.id,
        },
        body: c.body,
        redirect: 'manual',
        signal: abort.signal,
      });
      const status = res.status;
      try {
        // Free the connection; the body is of no use.
        await res.body?.cancel();
      } catch {
        /* nothing to do */
      }
      if (status >= 200 && status < 300) outcome = { kind: 'ok' };
      else if (status === 408 || status === 429 || status >= 500) outcome = { kind: 'retry', status };
      else outcome = { kind: 'final', status };
    } catch (err) {
      outcome = { kind: 'retry', error: errorClass(err) };
    }
    if (c.timer !== undefined) disarm(c.timer);
    c.timer = undefined;
    c.abort = undefined;
    if (c.cancelled) return;
    if (outcome.kind === 'ok') return finish(c);
    if (outcome.kind === 'final') {
      safeWarn(logger, 'chatwarden.delivery_webhook_failed', { status: outcome.status, attempts: c.attempts });
      return finish(c);
    }
    const wait = delays[c.attempts - 1];
    if (wait === undefined) {
      safeWarn(logger, 'chatwarden.delivery_webhook_failed', { ...(outcome.status === undefined ? { error: outcome.error ?? 'Error' } : { status: outcome.status }), attempts: c.attempts });
      return finish(c);
    }
    c.timer = arm(() => {
      c.timer = undefined;
      void send(c);
    }, wait);
  };

  const deliver = (d: NoticeDelivery): void => {
    try {
      if (disposed) return;
      const id: unknown = (d as { noticeId?: unknown }).noticeId;
      if (typeof id !== 'string' || !ID_RE.test(id)) return;
      const body = JSON.stringify(d);
      if (chains.size >= MAX_WAITING) {
        const oldest = chains.values().next();
        if (oldest.done !== true) {
          cancel(oldest.value);
          chains.delete(oldest.value);
          noteDrops(1);
        }
      }
      const chain: Chain = { id, body, attempts: 0, timer: undefined, abort: undefined, cancelled: false };
      chains.add(chain);
      void send(chain).catch(() => undefined);
    } catch (err) {
      safeWarn(logger, 'chatwarden.delivery_webhook_failed', { error: errorClass(err), attempts: 0 });
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const waiting = chains.size;
    for (const c of chains) cancel(c);
    chains.clear();
    const count = waiting + droppedSinceLog;
    droppedSinceLog = 0;
    if (count > 0) safeWarn(logger, 'chatwarden.delivery_webhook_dropped', { count });
  };

  return { deliver, dispose };
}
