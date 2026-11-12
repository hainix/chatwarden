import { HttpError, NotFoundError } from '../errors.js';
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
 *   changed (no call is made), 202 `{ status: 'pending' }` when a read is queued, 409 `ai_off` (level 0, no adapter, or the report is
 *   decided), 429 `ai_budget` (the daily cap) or 429 `rate_limited` (10 a minute per actor). 404 for an unknown report.
 * - `POST /reports/:id/ai/dont-teach` (`reasons.write`, a senior's): the decided report's casebook row can never teach again. 200
 *   `{ ok: true }`, 404 when the report is unknown or has no casebook row (it was not decided with the AI on). Audited `ai.outcome`.
 */
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
      load(id);
      // Nothing to ask for: no row is written for a request that did nothing.
      if (cw.ai.level() === 0) throw new HttpError('ai_off');
      // The row first, in `required` mode: a call the trail cannot record is not made (it spends money).
      c.audit('ai.rerun', { type: 'report', ref: id });
      const answer = await cw.ai.readAgain(id, c.authz.actor);
      if (answer === 'off') throw new HttpError('ai_off');
      if (answer === 'budget') throw new HttpError('ai_budget');
      if (answer === 'rate') throw new HttpError('rate_limited', { 'retry-after': '60' });
      if (answer === 'pending') return { status: 202, body: { status: 'pending' } };
      return { status: 200, body: { status: 'ready', ai: answer } };
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
