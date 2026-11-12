import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubContext } from '../src/context.js';
import type { HubContextValue } from '../src/context.js';
import { createT, en } from '../src/i18n.js';
import { HubError } from '../src/client.js';
import { decideErrorText } from '../src/labels.js';
import { modKey } from '../src/shortcuts.js';
import { ToastProvider, useToasts } from '../src/toasts.js';
import type { Toasts } from '../src/toasts.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Fix round 1 for Task 4c: what the review found, each as a test that was red before the fix.

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
const rowOf = (name: string): HTMLElement => {
  const row = within(pane()).getAllByRole('listitem').find((li) => li.querySelector('.cw-case-name')?.textContent === name);
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};
const calls = (w: HubWorld, path: string): number => w.sent.filter((r) => r.path === path).length;
async function started(w: HubWorld, path = '/', options: Parameters<typeof renderHub>[1] = {}) {
  const view = renderHub(w, { path, ...options });
  await settle();
  return view;
}
const setOnline = (online: boolean): void => {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(online);
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
};
/** A request the test holds open until it says so. */
function gate() {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  return { open, release };
}

describe('1: a 401 or 403 on /changes is not a lost connection', () => {
  const answer = (w: HubWorld, status: number, error: string, message: string, headers: Record<string, string> = {}) => {
    w.intercept.fn = (req) => (req.path === '/changes' ? { status, headers, body: { error, message } } : undefined);
  };

  it.each([
    [401, 'unauthorized', 'You are signed out. Sign in again to continue.'],
    [403, 'forbidden', 'Your role cannot do this.'],
  ])('%i: says so with the hub\'s own words, stops asking, and shows a Try again', async (status, code, words) => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    await started(w);
    answer(w, status, code, 'x');
    await tick(5_000);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(words);
    expect(banner).not.toHaveTextContent('Connection lost');
    expect(screen.getByText('Signed out')).toBeInTheDocument();
    const asked = calls(w, '/changes');
    await tick(180_000);
    expect(calls(w, '/changes')).toBe(asked);
    // What was on screen stays.
    expect(rowOf('Alpha')).toBeInTheDocument();
  });

  it('Try again asks once more, and when the session is back the banner goes and the hub is live', async () => {
    const w = await hubWorld();
    await started(w);
    answer(w, 401, 'unauthorized', 'x');
    await tick(5_000);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    w.intercept.fn = null;
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }));
    await tick(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    // And it polls again.
    const before = calls(w, '/changes');
    await tick(5_100);
    expect(calls(w, '/changes')).toBe(before + 1);
  });

  it('Try again while still signed out shows the banner again and does not loop', async () => {
    const w = await hubWorld();
    await started(w);
    answer(w, 401, 'unauthorized', 'x');
    await tick(5_000);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await tick(0);
    expect(screen.getByRole('alert')).toHaveTextContent('You are signed out');
    const asked = calls(w, '/changes');
    await tick(120_000);
    expect(calls(w, '/changes')).toBe(asked);
  });

  it('on the very first read it shows the pane error in the same words, and does not keep asking', async () => {
    const w = await hubWorld();
    answer(w, 401, 'unauthorized', 'x');
    await started(w);
    expect(within(pane()).getByRole('alert')).toHaveTextContent('You are signed out. Sign in again to continue.');
    const asked = calls(w, '/changes');
    await tick(120_000);
    expect(calls(w, '/changes')).toBe(asked);
  });

  it('coming back to the tab asks again (the session may have been renewed elsewhere)', async () => {
    const w = await hubWorld();
    await started(w);
    answer(w, 403, 'forbidden', 'x');
    await tick(5_000);
    w.intercept.fn = null;
    setVisibility('hidden');
    setVisibility('visible');
    await tick(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a 429 waits the retry-after before asking again, and is not signed out', async () => {
    const w = await hubWorld();
    await started(w);
    answer(w, 429, 'rate_limited', 'x', { 'retry-after': '60' });
    await tick(5_000);
    const asked = calls(w, '/changes');
    await tick(50_000);
    expect(calls(w, '/changes')).toBe(asked);
    w.intercept.fn = null;
    await tick(10_100);
    expect(calls(w, '/changes')).toBe(asked + 1);
    expect(screen.queryByText('Signed out')).not.toBeInTheDocument();
  });
});

