import { safeWarn } from '@chatwarden/core';
import type { AuditAction, AuditTarget, Chatwarden, Logger, Role } from '@chatwarden/core';
import { guard, requireRole } from '../auth.js';
import type { Authenticate } from '../auth.js';
import { withErrors } from '../errors.js';
import { resolvePermissions } from '../permissions.js';
import type { PermissionKey } from '../permissions.js';
import type { RouteHandler } from '../router.js';
import type { Authz, KitRequest, KitResponse, RouteParams } from '../types.js';

/** What the adopter gives the admin API. */
export interface AdminOptions {
  /**
   * Who is calling: the adopter's own auth (session, token, SSO). Returns the staff member's `actor` (a staff ref or
   * login, as the audit trail takes it) and `role`, or `null` for nobody (401). May be async. A throw is a 500.
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
   */
  audit(action: AuditAction, target?: AuditTarget, mode?: 'required' | 'best-effort'): void;
}

/** The shared parts of the staff API: build every admin route with `secure`, so none can skip auth or the audit. */
export interface AdminContext {
  readonly cw: Chatwarden;
  /** Wrap a staff handler: authenticate, require `permission`, run it, and turn every throw into a fixed response. */
  secure(permission: PermissionKey, handler: (call: AdminCall) => KitResponse | Promise<KitResponse>): RouteHandler;
}

/** The audit row for a view could not be written. Fixed message, no input. */
export class AuditFailedError extends Error {
  constructor() {
    super('audit: the row could not be written');
    this.name = 'AuditFailedError';
  }
}

export function createAdminContext(cw: Chatwarden, options: AdminOptions): AdminContext {
  const { authorize, logger } = options;
  // Validated once, here: a bad override fails at start-up, not on the first request.
  const permissions = resolvePermissions(options.permissions);
  return {
    cw,
    secure(permission, handler) {
      const guarded = guard({ authenticate: authorize, permissions }, permission, (req, params, authz) =>
        handler({
          req,
          params,
          authz,
          need: (p) => void requireRole(authz, p, permissions),
          audit: (action, target, mode = 'required') => {
            let written: boolean;
            try {
              written = cw.audit.record({
                actor: authz.actor,
                role: authz.role,
                action,
                ...(target === undefined ? {} : { target }),
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
      return withErrors(guarded, logger);
    },
  };
}
