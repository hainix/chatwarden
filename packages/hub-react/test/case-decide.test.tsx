import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';
import type { TransportRequest } from '../src/transport.js';
import { UNDO_MS } from '../src/toasts.js';

// The decision as a moderator lives it: held for five seconds with an Undo, sent at once if the page goes, "Decide and take next",
// a case someone else holds, and leaving a case. Against the real routes; the clock is faked only where time is the point.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];

const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const decideButton = (): HTMLElement => within(panel()).getByRole('button', { name: 'Decide' });
const nextButton = (): HTMLElement => within(panel()).getByRole('button', { name: /^Decide and take next/ });
const toasts = (): HTMLElement => screen.getByRole('region', { name: 'Notifications' });
const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

async function open(w: HubWorld, id: string, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/reports/${id}`, ...options });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  // A case accepts an act key a moment after it appeared; the guard's clock moves with the world's.
  w.clock.t += 400;
  return r;
}

/** Fair, and a reason: the suggestion, its rule and the person's own lines are already in the plan. */
async function fillFair(user: UserEvent, text = 'Clear from the chat.'): Promise<void> {
  await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
  await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), text);
}

const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });
const setVisibility = (state: 'hidden' | 'visible'): void => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('the five-second undo window', () => {
  it('holds the decision: nothing is sent at 4.9 seconds, and exactly one decision at 5', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user);
    vi.useFakeTimers({ toFake: [...FAKE] });
    expect(UNDO_MS).toBe(5_000);
    fireEvent.click(decideButton());
    expect(within(toasts()).getByText('Sending the decision on Mallory in 5 s.')).toBeInTheDocument();
    expect(within(toasts()).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await advance(4_900);
    expect(decides(w)).toHaveLength(0);
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
    await advance(200);
    expect(decides(w)).toHaveLength(1);
    expect(w.cw.reports.get(f.id)?.status).toBe('actioned');
  });

  it('says what is waiting in the bar, and the form is put away until it is sent or undone', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user);
    await user.click(decideButton());
    expect(within(panel()).getByText('Decision queued.')).toBeInTheDocument();
    expect(within(panel()).getByText('It is sent in 5 s unless you undo it.')).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Decide' })).not.toBeInTheDocument();
    // Keyboard focus is on the notice, not lost on a form that went away.
    expect(within(panel()).getByText('Decision queued.').closest('[role="status"]')).toHaveFocus();
    expect(decides(w)).toHaveLength(0);
  });

  it('Undo in the toast cancels with nothing sent, and the form comes back as it was', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user, 'Typed once.');
    vi.useFakeTimers({ toFake: [...FAKE] });
    fireEvent.click(decideButton());
    await advance(2_000);
    fireEvent.click(within(toasts()).getByRole('button', { name: 'Undo' }));
    await advance(20_000);
    expect(decides(w)).toHaveLength(0);
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('Typed once.');
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).toBeChecked();
    expect(within(panel()).getByRole('button', { name: 'Decide' })).toBeInTheDocument();
  });

  it('Undo in the bar does the same', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user);
    await user.click(decideButton());
    await user.click(within(panel()).getByRole('button', { name: 'Undo' }));
    await pageHides();
    expect(decides(w)).toHaveLength(0);
    expect(within(panel()).getByRole('button', { name: 'Decide' })).toBeInTheDocument();
  });

  it('the claim is still yours after an Undo', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    await fillFair(user);
    await user.click(decideButton());
    await user.click(within(panel()).getByRole('button', { name: 'Undo' }));
    expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test');
    expect(within(screen.getByRole('group', { name: 'Who is handling this case' })).getByText("You're handling this.")).toBeInTheDocument();
  });

  it('is sent at once when the page hides, and the request survives the page (keepalive)', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user);
    await user.click(decideButton());
    expect(decides(w)).toHaveLength(0);
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]!.keepalive).toBe(true);
    expect(w.cw.reports.get(f.id)?.status).toBe('actioned');
  });

  it('is sent at once when the tab is hidden', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user);
    await user.click(decideButton());
    await act(async () => setVisibility('hidden'));
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]!.keepalive).toBe(true);
  });

  it('is sent at once when the hub closes (unmount), and only once however many ways the page goes', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user, unmount } = await open(w, f.id);
    await fillFair(user);
    await user.click(decideButton());
    unmount();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    await pageHides();
    await act(async () => setVisibility('hidden'));
    expect(decides(w)).toHaveLength(1);
    expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(1);
  });

  it('pressing Decide again while it waits does not queue a second decision', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user);
    await user.click(decideButton());
    expect(within(toasts()).getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
  });

  it('after it is sent the bar shows the result with its reference code, and a way to the next case', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user);
    await user.click(decideButton());
    await pageHides();
    expect(await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' })).toBeInTheDocument();
    const stored = w.cw.sanctions.forPerson(f.person);
    expect(within(within(panel()).getByRole('list', { name: 'Reference codes' })).getByText(`${stored[0]!.refCode} (Chat restriction)`)).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Take next case' })).toBeInTheDocument();
    // The decided case is off the screen: no header, no transcript, no pane beside it.
    expect(screen.queryByRole('group', { name: 'About this report' })).toBeNull();
    // Deciding let go of the claim on the server.
    expect(w.cw.cases.holder(f.person)).toBeNull();
  });
});

describe('a decision that fails after it left the screen', () => {
  it('comes back: the case in the queue, the form with what was typed, and the error', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK, target: 'Mallory' });
    const { user } = await open(w, f.id);
    await fillFair(user, 'Kept through the failure.');
    w.intercept.fn = (req) => (isDecide(req) ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(decideButton());
    // At once the case leaves the list (it is "sending").
    const pane = screen.getByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(pane).queryByText('Mallory')).not.toBeInTheDocument());
    await pageHides();
    const alert = await within(panel()).findByText('The server had a problem. Try again in a moment.');
    expect(alert.closest('[role="alert"]')).toHaveFocus();
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('Kept through the failure.');
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).toBeChecked();
    expect(await within(pane).findByText('Mallory')).toBeInTheDocument();
    // The claim is back on the case too.
    expect(within(screen.getByRole('group', { name: 'Who is handling this case' })).getByText("You're handling this.")).toBeInTheDocument();
    // Try again sends the same body at once (no second window).
    const first = decides(w)[0]!.body;
    w.intercept.fn = null;
    await user.click(within(panel()).getByRole('button', { name: 'Try again' }));
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)).toHaveLength(2);
    expect(decides(w)[1]!.body).toEqual(first);
  });

  it('a network failure says so and keeps the form', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user);
    w.intercept.fn = (req) => {
      if (isDecide(req)) throw new TypeError('offline');
      return undefined;
    };
    await user.click(decideButton());
    await pageHides();
    expect(await within(panel()).findByText('Could not reach the server. Check your connection and try again.')).toBeInTheDocument();
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('Clear from the chat.');
  });
});

describe('Decide and take next', () => {
  async function two() {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'Ra', bystander: 'Sa', room: 'ra' });
    w.clock.t += 1000;
    const b = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Rb', bystander: 'Sb', room: 'rb' });
    return { w, a, b };
  }

  it('queues the decision, takes the next case and opens it', async () => {
    const { w, a, b } = await two();
    const { user, router } = await open(w, a.id);
    await fillFair(user);
    await user.click(nextButton());
    await waitFor(() => expect(router.path).toBe(`/reports/${b.id}`));
    // The next one is mine (claimed by "take next"), the decision is still in its window.
    await screen.findByRole('heading', { level: 2, name: /report against Beta/ });
    expect(w.cw.cases.holder(b.person)?.by).toBe('ann@example.test');
    expect(decides(w)).toHaveLength(0);
    expect(within(toasts()).getByText('Sending the decision on Alpha in 5 s.')).toBeInTheDocument();
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]!.path).toBe(`/reports/${a.id}/decide`);
    expect(w.cw.reports.get(a.id)?.status).toBe('actioned');
    expect(w.cw.reports.get(b.id)?.status).toBe('open');
    // The case just decided is not handed out again: its claim was still ours when the next one was taken.
    expect(w.sent.filter((r) => r.path === '/cases/next')).toHaveLength(1);
  });

  it('Ctrl+Enter does the same, from inside the reason box', async () => {
    const { w, a, b } = await two();
    const { user, router } = await open(w, a.id);
    await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Typed, then Ctrl+Enter.{Control>}{Enter}{/Control}');
    await waitFor(() => expect(router.path).toBe(`/reports/${b.id}`));
    expect(within(toasts()).getByText('Sending the decision on Alpha in 5 s.')).toBeInTheDocument();
    // Enter alone in the box added a line, and sent nothing.
    expect(decides(w)).toHaveLength(0);
  });

  it('Cmd+Enter works too', async () => {
    const { w, a, b } = await two();
    const { user, router } = await open(w, a.id);
    await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Cmd.{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(router.path).toBe(`/reports/${b.id}`));
  });

  it('the case leaves the queue at once, and Undo brings it back and goes back to it', async () => {
    const { w, a, b } = await two();
    const { user, router } = await open(w, a.id);
    await fillFair(user, 'Undo me.');
    await user.click(nextButton());
    await waitFor(() => expect(router.path).toBe(`/reports/${b.id}`));
    const pane = screen.getByRole('region', { name: 'Open cases' });
    expect(within(pane).queryByText('Alpha')).not.toBeInTheDocument();
    await user.click(within(toasts()).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(router.path).toBe(`/reports/${a.id}`));
    expect(await within(pane).findByText('Alpha')).toBeInTheDocument();
    expect(await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('textbox', { name: 'Reason' })).toHaveValue('Undo me.');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
  });

  it('a send that fails after you moved on says so, with the way back, and the form is waiting there', async () => {
    const { w, a, b } = await two();
    const { user, router } = await open(w, a.id);
    await fillFair(user, 'Waiting for you.');
    w.intercept.fn = (req) => (isDecide(req) ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(nextButton());
    await waitFor(() => expect(router.path).toBe(`/reports/${b.id}`));
    await pageHides();
    const toast = await within(toasts()).findByText('The decision on Alpha was not sent. The case is back, with what you entered.');
    expect(toast.closest('[role="alert"]')).not.toBeNull();
    w.intercept.fn = null;
    await user.click(within(toasts()).getByRole('button', { name: 'Open the case' }));
    await waitFor(() => expect(router.path).toBe(`/reports/${a.id}`));
    const bar = await screen.findByRole('region', { name: 'Decision' });
    expect(await within(bar).findByRole('textbox', { name: 'Reason' })).toHaveValue('Waiting for you.');
    expect(within(bar).getByRole('radio', { name: 'Fair' })).toBeChecked();
  });

  it('with nothing left to take, the team view says so, and the decision still goes out', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.fileRich({ lines: TALK, target: 'Alpha' });
    const { user, router } = await open(w, a.id);
    await fillFair(user);
    await user.click(nextButton());
    await waitFor(() => expect(router.path).toBe('/'));
    expect(within(toasts()).getByText('No unclaimed cases right now.')).toBeInTheDocument();
    await screen.findByRole('heading', { level: 2, name: 'Overview' });
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
  });

  it('a problem in the form stops it: nothing is queued and no case is taken', async () => {
    const { w, a } = await two();
    const { user } = await open(w, a.id);
    await user.click(nextButton());
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('Fix 2 things before deciding.');
    expect(w.sent.some((r) => r.path === '/cases/next')).toBe(false);
    expect(within(toasts()).queryByText(/Sending the decision/)).not.toBeInTheDocument();
  });
});

describe('a case someone else holds', () => {
  it('reads, but the bar is read-only and names the holder', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    await open(w, f.id);
    const banner = await screen.findByRole('group', { name: 'Who is handling this case' });
    expect(within(banner).getByText('maya is handling this.')).toBeInTheDocument();
    expect(within(panel()).getByText('maya is handling this case.')).toBeInTheDocument();
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).toBeDisabled();
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toBeDisabled();
    expect(within(banner).queryByRole('button', { name: 'Take over' })).toBeNull();
    // The transcript's boxes are not offered either.
    expect(screen.queryAllByRole('checkbox', { name: /^Show the line at/ })).toHaveLength(0);
  });

  it('keys do nothing on a case you may not decide', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    const { user } = await open(w, f.id);
    await user.keyboard('1');
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).not.toBeChecked();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(decides(w)).toHaveLength(0);
  });

  it('control: on a case nobody holds the same key selects Fair', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await within(panel()).findByRole('radio', { name: 'Fair' });
    await user.keyboard('1');
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).toBeChecked();
  });

  it('a senior sees Take over, and taking over makes the case theirs and the bar usable', async () => {
    const w = await hubWorld({ role: 'senior', actor: 'sen@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    const { user } = await open(w, f.id);
    const banner = await screen.findByRole('group', { name: 'Who is handling this case' });
    expect(within(banner).getByText('You can read the case. As a senior you can take it over.')).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: 'Take over' }));
    expect(await within(banner).findByText("You're handling this.")).toBeInTheDocument();
    expect(w.cw.cases.holder(f.person)?.by).toBe('sen@example.test');
    expect(within(toasts()).getByText('You took this case over from maya.')).toBeInTheDocument();
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).toBeEnabled();
    // The takeover is on the audit trail.
    expect(w.cw.audit.list({ limit: 50 }).items.some((r) => r.action === 'case.takeover')).toBe(true);
  });

  it('the Take over button is offered by the permission, not the role name', async () => {
    const w = await hubWorld({ role: 'moderator', actor: 'ann@example.test', permissions: { 'claims.override': 'moderator' } });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    await open(w, f.id);
    expect(await within(await screen.findByRole('group', { name: 'Who is handling this case' })).findByRole('button', { name: 'Take over' })).toBeInTheDocument();
    // One button, in the banner; the bar points to it.
    expect(within(panel()).queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(within(panel()).getByText('Use Take over in the banner above.')).toBeInTheDocument();
  });

  it('a free case can be taken after you let it go', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    const banner = await screen.findByRole('group', { name: 'Who is handling this case' });
    await user.click(await within(banner).findByRole('button', { name: 'Release' }));
    expect(await within(banner).findByText('Nobody is handling this.')).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: 'Handle this case' }));
    expect(await within(banner).findByText("You're handling this.")).toBeInTheDocument();
    expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test');
  });

  it('a decision refused because someone took the case meanwhile (409 claimed) turns the bar read-only, with the input kept', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    await fillFair(user, 'Mine, I thought.');
    await w.clientFor('sen@example.test', 'senior').claimCase(f.person, { takeOver: true });
    await user.click(decideButton());
    await pageHides();
    expect(await within(panel()).findByText('sen is handling this case, so this decision was not sent. What you entered is kept.')).toBeInTheDocument();
    expect(within(panel()).getByText('sen is handling this case.')).toBeInTheDocument();
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('Mine, I thought.');
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toBeDisabled();
    // Trying again cannot help while they hold it.
    expect(within(panel()).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
  });
});

describe('leaving a case lets it go', () => {
  async function two() {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'Ra', bystander: 'Sa', room: 'ra' });
    w.clock.t += 1000;
    const b = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Rb', bystander: 'Sb', room: 'rb' });
    return { w, a, b };
  }
  const releases = (w: HubWorld): string[] => w.sent.filter((r) => r.method === 'POST' && r.path.endsWith('/release')).map((r) => r.path);

  it('opening another case releases the first and claims the second', async () => {
    const { w, a, b } = await two();
    const { router } = await open(w, a.id);
    await waitFor(() => expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test'));
    act(() => router.navigate(`/reports/${b.id}`));
    await waitFor(() => expect(w.cw.cases.holder(a.person)).toBeNull());
    await waitFor(() => expect(w.cw.cases.holder(b.person)?.by).toBe('ann@example.test'));
    expect(releases(w)).toEqual([`/cases/${a.person}/release`]);
  });

  it('going to another screen releases it', async () => {
    const { w, a } = await two();
    const { router } = await open(w, a.id);
    await waitFor(() => expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test'));
    act(() => router.navigate('/reports'));
    await waitFor(() => expect(w.cw.cases.holder(a.person)).toBeNull());
    expect(releases(w)).toHaveLength(1);
  });

  it('closing the hub releases it too', async () => {
    const { w, a } = await two();
    const { unmount } = await open(w, a.id);
    await waitFor(() => expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test'));
    unmount();
    await waitFor(() => expect(w.cw.cases.holder(a.person)).toBeNull());
  });

  it('a second report about the same person keeps the claim: it is the same case', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const first = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'R1', room: 'r1' });
    const second = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'R2', room: 'r2' });
    const { router } = await open(w, first.id);
    await waitFor(() => expect(w.cw.cases.holder(first.person)?.by).toBe('ann@example.test'));
    act(() => router.navigate(`/reports/${second.id}`));
    await screen.findByRole('heading', { level: 2, name: /report against Alpha/ });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(releases(w)).toEqual([]);
    expect(w.cw.cases.holder(first.person)?.by).toBe('ann@example.test');
  });

  it('a case someone else holds is not released by leaving it', async () => {
    const { w, a } = await two();
    await w.clientFor('maya@example.test').claimCase(a.person);
    const { router } = await open(w, a.id);
    await screen.findByText('maya is handling this.');
    act(() => router.navigate('/reports'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(releases(w)).toEqual([]);
    expect(w.cw.cases.holder(a.person)?.by).toBe('maya@example.test');
  });

  it('a case with a decision waiting is not released on the way out: sending it lets it go', async () => {
    const { w, a } = await two();
    const { user, router } = await open(w, a.id);
    await fillFair(user);
    await user.click(decideButton());
    act(() => router.navigate('/'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(releases(w)).toEqual([]);
    expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test');
    await pageHides();
    await waitFor(() => expect(w.cw.cases.holder(a.person)).toBeNull());
    expect(releases(w)).toEqual([]);
  });

  it('even when the queue is read again meanwhile and shows the claim as still yours, a waiting decision keeps it from being released', async () => {
    const { w, a } = await two();
    const { user, router } = await open(w, a.id);
    await fillFair(user);
    await user.click(decideButton());
    // Something else changes the queue: the hub reads it again and the server still says the case is mine (the decision is held).
    const reads = (): number => w.sent.filter((r) => r.method === 'GET' && r.path === '/reports').length;
    const before = reads();
    await w.file({ target: 'Gamma', reporter: 'Rg', room: 'rg' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    act(() => router.navigate('/'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(releases(w)).toEqual([]);
    expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test');
  });

  it('the heartbeat stops once you have left', async () => {
    const { w, a } = await two();
    const { router } = await open(w, a.id);
    await waitFor(() => expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test'));
    vi.useFakeTimers({ toFake: [...FAKE] });
    act(() => router.navigate('/'));
    await advance(1);
    const claims = (): number => w.sent.filter((r) => r.path === `/cases/${a.person}/claim`).length;
    const before = claims();
    await advance(5 * 60_000);
    expect(claims()).toBe(before);
  });
});
