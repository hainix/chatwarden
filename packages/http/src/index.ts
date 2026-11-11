export const VERSION = '0.1.4';
export { ROLES } from '@chatwarden/core';
export type { Role } from '@chatwarden/core';
export type { Authz, KitRequest, KitResponse, RouteParams } from './types.js';
export { compileRoutes as matchRoute, createRouter } from './router.js';
export type { CompiledRoutes, RouteHandler, RouteTable } from './router.js';
export { ClaimedError, errorResponse, HttpError, NotFoundError, ValidationError, withErrors } from './errors.js';
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
  blockedRoutes,
  gapRoutes,
  meRoutes,
  policyRoutes,
  reportRoutes,
  sanctionRoutes,
  teamRoutes,
  termRoutes,
} from './admin/index.js';
export type {
  AdminCall,
  AdminContext,
  AdminOptions,
  AdminRoutesOptions,
  ExceptionListRow,
  Me,
  PolicyOptions,
  ReportSummary,
  TermListRow,
  TermMetadata,
  TermsAdmin,
  TermsEditor,
} from './admin/index.js';
export { CODE_OF_CONDUCT_CSP, playerRoutes } from './player.js';
export type { NamesRateLimit, PlayerOptions } from './player.js';
export { healthRoutes } from './health.js';
export type { HealthOptions } from './health.js';
export {
  ATTEMPT_TIMEOUT_MS,
  BACKOFF_BASE_MS,
  DELIVERY_HEADER,
  MAX_RETRIES,
  MIN_SECRET_LENGTH,
  QUEUE_MAX,
  REPLAY_CACHE_SIZE,
  ReplayCache,
  RETRY_AFTER_CAP_MS,
  RETRY_AFTER_FLOOR_MS,
  SIGNATURE_HEADER,
  SIGNATURE_WINDOW_MS,
  TIMESTAMP_HEADER,
  sign,
  verify,
  webhookIn,
  webhooksOut,
} from './webhooks/index.js';
export type { WebhookEndpoint, WebhookInOptions, WebhooksOut, WebhooksOutOptions } from './webhooks/index.js';
