import { cleanup, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { WorldOptions } from './world.js';

// "What the filters did" with the overturned counts (appeals landing, 7): a filter report that was overturned on appeal is counted per rule over a fixed 90
// days, and the count sits in the rule's own row (inside the disclosure that already exists). No overturned field, or an empty one, draws the table as it was.

afterEach(() => cleanup());

const owner = (o: WorldOptions = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
const OVERRIDES = { filters: { links: { action: 'mask' as const }, phrases: [{ id: 'ads', label: 'Gold ads', action: 'flag' as const, phrases: ['buy gold'] }] } };

async function setup(overturned?: Record<string, number> | null) {
  const w = await owner({ overrides: OVERRIDES });
  w.cw.rooms.seat('R', 'p1', { clientKey: 'k1' }, 'Spk');
  w.cw.chat.accept('R', 'p1', 'see blorf.com now');
  w.store.addFilterHits([{ day: Math.floor(w.clock.now() / 86_400_000), key: 'phrase.ads', action: 'flag', hits: 2 }]);
  if (overturned !== undefined) {
    w.intercept.fn = async (req) => {
      if (req.method !== 'GET' || req.path !== '/filters/stats') return undefined;
      const real = await w.direct.filterStats(7);
      return { status: 200, body: overturned === null ? real : { ...real, overturned } };
    };
  }
  const r = renderHub(w, { path: '/settings/advanced' });
  await screen.findByRole('region', { name: 'Chat filters' });
  await r.user.click(within(panel()).getByText('What the filters did'));
  const table = await within(panel()).findByRole('table', { name: 'What the filters did' });
  return { w, table, ...r };
}
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Chat filters' });
const rowOf = (table: HTMLElement, text: RegExp): HTMLElement => within(table).getByRole('row', { name: text });
const cells = (row: HTMLElement): string[] => within(row).getAllByRole('cell').map((c) => c.textContent ?? '');

describe('the overturned counts in the hits table', () => {
  it('a count appears beside its row, with the label text', async () => {
    const { table } = await setup({ 'phrase.ads': 3 });
    const gold = rowOf(table, /Gold ads/);
    expect(within(gold).getByText('Overturned on appeal (90 days): 3')).toBeInTheDocument();
    // The row's other cells are what they were.
    expect(cells(gold).slice(1)).toEqual(['0', '2', '0', '0', '0']);
    expect(within(table).getAllByRole('columnheader')).toHaveLength(6);
  });

  it('a key with a count and no hits in the window still gets a row, with all its counts at zero', async () => {
    const { table } = await setup({ 'personal_info.phone': 1, 'phrase.ads': 2 });
    const phone = rowOf(table, /Phone number/);
    expect(within(phone).getByText('Overturned on appeal (90 days): 1')).toBeInTheDocument();
    expect(cells(phone).slice(1)).toEqual(['0', '0', '0', '0', '0']);
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('a key that has hits keeps them and shows no overturned line when it has no count', async () => {
    const { table } = await setup({ 'phrase.ads': 2 });
    const links = rowOf(table, /Link on no list/);
    expect(within(links).queryByText(/Overturned on appeal/)).toBeNull();
  });

  it('a key with a count that is not a known rule is named like any other unknown key, never by the raw key', async () => {
    const { table } = await setup({ 'mystery.key': 4 });
    expect(table.textContent).not.toContain('mystery.key');
    expect(within(table).getByText('Overturned on appeal (90 days): 4')).toBeInTheDocument();
  });

  it('no overturned field renders as before', async () => {
    const { table } = await setup(null);
    expect(within(table).queryByText(/Overturned on appeal/)).toBeNull();
    expect(cells(rowOf(table, /Gold ads/))).toEqual(['Gold ads', '0', '2', '0', '0', '0']);
  });

  it('an empty overturned object renders exactly as before', async () => {
    const { table } = await setup({});
    expect(within(table).queryByText(/Overturned on appeal/)).toBeNull();
    expect(cells(rowOf(table, /Gold ads/))).toEqual(['Gold ads', '0', '2', '0', '0', '0']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  it('a zero count is not shown', async () => {
    const { table } = await setup({ 'phrase.ads': 0 });
    expect(within(table).queryByText(/Overturned on appeal/)).toBeNull();
  });

  it('the table has no axe violations with the counts', async () => {
    const { container } = await setup({ 'phrase.ads': 3, 'link.unlisted': 1 });
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it('the stats read is still the one read, with no extra request for the counts', async () => {
    const { w } = await setup({ 'phrase.ads': 3 });
    expect(w.sent.filter((r) => r.path === '/filters/stats')).toHaveLength(1);
  });
});
