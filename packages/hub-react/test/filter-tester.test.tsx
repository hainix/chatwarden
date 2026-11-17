import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The three tools under the cards of Settings > Advanced > "Chat filters": "Test a message" (the verdict for one line under the UNSAVED form), "Check my changes" (the
// form over the recent lines, with a confirm over 5 percent) and "Hits" (what the filters did, counts as numbers). Nothing here saves or audits.

afterEach(() => cleanup());

const owner = (o: WorldOptions = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });

async function open(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/advanced' });
  await screen.findByRole('heading', { level: 2, name: 'Advanced' });
  await screen.findByRole('region', { name: 'Chat filters' });
  return r;
}
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Chat filters' });
const posts = (w: HubWorld, path: string) => w.sent.filter((r) => r.method === 'POST' && r.path === path);
const LINK = 'see blorf.com now';

describe('Test a message', () => {
  it('sends the UNSAVED form as the candidate, shows kind, action and rule in words and highlights the ranges; nothing is saved', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('checkbox', { name: 'Links' }));
    await user.click(within(panel()).getByRole('radio', { name: 'Hide the part' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'A message to try' }), LINK);
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    const result = await within(panel()).findByRole('status', { name: 'Result of the test' });
    expect(await within(result).findByText(/Link on no list/)).toBeInTheDocument();
    expect(within(result).getByText(/Hide the part/)).toBeInTheDocument();
    expect(within(result).getByText(/Community Rule 4/)).toBeInTheDocument();
    // the matched part is marked in the line, and the line as it would be sent is shown
    expect(within(result).getByText('blorf.com', { selector: 'mark' })).toBeInTheDocument();
    expect(within(result).getByText(/see \*{8,10} now/)).toBeInTheDocument();
    const sent = posts(w, '/filters/test');
    expect(sent).toHaveLength(1);
    expect((sent[0]!.body as { candidate: { links: { action: string } } }).candidate.links.action).toBe('mask');
    expect(w.sent.filter((r) => r.method === 'PUT')).toHaveLength(0);
    expect(w.cw.profile.filters.links).toBeNull();
  });

  it('a clean line says so; a line the filters would refuse says it would not be sent', async () => {
    const w = await owner({ overrides: { filters: { links: { action: 'refuse' } } } });
    const { user } = await open(w);
    const box = within(panel()).getByRole('textbox', { name: 'A message to try' });
    await user.type(box, 'good game everyone');
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(await within(panel()).findByText('Nothing would happen to this message.')).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, LINK);
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(await within(panel()).findByText('This message would not be sent.')).toBeInTheDocument();
  });

  it('the result is about the form it was run for: change the form and it is gone; run it again and it answers for the form as it is now', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('checkbox', { name: 'Links' }));
    await user.click(within(panel()).getByRole('radio', { name: 'Hide the part' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'A message to try' }), LINK);
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    const result = await within(panel()).findByRole('status', { name: 'Result of the test' });
    expect(await within(result).findByText(/Link on no list/)).toBeInTheDocument();
    expect(within(result).getByText(/Hide the part/)).toBeInTheDocument();
    // the owner turns the rule into one that only counts: the old answer is not shown against the new form
    await user.click(within(panel()).getByRole('radio', { name: 'Only count' }));
    await waitFor(() => expect(within(result).queryByText(/Link on no list/)).toBeNull());
    expect(within(result).queryByText(/blorf\.com/)).toBeNull();
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(await within(result).findByText(/Only count/)).toBeInTheDocument();
    expect(posts(w, '/filters/test')).toHaveLength(2);
  });

  it('the marks follow the text as typed, even with a leading space', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('checkbox', { name: 'Links' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'A message to try' }), `  ${LINK}`);
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    const result = await within(panel()).findByRole('status', { name: 'Result of the test' });
    expect(await within(result).findByText('blorf.com', { selector: 'mark' })).toBeInTheDocument();
  });

  it('an invalid form is not sent: the problem is shown instead; an empty box asks for a message', async () => {
    const w = await owner({ overrides: { filters: { phrases: [{ id: 'gold', action: 'count', phrases: ['buy gold'] }] } } });
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(await within(panel()).findByText('Type a message to try.')).toBeInTheDocument();
    const patterns = within(panel()).getByRole('textbox', { name: /Patterns/ });
    await user.clear(patterns);
    await user.type(patterns, 'bad ~~ ((');
    await user.type(within(panel()).getByRole('textbox', { name: 'A message to try' }), 'hello');
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(posts(w, '/filters/test')).toHaveLength(0);
  });

  it('a failure shows the error and keeps what was typed', async () => {
    const w = await owner();
    const { user } = await open(w);
    w.intercept.fn = (req) => (req.path === '/filters/test' ? { status: 500, body: { error: 'internal' } } : undefined);
    const box = within(panel()).getByRole('textbox', { name: 'A message to try' });
    await user.type(box, 'hello there');
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(await within(panel()).findByRole('alert')).toBeInTheDocument();
    expect(box).toHaveValue('hello there');
  });
});

