import type { AiReadView } from '@chatwarden/core';
import { AiUnavailableError, HttpError, NotFoundError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';

/**
 * The AI routes (staff only, each audited). The level itself moves through `PUT /policy/profile` with `layer.ai`; nothing here
 * changes a setting.
 * - `GET /ai/status` (`policy.read`, audited as `policy.view`): `{ available, level, maxLevel, state, spentMicros, capMicros, day, reads,
 *   cacheHitRate, invalid, learn, stats }`. `state` is `ok`, `paused_budget`, `unavailable` or `off`; `level` is the effective level (the
 *   hub's setting held to the code's `maxLevel`; 0 without an adapter, where `available` is false); `invalid` counts answers core refused by
 *   code since the process started; `stats` is the casebook (`cw.ai.stats()`): totals, rates and a row per rule.
 * - `POST /reports/:id/ai/read` (`reports.decide`, audited `ai.rerun`): "read again". 200 `{ status: 'ready', ai }` when the input has not
 *   changed (no call is made), 202 `{ status: 'pending' }` when a read is queued (a read that ended without an answer is retaken once by an
 *   explicit ask, charged to the spend), 409 `ai_off` (level 0, no adapter, or the report is decided; no audit row), 409 `ai_final` (the
 *   read for this input ended without an answer and was already retaken once: nothing more to try), 429 `ai_budget` (the daily money or
 *   call cap), 429 `rate_limited` (10 a minute per actor, counted per process) or 503 `ai_unavailable` with `retryAfterMs` (the breaker is
 *   open, or the minute's calls are used). 404 for an unknown report. Every answer after `ai_off` leaves its `ai.rerun` row, written first
 *   because the ask can spend money, so a limited click is still one row; a `ready` answer counts as an ask for the limit.
 * - `POST /reports/:id/ai/dont-teach` (`reasons.write`, a senior's): the decided report's casebook row can never teach again. 200
 *   `{ ok: true }`, 404 when the report is unknown or has no casebook row (it was not decided with the AI on). Audited `ai.outcome`.
 */
/** What `POST /reports/:id/ai/read` answers with 200 or 202. */
export type AiReadAgainBody = { status: 'ready'; ai: AiReadView } | { status: 'pending' };

/** The body of a 503 `ai_unavailable`: the fixed error body and how long to wait, in milliseconds. */
export interface AiUnavailableBody {
  error: 'ai_unavailable';
  message: string;
  retryAfterMs: number;
}

export function aiRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;

  const load = (id: string): void => {
    if (cw.reports.get(id) === null) throw new NotFoundError();
  };

  return {
    'GET /ai/status': ctx.secure('policy.read', (c) => {
      const status = cw.ai.status();
      const stats = cw.ai.stats();
      c.audit('policy.view');
      return { status: 200, body: { ...status, learn: cw.profile.ai.learn, stats } };
    }),

    'POST /reports/:id/ai/read': ctx.secure('reports.decide', async (c) => {
      const id = c.params.id as string;
      const report = cw.reports.get(id);
      if (report === null) throw new NotFoundError();
      // Nothing to ask for: no row is written for a request that did nothing.
      if (cw.ai.level() === 0 || report.status !== 'open') throw new HttpError('ai_off');
      // The row first, in `required` mode: a call the trail cannot record is not made (it spends money).
      c.audit('ai.rerun', { type: 'report', ref: id });
      const answer = await cw.ai.readAgain(id, c.authz.actor);
      if (answer === 'off') throw new HttpError('ai_off');
      if (answer === 'budget') throw new HttpError('ai_budget');
      if (answer === 'rate') throw new HttpError('rate_limited', { 'retry-after': '60' });
      if (answer === 'final') throw new HttpError('ai_final');
      if (answer === 'pending') return { status: 202, body: { status: 'pending' } satisfies AiReadAgainBody };
      if ('unavailable' in answer) throw new AiUnavailableError(answer.unavailable.retryAfterMs);
      return { status: 200, body: { status: 'ready', ai: answer } satisfies AiReadAgainBody };
    }),

    'POST /reports/:id/ai/dont-teach': ctx.secure('reasons.write', (c) => {
      const id = c.params.id as string;
      load(id);
      if (!cw.ai.dontTeach(id)) throw new NotFoundError();
      // The mark is written: an audit failure is logged, never turned into an error.
      c.audit('ai.outcome', { type: 'report', ref: id }, 'best-effort');
      return { status: 200, body: { ok: true } };
    }),
  };
}
