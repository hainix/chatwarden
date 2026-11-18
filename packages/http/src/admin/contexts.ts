import { overriddenSections } from '@chatwarden/core';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';

/**
 * `GET /policy/contexts` (`policy.read`, not scope-aware: a scoped caller is 403): the room contexts the profile declares, in the order they were declared, as `{ contexts: [{ name, label, overrides }] }`.
 * `label` is the one on the case chip (the name when none was given) and `overrides` the chat-time sections the context sets (`profanity`, `pace`, `chat`, `filters`, in that order): names only, never a
 * value, a word list or a number. `[]` when none is declared. Contexts are declared in code, so there is nothing to edit; the route writes no audit row (it holds no player data and no setting's value).
 */
export function contextRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'GET /policy/contexts': ctx.secure('policy.read', () => {
      const declared = cw.profile.contexts;
      return {
        status: 200,
        body: { contexts: cw.contexts.names().map((name) => ({ name, label: declared[name]?.label ?? name, overrides: declared[name] === undefined ? [] : overriddenSections(declared[name]) })) },
      };
    }),
  };
}
