import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Settings > Advanced > "Chat filters" (release 0.2.0): four cards (links, personal info, shouting and repeats, phrases), each off until switched on, each with a
// four-way action in words, a Community Rule and its own details; saved through the same policy machinery as the other panels (a draft, a reason, a conflict offers a
// reload, a per-section reset). Only the owner edits. Nothing is on by default.

afterEach(() => cleanup());

const owner = (o: WorldOptions = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
type User = ReturnType<typeof renderHub>['user'];

async function open(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/advanced' });
  await screen.findByRole('heading', { level: 2, name: 'Advanced' });
  await screen.findByRole('region', { name: 'Chat filters' });
  return r;
}
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Chat filters' });
const card = (name: string): HTMLElement => within(panel()).getByRole('group', { name });
const puts = (w: HubWorld) => w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile');
async function save(user: User, why = 'Tuning the lobby') {
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), why);
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
}

const CARDS = ['Links', 'Personal info', 'Shouting and repeats', 'Phrases'] as const;

describe('the panel', () => {
  it('defaults to every block off: four switches off, no details, no action choice', async () => {
    const w = await owner();
    await open(w);
    for (const name of CARDS) {
      expect(within(card(name)).getByRole('checkbox', { name })).not.toBeChecked();
      expect(within(card(name)).queryByRole('radio')).toBeNull();
    }
    expect(within(panel()).queryByRole('textbox', { name: /Add an allowed domain/ })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('only the owner can save; seniors and moderators see the values read-only, with no save bar', async () => {
    for (const role of ['moderator', 'senior'] as const) {
      cleanup();
      const w = await hubWorld({ role, actor: `${role}@example.test`, overrides: { filters: { links: { action: 'refuse' } } } });
      await open(w);
      const links = card('Links');
      expect(within(links).getByRole('checkbox', { name: 'Links' })).toBeChecked();
      expect(within(links).getByRole('radio', { name: 'Don\u2019t send the line' })).toBeChecked();
      for (const el of within(panel()).getAllByRole('checkbox')) expect(el).toBeDisabled();
      expect(within(panel()).queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(within(panel()).queryByRole('button', { name: 'Use suggested values' })).toBeNull();
      expect(within(panel()).getByText(/You can see these settings/i)).toBeInTheDocument();
    }
  });

  it('switching a card on shows its details; the action is a choice in words and refuse and mask say what happens', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(card('Links')).getByRole('checkbox', { name: 'Links' }));
    const links = card('Links');
    expect(within(links).getAllByRole('radio').map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
      'Only count',
      'Send to the queue',
      'Hide the part',
      'Don\u2019t send the line',
    ]);
    // a first choice is "Only count": the safe way to start
    expect(within(links).getByRole('radio', { name: 'Only count' })).toBeChecked();
    await user.click(within(links).getByRole('radio', { name: 'Don\u2019t send the line' }));
    expect(within(links).getByText(/The player is told the line was not sent/)).toBeInTheDocument();
    await user.click(within(links).getByRole('radio', { name: 'Hide the part' }));
    expect(within(links).getByText(/replaced with stars/)).toBeInTheDocument();
    await user.click(within(links).getByRole('radio', { name: 'Send to the queue' }));
    expect(within(links).getByText(/report with no reporter/)).toBeInTheDocument();
  });

  it('saving sends the whole layer with filters merged and a reason; the kit takes it at once; Discard drops the draft', async () => {
    const w = await owner();
    // an earlier save of another section stays in the layer
    await w.direct.savePolicyProfile({ layer: { pace: { slowModeMs: 4000, burst: null, duplicateWindowMs: null } }, version: 0, reason: 'earlier' });
    const { user } = await open(w);
    await user.click(within(card('Links')).getByRole('checkbox', { name: 'Links' }));
    await user.click(within(card('Links')).getByRole('radio', { name: 'Don\u2019t send the line' }));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const body = puts(w)[0]!.body as { layer: Record<string, unknown>; reason: string; version: number };
    expect(body.reason).toBe('Tuning the lobby');
    expect(Object.keys(body.layer).sort()).toEqual(['filters', 'pace']);
    expect((body.layer.filters as { links: { action: string } }).links.action).toBe('refuse');
    expect((body.layer.filters as { personalInfo: unknown }).personalInfo).toBeNull();
    expect((body.layer.filters as { phrases: unknown[] }).phrases).toEqual([]);
    await waitFor(() => expect(w.cw.profile.filters.links?.action).toBe('refuse'));
  });

  it('a 409 offers to reload and keeps what was typed', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(card('Personal info')).getByRole('checkbox', { name: 'Personal info' }));
    await user.click(within(card('Personal info')).getByRole('radio', { name: 'Hide the part' }));
    // someone else saves first
    await w.direct.savePolicyProfile({ layer: { pace: { slowModeMs: 2000, burst: null, duplicateWindowMs: null } }, version: 0, reason: 'rival' });
    await save(user);
    expect(await within(panel()).findByText(/Someone else changed these settings/i)).toBeInTheDocument();
    expect(within(card('Personal info')).getByRole('radio', { name: 'Hide the part' })).toBeChecked();
    await user.click(within(panel()).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(within(panel()).queryByText(/Someone else changed these settings/i)).toBeNull());
  });

  it('reset restores the base: the saved filters go and the switches are off again', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(card('Links')).getByRole('checkbox', { name: 'Links' }));
    await save(user);
    await waitFor(() => expect(w.cw.profile.filters.links).not.toBeNull());
    await user.click(await within(panel()).findByRole('button', { name: /Reset chat filters/ }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'Back to the code');
    await user.click(within(panel()).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(w.cw.profile.filters.links).toBeNull());
    await waitFor(() => expect(within(card('Links')).getByRole('checkbox', { name: 'Links' })).not.toBeChecked());
  });

  it('use suggested values fills the form and does not save', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: 'Use suggested values' }));
    expect(within(card('Links')).getByRole('checkbox', { name: 'Links' })).toBeChecked();
    expect(puts(w)).toHaveLength(0);
    expect(w.cw.profile.filters.links).toBeNull();
    expect(await screen.findByText(/Suggested values filled in/)).toBeInTheDocument();
  });

  it('the new-account setting carries a hint when the kit has no account age, and none when it has', async () => {
    const without = await owner({ overrides: { filters: { links: { action: 'count' } } } });
    await open(without);
    expect(within(card('Links')).getByText(/needs the game to tell the kit how old an account is/i)).toBeInTheDocument();
    cleanup();
    const withAge = await owner({ overrides: { filters: { links: { action: 'count' } } }, signals: { accountAgeDays: () => 5 } });
    await open(withAge);
    expect(within(card('Links')).queryByText(/needs the game to tell the kit how old an account is/i)).toBeNull();
  });
});

