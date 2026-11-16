import { errorClass, safeWarn } from '@chatwarden/core';
import type { Clock, Logger } from '@chatwarden/core';
import { discardBody, readBoundedText } from '../internal/boundedText.js';

// The EOS client-credentials token (K5 design 9.3, "Token"). `POST {baseUrl}/auth/v1/oauth/token` with `Authorization: Basic base64(clientId:clientSecret)` and the form body
// `grant_type=client_credentials&deployment_id=...` (https://dev.epicgames.com/docs/web-api-ref/connect-web-api). The answer's `access_token` is held in memory until 60 s before
// `expires_in` runs out; callers that ask while a request is out share it. The secret goes into the header for each request and is never kept, logged or put in an error;
// the token is never logged either. A failure is logged as an operation, an HTTP status or an error class, and nothing else.

/** The token request failed. The message is fixed: it never holds a status text, a body, a token or a secret. */
export class TokenError extends Error {
  /** The HTTP status the token endpoint answered, when it answered. */
  status: number | undefined;
  /** A 429's `retry-after`, in milliseconds. */
  retryAfterMs: number | undefined;
  constructor(status?: number, retryAfterMs?: number) {
    super('EOS token request failed');
    this.name = 'TokenError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface TokenSource {
  /** A valid access token: the cached one, the one being fetched, or a new one. Rejects with {@link TokenError}. */
  get(): Promise<string>;
  /** Forget the token (it was refused): the next `get` asks again. */
  invalidate(): void;
  /** Abort a request in flight and refuse every later `get`. Safe to call more than once. */
  dispose(): void;
}

export interface TokenSourceOptions {
  clientId: string;
  clientSecret: string;
  deploymentId: string;
  /** No trailing slash. */
  baseUrl: string;
  fetch: typeof fetch;
  clock: Clock;
  logger?: Logger | undefined;
}

/** The token is dropped this long before it expires. */
export const TOKEN_MARGIN_MS = 60_000;
/** The token request is aborted after this long. */
export const TOKEN_TIMEOUT_MS = 10_000;
/** The most of the token answer that is read. */
const ANSWER_MAX = 16_384;
/** A token is kept at most this long, whatever `expires_in` says. */
const KEEP_MAX_MS = 24 * 3_600_000;
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;

/** A `retry-after` header in whole seconds as milliseconds; undefined for anything else (a date, a negative, junk, a huge number). */
export function retryAfterOf(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (v === null || !/^\d{1,6}$/.test(v.trim())) return undefined;
  return Number(v.trim()) * 1000;
}

/** Make a token source. Nothing runs until the first `get`. */
export function createTokenSource(o: TokenSourceOptions): TokenSource {
  let cached: { token: string; until: number } | null = null;
  let inflight: Promise<string> | null = null;
  let disposed = false;
  let controller: AbortController | null = null;

  const fail = (detail: { status?: number; error?: string }): void => safeWarn(o.logger, 'chatwarden.eos_failed', { op: 'token', ...detail });

  const request = async (): Promise<string> => {
    if (disposed) throw new TokenError();
    const ctl = new AbortController();
    controller = ctl;
    const timer = setTimeout(() => ctl.abort(new DOMException('The token request timed out.', 'TimeoutError')), TOKEN_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    try {
      let res: Response;
      try {
        res = await o.fetch(`${o.baseUrl}/auth/v1/oauth/token`, {
          method: 'POST',
          headers: {
            // Built here, for this request only.
            Authorization: `Basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({ grant_type: 'client_credentials', deployment_id: o.deploymentId }).toString(),
          redirect: 'manual',
          signal: ctl.signal,
        });
      } catch (err) {
        fail({ error: errorClass(err) });
        throw new TokenError();
      }
      if (res.status < 200 || res.status >= 300) {
        discardBody(res);
        fail({ status: res.status });
        throw new TokenError(res.status, res.status === 429 ? retryAfterOf(res) : undefined);
      }
      let parsed: unknown;
      try {
        const text = await readBoundedText(res, ANSWER_MAX);
        parsed = text === null ? undefined : JSON.parse(text);
      } catch (err) {
        // A body that cannot be read is a network failure; one that is not JSON is a bad answer.
        fail({ error: err instanceof SyntaxError ? 'BadAnswer' : errorClass(err) });
        throw new TokenError();
      }
      const body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      const token = body?.['access_token'];
      const life = body?.['expires_in'];
      if (typeof token !== 'string' || !TOKEN_RE.test(token) || typeof life !== 'number' || !Number.isFinite(life) || life <= 0) {
        fail({ error: 'BadAnswer' });
        throw new TokenError();
      }
      if (disposed) throw new TokenError();
      const keep = Math.min(life * 1000, KEEP_MAX_MS) - TOKEN_MARGIN_MS;
      cached = keep > 0 ? { token, until: o.clock.now() + keep } : null;
      return token;
    } finally {
      clearTimeout(timer);
      if (controller === ctl) controller = null;
    }
  };

  return {
    get() {
      if (disposed) return Promise.reject(new TokenError());
      if (cached !== null && o.clock.now() < cached.until) return Promise.resolve(cached.token);
      inflight ??= request().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate() {
      cached = null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cached = null;
      controller?.abort();
    },
  };
}
