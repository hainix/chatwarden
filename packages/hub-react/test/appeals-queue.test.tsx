import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { appealsHub } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { baseline, normalized } from './baseline.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { WorldOptions } from './world.js';

// The Appeals view of the queue (appeals, design 4.9): a switch beside the filters, only with appeals on and appeals.read; in Simple, one quiet line when there
// is work. With the feature off (or the permission missing) the queue pane, Simple's list and its menu are what 0.1.7 drew: byte for byte (files made from
// 0.1.7's own output).

async function twoPeople(w: { file: AppealsHub['file']; clock: AppealsHub['clock'] }) {
  await w.file({ target: 'Alpha', reporter: 'Rep-A' });
  w.clock.t += 1000;
  await w.file({ target: 'Bravo', reporter: 'Rep-B' });
}
const paneOf = async (n = 2): Promise<HTMLElement> => {
  const pane = await screen.findByRole('region', { name: 'Open cases' });
  await waitFor(() => expect(within(pane).getAllByRole('listitem').length).toBe(n));
  return pane;
};
const homeOf = (): Element => screen.getByRole('heading', { level: 2, name: 'Cases' }).closest('.cw-screen') as Element;

describe('with appeals off the pages are what 0.1.7 drew', () => {
  it('the queue pane in Detailed', async () => {
    const w = await hubWorld();
    await twoPeople(w);
    renderHub(w, { path: '/reports' });
    await expect(normalized(await paneOf())).toMatchFileSnapshot(baseline('queue-pane-detailed'));
  });

  it('the queue pane, the Simple list and the Simple menu in Simple', async () => {
    const w = await hubWorld();
    await twoPeople(w);
    const { container } = renderHub(w, { path: '/', mode: 'simple' });
    await expect(normalized(await paneOf())).toMatchFileSnapshot(baseline('queue-pane-simple'));
    await expect(normalized(homeOf())).toMatchFileSnapshot(baseline('simple-home'));
    await expect(normalized(container.querySelector('nav.cw-snav') as Element)).toMatchFileSnapshot(baseline('simple-nav'));
  });
});

describe('appeals on, but the caller may not read them: the same pages, byte for byte', () => {
  const closed: WorldOptions = { permissions: { 'appeals.read': 'owner' } };

  it('Detailed', async () => {
    const w = await appealsHub(closed);
    await twoPeople(w);
    await w.appeal({ target: 'Mallory' });
    renderHub(w, { path: '/reports' });
    expect((await w.client.me()).features).toEqual({ appeals: true, renames: false, keepBlocked: false });
    await expect(normalized(await paneOf())).toMatchFileSnapshot(baseline('queue-pane-detailed'));
    expect(screen.queryByRole('group', { name: 'List' })).toBeNull();
  });

  it('Simple, even with an appeal waiting', async () => {
    const w = await appealsHub(closed);
    await twoPeople(w);
    await w.appeal({ target: 'Mallory' });
    const { container } = renderHub(w, { path: '/', mode: 'simple' });
    await expect(normalized(await paneOf())).toMatchFileSnapshot(baseline('queue-pane-simple'));
    await expect(normalized(homeOf())).toMatchFileSnapshot(baseline('simple-home'));
    await expect(normalized(container.querySelector('nav.cw-snav') as Element)).toMatchFileSnapshot(baseline('simple-nav'));
  });
});