describe('Check my changes', () => {
  const lines = (n: number, hit: number): string[] => Array.from({ length: n }, (_, i) => (i < hit ? `visit blorf${i}.com` : `plain chat ${i}`));

  it('lists counts and samples, and does not ask for a confirm under 5 percent', async () => {
    const w = await owner({ recentLines: () => lines(100, 3) });
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('checkbox', { name: 'Links' }));
    await user.click(within(panel()).getByRole('radio', { name: 'Don\u2019t send the line' }));
    await user.click(within(panel()).getByRole('button', { name: 'Check my changes' }));
    const result = await within(panel()).findByRole('status', { name: 'Result of the check' });
    expect(await within(result).findByText(/Read 100 recent lines\. 3 would not be sent\./)).toBeInTheDocument();
    expect(within(result).getByText(/Link on no list: 3 lines/)).toBeInTheDocument();
    expect(within(result).getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    expect(within(panel()).queryByRole('checkbox', { name: /I still want to save this/ })).toBeNull();
    expect(posts(w, '/filters/check')).toHaveLength(1);
    expect((posts(w, '/filters/check')[0]!.body as { candidate: { links: { action: string } } }).candidate.links.action).toBe('refuse');
  });

  it('asks for a confirm when refuse or mask touches over 5 percent: Save waits for it', async () => {
    const w = await owner({ recentLines: () => lines(100, 12) });
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('checkbox', { name: 'Links' }));
    await user.click(within(panel()).getByRole('radio', { name: 'Don\u2019t send the line' }));
    await user.click(within(panel()).getByRole('button', { name: 'Check my changes' }));
    expect(await within(panel()).findByText(/12 of 100 recent lines/)).toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(screen.queryByRole('textbox', { name: /Why are you changing this/ })).toBeNull();
    await user.click(within(panel()).getByRole('checkbox', { name: /I still want to save this/ }));
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('textbox', { name: /Why are you changing this/ })).toBeInTheDocument();
  });

  it('a count or a flag never needs the confirm, however many lines it touches', async () => {
    const w = await owner({ recentLines: () => lines(100, 50) });
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('checkbox', { name: 'Links' }));
    await user.click(within(panel()).getByRole('radio', { name: 'Send to the queue' }));
    await user.click(within(panel()).getByRole('button', { name: 'Check my changes' }));
    await within(panel()).findByText(/Read 100 recent lines/);
    expect(within(panel()).queryByRole('checkbox', { name: /I still want to save this/ })).toBeNull();
  });

  it('with no recent lines it says so; an error keeps what was typed in the form', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('checkbox', { name: 'Links' }));
    await user.click(within(panel()).getByRole('button', { name: 'Check my changes' }));
    expect(await within(panel()).findByText(/No recent lines to check against/)).toBeInTheDocument();
    w.intercept.fn = (req) => (req.path === '/filters/check' ? { status: 500, body: { error: 'internal' } } : undefined);
    await user.click(within(panel()).getByRole('button', { name: 'Check my changes' }));
    expect(await within(panel()).findByRole('alert')).toBeInTheDocument();
    expect(within(panel()).getByRole('checkbox', { name: 'Links' })).toBeChecked();
  });

  it('changing the form after a check clears its result (it is about the form as it was)', async () => {
    const w = await owner({ recentLines: () => lines(100, 12) });
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('checkbox', { name: 'Links' }));
    await user.click(within(panel()).getByRole('radio', { name: 'Don\u2019t send the line' }));
    await user.click(within(panel()).getByRole('button', { name: 'Check my changes' }));
    await within(panel()).findByText(/12 of 100 recent lines/);
    await user.click(within(panel()).getByRole('radio', { name: 'Only count' }));
    await waitFor(() => expect(within(panel()).queryByText(/12 of 100 recent lines/)).toBeNull());
  });
});

