import { isValidAuditActor, MAX_SANCTION_DURATION_MS, safeWarn, SANCTION_KINDS } from '@chatwarden/core';
import type { AuditAction, AuditDetail, AuditTarget, Chatwarden, Logger, Role, SanctionKind } from '@chatwarden/core';
import { guard, requireAuthz, requireRole } from '../auth.js';
import type { Authenticate } from '../auth.js';
import { HttpError, withErrors } from '../errors.js';
import { resolvePermissions } from '../permissions.js';
import type { PermissionKey, Permissions } from '../permissions.js';
import type { RouteHandler } from '../router.js';
import type { Authz, KitRequest, KitResponse, RouteParams } from '../types.js';

const DAY_MS = 24 * 3_600_000;

/** What a scoped moderator may apply: the kinds, and the longest length (a permanent one is never allowed). */
export interface ScopedLimits {
  kinds: readonly SanctionKind[];
  maxDurationMs: number;
}

/** The default limits of a scoped moderator: a warning or a chat restriction of at most 7 days. */
export const SCOPED_DEFAULT_LIMITS: Readonly<ScopedLimits> = Object.freeze({ kinds: Object.freeze(['warning', 'chat'] as const) as readonly SanctionKind[], maxDurationMs: 7 * DAY_MS });

/**
 * The permissions a scoped caller may hold at all: the ones the scope-aware routes ask for. `GET /me` lists only these as true for a scoped caller, so the hub hides what the server would
 * refuse; every other permission is false for them whatever their role holds.
 */
export const SCOPE_AWARE_PERMISSIONS: readonly PermissionKey[] = Object.freeze(['reports.read', 'reports.decide', 'history.read', 'sanctions.apply', 'sanctions.revoke', 'reasons.read', 'claims.override'] as const);

/** The route handlers that declared themselves scope-aware (`secure(..., { scoped: true })`). Everything else answers 403 to a scoped caller. */
const SCOPE_AWARE = new WeakSet<RouteHandler>();
/** Did this route handler declare itself scope-aware? The guard test over the whole admin table reads it. */
export const isScopeAware = (handler: RouteHandler): boolean => SCOPE_AWARE.has(handler);

function resolveScopedLimits(given: ScopedLimits | undefined): Readonly<ScopedLimits> {
  if (given === undefined) return SCOPED_DEFAULT_LIMITS;
  const kinds = given.kinds as unknown;
  const max = given.maxDurationMs as unknown;
  if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every((k) => (SANCTION_KINDS as readonly unknown[]).includes(k))) {
    throw new RangeError('adminRoutes: scopedLimits.kinds must list at least one sanction kind');
  }
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > MAX_SANCTION_DURATION_MS) {
    throw new RangeError('adminRoutes: scopedLimits.maxDurationMs must be a whole number of milliseconds from 1 to 365 days');
  }
  return Object.freeze({ kinds: Object.freeze([...(kinds as SanctionKind[])]), maxDurationMs: max });
}

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
  /**
   * What a scoped moderator (`Authz.scope`) may apply, by `POST /sanctions` and in a decision: only these kinds, at most this long, never permanent. Default {@link SCOPED_DEFAULT_LIMITS}.
   * Validated once, when the routes are built (`RangeError` for a bad one).
   */
  scopedLimits?: ScopedLimits;
}

/** What a staff route handler is given, after the caller is authenticated and holds the route's permission. */
export interface AdminCall {
  req: KitRequest;
  params: RouteParams;
  authz: Authz;
  /** The caller's staff scope (`authz.scope`), or undefined for a global caller. A scope-aware route passes it to every read. */
  scope: readonly string[] | undefined;
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
  /**
   * Wrap a staff handler: authenticate, require `permission`, run it, and turn every throw into a fixed response. A caller with a staff scope gets 403 `forbidden` unless the route declares
   * `{ scoped: true }`, which says it reads and writes only through the caller's scope (`call.scope`): default deny, so a route added later is closed to scoped callers until it opts in.
   */
  secure(permission: PermissionKey, handler: (call: AdminCall) => KitResponse | Promise<KitResponse>, options?: { scoped?: boolean }): RouteHandler;
  /**
   * Like `secure`, for a route that needs no permission, only a signed-in caller (401 otherwise): `GET /me`. It gets no
   * `audit` and no `need`, so it cannot write a row. Scoped callers get 403 unless `{ scoped: true }`.
   */
  authenticated(
    handler: (call: { req: KitRequest; params: RouteParams; authz: Authz; scope: readonly string[] | undefined }) => KitResponse | Promise<KitResponse>,
    options?: { scoped?: boolean },
  ): RouteHandler;
  /** The limits of a scoped moderator, validated (the default when none was given). */
  readonly scopedLimits: Readonly<ScopedLimits>;
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
  const scopedLimits = resolveScopedLimits(options.scopedLimits);
  return {
    cw,
    logger,
    permissions,
    scopedLimits,
    authenticated(handler, o) {
      const route = noStore(
        withErrors(async (req, params) => {
          const authz = await authorize(req);
          requireAuthz(authz);
          if (authz.scope !== undefined && o?.scoped !== true) throw new HttpError('forbidden');
          return handler({ req, params, authz, scope: authz.scope });
        }, logger),
      );
      if (o?.scoped === true) SCOPE_AWARE.add(route);
      return route;
    },
    secure(permission, handler, o) {
      const guarded = guard({ authenticate: authorize, permissions }, permission, (req, params, authz) => {
        // Default deny: a scoped caller reaches only a route that declared itself scope-aware. Nothing is logged here (no scope, actor or id).
        if (authz.scope !== undefined && o?.scoped !== true) throw new HttpError('forbidden');
        return handler({
          req,
          params,
          authz,
          scope: authz.scope,
          need: (p) => {
            // A scoped caller never holds a permission outside the scope-aware ones, whatever their role would hold.
            if (authz.scope !== undefined && !SCOPE_AWARE_PERMISSIONS.includes(p)) throw new HttpError('forbidden');
            requireRole(authz, p, permissions);
          },
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
        });
      });
      const route = noStore(withErrors(guarded, logger));
      if (o?.scoped === true) SCOPE_AWARE.add(route);
      return route;
    },
  };
}
