import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The background refresh, on fake timers: the queue asks GET /changes every 5 seconds while the tab is visible and every 30
// while it is hidden, never while the browser is offline, and reads the queue again only when the token moved.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setVisibility('visible');
});

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await tick(0);
};

const pane = (): HTMLElement => screen.getByRole('region', { name: 'Open cases' });
const names = (): string[] => within(pane()).queryAllByRole('listitem').map((li) => li.querySelector('.cw-case-name')?.textContent ?? '');
const calls = (w: HubWorld, path: string): number => w.sent.filter((r) => r.path === path).length;
const rowOf = (name: string): HTMLElement => {
  const row = within(pane()).getAllByRole('listitem').find((li) => li.querySelector('.cw-case-name')?.textContent === name);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};

async function started(w: HubWorld, path = '/') {
  const view = renderHub(w, { path });
  await settle();
  return view;
}

describe('polling pace', () => {
  it('asks for changes every 5 seconds while the tab is visible, and reads the queue only once while nothing changes', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    await started(w);
    expect(calls(w, '/changes')).toBe(1);
    expect(calls(w, '/reports')).toBe(1);
    await tick(4_900);
    expect(calls(w, '/changes')).toBe(1);
    await tick(200);
    expect(calls(w, '/changes')).toBe(2);
    await tick(5_000);
    expect(calls(w, '/changes')).toBe(3);
    await tick(10_000);
    expect(calls(w, '/changes')).toBe(5);
    expect(calls(w, '/reports')).toBe(1);
  });

  it('sends the token it last saw, and the token never goes stale: the second poll names the first answer', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    await started(w);
    await tick(5_000);
    const [first, second] = w.sent.filter((r) => r.path === '/changes');
    expect(first?.query ?? {}).toEqual({});
    expect(second?.query?.since).toBeTruthy();
  });

  it('backs off to every 30 seconds while the tab is hidden, and asks at once when it is visible again', async () => {
    const w = await hubWorld();
    await started(w);
    expect(calls(w, '/changes')).toBe(1);
    setVisibility('hidden');
    await tick(0);
    const before = calls(w, '/changes');
    await tick(29_000);
    expect(calls(w, '/changes')).toBe(before);
    await tick(1_100);
    expect(calls(w, '/changes')).toBe(before + 1);
    await tick(30_000);
    expect(calls(w, '/changes')).toBe(before + 2);
    setVisibility('visible');
    await tick(0);
    expect(calls(w, '/changes')).toBe(before + 3);
    await tick(5_100);
    expect(calls(w, '/changes')).toBe(before + 4);
  });

  it('a tab that goes hidden before its next poll waits the full 30 seconds', async () => {
    const w = await hubWorld();
    await started(w);
    await tick(4_000);
    setVisibility('hidden');
    await tick(20_000);
    expect(calls(w, '/changes')).toBe(1);
    await tick(11_000);
    expect(calls(w, '/changes')).toBe(2);
  });

  it('stops asking when the hub is closed', async () => {
    const w = await hubWorld();
    const view = await started(w);
    view.unmount();
    const before = calls(w, '/changes');
    await tick(60_000);
    expect(calls(w, '/changes')).toBe(before);
  });
});

