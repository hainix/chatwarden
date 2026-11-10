import { errorClass, safeWarn } from '@chatwarden/core';
import type { Logger } from '@chatwarden/core';

// The Discord forum, as a channel webhook. A forum webhook can open a thread (`thread_name`) and post into one
// (`thread_id`), and nothing more: no buttons, no reading. Every request is `POST ...?wait=true`, so Discord answers
// with the message; for a new thread its `channel_id` is the thread id.
//
// Failures are logged as an operation name, an HTTP status or an error class, and an attempt count. Never the webhook
// URL (it is a credential), the thread name, the content or an error message (a fetch error can quote the URL).

/** How many times a failed request is retried after the first attempt: 6 attempts in all. */
export const MAX_RETRIES = 5;
/** Each attempt (the request and the reading of its answer) is aborted after this long. */
export const ATTEMPT_TIMEOUT_MS = 10_000;
/** The first backoff for a 5xx or a network error; each retry doubles it (1, 2, 4, 8, 16 s), with plus or minus 20 percent jitter. */
export const BACKOFF_BASE_MS = 1000;
/** The shortest a 429's `retry_after` is honoured as: Discord cannot make us retry at once. */
export const RETRY_AFTER_FLOOR_MS = 500;
/** The longest a 429's `retry_after` is honoured. */
export const RETRY_AFTER_CAP_MS = 60_000;
/** Discord's limit on a forum thread name. */
export const THREAD_NAME_MAX = 100;
/** Discord's limit on a message's content. */
export const CONTENT_MAX = 2000;

/** Discord's JSON error code for "Unknown Channel": the thread was deleted. */
const UNKNOWN_CHANNEL = 10003;
/** Message flag SUPPRESS_EMBEDS: a link in the text must never unfurl into a preview card. */
const SUPPRESS_EMBEDS = 4;

const HOSTS: readonly string[] = ['discord.com', 'discordapp.com'].flatMap((d) => [d, `ptb.${d}`, `canary.${d}`]);
const WEBHOOK_PATH_RE = /^\/api\/webhooks\/(\d{17,20})\/([A-Za-z0-9._-]{1,200})\/?$/;

/** A Discord snowflake as text: 17 to 20 digits. */
export const isSnowflake = (value: unknown): value is string => typeof value === 'string' && /^\d{17,20}$/.test(value);

/**
 * Check a Discord webhook URL and return it bare (no query, no fragment, no trailing slash): `https:`, host
 * `discord.com` or `discordapp.com` (or their `ptb.` and `canary.` subdomains), no port or credentials, and path
 * `/api/webhooks/<id>/<token>`. Throws `RangeError`; the message never holds the value.
 */
export function parseWebhookUrl(raw: unknown): string {
  const fail = (): never => {
    throw new RangeError('discordFeed: webhookUrl must be an https Discord webhook URL (discord.com/api/webhooks/<id>/<token>)');
  };
  let url: URL;
  try {
    url = new URL(typeof raw === 'string' ? raw : '');
  } catch {
    return fail();
  }
  const path = WEBHOOK_PATH_RE.exec(url.pathname);
  if (url.protocol !== 'https:' || !HOSTS.includes(url.hostname) || url.port !== '' || url.username !== '' || url.password !== '' || path === null) {
    return fail();
  }
  return `https://${url.hostname}/api/webhooks/${path[1]}/${path[2]}`;
}

/** `text` cut to at most `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

/** What the feed sends: the text, and the one role it may ping (severe posts only). */
export interface ForumMessage {
  content: string;
  /** Pinged through `allowed_mentions.roles`. Anything that is not a snowflake is ignored. */
  mentionRoleId?: string;
}

export interface ForumClientOptions {
  /** A webhook URL accepted by {@link parseWebhookUrl}. */
  webhookUrl: string;
  /** The `fetch` to POST with. Default: the global one. */
  fetch?: typeof fetch;
  /** Where failures are logged. Defaults to `console.warn`. */
  logger?: Logger;
  /** Jitter source in [0, 1). Default `Math.random`. */
  random?: () => number;
}

export interface ForumClient {
  /** Open a forum thread whose first message is `message`. The thread id, or null when it could not be opened. */
  openThread(name: string, message: ForumMessage): Promise<{ threadId: string } | null>;
  /** Post into a thread. `{ gone: true }` when Discord says the thread no longer exists; null when it failed. */
  post(threadId: string, message: ForumMessage): Promise<{ ok: true } | { gone: true } | null>;
  /** Abort the request in flight, wake every wait, and answer all pending and later calls with null. Safe to call twice. */
  dispose(): void;
}

type Json = Record<string, unknown> | null;

type Attempt =
  | { kind: 'ok'; json: Json }
  | { kind: 'final'; status: number; json: Json }
  | { kind: 'retry'; status?: number; error?: string; afterMs?: number };

type Outcome = { kind: 'ok'; json: Json } | { kind: 'final'; status: number; json: Json } | { kind: 'failed' };

const parseJson = (text: string): Json => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const clampRetryAfter = (ms: number): number => Math.min(Math.max(ms, RETRY_AFTER_FLOOR_MS), RETRY_AFTER_CAP_MS);

