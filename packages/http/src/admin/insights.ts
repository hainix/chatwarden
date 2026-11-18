import { HttpError, NotFoundError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';

/** A query `days`: absent is 30; otherwise exactly `7`, `30` or `90`, else 400 `invalid_query`. */
function queryDays(raw: string | undefined): 7 | 30 | 90 {
  if (raw === undefined) return 30;
  if (raw === '7') return 7;
  if (raw === '30') return 30;
  if (raw === '90') return 90;
  throw new HttpError('invalid_query');
}

/**
 * The Insights route (0.2.0), behind `desk.insights`: with it off the route answers 404 like any route that is not there.
 *
 * - `GET /insights?days=7|30|90` (`insights.read`, a moderator's by default; 30 days by default, any other value 400 `invalid_query`): how the team is doing over the window, from rows the
 *   kit already holds plus the daily line counter: `{ days, from, to, reports: { filed, decided, open }, decision: { decided, medianMs, p90Ms }, urgent: { filed, decided, medianMs }, wait: {
 *   longestOpenMs, backlog }, byReason, byOutcome, byRule, chat, partial }`. Counts and times only: no person, handle, text or staff member, and no per-person number (a median and a longest
 *   wait together, on purpose). `medianMs` and `p90Ms` are `null` below five decided reports (`urgent.medianMs` below three); `chat` is `null` when no line was counted in the window.
 *   Audited `insights.view` with no target, best-effort after the read. `no-store`.
 */
export function insightRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'GET /insights': ctx.secure('insights.read', (c) => {
      if (!cw.insights.enabled()) throw new NotFoundError();
      const days = queryDays(c.req.query.days);
      const result = cw.insights.read(days);
      // Switched off between the check and the read: the same 404.
      if (result === null) throw new NotFoundError();
      c.audit('insights.view', undefined, 'best-effort');
      return { status: 200, body: result };
    }),
  };
}
