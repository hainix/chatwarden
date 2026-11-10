import { ROLES } from '@chatwarden/core';
import type { Role } from '@chatwarden/core';

/** The things a staff member may be allowed to do. */
export const PERMISSION_KEYS = [
  'reports.read',
  'reports.decide',
  'sanctions.apply',
  'sanctions.apply.ban_permanent',
  'sanctions.revoke',
  'history.read',
  'gaps.read',
  'gaps.close',
  'terms.read',
  'terms.write',
  'policy.read',
  'audit.read',
  'settings',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/** The role each permission needs, as a whole map. */
export type Permissions = Readonly<Record<PermissionKey, Role>>;

/** The minimum role for each action. `terms.write` is `moderator` on purpose (the Moxgate decision). */
export const PERMISSIONS: Permissions = Object.freeze({
  'reports.read': 'moderator',
  'reports.decide': 'moderator',
  'sanctions.apply': 'moderator',
  'sanctions.apply.ban_permanent': 'senior',
  'sanctions.revoke': 'moderator',
  'history.read': 'moderator',
  'gaps.read': 'moderator',
  'gaps.close': 'owner',
  'terms.read': 'moderator',
  'terms.write': 'moderator',
  'policy.read': 'moderator',
  'audit.read': 'senior',
  settings: 'owner',
});

const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);
const isPermissionKey = (v: string): v is PermissionKey => (PERMISSION_KEYS as readonly string[]).includes(v);

/** True when `actual` is `required` or higher (`moderator` < `senior` < `owner`). A value that is not a role is never enough. */
export function roleAtLeast(actual: Role, required: Role): boolean {
  if (!isRole(actual) || !isRole(required)) return false;
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

/**
 * The defaults with the adopter's overrides applied, validated: every key must be a known permission and every value a
 * role. Throws `RangeError` at creation, naming the key and never the value. Returns a frozen copy.
 */
export function resolvePermissions(overrides?: Partial<Record<PermissionKey, Role | undefined>>): Permissions {
  if (overrides !== undefined && (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides))) {
    throw new RangeError('permissions must be an object');
  }
  const out: Record<PermissionKey, Role> = { ...PERMISSIONS };
  for (const key of Object.keys(overrides ?? {})) {
    if (!isPermissionKey(key)) throw new RangeError(`permissions: unknown permission "${key}"`);
    const value = (overrides as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (!isRole(value)) throw new RangeError(`permissions.${key} must be one of ${ROLES.join(', ')}`);
    out[key] = value;
  }
  return Object.freeze(out);
}
