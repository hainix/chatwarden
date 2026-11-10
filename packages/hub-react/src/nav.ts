import type { HubText } from './i18n.js';
import type { Route, TabName } from './router.js';
import type { PermissionKey } from './types.js';

/** The tabs, in order. A tab shows only when the signed-in role holds its permission (`null`: always). */
export const TABS: ReadonlyArray<{ tab: TabName; route: Route; label: HubText; permission: PermissionKey | null }> = [
  { tab: 'overview', route: { name: 'overview' }, label: 'hub.nav.overview', permission: null },
  { tab: 'reports', route: { name: 'reports', status: 'open' }, label: 'hub.nav.reports', permission: 'reports.read' },
  { tab: 'blocked', route: { name: 'blocked' }, label: 'hub.nav.blocked', permission: 'blocked.read' },
  { tab: 'terms', route: { name: 'terms' }, label: 'hub.nav.terms', permission: 'terms.read' },
  { tab: 'gaps', route: { name: 'gaps' }, label: 'hub.nav.gaps', permission: 'gaps.read' },
  { tab: 'audit', route: { name: 'audit' }, label: 'hub.nav.audit', permission: 'audit.read' },
  { tab: 'guide', route: { name: 'guide' }, label: 'hub.nav.guide', permission: 'policy.read' },
];

/** The permission a route needs to open at all (`null`: any signed-in staff member). */
export function permissionFor(route: Route): PermissionKey | null {
  switch (route.name) {
    case 'overview':
    case 'notFound':
      return null;
    case 'reports':
    case 'report':
      return 'reports.read';
    case 'person':
    case 'actions':
      return 'history.read';
    case 'terms':
      return 'terms.read';
    case 'blocked':
      return 'blocked.read';
    case 'gaps':
      return 'gaps.read';
    case 'audit':
      return 'audit.read';
    case 'guide':
      return 'policy.read';
  }
}
