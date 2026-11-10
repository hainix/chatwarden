// `@chatwarden/http/admin`: the staff API and what it needs, and nothing that imports a Node builtin, so a browser bundle
// (the hub, a demo running the kit in the page) can use it. It leaves out the player routes, the webhooks and the Express
// adapter, which use `node:crypto`; import those from `@chatwarden/http` or `@chatwarden/http/express` on the server.
// Every name here is the same binding the root export gives.
export { ROLES } from '@chatwarden/core';
export type { Role } from '@chatwarden/core';
export type { Authz, KitRequest, KitResponse, RouteParams } from './types.js';
export { compileRoutes as matchRoute, createRouter } from './router.js';
export type { CompiledRoutes, RouteHandler, RouteTable } from './router.js';
export { errorResponse, HttpError, NotFoundError, ValidationError, withErrors } from './errors.js';
export type { ErrorCode } from './errors.js';
export { BODY_MAX_BYTES, parseJson } from './body.js';
export { guard, requireRole } from './auth.js';
export type { Authenticate, GuardOptions } from './auth.js';
export { PERMISSION_KEYS, PERMISSIONS, resolvePermissions, roleAtLeast } from './permissions.js';
export type { PermissionKey, Permissions } from './permissions.js';
export {
  adminRoutes,
  auditRoutes,
  AuditFailedError,
  BadActorError,
  createAdminContext,
  DEFAULT_GAME_NAME,
  gapRoutes,
  meRoutes,
  policyRoutes,
  reportRoutes,
  sanctionRoutes,
  termRoutes,
} from './admin/index.js';
export type {
  AdminCall,
  AdminContext,
  AdminOptions,
  AdminRoutesOptions,
  Me,
  PolicyOptions,
  ReportSummary,
  TermsAdmin,
  TermsEditor,
} from './admin/index.js';
