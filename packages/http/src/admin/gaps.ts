import type { GapRow } from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { bodyObject, has } from './validate.js';

/** What a gap may be closed as: any status but `open`. */
const CLOSE_STATUSES: readonly Exclude<GapRow['status'], 'open'>[] = ['ruled', 'not_a_rule'];

/**
 * Rule gaps (staff only):
 * - `GET /gaps`: every gap, newest first (`gaps.read`). It names no person. Writes no audit row.
 * - `POST /gaps/:groupId/close { status, ref }`: close one (`gaps.close`). `status` is `ruled` or `not_a_rule`. `ruled`
 *   needs `ref`, the number of an active Community Rule (the rule that now covers it), else 400 `invalid_gap_ref`;
 *   `not_a_rule` takes a null or absent `ref`. The core writes the `gap.close` audit row itself, so this route does not.
 */
export function gapRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'GET /gaps': ctx.secure('gaps.read', () => ({ status: 200, body: { items: cw.gaps.list() } })),

    'POST /gaps/:groupId/close': ctx.secure('gaps.close', (c) => {
      const groupId = c.params.groupId as string;
      const body = bodyObject(c.req);
      const status = body.status;
      if (typeof status !== 'string' || !(CLOSE_STATUSES as readonly string[]).includes(status)) throw new ValidationError();
      const ref = has(body, 'ref') ? body.ref : null;
      let stored: string | null = null;
      if (status === 'ruled') {
        if (typeof ref !== 'number' || !Number.isSafeInteger(ref) || !cw.rules.isCitable(ref)) throw new HttpError('invalid_gap_ref');
        stored = String(ref);
      } else if (ref !== null) {
        throw new HttpError('invalid_gap_ref');
      }
      // False: no such group, no gap on it, or it is closed already.
      if (!cw.gaps.close(groupId, status as 'ruled' | 'not_a_rule', stored, c.authz.actor)) throw new NotFoundError();
      return { status: 200, body: { ok: true } };
    }),
  };
}
