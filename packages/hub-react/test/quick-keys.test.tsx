import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUICK_ACT_COOLDOWN_MS } from '../src/case/useQuickActions.js';
import { QUICK_KEYS_KEY, readQuickKeys, resetQuickKeysVisit, writeQuickKeys } from '../src/quickKeys.js';
import { QUEUE_OPEN_DELAY_MS } from '../src/shortcuts.js';
import type { TransportRequest } from '../src/transport.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Keyboard queue mode: Quick keys is a per-moderator choice (on in Simple, off in Detailed) that makes 1, 2 and 3 act at once and
// J, K and the arrow keys open the case they move to. U undoes the newest waiting decision. All on the real routes.

const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const claims = (w: HubWorld): number => w.sent.filter((r) => r.method === 'POST' && /^\/cases\/[^/]+\/claim$/.test(r.path)).length;
const pane = (): HTMLElement => screen.getByRole('region', { name: 'Open cases' });
const focusedName = (): string => (document.activeElement as HTMLElement | null)?.querySelector('.cw-case-name')?.textContent ?? '';
const decision = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });

beforeEach(() => {
  window.localStorage.clear();
  resetQuickKeysVisit();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetQuickKeysVisit();
});

async function world(count = 3) {
  const w = await hubWorld({ actor: 'ann@example.test' });
  const filed = [];
  for (const [i, target] of NAMES.slice(0, count).entries()) {
    filed.push(await w.fileRich({ target, reporter: `Rep${i}`, room: `room-${i}` }));
    w.clock.t += 1000;
  }
  return { w, filed };
}
async function open(count = 3, options: Parameters<typeof renderHub>[1] = {}) {
  cleanup();
  const { w, filed } = await world(count);
  const r = renderHub(w, options);
  await screen.findByRole('region', { name: 'Open cases' });
  await waitFor(() => expect(within(pane()).getAllByRole('link')).toHaveLength(count));
  return { w, filed, ...r };
}
/** The first case open with its decision showing, the quick-key cooldown passed. */
async function openCase(count: number, mode: 'simple' | 'detailed', extra: Parameters<typeof renderHub>[1] = {}) {
  cleanup();
  const { w, filed } = await world(count);
  const r = renderHub(w, { mode, path: `/reports/${filed[0]!.id}`, ...extra });
  const bar = await screen.findByRole('region', { name: 'Decision' });
  await within(bar).findByRole('button', { name: mode === 'simple' ? /^No action needed/ : /^Nothing wrong here/ });
  w.clock.t += QUICK_ACT_COOLDOWN_MS + 1;
  return { w, filed, ...r };
}
const flush = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });

/** A key pressed where focus is (the body when nothing is focused), without user-event so fake timers can run. */
const press = (key: string, init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
};
const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('the preference', () => {
  it('defaults: on in Simple, off in Detailed', () => {
    expect(readQuickKeys('simple')).toBe(true);
    expect(readQuickKeys('detailed')).toBe(false);
  });

  it('the choice is remembered per browser and survives a reload; it wins over the default in both modes', () => {
    writeQuickKeys(false);
    expect(window.localStorage.getItem(QUICK_KEYS_KEY)).toBe('off');
    expect(readQuickKeys('simple')).toBe(false);
    writeQuickKeys(true);
    expect(window.localStorage.getItem(QUICK_KEYS_KEY)).toBe('on');
    expect(readQuickKeys('detailed')).toBe(true);
  });

  it('a value that is neither on nor off is ignored', () => {
    window.localStorage.setItem(QUICK_KEYS_KEY, 'yes');
    expect(readQuickKeys('simple')).toBe(true);
    expect(readQuickKeys('detailed')).toBe(false);
  });

  it('blocked storage falls back to the default and the switch still works for the visit', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readQuickKeys('simple')).toBe(true);
    expect(readQuickKeys('detailed')).toBe(false);
    expect(() => writeQuickKeys(true)).not.toThrow();
    const { user } = await open(2, { mode: 'detailed' });
    await user.keyboard('?');
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    const toggle = within(sheet).getByRole('switch', { name: 'Quick keys' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
  });
});

