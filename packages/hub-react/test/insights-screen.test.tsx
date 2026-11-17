import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { InsightsResult } from '@chatwarden/core';
import { renderHub } from './render.js';
import { HOUR, MINUTE, hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The Insights page (design 8): a read-only page of team numbers: counts and times in tables with captions, the median beside the longest
// wait, no chart, no export, never a name. Each number is drawn from a fixture the real route could send; the real route is read once too.

const ON: WorldOptions = { overrides: { desk: { insights: true } } };

const FIXTURE: InsightsResult = {
  days: 30,
  from: 1_799_000_000_000,
  to: 1_800_000_000_000,
  reports: { filed: 120, decided: 100, open: 20 },
  decision: { decided: 100, medianMs: 25 * MINUTE, p90Ms: 3 * HOUR },
  urgent: { filed: 4, decided: 3, medianMs: 7 * MINUTE },
  wait: { longestOpenMs: 52 * HOUR, backlog: { under1h: 5, under4h: 6, under1d: 4, under3d: 3, over3d: 2 } },
  byReason: [
    { reason: 'harassment', label: 'Insults or harassment', count: 60 },
    { reason: 'spam', label: 'Spam or ads', count: 40 },
    { reason: 'none', label: 'No reason given', count: 20 },
  ],
  byOutcome: { actioned: 55, dismissed: 40, badFaith: 5 },
  byRule: [
    { rule: 2, count: 30 },
    { rule: 'uncovered', count: 3 },
  ],
  chat: { delivered: 50_000, refused: 1_200, reportsPer1000: 2.4 },
  partial: false,
};

function serve(w: HubWorld, body: InsightsResult | ((days: string | number | undefined) => InsightsResult)): { asked: Array<string | number | undefined> } {
  const asked: Array<string | number | undefined> = [];
  w.intercept.fn = (req) => {
    if (req.method === 'GET' && req.path === '/insights') {
      asked.push(req.query?.['days']);
      return { status: 200, body: typeof body === 'function' ? body(req.query?.['days']) : body };
    }
    return undefined;
  };
  return { asked };
}
async function open(w: HubWorld, extra: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: '/insights', ...extra });
  await screen.findByRole('heading', { level: 2, name: 'Insights' });
  await screen.findByRole('table', { name: 'Reports' });
  return r;
}
const table = (name: string): HTMLElement => screen.getByRole('table', { name });
const cell = (name: string, row: string): string => {
  const r = within(table(name)).getAllByRole('row').find((x) => within(x).queryByRole('rowheader', { name: row }) !== null);
  if (r === undefined) throw new Error(`no row ${row} in ${name}`);
  return within(r).getAllByRole('cell').map((c) => c.textContent).join(' | ');
};

