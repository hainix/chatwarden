import type { Chatwarden } from '@chatwarden/core';
import type { RouteTable } from '../router.js';
import { createAdminContext } from './context.js';
import type { AdminOptions } from './context.js';
import { reportRoutes } from './reports.js';

export { AuditFailedError, BadActorError, createAdminContext } from './context.js';
export type { AdminCall, AdminContext, AdminOptions } from './context.js';
export { reportRoutes } from './reports.js';

/**
 * The staff API as a route table: hand it to `createRouter` (alone, or spread beside your own routes). Every route is
 * authenticated by `options.authorize`, needs a permission, and writes its audit row. Later route groups (sanctions,
 * gaps, terms, policy, audit) join this table through the same `createAdminContext`, so there is one auth and audit path.
 */
export function adminRoutes(cw: Chatwarden, options: AdminOptions): RouteTable {
  const ctx = createAdminContext(cw, options);
  return { ...reportRoutes(ctx) };
}
