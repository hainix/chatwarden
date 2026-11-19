import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from '../render.js';
import { hubWorld } from '../world.js';
import type { HubWorld, WorldOptions } from '../world.js';

// The Team notes panel on the Steps and ladder screen: staff-only notes for the AI read and the guide, each optionally tied to a Community Rule. Add, type, pick a rule, remove, the cap of 30,
// the counter, a refusal pointing at its field, Reset, and the read-only roles.

afterEach(() => cleanup());

const WAIT = { timeout: 4000 };
const owner = (o: WorldOptions = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
type User = ReturnType<typeof renderHub>['user'];

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Team notes' });
const noteBox = (n: number): HTMLTextAreaElement => within(panel()).getByRole('textbox', { name: `Team note ${n}` }) as HTMLTextAreaElement;
const ruleBox = (n: number): HTMLSelectElement => within(panel()).getByRole('combobox', { name: `Rule for note ${n}` }) as HTMLSelectElement;
const ADD = 'Add a note';
const puts = (w: HubWorld) => w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile');
const dels = (w: HubWorld) => w.sent.filter((r) => r.method === 'DELETE' && r.path === '/policy/profile');
const sentLayer = (w: HubWorld) => (puts(w).at(-1)?.body as { layer: Record<string, unknown> }).layer;
const seed = (w: HubWorld, notes: Array<{ text: string; rule?: number }>) => {
  const res = w.cw.policy.save({ teamNotes: notes }, { version: w.cw.policy.get().version, actor: 'x', reason: 'seed' });
  expect(res.ok).toBe(true);
};

async function open(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/ladder' });
  await screen.findByRole('heading', { level: 2, name: 'Steps and ladder' });
  await screen.findByRole('region', { name: 'Team notes' });
  return r;
}
async function save(user: User, reason = 'A note for the team') {
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), reason);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
}

describe('the panel', () => {
  it('says the notes are staff only and that the AI read gets them, and shows an empty state with Add a note', async () => {
    const w = await owner();
    await open(w);
    expect(within(panel()).getByText('Staff only: players never see these. The AI read gets them too.')).toBeInTheDocument();
    expect(within(panel()).getByText('No team notes yet.')).toBeInTheDocument();
    expect(within(panel()).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(panel()).getByRole('button', { name: ADD })).toHaveAttribute('aria-disabled', 'false');
    expect(within(panel()).getByRole('button', { name: 'Reset team notes' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('add, type, pick a rule and save sends teamNotes: [{ text, rule }] and nothing else; the guide then lists it', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: ADD }));
    expect(within(panel()).queryByText('No team notes yet.')).toBeNull();
    await waitFor(() => expect(noteBox(1)).toHaveFocus(), WAIT);
    await user.type(noteBox(1), 'Banter is fine in the arena');
    await user.selectOptions(ruleBox(1), 'Rule 2: No insulting, threatening or targeting another player');
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect(puts(w)).toHaveLength(1);
    expect(sentLayer(w)).toEqual({ teamNotes: [{ text: 'Banter is fine in the arena', rule: 2 }] });
    expect(w.cw.policy.get().effective.teamNotes).toEqual([{ text: 'Banter is fine in the arena', rule: 2 }]);
    expect((await w.client.policy()).documents.moderatorGuide).toContain('Banter is fine in the arena');
  });

  it('the same note without a rule sends no rule key', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: ADD }));
    expect(ruleBox(1)).toHaveValue('');
    expect(within(ruleBox(1)).getByRole('option', { name: 'Any rule' })).toBeInTheDocument();
    await user.type(noteBox(1), 'General reminder');
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect(sentLayer(w)).toEqual({ teamNotes: [{ text: 'General reminder' }] });
    expect(Object.keys((sentLayer(w).teamNotes as object[])[0]!)).toEqual(['text']);
  });

  it('keeps the other saved sections when it saves (a ladder saved first is still there)', async () => {
    const w = await owner();
    w.cw.policy.save({ pace: { slowModeMs: 2000 } }, { version: 0, actor: 'x', reason: 'seed' });
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: ADD }));
    await user.type(noteBox(1), 'Hello');
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect(Object.keys(sentLayer(w)).sort()).toEqual(['pace', 'teamNotes']);
  });

  it('shows the notes of the kit, their rule, and removes one with the focus kept in the panel', async () => {
    const w = await owner();
    seed(w, [{ text: 'First', rule: 3 }, { text: 'Second' }, { text: 'Third', rule: 1 }]);
    const { user } = await open(w);
    expect(noteBox(1).value).toBe('First');
    expect(ruleBox(1)).toHaveValue('3');
    expect(ruleBox(2)).toHaveValue('');
    await user.click(within(panel()).getByRole('button', { name: 'Remove this note: number 2' }));
    expect(noteBox(2).value).toBe('Third');
    expect(within(panel()).queryByRole('textbox', { name: 'Team note 3' })).toBeNull();
    await waitFor(() => expect(panel().contains(document.activeElement)).toBe(true), WAIT);
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect(sentLayer(w)).toEqual({ teamNotes: [{ text: 'First', rule: 3 }, { text: 'Third', rule: 1 }] });
  });

  it('removing the last note leaves the empty state and moves the focus to Add a note', async () => {
    const w = await owner();
    seed(w, [{ text: 'Only' }]);
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: 'Remove this note: number 1' }));
    expect(within(panel()).getByText('No team notes yet.')).toBeInTheDocument();
    await waitFor(() => expect(within(panel()).getByRole('button', { name: ADD })).toHaveFocus(), WAIT);
  });

  it('removing every note saves an empty list, which goes back to the profile in code (a null section is left out)', async () => {
    const w = await owner();
    seed(w, [{ text: 'Only' }]);
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: 'Remove this note: number 1' }));
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect(sentLayer(w)).toEqual({});
    expect(w.cw.policy.get().effective.teamNotes).toEqual([]);
  });
});