describe('2: a minute tick keeps waits and lapsed claims honest in a quiet queue', () => {
  it('a claim that lapses is shown as unclaimed with no change on the server', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await w.clientFor('maya@example.test').claimCase(a.person);
    await started(w);
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'other');
    w.clock.t += 11 * 60_000;
    await tick(60_000);
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'none');
    expect(calls(w, '/reports')).toBe(1);
  });

  it('the wait turns red at 24 hours by itself', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    w.clock.t = w.cw.reports.get(a.id)!.createdAt + 24 * 3_600_000 - 90_000;
    await started(w);
    expect(rowOf('Alpha')).toHaveAttribute('data-wait', 'ok');
    w.clock.t += 120_000;
    await tick(60_000);
    expect(rowOf('Alpha')).toHaveAttribute('data-wait', 'overdue');
  });

  it('the time shown in a row moves on too', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    w.clock.t = w.cw.reports.get(a.id)!.createdAt + 59 * 60_000;
    await started(w);
    expect(rowOf('Alpha')).toHaveTextContent('Waiting 59m');
    w.clock.t += 2 * 60_000;
    await tick(60_000);
    expect(rowOf('Alpha')).toHaveTextContent('Waiting 1h');
  });

  it('does not tick while the tab is hidden, and catches up at once when it is visible again', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await w.clientFor('maya@example.test').claimCase(a.person);
    await started(w);
    setVisibility('hidden');
    await tick(0);
    w.clock.t += 11 * 60_000;
    await tick(29_000);
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'other');
    setVisibility('visible');
    await tick(0);
    expect(rowOf('Alpha')).toHaveAttribute('data-claim', 'none');
  });

  it('stops ticking when the hub closes', async () => {
    const w = await hubWorld();
    const view = await started(w);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('3: deciding a case someone else holds says who', () => {
  it('the real route refuses with claimed, and the client says who and until when', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await w.clientFor('maya@example.test').claimCase(a.person);
    const err = (await w.client.decide(a.id, { verdict: 'no_action', reason: 'fine', actions: [] }).catch((e: unknown) => e)) as HubError;
    expect([err.status, err.code, err.heldBy]).toEqual([409, 'claimed', 'maya@example.test']);
  });

  it('decideErrorText names the holder, and copes when the server did not say', () => {
    const t = createT(en, 'en');
    const named = new HubError({ status: 409, code: 'claimed', message: 'm', heldBy: 'maya@example.test', heldUntil: 1 });
    expect(decideErrorText(t, named)).toBe('maya is handling this case, so this decision was not sent. What you entered is kept.');
    const unnamed = new HubError({ status: 409, code: 'claimed', message: 'm' });
    expect(decideErrorText(t, unnamed)).toBe('Another moderator is handling this case, so this decision was not sent. What you entered is kept.');
    expect(decideErrorText(t, new HubError({ status: 409, code: 'already_decided', message: 'm' }))).not.toMatch(/handling this case/);
  });

  it('a case someone else holds: the decision bar is read-only and names the holder, and nothing is sent', async () => {
    vi.useRealTimers();
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await w.clientFor('maya@example.test').claimCase(a.person);
    renderHub(w, { path: `/reports/${a.id}` });
    const panel = await screen.findByRole('region', { name: 'Decision' });
    expect(await within(panel).findByText('maya is handling this case.')).toBeInTheDocument();
    expect(within(panel).getByText('You can read it, not decide it, until they release it.')).toBeInTheDocument();
    expect(await within(panel).findByRole('radio', { name: 'Not a problem' })).toBeDisabled();
    expect(within(panel).getByRole('textbox', { name: 'Reason' })).toBeDisabled();
    // Not a senior: no Take over.
    expect(within(panel).queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(w.sent.some((r) => r.path.endsWith('/decide'))).toBe(false);
    expect((await w.client.getReport(a.id)).report.status).toBe('open');
  });

  it('the case banner and the toast say what really happens now: deciding is refused', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await w.clientFor('maya@example.test').claimCase(a.person);
    await started(w, `/reports/${a.id}`);
    expect(screen.getByText('You can read the case. Deciding it waits until they release it.')).toBeInTheDocument();
    expect(screen.getByText('maya is handling this case. Deciding it is refused until they release it.', { selector: '.cw-toast-text' })).toBeInTheDocument();
  });
});

describe('4: behaviours that were not locked', () => {
  it('overlapping polls: a request still in flight is never joined by a second', async () => {
    const w = await hubWorld();
    await started(w);
    const held = gate();
    w.intercept.fn = async (req) => {
      if (req.path === '/changes') await held.open;
      return undefined;
    };
    await tick(5_000);
    const inFlight = calls(w, '/changes');
    // Things that ask at once while a poll is out: the tab coming back, the browser coming online, Try now.
    setVisibility('hidden');
    setVisibility('visible');
    setOnline(true);
    await tick(0);
    await tick(60_000);
    expect(calls(w, '/changes')).toBe(inFlight);
    held.release();
    await tick(0);
  });

  it('the take-next cooldown: a press after the first has been answered, inside 500 ms, is ignored; after it, taken', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    await w.file({ target: 'Alpha' });
    w.clock.t += 1000;
    await w.file({ target: 'Bravo' });
    w.clock.t += 1000;
    await w.file({ target: 'Charlie' });
    await started(w);
    const take = within(pane()).getByRole('button', { name: /Take next case/ });
    fireEvent.click(take);
    await tick(0);
    expect(calls(w, '/cases/next')).toBe(1);
    await tick(100);
    fireEvent.click(take);
    await tick(0);
    expect(calls(w, '/cases/next')).toBe(1);
    await tick(600);
    fireEvent.click(take);
    await tick(0);
    expect(calls(w, '/cases/next')).toBe(2);
  });

  it('a case someone else holds is said once across several heartbeats, not at every one', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await w.clientFor('maya@example.test').claimCase(a.person);
    await started(w, `/reports/${a.id}`);
    const said = (): number => screen.queryAllByText(/maya is handling this case\. Deciding it is refused/, { selector: '.cw-toast-text' }).length;
    expect(said()).toBe(1);
    // Keep the claim alive for maya so it is still hers, and let three heartbeats pass.
    for (let i = 0; i < 3; i += 1) {
      await w.clientFor('maya@example.test').claimCase(a.person);
      await tick(60_000);
    }
    expect(calls(w, `/cases/${a.person}/claim`)).toBeGreaterThanOrEqual(4);
    // The first toast has long gone; none was added again.
    expect(said()).toBe(0);
  });

  it('going offline while a poll is out: when it comes back nothing is scheduled', async () => {
    const w = await hubWorld();
    await started(w);
    const held = gate();
    w.intercept.fn = async (req) => {
      if (req.path === '/changes') await held.open;
      return undefined;
    };
    await tick(5_000);
    setOnline(false);
    await tick(0);
    held.release();
    await tick(0);
    const asked = calls(w, '/changes');
    await tick(120_000);
    expect(calls(w, '/changes')).toBe(asked);
  });
});