describe('the switch, with appeals on and appeals.read', () => {
  async function ready(o: WorldOptions = {}, mode: 'detailed' | 'simple' = 'detailed', path = '/reports') {
    const w = await appealsHub(o);
    await twoPeople(w);
    const a1 = await w.appeal({ target: 'Mallory' });
    w.clock.t += 1000;
    const a2 = await w.appeal({ target: 'Natasha', kind: 'ban', durationMs: null });
    const r = renderHub(w, { path, mode });
    await paneOf();
    return { w, a1, a2, ...r };
  }
  const group = (): HTMLElement => screen.getByRole('group', { name: 'List' });

  it('is there beside the filters: Reports (pressed) and Appeals with the number waiting', async () => {
    await ready();
    const buttons = within(group()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Reports', 'Appeals (2)']);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });

  it('has no number when none is waiting', async () => {
    const w = await appealsHub();
    await twoPeople(w);
    renderHub(w, { path: '/reports' });
    await paneOf();
    expect(within(group()).getByRole('button', { name: 'Appeals' })).toBeInTheDocument();
  });

  it('is not in Simple, which has its own quiet line', async () => {
    await ready({}, 'simple', '/');
    expect(screen.queryByRole('group', { name: 'List' })).toBeNull();
  });

  it('Appeals opens the Appeals view: the pane lists the open appeals, oldest first, and the report filters go', async () => {
    const { user, router, a1, a2 } = await ready();
    await user.click(within(group()).getByRole('button', { name: 'Appeals (2)' }));
    expect(router.path).toBe('/appeals');
    const pane = await screen.findByRole('region', { name: 'Open appeals' });
    const list = await within(pane).findByRole('list', { name: 'Appeals' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Mallory');
    expect(rows[0]).toHaveTextContent('Chat restriction, 6 hours');
    expect(rows[0]).toHaveTextContent('Rule 2');
    expect(rows[1]).toHaveTextContent('Natasha');
    expect(rows[1]).toHaveTextContent('Ban, permanent');
    expect(within(rows[0] as HTMLElement).getByRole('link')).toHaveAttribute('href', `#/appeals/${a1.appealId}`);
    expect(within(rows[1] as HTMLElement).getByRole('link')).toHaveAttribute('href', `#/appeals/${a2.appealId}`);
    // No claim, no Take next, no claim or reason filter, no "new" pill.
    expect(within(pane).queryByRole('button', { name: /take next/i })).toBeNull();
    expect(within(pane).queryByRole('group', { name: 'Show' })).toBeNull();
    expect(within(pane).queryByLabelText('Reported as')).toBeNull();
    expect(within(pane).queryByText(/unclaimed/i)).toBeNull();
    expect(within(group()).getByRole('button', { name: 'Appeals (2)' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(pane).getByText('2 appeals')).toBeInTheDocument();
  });

  it('a row opens the card in the main pane and is marked as the one open', async () => {
    const { user, router, a2 } = await ready();
    await user.click(within(group()).getByRole('button', { name: 'Appeals (2)' }));
    const list = await screen.findByRole('list', { name: 'Appeals' });
    await user.click(within(list).getByRole('link', { name: /Natasha/ }));
    expect(router.path).toBe(`/appeals/${a2.appealId}`);
    expect(await screen.findByRole('heading', { level: 2, name: 'Appeal against Ban, permanent' })).toBeInTheDocument();
    await waitFor(() => expect(within(list).getByRole('link', { name: /Natasha/ })).toHaveAttribute('aria-current', 'true'));
    expect(within(list).getByRole('link', { name: /Mallory/ })).not.toHaveAttribute('aria-current');
  });

  it('opening an appeal by its address shows the Appeals view with it marked', async () => {
    const w = await appealsHub();
    const a = await w.appeal({ target: 'Mallory' });
    renderHub(w, { path: `/appeals/${a.appealId}` });
    const list = await screen.findByRole('list', { name: 'Appeals' });
    await waitFor(() => expect(within(list).getByRole('link', { name: /Mallory/ })).toHaveAttribute('aria-current', 'true'));
    expect(within(group()).getByRole('button', { name: /^Appeals/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Reports goes back to the reports list', async () => {
    const { user, router } = await ready();
    await user.click(within(group()).getByRole('button', { name: 'Appeals (2)' }));
    await screen.findByRole('list', { name: 'Appeals' });
    await user.click(within(group()).getByRole('button', { name: 'Reports' }));
    expect(router.path).toBe('/reports');
    await paneOf();
    expect(within(group()).getByRole('button', { name: 'Reports' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says so when no appeal is waiting', async () => {
    const w = await appealsHub();
    await twoPeople(w);
    renderHub(w, { path: '/appeals' });
    const pane = await screen.findByRole('region', { name: 'Open appeals' });
    expect(await within(pane).findByText('No appeals are waiting.')).toBeInTheDocument();
  });

  it('a decided appeal leaves the list, and the number follows the next read of the queue', async () => {
    const { w, user, a1 } = await ready({ role: 'senior', actor: 'bea@example.test' });
    await user.click(within(group()).getByRole('button', { name: 'Appeals (2)' }));
    const list = await screen.findByRole('list', { name: 'Appeals' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    await w.client.decideAppeal(a1.appealId, { outcome: 'uphold', reason: 'fine' });
    // The queue polls its change token every few seconds; the list follows when it moves.
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1), { timeout: 9000 });
    expect(within(group()).getByRole('button', { name: 'Appeals (1)' })).toBeInTheDocument();
  }, 20_000);

  it('a failed read of the list says so and offers to try again', async () => {
    const w = await appealsHub();
    await w.appeal();
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/appeals' ? { status: 500, headers: {}, body: { error: 'internal', message: 'x' } } : undefined);
    renderHub(w, { path: '/appeals' });
    const pane = await screen.findByRole('region', { name: 'Open appeals' });
    expect(await within(pane).findByRole('alert')).toBeInTheDocument();
    w.intercept.fn = null;
    await userEvent.setup().click(within(pane).getByRole('button', { name: 'Try again' }));
    expect(await within(pane).findByRole('list', { name: 'Appeals' })).toBeInTheDocument();
  });

  it('the appeals list asks for the open appeals only', async () => {
    const { w, user } = await ready();
    await user.click(within(group()).getByRole('button', { name: 'Appeals (2)' }));
    await screen.findByRole('list', { name: 'Appeals' });
    const asks = w.sent.filter((r) => r.method === 'GET' && r.path === '/appeals');
    expect(asks.length).toBeGreaterThan(0);
    for (const r of asks) expect(r.query).toMatchObject({ status: 'open' });
  });
});

describe('Simple: one quiet line when there is work', () => {
  const line = (): HTMLElement | null => screen.queryByRole('link', { name: /appeals? waiting/ });
  const homeReady = async (w: AppealsHub | Awaited<ReturnType<typeof hubWorld>>, o: Parameters<typeof renderHub>[1] = {}) => {
    const r = renderHub(w, { path: '/', mode: 'simple', ...o });
    await screen.findByRole('heading', { level: 2, name: 'Cases' });
    await screen.findByText(/waiting for a decision|all caught up/);
    return r;
  };

  it('"1 appeal waiting" opens the Appeals view', async () => {
    const w = await appealsHub();
    await w.appeal({ target: 'Mallory' });
    const { user, router } = await homeReady(w);
    await waitFor(() => expect(line()).not.toBeNull());
    expect(line()).toHaveTextContent('1 appeal waiting');
    await user.click(line() as HTMLElement);
    expect(router.path).toBe('/appeals');
    const pane = await screen.findByRole('region', { name: 'Open appeals' });
    expect(await within(pane).findByRole('list', { name: 'Appeals' })).toBeInTheDocument();
    // The list is the pane beside the screen, as the cases are: no switch.
    expect(screen.queryByRole('group', { name: 'List' })).toBeNull();
  });

  it('sits at the top of the Cases list, above the cases, and stays while a case is open', async () => {
    const w = await appealsHub();
    const f = await w.file({ target: 'Alpha' });
    await w.appeal({ target: 'Mallory' });
    const { router } = await homeReady(w);
    await waitFor(() => expect(line()).not.toBeNull());
    const pane = screen.getByRole('region', { name: 'Open cases' });
    expect(pane).toContainElement(line() as HTMLElement);
    // above the list of cases in the document
    const list = within(pane).getByRole('list', { name: 'Cases' });
    expect((line() as HTMLElement).compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // and it is not on the landing page as a second copy
    expect(screen.getAllByRole('link', { name: /appeals? waiting/ })).toHaveLength(1);
    // opening a case leaves it there
    router.navigate(`/reports/${f.id}`);
    await screen.findByRole('heading', { level: 2, name: /Alpha/ });
    expect(line()).not.toBeNull();
    expect(line()).toHaveTextContent('1 appeal waiting');
  });

  it('is not in the Appeals view itself (the list is the appeals), and not in Detailed (the switch is)', async () => {
    const w = await appealsHub();
    await w.appeal({ target: 'Mallory' });
    const a = renderHub(w, { path: '/appeals', mode: 'simple' });
    await screen.findByRole('region', { name: 'Open appeals' });
    expect(line()).toBeNull();
    a.unmount();
    renderHub(w, { path: '/reports' });
    await screen.findByRole('group', { name: 'List' });
    expect(line()).toBeNull();
  });

  it('says how many', async () => {
    const w = await appealsHub();
    await w.appeal();
    await w.appeal();
    await w.appeal();
    await homeReady(w);
    await waitFor(() => expect(line()).toHaveTextContent('3 appeals waiting'));
  });

  it('is not there with none waiting', async () => {
    const w = await appealsHub();
    await w.file({ target: 'Alpha' });
    await homeReady(w);
    expect(line()).toBeNull();
  });

  it('is not there with appeals off', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    await homeReady(w);
    expect(line()).toBeNull();
  });

  it('is not there without appeals.read', async () => {
    const w = await appealsHub({ permissions: { 'appeals.read': 'owner' } });
    await w.appeal();
    await homeReady(w);
    expect(line()).toBeNull();
    expect(w.sent.filter((r) => r.path === '/appeals')).toEqual([]);
  });

  it("Simple's menu is unchanged with appeals on (snapshot)", async () => {
    const w = await appealsHub();
    await w.appeal();
    const { container } = await homeReady(w);
    await expect(normalized(container.querySelector('nav.cw-snav') as Element)).toMatchFileSnapshot(baseline('simple-nav'));
  });

  it('the line is quiet: plain text in the page, not a banner or an alert', async () => {
    const w = await appealsHub();
    await w.appeal();
    await homeReady(w);
    await waitFor(() => expect(line()).not.toBeNull());
    expect((line() as HTMLElement).closest('[role="alert"], [role="status"], .cw-notice, .cw-error')).toBeNull();
  });
});

describe('the Appeals view keeps to its permission', () => {
  it('the screen is closed to a role without appeals.read, like any other', async () => {
    const w = await appealsHub({ permissions: { 'appeals.read': 'owner' } });
    const a = await w.appeal();
    renderHub(w, { path: `/appeals/${a.appealId}` });
    expect(await screen.findByText('Not available for your role')).toBeInTheDocument();
    expect(w.sent.filter((r) => /^\/appeals/.test(r.path))).toEqual([]);
  });

  it('with appeals off, the address finds nothing and asks the server for nothing it would refuse', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/appeals' });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(screen.queryByRole('region', { name: 'Open appeals' })).toBeNull();
    expect(w.sent.filter((r) => /^\/appeals/.test(r.path))).toEqual([]);
  });
});
