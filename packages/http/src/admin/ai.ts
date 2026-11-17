import type { AiActingError, AiActingResult, AiReadView } from '@chatwarden/core';
import { AiUnavailableError, HttpError, NotFoundError } from '../errors.js';
import type { ErrorCode } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminCall, AdminContext } from './context.js';
import { bodyActing, bodyObject } from './validate.js';

/** Each refusal of an acting step, as the fixed error code it is answered with. */
const ACTING_ERROR: Readonly<Record<AiActingError, ErrorCode>> = {
  invalid: 'invalid_request',
  unsupported: 'acting_unavailable',
  no_appeals: 'no_appeals',
  not_allowed: 'ai_level',
  too_early: 'too_early',
  wrong_state: 'wrong_state',
};

/** What `POST /reports/:id/ai/read` answers with 200 or 202. */
export type AiReadAgainBody = { status: 'ready'; ai: AiReadView } | { status: 'pending' };

/** The body of a 503 `ai_unavailable`: the fixed error body and how long to wait, in milliseconds. */
export interface AiUnavailableBody {
  error: 'ai_unavailable';
  message: string;
  retryAfterMs: number;
}

/**
 * The AI routes (staff only, each audited). The level itself moves through `PUT /policy/profile` with `layer.ai`; nothing here
 * changes a setting.
 * - `GET /ai/status` (`policy.read`, audited as `policy.view`): `{ available, level, maxLevel, state, spentMicros, capMicros, day, reads,
 *   cacheHitRate, invalid, learn, stats }`. `state` is `ok`, `paused_budget`, `unavailable` or `off`; `level` is the effective level (the
 *   hub's setting held to the code's `maxLevel`; 0 without an adapter, where `available` is false); `invalid` counts answers core refused by
 *   code since the process started; `stats` is the casebook (`cw.ai.stats()`): totals, rates and a row per rule.
 * - `GET /ai/gates` (`policy.read`, audited as `policy.view`, `@experimental`): the gate dashboard's data, `cw.ai.gates()` as it is: a row per rule and conduct level
 *   the profile could ever act on, with each gate's number against its need and whether the cell is open, the reach preview, the counts and the appeals facts.
 *   Read-only and computed on the server from the store and the clock (no query or body can supply a number); no id, no text and no staff ref. `actingAvailable`
 *   is false in this release: nothing here lets the AI act.
 * - `GET /ai/acting` (`policy.read`, audited as `policy.view`, `@experimental`): where acting stands, `{ mode, paused, modeSince, shadowDaysDone, shadowWouldHaveActed, maxLevel }`: numbers,
 *   words and booleans, no staff ref. `off` with no AI.
 * - `POST /ai/acting/shadow|start|resume|off` (the OWNER's, fixed in code: the `permissions` option cannot lower them; `@experimental`) and `POST /ai/acting/pause` (`ai.pause`, a senior's,
 *   lowerable). Bodies: `shadow` and `start` `{ confirm: 'ACT', reason }` (`shadow` from acting needs no word), the rest `{ reason }`; any other key is 400 `forbidden_key`, the actor is the
 *   caller. 200 with the new state, or 409 `wrong_state` (not a state this step starts from, or another process moved it first), `too_early` (shadow has not run its days), `no_appeals`,
 *   `ai_level` (the hub's level is below 2), `acting_unavailable` (no AI, `maxLevel` below 3, `ai.act.enabled: false`, or a store that cannot keep the state), 400 `invalid_request` (a
 *   wrong word, a missing reason). Each transition leaves one `ai.acting` audit row (the sections `['ai']` and the reason; best-effort, after the write); a refusal leaves none. In this
 *   release nothing that acting leads to writes a sanction.
 * - `POST /reports/:id/ai/read` (`reports.decide`, audited `ai.rerun`): "read again". 200 `{ status: 'ready', ai }` when the input has not
 *   changed (no call is made), 202 `{ status: 'pending' }` when a read is queued (a read that ended without an answer is retaken once by an
 *   explicit ask, charged to the spend; a read still waiting for its own retry is not retaken, it keeps its time), 409 `ai_off` (level 0, no adapter, or the report is decided; no audit row), 409 `ai_final` (the
 *   read for this input ended without an answer and was already retaken once: nothing more to try), 429 `ai_budget` (the daily money or
 *   call cap), 429 `rate_limited` (10 a minute per actor, counted per process) or 503 `ai_unavailable` with `retryAfterMs` (the breaker is
 *   open, or the minute's calls are used). 404 for an unknown report. Every answer after `ai_off` leaves its `ai.rerun` row, written first
 *   because the ask can spend money, so a limited click is still one row; a `ready` answer counts as an ask for the limit.
 * - `POST /reports/:id/ai/dont-teach` (`reasons.write`, a senior's): the decided report's casebook row can never teach again. 200
 *   `{ ok: true }`, 404 when the report is unknown or has no casebook row (it was not decided with the AI on). Audited `ai.outcome`.
 */
