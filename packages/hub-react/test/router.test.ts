import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPath, hashRouter, memoryRouter, parseRoute, tabOf } from '../src/router.js';
import type { Route } from '../src/router.js';

describe('parseRoute', () => {
  it.each<[string, Route]>([
    ['/', { name: 'overview' }],
    ['', { name: 'overview' }],
    ['#', { name: 'overview' }],
    ['#/', { name: 'overview' }],
    ['/reports', { name: 'reports', status: 'open' }],
    ['#/reports', { name: 'reports', status: 'open' }],
    ['/reports/', { name: 'reports', status: 'open' }],
    ['/reports?status=actioned', { name: 'reports', status: 'actioned' }],
    ['/reports?status=dismissed', { name: 'reports', status: 'dismissed' }],
    ['/reports?status=all', { name: 'reports', status: 'all' }],
    ['/reports?status=open', { name: 'reports', status: 'open' }],
    ['/reports?status=nonsense', { name: 'reports', status: 'open' }],
    ['/reports/abc123', { name: 'report', id: 'abc123' }],
    ['/reports/AbC_-9', { name: 'report', id: 'AbC_-9' }],
    ['/people/p_0123456789', { name: 'person', ref: 'p_0123456789' }],
    ['/terms', { name: 'terms' }],
    ['/blocked', { name: 'blocked' }],
    ['/gaps', { name: 'gaps' }],
    ['/audit', { name: 'audit' }],
    ['/guide', { name: 'guide' }],
    ['/actions', { name: 'actions' }],
    ['#/actions/', { name: 'actions' }],
  ])('parses %j', (path, route) => {
    expect(parseRoute(path)).toEqual(route);
  });

  it.each(['/nope', '/reports/a/b', '/people', '/people/a/b', '/terms/x', '/reports/has space', '/reports/a%2Fb', '/people/../x', '//reports', '/actions/x', '/actions/1/2'])(
    'sends %j to notFound, keeping the path',
    (path) => {
      const r = parseRoute(path);
      expect(r.name).toBe('notFound');
    },
  );

  it('refuses an id longer than the server accepts (64) and one with unsafe characters', () => {
    expect(parseRoute(`/reports/${'a'.repeat(64)}`).name).toBe('report');
    expect(parseRoute(`/reports/${'a'.repeat(65)}`).name).toBe('notFound');
    expect(parseRoute('/reports/a.b').name).toBe('notFound');
    expect(parseRoute('/reports/a%00b').name).toBe('notFound');
    expect(parseRoute('/people/%E0%A4%A').name).toBe('notFound');
  });

  it('ignores a fragment and an unknown query', () => {
    expect(parseRoute('/terms?x=1')).toEqual({ name: 'terms' });
    expect(parseRoute('/reports?x=1&status=all')).toEqual({ name: 'reports', status: 'all' });
  });
});

describe('buildPath', () => {
  it.each<[Route, string]>([
    [{ name: 'overview' }, '/'],
    [{ name: 'reports', status: 'open' }, '/reports'],
    [{ name: 'reports', status: 'actioned' }, '/reports?status=actioned'],
    [{ name: 'reports', status: 'dismissed' }, '/reports?status=dismissed'],
    [{ name: 'reports', status: 'all' }, '/reports?status=all'],
    [{ name: 'report', id: 'abc' }, '/reports/abc'],
    [{ name: 'person', ref: 'p1' }, '/people/p1'],
    [{ name: 'terms' }, '/terms'],
    [{ name: 'blocked' }, '/blocked'],
    [{ name: 'gaps' }, '/gaps'],
    [{ name: 'audit' }, '/audit'],
    [{ name: 'guide' }, '/guide'],
    [{ name: 'actions' }, '/actions'],
  ])('builds %j as %s', (route, path) => {
    expect(buildPath(route)).toBe(path);
  });

  it('builds a notFound route as its own path', () => {
    expect(buildPath({ name: 'notFound', path: '/nope' })).toBe('/nope');
  });

  it('round trips: parse(build(route)) is the route, build(parse(path)) is the normalised path', () => {
    const routes: Route[] = [
      { name: 'overview' },
      { name: 'reports', status: 'open' },
      { name: 'reports', status: 'all' },
      { name: 'report', id: 'a_B-9' },
      { name: 'person', ref: 'abcdef0123456789' },
      { name: 'terms' },
      { name: 'blocked' },
      { name: 'gaps' },
      { name: 'audit' },
      { name: 'guide' },
      { name: 'actions' },
    ];
    for (const route of routes) expect(parseRoute(buildPath(route))).toEqual(route);
    for (const path of ['#/reports/', '/reports?status=open', 'reports', '#/people/p1']) {
      const normal = buildPath(parseRoute(path));
      expect(buildPath(parseRoute(normal))).toBe(normal);
    }
  });
});

