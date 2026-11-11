import type { Role } from '@chatwarden/core';
import { PERMISSION_KEYS, roleAtLeast } from '../permissions.js';
import type { PermissionKey } from '../permissions.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';

/** What `GET /me` answers: who the caller is and, for each permission, whether their role holds it. */
export interface Me {
  actor: string;
  role: Role;
  can: Record<PermissionKey, boolean>;
}

/**
 * `GET /me` (any signed-in staff member): `{ actor, role, can }`, where `can` has a boolean for every permission under the
 * effective table (the defaults with the `permissions` option applied), so a client can hide what the server would refuse.
 * It needs no permission beyond being authenticated (401 otherwise), holds no ids or text, and writes no audit row.
 */
export function meRoutes(ctx: AdminContext): RouteTable {
  const { permissions } = ctx;
  return {
    'GET /me': ctx.authenticated(({ authz }) => {
      const can = {} as Record<PermissionKey, boolean>;
      for (const key of PERMISSION_KEYS) can[key] = roleAtLeast(authz.role, permissions[key]);
      const body: Me = { actor: authz.actor, role: authz.role, can };
      return { status: 200, body };
    }),
  };
}