export function aiRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;

  const load = (id: string): void => {
    if (cw.reports.get(id) === null) throw new NotFoundError();
  };

  /** The route for one acting step: the owner's (fixed) or a lowerable permission's, the body checked after the caller is. */
  const step = (kind: 'shadow' | 'start' | 'pause' | 'resume' | 'off'): ReturnType<AdminContext['secure']> =>
    ctx.secure(kind === 'pause' ? 'ai.pause' : 'policy.read', (c: AdminCall) => {
      // The owner's steps are compared in code, so no `permissions` override can lower them (design 6.6, "owner (fixed)").
      if (kind !== 'pause' && c.authz.role !== 'owner') throw new HttpError('forbidden');
      const body = bodyActing(bodyObject(c.req), kind === 'shadow' || kind === 'start');
      const res = runStep(kind, c.authz.actor, body);
      if (!res.ok) throw new HttpError(ACTING_ERROR[res.error]);
      // The state is written: an audit failure is logged, never turned into an error (a pause must not fail on the trail).
      c.audit('ai.acting', undefined, 'best-effort', { sections: ['ai'], reason: body.reason.trim() });
      return { status: 200, body: res.state };
    });
  const runStep = (kind: 'shadow' | 'start' | 'pause' | 'resume' | 'off', actor: string, body: { confirm?: string; reason: string }): AiActingResult => {
    const a = cw.ai.acting;
    switch (kind) {
      case 'shadow':
        return a.startShadow(actor, { ...(body.confirm === undefined ? {} : { confirm: body.confirm }), reason: body.reason });
      case 'start':
        return a.startActing(actor, { confirm: body.confirm as string, reason: body.reason });
      case 'pause':
        return a.pause(actor, { reason: body.reason });
      case 'resume':
        return a.resume(actor, { reason: body.reason });
      default:
        return a.off(actor, { reason: body.reason });
    }
  };

  return {
    'GET /ai/acting': ctx.secure('policy.read', (c) => {
      const state = cw.ai.acting.state();
      c.audit('policy.view');
      return { status: 200, body: state };
    }),
    'POST /ai/acting/shadow': step('shadow'),
    'POST /ai/acting/start': step('start'),
    'POST /ai/acting/pause': step('pause'),
    'POST /ai/acting/resume': step('resume'),
    'POST /ai/acting/off': step('off'),

    'GET /ai/status': ctx.secure('policy.read', (c) => {
      const status = cw.ai.status();
      const stats = cw.ai.stats();
      c.audit('policy.view');
      return { status: 200, body: { ...status, learn: cw.profile.ai.learn, stats } };
    }),

    'GET /ai/gates': ctx.secure('policy.read', (c) => {
      const view = cw.ai.gates();
      c.audit('policy.view');
      return { status: 200, body: view };
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
