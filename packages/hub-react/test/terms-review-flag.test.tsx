import { cleanup, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The term review flag (appeals landing, 6.2): a term whose automatic restrictions were overturned on appeal often enough (the server's flag, over 90 days) is
// marked in its own row, with the row's existing edit action one step from the mark. Nothing is reordered, hidden or edited by the flag.

afterEach(() => cleanup());

type Flag = { termId: string; overturned: number; lastAt: number };
const region = (name: string | RegExp): HTMLElement => screen.getByRole('region', { name });
const rowOf = (el: HTMLElement, text: string | RegExp): HTMLElement => {
  const row = within(el)
    .getAllByRole('row')
    .find((r) => (typeof text === 'string' ? r.textContent?.includes(text) : text.test(r.textContent ?? '')));
  if (row === undefined) throw new Error(`no row with ${String(text)}`);
  return row;
};

async function openTerms(o: { flags?: (w: HubWorld) => Flag[] | undefined | 'absent'; world?: WorldOptions } = {}) {
  const w = await hubWorld(o.world ?? {});
  const idOf = (word: string): string => {
    const row = w.live.rows.terms.find((r) => r.term === word);
    if (row === undefined) throw new Error(`no term ${word}`);
    return row.id;
  };
  if (o.flags !== undefined) {
    const flags = o.flags(w);
    w.intercept.fn = async (req) => {
      if (req.method !== 'GET' || req.path !== '/terms') return undefined;
      const real = (await w.direct.listTerms()) as unknown as Record<string, unknown>;
      const { reviewFlags: _drop, ...rest } = real;
      void _drop;
      return { status: 200, body: flags === 'absent' || flags === undefined ? rest : { ...rest, reviewFlags: flags } };
    };
  }
  const r = renderHub(w, { path: '/terms' });
  await screen.findByRole('heading', { level: 2, name: 'Terms' });
  await screen.findByRole('region', { name: /^English/ });
  const terms = within(region('English (en)')).getByRole('region', { name: 'Terms in English (en)' });
  return { w, idOf, terms, ...r };
}
const termRows = (terms: HTMLElement): string[] => within(terms).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]?.textContent ?? '');

describe('the flag on a term', () => {
  it('a flagged term shows "Overturned on appeal 3 times in 90 days"; an unflagged one shows nothing extra', async () => {
    const { terms, user } = await openTerms({ flags: (w) => [{ termId: w.live.rows.terms.find((r) => r.term === 'zorbak')!.id, overturned: 3, lastAt: 1 }] });
    await user.click(screen.getByRole('checkbox', { name: 'Show words' }));
    const zorbak = rowOf(terms, 'zorbak');
    expect(within(zorbak).getByText('Overturned on appeal 3 times in 90 days')).toBeInTheDocument();
    const other = rowOf(terms, 'vlemmo');
    expect(within(other).queryByText(/Overturned on appeal/)).toBeNull();
    expect(within(terms).getAllByText(/Overturned on appeal/)).toHaveLength(1);
    // The block count beside it is unchanged.
    expect(within(zorbak).getByText('0')).toBeInTheDocument();
  });

  it('says it in the singular for one (a count the server does not send, handled anyway)', async () => {
    const { terms } = await openTerms({ flags: (w) => [{ termId: w.live.rows.terms[0]!.id, overturned: 1, lastAt: 1 }] });
    expect(within(terms).getByText('Overturned on appeal 1 time in 90 days')).toBeInTheDocument();
  });

  it('a server with no reviewFlags field renders as before', async () => {
    const { terms } = await openTerms({ flags: () => 'absent' });
    expect(within(terms).queryByText(/Overturned on appeal/)).toBeNull();
    expect(within(terms).queryByRole('button', { name: /^Review/ })).toBeNull();
  });

  it('an empty list renders as before, and a flag for a term that is not listed shows nowhere', async () => {
    const { terms } = await openTerms({ flags: () => [{ termId: 'syn:not-here', overturned: 4, lastAt: 1 }] });
    expect(within(terms).queryByText(/Overturned on appeal/)).toBeNull();
    cleanup();
    const none = await openTerms({ flags: () => [] });
    expect(within(none.terms).queryByText(/Overturned on appeal/)).toBeNull();
  });

  it('never removes or reorders a row', async () => {
    const plain = await openTerms();
    const before = termRows(plain.terms);
    cleanup();
    const flagged = await openTerms({ flags: (w) => [{ termId: w.live.rows.terms[3]!.id, overturned: 5, lastAt: 9 }, { termId: w.live.rows.terms[0]!.id, overturned: 2, lastAt: 3 }] });
    expect(termRows(flagged.terms)).toEqual(before);
    expect(within(flagged.terms).getAllByText(/Overturned on appeal/)).toHaveLength(2);
  });

  it('the flag never edits a term: opening the page and using the flag send no write', async () => {
    const { w, terms, user } = await openTerms({ flags: (x) => [{ termId: x.live.rows.terms[0]!.id, overturned: 3, lastAt: 1 }] });
    await user.click(within(terms).getByRole('button', { name: 'Review term 1' }));
    expect(w.sent.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('the row\'s edit action is reachable from the flag: its button takes the focus', async () => {
    const { terms, user } = await openTerms({ flags: (w) => [{ termId: w.live.rows.terms[1]!.id, overturned: 3, lastAt: 1 }] });
    const review = within(terms).getByRole('button', { name: 'Review term 2' });
    expect(review).toHaveTextContent('Review');
    await user.click(review);
    expect(within(terms).getByRole('button', { name: 'Edit term 2' })).toHaveFocus();
  });

  it('the flag line names no word while words are hidden', async () => {
    const { container } = await openTerms({ flags: (w) => [{ termId: w.live.rows.terms[0]!.id, overturned: 3, lastAt: 1 }] });
    for (const word of ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn']) expect(container.innerHTML.toLowerCase()).not.toContain(word);
  });

  it('without terms.write the flag is the line alone: no button, since there is no edit to reach', async () => {
    const { terms } = await openTerms({
      world: { role: 'moderator', permissions: { 'terms.write': 'owner' } },
      flags: (w) => [{ termId: w.live.rows.terms[0]!.id, overturned: 3, lastAt: 1 }],
    });
    expect(within(terms).getByText('Overturned on appeal 3 times in 90 days')).toBeInTheDocument();
    expect(within(terms).queryByRole('button', { name: /^Review/ })).toBeNull();
  });

  it('the table has no axe violations with a flag', async () => {
    const { container } = await openTerms({ flags: (w) => [{ termId: w.live.rows.terms[0]!.id, overturned: 3, lastAt: 1 }] });
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});
