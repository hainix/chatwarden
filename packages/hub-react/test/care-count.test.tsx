import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCare, setCare } from '../src/care.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The careful view's counter and the break note (design 7): one count per case opened, kept in the browser by the browser's own local date, shown only in the panel; a dismissible,
// non-modal note at N excerpts opened and again at 2N. With counting off nothing is stored.

beforeEach(() => {
  resetCare();
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});
afterEach(() => {
  resetCare();
  vi.restoreAllMocks();
});

async function cases(n: number): Promise<{ w: HubWorld; ids: string[] }> {
  const w = await hubWorld();
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push((await w.fileRich({ target: `Target${i}`, reporter: `Reporter${i}` })).id);
  return { w, ids };
}
const showButton = (): HTMLElement => screen.getByRole('button', { name: /^Show the chat/ });
async function openCase(w: HubWorld, id: string, user: ReturnType<typeof renderHub>['user'], router: { navigate: (p: string) => void }) {
  router.navigate(`/reports/${id}`);
  await screen.findByRole('button', { name: /^Show the chat/ });
  await user.click(showButton());
}
const dayKeys = (): string[] => Object.keys(localStorage).filter((k) => k.includes('care'));

describe('the counter', () => {
  it('counts one per case opened, however many buttons are pressed in it', async () => {
    const { w, ids } = await cases(2);
    setCare({ hideExcerpts: true, countOpened: true });
    const { user, router } = renderHub(w, { path: `/reports/${ids[0]}` });
    await screen.findByRole('button', { name: /^Show the chat/ });
    await user.click(showButton());
    // The other buttons (note) are gone: opening is for the whole case, and counted once.
    expect(screen.queryByRole('button', { name: /^Show the/ })).toBeNull();
    await openCase(w, ids[1] as string, user, router);
    router.navigate('/settings/advanced');
    const region = await screen.findByRole('region', { name: 'Your own view' });
    expect(within(region).getByText('Opened today: 2')).toBeInTheDocument();
  });

  it('is shown only in the panel: never on a case, in the queue or in the top bar', async () => {
    const { w, ids } = await cases(1);
    setCare({ hideExcerpts: true, countOpened: true });
    const { user } = renderHub(w, { path: `/reports/${ids[0]}` });
    await screen.findByRole('button', { name: /^Show the chat/ });
    await user.click(showButton());
    expect(screen.queryByText(/Opened today/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/opened \d+ excerpt|Opened today/i);
  });

  it('resets at the browser\'s local midnight', async () => {
    const { w, ids } = await cases(3);
    setCare({ hideExcerpts: true, countOpened: true });
    // 23:30 local on a day, by the hub's clock; two cases opened.
    w.clock.t = new Date(2027, 0, 15, 23, 30, 0).getTime();
    const { user, router } = renderHub(w, { path: `/reports/${ids[0]}` });
    await screen.findByRole('button', { name: /^Show the chat/ });
    await user.click(showButton());
    await openCase(w, ids[1] as string, user, router);
    router.navigate('/settings/advanced');
    expect(within(await screen.findByRole('region', { name: 'Your own view' })).getByText('Opened today: 2')).toBeInTheDocument();
    // Past local midnight: the day turns over, so the next case is the first of the new day.
    act(() => {
      w.clock.t = new Date(2027, 0, 16, 0, 5, 0).getTime();
    });
    await openCase(w, ids[2] as string, user, router);
    router.navigate('/settings/advanced');
    expect(within(await screen.findByRole('region', { name: 'Your own view' })).getByText('Opened today: 1')).toBeInTheDocument();
  });

  it('with counting off nothing is stored: not the count, not the day', async () => {
    const { w, ids } = await cases(2);
    setCare({ hideExcerpts: true });
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const { user, router } = renderHub(w, { path: `/reports/${ids[0]}` });
    await screen.findByRole('button', { name: /^Show the chat/ });
    await user.click(showButton());
    await openCase(w, ids[1] as string, user, router);
    expect(set.mock.calls.filter(([k]) => /day|count|opened/i.test(String(k)))).toEqual([]);
    expect(dayKeys().filter((k) => /day|opened/.test(k))).toEqual([]);
    router.navigate('/settings/advanced');
    const region = await screen.findByRole('region', { name: 'Your own view' });
    expect(within(region).queryByText(/Opened today/)).toBeNull();
  });

  it('the count lives in this browser only: no request carries it, or any of the care settings', async () => {
    const { w, ids } = await cases(2);
    setCare({ hideExcerpts: true, countOpened: true, breakAfter: 10 });
    const { user, router } = renderHub(w, { path: `/reports/${ids[0]}` });
    await screen.findByRole('button', { name: /^Show the chat/ });
    await user.click(showButton());
    await openCase(w, ids[1] as string, user, router);
    const traffic = JSON.stringify(w.sent);
    expect(traffic).not.toMatch(/care|hideExcerpts|countOpened|breakAfter|opened|excerpts today/i);
    expect(w.sent.every((r) => r.method === 'GET' || r.method === 'POST' || r.method === 'DELETE' || r.method === 'PUT')).toBe(true);
  });
});

describe('the break note', () => {
  async function setup(breakAfter = 2, n = 5) {
    const { w, ids } = await cases(n);
    // The panel offers 10, 25 and 50; the logic takes any N, so a small one keeps the test short.
    setCare({ hideExcerpts: true, countOpened: true, breakAfter });
    const view = renderHub(w, { path: `/reports/${ids[0]}` });
    await screen.findByRole('button', { name: /^Show the chat/ });
    return { w, ids, ...view };
  }
  const note = (): HTMLElement | null => screen.queryByText(/A short break may help/)?.closest('[role="status"]') ?? null;

  it('appears at N, again at 2N, never before', async () => {
    const { w, ids, user, router } = await setup(2, 5);
    await user.click(showButton());
    expect(note()).toBeNull();
    await openCase(w, ids[1] as string, user, router);
    expect(note()).not.toBeNull();
    expect(note()).toHaveTextContent('You have opened 2 excerpts today. A short break may help.');
    await openCase(w, ids[2] as string, user, router);
    expect(note()).toBeNull();
    await openCase(w, ids[3] as string, user, router);
    expect(note()).toHaveTextContent('You have opened 4 excerpts today.');
  });

  it('is a polite status, takes no focus, does not block the case and is not a modal', async () => {
    const { w, ids, user, router } = await setup(2, 3);
    await user.click(showButton());
    await openCase(w, ids[1] as string, user, router);
    const el = note() as HTMLElement;
    expect(el).toHaveAttribute('role', 'status');
    expect(document.activeElement).not.toBe(el);
    expect(el.contains(document.activeElement)).toBe(false);
    expect(el.closest('[role="dialog"], [aria-modal="true"]')).toBeNull();
    // The case is still there to work: its tabs and its buttons answer.
    await user.click(screen.getByRole('tab', { name: /^Reports/ }));
    expect(screen.getByRole('tab', { name: /^Reports/ })).toHaveAttribute('aria-selected', 'true');
    expect(w.sent.filter((r) => r.method === 'POST' && /decide/.test(r.path))).toEqual([]);
  });

  it('closes with its button and with Escape, and Escape does not also leave the case', async () => {
    const { w, ids, user, router } = await setup(2, 4);
    await user.click(showButton());
    await openCase(w, ids[1] as string, user, router);
    await user.click(within(note() as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    expect(note()).toBeNull();
    await openCase(w, ids[2] as string, user, router);
    await openCase(w, ids[3] as string, user, router);
    expect(note()).not.toBeNull();
    const here = router.path;
    await user.keyboard('{Escape}');
    expect(note()).toBeNull();
    expect(router.path).toBe(here);
  });

  it('is off unless chosen: with no break set it never appears', async () => {
    const { w, ids } = await cases(3);
    setCare({ hideExcerpts: true, countOpened: true });
    const { user, router } = renderHub(w, { path: `/reports/${ids[0]}` });
    await screen.findByRole('button', { name: /^Show the chat/ });
    await user.click(showButton());
    await openCase(w, ids[1] as string, user, router);
    await openCase(w, ids[2] as string, user, router);
    expect(screen.queryByText(/A short break may help/)).toBeNull();
  });

  it('needs counting: a break choice with counting off never appears (nothing is counted to reach it)', async () => {
    const { w, ids } = await cases(3);
    setCare({ hideExcerpts: true, breakAfter: 10 });
    const { user, router } = renderHub(w, { path: `/reports/${ids[0]}` });
    await screen.findByRole('button', { name: /^Show the chat/ });
    await user.click(showButton());
    await openCase(w, ids[1] as string, user, router);
    expect(screen.queryByText(/A short break may help/)).toBeNull();
  });

  it('the panel offers 10, 25 and 50 and remembers the choice', async () => {
    const w = await hubWorld();
    const { user } = renderHub(w, { path: '/settings/advanced' });
    const region = await screen.findByRole('region', { name: 'Your own view' });
    const select = within(region).getByRole('combobox', { name: 'Offer a break' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Off', 'After 10 excerpts', 'After 25 excerpts', 'After 50 excerpts']);
    await user.selectOptions(select, 'After 25 excerpts');
    await waitFor(() => expect(localStorage.getItem('chatwarden.hub.care.break')).toBe('25'));
  });
});
