import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PRESETS } from '@chatwarden/core';
import type { GuidelineTier } from '@chatwarden/core';
import { aiWorld, reads } from './aiHub.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// "Principles for this case" (0.2.2): in the Detailed case pane, a collapsed disclosure under the facts row that shows the principle matching the case's conduct level (the team's own words) and
// the team notes tied to the case's Community Rule. Plain text only. The Simple card has none. A role that cannot read the policy has none, and a failed read shows nothing.

afterEach(() => cleanup());

const WAIT = { timeout: 4000 };
const TITLE = 'Principles for this case';
const standard = PRESETS.standard.guidelines;
const tierOf = (cover: string): GuidelineTier => standard.find((t) => (t.covers as string[]).includes(cover))!;
const disclosure = (): HTMLElement => screen.getByRole('button', { name: TITLE });
const policyReads = (w: HubWorld) => w.sent.filter((r) => r.method === 'GET' && r.path === '/policy');
const SAVE = { version: 0, actor: 'x', reason: 'seed' };

async function open(w: HubWorld, id: string, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/reports/${id}`, ...options });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  return r;
}
const world = (o: WorldOptions = {}) => hubWorld({ role: 'moderator', actor: 'maya@example.test', ...o });
const body = (): HTMLElement => document.querySelector('.cw-case-principles-body') as HTMLElement;

describe('the disclosure', () => {
  it('is collapsed; opening it shows the principle for the default level (hostile): its name, description, examples and outcome, labelled as the team wrote them', async () => {
    const w = await world();
    const f = await w.fileRich({});
    const { user } = await open(w, f.id);
    await screen.findByRole('button', { name: TITLE }, WAIT);
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    const tier = tierOf('hostile');
    expect(screen.queryByText(tier.title)).toBeNull();
    await user.click(disclosure());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText(tier.title)).toBeInTheDocument();
    expect(screen.getByText('What the team wrote')).toBeInTheDocument();
    expect(within(body()).getByText(tier.description)).toBeInTheDocument();
    for (const example of tier.examples) expect(within(body()).getByText(example)).toBeInTheDocument();
    expect(within(body()).getByText(`Outcome: ${tier.outcome}`)).toBeInTheDocument();
    expect(within(body()).queryByText('Team notes for this rule')).toBeNull();
  });

  it('sits under the facts row of the header, inside the case pane', async () => {
    const w = await world();
    const f = await w.fileRich({});
    await open(w, f.id);
    const button = await screen.findByRole('button', { name: TITLE }, WAIT);
    const facts = screen.getByRole('group', { name: 'About this report' });
    expect(facts.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.closest('.cw-casehead')).not.toBeNull();
  });

  it('after the moderator picks level Severe in the decision bar the principle changes to the Severe one', async () => {
    const w = await world();
    const f = await w.fileRich({});
    const { user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: TITLE }, WAIT));
    expect(await screen.findByText(tierOf('hostile').title)).toBeInTheDocument();
    const panel = await screen.findByRole('region', { name: 'Decision' });
    await user.click(within(panel).getByRole('button', { name: 'Change' }));
    await user.click(within(within(panel).getByRole('group', { name: 'How serious is the conduct?' })).getByRole('button', { name: 'Severe' }));
    await waitFor(() => expect(within(body()).getByText(tierOf('severe').title)).toBeInTheDocument(), WAIT);
    expect(within(body()).queryByText(tierOf('hostile').title)).toBeNull();
    await user.click(within(within(panel).getByRole('group', { name: 'How serious is the conduct?' })).getByRole('button', { name: 'Rude' }));
    await waitFor(() => expect(within(body()).getByText(tierOf('rude').title)).toBeInTheDocument(), WAIT);
  });

  it('the AI read severity is the level when nothing was picked', async () => {
    const { w, f } = await aiWorld({ level: 1, script: reads({ severity: 'rude' }) });
    expect((await w.client.getReport(f.id)).ai?.severity).toBe('rude');
    const { user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: TITLE }, WAIT));
    expect(await within(body()).findByText(tierOf('rude').title)).toBeInTheDocument();
    expect(within(body()).queryByText(tierOf('hostile').title)).toBeNull();
  });
});

describe('the team notes of the rule', () => {
  const seedNotes = (w: HubWorld, notes: Array<{ text: string; rule?: number }>) => expect(w.cw.policy.save({ teamNotes: notes }, SAVE).ok).toBe(true);

  it('a case under a rule shows the notes tied to it and none tied to another rule; a note with no rule is not shown', async () => {
    const w = await world();
    const f = await w.fileRich({});
    const rule = (await w.client.getReport(f.id)).rule;
    expect(typeof rule).toBe('number');
    const other = rule === 1 ? 2 : 1;
    seedNotes(w, [{ text: 'About this very rule', rule: rule as number }, { text: 'About another rule', rule: other }, { text: 'About no rule at all' }, { text: 'Again this rule', rule: rule as number }]);
    const { user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: TITLE }, WAIT));
    expect(await within(body()).findByText('Team notes for this rule')).toBeInTheDocument();
    const items = within(body()).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(expect.arrayContaining(['About this very rule', 'Again this rule']));
    expect(items).not.toContain('About another rule');
    expect(items).not.toContain('About no rule at all');
  });

  it("'uncovered' shows none", async () => {
    const w = await world();
    const f = await w.fileRich({});
    const real = await w.direct.getReport(f.id);
    seedNotes(w, [{ text: 'Rule one note', rule: 1 }, { text: 'Rule two note', rule: 2 }]);
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === `/reports/${f.id}` ? { status: 200, body: { ...real, rule: 'uncovered' } } : undefined);
    const { user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: TITLE }, WAIT));
    expect(await within(body()).findByText(tierOf('hostile').title)).toBeInTheDocument();
    expect(within(body()).queryByText('Team notes for this rule')).toBeNull();
  });

  it('a note on a retired rule is not shown', async () => {
    const w = await world({ retire: [7] });
    const f = await w.fileRich({});
    const real = await w.direct.getReport(f.id);
    seedNotes(w, [{ text: 'Retired rule note', rule: 7 }]);
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === `/reports/${f.id}` ? { status: 200, body: { ...real, rule: 7 } } : undefined);
    const { user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: TITLE }, WAIT));
    expect(await within(body()).findByText(tierOf('hostile').title)).toBeInTheDocument();
    expect(within(body()).queryByText('Retired rule note')).toBeNull();
    expect(within(body()).queryByText('Team notes for this rule')).toBeNull();
  });

  it('no notes at all means only the principle', async () => {
    const w = await world();
    const f = await w.fileRich({});
    const { user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: TITLE }, WAIT));
    expect(await within(body()).findByText(tierOf('hostile').title)).toBeInTheDocument();
    expect(within(body()).queryByRole('list', { name: 'Team notes for this rule' })).toBeNull();
    expect(within(body()).queryByText('Team notes for this rule')).toBeNull();
  });
});

describe('plain text only', () => {
  it('a principle or a note whose text is "<b>x</b>" renders as text, not as a bold element', async () => {
    const w = await world();
    const f = await w.fileRich({});
    const rule = (await w.client.getReport(f.id)).rule as number;
    const tiers = standard.map((t) => (t.covers.includes('hostile') ? { ...t, title: '<b>x</b>', description: '<i>y</i>', examples: ['<u>z</u>'], outcome: '<script>no</script>' } : t));
    expect(w.cw.policy.save({ guidelines: { tiers }, teamNotes: [{ text: '<b>x</b>', rule }] }, SAVE).ok).toBe(true);
    const { user } = await open(w, f.id);
    await user.click(await screen.findByRole('button', { name: TITLE }, WAIT));
    expect(await within(body()).findByText('<i>y</i>')).toBeInTheDocument();
    expect(within(body()).getAllByText('<b>x</b>').length).toBeGreaterThanOrEqual(2);
    expect(within(body()).getByText('<u>z</u>')).toBeInTheDocument();
    expect(within(body()).getByText('Outcome: <script>no</script>')).toBeInTheDocument();
    expect(body().querySelector('b, i, u, script')).toBeNull();
  });
});

describe('who gets it, and when', () => {
  it('a role without policy.read sees no disclosure and no /policy request is made for it', async () => {
    const w = await world({ permissions: { 'policy.read': 'senior' } });
    const f = await w.fileRich({});
    await open(w, f.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('button', { name: TITLE })).toBeNull();
    expect(policyReads(w)).toHaveLength(0);
  });

  it('a scoped moderator likewise', async () => {
    const w = await world({ role: 'senior', scope: ['creator:alice'] });
    const f = await w.fileRich({ tags: { scope: 'creator:alice' } });
    await open(w, f.id);
    await screen.findByText(/Filed/);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('button', { name: TITLE })).toBeNull();
    expect(policyReads(w)).toHaveLength(0);
  });

  it('the Simple case card has no such disclosure', async () => {
    const w = await world();
    const f = await w.fileRich({});
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple', stay: true });
    await screen.findByRole('region', { name: /^Case against/ }, WAIT);
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole('button', { name: TITLE })).toBeNull();
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it('a failing policy read shows no disclosure and no error, and does not block the case', async () => {
    const w = await world();
    const f = await w.fileRich({});
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/policy' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await open(w, f.id);
    expect(await screen.findByRole('region', { name: 'Decision' }, WAIT)).toBeInTheDocument();
    await waitFor(() => expect(policyReads(w).length).toBeGreaterThan(0), WAIT);
    expect(screen.queryByRole('button', { name: TITLE })).toBeNull();
    // the decision bar says its own rules could not load (that is its business); the case header, where the disclosure would be, says nothing
    expect(document.querySelector('.cw-casehead')?.textContent).not.toMatch(/server had a problem/);
    expect(document.querySelector('.cw-case-principles')).toBeNull();
  });
});

describe('review R2 M2: a report about play or a name opens at the level the ladder reads', () => {
  const HELLO = [{ who: 'target' as const, text: 'Hello' }];
  it('an AFK report shows the rude principle, not the hostile one', async () => {
    const w = await world();
    const f = await w.fileRich({ lines: HELLO, reason: 'afk', cite: 1 });
    const { user } = await open(w, f.id);
    await screen.findByRole('button', { name: TITLE }, WAIT);
    await user.click(disclosure());
    expect(within(body()).getByText(tierOf('rude').title)).toBeInTheDocument();
    expect(within(body()).queryByText(tierOf('hostile').title)).toBeNull();
  });
  it('a name report shows the rude principle too', async () => {
    const w = await world();
    const f = await w.fileRich({ lines: HELLO, reason: 'name', cite: 7 });
    const { user } = await open(w, f.id);
    await screen.findByRole('button', { name: TITLE }, WAIT);
    await user.click(disclosure());
    expect(within(body()).getByText(tierOf('rude').title)).toBeInTheDocument();
  });
  it('a chat report is as it was: the hostile principle', async () => {
    const w = await world();
    const f = await w.fileRich({ lines: HELLO, reason: 'harassment', cite: 2 });
    const { user } = await open(w, f.id);
    await screen.findByRole('button', { name: TITLE }, WAIT);
    await user.click(disclosure());
    expect(within(body()).getByText(tierOf('hostile').title)).toBeInTheDocument();
  });
});
