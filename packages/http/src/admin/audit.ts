import type { AuditAction } from '@chatwarden/core';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { queryLimit } from './validate.js';

/** How many rows a page holds when `limit` is absent. */
const AUDIT_PAGE_DEFAULT = 50;

/**
 * `GET /audit?cursor&limit&actor&action` (`audit.read`, senior by default): one page of the staff audit trail, newest
 * first, `{ items, next }`. The rows hold ids and action names only. Reading the trail writes no row of its own. A bad
 * `limit` (not a whole number from 1 to 200), `cursor`, `actor` or `action` is 400.
 */
export function auditRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'GET /audit': ctx.secure('audit.read', (c) => {
      const { cursor, actor, action } = c.req.query;
      const page = cw.audit.list({
        limit: queryLimit(c.req.query.limit) ?? AUDIT_PAGE_DEFAULT,
        ...(cursor === undefined ? {} : { before: cursor }),
        ...(actor === undefined ? {} : { actor }),
        // The core checks the action against its closed list (AuditQueryError -> 400).
        ...(action === undefined ? {} : { action: action as AuditAction }),
      });
      return { status: 200, body: page };
    }),
  };
}