describe('everything else is unchanged', () => {
  it('Simple mode and the main nav gain nothing: no Chat filters link, no panel, no chip when there is no filter report', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'owen@example.test' });
    await w.file({ target: 'Plainy' });
    renderHub(w, { path: '/', mode: 'simple' });
    await screen.findByRole('navigation', { name: /./ }).catch(() => undefined);
    expect(screen.queryByText('Chat filters')).toBeNull();
    expect(screen.queryByText(/^Filter/)).toBeNull();
    cleanup();
    renderHub(w, { path: '/settings/ladder', mode: 'detailed' });
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Steps and ladder', 'Reporting', 'AI', 'Advanced']);
  });

  it('the panel appears only in Advanced, after the Names panel, and is loaded when that screen opens', async () => {
    const w = await owner();
    await open(w);
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label') ?? within(r).queryAllByRole('heading')[0]?.textContent);
    expect(regions.indexOf('Chat filters')).toBeGreaterThan(regions.indexOf('Names'));
  });
});

describe('each card validates as the server does, in words', () => {
  it('a shared hosting suffix in the allow list reads "list the exact name with ="; Save is blocked and nothing is sent', async () => {
    const w = await owner({ overrides: { filters: { links: { action: 'count' } } } });
    const { user } = await open(w);
    const links = card('Links');
    await user.type(within(links).getByRole('textbox', { name: 'Add an allowed domain' }), 'github.io');
    await user.click(within(links).getByRole('button', { name: 'Add to allowed domains' }));
    expect(await within(links).findByText(/list the exact name with =/i)).toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(screen.queryByRole('textbox', { name: /Why are you changing this/ })).toBeNull();
    expect(puts(w)).toHaveLength(0);
    // the exact name is fine
    await user.click(within(links).getByRole('button', { name: /Remove github\.io/ }));
    await user.type(within(links).getByRole('textbox', { name: 'Add an allowed domain' }), '=glarn.github.io');
    await user.click(within(links).getByRole('button', { name: 'Add to allowed domains' }));
    expect(within(links).queryByText(/list the exact name with =/i)).toBeNull();
    expect(within(links).getByText('=glarn.github.io')).toBeInTheDocument();
  });

  it('a bad domain, a bad pattern and an out-of-range number each name their field and block the save', async () => {
    const w = await owner({
      overrides: { filters: { links: { action: 'count' }, ratio: { action: 'count' }, phrases: [{ id: 'gold', action: 'count', phrases: ['buy gold'] }] } },
    });
    const { user } = await open(w);
    const links = card('Links');
    await user.type(within(links).getByRole('textbox', { name: 'Add a denied domain' }), 'not a domain');
    await user.click(within(links).getByRole('button', { name: 'Add to denied domains' }));
    expect(await within(links).findByText(/Denied domains, entry 1/i)).toBeInTheDocument();
    await user.click(within(links).getByRole('button', { name: /Remove not a domain/ }));
    expect(within(links).queryByText(/Denied domains, entry 1/i)).toBeNull();

    const phrases = card('Phrases');
    const patterns = within(phrases).getByRole('textbox', { name: /Patterns/ });
    await user.clear(patterns);
    await user.type(patterns, 'good one{enter}bad ~~ pattern ((');
    expect(await within(phrases).findByText(/Patterns, line 2/i)).toBeInTheDocument();
    await user.clear(patterns);
    await user.type(patterns, 'buy gold');
    expect(within(phrases).queryByText(/Patterns, line/i)).toBeNull();

    const ratio = card('Shouting and repeats');
    const percent = within(ratio).getByRole('spinbutton', { name: /Capital letters, at most/ });
    await user.clear(percent);
    await user.type(percent, '10');
    expect(await within(ratio).findByText(/Capital letters, at most/i, { selector: '.cw-field-error' })).toBeInTheDocument();
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(puts(w)).toHaveLength(0);
  });

  it('a refusal from the server (a rule that is no longer on) is shown against its card, and the draft is kept', async () => {
    const w = await owner({ retire: [4] });
    const { user } = await open(w);
    await user.click(within(card('Links')).getByRole('checkbox', { name: 'Links' }));
    // The default rule of Links is the retired one: it stays what the form holds (and is named), so the owner sees what the server refuses.
    expect(within(card('Links')).getByRole('combobox', { name: 'Community Rule' })).toHaveValue('4');
    await save(user);
    expect(await within(card('Links')).findByText(/Community Rule/i, { selector: '.cw-field-error' })).toBeInTheDocument();
    expect(within(card('Links')).getByRole('checkbox', { name: 'Links' })).toBeChecked();
    expect(w.cw.profile.filters.links).toBeNull();
  });
});

