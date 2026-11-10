import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The workbench shell under axe, in both themes: the queue pane with claims and viewers, the case panel, the command bar, the
// shortcut sheet, a toast, the offline banner and the loading skeletons. jsdom has no layout or painted colours, so the
// `color-contrast` rule is off here; the stylesheet's contrast is computed from its tokens by the static tests.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function busy(): Promise<HubWorld> {
  const w = await hubWorld({ role: 'senior', actor: 'ann@example.test' });
  const a = await w.file({ target: 'Vantablob', category: 'hate' });
  w.clock.t += 1000;
  const b = await w.file({ target: 'GrimJaw' });
  await w.file({ target: 'Ostrander', category: 'spam' });
  // The first case has waited over a day (red), and the claims and viewers are fresh.
  w.clock.t += 30 * 3_600_000;
  await w.client.claimCase(a.person);
  await w.clientFor('maya@example.test').claimCase(b.person);
  await w.clientFor('ana@example.test').viewing(a.person);
  await w.sanction(a.person, 'chat', 1);
  await w.sanction(a.person, 'warning', 1);
  await w.sanction(b.person, 'ban', 2);
  return w;
}

async function ready() {
  const pane = await screen.findByRole('region', { name: 'Open cases' });
  await waitFor(() => expect(within(pane).queryByText('Loading the queue')).not.toBeInTheDocument());
}

describe.each(['light', 'dark'] as const)('axe on the workbench, %s theme', (theme) => {
  it('the team view with the queue pane (claims, viewers, an overdue wait) has no violations', async () => {
    const w = await busy();
    const { container } = renderHub(w, { theme });
    await ready();
    await screen.findByRole('region', { name: 'Recent actions' });
    await waitFor(() => expect(screen.queryByText('Loading')).not.toBeInTheDocument());
    expect(await violations(container)).toEqual([]);
  });

  it('an open case with its case panel has no violations', async () => {
    const w = await busy();
    const first = (await w.client.listReports({ status: 'open', limit: 1 })).items[0]!;
    const { container } = renderHub(w, { theme, path: `/reports/${first.id}` });
    await ready();
    await screen.findByRole('complementary', { name: 'About this case' });
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    await waitFor(() => expect(screen.queryByText('Loading')).not.toBeInTheDocument());
    expect(await violations(container)).toEqual([]);
  });

  it('the command bar, open with results, has no violations', async () => {
    const w = await busy();
    const { container, user } = renderHub(w, { theme });
    await ready();
    await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
    await user.keyboard('a');
    expect(await violations(container)).toEqual([]);
  });

  it('the command bar with no results has no violations', async () => {
    const w = await busy();
    const { container, user } = renderHub(w, { theme });
    await ready();
    await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
    await user.keyboard('zzzz');
    expect(await violations(container)).toEqual([]);
  });

  it('the shortcut sheet has no violations', async () => {
    const w = await busy();
    const { container, user } = renderHub(w, { theme });
    await ready();
    await user.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('a toast, and the offline banner, have no violations', async () => {
    const w = await busy();
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const { container } = renderHub(w, { theme });
    expect(await screen.findByRole('alert')).toHaveTextContent('You are offline');
    expect(await violations(container)).toEqual([]);
  });

  it('a toast with Undo has no violations', async () => {
    const w = await busy();
    const { container, user } = renderHub(w, { theme });
    await ready();
    await user.click(await screen.findByRole('button', { name: /^Release the case against Vantablob/ }));
    await screen.findByText('You released the case against Vantablob.');
    expect(await violations(container)).toEqual([]);
  });

  it('while the queue is loading (skeletons), has no violations', async () => {
    const w = await busy();
    const { container } = renderHub(w, { theme });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(await violations(container)).toEqual([]);
  });

  it('with the queue failed, has no violations', async () => {
    const w = await busy();
    w.intercept.fn = (req) => (req.path === '/reports' || req.path === '/changes' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { container } = renderHub(w, { theme });
    await within(container).findAllByText(/Could not load the reports/);
    expect(await violations(container)).toEqual([]);
  });

  it('a role that cannot read reports (no queue pane) has no violations', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.read': 'owner' } });
    const { container } = renderHub(w, { theme });
    await screen.findByRole('region', { name: 'Recent actions' });
    expect(await violations(container)).toEqual([]);
  });
});

describe('the shell structure', () => {
  it('has one h1, one main, one nav, a banner, and the queue as a labelled region', async () => {
    const w = await busy();
    const { container } = renderHub(w);
    await ready();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelectorAll('nav')).toHaveLength(1);
    expect(container.querySelectorAll('header')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Open cases' })).toBeInTheDocument();
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });
});
