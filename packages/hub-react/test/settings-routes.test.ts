import { describe, expect, it } from 'vitest';
import { TABS, permissionFor } from '../src/nav.js';
import { buildPath, parseRoute, tabOf } from '../src/router.js';
import type { Route } from '../src/router.js';

// The settings screen is a route of its own, `#/settings/ladder`, with a section in the address so a later section (Reporting)
// is another path and not a restructure.

describe('the settings route', () => {
  it.each<[string, Route]>([
    ['/settings/ladder', { name: 'settings', section: 'ladder' }],
    ['#/settings/ladder', { name: 'settings', section: 'ladder' }],
    ['/settings/ladder/', { name: 'settings', section: 'ladder' }],
    ['/settings', { name: 'settings', section: 'ladder' }],
  ])('parses %s', (path, route) => {
    expect(parseRoute(path)).toEqual(route);
  });
  it.each(['/settings/nope', '/settings/ladder/x', '/settings/Ladder', '/setting'])('sends %s to not found', (path) => {
    expect(parseRoute(path).name).toBe('notFound');
  });
  it('builds its path and round-trips', () => {
    const route: Route = { name: 'settings', section: 'ladder' };
    expect(buildPath(route)).toBe('/settings/ladder');
    expect(parseRoute(buildPath(route))).toEqual(route);
  });
  it('lights the Settings tab', () => {
    expect(tabOf({ name: 'settings', section: 'ladder' })).toBe('settings');
  });
  it('needs policy.read to open', () => {
    expect(permissionFor({ name: 'settings', section: 'ladder' })).toBe('policy.read');
  });
  it('is the last item of the Detailed nav, for a role that can read the policy', () => {
    const last = TABS[TABS.length - 1];
    expect(last).toMatchObject({ tab: 'settings', route: { name: 'settings', section: 'ladder' }, label: 'hub.nav.settings', permission: 'policy.read' });
  });
});
