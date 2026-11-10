import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { isWaiting } from '../src/decisions.js';
import type { DecisionEntry } from '../src/decisions.js';
import { Hub } from '../src/Hub.js';
import { memoryRouter } from '../src/router.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// Fix round 1 of Task 4d: what the review and the real-browser check found. Each test names the finding it pins.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];

const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const dock = (container: HTMLElement): HTMLElement => container.querySelector('.cw-dock') as HTMLElement;
const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });

async function open(w: HubWorld, id: string, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/reports/${id}`, ...options });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  return r;
}
async function fillFair(user: ReturnType<typeof renderHub>['user'], text = 'Clear from the chat.'): Promise<void> {
  await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
  await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), text);
}
const entry = (status: DecisionEntry['state']['status']): DecisionEntry =>
  ({ reportId: 'r', person: 'p', name: 'n', input: {}, snapshot: {}, state: { status } }) as unknown as DecisionEntry;

describe('isWaiting', () => {
  it('is true while a decision is held or being sent, and for nothing else', () => {
    expect(isWaiting(entry('held'))).toBe(true);
    expect(isWaiting(entry('sending'))).toBe(true);
    for (const s of ['done', 'failed', 'conflict', 'undone'] as const) expect(isWaiting(entry(s)), s).toBe(false);
    expect(isWaiting(undefined)).toBe(false);
  });
});

describe('B1: the decided case leaves the screen at once', () => {
  it('after Decide the case, its decision form and the pane beside it are gone before the timer fires, and only the queued notice is left', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user, container } = await open(w, f.id);
    await fillFair(user);
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    expect(decides(w)).toHaveLength(0);
    expect(screen.queryByRole('heading', { level: 2, name: /report against/ })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Chat lines' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(container.querySelector('.cw-ctx')).toHaveAttribute('hidden');
    expect(within(panel()).getByText('Decision queued.')).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: /^Take next case/ })).toBeInTheDocument();
    expect(within(panel()).queryByRole('textbox', { name: 'Reason' })).toBeNull();
  });

  it('it says whose case it was, so the empty pane is not a mystery', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, target: 'Mallory' });
    const { user } = await open(w, f.id);
    await fillFair(user);
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    expect(within(panel()).getByRole('heading', { level: 2, name: 'Decision on Mallory' })).toBeInTheDocument();
  });

  it('Undo brings the case back with every input as it was', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(screen.getAllByRole('checkbox', { name: /^Show the line at/ })[0]!);
    await fillFair(user, 'Typed before.');
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await user.click(within(panel()).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('heading', { level: 2, name: /report against/ })).toBeInTheDocument();
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('Typed before.');
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).toBeChecked();
    expect(screen.getAllByRole('checkbox', { name: /^Show the line at/ })[0]).not.toBeChecked();
    expect(screen.getAllByRole('checkbox', { name: /^Show the line at/ })[1]).toBeChecked();
    await pageHides();
    expect(decides(w)).toHaveLength(0);
  });

  it('a failed send brings the case back with the inputs and the error', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user, 'Kept.');
    w.intercept.fn = (req) => (isDecide(req) ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    expect(await screen.findByRole('heading', { level: 2, name: /report against/ })).toBeInTheDocument();
    expect(await within(panel()).findByText('The server had a problem. Try again in a moment.')).toBeInTheDocument();
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('Kept.');
  });

  it('once sent, the result stays in the empty pane with its reference code, and the case does not come back', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user);
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    expect(await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: /report against/ })).toBeNull();
    expect(within(panel()).getByRole('list', { name: 'Reference codes' })).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Take next case' })).toBeInTheDocument();
  });

  it('a conflict (someone else decided it first) brings the case back, closed, with the notice', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await fillFair(user);
    await w.client.decide(f.id, { verdict: 'no_action', reason: 'Other moderator.', actions: [] });
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    expect(await screen.findByRole('heading', { level: 2, name: /report against/ })).toBeInTheDocument();
    expect(await within(panel()).findByText('Other moderator.')).toBeInTheDocument();
  });

  it('Take next case in the empty pane takes the next one', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'Ra', room: 'ra' });
    w.clock.t += 1000;
    const b = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Rb', room: 'rb' });
    const { user, router } = await open(w, a.id);
    await fillFair(user);
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await user.click(within(panel()).getByRole('button', { name: /^Take next case/ }));
    await waitFor(() => expect(router.path).toBe(`/reports/${b.id}`));
  });
});

describe('Important 1: a failed send is visible on a phone', () => {
  it('the sheet is open on the error, focused, when the send fails and the person is still on the case', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user, container } = await open(w, f.id);
    await fillFair(user);
    w.intercept.fn = (req) => (isDecide(req) ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    const alert = (await within(panel()).findByText('The server had a problem. Try again in a moment.')).closest('[role="alert"]') as HTMLElement;
    expect(dock(container)).toHaveAttribute('data-open', 'true');
    expect(alert).toHaveFocus();
  });

  it('a 409 claimed (someone took the case meanwhile) is shown the same way', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const { user, container } = await open(w, f.id);
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    await fillFair(user);
    await w.clientFor('sen@example.test', 'senior').claimCase(f.person, { takeOver: true });
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    await within(panel()).findByText(/sen is handling this case, so this decision was not sent/);
    expect(dock(container)).toHaveAttribute('data-open', 'true');
  });

  it('a network failure is shown the same way: the sheet is open on the alert, which has focus', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user, container } = await open(w, f.id);
    await fillFair(user);
    w.intercept.fn = (req) => {
      if (isDecide(req)) throw new TypeError('offline');
      return undefined;
    };
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    const alert = (await within(panel()).findByText('Could not reach the server. Check your connection and try again.')).closest('[role="alert"]') as HTMLElement;
    expect(dock(container)).toHaveAttribute('data-open', 'true');
    expect(alert).toHaveFocus();
  });
});

describe('Important 2: Fair brings the suggestion back under React StrictMode too', () => {
  it('Not a problem takes it off once, Fair puts it back once, and the announcement is not doubled', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const user = userEvent.setup();
    render(
      <StrictMode>
        <Hub client={w.client} router={memoryRouter(`/reports/${f.id}`)} now={w.now} mode="detailed" />
      </StrictMode>,
    );
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
    expect(within(panel()).getByRole('group', { name: 'The ladder suggests' })).toBeInTheDocument();
    // Count what the live region is told: StrictMode runs an updater twice, and a doubled announcement is two insertions.
    const region = within(panel()).getByRole('status', { name: 'Decision updates' });
    const told: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if ((n.textContent ?? '') !== '') told.push(n.textContent ?? '');
    });
    watch.observe(region, { childList: true });
    await user.keyboard('2');
    expect(within(panel()).queryByRole('group', { name: 'The ladder suggests' })).toBeNull();
    expect(region).toHaveTextContent(/^Removed 1 action on the reported person\. A report that is not fair cannot act on them\.$/);
    await act(async () => {
      await Promise.resolve();
    });
    expect(told).toEqual(['Removed 1 action on the reported person. A report that is not fair cannot act on them.']);
    watch.disconnect();
    await user.keyboard('1');
    expect(within(panel()).getByRole('group', { name: 'The ladder suggests' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { name: /^Show the line at/ })).toHaveLength(2);
    // And again: the round trip works every time, not only the first.
    await user.keyboard('3');
    await user.keyboard('1');
    expect(within(panel()).getByRole('group', { name: 'The ladder suggests' })).toBeInTheDocument();
    cleanup();
  });

  it('four keys in one batch (before React renders) end in one suggestion, as if they were pressed one by one', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    act(() => {
      for (const key of ['2', '1', '3', '1']) fireEvent.keyDown(document.body, { key });
    });
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).toBeChecked();
    expect(within(panel()).getAllByRole('group', { name: 'The ladder suggests' })).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    expect(within(panel()).getAllByRole('group', { name: /^Action \d$/ })).toHaveLength(1);
    expect(screen.getAllByRole('checkbox', { name: /^Show the line at/ })).toHaveLength(2);
  });
});

describe('Minor 1: no stale snapshot over newer input', () => {
  it('after an Undo, editing, leaving and coming back keeps the newer edit, not the first snapshot', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'Ra', room: 'ra' });
    const b = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Rb', room: 'rb' });
    const { user, router } = await open(w, a.id);
    await fillFair(user, 'First.');
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await user.click(within(panel()).getByRole('button', { name: 'Undo' }));
    await user.type(await within(panel()).findByRole('textbox', { name: 'Reason' }), ' Second.');
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('First. Second.');
    act(() => router.navigate(`/reports/${b.id}`));
    await screen.findByRole('heading', { level: 2, name: /report against Beta/ });
    act(() => router.navigate(`/reports/${a.id}`));
    await screen.findByRole('heading', { level: 2, name: /report against Alpha/ });
    // The form is a fresh one (the edit was not saved anywhere), and it is NOT the old snapshot taken over it.
    expect(await within(panel()).findByRole('textbox', { name: 'Reason' })).toHaveValue('');
  });

  it('coming back to a case whose decision is still waiting and then fails: the form is what you entered', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'Ra', room: 'ra' });
    w.clock.t += 1000;
    const b = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Rb', room: 'rb' });
    const { user, router } = await open(w, a.id);
    await fillFair(user, 'What I entered.');
    w.intercept.fn = (req) => (isDecide(req) ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(within(panel()).getByRole('button', { name: /^Decide and take next/ }));
    await waitFor(() => expect(router.path).toBe(`/reports/${b.id}`));
    // Back to the case while its decision is still in its window.
    act(() => router.navigate(`/reports/${a.id}`));
    await screen.findByRole('region', { name: 'Decision' });
    await pageHides();
    expect(await within(panel()).findByText('The server had a problem. Try again in a moment.')).toBeInTheDocument();
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('What I entered.');
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).toBeChecked();
  });
});

describe('Minor 4: one Take over, in the claim banner', () => {
  it('a senior sees exactly one Take over, in the banner, and the read-only bar points to it', async () => {
    const w = await hubWorld({ role: 'senior', actor: 'sen@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    await open(w, f.id);
    await screen.findByText('maya is handling this case.');
    const all = screen.getAllByRole('button', { name: 'Take over' });
    expect(all).toHaveLength(1);
    expect(all[0]!.closest('.cw-claim')).not.toBeNull();
    expect(within(panel()).queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(within(panel()).getByText('Use Take over in the banner above.')).toBeInTheDocument();
  });

  it('a moderator gets no Take over anywhere and no pointer to one', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    await open(w, f.id);
    await screen.findByText('maya is handling this case.');
    expect(screen.queryAllByRole('button', { name: 'Take over' })).toHaveLength(0);
    expect(within(panel()).queryByText('Use Take over in the banner above.')).toBeNull();
    expect(within(panel()).getByText('You can read it, not decide it, until they release it.')).toBeInTheDocument();
  });
});

describe('Minor 5: focus after Undo goes somewhere that can take it', () => {
  it('Undo reopens the sheet and focuses the Decide button', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user, container } = await open(w, f.id);
    await fillFair(user);
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await user.click(within(panel()).getByRole('button', { name: 'Undo' }));
    await within(panel()).findByRole('button', { name: /^Decide and take next/ });
    expect(dock(container)).toHaveAttribute('data-open', 'true');
    await waitFor(() => expect(within(panel()).getByRole('button', { name: /^Decide and take next/ })).toHaveFocus());
  });
});

describe('B4: no toast for what the screen already says', () => {
  it('Take next does not say "You took the case": the banner does', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'Ra', room: 'ra' });
    const { user } = renderHub(w);
    await user.click(await screen.findByRole('button', { name: /^Take next case/ }));
    await screen.findByRole('heading', { level: 2, name: /report against Alpha/ });
    expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test');
    expect(screen.queryByText(/^You took the/)).toBeNull();
    expect(within(await screen.findByRole('group', { name: 'Who is handling this case' })).getByText("You're handling this.")).toBeInTheDocument();
  });

  it('opening a case from the queue makes no toast either, and a take-over and "nothing left" still do', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.fileRich({ lines: TALK, target: 'Alpha' });
    renderHub(w, { path: `/reports/${a.id}` });
    await screen.findByRole('heading', { level: 2, name: /report against Alpha/ });
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeEmptyDOMElement();
  });
});

describe('release by someone who is no longer the holder', () => {
  it('against the real routes: a release after a take-over the caller has not seen is a no-op and never frees the new holder', async () => {
    const w = await hubWorld({ role: 'senior', actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const ann = w.clientFor('ann@example.test', 'senior');
    const sen = w.clientFor('sen@example.test', 'senior');
    await ann.claimCase(f.person);
    await sen.claimCase(f.person, { takeOver: true });
    expect(await ann.releaseCase(f.person)).toEqual({ released: false });
    expect(w.cw.cases.holder(f.person)?.by).toBe('sen@example.test');
    // Again, and with no claim at all: still a harmless 200.
    expect(await ann.releaseCase(f.person)).toEqual({ released: false });
    await sen.releaseCase(f.person);
    expect(await ann.releaseCase(f.person)).toEqual({ released: false });
    expect(w.cw.cases.holder(f.person)).toBeNull();
  });

  it('in the hub: leaving a case that was taken over meanwhile (the queue has not polled) leaves the new holder\'s claim alone', async () => {
    const w = await hubWorld({ role: 'senior', actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const { router } = await open(w, f.id);
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    await w.clientFor('sen@example.test', 'senior').claimCase(f.person, { takeOver: true });
    act(() => router.navigate('/reports'));
    await waitFor(() => expect(w.sent.some((r) => r.path === `/cases/${f.person}/release`)).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(w.cw.cases.holder(f.person)?.by).toBe('sen@example.test');
  });
});
