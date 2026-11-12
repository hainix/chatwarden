import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../src/Dialog.js';
import { QUICK_ACT_COOLDOWN_MS } from '../src/case/useQuickActions.js';
import { resetQuickKeysVisit } from '../src/quickKeys.js';
import { QUEUE_OPEN_DELAY_MS } from '../src/shortcuts.js';
import type { TransportRequest } from '../src/transport.js';
import { advanceGuardTime } from './guardTime.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Review fix round 1: every act key and button obeys the same two guards (a held key is one action; a case accepts an act key only a
// moment after it appeared, on a monotonic clock), and nothing acts behind a window or while a move to another case is pending.
// The guard clock is frozen in tests and moves only with `advanceGuardTime` (or the world's clock), so "100 ms" and "301 ms" are exact.

const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const decision = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const KEY = 'chatwarden.hub.quickKeys';
const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;
const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });
const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const ctrlEnter = (init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Enter', ctrlKey: true, ...init });
};

beforeEach(() => {
  window.localStorage.clear();
  resetQuickKeysVisit();
});
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  resetQuickKeysVisit();
});

async function cases(names: string[], options: Parameters<typeof hubWorld>[0] = {}) {
  const w = await hubWorld({ actor: 'ann@example.test', ...options });
  const filed = [];
  for (const [i, target] of names.entries()) {
    filed.push(await w.file({ target, reporter: `Rep${i}`, room: `room-${i}` }));
    w.clock.t += 1000;
  }
  return { w, filed };
}

/** The Detailed bar of the first case with "Fair" chosen (so Ctrl+Enter has something to decide). Nothing has aged yet. */
async function detailed(names = ['Alpha', 'Bravo'], props: Parameters<typeof renderHub>[1] = {}) {
  cleanup();
  const { w, filed } = await cases(names);
  const r = renderHub(w, { path: `/reports/${filed[0]!.id}`, mode: 'detailed', ...props });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('button', { name: /^Nothing wrong here/ });
  await r.user.click(within(decision()).getByRole('radio', { name: /Not a problem/ }));
  (document.activeElement as HTMLElement | null)?.blur();
  return { w, filed, ...r };
}

describe('Detailed Ctrl+Enter obeys the act-key guards', () => {
  it('a repeated Ctrl+Enter does nothing, even on a case that has aged', async () => {
    const s = await detailed();
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    ctrlEnter({ repeat: true });
    await pageHides();
    expect(decides(s.w)).toHaveLength(0);
    ctrlEnter();
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
  });

  it('a Ctrl+Enter within 300 ms of the case appearing does nothing; after it, it decides', async () => {
    const s = await detailed();
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS - 1);
    ctrlEnter();
    await pageHides();
    expect(decides(s.w)).toHaveLength(0);
    advanceGuardTime(1);
    ctrlEnter();
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
  });

  it('the second tap of a double Ctrl+Enter, meant for the case just closed, cannot decide the next one', async () => {
    const s = await detailed();
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    ctrlEnter();
    await waitFor(() => expect(s.router.path).toBe(`/reports/${s.filed[1]!.id}`));
    await within(decision()).findByRole('radio', { name: /Not a problem/ });
    await s.user.click(within(decision()).getByRole('radio', { name: /Not a problem/ }));
    (document.activeElement as HTMLElement | null)?.blur();
    advanceGuardTime(100);
    ctrlEnter();
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS);
    ctrlEnter();
    await pageHides();
    expect(decides(s.w)).toHaveLength(2);
  });

  it('Simple with Something else open: the same guards on the bar\'s Ctrl+Enter', async () => {
    cleanup();
    const { w, filed } = await cases(['Alpha', 'Bravo']);
    const r = renderHub(w, { path: `/reports/${filed[0]!.id}`, mode: 'simple' });
    await r.user.click(await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('button', { name: /^Something else/ }));
    await r.user.click(within(decision()).getByRole('radio', { name: /Not a problem/ }));
    (document.activeElement as HTMLElement | null)?.blur();
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    ctrlEnter({ repeat: true });
    await pageHides();
    expect(decides(w)).toHaveLength(0);
  });

  it('the Decide button is unaffected: it is a deliberate click on the form in front of you', async () => {
    const s = await detailed();
    await s.user.click(within(decision()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
  });
});