describe('5: a slow old answer never overwrites a newer one', () => {
  it('a refresh that was started first and answers last is dropped', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const alpha = await w.file({ target: 'Alpha' });
    // Alpha is maya's, so the next unclaimed case Take next finds is Bravo, who is not in the list yet.
    await w.clientFor('maya@example.test').claimCase(alpha.person);
    await started(w);
    const stale = (await w.direct.listReports({ status: 'open', limit: 200 })).items;
    await w.file({ target: 'Bravo' });
    const held = gate();
    let first = true;
    w.intercept.fn = async (req) => {
      if (req.path === '/reports' && first) {
        first = false;
        await held.open;
        return { status: 200, body: { items: stale, next: null } };
      }
      return undefined;
    };
    // The poll sees the change and starts a (slow) read; then Take next finds Bravo missing and reads again, fast.
    await tick(5_000);
    fireEvent.click(within(pane()).getByRole('button', { name: /Take next case/ }));
    await tick(0);
    await tick(0);
    held.release();
    await tick(0);
    await tick(0);
    await settle();
    const names = within(pane()).getAllByRole('listitem').map((li) => li.querySelector('.cw-case-name')?.textContent);
    expect(names).toContain('Bravo');
    // Bravo is still an open case, not a closed row held in place, and the summary counts both people.
    expect(rowOf('Bravo')).not.toHaveAttribute('data-gone');
    expect(within(pane()).getByText('2 people and 2 reports')).toBeInTheDocument();
  });
});

describe('6: one Take next guard for the whole hub', () => {
  it('a click, then N, then the command bar inside the cooldown take one case', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    await w.file({ target: 'Alpha' });
    w.clock.t += 1000;
    await w.file({ target: 'Bravo' });
    await started(w);
    fireEvent.click(within(pane()).getByRole('button', { name: /Take next case/ }));
    await tick(0);
    fireEvent.keyDown(document.body, { key: 'n' });
    await tick(0);
    fireEvent.click(screen.getByRole('button', { name: /Search or jump to/ }));
    await tick(0);
    const input = screen.getByRole('combobox', { name: 'Search people, reports, terms or screens' });
    fireEvent.change(input, { target: { value: 'take next' } });
    await tick(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    await tick(0);
    expect(calls(w, '/cases/next')).toBe(1);
  });
});

describe('8: viewers are listed with the catalog and Intl, not a literal join', () => {
  it('names the first viewer and says how many more, in the catalog\'s words', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    for (const n of ['kai', 'lee', 'rin']) await w.clientFor(`${n}@example.test`).viewing(a.person);
    const t = createT({ ...en, 'hub.queue.row.viewingMore': '{name} et {count} autres' }, 'en');
    await started(w, '/', { t });
    expect(rowOf('Alpha').querySelector('.cw-case-viewing span[aria-hidden="true"]')).toHaveTextContent('kai et 2 autres');
  });

  it('two viewers: the first by name and one more; one viewer: just the name', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    const b = await w.file({ target: 'Bravo' });
    await w.clientFor('kai@example.test').viewing(a.person);
    await w.clientFor('lee@example.test').viewing(a.person);
    await w.clientFor('rin@example.test').viewing(b.person);
    await started(w);
    expect(rowOf('Alpha').querySelector('.cw-case-viewing span[aria-hidden="true"]')).toHaveTextContent('kai and 1 more');
    expect(rowOf('Bravo').querySelector('.cw-case-viewing span[aria-hidden="true"]')).toHaveTextContent(/^rin$/);
  });
});

