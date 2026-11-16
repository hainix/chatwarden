import { ROLES } from '@chatwarden/core';
import type { Role } from '@chatwarden/core';
import type { DiscordRoleMap } from './types.js';

/** A member can hold at most this many roles in Discord (250); more than that is not a member list. */
const MEMBER_ROLES_MAX = 250;

/**
 * The kit role a Discord member acts as: the HIGHEST of the kit roles whose Discord role ids include one the member holds, or null for none.
 * `memberRoles` is the `member.roles` of a signed interaction (ids, never names); anything in it that is not a string is ignored. The map is
 * compared by id only: a role name, or the word `owner`, matches nothing. A role id listed under two kit roles gives the higher.
 */
export function kitRoleOf(memberRoles: readonly unknown[], map: DiscordRoleMap): Role | null {
  if (!Array.isArray(memberRoles) || memberRoles.length > MEMBER_ROLES_MAX) return null;
  const held = new Set<string>();
  for (const id of memberRoles as unknown[]) if (typeof id === 'string') held.add(id);
  let found: Role | null = null;
  // ROLES runs from the lowest to the highest, so the last match is the highest.
  for (const role of ROLES) {
    if (!Object.hasOwn(map, role)) continue;
    const ids = map[role];
    if (ids !== undefined && ids.some((id) => held.has(id))) found = role;
  }
  return found;
}