describe('the hub ignores keys behind any window', () => {
  async function bulkWindow() {
    cleanup();
    const w = await hubWorld({ actor: 'ann@example.test' });
    const held = await w.file({ target: 'Alpha', reporter: 'Zed', room: 'a' });
    w.clock.t += 1000;
    const ids = [];
    for (const [i, reporter] of ['Sam', 'Tess', 'Rita'].entries()) {
      ids.push(await w.file({ target: 'Mallory', reporter, room: `m${i}` }));
      w.clock.t += 1000;
    }
    await w.file({ target: 'Elsewhere', reporter: 'Uma', room: 'e' });
    window.localStorage.setItem(KEY, 'on');
    const r = renderHub(w, { path: `/reports/${held.id}`, mode: 'detailed' });
    await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('button', { name: /^Nothing wrong here/ });
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    // A decision waiting for its Undo (so U would have something to take back).
    await r.user.click(within(decision()).getByRole('button', { name: /^Nothing wrong here/ }));
    await waitFor(() => expect(r.router.path).toMatch(/^\/reports\//));
    await waitFor(() => expect(r.router.path).not.toBe(`/reports/${held.id}`));
    const here = await screen.findByRole('region', { name: 'Decision' });
    await within(here).findByText('Close more reports at once');
    await r.user.click(within(here).getByText('Close more reports at once'));
    const row = within(here).queryByRole('button', { name: /^Dismiss all open reports from/ });
    expect(row).not.toBeNull();
    await r.user.click(row as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: 'Cancel' });
    return { w, held, ids, dialog, ...r };
  }
  const nextCalls = (w: HubWorld): number => w.sent.filter((q) => q.path === '/cases/next').length;

  it('U, N, J and K do nothing while the bulk confirm window is open', async () => {
    const s = await bulkWindow();
    const takes = nextCalls(s.w);
    const path = s.router.path;
    const inWindow = within(s.dialog).getByRole('button', { name: 'Cancel' });
    expect(inWindow).toHaveFocus();
    for (const key of ['u', 'n', 'j', 'k']) fireEvent.keyDown(inWindow, { key });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Undid the decision/)).toBeNull();
    expect(nextCalls(s.w)).toBe(takes);
    expect(s.router.path).toBe(path);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(inWindow).toHaveFocus();
    // The held decision is still waiting: Escape closes the window, and then U takes it back.
    await s.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    await s.user.keyboard('u');
    await screen.findByText(/Undid the decision on/);
  });
});

describe('a pending move to another case', () => {
  async function simple() {
    cleanup();
    const { w, filed } = await cases(['Alpha', 'Bravo', 'Charlie']);
    const r = renderHub(w, { path: `/reports/${filed[0]!.id}`, mode: 'simple' });
    await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('button', { name: /^No action needed/ });
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    vi.useFakeTimers({ toFake: [...FAKE] });
    (document.activeElement as HTMLElement | null)?.blur();
    return { w, filed, ...r };
  }
  const press = (key: string): void => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  };

  it('a digit pressed while J is waiting to open the next case does not act on the case being left', async () => {
    const s = await simple();
    press('j');
    expect(document.querySelector('.cw-hub')).toHaveAttribute('data-cw-moving');
    await advance(100);
    press('2');
    await advance(10);
    expect(decides(s.w)).toHaveLength(0);
    await advance(QUEUE_OPEN_DELAY_MS);
    expect(document.querySelector('.cw-hub')).not.toHaveAttribute('data-cw-moving');
  });

  it('once the case under the cursor is open and has aged, the digit acts on it', async () => {
    const s = await simple();
    press('j');
    await advance(QUEUE_OPEN_DELAY_MS + 20);
    await advance(300);
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    (document.activeElement as HTMLElement | null)?.blur();
    press('2');
    await advance(50);
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(decides(s.w)).toHaveLength(1);
    expect(decides(s.w)[0]!.path).not.toBe(`/reports/${s.filed[0]!.id}/decide`);
  });

  it('the flag is cleared when the pending open is cancelled', async () => {
    await simple();
    press('j');
    expect(document.querySelector('.cw-hub')).toHaveAttribute('data-cw-moving');
    press('Escape');
    expect(document.querySelector('.cw-hub')).not.toHaveAttribute('data-cw-moving');
  });
});

describe('quick-action buttons: a double click never decides the next case', () => {
  async function simple() {
    cleanup();
    const { w, filed } = await cases(['Alpha', 'Bravo']);
    const r = renderHub(w, { path: `/reports/${filed[0]!.id}`, mode: 'simple' });
    await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('button', { name: /^No action needed/ });
    return { w, filed, ...r };
  }
  const dismiss = (): HTMLElement => within(decision()).getByRole('button', { name: /^No action needed/ });

  it('a click on a card that has just appeared does nothing; after 300 ms it acts', async () => {
    const s = await simple();
    fireEvent.click(dismiss());
    await pageHides();
    expect(decides(s.w)).toHaveLength(0);
    expect(dismiss()).toHaveAttribute('aria-disabled', 'true');
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    fireEvent.click(dismiss());
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
  });

  it('the second click of a double click lands on the next card within 300 ms and is ignored', async () => {
    const s = await simple();
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    fireEvent.click(dismiss());
    await screen.findByRole('heading', { level: 2, name: 'Bravo' });
    await within(decision()).findByRole('button', { name: /^No action needed/ });
    advanceGuardTime(100);
    fireEvent.click(dismiss());
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS);
    fireEvent.click(dismiss());
    await pageHides();
    expect(decides(s.w)).toHaveLength(2);
  });

  it('a click that the browser counts as part of a double click (detail 2) is ignored, even on an aged card', async () => {
    const s = await simple();
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    fireEvent.click(dismiss(), { detail: 2 });
    await pageHides();
    expect(decides(s.w)).toHaveLength(0);
    fireEvent.click(dismiss(), { detail: 1 });
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
  });

  it('the Detailed Nothing wrong here button has the same two guards', async () => {
    cleanup();
    const { w, filed } = await cases(['Alpha', 'Bravo']);
    renderHub(w, { path: `/reports/${filed[0]!.id}`, mode: 'detailed' });
    const button = await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('button', { name: /^Nothing wrong here/ });
    fireEvent.click(button);
    await pageHides();
    expect(decides(w)).toHaveLength(0);
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    fireEvent.click(button, { detail: 2 });
    await pageHides();
    expect(decides(w)).toHaveLength(0);
    fireEvent.click(button);
    await pageHides();
    expect(decides(w)).toHaveLength(1);
  });
});