describe('Hits', () => {
  it('is collapsed by default and shows counts as numbers with no band or colour; flag_capped reads "not filed (daily limit)"', async () => {
    const w = await owner({ overrides: { filters: { links: { action: 'mask' }, phrases: [{ id: 'ads', label: 'Gold ads', action: 'flag', phrases: ['buy gold'] }] } } });
    w.cw.rooms.seat('R', 'p1', { clientKey: 'k1' }, 'Spk');
    w.cw.chat.accept('R', 'p1', LINK);
    w.store.addFilterHits([
      { day: Math.floor(w.clock.now() / 86_400_000), key: 'phrase.ads', action: 'flag_capped', hits: 4 },
      { day: Math.floor(w.clock.now() / 86_400_000), key: 'phrase.ads', action: 'flag', hits: 2 },
    ]);
    const { user } = await open(w);
    const details = within(panel()).getByText('What the filters did').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(posts(w, '/filters/stats')).toHaveLength(0);
    expect(w.sent.filter((r) => r.path === '/filters/stats')).toHaveLength(0);
    await user.click(within(panel()).getByText('What the filters did'));
    const table = await within(panel()).findByRole('table', { name: 'What the filters did' });
    expect(within(table).getByRole('columnheader', { name: 'Not filed (daily limit)' })).toBeInTheDocument();
    // One line says what the "Sent to the queue" column counts: reports filed, not lines that matched.
    expect(table).toHaveAccessibleDescription(/already has an open report/);
    expect(within(panel()).getByText(/already has an open report/)).toBeInTheDocument();
    const gold = within(table).getByRole('row', { name: /Gold ads/ });
    expect(within(gold).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Gold ads', '0', '2', '0', '0', '4']);
    const links = within(table).getByRole('row', { name: /Link on no list/ });
    expect(within(links).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Link on no list', '0', '0', '1', '0', '0']);
    expect(table.querySelector('[class*="tone"], [data-tone], [data-band]')).toBeNull();
    expect(w.sent.filter((r) => r.path === '/filters/stats').map((r) => r.query)).toEqual([{ days: 7 }]);
  });

  it('switches to 30 days, and says when there is nothing to show', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByText('What the filters did'));
    expect(await within(panel()).findByText('Nothing has been counted yet.')).toBeInTheDocument();
    await user.click(within(panel()).getByRole('radio', { name: 'Last 30 days' }));
    await waitFor(() => expect(w.sent.filter((r) => r.path === '/filters/stats').map((r) => r.query)).toEqual([{ days: 7 }, { days: 30 }]));
  });

  it('a role without filters.read has no tools at all', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'owen@example.test', permissions: { 'filters.read': 'owner' } });
    cleanup();
    const mod = await hubWorld({ role: 'moderator', actor: 'm@example.test', permissions: { 'filters.read': 'owner' } });
    await open(mod);
    expect(within(panel()).queryByRole('button', { name: 'Test' })).toBeNull();
    expect(within(panel()).queryByText('What the filters did')).toBeNull();
    expect(w).toBeDefined();
  });
});