describe('the Community Rule is picked from the active rules', () => {
  const options = (rule: HTMLElement): string[] => within(rule).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);

  it('a select of the rules in force, with the retired ones left out, on each card', async () => {
    const w = await owner({ retire: [9] });
    const { user } = await open(w);
    for (const name of ['Links', 'Personal info', 'Shouting and repeats']) await user.click(within(card(name)).getByRole('checkbox', { name }));
    await user.click(within(card('Phrases')).getByRole('checkbox', { name: 'Phrases' }));
    await user.click(within(card('Phrases')).getByRole('button', { name: 'Add a phrase rule' }));
    for (const name of ['Links', 'Personal info', 'Shouting and repeats', 'Phrases']) {
      const select = await within(card(name)).findByRole('combobox', { name: 'Community Rule' });
      await waitFor(() => expect(options(select).length, name).toBeGreaterThan(3));
      expect(options(select), name).toEqual(expect.arrayContaining(['1', '2', '3', '4']));
      expect(options(select), name).not.toContain('9');
      expect(within(card(name)).queryByRole('spinbutton', { name: 'Community Rule' }), name).toBeNull();
    }
  });

  it('picking a rule changes what is saved', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(card('Links')).getByRole('checkbox', { name: 'Links' }));
    const select = await within(card('Links')).findByRole('combobox', { name: 'Community Rule' });
    await waitFor(() => expect(options(select).length).toBeGreaterThan(3));
    await user.selectOptions(select, '5');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: { filters: { links: { rule: number } } } }).layer.filters.links.rule).toBe(5);
    expect(w.cw.profile.filters.links?.rule).toBe(5);
  });

  it('a senior who can only read sees the chosen rule in a select that is disabled', async () => {
    const w = await hubWorld({ role: 'senior', actor: 'sam@example.test', overrides: { filters: { links: { action: 'refuse', rule: 5 } } } });
    await open(w);
    const select = await within(card('Links')).findByRole('combobox', { name: 'Community Rule' });
    await waitFor(() => expect(select).toHaveValue('5'));
    expect(select).toBeDisabled();
  });
});

