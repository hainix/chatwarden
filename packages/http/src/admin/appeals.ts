import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import { roleAtLeast } from '../permissions.js';
import type { RouteTable } from '../router.js';
import { checkDurationsOffered } from './apply.js';
import type { AdminContext } from './context.js';
import { flagKey, handleFlags, latestHandle } from './handles.js';
import { bodyAppealDecision, bodyObject, queryAppealDays, queryAppealStatus, queryLimit } from './validate.js';

/**
 * The staff appeal routes. Every one is 404 `not_found` while appeals are off (after authentication and the permission, so a caller who
 * could not use them learns nothing either way), and every answer is `no-store`. An appeal belongs to a person: `person` is a staff ref.
 * - `GET /appeals?status=open|decided|all&cursor&limit` (`appeals.read`): the inbox, oldest first, `{ items, next }`. Each item is the core's
 *   `AppealSummary` plus `handle`, the person's name as `GET /sanctions` shows it (null without `history.read`, or when no report recorded one),
 *   and `handleFlagged: true` when the matcher flags that handle and `names.maskInHub` is on (else the key is absent).
 *   `status` defaults to open; `limit` 1..200 (default 50); `cursor` is the previous `next`. A bad status, cursor or limit is 400 `invalid_query`.
 *   No statement is in a list. Audits `appeal.view` with no target; the row is required, so a read that cannot be recorded fails (500).
 * - `GET /appeals/stats?days=30|90|365` (`appeals.read`): the per-rule counts, `AppealStats`. `days` defaults to 90; any other value is 400
 *   `invalid_query`. Audits `appeal.view` with no target (required).
 * - `GET /appeals/:id` (`appeals.read`): `{ appeal }`, the `AppealDetail`: the statement (null once purged), the decision and its private reason
 *   once made, and the lines the player was shown. 404 for an unknown id. Audits `appeal.view` with the appeal as target (required).
 * - `POST /appeals/:id/decide { outcome, reason, to? }` (`appeals.decide`): `outcome` is `uphold`, `reduce` or `revoke`; `reason` is private (1 to
 *   500 characters, never echoed); `to` is `{ kind, durationMs }` and is required for `reduce` only (the lighter outcome; with `customDuration` off the length
 *   must be one the profile offers, else 400 `duration_not_offered`). 200 `{ status, replacementGroupId? }`. 409 `already_decided`, 409
 *   `same_decider` (the moderator who made the original decision may not decide its appeal unless `appeals.allowSelfReview` is on), 409 `gone`
 *   (the sanction is gone; the appeal is closed as moot), 400 for a body or a `to` the core refuses, 404 for an unknown id. The actor is the
 *   authenticated caller, never the body. Audits `appeal.decide` with the appeal as target, best-effort, after the write.
 * A literal segment beats a param, so `/appeals/stats` is never an appeal called `stats`.
 */
export function appealRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  const live = (): void => {
    if (!cw.appeals.enabled()) throw new NotFoundError();
  };

  return {
    'GET /appeals': ctx.secure('appeals.read', (c) => {
      live();
      const status = queryAppealStatus(c.req.query.status);
      const limit = queryLimit(c.req.query.limit);
      const { cursor } = c.req.query;
      let page: ReturnType<typeof cw.appeals.list>;
      try {
        page = cw.appeals.list({
          ...(status === undefined ? {} : { status }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch (err) {
        // The core's own checks of the cursor and the limit's range.
        if (err instanceof RangeError) throw new HttpError('invalid_query');
        throw err;
      }
      // The name to show for the person, one read per person on the page, for a caller who may read people's histories only.
      const mayReadHandles = roleAtLeast(c.authz.role, ctx.permissions['history.read']);
      const handles = new Map<string, string | null>();
      const handleOf = (person: string): string | null => {
        if (!mayReadHandles) return null;
        if (!handles.has(person)) handles.set(person, latestHandle(cw, person));
        return handles.get(person) ?? null;
      };
      const flagged = handleFlags(cw);
      const items = page.items.map((i) => ({ ...i, handle: handleOf(i.person), ...flagKey(flagged, 'handleFlagged', handleOf(i.person)) }));
      c.audit('appeal.view');
      return { status: 200, body: { items, next: page.next } };
    }),

    'GET /appeals/stats': ctx.secure('appeals.read', (c) => {
      live();
      const days = queryAppealDays(c.req.query.days);
      const stats = cw.appeals.stats(days === undefined ? {} : { days });
      c.audit('appeal.view');
      return { status: 200, body: stats };
    }),

    'GET /appeals/:id': ctx.secure('appeals.read', (c) => {
      live();
      const id = c.params.id as string;
      const appeal = cw.appeals.get(id);
      if (appeal === null) throw new NotFoundError();
      c.audit('appeal.view', { type: 'appeal', ref: id });
      return { status: 200, body: { appeal } };
    }),

    'POST /appeals/:id/decide': ctx.secure('appeals.decide', async (c) => {
      live();
      const id = c.params.id as string;
      const ruling = bodyAppealDecision(bodyObject(c.req));
      // A reduction is a new sanction: with customDuration off its length must be one the profile offers, as for any sanction.
      if (ruling.to !== undefined) checkDurationsOffered(cw, [{ subject: id, kind: ruling.to.kind, durationMs: ruling.to.durationMs, rule: 'uncovered' }]);
      // The actor is the authenticated caller, never from the body.
      const res = await cw.appeals.decide({ appealId: id, actor: c.authz.actor, ...ruling });
      if (!res.ok) {
        if (res.error === 'not_found') throw new NotFoundError();
        if (res.error === 'invalid') throw new ValidationError();
        // already_decided, same_decider and gone have their own codes.
        throw new HttpError(res.error);
      }
      // The decision is written: an audit failure is logged, never turned into an error.
      c.audit('appeal.decide', { type: 'appeal', ref: id }, 'best-effort');
      return { status: 200, body: { status: res.status, ...(res.replacementGroupId === undefined ? {} : { replacementGroupId: res.replacementGroupId }) } };
    }),
  };
}