describe('J and K with Quick keys on', () => {
  it('J moves and opens the case after QUEUE_OPEN_DELAY_MS', async () => {
    const { w, router } = await open(3, { mode: 'simple' });
    vi.useFakeTimers({ toFake: [...FAKE] });
    expect(QUEUE_OPEN_DELAY_MS).toBe(200);
    press('j');
    expect(focusedName()).toBe('Alpha');
    await advance(QUEUE_OPEN_DELAY_MS - 1);
    expect(router.path).toBe('/');
    expect(claims(w)).toBe(0);
    await advance(1);
    expect(router.path).toMatch(/^\/reports\//);
    await advance(50);
    expect(claims(w)).toBe(1);
  });

  it('holding J through five rows opens only the last', async () => {
    const { w, router } = await open(6, { mode: 'simple' });
    vi.useFakeTimers({ toFake: [...FAKE] });
    press('j');
    for (let i = 0; i < 4; i += 1) {
      await advance(50);
      press('j', { repeat: true });
    }
    expect(focusedName()).toBe('Echo');
    await advance(QUEUE_OPEN_DELAY_MS);
    expect(router.path).toMatch(/^\/reports\//);
    expect((router as unknown as { history: string[] }).history.filter((p) => p.startsWith('/reports/'))).toHaveLength(1);
    await advance(50);
    expect(claims(w)).toBe(1);
    await advance(500);
    expect(screen.getByRole('heading', { level: 2, name: 'Echo' })).toBeInTheDocument();
  });

  it('the arrow keys move and open too, from a row', async () => {
    const { router } = await open(3, { mode: 'simple' });
    vi.useFakeTimers({ toFake: [...FAKE] });
    press('j');
    await advance(QUEUE_OPEN_DELAY_MS);
    const first = router.path;
    expect(first).toMatch(/^\/reports\//);
    (within(pane()).getAllByRole('link')[0] as HTMLElement).focus();
    press('ArrowDown');
    expect(focusedName()).toBe('Bravo');
    await advance(QUEUE_OPEN_DELAY_MS);
    expect(router.path).not.toBe(first);
    press('ArrowUp');
    expect(focusedName()).toBe('Alpha');
  });

  it('K moves up and opens', async () => {
    const { router } = await open(3, { mode: 'simple' });
    vi.useFakeTimers({ toFake: [...FAKE] });
    press('k');
    expect(focusedName()).toBe('Charlie');
    await advance(QUEUE_OPEN_DELAY_MS);
    expect(router.path).toMatch(/^\/reports\//);
  });

  it('Escape cancels a pending open and goes back to the queue', async () => {
    const { router } = await open(3, { mode: 'simple' });
    vi.useFakeTimers({ toFake: [...FAKE] });
    press('j');
    await advance(100);
    press('Escape');
    await advance(QUEUE_OPEN_DELAY_MS * 2);
    expect(router.path).toBe('/');
  });

  it('a click on a row before the delay is that click: the pending open does not fire a second time', async () => {
    const { router } = await open(3, { mode: 'simple' });
    vi.useFakeTimers({ toFake: [...FAKE] });
    press('j');
    const bravo = within(pane()).getAllByRole('link')[1] as HTMLElement;
    fireEvent.click(bravo);
    const after = router.path;
    expect(after).toMatch(/^\/reports\//);
    await advance(QUEUE_OPEN_DELAY_MS * 2);
    expect(router.path).toBe(after);
  });

  it('unmounting cancels it', async () => {
    const { router, unmount } = await open(3, { mode: 'simple' });
    vi.useFakeTimers({ toFake: [...FAKE] });
    press('j');
    unmount();
    await advance(QUEUE_OPEN_DELAY_MS * 2);
    expect(router.path).toBe('/');
  });

  it('it opens the row focus is on at that moment, not one the focus has left', async () => {
    const { router } = await open(3, { mode: 'simple' });
    vi.useFakeTimers({ toFake: [...FAKE] });
    press('j');
    (document.activeElement as HTMLElement).blur();
    await advance(QUEUE_OPEN_DELAY_MS * 2);
    expect(router.path).toBe('/');
  });
});

describe('J and K with Quick keys off', () => {
  it('J moves focus and does not open (Enter opens), as today', async () => {
    const { router } = await open(3, { mode: 'detailed' });
    vi.useFakeTimers({ toFake: [...FAKE] });
    press('j');
    expect(focusedName()).toBe('Alpha');
    await advance(QUEUE_OPEN_DELAY_MS * 5);
    expect(router.path).toBe('/');
  });

  it('turned on in Detailed it opens', async () => {
    window.localStorage.setItem(QUICK_KEYS_KEY, 'on');
    const { router } = await open(3, { mode: 'detailed' });
    vi.useFakeTimers({ toFake: [...FAKE] });
    press('j');
    await advance(QUEUE_OPEN_DELAY_MS);
    expect(router.path).toMatch(/^\/reports\//);
  });

  it('turned off in Simple it moves and does not open', async () => {
    window.localStorage.setItem(QUICK_KEYS_KEY, 'off');
    const { router } = await open(3, { mode: 'simple' });
    vi.useFakeTimers({ toFake: [...FAKE] });
    press('j');
    await advance(QUEUE_OPEN_DELAY_MS * 5);
    expect(router.path).toBe('/');
  });

  it('turned off in Simple the digits do not act either', async () => {
    window.localStorage.setItem(QUICK_KEYS_KEY, 'off');
    const { w, user } = await openCase(2, 'simple', { stay: true });
    await user.keyboard('2');
    await flush();
    expect(decides(w)).toHaveLength(0);
  });
});

describe('U undoes the newest waiting decision', () => {
  it('shows its case and says so; U again with nothing waiting is silent', async () => {
    const { w, filed, ...r } = await openCase(2, 'simple');
    await r.user.keyboard('2');
    await screen.findByRole('heading', { level: 2, name: 'Bravo' });
    (document.activeElement as HTMLElement | null)?.blur();
    await r.user.keyboard('u');
    await screen.findByRole('heading', { level: 2, name: 'Alpha' });
    expect(r.router.path).toBe(`/reports/${filed[0]!.id}`);
    expect(await screen.findByText('Undid the decision on Alpha.')).toBeInTheDocument();
    const toasts = within(screen.getByRole('region', { name: 'Notifications' }));
    const before = toasts.queryAllByText(/Undid the decision/).length;
    (document.activeElement as HTMLElement | null)?.blur();
    await r.user.keyboard('u');
    expect(toasts.queryAllByText(/Undid the decision/)).toHaveLength(before);
    await flush();
    expect(decides(w)).toHaveLength(0);
  });

  it('takes the newest of several', async () => {
    const { w, filed, ...r } = await openCase(3, 'simple');
    expect(filed).toHaveLength(3);
    await r.user.keyboard('2');
    await screen.findByRole('heading', { level: 2, name: 'Bravo' });
    w.clock.t += QUICK_ACT_COOLDOWN_MS + 1;
    await r.user.keyboard('2');
    await screen.findByRole('heading', { level: 2, name: 'Charlie' });
    (document.activeElement as HTMLElement | null)?.blur();
    await r.user.keyboard('u');
    await screen.findByRole('heading', { level: 2, name: 'Bravo' });
    (document.activeElement as HTMLElement | null)?.blur();
    await r.user.keyboard('u');
    await screen.findByRole('heading', { level: 2, name: 'Alpha' });
    await flush();
    expect(decides(w)).toHaveLength(0);
  });

  it('U inside the reason box types a u', async () => {
    const { w, filed, ...r } = await openCase(2, 'detailed');
    const bar = screen.getByRole('region', { name: 'Decision' });
    await r.user.click(within(bar).getByRole('button', { name: /^Nothing wrong here/ }));
    await waitFor(() => expect(r.router.path).not.toBe(`/reports/${filed[0]!.id}`));
    const next = await screen.findByRole('region', { name: 'Decision' });
    const reason = await within(next).findByRole('textbox', { name: /Reason/ });
    await r.user.click(reason);
    await r.user.keyboard('u');
    expect(reason).toHaveValue('u');
    expect(r.router.path).not.toBe(`/reports/${filed[0]!.id}`);
    await flush();
    expect(decides(w)).toHaveLength(1);
  });

  it('Detailed: U undoes too, and shows the case again', async () => {
    const { filed, ...r } = await openCase(2, 'detailed');
    const bar = screen.getByRole('region', { name: 'Decision' });
    await r.user.click(within(bar).getByRole('button', { name: /^Nothing wrong here/ }));
    await waitFor(() => expect(r.router.path).not.toBe(`/reports/${filed[0]!.id}`));
    (document.activeElement as HTMLElement | null)?.blur();
    await r.user.keyboard('u');
    await waitFor(() => expect(r.router.path).toBe(`/reports/${filed[0]!.id}`));
    expect(within(decision()).getByRole('button', { name: /^Nothing wrong here/ })).toBeInTheDocument();
  });
});