describe('Ignore these phrases', () => {
  const ignoreBox = async (user: User): Promise<HTMLElement> => {
    await user.click(within(panel()).getByText('More settings'));
    return within(panel()).getByRole('textbox', { name: 'Ignore these phrases (one per line)' });
  };

  it('a new line can be started: the box keeps a trailing new line and the form stays valid', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await ignoreBox(user);
    await user.type(box, 'e.g.{enter}');
    expect(box).toHaveValue('e.g.\n');
    expect(panel().querySelector('.cw-field-error')).toBeNull();
    await user.type(box, 'score:{enter}{enter}12 - 9');
    expect(box).toHaveValue('e.g.\nscore:\n\n12 - 9');
    expect(panel().querySelector('.cw-field-error')).toBeNull();
  });

  it('blank lines are skipped, not sent, and do not block the save', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = await ignoreBox(user);
    await user.type(box, '  e.g.  {enter}{enter}   {enter}score:{enter}');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: { filters: { ignore: string[] } } }).layer.filters.ignore).toEqual(['e.g.', 'score:']);
    expect(w.cw.profile.filters.ignore).toEqual(['e.g.', 'score:']);
  });
});

describe('phrases', () => {
  it('add a rule, name it, give it patterns and an action; save sends one rule; remove takes it out', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(card('Phrases')).getByRole('checkbox', { name: 'Phrases' }));
    await user.click(within(card('Phrases')).getByRole('button', { name: 'Add a phrase rule' }));
    const rule = within(card('Phrases')).getByRole('group', { name: 'Phrase rule 1' });
    await user.type(within(rule).getByRole('textbox', { name: 'Name' }), 'Gold ads');
    await user.type(within(rule).getByRole('textbox', { name: /Patterns/ }), 'buy gold{enter}free gold');
    await user.click(within(rule).getByRole('radio', { name: 'Send to the queue' }));
    await save(user);
    await waitFor(() => expect(w.cw.profile.filters.phrases).toHaveLength(1));
    expect(w.cw.profile.filters.phrases[0]).toMatchObject({ label: 'Gold ads', action: 'flag', phrases: ['buy gold', 'free gold'] });
    expect(w.cw.profile.filters.phrases[0]!.id).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    await user.click(within(card('Phrases')).getByRole('button', { name: 'Remove Gold ads' }));
    expect(within(card('Phrases')).queryByRole('group', { name: 'Phrase rule 1' })).toBeNull();
  });

  it('shows the pattern vocabulary in one line of help', async () => {
    const w = await owner({ overrides: { filters: { phrases: [{ id: 'gold', action: 'count', phrases: ['buy gold'] }] } } });
    await open(w);
    expect(within(card('Phrases')).getByText(/a word, a\|b, word\*/i)).toBeInTheDocument();
  });
});
