import type { Role } from '@chatwarden/core';
import { PERMISSION_KEYS, roleAtLeast } from '../permissions.js';
import type { PermissionKey } from '../permissions.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';

/** Which of the optional staff features are on right now. Present in `GET /me` only when at least one is on. */
export interface MeFeatures {
  /** Appeals are on (`profile.appeals.enabled`, and the store can keep them). */
  appeals: boolean;
  /** Required renames can work: `names.renames` is on AND the store can release a rename, so a hub never offers one that always 404s. */
  renames: boolean;
  /** `names.keepBlocked` is on: blocked names are kept as evidence, so the Blocked screen may offer the Names list. Read live. */
  keepBlocked: boolean;
}

/** What `GET /me` answers: who the caller is and, for each permission, whether their role holds it. */
export interface Me {
  actor: string;
  role: Role;
  can: Record<PermissionKey, boolean>;
  /** Only when appeals, renames or keepBlocked is on. With all off the body is what 0.1.7 sent. */
  features?: MeFeatures;
}

/**
 * `GET /me` (any signed-in staff member): `{ actor, role, can }`, where `can` has a boolean for every permission under the
 * effective table (the defaults with the `permissions` option applied), so a client can hide what the server would refuse.
 * `features: { appeals, renames, keepBlocked }` is added only when any is on (appeals: the profile says so and the store can keep them; renames:
 * `names.renames` is on and the store can release one; keepBlocked: `names.keepBlocked`, so a hub learns it without reading the policy), read
 * live; with all three off the body is exactly what 0.1.7 sent.
 * It needs no permission beyond being authenticated (401 otherwise), holds no ids or text, and writes no audit row.
 */
export function meRoutes(ctx: AdminContext): RouteTable {
  const { permissions, cw } = ctx;
  return {
    'GET /me': ctx.authenticated(({ authz }) => {
      const can = {} as Record<PermissionKey, boolean>;
      for (const key of PERMISSION_KEYS) can[key] = roleAtLeast(authz.role, permissions[key]);
      const body: Me = { actor: authz.actor, role: authz.role, can };
      const features: MeFeatures = { appeals: cw.appeals.enabled(), renames: cw.names.renamesEnabled(), keepBlocked: cw.profile.names.keepBlocked === true };
      if (features.appeals || features.renames || features.keepBlocked) body.features = features;
      return { status: 200, body };
    }),
  };
}
