import { errorClass, safeWarn } from '@chatwarden/core';
import type { Logger } from '@chatwarden/core';
import { TEXT, ephemeral } from './answers.js';
import type { InteractionAnswer } from './answers.js';

// Slow work (K5 design 6.5, "Deferred answers"). Discord wants the first answer within 3 seconds. The handler races its work against `respondWithinMs`:
// when the timer wins, the bot answers "deferred" at once and, when the work finishes, edits the original response once through the interaction token
// (`PATCH /webhooks/<application id>/<token>/messages/@original`). That route needs no Authorization header: the token is the credential. The token is
// kept only for the length of one call: never logged, never stored, never sent anywhere but that URL.

const FOLLOW_UP_HOST = 'https://discord.com/api/v10/webhooks';
/** What an interaction token may look like (base64url, long). Anything else is never put in a URL. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,512}$/;
/** A follow-up request is cut off after this long. */
const ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_FLOOR_MS = 1000;
const RETRY_CAP_MS = 60_000;

/** The first answer of a deferred interaction: a loading message only the clicker sees (5), or "I got it" on the message it was clicked on (6). */
export const deferred = (kind: 'message' | 'update'): { type: number; data?: { flags: number } } => (kind === 'message' ? { type: 5, data: { flags: 64 } } : { type: 6 });

type Json = Record<string, unknown> | null;

const parseJson = (text: string): Json => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** How long a 429 asks us to wait: the JSON `retry_after` (seconds, may be a float), else the `retry-after` header, else the floor; clamped to 1 to 60 s. */
function waitMs(json: Json, header: string | null): number {
  const fromBody = json?.retry_after;
  let ms = RETRY_FLOOR_MS;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody)) ms = fromBody * 1000;
  else if (header !== null && /^\d{1,9}(\.\d{1,6})?$/.test(header.trim())) ms = Number(header) * 1000;
  return Math.min(Math.max(ms, RETRY_FLOOR_MS), RETRY_CAP_MS);
}

export interface DeferralDeps {
  applicationId: string;
  withinMs: number;
  schedule: (run: () => void, ms: number) => () => void;
  fetch: typeof fetch | undefined;
  logger: Logger | undefined;
  /** Logs a failure of the work itself, by class. */
  fail: (op: string, err: unknown) => void;
}

const LATE = Symbol('late');

/** Races work against the deadline and sends the one follow-up. One per bot. */
export class Deferral {
  private disposed = false;
  private readonly cancels = new Set<() => void>();
  private readonly aborts = new Set<AbortController>();
  private readonly deps: DeferralDeps;

  constructor(deps: DeferralDeps) {
    this.deps = deps;
  }

  /**
   * The answer to give now. `work` is the real answer; `first` is what to answer if it is not ready in time (and the token is usable); `token` is
   * `body.token` as sent. A work that throws is the fixed failure text, whichever way it is delivered.
   */
  async settle(work: Promise<InteractionAnswer>, first: { type: number; data?: { flags: number } }, token: unknown): Promise<InteractionAnswer | { type: number }> {
    const safe = work.catch((err: unknown) => {
      this.deps.fail('handle', err);
      return ephemeral(TEXT.failed);
    });
    const winner = await new Promise<InteractionAnswer | typeof LATE>((resolve) => {
      const stop = this.deps.schedule(() => resolve(LATE), this.deps.withinMs);
      this.cancels.add(stop);
      void safe.then((answer) => {
        this.cancels.delete(stop);
        stop();
        resolve(answer);
      });
    });
    if (winner !== LATE) return winner;
    if (this.disposed) return first;
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      // Nothing can be sent later without a usable token, so wait for the work and answer in the same breath (Discord may have given up by then).
      safeWarn(this.deps.logger, 'chatwarden.discord_followup_failed', { reason: 'token' });
      return await safe;
    }
    void this.followUp(safe, token);
    return first;
  }

  private async followUp(work: Promise<InteractionAnswer>, token: string): Promise<void> {
    const answer = await work;
    if (this.disposed) return;
    const data = answer.data;
    const body = JSON.stringify({ content: data?.content ?? TEXT.failed, allowed_mentions: { parse: [] }, components: data?.components ?? [] });
    const url = `${FOLLOW_UP_HOST}/${this.deps.applicationId}/${token}/messages/@original`;
    try {
      let res = await this.attempt(url, body);
      if (res !== null && res.status === 429) {
        const wait = waitMs(res.json, res.retryAfter);
        if (!(await this.sleep(wait))) return;
        res = await this.attempt(url, body);
      }
      if (this.disposed) return;
      if (res === null || (res.status >= 200 && res.status < 300)) return;
      safeWarn(this.deps.logger, 'chatwarden.discord_followup_failed', { reason: 'status', status: res.status });
    } catch (err) {
      // Never the message: a fetch error can quote the URL, and the URL holds the token.
      if (!this.disposed) safeWarn(this.deps.logger, 'chatwarden.discord_followup_failed', { reason: 'error', error: errorClass(err) });
    }
  }

  /** One request. `null` when the bot was disposed meanwhile. A rejection is the caller's to log by class. */
  private async attempt(url: string, body: string): Promise<{ status: number; json: Json; retryAfter: string | null } | null> {
    const send = this.deps.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    this.aborts.add(controller);
    const timeout = setTimeout(() => controller.abort(new DOMException('The follow-up timed out.', 'TimeoutError')), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await send(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: controller.signal });
      let json: Json = null;
      if (res.status === 429) json = parseJson(await res.text());
      else void res.body?.cancel().catch(() => undefined);
      return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
    } catch (err) {
      if (this.disposed) return null;
      throw err;
    } finally {
      clearTimeout(timeout);
      this.aborts.delete(controller);
    }
  }

  /** Wait through the injected timer; false when the bot is disposed (the wait is cancelled). */
  private sleep(ms: number): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const holder: { stop?: () => void } = {};
      const cancel = this.deps.schedule(() => {
        if (holder.stop !== undefined) this.cancels.delete(holder.stop);
        resolve(!this.disposed);
      }, ms);
      // Disposing cancels the timer and wakes the wait with "no".
      holder.stop = () => {
        cancel();
        resolve(false);
      };
      this.cancels.add(holder.stop);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of this.cancels) cancel();
    this.cancels.clear();
    for (const controller of this.aborts) controller.abort();
    this.aborts.clear();
  }
}