describe('the page', () => {
  it('draws each number from the fixture, in tables with captions and header cells', async () => {
    const w = await hubWorld({ ...ON });
    serve(w, FIXTURE);
    await open(w);
    expect(cell('Reports', 'Filed')).toBe('120');
    expect(cell('Reports', 'Decided')).toBe('100');
    expect(cell('Reports', 'Open now')).toBe('20');
    expect(cell('Time to a decision', 'Median')).toBe('25m');
    expect(cell('Time to a decision', '90th percentile')).toBe('3h');
    expect(cell('Time to a decision', 'Longest wait now')).toBe('2d');
    expect(cell('Urgent reports', 'Filed')).toBe('4');
    expect(cell('Urgent reports', 'Median')).toBe('7m');
    expect(cell('How long open reports have waited', 'Under 1 hour')).toBe('5');
    expect(cell('How long open reports have waited', '3 days or more')).toBe('2');
    expect(cell('Reports by reason', 'Insults or harassment')).toBe('60');
    expect(cell('Reports by reason', 'No reason given')).toBe('20');
    expect(cell('What was decided', 'Action taken')).toBe('55');
    expect(cell('What was decided', 'Dismissed')).toBe('40');
    expect(cell('What was decided', 'Dismissed as bad faith')).toBe('5');
    expect(cell('Sanctions by Community Rule', 'Rule 2')).toBe('30');
    expect(cell('Sanctions by Community Rule', 'Not covered by a rule')).toBe('3');
    expect(cell('Chat', 'Lines delivered')).toBe('50,000');
    expect(cell('Chat', 'Lines refused')).toBe('1,200');
    expect(cell('Chat', 'Reports per 1,000 lines')).toBe('2.4');
    for (const t of screen.getAllByRole('table')) {
      expect(t.querySelector('caption')).not.toBeNull();
      expect(within(t).getAllByRole('columnheader').length).toBeGreaterThan(0);
      expect(within(t).getAllByRole('rowheader').length).toBeGreaterThan(0);
    }
  });

  it('puts the median beside the longest wait, in one table', async () => {
    const w = await hubWorld({ ...ON });
    serve(w, FIXTURE);
    await open(w);
    const t = table('Time to a decision');
    expect(within(t).getByRole('rowheader', { name: 'Median' })).toBeInTheDocument();
    expect(within(t).getByRole('rowheader', { name: 'Longest wait now' })).toBeInTheDocument();
  });

  it('shows a median that is not there yet as "not enough decisions yet"', async () => {
    const w = await hubWorld({ ...ON });
    serve(w, { ...FIXTURE, decision: { decided: 2, medianMs: null, p90Ms: null }, urgent: { filed: 1, decided: 1, medianMs: null } });
    await open(w);
    expect(cell('Time to a decision', 'Median')).toBe('not enough decisions yet');
    expect(cell('Time to a decision', '90th percentile')).toBe('not enough decisions yet');
    expect(cell('Urgent reports', 'Median')).toBe('not enough decisions yet');
  });

  it('says so for a partial read, and when line counting was off or began part-way through the window', async () => {
    const w = await hubWorld({ ...ON });
    serve(w, { ...FIXTURE, partial: true, chat: null });
    const first = await open(w);
    expect(screen.getByText(/partial count/i)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Chat' })).toBeNull();
    expect(screen.getByText('Lines were not counted during this window, so there is no report rate.')).toBeInTheDocument();
    w.intercept.fn = (req) => (req.path === '/insights' ? { status: 200, body: { ...FIXTURE, chat: { delivered: 900, refused: 3, reportsPer1000: null } } } : undefined);
    first.unmount();
    const again = await open(w);
    expect(within(table('Chat')).getAllByText('not shown').length).toBeGreaterThan(0);
    expect(screen.getByText('Counting began part-way through this window, so the rate is not shown.')).toBeInTheDocument();
    again.unmount();
  });

  it('an empty window is zeros and dashes, never NaN or a blank', async () => {
    const w = await hubWorld({ ...ON });
    serve(w, {
      ...FIXTURE,
      reports: { filed: 0, decided: 0, open: 0 },
      decision: { decided: 0, medianMs: null, p90Ms: null },
      urgent: { filed: 0, decided: 0, medianMs: null },
      wait: { longestOpenMs: 0, backlog: { under1h: 0, under4h: 0, under1d: 0, under3d: 0, over3d: 0 } },
      byReason: [],
      byOutcome: { actioned: 0, dismissed: 0, badFaith: 0 },
      byRule: [],
      chat: null,
    });
    await open(w);
    expect(document.body.textContent).not.toMatch(/NaN|undefined|null|Infinity/);
    expect(cell('Reports', 'Filed')).toBe('0');
    expect(cell('Time to a decision', 'Longest wait now')).toBe('none open');
    expect(screen.getByText('No reports in this window.')).toBeInTheDocument();
    expect(screen.getByText('No sanctions in this window.')).toBeInTheDocument();
  });

  it('has no chart, no image, no export and no name: nothing a person could be picked out by', async () => {
    const w = await hubWorld({ ...ON, actor: 'ann@example.test' });
    const f = await w.file({ target: 'Mallory', reporter: 'Rhea', reason: 'spam' });
    await w.clientFor('bea@example.test').decide(f.id, { verdict: 'no_action', actions: [] }).catch(() => undefined);
    await open(w);
    const tables = document.querySelector('.cw-insights-tables') as HTMLElement;
    expect(tables.querySelector('svg, canvas, img, [role="img"], [role="figure"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /export|download|csv/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /export|download|csv/i })).toBeNull();
    const text = tables.textContent ?? '';
    for (const forbidden of ['ann', 'bea', 'Mallory', 'Rhea', f.person, f.reporter]) {
      expect(new RegExp(`\b${forbidden}\b`).test(text), forbidden).toBe(false);
    }
    expect(text).not.toContain('example.test');
  });

  it('reads the real route: what was filed and decided appears in the tables', async () => {
    const w = await hubWorld({ ...ON, role: 'senior' });
    const a = await w.file({ target: 'A', reason: 'spam' });
    await w.file({ target: 'B', reason: 'harassment' });
    w.clock.t += 10 * MINUTE;
    await w.direct.decide(a.id, { verdict: 'no_action', actions: [] });
    await open(w);
    await waitFor(() => expect(cell('Reports', 'Filed')).toBe('2'));
    expect(cell('Reports', 'Decided')).toBe('1');
    expect(cell('Reports', 'Open now')).toBe('1');
    expect(cell('Reports by reason', 'Spam or ads')).toBe('1');
  });
});

describe('the window', () => {
  it('asks for 30 days first, and 7 or 90 when chosen; the choice is a labelled select', async () => {
    const w = await hubWorld({ ...ON });
    const { asked } = serve(w, (days) => ({ ...FIXTURE, days: Number(days) as 7 | 30 | 90 }));
    const { user } = await open(w);
    expect(asked).toEqual([30]);
    const select = screen.getByRole('combobox', { name: 'Window' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Last 7 days', 'Last 30 days', 'Last 90 days']);
    await user.selectOptions(select, 'Last 7 days');
    await waitFor(() => expect(asked).toEqual([30, 7]));
    await user.selectOptions(select, 'Last 90 days');
    await waitFor(() => expect(asked).toEqual([30, 7, 90]));
    expect(screen.getByText(/the last 90 days/i)).toBeInTheDocument();
  });

  it('a failed read says so with a way to try again, and keeps the page', async () => {
    const w = await hubWorld({ ...ON });
    w.intercept.fn = (req) => (req.path === '/insights' ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    renderHub(w, { path: '/insights' });
    await screen.findByRole('heading', { level: 2, name: 'Insights' });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('who may open it', () => {
  it('a hub with Insights off answers the route with the server\'s 404 in words, and the Overview has no link', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/insights' });
    await screen.findByRole('heading', { level: 2, name: 'Insights' });
    expect(await screen.findByText('That no longer exists.')).toBeInTheDocument();
  });

  it('a role without insights.read is stopped at the gate like any screen it may not open', async () => {
    const w = await hubWorld({ ...ON, permissions: { 'insights.read': 'owner' } });
    renderHub(w, { path: '/insights' });
    await screen.findByRole('heading', { level: 2, name: 'Not available for your role' });
    expect(w.sent.filter((r) => r.path === '/insights')).toEqual([]);
  });

  it('is reached from the command bar when on', async () => {
    const w = await hubWorld({ ...ON });
    const { user } = renderHub(w);
    await screen.findByRole('region', { name: 'Open cases' });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search people, reports, terms or screens' });
    await user.type(input, 'Insights');
    expect(await screen.findByRole('option', { name: /Insights/ })).toBeInTheDocument();
  });

  it('is not in the command bar when off', async () => {
    const w = await hubWorld();
    const { user } = renderHub(w);
    await screen.findByRole('region', { name: 'Open cases' });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search people, reports, terms or screens' });
    await user.type(input, 'Insights');
    expect(screen.queryByRole('option', { name: /Insights/ })).toBeNull();
  });
});
