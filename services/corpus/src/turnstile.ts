import type { LogEvent } from './deps.js';

// Cloudflare Turnstile, server side: the docs-site report form proves a person is there by a token, and the service asks Cloudflare whether it
// is good. Fail closed: anything but a clear `success: true` (an error, a timeout, a body that is not JSON, a wrong site) is a no. The visitor's
// address is not sent to Cloudflare, and neither the token nor the secret is logged or kept.

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TOKEN_MAX = 2048;
const TIMEOUT_MS = 5000;
const ANSWER_MAX = 8192;

export interface TurnstileConfig {
  /** The widget's secret key (a Worker secret). */
  secret: string;
  /** When set, the token must have been solved on this host (the docs site). */
  hostname?: string;
  /** The network (default global `fetch`). */
  fetch?: typeof fetch;
}

/** Whether `token` is a good Turnstile token for this site. Never throws. */
export async function verifyTurnstile(config: TurnstileConfig, token: string, log?: (event: LogEvent) => void): Promise<boolean> {
  const note = (code: string): void => {
    try {
      log?.({ stage: 'turnstile', code });
    } catch {
      // a logger that throws must not break a request
    }
  };
  try {
    const res = await (config.fetch ?? globalThis.fetch)(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: config.secret, response: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
      credentials: 'omit',
    });
    if (!res.ok) {
      note('unavailable');
      return false;
    }
    const text = await res.text();
    if (text.length > ANSWER_MAX) {
      note('unavailable');
      return false;
    }
    const body: unknown = JSON.parse(text);
    if (body === null || typeof body !== 'object') {
      note('unavailable');
      return false;
    }
    const answer = body as { success?: unknown; hostname?: unknown };
    if (answer.success !== true) {
      note('refused');
      return false;
    }
    if (config.hostname !== undefined && answer.hostname !== config.hostname) {
      note('hostname');
      return false;
    }
    return true;
  } catch {
    note('unavailable');
    return false;
  }
}
