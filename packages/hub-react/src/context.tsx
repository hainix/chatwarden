import { createContext, useContext } from 'react';
import type { HubClient } from './client.js';
import type { HubT } from './i18n.js';
import type { HubRouter, Route } from './router.js';
import type { Me, PermissionKey } from './types.js';

/** What every screen reads from the hub: the client, the words, the clock, the router and who is signed in. */
export interface HubContextValue {
  client: HubClient;
  t: HubT;
  locale: string;
  /** The clock for "5 minutes ago". The page's clock by default; tests pass their own. */
  now: () => number;
  router: HubRouter;
  me: Me;
  /** Whether the signed-in role holds a permission (from `GET /me`, so the server's own table, overrides included). */
  can: (permission: PermissionKey) => boolean;
  /** Move to a route. */
  go: (route: Route) => void;
  /** The address of a route, for a link. */
  href: (route: Route) => string;
}

export const HubContext = createContext<HubContextValue | null>(null);

/** The hub's context. Throws outside a `<Hub>`: a screen cannot work without one. */
export function useHub(): HubContextValue {
  const value = useContext(HubContext);
  if (value === null) throw new Error('useHub must be used inside <Hub>');
  return value;
}
