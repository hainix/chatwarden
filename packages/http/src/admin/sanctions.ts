import { NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { bodyObject, bodyText, has, parseAction } from './validate.js';

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
      const body = bodyObject(c.req);
      // The same checks as a decision's actions, so the two paths cannot disagree. Notice excerpts belong to a decision.
      if (has(body, 'lineIds')) throw new ValidationError();
      const action = parseAction(body);
      const reason = has(body, 'reason') ? bodyText(body.reason) : '';
      if (action.kind === 'ban' && action.durationMs === null) c.need('sanctions.apply.ban_permanent');
      if (!cw.rules.isCitable(action.rule)) throw new ValidationError();

      const done = await cw.sanctions.apply({
        kind: action.kind,
        subject: action.subject,
        includeIp: action.includeIp ?? false,
        durationMs: action.durationMs,
        reason,
        // Never from the body: the caller is who the auth hook says, and an admin route is always a moderator's.
        actor: c.authz.actor,
        source: 'moderator',
        automated: false,
        rule: action.rule,
        ...(action.gapNote === undefined ? {} : { gapNote: action.gapNote }),
      });
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
