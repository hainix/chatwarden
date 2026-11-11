import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/Hub.js';
import { memoryRouter } from '../src/router.js';
import { UNDO_MS } from '../src/toasts.js';
import type { TransportRequest } from '../src/transport.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// Simple or Detailed: where the choice comes from (the prop, then the browser's memory, then Simple), the switch that makes it,
// and what survives a switch: the route, the open case and a decision waiting for its Undo.

const KEY = 'chatwarden.hub.mode';
const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];
const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;
const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const sections = (): HTMLElement => screen.getByRole('navigation', { name: 'Moderator hub sections' });
const view = (): HTMLElement => screen.getByRole('group', { name: 'View' });
const toasts = (): HTMLElement => screen.getByRole('region', { name: 'Notifications' });

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('which mode the hub opens in', () => {
  it('is Simple when nothing is set and nothing is remembered', async () => {
    const w = await hubWorld();
    const { container } = renderHub(w, { mode: undefined });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'simple');
    expect(within(view()).getByRole('button', { name: 'Simple' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(view()).getByRole('button', { name: 'Detailed' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('is what the moderator chose last time, when nothing is set', async () => {
    window.localStorage.setItem(KEY, 'detailed');
    const w = await hubWorld();
    const { container } = renderHub(w, { mode: undefined });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'detailed');
    expect(within(sections()).getByRole('link', { name: 'Overview' })).toBeInTheDocument();
  });

  it.each(['', 'compact', 'SIMPLE', 'null', '{"mode":"detailed"}'])('falls back to Simple for a remembered value that is not a mode (%j)', async (junk) => {
    window.localStorage.setItem(KEY, junk);
    const w = await hubWorld();
    const { container } = renderHub(w, { mode: undefined });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'simple');
  });

  it('is the prop when there is one, over anything remembered, and then there is no switch', async () => {
    window.localStorage.setItem(KEY, 'simple');
    const w = await hubWorld();
    const { container } = renderHub(w, { mode: 'detailed' });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'detailed');
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull();
  });

  it('a fixed Simple hides the switch too, over a remembered Detailed', async () => {
    window.localStorage.setItem(KEY, 'detailed');
    const w = await hubWorld();
    const { container } = renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'simple');
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull();
  });

  it('a fixed mode is not written to the browser', async () => {
    const w = await hubWorld();
    renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('has no switch before the hub knows who is signed in', async () => {
    const w = await hubWorld({ role: null });
    renderHub(w, { mode: undefined });
    await screen.findByRole('heading', { name: 'Sign in to use the hub' });
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull();
  });
});

describe('when the browser will not remember', () => {
  it('reading throws: the default, and the hub works', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const w = await hubWorld();
    const { container } = renderHub(w, { mode: undefined });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'simple');
  });

  it('the storage object itself throws when touched: the default', async () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      const w = await hubWorld();
      const { container, user } = renderHub(w, { mode: undefined });
      await screen.findByRole('region', { name: 'Open cases' });
      expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'simple');
      // And the switch still works for this visit.
      await user.click(within(view()).getByRole('button', { name: 'Detailed' }));
      expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'detailed');
    } finally {
      if (real !== undefined) Object.defineProperty(window, 'localStorage', real);
    }
  });

  it('writing throws: the switch still changes the view for this visit', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const w = await hubWorld();
    const { container, user } = renderHub(w, { mode: undefined });
    await screen.findByRole('region', { name: 'Open cases' });
    await user.click(within(view()).getByRole('button', { name: 'Detailed' }));
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'detailed');
    expect(within(view()).getByRole('button', { name: 'Detailed' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the switch', () => {
  it('changes the view and is remembered, per browser', async () => {
    const w = await hubWorld();
    const first = renderHub(w, { mode: undefined });
    await screen.findByRole('region', { name: 'Open cases' });
    await first.user.click(within(view()).getByRole('button', { name: 'Detailed' }));
    expect(window.localStorage.getItem(KEY)).toBe('detailed');
    expect(first.container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'detailed');
    first.unmount();
    const second = renderHub(w, { mode: undefined });
    await screen.findByRole('region', { name: 'Open cases' });
    expect(second.container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'detailed');
    await second.user.click(within(view()).getByRole('button', { name: 'Simple' }));
    expect(window.localStorage.getItem(KEY)).toBe('simple');
  });

  it('is on every screen: the top bar carries it wherever the moderator is', async () => {
    const w = await hubWorld({ role: 'owner' });
    for (const path of ['/', '/reports', '/terms', '/blocked', '/gaps', '/audit', '/guide', '/actions']) {
      const { unmount } = renderHub(w, { mode: undefined, path });
      await screen.findByRole('group', { name: 'View' });
      unmount();
    }
  });

  it('keeps the route and a case with it open', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { router, user } = renderHub(w, { mode: undefined, path: `/reports/${f.id}` });
    await screen.findByRole('heading', { level: 2, name: 'Mallory' });
    expect(screen.queryByRole('tablist')).toBeNull();
    await user.click(within(view()).getByRole('button', { name: 'Detailed' }));
    expect(router.path).toBe(`/reports/${f.id}`);
    expect(await screen.findByRole('heading', { level: 2, name: /Insults or harassment report against Mallory/ })).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    await user.click(within(view()).getByRole('button', { name: 'Simple' }));
    expect(router.path).toBe(`/reports/${f.id}`);
    expect(await screen.findByRole('heading', { level: 2, name: 'Mallory' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('keeps the claim: a switch does not let the case go', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = renderHub(w, { mode: undefined, path: `/reports/${f.id}` });
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    await user.click(within(view()).getByRole('button', { name: 'Detailed' }));
    await user.click(within(view()).getByRole('button', { name: 'Simple' }));
    expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test');
    expect(w.sent.filter((r) => r.method === 'DELETE' || /release/.test(r.path))).toHaveLength(0);
  });

  it('reads the case once: a switch does not read it again', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = renderHub(w, { mode: undefined, path: `/reports/${f.id}` });
    await screen.findByRole('heading', { level: 2, name: 'Mallory' });
    await user.click(within(view()).getByRole('button', { name: 'Detailed' }));
    await screen.findByRole('heading', { level: 2, name: /report against Mallory/ });
    expect(w.sent.filter((r) => r.method === 'GET' && r.path === `/reports/${f.id}`)).toHaveLength(1);
  });

  it('keeps what was typed in the full decision bar', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = renderHub(w, { mode: undefined, path: `/reports/${f.id}` });
    await user.click(await screen.findByRole('button', { name: 'Something else…' }));
    await user.type(await screen.findByRole('textbox', { name: 'Reason' }), 'Typed here.');
    await user.click(within(view()).getByRole('button', { name: 'Detailed' }));
    expect(await screen.findByRole('textbox', { name: 'Reason' })).toHaveValue('Typed here.');
  });
});

describe('a decision waiting for its Undo survives a switch', () => {
  it('is neither sent nor dropped when the mode changes, and still sent when the window ends', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    renderHub(w, { mode: undefined, path: `/reports/${f.id}` });
    const go = await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ });
    vi.useFakeTimers({ toFake: [...FAKE] });
    fireEvent.click(go);
    expect(within(toasts()).getByText('Sending the decision on Mallory in 5 s.')).toBeInTheDocument();
    await advance(1_500);
    fireEvent.click(within(view()).getByRole('button', { name: 'Detailed' }));
    // The toast is still there, with its Undo; the bar says it is queued; nothing went to the server.
    expect(within(toasts()).getByText(/Sending the decision on Mallory in/)).toBeInTheDocument();
    expect(within(toasts()).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByText('Decision queued.')).toBeInTheDocument();
    expect(decides(w)).toHaveLength(0);
    fireEvent.click(within(view()).getByRole('button', { name: 'Simple' }));
    expect(screen.getByText('Decision queued.')).toBeInTheDocument();
    expect(decides(w)).toHaveLength(0);
    await advance(UNDO_MS);
    expect(decides(w)).toHaveLength(1);
    expect(w.cw.reports.get(f.id)?.status).toBe('actioned');
  });

  it('can still be undone after a switch, and nothing is ever sent', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = renderHub(w, { mode: undefined, path: `/reports/${f.id}` });
    await user.click(await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ }));
    await user.click(within(view()).getByRole('button', { name: 'Detailed' }));
    await user.click(within(screen.getByRole('region', { name: 'Decision' })).getByRole('button', { name: 'Undo' }));
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });
    expect(decides(w)).toHaveLength(0);
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
    // The case is back, in Detailed, undecided.
    expect(await screen.findByRole('radio', { name: 'Fair' })).not.toBeChecked();
    await user.click(within(view()).getByRole('button', { name: 'Simple' }));
    expect(await screen.findByRole('button', { name: /^Restrict chat, 24 hours/ })).toBeInTheDocument();
  });
});

describe('the prop follows the adopter', () => {
  it('changing the prop on a mounted hub changes the view', async () => {
    const w = await hubWorld();
    const router = memoryRouter('/');
    const { rerender, container } = render(<Hub client={w.client} router={router} now={w.now} mode="simple" />);
    await screen.findByRole('region', { name: 'Open cases' });
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'simple');
    rerender(<Hub client={w.client} router={router} now={w.now} mode="detailed" />);
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-mode', 'detailed');
  });
});