describe('tabOf', () => {
  it('lights the Reports tab for a report and a person, and no tab for notFound', () => {
    expect(tabOf({ name: 'overview' })).toBe('overview');
    expect(tabOf({ name: 'reports', status: 'open' })).toBe('reports');
    expect(tabOf({ name: 'report', id: 'a' })).toBe('reports');
    expect(tabOf({ name: 'person', ref: 'a' })).toBe('reports');
    expect(tabOf({ name: 'gaps' })).toBe('gaps');
    // All actions is the Overview's Recent actions, in full.
    expect(tabOf({ name: 'actions' })).toBe('overview');
    expect(tabOf({ name: 'notFound', path: '/x' })).toBeNull();
  });
});

describe('memoryRouter', () => {
  it('starts at the given path (default /) and normalises it', () => {
    expect(memoryRouter().path).toBe('/');
    expect(memoryRouter('/reports').path).toBe('/reports');
    expect(memoryRouter('#/terms').path).toBe('/terms');
    expect(memoryRouter('reports').path).toBe('/reports');
  });
  it('navigates, remembers where it has been and tells subscribers', () => {
    const r = memoryRouter('/');
    const seen: string[] = [];
    const off = r.subscribe((): void => void seen.push(r.path));
    r.navigate('/reports');
    r.navigate('#/terms');
    expect(r.path).toBe('/terms');
    expect(r.history).toEqual(['/', '/reports', '/terms']);
    expect(seen).toEqual(['/reports', '/terms']);
    off();
    r.navigate('/guide');
    expect(seen).toEqual(['/reports', '/terms']);
  });
  it('does not notify when the path does not change', () => {
    const r = memoryRouter('/gaps');
    const fn = vi.fn();
    r.subscribe(fn);
    r.navigate('/gaps');
    r.navigate('gaps');
    expect(fn).not.toHaveBeenCalled();
    expect(r.history).toEqual(['/gaps']);
  });
  it('goes back', () => {
    const r = memoryRouter('/');
    r.navigate('/reports');
    r.navigate('/reports/abc');
    r.back();
    expect(r.path).toBe('/reports');
    r.back();
    r.back();
    expect(r.path).toBe('/');
  });
  it('gives each link a hash href', () => {
    expect(memoryRouter().href('/reports')).toBe('#/reports');
  });
});

describe('hashRouter', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('reads the path from the hash, and an empty hash is /', () => {
    window.location.hash = '';
    const r = hashRouter();
    expect(r.path).toBe('/');
    window.location.hash = '#/reports?status=all';
    expect(r.path).toBe('/reports?status=all');
  });
  it('navigate writes the hash and href builds one', () => {
    const r = hashRouter();
    r.navigate('/terms');
    expect(window.location.hash).toBe('#/terms');
    expect(r.path).toBe('/terms');
    expect(r.href('/gaps')).toBe('#/gaps');
  });
  it('notifies subscribers when the hash changes (back button, typed link) until they unsubscribe', async () => {
    const r = hashRouter();
    // Let hashchange events from earlier tests' writes arrive before listening.
    window.location.hash = '#/start';
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fn = vi.fn();
    const off = r.subscribe(fn);
    window.location.hash = '#/audit';
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    expect(r.path).toBe('/audit');
    off();
    const calls = fn.mock.calls.length;
    window.location.hash = '#/guide';
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fn.mock.calls.length).toBe(calls);
  });
});

describe('the Appeals routes', () => {
  it.each<[string, Route]>([
    ['/appeals', { name: 'appeals' }],
    ['#/appeals', { name: 'appeals' }],
    ['/appeals/', { name: 'appeals' }],
    ['/appeals/abc123', { name: 'appeal', id: 'abc123' }],
    ['/appeals/AbC_-9', { name: 'appeal', id: 'AbC_-9' }],
  ])('parses %j', (path, route) => {
    expect(parseRoute(path)).toEqual(route);
  });

  it.each(['/appeals/a/b', '/appeals/has space', '/appeals/a%2Fb', '/appeals/a.b', `/appeals/${'a'.repeat(65)}`, '/appeal/abc'])('sends %j to notFound', (path) => {
    expect(parseRoute(path).name).toBe('notFound');
  });

  it('builds and parses back, and an id is encoded', () => {
    for (const route of [{ name: 'appeals' }, { name: 'appeal', id: 'abc_-1' }] as Route[]) expect(parseRoute(buildPath(route))).toEqual(route);
    expect(buildPath({ name: 'appeal', id: 'abc' })).toBe('/appeals/abc');
    expect(buildPath({ name: 'appeals' })).toBe('/appeals');
  });

  it('belongs to the Reports tab, with the queue', () => {
    expect(tabOf({ name: 'appeals' })).toBe('reports');
    expect(tabOf({ name: 'appeal', id: 'abc' })).toBe('reports');
  });
});
