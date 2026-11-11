import { isValidAuditActor, safeWarn } from '@chatwarden/core';
import type { AuditAction, AuditDetail, AuditTarget, Chatwarden, Logger, Role } from '@chatwarden/core';
import { guard, requireAuthz, requireRole } from '../auth.js';
import type { Authenticate } from '../auth.js';
import { withErrors } from '../errors.js';
import { resolvePermissions } from '../permissions.js';
import type { PermissionKey, Permissions } from '../permissions.js';
import type { RouteHandler } from '../router.js';
import type { Authz, KitRequest, KitResponse, RouteParams } from '../types.js';

/** What the adopter gives the admin API. */
export interface AdminOptions {
  /**
   * Who is calling: the adopter's own auth (session, token, SSO). Returns the staff member's `actor` (a staff ref or
   * login, as the audit trail takes it: 1..128 characters of `A-Z a-z 0-9 _ . : @ + -`, no spaces; any other actor is a
   * 500 `internal` and a `chatwarden.http_bad_actor` log) and `role`, or `null` for nobody (401). May be async. A throw is a 500.
   */
  authorize: Authenticate;
  /** Overrides of the default minimum roles. Validated once, when the routes are built (`RangeError` for a bad one). */
  permissions?: Partial<Record<PermissionKey, Role | undefined>>;
  /** Where unexpected errors are logged (event and error class only). Defaults to `console.warn`. */
  logger?: Logger;
}

/** What a staff route handler is given, after the caller is authenticated and holds the route's permission. */
export interface AdminCall {
  req: KitRequest;
  params: RouteParams;
  authz: Authz;
  /** Require one more permission (for example a sanction's); throws 403 `forbidden`. */
  need(permission: PermissionKey): void;
  /**
   * Write this call's audit row, with the caller as actor and role. Call it only once the work has succeeded, so a
   * refused or failed request leaves no row.
   * - `'required'` (the default, for views): when the row cannot be written, throws, so the response is a 500 and
   *   nothing is shown that was not recorded.
   * - `'best-effort'` (for a write that has already committed): the failure is logged (`chatwarden.http_audit_failed`,
   *   no detail) and the answer stands.
   * `detail` is for `policy.update` and `policy.reset` only: the sections changed and the reason.
   */
  audit(action: AuditAction, target?: AuditTarget, mode?: 'required' | 'best-effort', detail?: AuditDetail): void;
}

/** The shared parts of the staff API: build every admin route with `secure`, so none can skip auth or the audit. */
export interface AdminContext {
  readonly cw: Chatwarden;
  /** Where the route groups log (event and counts only). */
  readonly logger: Logger | undefined;
  /** Wrap a staff handler: authenticate, require `permission`, run it, and turn every throw into a fixed response. */
  secure(permission: PermissionKey, handler: (call: AdminCall) => KitResponse | Promise<KitResponse>): RouteHandler;
  /**
   * Like `secure`, for a route that needs no permission, only a signed-in caller (401 otherwise): `GET /me`. It gets no
   * `audit` and no `need`, so it cannot write a row.
   */
  authenticated(handler: (call: { req: KitRequest; params: RouteParams; authz: Authz }) => KitResponse | Promise<KitResponse>): RouteHandler;
  /** The effective minimum role for each permission: the defaults with the adopter's overrides applied (a frozen copy). */
  readonly permissions: Permissions;
}

/** `authorize` returned an actor the audit trail cannot hold: a bug in the adopter's hook. Fixed message, never the value. */
export class BadActorError extends Error {
  constructor() {
    super('authorize: the actor is not an allowed staff ref');
    this.name = 'BadActorError';
  }
}

/** The audit row for a view could not be written. Fixed message, no input. */
export class AuditFailedError extends Error {
  constructor() {
    super('audit: the row could not be written');
    this.name = 'AuditFailedError';
  }
}

/** Staff data is per caller: no shared cache may keep an answer, success or error. Applied to every staff route, here, once. */
const noStore = (handler: RouteHandler): RouteHandler => async (req, params) => {
  const res = await handler(req, params);
  return { ...res, headers: { ...res.headers, 'cache-control': 'no-store' } };
};

export function createAdminContext(cw: Chatwarden, options: AdminOptions): AdminContext {
  const { logger } = options;
  // The audit trail takes an actor of 1..128 of `A-Z a-z 0-9 _ . : @ + -` only. A hook that returns another (a display name,
  // say) would make every view fail its audit write for no visible reason, and a decision store a name: refuse it here,
  // once, before any handler runs. An empty or non-string actor is left to the guard (401, a malformed authz).
  const authorize: typeof options.authorize = async (req) => {
    const authz = await options.authorize(req);
    const actor = (authz as { actor?: unknown } | null | undefined)?.actor;
    if (typeof actor === 'string' && actor !== '' && !isValidAuditActor(actor)) {
      safeWarn(logger, 'chatwarden.http_bad_actor');
      throw new BadActorError();
    }
    return authz;
  };
  // Validated once, here: a bad override fails at start-up, not on the first request.
  const permissions = resolvePermissions(options.permissions);
  return {
    cw,
    logger,
    permissions,
    authenticated(handler) {
      return noStore(
        withErrors(async (req, params) => {
          const authz = await authorize(req);
          requireAuthz(authz);
          return handler({ req, params, authz });
        }, logger),
      );
    },
    secure(permission, handler) {
      const guarded = guard({ authenticate: authorize, permissions }, permission, (req, params, authz) =>
        handler({
          req,
          params,
          authz,
          need: (p) => void requireRole(authz, p, permissions),
          audit: (action, target, mode = 'required', detail) => {
            let written: boolean;
            try {
              written = cw.audit.record({
                actor: authz.actor,
                role: authz.role,
                action,
                ...(target === undefined ? {} : { target }),
                ...(detail === undefined ? {} : { detail }),
              });
            } catch {
              written = false;
            }
            if (written) return;
            if (mode === 'required') throw new AuditFailedError();
            safeWarn(logger, 'chatwarden.http_audit_failed');
          },
        }),
      );
      return noStore(withErrors(guarded, logger));
    },
  };
}
