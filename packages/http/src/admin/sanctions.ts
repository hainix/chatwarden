import { NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import { applySanction, needForSanction, parseSanction } from './apply.js';
import type { AdminContext } from './context.js';
import { bodyObject, bodyText } from './validate.js';

/**
 * Sanctions outside a report (staff only, each audited after it succeeds):
 * - `POST /sanctions { subject, kind, durationMs, rule, gapNote?, includeIp?, reason? }`: apply one (`sanctions.apply`, and
 *   `sanctions.apply.ban_permanent` for a ban with `durationMs: null`). The actor is the authz actor and the source is
 *   always `moderator`. Audits `sanction.apply` with the group id.
 * - `POST /sanctions/:groupId/revoke { reason }`: revoke the whole group (`sanctions.revoke`). Audits `sanction.revoke`.
 * `durationMs` is required: a whole number of milliseconds up to the 365 day cap, or an explicit `null` (permanent).
 */
export function sanctionRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'POST /sanctions': ctx.secure('sanctions.apply', async (c) => {
      const sanction = parseSanction(bodyObject(c.req));
      needForSanction(sanction.action, c.need);
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
