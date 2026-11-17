import type { Chatwarden } from '@chatwarden/core';
import type { RouteTable } from '../router.js';
import { aiRoutes } from './ai.js';
import { appealRoutes } from './appeals.js';
import { auditRoutes } from './audit.js';
import { blockedRoutes } from './blocked.js';
import { communityRoutes } from './community.js';
import type { CommunityAdmin } from './community.js';
import { createAdminContext } from './context.js';
import type { AdminOptions } from './context.js';
import { filterRoutes } from './filters.js';
import { legalRoutes } from './legal.js';
import { gapRoutes } from './gaps.js';
import { meRoutes } from './me.js';
import { nameRoutes } from './names.js';
import { personRoutes } from './people.js';
import { privacyRoutes } from './privacy.js';
import { policyRoutes } from './policy.js';
import { policyProfileRoutes } from './policyProfile.js';
import type { PolicyOptions } from './policy.js';
import { reportRoutes } from './reports.js';
import { sanctionRoutes } from './sanctions.js';
import { teamRoutes } from './team.js';
import { termRoutes } from './terms.js';
import { workflowRoutes } from './workflow.js';
import type { TermsAdmin } from './terms.js';

export { AuditFailedError, BadActorError, createAdminContext } from './context.js';
export type { AdminCall, AdminContext, AdminOptions } from './context.js';
export { aiRoutes } from './ai.js';
export { appealRoutes } from './appeals.js';
export type { AiReadAgainBody, AiUnavailableBody } from './ai.js';
export { auditRoutes } from './audit.js';
export { blockedRoutes } from './blocked.js';
export { communityRoutes } from './community.js';
export type {
  CommunityAdmin,
  CommunityLoader,
  CommunityRelease,
  CommunityShareClient,
  CommunityShareInput,
  CommunityStatus,
  CommunitySummary,
  CommunitySyncResult,
  CommunitySyncTarget,
} from './community.js';
export { gapRoutes } from './gaps.js';
export { meRoutes } from './me.js';
export { nameRoutes } from './names.js';
export { personRoutes } from './people.js';
export { privacyRoutes } from './privacy.js';
export { legalRoutes } from './legal.js';
export type { Me, MeFeatures } from './me.js';
export { DEFAULT_GAME_NAME, policyRoutes } from './policy.js';
export type { PolicyOptions } from './policy.js';
export { reportRoutes } from './reports.js';
export { workflowRoutes } from './workflow.js';
export type { ReporterAccuracySummary, ReportSummary } from './reports.js';
export { sanctionRoutes } from './sanctions.js';
export { teamRoutes } from './team.js';
export { termRoutes } from './terms.js';
export type { ExceptionListRow, TermListRow, TermMetadata, TermsAdmin, TermsEditor } from './terms.js';

/** What the adopter gives the whole staff API: the auth hook and permissions, plus what the term and policy routes need. */
export interface AdminRoutesOptions extends AdminOptions, PolicyOptions {
  /**
   * The live term list (the matcher package's `LiveTerms` fits). Without it there are no term or exception routes.
   * Term text is shown in `GET /terms`, `POST /terms/check` and the `term` of `GET /blocked`, to staff. `POST /terms/test` is
   * mounted when it has a `match` (a `LiveTerms` does).
   */
  terms?: TermsAdmin;
  /**
   * The recent chat lines `POST /terms/check` also tests a candidate against (on top of the term pack's own corpus). Called
   * on each check. Default: none. These are other players' lines: they reach staff in the `hits` and nowhere else.
   */
  recentLines?: () => readonly string[];
  /**
   * The shared term list (K7, experimental): `{ loader, live, share? }`, where `loader` is the matcher's corpus loader, `live` its
   * `LiveTerms` and `share` the community share client. With it the staff API gains `GET /community`, `POST /community/refresh`,
   * `POST /community/apply`, `GET /terms/:id` and `POST /terms/lookup`, and, with `share`, `POST` and `GET /terms/:id/share`; the term
   * routes use `live` when `terms` is not given. `GET /terms` stops listing community rows nobody has edited (it reports
   * `community.hidden`) unless `community.exposeCommunityRows` is true. Without `community` none of this exists.
   */
  community?: CommunityAdmin;
}

/**
 * The staff API as a route table: hand it to `createRouter` (alone, or spread beside your own routes). Every route is
 * authenticated by `options.authorize`, needs a permission, and writes its audit row. All groups (reports, sanctions,
 * gaps, terms, policy and the editable profile, audit, and the team's claims, change token and saved reasons) are built from one `createAdminContext`, so there is one auth and audit path.
 */
export function adminRoutes(cw: Chatwarden, options: AdminRoutesOptions): RouteTable {
  const ctx = createAdminContext(cw, options);
  const terms = options.terms ?? options.community?.live;
  return {
    ...meRoutes(ctx, { community: options.community !== undefined }),
    ...reportRoutes(ctx),
    ...teamRoutes(ctx),
    ...sanctionRoutes(ctx),
    ...appealRoutes(ctx),
    ...nameRoutes(ctx),
    ...personRoutes(ctx),
    ...privacyRoutes(ctx),
    ...legalRoutes(ctx),
    ...workflowRoutes(ctx),
    ...blockedRoutes(ctx, options.terms),
    ...gapRoutes(ctx),
    ...(terms === undefined
      ? {}
      : termRoutes(ctx, terms, options.recentLines ?? (() => []), options.community === undefined ? undefined : { expose: options.community.exposeCommunityRows === true })),
    ...(options.community === undefined ? {} : communityRoutes(ctx, options.community)),
    ...policyRoutes(ctx, {
      ...(options.gameName === undefined ? {} : { gameName: options.gameName }),
      ...(options.contactUrl === undefined ? {} : { contactUrl: options.contactUrl }),
    }),
    ...policyProfileRoutes(ctx),
    ...filterRoutes(ctx, options.recentLines ?? (() => [])),
    ...aiRoutes(ctx),
    ...auditRoutes(ctx),
  };
}