/** How long a 429 asks us to wait: the JSON `retry_after` (seconds, may be a float), else the `retry-after` header. */
function retryAfterMs(json: Json, header: string | null): number | undefined {
  const fromBody = json?.retry_after;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody)) return clampRetryAfter(fromBody * 1000);
  if (header !== null && /^\d{1,9}(\.\d{1,6})?$/.test(header.trim())) return clampRetryAfter(Number(header) * 1000);
  return undefined;
}

export function makeForumClient(options: ForumClientOptions): ForumClient {
  const base = parseWebhookUrl(options.webhookUrl);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const random = options.random ?? Math.random;
  const { logger } = options;

  let disposed = false;
  let tail: Promise<unknown> = Promise.resolve();
  const timers = new Set<{ timer: ReturnType<typeof setTimeout>; wake: () => void }>();
  const aborts = new Set<AbortController>();

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

  const attempt = async (target: string, payload: string): Promise<Attempt> => {
    const controller = new AbortController();
    aborts.add(controller);
    const timeout = setTimeout(() => controller.abort(new DOMException('The attempt timed out.', 'TimeoutError')), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetchFn(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        redirect: 'manual',
        signal: controller.signal,
      });
      const status = res.status;
      let json: Json = null;
      try {
        json = parseJson(await res.text());
      } catch (err) {
        if (controller.signal.aborted) throw err;
      }
      if (status >= 200 && status < 300) return { kind: 'ok', json };
      if (status === 429) {
        const wait = retryAfterMs(json, res.headers.get('retry-after'));
        return { kind: 'retry', status, ...(wait === undefined ? {} : { afterMs: wait }) };
      }
      if (status >= 500) return { kind: 'retry', status };
      return { kind: 'final', status, json };
    } catch (err) {
      return { kind: 'retry', error: errorClass(err) };
    } finally {
      clearTimeout(timeout);
      aborts.delete(controller);
    }
  };

  /** One request with its retries. Logs a failure once, at the end. */
  const send = async (op: string, target: string, payload: Record<string, unknown>): Promise<Outcome> => {
    const body = JSON.stringify(payload);
    for (let tried = 1; ; tried++) {
      const result = await attempt(target, body);
      // An answer that arrived is kept even if dispose() came right behind it: dropping a created thread's id would open a second one.
      if (result.kind === 'ok') return result;
      if (disposed) return { kind: 'failed' };
      if (result.kind === 'final') return result;
      if (tried > MAX_RETRIES) {
        safeWarn(logger, 'chatwarden.discord_failed', {
          op,
          ...(result.status === undefined ? {} : { status: result.status }),
          ...(result.error === undefined ? {} : { error: result.error }),
          attempts: tried,
        });
        return { kind: 'failed' };
      }
      await sleep(result.afterMs ?? backoff(tried - 1));
      if (disposed) return { kind: 'failed' };
    }
  };

  /** Requests run one at a time, in order: a webhook's rate limit is shared by everything sent through it. */
  const serial = <T>(work: () => Promise<T>, whenDisposed: T): Promise<T> => {
    const run = tail.then(() => (disposed ? whenDisposed : work()));
    tail = run.catch(() => undefined);
    return run.catch(() => whenDisposed);
  };

  const urlFor = (threadId?: string): string => {
    const u = new URL(base);
    u.searchParams.set('wait', 'true');
    if (threadId !== undefined) u.searchParams.set('thread_id', threadId);
    return u.toString();
  };

  const payloadOf = (message: ForumMessage, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...extra,
    content: cutText(String(message.content), CONTENT_MAX),
    // Nothing the adopter or a rule title wrote can ping anyone; only the one configured role, on a severe post.
    allowed_mentions: isSnowflake(message.mentionRoleId) ? { parse: [], roles: [message.mentionRoleId] } : { parse: [] },
    flags: SUPPRESS_EMBEDS,
  });

  const failLog = (op: string, error: string): void => {
    safeWarn(logger, 'chatwarden.discord_failed', { op, error, attempts: 1 });
  };

  return {
    openThread: (name, message) =>
      serial<{ threadId: string } | null>(async () => {
        const out = await send('openThread', urlFor(), payloadOf(message, { thread_name: cutText(name, THREAD_NAME_MAX) }));
        if (out.kind === 'final') {
          safeWarn(logger, 'chatwarden.discord_failed', { op: 'openThread', status: out.status, attempts: 1 });
          return null;
        }
        if (out.kind !== 'ok') return null;
        const threadId = out.json?.channel_id;
        if (typeof threadId !== 'string' || threadId === '') {
          failLog('openThread', 'bad_response');
          return null;
        }
        return { threadId };
      }, null),

    post: (threadId, message) =>
      serial<{ ok: true } | { gone: true } | null>(async () => {
        const out = await send('post', urlFor(threadId), payloadOf(message));
        if (out.kind === 'ok') return { ok: true };
        if (out.kind === 'failed') return null;
        const code = out.json?.code;
        // A 404 with another Discord code (10015: the webhook itself is gone) is not a deleted thread.
        if (code === UNKNOWN_CHANNEL || (out.status === 404 && (code === undefined || code === null))) return { gone: true };
        safeWarn(logger, 'chatwarden.discord_failed', { op: 'post', status: out.status, attempts: 1 });
        return null;
      }, null),

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
    },
  };
}