describe('the guard clock is monotonic, not the hub clock', () => {
  it('a hub whose clock is frozen is not locked out: the digits act once 300 ms have passed on the machine', async () => {
    cleanup();
    const { w, filed } = await cases(['Alpha']);
    const frozen = w.now();
    const r = renderHub(w, { path: `/reports/${filed[0]!.id}`, mode: 'simple', now: () => frozen, stay: true });
    await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('button', { name: /^No action needed/ });
    await r.user.keyboard('2');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    await r.user.keyboard('2');
    await pageHides();
    expect(decides(w)).toHaveLength(1);
  });

  it('a hub clock that jumps forward (a clock set right) does not skip the guard', async () => {
    cleanup();
    const { w, filed } = await cases(['Alpha']);
    let t = w.now();
    const r = renderHub(w, { path: `/reports/${filed[0]!.id}`, mode: 'simple', now: () => t, stay: true });
    await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('button', { name: /^No action needed/ });
    t += 3_600_000;
    await r.user.keyboard('2');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
  });
});

describe('smaller fixes of the review', () => {
  it('M5: a person case held by someone else names the holder in the title, not a question nobody can confirm', async () => {
    cleanup();
    const w = await hubWorld({ actor: 'ann@example.test' });
    const ids = [];
    for (const [i, reporter] of ['Sam', 'Tess', 'Rita'].entries()) {
      ids.push(await w.file({ target: 'Mallory', reporter, room: `m${i}` }));
      w.clock.t += 1000;
    }
    await w.clientFor('maya@example.test', 'moderator').claimCase(ids[0]!.person);
    const r = renderHub(w, { path: `/reports/${ids[2]!.id}`, mode: 'detailed' });
    await screen.findByRole('region', { name: 'Decision' });
    const decisionRegion = await screen.findByRole('region', { name: 'Decision' });
    await r.user.click(await within(decisionRegion).findByText('Close more reports at once'));
    await r.user.click(await within(decisionRegion).findByRole('button', { name: /^Dismiss all 3 open reports about/ }));
    const dialog = await screen.findByRole('dialog', { name: /maya is handling this case/ });
    expect(within(dialog).queryByRole('heading', { name: /^Dismiss 3 reports about/ })).toBeNull();
  });

  it('M6: a held toast that was paused by the pointer and then hidden by a newer one still ends on time', async () => {
    const { ToastProvider, useToasts } = await import('../src/toasts.js');
    const { HubContext } = await import('../src/context.js');
    const { createT, en } = await import('../src/i18n.js');
    vi.useFakeTimers({ toFake: [...FAKE, 'Date'] });
    const ref: { api: ReturnType<typeof useToasts> | null } = { api: null };
    function Grab() {
      ref.api = useToasts();
      return null;
    }
    const context = { t: createT(en, 'en') } as never;
    render(
      <HubContext.Provider value={context}>
        <ToastProvider>
          <Grab />
        </ToastProvider>
      </HubContext.Provider>,
    );
    const first = vi.fn();
    act(() => void ref.api!.hold({ text: 'Dismissing A.', run: first }));
    fireEvent.pointerEnter(screen.getByText('Dismissing A.').closest('.cw-toast') as HTMLElement);
    act(() => void ref.api!.hold({ text: 'Dismissing B.', run: () => undefined }));
    expect(screen.queryByText('Dismissing A.')).toBeNull();
    await advance(5_100);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('M7: Tab in a window skips a hidden control', async () => {
    const user = (await import('@testing-library/user-event')).userEvent.setup();
    render(
      <Dialog label="Window" onClose={() => undefined}>
        <button type="button">One</button>
        <button type="button" hidden>
          Hidden
        </button>
        <button type="button">Two</button>
      </Dialog>,
    );
    screen.getByRole('button', { name: 'One' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Two' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'One' })).toHaveFocus();
  });
});
