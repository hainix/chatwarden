import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/Hub.js';
import { createT, en } from '../src/i18n.js';
import type { HubT } from '../src/i18n.js';
import { memoryRouter } from '../src/router.js';
import type { HubRouter, Route } from '../src/router.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

const tabNames = (): string[] =>
  within(screen.getByRole('navigation', { name: 'Moderator hub sections' }))
    .getAllByRole('link')
    .map((a) => a.textContent ?? '');

describe('Hub: starting up', () => {
  it('says it is loading, then shows the overview with the hub title', async () => {
    const w = await hubWorld();
    renderHub(w);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the hub');
    expect(await screen.findByRole('heading', { level: 1, name: 'Moderation' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();
  });

  it('asks GET /me first and shows who is signed in and their role', async () => {
    const w = await hubWorld({ role: 'senior', actor: 'sam@example.test' });
    renderHub(w);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(w.sent[0]).toMatchObject({ method: 'GET', path: '/me' });
    const who = screen.getByRole('group', { name: 'Signed in' });
    expect(who).toHaveTextContent('sam@example.test');
    expect(who).toHaveTextContent('Senior moderator');
  });

  it('shows a plain full-hub message for 401, and no tabs', async () => {
    const w = await hubWorld({ role: null });
    renderHub(w);
    expect(await screen.findByRole('heading', { name: 'Sign in to use the hub' })).toBeInTheDocument();
    expect(screen.getByText(/did not recognise you/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(w.sent.map((r) => r.path)).toEqual(['/me']);
  });

  it('shows a plain full-hub message for 403, and no tabs', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.path === '/me' ? { status: 403, body: { error: 'forbidden', message: 'Your role cannot do that.' } } : undefined);
    renderHub(w);
    expect(await screen.findByRole('heading', { name: 'No access to the hub' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('shows a start-up failure with Try again, and starts once the server answers', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.path === '/me' ? { status: 500, body: { error: 'internal', message: 'Something went wrong.' } } : undefined);
    const { user } = renderHub(w);
    expect(await screen.findByRole('heading', { name: 'The hub could not start' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The server had a problem');
    w.intercept.fn = null;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('says so when the network is down', async () => {
    const w = await hubWorld();
    w.intercept.fn = () => {
      throw new TypeError('fetch failed');
    };
    renderHub(w);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });
});

describe('Hub: tabs by role', () => {
  it('a moderator sees Overview, Reports, Blocked, Terms, Rule gaps and Guide, and not Audit', async () => {
    const w = await hubWorld({ role: 'moderator' });
    renderHub(w);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(tabNames()).toEqual(['Overview', 'Reports', 'Blocked', 'Terms', 'Rule gaps', 'Guide']);
  });

  it('a senior sees Audit as well, in its place before Guide', async () => {
    const w = await hubWorld({ role: 'senior' });
    renderHub(w);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(tabNames()).toEqual(['Overview', 'Reports', 'Blocked', 'Terms', 'Rule gaps', 'Audit', 'Guide']);
  });

  it('an owner sees every tab', async () => {
    const w = await hubWorld({ role: 'owner' });
    renderHub(w);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(tabNames()).toEqual(['Overview', 'Reports', 'Blocked', 'Terms', 'Rule gaps', 'Audit', 'Guide']);
  });

  it('follows the permissions the server reports, not the role names: raising terms.read hides Terms from a moderator', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'terms.read': 'senior', 'blocked.read': 'owner', 'gaps.read': 'senior' } });
    renderHub(w);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(tabNames()).toEqual(['Overview', 'Reports', 'Guide']);
  });

  it('lowering audit.read shows Audit to a moderator', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'audit.read': 'moderator' } });
    renderHub(w);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(tabNames()).toContain('Audit');
  });

  it('marks the current tab with aria-current and moves it with the route', async () => {
    const w = await hubWorld();
    const { user, router } = renderHub(w);
    await screen.findByRole('heading', { name: 'Overview' });
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Reports' })).not.toHaveAttribute('aria-current');
    await user.click(screen.getByRole('link', { name: 'Reports' }));
    expect(router.path).toBe('/reports');
    expect(await screen.findByRole('heading', { level: 2, name: 'Reports' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reports' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('lights Reports for a report page and gives tabs real hash addresses', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/reports/abc123' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('link', { name: 'Reports' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '#/reports');
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '#/');
  });

  it('lets a modified click (new tab) through instead of navigating', async () => {
    const w = await hubWorld();
    const { user, router } = renderHub(w);
    await screen.findByRole('heading', { name: 'Overview' });
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('link', { name: 'Reports' }));
    await user.keyboard('{/Control}');
    expect(router.path).toBe('/');
  });
});

describe('Hub: screens the role cannot use, unknown paths, and screens still to come', () => {
  it('shows a plain message, not a crash, when a moderator opens #/audit', async () => {
    const w = await hubWorld({ role: 'moderator' });
    renderHub(w, { path: '/audit' });
    expect(await screen.findByRole('heading', { name: 'Not available for your role' })).toBeInTheDocument();
    expect(w.sent.map((r) => r.path)).toEqual(['/me']);
  });

  it('shows "that page does not exist" for an unknown path, with a way back that works', async () => {
    const w = await hubWorld();
    const { user, router } = renderHub(w, { path: '/nope/at/all' });
    expect(await screen.findByRole('heading', { name: 'That page does not exist' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Back to the overview' }));
    expect(router.path).toBe('/');
    expect(await screen.findByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();
  });

  it.each([
    ['/terms', 'Terms'],
    ['/blocked', 'Blocked'],
    ['/gaps', 'Rule gaps'],
    ['/guide', 'Guide'],
    ['/people/abc', 'Person'],
  ])('%s opens a titled placeholder until its screen is built', async (path, name) => {
    const w = await hubWorld({ role: 'owner' });
    renderHub(w, { path });
    expect(await screen.findByRole('heading', { level: 2, name: `${name} is not available yet` })).toBeInTheDocument();
  });
});

describe('Hub: router, callbacks, theme, text', () => {
  it('calls onNavigate for the first route and each change', async () => {
    const w = await hubWorld();
    const seen: Array<[Route['name'], string]> = [];
    const { user } = renderHub(w, { onNavigate: (route, path) => void seen.push([route.name, path]) });
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(screen.getByRole('link', { name: 'Reports' }));
    await screen.findByRole('heading', { level: 2, name: 'Reports' });
    expect(seen).toEqual([
      ['overview', '/'],
      ['reports', '/reports'],
    ]);
  });

  it('follows a router that has no subscribe when the parent renders again with a new path', async () => {
    const w = await hubWorld();
    let path = '/';
    const mk = (): HubRouter => ({ path, navigate: vi.fn() });
    const { rerender } = render(<Hub client={w.client} router={mk()} now={w.now} />);
    await screen.findByRole('heading', { name: 'Overview' });
    path = '/reports';
    rerender(<Hub client={w.client} router={mk()} now={w.now} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Reports' })).toBeInTheDocument();
  });

  it('uses the router the adopter gave for links and for moving', async () => {
    const w = await hubWorld();
    const navigate = vi.fn();
    const router: HubRouter = { path: '/', navigate, href: (p) => `/app/mod${p === '/' ? '' : p}` };
    const { user } = renderHub(w, { router });
    await screen.findByRole('heading', { name: 'Overview' });
    const reports = screen.getByRole('link', { name: 'Reports' });
    expect(reports).toHaveAttribute('href', '/app/mod/reports');
    await user.click(reports);
    expect(navigate).toHaveBeenCalledWith('/reports');
  });

  it('defaults to the URL hash', async () => {
    window.location.hash = '#/reports';
    const w = await hubWorld();
    render(<Hub client={w.client} now={w.now} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Reports' })).toBeInTheDocument();
    window.location.hash = '';
  });

  it('sets data-cw-theme for light and dark, and leaves it off for auto and by default', async () => {
    const w = await hubWorld();
    const { container, rerender } = renderHub(w, { theme: 'dark' });
    await screen.findByRole('heading', { name: 'Overview' });
    const root = container.querySelector('.cw-hub');
    expect(root).toHaveAttribute('data-cw-theme', 'dark');
    rerender(<Hub client={w.client} router={memoryRouter('/')} now={w.now} theme="light" />);
    expect(container.querySelector('.cw-hub')).toHaveAttribute('data-cw-theme', 'light');
    rerender(<Hub client={w.client} router={memoryRouter('/')} now={w.now} theme="auto" />);
    expect(container.querySelector('.cw-hub')).not.toHaveAttribute('data-cw-theme');
    rerender(<Hub client={w.client} router={memoryRouter('/')} now={w.now} />);
    expect(container.querySelector('.cw-hub')).not.toHaveAttribute('data-cw-theme');
  });

  it('adds the adopter className to the root', async () => {
    const w = await hubWorld();
    const { container } = renderHub(w, { className: 'my-hub' });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(container.querySelector('.cw-hub')).toHaveClass('my-hub');
  });

  it('takes its words from the t prop', async () => {
    const w = await hubWorld();
    const base = createT({ ...en, 'hub.nav.reports': 'Meldungen', 'hub.title': 'Moderation (de)' }, 'en');
    const t: HubT = (key, params) => base(key, params);
    renderHub(w, { t });
    expect(await screen.findByRole('heading', { level: 1, name: 'Moderation (de)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Meldungen' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Reports' })).not.toBeInTheDocument();
  });

  it('writes times in the locale prop', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Mallory' });
    w.clock.t += 5 * 60_000;
    renderHub(w, { locale: 'de' });
    await screen.findByRole('heading', { name: 'Overview' });
    await waitFor(() => expect(document.body.textContent).toMatch(/vor \d+ Minuten|5\s?Min/));
  });

  it('moves focus to the main region from the skip link without changing the route', async () => {
    const w = await hubWorld();
    const { user, router } = renderHub(w);
    await screen.findByRole('heading', { name: 'Overview' });
    await user.click(screen.getByRole('button', { name: 'Skip to the main content' }));
    expect(screen.getByRole('main')).toHaveFocus();
    expect(router.path).toBe('/');
  });
});
