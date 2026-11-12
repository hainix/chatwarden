// `@chatwarden/http/admin`: the staff API and what it needs, and nothing that imports a Node builtin, so a browser bundle
// (the hub, a demo running the kit in the page) can use it. It leaves out the player routes, the webhooks and the Express
// adapter, which use `node:crypto`; import those from `@chatwarden/http` or `@chatwarden/http/express` on the server.
// Every name here is the same binding the root export gives.
export { ROLES } from '@chatwarden/core';
export type { Role } from '@chatwarden/core';
export type { Authz, KitRequest, KitResponse, KitStream, RouteParams } from './types.js';
export { compileRoutes as matchRoute, createRouter } from './router.js';
export type { CompiledRoutes, RouteHandler, RouteTable } from './router.js';
export { AiUnavailableError, ClaimedError, errorResponse, HttpError, NotFoundError, ValidationError, withErrors } from './errors.js';
export type { ErrorCode } from './errors.js';
export { BODY_MAX_BYTES, parseJson } from './body.js';
export { guard, requireRole } from './auth.js';
export type { Authenticate, GuardOptions } from './auth.js';
export { PERMISSION_KEYS, PERMISSIONS, resolvePermissions, roleAtLeast } from './permissions.js';
export type { PermissionKey, Permissions } from './permissions.js';
export {
  adminRoutes,
  aiRoutes,
  auditRoutes,
  AuditFailedError,
  BadActorError,
  createAdminContext,
  DEFAULT_GAME_NAME,
  blockedRoutes,
  gapRoutes,
  meRoutes,
  policyRoutes,
  reportRoutes,
  sanctionRoutes,
  teamRoutes,
  termRoutes,
} from './admin/index.js';
export type { AiReadAgainBody, AiUnavailableBody } from './admin/index.js';
export type {
  AdminCall,
  AdminContext,
  AdminOptions,
  AdminRoutesOptions,
  ExceptionListRow,
  Me,
  PolicyOptions,
  ReporterAccuracySummary,
  ReportSummary,
  TermListRow,
  TermMetadata,
  TermsAdmin,
  TermsEditor,
} from './admin/index.js';