describe('9: an Undo is never pushed off by news', () => {
  const context = { t: createT(en, 'en') } as unknown as HubContextValue;
  function mount() {
    const ref: { api: Toasts | null } = { api: null };
    function Grab() {
      ref.api = useToasts();
      return null;
    }
    render(
      <HubContext.Provider value={context}>
        <ToastProvider>
          <Grab />
        </ToastProvider>
      </HubContext.Provider>,
    );
    return (): Toasts => ref.api as Toasts;
  }

  it('the oldest toast without an action goes first', async () => {
    const api = mount();
    act(() => {
      api().push({ text: 'Released.', action: { label: 'Undo', run: () => undefined } });
      for (const text of ['A', 'B', 'C']) api().push({ text });
    });
    expect(screen.getByText('Released.')).toBeInTheDocument();
    expect(screen.queryByText('A')).not.toBeInTheDocument();
    for (const text of ['B', 'C']) expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('a held action with Undo is kept too, and is not sent early', async () => {
    const api = mount();
    const run = vi.fn();
    act(() => {
      api().hold({ text: 'Held.', run });
      for (const text of ['A', 'B', 'C']) api().push({ text });
    });
    await tick(0);
    expect(screen.getByText('Held.')).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it('when every news toast has an action, the oldest news goes; a held action is not pushed off by them, and is still sent once', async () => {
    const api = mount();
    const run = vi.fn();
    act(() => {
      api().hold({ text: 'Held.', run });
      for (const text of ['A', 'B', 'C', 'D']) api().push({ text, action: { label: 'Open', run: () => undefined } });
    });
    await tick(0);
    expect(screen.getByText('Held.')).toBeInTheDocument();
    expect(screen.queryByText('A')).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    await tick(5_100);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('10: Recent actions is read on open, not by the live loop (every read of GET /sanctions is an audited history.view)', () => {
  it('a sanction made by a teammate does not make the Overview read the list again; the queue loop still notices it', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.file({ target: 'Alpha' });
    await started(w);
    const recent = screen.getByRole('region', { name: 'Recent actions' });
    expect(within(recent).getByText(/No actions yet/)).toBeInTheDocument();
    expect(calls(w, '/sanctions')).toBe(1);
    const changes = calls(w, '/changes');
    await w.sanction(a.person, 'warning', 1);
    await tick(5_000);
    // The loop saw the change (it asked /changes again) but the list was not read again: no second audited read.
    expect(calls(w, '/changes')).toBeGreaterThan(changes);
    await tick(60_000);
    expect(calls(w, '/sanctions')).toBe(1);
    expect(within(recent).getByText(/No actions yet/)).toBeInTheDocument();
  });

  it('reads once when it opens and not at all in between, however long the hub stays open', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    await started(w);
    expect(calls(w, '/sanctions')).toBe(1);
    await tick(120_000);
    expect(calls(w, '/sanctions')).toBe(1);
  });
});

describe('12: the shortcut cap matches the keyboard', () => {
  it.each([
    ['MacIntel', '⌘'],
    ['iPhone', '⌘'],
    ['Win32', 'Ctrl'],
    ['Linux x86_64', 'Ctrl'],
  ])('%s shows %s', (platform, cap) => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform);
    expect(modKey()).toBe(cap === 'Ctrl' ? 'Ctrl' : 'Cmd');
  });

  it('the top bar and the sheet show the Cmd glyph on a Mac, Ctrl elsewhere', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const w = await hubWorld();
    const mac = await started(w);
    const button = screen.getByRole('button', { name: /Search or jump to/ });
    expect(button).toHaveTextContent('⌘');
    expect(button).not.toHaveTextContent('Ctrl');
    fireEvent.keyDown(document.body, { key: '?' });
    const sheet = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(sheet).getAllByText('⌘').length).toBeGreaterThanOrEqual(2);
    expect(within(sheet).queryByText('Ctrl')).not.toBeInTheDocument();
    mac.unmount();
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    await started(w);
    expect(screen.getByRole('button', { name: /Search or jump to/ })).toHaveTextContent('Ctrl');
  });

  it('prefers userAgentData.platform when the browser has it', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    Object.defineProperty(window.navigator, 'userAgentData', { configurable: true, value: { platform: 'macOS' } });
    expect(modKey()).toBe('Cmd');
    Object.defineProperty(window.navigator, 'userAgentData', { configurable: true, value: undefined });
  });
});
