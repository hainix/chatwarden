import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { nextOpenReport } from '../src/queue.js';
import type { QueueGroup } from '../src/queue.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// Fix round 3: one case per person. Deciding one report of several keeps the person's claim, the queue row, and goes on to the
// same person's next open report; the claim is released only when the last one is decided.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
];

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });
const calls = (w: HubWorld, path: RegExp): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && path.test(r.path));
const isNext = /^\/cases\/next$/;
const isRelease = /\/release$/;

/** Three open reports about Mallory (oldest first: m1, m2, m3), and one about Zed. */
async function world3() {
  const w = await hubWorld({ actor: 'ann@example.test' });
  const m1 = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'R1', room: 'r1' });
  w.clock.t += 1000;
  const m2 = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'R2', room: 'r2' });
  w.clock.t += 1000;
  const m3 = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'R3', room: 'r3' });
  w.clock.t += 1000;
  const z = await w.fileRich({ lines: TALK, target: 'Zed', reporter: 'Rz', room: 'rz' });
  return { w, m1, m2, m3, z };
}

async function openCase(w: HubWorld, id: string) {
  const r = renderHub(w, { path: `/reports/${id}` });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  // A case accepts an act key a moment after it appeared; the guard's clock moves with the world's.
  w.clock.t += 400;
  return r;
}
async function fillAnd(user: ReturnType<typeof renderHub>['user'], button: string | RegExp) {
  await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
  await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Clear from the chat.');
  await user.click(within(panel()).getByRole('button', { name: button }));
}
const row = (name: string): HTMLElement => {
  const pane = screen.getByRole('region', { name: 'Open cases' });
  return within(pane).getByText(name, { selector: '.cw-case-name' }).closest('.cw-case') as HTMLElement;
};

describe('nextOpenReport: the one rule for "the next report about this person"', () => {
  const group = (person: string, ids: string[]): QueueGroup =>
    ({ person, reportIds: ids, entries: ids.map((id, i) => ({ id, category: 'harassment', createdAt: 1000 - i })) }) as unknown as QueueGroup;

  it('is the oldest other open report of the person (entries are newest first), and the count of what is left', () => {
    const groups = [group('p', ['c', 'b', 'a']), group('q', ['z'])];
    expect(nextOpenReport(groups, 'p', 'c')).toMatchObject({ id: 'a', left: 2 });
    expect(nextOpenReport(groups, 'p', 'a')).toMatchObject({ id: 'b', left: 2 });
    expect(nextOpenReport(groups, 'p', 'b')).toMatchObject({ id: 'a', left: 2 });
  });
  it('leaves out reports whose decision is already on its way (the queue has not read them as closed yet)', () => {
    const groups = [group('p', ['c', 'b', 'a'])];
    expect(nextOpenReport(groups, 'p', 'c', new Set(['a']))).toMatchObject({ id: 'b', left: 1 });
    expect(nextOpenReport(groups, 'p', 'c', new Set(['a', 'b']))).toBeNull();
    expect(nextOpenReport(groups, 'p', 'c', new Set(['c']))).toMatchObject({ id: 'a', left: 2 });
  });
  it('is null when the decided report is the only one, or the person is not in the queue', () => {
    expect(nextOpenReport([group('p', ['a'])], 'p', 'a')).toBeNull();
    expect(nextOpenReport([group('p', ['a'])], 'nobody', 'a')).toBeNull();
    expect(nextOpenReport([], 'p', 'a')).toBeNull();
  });
  it('ignores other people\'s reports and counts the decided one out even when it is the oldest', () => {
    const groups = [group('p', ['b', 'a']), group('q', ['y', 'x'])];
    expect(nextOpenReport(groups, 'p', 'a')).toMatchObject({ id: 'b', left: 1 });
  });
});

