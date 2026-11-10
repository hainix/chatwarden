import type { Chatwarden } from '@chatwarden/core';
import type { RouteTable } from '../router.js';
import { auditRoutes } from './audit.js';
import { createAdminContext } from './context.js';
import type { AdminOptions } from './context.js';
import { gapRoutes } from './gaps.js';
import { meRoutes } from './me.js';
import { policyRoutes } from './policy.js';
import type { PolicyOptions } from './policy.js';
import { reportRoutes } from './reports.js';
import { sanctionRoutes } from './sanctions.js';
import { termRoutes } from './terms.js';
import type { TermsAdmin } from './terms.js';

export { AuditFailedError, BadActorError, createAdminContext } from './context.js';
export type { AdminCall, AdminContext, AdminOptions } from './context.js';
export { auditRoutes } from './audit.js';
export { gapRoutes } from './gaps.js';
export { meRoutes } from './me.js';
export type { Me } from './me.js';
export { DEFAULT_GAME_NAME, policyRoutes } from './policy.js';
export type { PolicyOptions } from './policy.js';
export { reportRoutes } from './reports.js';
export type { ReportSummary } from './reports.js';
export { sanctionRoutes } from './sanctions.js';
export { termRoutes } from './terms.js';
export type { TermsAdmin, TermsEditor } from './terms.js';

/** What the adopter gives the whole staff API: the auth hook and permissions, plus what the term and policy routes need. */
export interface AdminRoutesOptions extends AdminOptions, PolicyOptions {
  /**
   * The live term list (the matcher package's `LiveTerms` fits). Without it there are no term or exception routes.
   * Term text is shown in `GET /terms` and `POST /terms/check` only, to staff.
   */
  terms?: TermsAdmin;
  /**
   * The recent chat lines `POST /terms/check` also tests a candidate against (on top of the term pack's own corpus). Called
   * on each check. Default: none. These are other players' lines: they reach staff in the `hits` and nowhere else.
   */
  recentLines?: () => readonly string[];
}

/**
 * The staff API as a route table: hand it to `createRouter` (alone, or spread beside your own routes). Every route is
 * authenticated by `options.authorize`, needs a permission, and writes its audit row. All groups (reports, sanctions,
 * gaps, terms, policy, audit) are built from one `createAdminContext`, so there is one auth and audit path.
 */
export function adminRoutes(cw: Chatwarden, options: AdminRoutesOptions): RouteTable {
  const ctx = createAdminContext(cw, options);
  return {
    ...meRoutes(ctx),
    ...reportRoutes(ctx),
    ...sanctionRoutes(ctx),
    ...gapRoutes(ctx),
    ...(options.terms === undefined ? {} : termRoutes(ctx, options.terms, options.recentLines ?? (() => []))),
    ...policyRoutes(ctx, {
      ...(options.gameName === undefined ? {} : { gameName: options.gameName }),
      ...(options.contactUrl === undefined ? {} : { contactUrl: options.contactUrl }),
    }),
    ...auditRoutes(ctx),
  };
}