describe('reading the queue again only when it changed', () => {
  it('a new report triggers one more read and a pill, not a new row', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    await started(w);
    expect(names()).toEqual(['Alpha']);
    await w.file({ target: 'Bravo' });
    await tick(5_000);
    expect(calls(w, '/reports')).toBe(2);
    expect(names()).toEqual(['Alpha']);
    expect(within(pane()).getByRole('button', { name: '1 new case' })).toBeInTheDocument();
    // Nothing else changed: no more reads.
    await tick(10_000);
    expect(calls(w, '/reports')).toBe(2);
  });

  it('the pill counts cases, not reports, and a second case makes it 2', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    await started(w);
    await w.file({ target: 'Bravo', reporter: 'R1' });
    await w.file({ target: 'Bravo', reporter: 'R2' });
    await tick(5_000);
    expect(within(pane()).getByRole('button', { name: '1 new case' })).toBeInTheDocument();
    await w.file({ target: 'Charlie', reporter: 'R3' });
    await tick(5_000);
    expect(within(pane()).getByRole('button', { name: '2 new cases' })).toBeInTheDocument();
  });

  it('choosing the pill puts the new cases in the list, longest wait first, and removes the pill', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    await started(w);
    w.clock.t += 1000;
    await w.file({ target: 'Bravo' });
    await tick(5_000);
    fireEvent.click(within(pane()).getByRole('button', { name: '1 new case' }));
    expect(names()).toEqual(['Alpha', 'Bravo']);
    expect(within(pane()).queryByRole('button', { name: /new case/ })).not.toBeInTheDocument();
  });

  it('a case that is decided elsewhere leaves the list when nobody is on it', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    await w.file({ target: 'Bravo' });
    await started(w);
    await w.clientFor('maya@example.test').decide(a.id, { verdict: 'no_action', reason: 'fine', actions: [] });
    await tick(5_000);
    expect(names()).toEqual(['Bravo']);
  });

  it('a claim by a teammate arrives in place, with no pill and no reorder', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await w.file({ target: 'Bravo' });
    await started(w);
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'none');
    await w.clientFor('maya@example.test').claimCase(a.person);
    await tick(5_000);
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'other');
    expect(within(rowOf('Alpha')).getByText('maya')).toBeInTheDocument();
    expect(names()).toEqual(['Alpha', 'Bravo']);
    expect(within(pane()).queryByRole('button', { name: /new case/ })).not.toBeInTheDocument();
  });

  it('a claim that lapses is shown as unclaimed on the next render without any server change', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await w.clientFor('maya@example.test').claimCase(a.person);
    await started(w);
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'other');
    w.clock.t += 11 * 60_000;
    await w.file({ target: 'Bravo' });
    await tick(5_000);
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'none');
  });
});

