import { SANCTION_SOURCES } from '@chatwarden/core';
import type { Source } from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import { applySanction, needForSanction, parseSanction } from './apply.js';
import { gateCase } from './claims.js';
import type { AdminContext } from './context.js';
import { bodyObject, bodyTakeOver, bodyText, queryLimit } from './validate.js';

/**
 * Sanctions outside a report (staff only, each audited after it succeeds):
 * - `GET /sanctions?cursor&limit&source`: every person's sanctions, newest first, `{ items, next }` (`history.read`). Each
 *   item is the group's `SanctionGroupView` plus `person`, the canonical subject (a staff ref). Built from the subject row
 *   only: never an IP row, hash or stored value. `limit` 1..200 (default 50, clamped), `cursor` is the previous `next`,
 *   `source` one of the sanction sources. A bad cursor, limit or source is 400 `invalid_query`. Writes no audit row.
 * - `POST /sanctions { subject, kind, durationMs, rule, gapNote?, includeIp?, reason?, takeOver? }`: apply one (`sanctions.apply`,
 *   and `sanctions.apply.ban_permanent` for a ban with `durationMs: null`). The actor is the authz actor and the source is
 *   always `moderator`. Audits `sanction.apply` with the group id. Another moderator's live claim on the person is 409
 *   `claimed` unless `takeOver: true` and the caller holds `claims.override` (audited as `case.takeover`, first); the claim then
 *   stays with the caller. Revoking is never held up by a claim.
 * - `POST /sanctions/:groupId/revoke { reason }`: revoke the whole group (`sanctions.revoke`). Audits `sanction.revoke`.
 * `durationMs` is required: a whole number of milliseconds up to the 365 day cap, or an explicit `null` (permanent).
 */
export function sanctionRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'GET /sanctions': ctx.secure('history.read', (c) => {
      const { cursor, source } = c.req.query;
      const limit = queryLimit(c.req.query.limit);
      // Checked here as well as in the core, so a source is a 400 whatever the facade does with an odd value.
      if (source !== undefined && !(SANCTION_SOURCES as readonly string[]).includes(source)) throw new HttpError('invalid_query');
      // The facade checks the cursor (SanctionQueryError -> 400) and clamps the limit.
      const page = cw.sanctions.list({
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(source === undefined ? {} : { source: source as Source }),
      });
      return { status: 200, body: { items: page.items, next: page.next } };
    }),

    'POST /sanctions': ctx.secure('sanctions.apply', async (c) => {
      const body = bodyObject(c.req);
      const sanction = parseSanction(body);
      const takeOver = bodyTakeOver(body);
      needForSanction(sanction.action, c.need);
      gateCase(ctx, c, sanction.action.subject, takeOver);
      // The actor is never from the body: the caller is who the auth hook says, and an admin route is always a moderator's.
      const done = await applySanction(cw, sanction, c.authz.actor);
      // The sanction is live: an audit failure is logged, never turned into an error.
      c.audit('sanction.apply', { type: 'sanction', ref: done.groupId }, 'best-effort');
      return { status: 200, body: { groupId: done.groupId, refCode: done.refCode } };
    }),

    'POST /sanctions/:groupId/revoke': ctx.secure('sanctions.revoke', async (c) => {
      const groupId = c.params.groupId as string;
      const body = bodyObject(c.req);
      const reason = bodyText(body.reason);
      if (reason.trim() === '') throw new ValidationError();
      // False: no such group, or it was revoked already.
      if (!(await cw.sanctions.revoke(groupId, c.authz.actor, reason))) throw new NotFoundError();
      c.audit('sanction.revoke', { type: 'sanction', ref: groupId }, 'best-effort');
      return { status: 200, body: { ok: true } };
    }),
  };
}
