import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { appealsHub, HOUR } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { WorldOptions } from './world.js';

// The Person page shows an appeal as a line in the timeline (appeals, design 4.9): "Appeal: reduced", with its date, and no referee card (nothing was done
// to them by it). Nothing above the timeline changes, and no other element appears.

const SENIOR: WorldOptions = { role: 'senior', actor: 'bea@example.test' };
const timeline = (): HTMLElement => screen.getByRole('region', { name: 'Timeline' });
const entries = (): string[] => within(timeline()).getAllByRole('listitem').map((li) => (li.querySelector('.cw-rec-head strong') as HTMLElement | null)?.textContent ?? '');

async function page(w: AppealsHub | Awaited<ReturnType<typeof hubWorld>>, person: string, o: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/people/${person}`, ...o });
  await screen.findByRole('region', { name: 'Timeline' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return r;
}

describe('an appeal in the timeline', () => {
  it('an open appeal reads "Appeal: waiting for a decision", with its date and a way to open it', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory' });
    await page(w, a.person);
    const li = within(timeline()).getAllByRole('listitem').find((x) => /^Appeal/.test(x.textContent ?? '')) as HTMLElement;
    expect(li).toHaveTextContent('Appeal: waiting for a decision');
    expect(li.querySelector('time')).not.toBeNull();
    expect(within(li).getByRole('link', { name: 'Open the appeal' })).toHaveAttribute('href', `#/appeals/${a.appealId}`);
  });

  it.each([
    ['uphold', undefined, 'Appeal: decision kept'],
    ['revoke', undefined, 'Appeal: removed'],
    ['reduce', { kind: 'chat' as const, durationMs: HOUR }, 'Appeal: reduced'],
  ] as const)('%s reads "%s"', async (outcome, to, words) => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory', kind: 'chat', durationMs: 6 * HOUR });
    await w.client.decideAppeal(a.appealId, { outcome, reason: 'private', ...(to === undefined ? {} : { to }) });
    await page(w, a.person);
    expect(entries()).toContain(words);
  });

  it('a moot appeal (the sanction was revoked by hand first) is left out, as the server leaves it out of every list', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory' });
    await w.client.revokeSanction(a.groupId, 'a misread');
    await page(w, a.person);
    expect(entries().some((e) => /^Appeal/.test(e))).toBe(false);
  });

  it('has no referee card of its own, and the other entries keep theirs', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory' });
    await page(w, a.person);
    const lis = within(timeline()).getAllByRole('listitem');
    const mine = lis.find((x) => /^Appeal/.test(x.textContent ?? '')) as HTMLElement;
    expect(mine.querySelector('.cw-card')).toBeNull();
    expect(lis.some((x) => x.querySelector('.cw-card') !== null)).toBe(true);
  });

  it('is placed by its date among the reports and sanctions, newest first', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory' });
    w.clock.t += 2 * HOUR;
    await w.file({ target: 'Mallory', reporter: 'Later' });
    await page(w, a.person);
    const order = entries();
    expect(order.indexOf('Appeal: waiting for a decision')).toBeGreaterThan(-1);
    // A report filed after the appeal comes first; the sanction and the report that made it come after the appeal.
    expect(order[0]).toBe('Report');
    expect(order.indexOf('Appeal: waiting for a decision')).toBeLessThan(order.lastIndexOf('Report'));
  });

  it('names the sanction it is against, in words, beside the entry', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ target: 'Mallory', kind: 'ban', durationMs: null });
    await page(w, a.person);
    const li = within(timeline()).getAllByRole('listitem').find((x) => /^Appeal/.test(x.textContent ?? '')) as HTMLElement;
    expect(li).toHaveTextContent('Ban');
  });

  it('a link to the appeal is only for a role that may read appeals', async () => {
    const w = await appealsHub({ ...SENIOR, permissions: { 'appeals.read': 'owner' } });
    const a = await w.appeal({ target: 'Mallory' });
    await page(w, a.person);
    // A role without appeals.read gets no appeals in the history at all, so no entry and no link.
    expect(within(timeline()).queryByText(/^Appeal:/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the appeal' })).toBeNull();
  });
});

describe('and nothing else on the page changes', () => {
  const sections = (): string[] => within(document.querySelector('main') as HTMLElement).getAllByRole('region').map((r) => r.getAttribute('aria-label') ?? within(r).queryByRole('heading')?.textContent ?? '');

  it('the same regions and the same controls with an appeal as without one', async () => {
    const without = await appealsHub(SENIOR);
    const f = await without.file({ target: 'Mallory' });
    await without.sanction(f.person, 'chat', 2, 6 * HOUR);
    const r1 = await page(without, f.person);
    const main = (): HTMLElement => document.querySelector('main') as HTMLElement;
    const controls = (): Array<string | null> => within(main()).getAllByRole('button').map((b) => b.textContent);
    const before = { sections: sections(), buttons: controls() };
    r1.unmount();

    const withAppeal = await appealsHub(SENIOR);
    const a = await withAppeal.appeal({ target: 'Mallory', kind: 'chat', durationMs: 6 * HOUR });
    await page(withAppeal, a.person);
    expect(sections()).toEqual(before.sections);
    expect(controls()).toEqual(before.buttons);
  });

  it('with appeals off the timeline is what it was: no appeal entry, no new request', async () => {
    const w = await hubWorld(SENIOR);
    const f = await w.file({ target: 'Mallory' });
    await w.sanction(f.person, 'chat', 2, 6 * HOUR);
    await page(w, f.person);
    expect(within(timeline()).queryByText(/^Appeal:/)).toBeNull();
    expect(w.sent.filter((r) => /appeals/.test(r.path))).toEqual([]);
    expect(Object.keys((await w.client.personHistory(f.person)))).not.toContain('appeals');
  });

  it('a person with appeals on and none filed shows no appeal entry', async () => {
    const w = await appealsHub(SENIOR);
    const f = await w.file({ target: 'Mallory' });
    await w.sanction(f.person, 'chat', 2, 6 * HOUR);
    await page(w, f.person);
    expect(within(timeline()).queryByText(/^Appeal:/)).toBeNull();
  });
});