describe('the list never moves under the cursor', () => {
  async function three() {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    w.clock.t += 1000;
    const b = await w.file({ target: 'Bravo' });
    w.clock.t += 1000;
    const c = await w.file({ target: 'Charlie' });
    await started(w);
    return { w, a, b, c };
  }
  const decide = (w: HubWorld, id: string) => w.clientFor('maya@example.test').decide(id, { verdict: 'no_action', reason: 'fine', actions: [] });

  it('a new case never lands among the rows, whatever has focus', async () => {
    const { w } = await three();
    const link = within(rowOf('Bravo')).getByRole('link');
    link.focus();
    await w.file({ target: 'Delta' });
    await tick(5_000);
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(link).toHaveFocus();
    expect(within(pane()).getByRole('button', { name: '1 new case' })).toBeInTheDocument();
  });

  it('a case that closes while focus is in the list stays in place, marked, and keeps every other row where it is', async () => {
    const { w, a } = await three();
    const link = within(rowOf('Bravo')).getByRole('link');
    link.focus();
    await decide(w, a.id);
    await tick(5_000);
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(rowOf('Alpha')).toHaveAttribute('data-gone', 'true');
    expect(rowOf('Alpha')).toHaveTextContent('No longer open');
    expect(link).toHaveFocus();
    // Focus leaves the list: the closed row goes.
    act(() => link.blur());
    expect(names()).toEqual(['Bravo', 'Charlie']);
  });

  it('a case that closes while the pointer is over the list stays until the pointer leaves', async () => {
    const { w, b } = await three();
    const list = within(pane()).getByRole('list', { name: 'Cases' }).parentElement as HTMLElement;
    fireEvent.pointerEnter(list);
    await decide(w, b.id);
    await tick(5_000);
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(rowOf('Bravo')).toHaveAttribute('data-gone', 'true');
    fireEvent.pointerLeave(list);
    expect(names()).toEqual(['Alpha', 'Charlie']);
  });

  it('moving focus between two rows does not let a closed row go in between', async () => {
    const { w, c } = await three();
    within(rowOf('Alpha')).getByRole('link').focus();
    await decide(w, c.id);
    await tick(5_000);
    expect(rowOf('Charlie')).toHaveAttribute('data-gone', 'true');
    within(rowOf('Bravo')).getByRole('link').focus();
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('the case that is open keeps its row after it closes, marked, until you leave it', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await w.file({ target: 'Bravo' });
    const view = await started(w, `/reports/${a.id}`);
    // Ann holds it now (opening claimed it), so a senior takes it over to decide it.
    await w.clientFor('sam@example.test', 'senior').decide(a.id, { verdict: 'no_action', reason: 'fine', actions: [], takeOver: true });
    await tick(5_000);
    expect(names()).toEqual(['Alpha', 'Bravo']);
    expect(rowOf('Alpha')).toHaveAttribute('data-gone', 'true');
    act(() => view.router.navigate('/'));
    await settle();
    expect(names()).toEqual(['Bravo']);
  });

  it('a gone row can still be opened (its report is still there to read)', async () => {
    const { w, a } = await three();
    const list = within(pane()).getByRole('list', { name: 'Cases' }).parentElement as HTMLElement;
    fireEvent.pointerEnter(list);
    await decide(w, a.id);
    await tick(5_000);
    expect(within(rowOf('Alpha')).getByRole('link')).toHaveAttribute('href', `#/reports/${a.id}`);
  });
});

describe('losing the connection', () => {
  const lose = (w: HubWorld) => {
    w.intercept.fn = (req) => {
      if (req.path === '/changes') throw new TypeError('fetch failed');
      return undefined;
    };
  };

  it('stays quiet after one failure, shows the banner after two in a row, and the top bar says reconnecting', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    await started(w);
    expect(screen.getByText('Live')).toBeInTheDocument();
    lose(w);
    await tick(5_000);
    expect(screen.queryByText(/Connection lost/)).not.toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    await tick(5_000);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Connection lost. Retrying. What you see may be out of date.');
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    // What was on screen stays.
    expect(names()).toEqual(['Alpha']);
  });

  it('one failure between successes never shows the banner', async () => {
    const w = await hubWorld();
    await started(w);
    lose(w);
    await tick(5_000);
    w.intercept.fn = null;
    await tick(5_000);
    lose(w);
    await tick(5_000);
    w.intercept.fn = null;
    await tick(5_000);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries every 15 seconds while the banner is up', async () => {
    const w = await hubWorld();
    await started(w);
    lose(w);
    await tick(10_000);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    const before = calls(w, '/changes');
    await tick(14_000);
    expect(calls(w, '/changes')).toBe(before);
    await tick(1_100);
    expect(calls(w, '/changes')).toBe(before + 1);
  });

  it('says Back online with a toast when it recovers, and the banner goes', async () => {
    const w = await hubWorld();
    await started(w);
    lose(w);
    await tick(10_000);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    w.intercept.fn = null;
    await tick(15_000);
    expect(screen.queryByText(/Connection lost/)).not.toBeInTheDocument();
    expect(screen.getByText('Back online.')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('does not say Back online after a recovery that never showed a banner', async () => {
    const w = await hubWorld();
    await started(w);
    lose(w);
    await tick(5_000);
    w.intercept.fn = null;
    await tick(5_000);
    expect(screen.queryByText('Back online.')).not.toBeInTheDocument();
  });

  it('Try now asks at once and recovers without waiting', async () => {
    const w = await hubWorld();
    await started(w);
    lose(w);
    await tick(10_000);
    w.intercept.fn = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    await tick(0);
    expect(screen.queryByText(/Connection lost/)).not.toBeInTheDocument();
    expect(screen.getByText('Back online.')).toBeInTheDocument();
  });

  it('a failed read of the queue counts too, and the rows already shown stay', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    await started(w);
    await w.file({ target: 'Bravo' });
    w.intercept.fn = (req) => (req.path === '/reports' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await tick(5_000);
    await tick(5_000);
    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost');
    expect(names()).toEqual(['Alpha']);
  });

  it('after a recovery the missed changes arrive (as a pill)', async () => {
    const w = await hubWorld();
    await started(w);
    lose(w);
    await w.file({ target: 'Alpha' });
    await tick(10_000);
    w.intercept.fn = null;
    await tick(15_000);
    expect(within(pane()).getByRole('button', { name: '1 new case' })).toBeInTheDocument();
  });
});

describe('offline', () => {
  const setOnline = (online: boolean) => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(online);
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  };

  it('pauses polling while the browser is offline, says so, and resumes at once when it is back', async () => {
    const w = await hubWorld();
    await started(w);
    const before = calls(w, '/changes');
    setOnline(false);
    await tick(0);
    expect(screen.getByRole('alert')).toHaveTextContent('You are offline. Updates resume when you are back.');
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try now' })).not.toBeInTheDocument();
    await tick(120_000);
    expect(calls(w, '/changes')).toBe(before);
    setOnline(true);
    await tick(0);
    expect(calls(w, '/changes')).toBe(before + 1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Back online.')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('starts paused when the page opens offline, and loads once it is online', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    await started(w);
    expect(calls(w, '/changes')).toBe(0);
    expect(calls(w, '/reports')).toBe(0);
    expect(screen.getByRole('alert')).toHaveTextContent('You are offline');
    setOnline(true);
    await settle();
    expect(names()).toEqual(['Alpha']);
  });
});
