import type { Role, SanctionKind } from '@chatwarden/core';
import { PERMISSION_KEYS, roleAtLeast } from '../permissions.js';
import type { PermissionKey } from '../permissions.js';
import type { RouteTable } from '../router.js';
import { SCOPE_AWARE_PERMISSIONS } from './context.js';
import type { AdminContext } from './context.js';

/** Which of the optional staff features are on right now. Always present in `GET /me` since 0.2.0. */
export interface MeFeatures {
  /** Appeals are on (`profile.appeals.enabled`, and the store can keep them). */
  appeals: boolean;
  /** Required renames can work: `names.renames` is on AND the store can release a rename, so a hub never offers one that always 404s. */
  renames: boolean;
  /** `names.keepBlocked` is on: blocked names are kept as evidence, so the Blocked screen may offer the Names list. Read live. */
  keepBlocked: boolean;
  /** The shared term list is wired (`community` was passed to `adminRoutes`). Present, as `true`, only then; the hub shows its section when it is. */
  community?: boolean;
  /** The room tools (modes, the room list, taking a line back) are part of every kit: always `true`. What a caller may do with them is `can['rooms.read']` and `can['rooms.manage']`. */
  rooms: boolean;
  /** `desk.workflow` is on: staff comments and a second look. Read live. */
  workflow: boolean;
  /** `desk.insights` is on and the store can read the rows: the Insights page. Read live. */
  insights: boolean;
}

/** What `GET /me` answers: who the caller is and, for each permission, whether their role holds it. */
export interface Me {
  actor: string;
  role: Role;
  can: Record<PermissionKey, boolean>;
  /** The staff features that are on. This server always sends it (`rooms`, `workflow` and `insights` are booleans); the type leaves it optional for a client written before it. */
  features?: MeFeatures;
  /**
   * The staff scope of a scoped caller (the room labels they may see), present only for one. For a scoped caller `can` is true only for the permissions the scope-aware routes ask for
   * (and the role holds), so a hub shows nothing the server would refuse.
   */
  scope?: readonly string[];
  /**
   * What a scoped caller may apply (present only with `scope`): the sanction kinds and the longest length of a restriction or a ban, in milliseconds (a permanent one never). A hub offers no more than this; the
   * server refuses the rest with 400 `invalid_sanction`. A scoped caller also never places an IP sanction, and `features.renames` is `false` for them.
   */
  scopedLimits?: { kinds: readonly SanctionKind[]; maxDurationMs: number };
}

/**
 * `GET /me` (any signed-in staff member): `{ actor, role, can }`, where `can` has a boolean for every permission under the
 * effective table (the defaults with the `permissions` option applied), so a client can hide what the server would refuse.
 * `features: { appeals, renames, keepBlocked, community?, rooms, workflow, insights }` is always there (`community`: the shared term list is wired, present only then) (appeals: the profile says so and the store
 * can keep them; renames: `names.renames` is on and the store can release one; keepBlocked: `names.keepBlocked`, so a hub learns it without reading the policy; `rooms`: always true, the room tools are part of every kit;
 * `workflow`: `desk.workflow`; `insights`: `desk.insights` and a store that can read the rows), read live.
 * For a scoped caller `scope` and `scopedLimits` (the kinds and longest length they may apply) are there too, `can` is trimmed to what a scoped caller may do, and `features.renames` is `false`.
 * It needs no permission beyond being authenticated (401 otherwise), holds no ids or text, and writes no audit row.
 */
export function meRoutes(ctx: AdminContext, options: { community?: boolean } = {}): RouteTable {
  const { permissions, cw } = ctx;
  return {
    'GET /me': ctx.authenticated(({ authz, scope }) => {
      const can = {} as Record<PermissionKey, boolean>;
      for (const key of PERMISSION_KEYS) can[key] = roleAtLeast(authz.role, permissions[key]) && (scope === undefined || SCOPE_AWARE_PERMISSIONS.includes(key));
      const body: Me = {
        actor: authz.actor,
        role: authz.role,
        can,
        ...(scope === undefined ? {} : { scope: [...scope], scopedLimits: { kinds: [...ctx.scopedLimits.kinds], maxDurationMs: ctx.scopedLimits.maxDurationMs } }),
      };
      const community = options.community === true;
      const features: MeFeatures = {
        appeals: cw.appeals.enabled(),
        // A scoped decision with a rename is refused whole (403), so a scoped caller is never told renames work.
        renames: scope === undefined && cw.names.renamesEnabled(),
        keepBlocked: cw.profile.names.keepBlocked === true,
        ...(community ? { community: true } : {}),
        rooms: true,
        workflow: cw.desk.workflowEnabled(),
        insights: cw.insights.enabled(),
      };
      body.features = features;
      return { status: 200, body };
    }, { scoped: true }),
  };
}