describe('the cap and the counter', () => {
  it('shows the 500 counter, refuses an empty note and one over 500 with focus on that note', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: ADD }));
    expect(within(panel()).getByText('0 of 500')).toBeInTheDocument();
    await user.type(noteBox(1), 'abc');
    expect(within(panel()).getByText('3 of 500')).toBeInTheDocument();
    fireEvent.change(noteBox(1), { target: { value: 'x'.repeat(501) } });
    expect(within(panel()).getByText('Use at most 500 characters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(noteBox(1)).toHaveFocus(), WAIT);
    fireEvent.change(noteBox(1), { target: { value: '   ' } });
    expect(within(panel()).getByText('Write the note, or remove it.')).toBeInTheDocument();
    expect(puts(w)).toHaveLength(0);
    fireEvent.change(noteBox(1), { target: { value: 'x'.repeat(500) } });
    expect(within(panel()).queryByText('Use at most 500 characters.')).toBeNull();
  });

  it('the 31st note is refused: Add a note is off and the reason is shown', async () => {
    const w = await owner();
    seed(w, Array.from({ length: 29 }, (_, i) => ({ text: `Note ${i + 1}` })));
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: ADD }));
    expect(within(panel()).getAllByRole('textbox')).toHaveLength(30);
    const add = within(panel()).getByRole('button', { name: ADD });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(within(panel()).getByText('You can keep up to 30 notes.')).toBeInTheDocument();
    await user.click(add);
    expect(within(panel()).getAllByRole('textbox')).toHaveLength(30);
  });
});

describe('what the kit says back', () => {
  it('a refusal at layer.teamNotes[0].rule focuses the rule box of note 1 and marks it', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: ADD }));
    await user.type(noteBox(1), 'About a rule');
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 400, body: { error: 'invalid_profile', message: 'x', path: 'layer.teamNotes[0].rule' } } : undefined);
    await save(user);
    await waitFor(() => expect(ruleBox(1)).toHaveFocus(), WAIT);
    expect(ruleBox(1)).toHaveAttribute('aria-invalid', 'true');
  });

  it('a note on a rule that was retired still shows it and can be changed to another', async () => {
    const w = await owner({ retire: [4] });
    seed(w, [{ text: 'Old rule', rule: 4 }]);
    await open(w);
    expect(ruleBox(1)).toHaveValue('4');
    expect(within(ruleBox(1)).getByRole('option', { name: /Rule 4/ })).toBeInTheDocument();
  });

  it('Reset team notes issues DELETE ?section=teamNotes and the notes go', async () => {
    const w = await owner();
    seed(w, [{ text: 'Gone soon' }]);
    const { user } = await open(w);
    await user.click(within(panel()).getByRole('button', { name: 'Reset team notes' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'Start over');
    await user.click(within(screen.getByRole('group', { name: 'Reset team notes?' })).getByRole('button', { name: 'Reset' }));
    await within(screen.getByRole('region', { name: 'Notifications' })).findByText('Reset the team notes.');
    expect(dels(w).map((r) => r.query?.section)).toEqual(['teamNotes']);
    expect(w.cw.policy.get().effective.teamNotes).toEqual([]);
    expect(within(panel()).getByText('No team notes yet.')).toBeInTheDocument();
  });
});

describe('who may change it', () => {
  it.each(['senior', 'moderator'] as const)('a %s reads the notes: boxes disabled, no Add, no Remove, no Reset, no Save', async (role) => {
    const w = await hubWorld({ role, actor: `${role}@example.test` });
    seed(w, [{ text: 'Staff read this', rule: 2 }]);
    await open(w);
    expect(noteBox(1)).toBeDisabled();
    expect(ruleBox(1)).toBeDisabled();
    expect(within(panel()).queryByRole('button', { name: ADD })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: /^Remove this note/ })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: /^Reset/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });
});
