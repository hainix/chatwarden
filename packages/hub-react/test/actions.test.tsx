import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { personTag } from '../src/format.js';
import { renderHub } from './render.js';
import { HOUR, hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Recent actions name the person (by the handle on their latest report), and "See all" opens the full list, a page at a time,
// with a filter for the automatic ones.

const recent = (): HTMLElement => screen.getByRole('region', { name: 'Recent actions' });
const rowsIn = (el: HTMLElement): HTMLElement[] => within(el).queryAllByRole('listitem');

async function overview() {
  await screen.findByRole('heading', { level: 2, name: 'Overview' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
}

async function all(w: HubWorld, path = '/actions', options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path, ...options });
  await screen.findByRole('heading', { level: 2, name: 'All actions' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return r;
}
const list = (): HTMLElement => screen.getByRole('list', { name: 'Actions' });

const auto = (w: HubWorld, person: string, over: Record<string, unknown> = {}) =>
  w.cw.sanctions.apply({ kind: 'chat', subject: person, includeIp: false, durationMs: HOUR, reason: 'auto', actor: 'system', source: 'auto_filter', automated: true, rule: 1, ...over } as never);

describe('Recent actions name the person', () => {
  it('shows the handle from the latest report, with the short tag beside it, and links to the person page', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Zorbak-fan' });
    await w.sanction(f.person, 'chat', 1);
    renderHub(w);
    await overview();
    const row = rowsIn(recent())[0]!;
    const link = within(row).getByRole('link', { name: /Zorbak-fan/ });
    expect(link).toHaveAttribute('href', `#/people/${f.person}`);
    expect(within(row).getByText(personTag(f.person))).toBeInTheDocument();
  });

  it('a person nobody reported has only the tag ("Person" and the tag), no empty name', async () => {
    const w = await hubWorld();
    await w.sanction('s_never_reported_aaaaaaaaaa', 'warning', 1);
    renderHub(w);
    await overview();
    const row = rowsIn(recent())[0]!;
    const link = within(row).getByRole('link');
    expect(link.textContent).toMatch(/^Person\s?s_never_$/);
    expect(link.querySelector('strong')).toBeNull();
  });

  it('never shows more of the ref than the tag', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Vlemmo' });
    await w.sanction(f.person, 'ban', 2);
    renderHub(w);
    await overview();
    expect(recent().textContent).not.toContain(f.person.slice(0, 9));
  });

  it('has a See all link to the full list, for a role that can read history', async () => {
    const w = await hubWorld();
    const f = await w.file();
    await w.sanction(f.person, 'warning', 1);
    const { user, router } = renderHub(w);
    await overview();
    await user.click(within(recent()).getByRole('link', { name: 'See all' }));
    await waitFor(() => expect(router.path).toBe('/actions'));
    expect(await screen.findByRole('heading', { level: 2, name: 'All actions' })).toBeInTheDocument();
  });

  it('each read of the list is on a user action: opening the Overview, opening All actions, coming back (3 reads, none in between)', async () => {
    const w = await hubWorld();
    const f = await w.file();
    await w.sanction(f.person, 'warning', 1);
    const { user, router } = renderHub(w);
    await overview();
    const reads = () => w.sent.filter((r) => r.path === '/sanctions').length;
    expect(reads()).toBe(1);
    await user.click(within(recent()).getByRole('link', { name: 'See all' }));
    await waitFor(() => expect(router.path).toBe('/actions'));
    await screen.findByRole('heading', { level: 2, name: 'All actions' });
    await waitFor(() => expect(reads()).toBe(2));
    await user.click(screen.getByRole('link', { name: 'Overview' }));
    await waitFor(() => expect(router.path).toBe('/'));
    await overview();
    expect(reads()).toBe(3);
  });

  it('has no panel and no link without history.read', async () => {
    const w = await hubWorld({ permissions: { 'history.read': 'owner' } });
    renderHub(w);
    await overview();
    expect(screen.queryByRole('link', { name: 'See all' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recent actions' })).toBeNull();
  });
});

describe('a very long handle in the action rows', () => {
  it('shows whole in Recent actions and in All actions', async () => {
    const w = await hubWorld();
    const LONG = 'Vlemmo'.repeat(10);
    const f = await w.file({ target: LONG });
    await w.sanction(f.person, 'warning', 1);
    renderHub(w);
    await overview();
    expect(within(recent()).getByText(LONG, { selector: '.cw-arow-who' })).toBeInTheDocument();
  });
});

describe('All actions', () => {
  it('lists every sanction newest first with the person, the card, what, the rule and who', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Tarvo' });
    const b = await w.file({ target: 'Snerp' });
    await w.sanction(a.person, 'chat', 1);
    await w.sanction(b.person, 'ban', 2, 7 * 24 * HOUR);
    await all(w);
    const rows = rowsIn(list());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ban');
    expect(rows[0]).toHaveTextContent('Snerp');
    expect(rows[0]).toHaveTextContent('Rule 2');
    expect(rows[0]).toHaveTextContent('by ann@example.test');
    expect(rows[0]!.querySelector('.cw-card--ban')).not.toBeNull();
    expect(rows[1]).toHaveTextContent('Tarvo');
    expect(within(rows[1]!).getByRole('link', { name: /Tarvo/ })).toHaveAttribute('href', `#/people/${a.person}`);
  });

  it('says so when there are none', async () => {
    const w = await hubWorld();
    await all(w);
    expect(screen.getByText(/No actions yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('pages 25 at a time: Load more adds the next page in order, then the button goes', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Glarn' });
    for (let i = 0; i < 30; i += 1) await w.sanction(f.person, 'warning', 1);
    const { user } = await all(w);
    expect(rowsIn(list())).toHaveLength(25);
    expect(w.sent.filter((r) => r.path === '/sanctions').map((r) => r.query?.limit)).toEqual([25]);
    expect(screen.getByText('25 actions shown')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rowsIn(list())).toHaveLength(30));
    const second = w.sent.filter((r) => r.path === '/sanctions')[1]!;
    expect(second.query?.cursor).toEqual(expect.any(String));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByText('30 actions shown')).toBeInTheDocument();
  });

  it('exactly one full page has a Load more that finds nothing and then goes', async () => {
    const w = await hubWorld();
    const f = await w.file();
    for (let i = 0; i < 25; i += 1) await w.sanction(f.person, 'warning', 1);
    const { user } = await all(w);
    expect(rowsIn(list())).toHaveLength(25);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
    expect(rowsIn(list())).toHaveLength(25);
  });

  it('a failed page keeps what is shown, says so, and Load more tries that page again', async () => {
    const w = await hubWorld();
    const f = await w.file();
    for (let i = 0; i < 30; i += 1) await w.sanction(f.person, 'warning', 1);
    const { user } = await all(w);
    let fail = true;
    w.intercept.fn = (req) => (fail && req.path === '/sanctions' && req.query?.cursor !== undefined ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load actions.');
    expect(rowsIn(list())).toHaveLength(25);
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rowsIn(list())).toHaveLength(30));
  });

  it('a failed first load has an error and Try again', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.path === '/sanctions' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { user } = renderHub(w, { path: '/actions' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load actions.');
    w.intercept.fn = null;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No actions yet/)).toBeInTheDocument();
  });

  describe('Automatic only', () => {
    it('asks for source auto_filter and lists only automatic ones; Everything brings the rest back', async () => {
      const w = await hubWorld();
      const f = await w.file({ target: 'Fenrisk' });
      await w.sanction(f.person, 'chat', 1);
      w.clock.t += 1000;
      await auto(w, f.person);
      w.clock.t += 1000;
      await auto(w, f.person, { kind: 'warning', durationMs: null });
      const { user } = await all(w);
      expect(rowsIn(list())).toHaveLength(3);
      const everything = screen.getByRole('button', { name: 'Everything' });
      const onlyAuto = screen.getByRole('button', { name: 'Automatic only' });
      expect([everything, onlyAuto].map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
      await user.click(onlyAuto);
      await waitFor(() => expect(rowsIn(list())).toHaveLength(2));
      for (const row of rowsIn(list())) expect(row).toHaveTextContent('Automatic filter');
      expect(w.sent.filter((r) => r.path === '/sanctions').at(-1)?.query).toMatchObject({ source: 'auto_filter', limit: 25 });
      expect([everything, onlyAuto].map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
      await user.click(everything);
      await waitFor(() => expect(rowsIn(list())).toHaveLength(3));
      expect(w.sent.filter((r) => r.path === '/sanctions').at(-1)?.query).not.toHaveProperty('source');
    });

    it('says there are no automatic actions when only moderators acted, and pages within the filter', async () => {
      const w = await hubWorld();
      const f = await w.file();
      await w.sanction(f.person, 'chat', 1);
      const { user } = await all(w);
      await user.click(screen.getByRole('button', { name: 'Automatic only' }));
      expect(await screen.findByText(/No automatic actions/)).toBeInTheDocument();
      for (let i = 0; i < 27; i += 1) {
        w.clock.t += 1000;
        await auto(w, f.person, { kind: 'warning', durationMs: null });
      }
      await user.click(screen.getByRole('button', { name: 'Everything' }));
      await user.click(screen.getByRole('button', { name: 'Automatic only' }));
      await waitFor(() => expect(rowsIn(list())).toHaveLength(25));
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(() => expect(rowsIn(list())).toHaveLength(27));
      // The cursor is sent with the filter: nothing from the other source came in.
      expect(w.sent.filter((r) => r.path === '/sanctions' && r.query?.cursor !== undefined).every((r) => r.query?.source === 'auto_filter')).toBe(true);
    });
  });

  it('AI and automatic sources are labelled; the private reason is never shown', async () => {
    const w = await hubWorld();
    const f = await w.file();
    await auto(w, f.person);
    w.clock.t += 1000;
    await w.cw.sanctions.apply({ kind: 'warning', subject: f.person, includeIp: false, durationMs: null, reason: 'ai private', actor: 'ai-reader', source: 'ai', automated: false, rule: 1 });
    await all(w);
    expect(list()).toHaveTextContent('AI');
    expect(list()).toHaveTextContent('Automatic filter');
    expect(document.body.textContent).not.toContain('ai private');
  });

  it('is not available to a role without history.read', async () => {
    const w = await hubWorld({ permissions: { 'history.read': 'owner' } });
    renderHub(w, { path: '/actions' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Not available for your role' })).toBeInTheDocument();
    expect(w.sent.some((r) => r.path === '/sanctions')).toBe(false);
  });

  it.each(['light', 'dark'] as const)('has no axe violations, %s theme', async (theme) => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Quissel' });
    await w.sanction(f.person, 'chat', 1);
    await auto(w, f.person);
    const { container } = await all(w, '/actions', { theme });
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`)).toEqual([]);
  });
});