describe('deciding one report of three keeps the person\'s claim', () => {
  it('the notice offers "Next report on Mallory (2 left)"; it opens the oldest remaining one, keeps the claim and never calls /cases/next', async () => {
    const { w, m1, m2, m3 } = await world3();
    const { user, router } = await openCase(w, m3.id);
    await waitFor(() => expect(w.cw.cases.holder(m3.person)?.by).toBe('ann@example.test'));
    await fillAnd(user, 'Decide');
    // The row keeps showing "You" between the decisions: it is not hidden and the claim is not let go.
    expect(row('Mallory')).toHaveAttribute('data-claim', 'you');
    await pageHides();
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(w.cw.cases.holder(m3.person)?.by).toBe('ann@example.test');
    expect(row('Mallory')).toHaveAttribute('data-claim', 'you');
    const next = within(panel()).getByRole('button', { name: 'Next report on Mallory (2 left)' });
    expect(within(panel()).getByRole('button', { name: /^Take next case/ })).toBeInTheDocument();
    await user.click(next);
    await waitFor(() => expect(router.path).toBe(`/reports/${m1.id}`));
    await screen.findByRole('heading', { level: 2, name: /report against Mallory/ });
    expect(calls(w, isNext)).toHaveLength(0);
    expect(calls(w, isRelease)).toHaveLength(0);
    expect(w.cw.cases.holder(m3.person)?.by).toBe('ann@example.test');
    void m2;
  });

  it('the count goes 3, 2 left, 1 left, then nothing: the last decision releases the claim and today\'s view stays', async () => {
    const { w, m1, m2, m3 } = await world3();
    const { user, router } = await openCase(w, m3.id);
    await fillAnd(user, 'Decide');
    await pageHides();
    await user.click(await within(panel()).findByRole('button', { name: 'Next report on Mallory (2 left)' }));
    await waitFor(() => expect(router.path).toBe(`/reports/${m1.id}`));
    await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
    await fillAnd(user, 'Decide');
    await pageHides();
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(w.cw.cases.holder(m3.person)?.by).toBe('ann@example.test');
    await user.click(within(panel()).getByRole('button', { name: 'Next report on Mallory (1 left)' }));
    await waitFor(() => expect(router.path).toBe(`/reports/${m2.id}`));
    await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
    await fillAnd(user, 'Decide');
    await pageHides();
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    await waitFor(() => expect(w.cw.cases.holder(m3.person)).toBeNull());
    expect(within(panel()).queryByRole('button', { name: /^Next report on/ })).toBeNull();
    expect(within(panel()).getByRole('button', { name: 'Take next case' })).toBeInTheDocument();
    expect(calls(w, isNext)).toHaveLength(0);
    // Between the decisions the claim was never let go.
    expect(calls(w, isRelease)).toHaveLength(0);
  });

  it('"Decide and take next" goes to the same person\'s next report first, and to /cases/next only when none are left', async () => {
    const { w, m1, m2, m3, z } = await world3();
    const { user, router } = await openCase(w, m3.id);
    await fillAnd(user, /^Decide and take next/);
    await waitFor(() => expect(router.path).toBe(`/reports/${m1.id}`));
    expect(calls(w, isNext)).toHaveLength(0);
    await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
    await fillAnd(user, /^Decide and take next/);
    await waitFor(() => expect(router.path).toBe(`/reports/${m2.id}`));
    expect(calls(w, isNext)).toHaveLength(0);
    await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
    await fillAnd(user, /^Decide and take next/);
    await waitFor(() => expect(router.path).toBe(`/reports/${z.id}`));
    expect(calls(w, isNext)).toHaveLength(1);
    await pageHides();
    await waitFor(() => expect(w.cw.reports.get(m2.id)?.status).toBe('actioned'));
    expect(w.cw.cases.holder(m3.person)).toBeNull();
    expect(w.cw.cases.holder(z.person)?.by).toBe('ann@example.test');
  });

  it('the Ctrl+Enter key does the same', async () => {
    const { w, m1, m3 } = await world3();
    const { user, router } = await openCase(w, m3.id);
    await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Keys.{Control>}{Enter}{/Control}');
    await waitFor(() => expect(router.path).toBe(`/reports/${m1.id}`));
    expect(calls(w, isNext)).toHaveLength(0);
  });

  it('moving between the same person\'s reports never releases the claim', async () => {
    const { w, m1, m3 } = await world3();
    const { user, router } = await openCase(w, m3.id);
    await waitFor(() => expect(w.cw.cases.holder(m3.person)?.by).toBe('ann@example.test'));
    await fillAnd(user, /^Decide and take next/);
    await waitFor(() => expect(router.path).toBe(`/reports/${m1.id}`));
    await screen.findByRole('heading', { level: 2, name: /report against Mallory/ });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(calls(w, isRelease)).toHaveLength(0);
    expect(w.cw.cases.holder(m3.person)?.by).toBe('ann@example.test');
    await pageHides();
    await waitFor(() => expect(w.cw.reports.get(m3.id)?.status).toBe('actioned'));
    expect(w.cw.cases.holder(m3.person)?.by).toBe('ann@example.test');
  });

  it('a report about the same person that arrives mid-case counts as remaining', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a = await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'R1', room: 'r1' });
    const { user } = await openCase(w, a.id);
    await waitFor(() => expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test'));
    const reads = (): number => w.sent.filter((r) => r.method === 'GET' && r.path === '/reports').length;
    const before = reads();
    w.clock.t += 1000;
    await w.fileRich({ lines: TALK, target: 'Mallory', reporter: 'R2', room: 'r2' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await fillAnd(user, 'Decide');
    await pageHides();
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(await within(panel()).findByRole('button', { name: 'Next report on Mallory (1 left)' })).toBeInTheDocument();
    expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test');
  });

  it('Undo with reports remaining brings the case back and the claim was never let go', async () => {
    const { w, m3 } = await world3();
    const { user } = await openCase(w, m3.id);
    await waitFor(() => expect(w.cw.cases.holder(m3.person)?.by).toBe('ann@example.test'));
    await fillAnd(user, 'Decide');
    await user.click(within(panel()).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('heading', { level: 2, name: /report against Mallory/ })).toBeInTheDocument();
    expect(row('Mallory')).toHaveAttribute('data-claim', 'you');
    expect(w.cw.cases.holder(m3.person)?.by).toBe('ann@example.test');
  });

  it('choosing Take next case instead of the next report lets the person go: the claim is released, the waiting decision still goes out', async () => {
    const { w, m3, z } = await world3();
    const { user, router } = await openCase(w, m3.id);
    await waitFor(() => expect(w.cw.cases.holder(m3.person)?.by).toBe('ann@example.test'));
    await fillAnd(user, 'Decide');
    await user.click(within(panel()).getByRole('button', { name: /^Take next case/ }));
    await waitFor(() => expect(router.path).toBe(`/reports/${z.id}`));
    await waitFor(() => expect(w.cw.cases.holder(m3.person)).toBeNull());
    expect(calls(w, isRelease)).toHaveLength(1);
    await pageHides();
    await waitFor(() => expect(w.cw.reports.get(m3.id)?.status).toBe('actioned'));
    expect(w.cw.cases.holder(m3.person)).toBeNull();
  });

  it('the last report of a person is unchanged: the row leaves at once and the claim goes with the decision', async () => {
    const { w, z } = await world3();
    const { user } = await openCase(w, z.id);
    await waitFor(() => expect(w.cw.cases.holder(z.person)?.by).toBe('ann@example.test'));
    await fillAnd(user, 'Decide');
    const pane = screen.getByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(pane).queryByText('Zed')).toBeNull());
    await pageHides();
    await waitFor(() => expect(w.cw.cases.holder(z.person)).toBeNull());
  });
});
