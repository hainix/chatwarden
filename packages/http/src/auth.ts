import { ROLES } from '@chatwarden/core';
import type { Role } from '@chatwarden/core';
import { HttpError } from './errors.js';
import { PERMISSIONS, resolvePermissions, roleAtLeast } from './permissions.js';
import type { PermissionKey, Permissions } from './permissions.js';
import type { Authz, KitRequest, KitResponse, RouteParams } from './types.js';

/** The adopter's auth hook: who is calling, or `null` for nobody. The kit never sees a password or a token. */
export type Authenticate = (req: KitRequest) => Authz | null | Promise<Authz | null>;

const isAuthz = (v: unknown): v is Authz => {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as { actor?: unknown; role?: unknown };
  return typeof a.actor === 'string' && a.actor.length > 0 && typeof a.role === 'string' && (ROLES as readonly string[]).includes(a.role);
};

/** Check that `authz` is a well-formed caller (no permission needed). A missing or malformed one fails closed: throws 401 `unauthorized`. */
export function requireAuthz(authz: Authz | null | undefined): asserts authz is Authz {
  if (!isAuthz(authz)) throw new HttpError('unauthorized');
}

/**
 * Check that `authz` may do `permission`. Returns it when so.
 * - no authz (or one that is malformed: fail closed) -> throws 401 `unauthorized`
 * - a role below the one the permission needs, or a permission the map does not know -> throws 403 `forbidden`
 * Pair it with {@link withErrors} to turn the throw into a response.
 */
export function requireRole(
  authz: Authz | null,
  permission: PermissionKey,
  permissions: Permissions = PERMISSIONS,
): Authz {
  requireAuthz(authz);
  const required = Object.hasOwn(permissions, permission) ? permissions[permission] : undefined;
  if (required === undefined || !roleAtLeast(authz.role, required)) throw new HttpError('forbidden');
  return authz;
}

export interface GuardOptions {
  authenticate: Authenticate;
  /** Overrides of the default minimum roles. Validated once, when the guard is built (`RangeError` for a bad one). */
  permissions?: Partial<Record<PermissionKey, Role | undefined>>;
}

/**
 * Wrap a route handler so it runs only for a caller who may do `permission`: authenticate, then check the role, then
 * (and only then) call the handler with the authz. A refusal throws before the handler; wrap the result in
 * {@link withErrors} to answer it as 401 or 403.
 */
export function guard(
  options: GuardOptions,
  permission: PermissionKey,
  handler: (req: KitRequest, params: RouteParams, authz: Authz) => KitResponse | Promise<KitResponse>,
): (req: KitRequest, params: RouteParams) => Promise<KitResponse> {
  const { authenticate } = options;
  // Resolved (validated, defaults filled in, frozen copy) once here, not per request.
  const permissions = resolvePermissions(options.permissions);
  return async (req, params) => {
    const authz = requireRole(await authenticate(req), permission, permissions);
    return handler(req, params, authz);
  };
}
