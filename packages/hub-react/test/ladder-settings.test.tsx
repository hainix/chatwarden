import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryStore } from '@chatwarden/store-memory';
import { describe, expect, it, vi } from 'vitest';
import type { PolicyLadderRow } from '@chatwarden/core';
import { Hub } from '../src/Hub.js';
import { memoryRouter } from '../src/router.js';
import type { TransportRequest } from '../src/transport.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The Steps and ladder settings screen, on the real staff routes: every section is edited, previewed, saved and then seen to
// change what the kit suggests; a second save conflicts; a refusal points at its field; each reset; the roles; a store that cannot
// save; the lengths' bounds; and leaving with unsaved edits.

const H = 3_600_000;
const D = 24 * H;
const WAIT = { timeout: 4000 };

/** The profile's ladder as a layer takes it (no labels), with a change to one row if asked. */
const plainLadder = (w: HubWorld, tweak: (row: PolicyLadderRow) => PolicyLadderRow = (r) => r): PolicyLadderRow[] =>
  w.cw.profile.ladder.map((r) =>
    tweak({
      step: r.step,
      lowMedium: { kind: r.lowMedium.kind as 'chat', durationMs: r.lowMedium.durationMs },
      high: { kind: r.high.kind as 'chat', durationMs: r.high.durationMs },
    }),
  );
const requests = (w: HubWorld, method: string, path: string): TransportRequest[] => w.sent.filter((r) => r.method === method && r.path === path);
const gets = (w: HubWorld): number => requests(w, 'GET', '/policy/profile').length;
const previews = (w: HubWorld): TransportRequest[] => requests(w, 'POST', '/policy/profile/preview');

async function open(w: HubWorld, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: '/settings/ladder', ...options });
  await screen.findByRole('heading', { level: 2, name: 'Steps and ladder' });
  await screen.findByRole('list', { name: 'Lengths offered' });
  return r;
}
const areaGroup = (): HTMLElement => screen.getByRole('group', { name: 'Rules that ban from public rooms instead of restricting chat' });
const severeGroup = (): HTMLElement => screen.getByRole('group', { name: 'Rules that always use the harsher column' });
const owner = (o: Parameters<typeof hubWorld>[0] = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
type User = ReturnType<typeof renderHub>['user'];

/** Save with a reason: the button asks for it first, then the form sends. */
async function save(user: User, reason = 'Lighter steps, asked for by the team') {
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), reason);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
}
const cellOf = async (row: string, col: number): Promise<string> => {
  const region = await screen.findByRole('region', { name: 'Preview' });
  return (within(region).getByRole('row', { name: new RegExp(`^${row}`) }).querySelectorAll('td')[col]?.textContent ?? '').trim();
};
// Columns of the preview: Banter 0, Rude 1, Hostile 2, Severe 3.

describe('the screen', () => {
  it('shows every section, with the profile in force', async () => {
    const w = await owner();
    await open(w);
    for (const name of ['Lengths', 'The ladder', 'First offence', 'Repeated', 'Rules', 'Written guidelines', 'Preview']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    const chips = within(screen.getByRole('list', { name: 'Lengths offered' })).getAllByRole('listitem');
    expect(chips.map((c) => c.textContent?.replace(/Remove.*$/, '').trim())).toEqual(['1 hour', '6 hours', '12 hours', '24 hours', '3 days', '7 days', '30 days']);
    expect(screen.getByRole('checkbox', { name: 'Let moderators type their own length' })).toBeChecked();
    // Six steps by two columns, each with a kind and a length.
    const grid = screen.getByRole('region', { name: 'The ladder grid' });
    expect(within(grid).getAllByRole('row')).toHaveLength(7);
    expect(screen.getByLabelText('Step 2, lighter: what happens')).toHaveValue('chat');
    expect(screen.getByLabelText('Step 0, harsher: how long')).toBeInTheDocument();
    expect(screen.getByLabelText('Hostile: what happens')).toHaveValue('chat');
    expect(screen.getByLabelText('Notes')).toHaveValue(2);
    expect(within(areaGroup()).getByRole('checkbox', { name: 'Rule 5: No cheating or exploiting' })).toBeChecked();
  });

  it('reads the settings once when it opens, and not again by itself', async () => {
    const w = await owner();
    await open(w);
    await new Promise((r) => setTimeout(r, 700));
    expect(gets(w)).toBe(1);
  });

  it('the grid scrolls inside its own box', async () => {
    const w = await owner();
    await open(w);
    const grid = screen.getByRole('region', { name: 'The ladder grid' });
    expect(grid).toHaveClass('cw-scroll');
    expect(grid.querySelector('table')).not.toBeNull();
  });

  it('is reached from the rail in Detailed mode, and from More in Simple', async () => {
    const w = await owner();
    const a = renderHub(w);
    await a.user.click(await screen.findByRole('link', { name: 'Settings' }));
    await screen.findByRole('heading', { level: 2, name: 'Steps and ladder' });
    a.unmount();
    const b = renderHub(w, { mode: 'simple' });
    await b.user.click(await screen.findByRole('button', { name: 'More' }));
    await b.user.click(screen.getByRole('link', { name: 'Steps and ladder' }));
    await screen.findByRole('heading', { level: 2, name: 'Steps and ladder' });
  });
});

describe('who can open and change it', () => {
  it('a moderator reads it: every control is off, no Save, no Reset, one plain sentence', async () => {
    const w = await hubWorld({ role: 'moderator' });
    await open(w);
    expect(screen.getByText('You can see these settings. Changing them needs permission to edit settings.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reset/ })).toBeNull();
    for (const c of [screen.getByLabelText('Add a length'), screen.getByLabelText('Step 1, lighter: what happens'), screen.getByLabelText('Notes'), within(areaGroup()).getByRole('checkbox', { name: 'Rule 5: No cheating or exploiting' })]) {
      expect(c).toBeDisabled();
    }
    // The preview is a read, so it still works.
    expect(await cellOf('Clean record', 2)).toMatch(/Restrict chat 24 hours/);
  });

  it('a role without policy.read gets the no-access page, and nothing is asked', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'policy.read': 'owner' } });
    renderHub(w, { path: '/settings/ladder' });
    await screen.findByText('Not available for your role');
    expect(gets(w)).toBe(0);
  });

  it('a store that cannot save settings: read-only, with the reason in one sentence', async () => {
    const store = new MemoryStore();
    (store as unknown as Record<string, unknown>).savePolicyLayer = undefined;
    (store as unknown as Record<string, unknown>).loadPolicyLayer = undefined;
    const w = await owner({ store });
    await open(w);
    expect(screen.getByText('This setup cannot save settings, so the steps and ladder stay as they are.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.getByLabelText('Add a length')).toBeDisabled();
  });

  it('a stored layer the kit cannot use is said plainly, and Reset steps and ladder clears it, in one call that names no section', async () => {
    const store = new MemoryStore();
    const w = await owner({ store });
    // A layer a newer kit wrote, straight into the store: this kit cannot read it and ignores it.
    store.savePolicyLayer?.({ profanity: { mode: 'refuse' } } as never, 0);
    w.cw.policy.refresh();
    const { user } = await open(w);
    expect(screen.getByText('The saved settings could not be used, so the default settings are in force. Reset the steps and ladder to clear them.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset steps and ladder' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'Clear the bad layer');
    await user.click(within(screen.getByRole('group', { name: 'Reset steps and ladder?' })).getByRole('button', { name: 'Reset' }));
    await screen.findByText('Reset the steps and ladder.');
    await waitFor(() => expect(screen.queryByText(/could not be used/)).toBeNull());
    expect(w.cw.policy.get().layerError).toBeUndefined();
    // Nothing readable is saved, so there is no section to name: this one call clears the unreadable layer whole.
    expect(requests(w, 'DELETE', '/policy/profile').map((r) => r.query?.section)).toEqual([undefined]);
  });
});

describe('Lengths', () => {
  it('adds a length in its place, and removes one', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.type(screen.getByLabelText('Add a length'), '2');
    await user.selectOptions(screen.getByLabelText('Unit'), 'Days');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const list = screen.getByRole('list', { name: 'Lengths offered' });
    expect(within(list).getAllByRole('listitem').map((c) => c.textContent?.replace(/Remove.*$/, '').trim())).toEqual([
      '1 hour', '6 hours', '12 hours', '24 hours', '2 days', '3 days', '7 days', '30 days',
    ]);
    await user.click(screen.getByRole('button', { name: 'Remove 6 hours' }));
    expect(within(list).queryByText('6 hours')).toBeNull();
    expect(screen.getByLabelText('Add a length')).toHaveValue(null);
  });

  it('Enter in the box adds the length', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.type(screen.getByLabelText('Add a length'), '90{Enter}');
    // 90 hours is not a whole number of days: it is shown as hours.
    expect(within(screen.getByRole('list', { name: 'Lengths offered' })).getByText('90 hours')).toBeInTheDocument();
  });

  it.each<[string, string, string]>([
    ['', 'Hours', 'Enter a length, such as 6 and hours.'],
    ['0', 'Hours', 'The shortest length is 1 minute.'],
    ['366', 'Days', 'The longest length is 365 days.'],
    ['9000', 'Hours', 'The longest length is 365 days.'],
    ['1.00001', 'Hours', 'Use a length in whole minutes.'],
  ])('%j %s is refused with a plain message and adds nothing', async (amount, unit, message) => {
    const w = await owner();
    const { user } = await open(w);
    if (amount !== '') await user.type(screen.getByLabelText('Add a length'), amount);
    await user.selectOptions(screen.getByLabelText('Unit'), unit);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText('Add a length')).toHaveAttribute('aria-invalid', 'true');
    expect(within(screen.getByRole('list', { name: 'Lengths offered' })).getAllByRole('listitem')).toHaveLength(7);
  });

  it('a length that is already listed is refused, and the message goes when the box changes', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.type(screen.getByLabelText('Add a length'), '24');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('That length is already in the list.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Add a length'), '1');
    expect(screen.queryByText('That length is already in the list.')).toBeNull();
  });

  it('at most 50 lengths', async () => {
    const w = await owner({ overrides: { durations: Array.from({ length: 50 }, (_, i) => (i + 1) * 60_000) } });
    const { user } = await open(w);
    await user.type(screen.getByLabelText('Add a length'), '2');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('You can list up to 50 lengths.')).toBeInTheDocument();
  });

  it('edit, preview, save: the lengths a moderator is offered change', async () => {
    const w = await owner();
    const { user } = await open(w);
    for (const hours of ['Remove 3 days', 'Remove 7 days', 'Remove 30 days']) await user.click(screen.getByRole('button', { name: hours }));
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect(w.cw.profile.durations).toEqual([H, 6 * H, 12 * H, D]);
    expect(w.cw.profile.customDuration).toBe(false);
    expect(requests(w, 'PUT', '/policy/profile')[0]?.body).toEqual({ layer: { durations: [H, 6 * H, 12 * H, D], customDuration: false }, version: 0, reason: 'Lighter steps, asked for by the team' });
  });
});

describe('The ladder', () => {
  it('a step 1 harsher cell, edited: the preview shows it, a save changes the real suggestion', async () => {
    const w = await owner();
    const target = await w.file({ target: 'Vantablob' });
    await w.sanction(target.person, 'warning', 'uncovered');
    const second = await w.file({ target: 'Vantablob' });
    const before = (await w.client.getReport(second.id)).suggest.outcome;
    expect(before).not.toEqual({ kind: 'ban', durationMs: 3 * D });
    const { user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Step 1, harsher: what happens'), 'Ban');
    await user.selectOptions(screen.getByLabelText('Step 1, harsher: how long'), '3 days');
    await waitFor(async () => expect(await cellOf('One warning', 2)).toMatch(/Full ban 3 days/), WAIT);
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect((await w.client.getReport(second.id)).suggest.outcome).toEqual({ kind: 'ban', durationMs: 3 * D });
    expect(w.cw.profile.ladder[1]?.high).toMatchObject({ kind: 'ban', durationMs: 3 * D });
  });

  it('a warning has no length; permanent is offered; custom opens a number and a unit', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Step 2, lighter: what happens'), 'Warning');
    expect(screen.queryByLabelText('Step 2, lighter: how long')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Step 3, lighter: how long'), 'Permanent');
    await user.selectOptions(screen.getByLabelText('Step 4, lighter: how long'), 'Custom length');
    await user.type(screen.getByLabelText('Step 4, lighter: number'), '36');
    await user.selectOptions(screen.getByLabelText('Step 4, lighter: unit'), 'Hours');
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect(w.cw.profile.ladder[2]?.lowMedium).toMatchObject({ kind: 'warning', durationMs: null });
    expect(w.cw.profile.ladder[3]?.lowMedium.durationMs).toBeNull();
    expect(w.cw.profile.ladder[4]?.lowMedium.durationMs).toBe(36 * H);
  });

  it('a custom length with no number blocks the save and puts keyboard focus on it', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Step 5, harsher: how long'), 'Custom length');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByLabelText('Step 5, harsher: number')).toHaveFocus();
    expect(screen.getByText('Enter a length, such as 6 and hours.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Why are you changing this/ })).toBeNull();
    expect(requests(w, 'PUT', '/policy/profile')).toHaveLength(0);
  });

  it('a length that is not in the list stays visible in its cell', async () => {
    const w = await owner();
    w.cw.policy.save({ ladder: plainLadder(w, (r) => (r.step === 2 ? { ...r, high: { kind: 'ban', durationMs: 36 * H } } : r)) }, { version: 0, actor: 'x', reason: 'seed' });
    await open(w);
    const select = screen.getByLabelText('Step 2, harsher: how long') as HTMLSelectElement;
    expect(select.options[select.selectedIndex]?.textContent).toBe('36 hours');
  });
});

describe('First offence', () => {
  it('a hostile first offence of 6 hours: previewed, saved, and suggested on a real case', async () => {
    const w = await owner();
    const f = await w.file({ target: 'Vantablob' });
    expect((await w.client.getReport(f.id)).suggest.outcome).toEqual({ kind: 'chat', durationMs: D });
    const { user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Hostile: how long'), '6 hours');
    await waitFor(async () => expect(await cellOf('Clean record', 2)).toMatch(/Restrict chat 6 hours/), WAIT);
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect((await w.client.getReport(f.id)).suggest.outcome).toEqual({ kind: 'chat', durationMs: 6 * H });
  });

  it('banter is never acted on, and says so', async () => {
    const w = await owner();
    await open(w);
    expect(screen.getByText('Banter: never acted on.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Banter: what happens')).toBeNull();
  });

  it('rude to "Note", and "No action" and "Warning" have no length', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Rude: what happens'), 'Note');
    expect(screen.queryByLabelText('Rude: how long')).toBeNull();
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect(w.cw.profile.firstOffense.rude).toBe('note');
  });

  it('the kit refuses a severe first offence of "No action": the field is marked and takes keyboard focus', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Severe: what happens'), 'No action');
    await save(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("That setting isn't allowed.");
    await waitFor(() => expect(screen.getByLabelText('Severe: what happens')).toHaveFocus());
    expect(screen.getByLabelText('Severe: what happens')).toHaveAttribute('aria-invalid', 'true');
    // Nothing was saved, the edit is kept, and the screen did not read the settings again.
    expect(screen.getByLabelText('Severe: what happens')).toHaveValue('none');
    expect(w.cw.policy.get().version).toBe(0);
    expect(gets(w)).toBe(1);
  });
});

describe('Repeated', () => {
  it('three notes in 60 days from different games, then a warning', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.clear(screen.getByLabelText('Notes'));
    await user.type(screen.getByLabelText('Notes'), '3');
    await user.clear(screen.getByLabelText('Days'));
    await user.type(screen.getByLabelText('Days'), '60');
    await user.click(screen.getByRole('checkbox', { name: 'The notes must come from different games' }));
    await user.selectOptions(screen.getByLabelText('Then: what happens'), 'Warning');
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect(w.cw.profile.repeat).toEqual({ windowDays: 60, notes: 3, distinctGames: true, outcome: 'warning' });
  });

  it.each([
    ['Notes', '0'],
    ['Days', '91'],
    ['Notes', '1.5'],
  ])('%s of %s is refused before anything is sent', async (label, value) => {
    const w = await owner();
    const { user } = await open(w);
    await user.clear(screen.getByLabelText(label));
    await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByLabelText(label)).toHaveFocus();
    expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true');
    expect(requests(w, 'PUT', '/policy/profile')).toHaveLength(0);
  });
});

describe('Rules', () => {
  it('the preview takes a rule: area rules turn a chat restriction into an area one', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Preview a report that cites'), screen.getByRole('option', { name: /Rule 5:/ }));
    await waitFor(async () => expect(await cellOf('Clean record', 2)).toMatch(/Ban from public rooms 24 hours/), WAIT);
    expect(previews(w).at(-1)?.body).toMatchObject({ rule: 5 });
    await user.click(within(areaGroup()).getByRole('checkbox', { name: 'Rule 5: No cheating or exploiting' }));
    await waitFor(async () => expect(await cellOf('Clean record', 2)).toMatch(/Restrict chat 24 hours/), WAIT);
  });

  it('area and severe rules, edited and saved, are what the kit uses', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(areaGroup()).getByRole('checkbox', { name: 'Rule 5: No cheating or exploiting' }));
    await user.click(within(severeGroup()).getByRole('checkbox', { name: /^Rule 2:/ }));
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect(w.cw.profile.areaRules).toEqual([6]);
    expect(w.cw.profile.severeRules).toEqual([1, 2]);
  });
});

describe('Written guidelines', () => {
  it('the outcome text is saved and the generated guide says it', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = screen.getByLabelText(/Outcome for .Personal abuse./);
    await user.clear(box);
    await user.type(box, 'A warning, then a 1 hour chat break.');
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect((await w.client.policy()).documents.moderatorGuide).toContain('A warning, then a 1 hour chat break.');
  });

  it('an empty outcome is refused before sending', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.clear(screen.getByLabelText(/Outcome for .Personal abuse./));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByLabelText(/Outcome for .Personal abuse./)).toHaveFocus();
    expect(requests(w, 'PUT', '/policy/profile')).toHaveLength(0);
  });
});

describe('Preview', () => {
  it('shows the sample records by the conduct levels, as referee cards with words', async () => {
    const w = await owner();
    await open(w);
    const region = await screen.findByRole('region', { name: 'Preview' });
    await waitFor(() => expect(within(region).getAllByRole('row')).toHaveLength(5), WAIT);
    expect(within(region).getByRole('row', { name: /^Clean record/ })).toBeInTheDocument();
    expect(within(region).getByRole('row', { name: /^One warning/ })).toBeInTheDocument();
    expect(within(region).getByRole('row', { name: /^24-hour chat restriction/ })).toBeInTheDocument();
    expect(within(region).getByRole('row', { name: /^7-day ban/ })).toBeInTheDocument();
    expect(await cellOf('Clean record', 0)).toBe('No action');
    expect(region.querySelectorAll('.cw-card').length).toBeGreaterThan(5);
  });

  it('waits 400 ms after the last edit and sends the draft once', async () => {
    const w = await owner();
    const { user } = await open(w);
    await waitFor(() => expect(previews(w)).toHaveLength(1), WAIT);
    await user.selectOptions(screen.getByLabelText('Hostile: how long'), '6 hours');
    await user.selectOptions(screen.getByLabelText('Hostile: how long'), '12 hours');
    await user.selectOptions(screen.getByLabelText('Rude: what happens'), 'Note');
    expect(previews(w)).toHaveLength(1);
    await waitFor(() => expect(previews(w)).toHaveLength(2), WAIT);
    await new Promise((r) => setTimeout(r, 600));
    expect(previews(w)).toHaveLength(2);
    expect(previews(w)[1]?.body).toEqual({ layer: { firstOffense: { rude: 'note', hostile: { kind: 'chat', durationMs: 12 * H } } } });
  });

  it('a draft with a problem sends no preview and says why', async () => {
    const w = await owner();
    const { user } = await open(w);
    await waitFor(() => expect(previews(w)).toHaveLength(1), WAIT);
    await user.clear(screen.getByLabelText('Notes'));
    await new Promise((r) => setTimeout(r, 600));
    expect(previews(w)).toHaveLength(1);
    expect(screen.getByText('Fix the marked settings to see the preview.')).toBeInTheDocument();
  });

  it('a layer the kit refuses is said without moving keyboard focus', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Severe: what happens'), 'No action');
    await screen.findByText('The preview cannot be shown for these settings.', undefined, WAIT);
    expect(screen.getByLabelText('Severe: what happens')).toHaveFocus();
  });
});

describe('Saving', () => {
  it('asks for a reason, sends nothing without one, and puts it in the audit trail', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Say why you are changing this.')).toBeInTheDocument();
    expect(requests(w, 'PUT', '/policy/profile')).toHaveLength(0);
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'Lae asked for lighter steps');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Saved the steps and ladder.');
    const audit = (await w.client.listAudit()).items.find((i) => i.action === 'policy.update');
    expect(audit?.detail).toEqual({ sections: ['customDuration'], reason: 'Lae asked for lighter steps' });
  });

  it('afterwards the screen is clean at the new version, and reads at most once more', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    await waitFor(() => expect(screen.getByText('No unsaved changes.')).toBeInTheDocument());
    expect(gets(w)).toBeLessThanOrEqual(2);
    // A second edit saves against the new version.
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await save(user, 'Back on again');
    await waitFor(() => expect(requests(w, 'PUT', '/policy/profile')).toHaveLength(2));
    expect((requests(w, 'PUT', '/policy/profile')[1]?.body as { version: number }).version).toBe(1);
    expect(w.cw.profile.customDuration).toBe(true);
  });

  it('uses the state the kit answers a save with, when it does, and reads nothing more', async () => {
    const w = await owner();
    w.intercept.fn = async (req) => {
      if (req.method !== 'PUT' || req.path !== '/policy/profile') return undefined;
      const res = await w.direct.savePolicyProfile(req.body as never);
      return { status: 200, body: { ...res, ...(await w.direct.policyProfile()) } };
    };
    const { user } = await open(w);
    const before = gets(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    expect(gets(w)).toBe(before);
    expect(screen.getByText('No unsaved changes.')).toBeInTheDocument();
  });

  it('a save sends back what another screen saved (a section this screen does not edit), so it is never dropped', async () => {
    const w = await owner();
    w.intercept.fn = async (req) => {
      if (req.method !== 'GET' || req.path !== '/policy/profile') return undefined;
      const state = await w.direct.policyProfile();
      return { status: 200, body: { ...state, layer: { ...state.layer, reporting: { thanks: 'Thanks for the report.' } } } };
    };
    const { user } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await save(user);
    await waitFor(() => expect(requests(w, 'PUT', '/policy/profile')).toHaveLength(1));
    expect((requests(w, 'PUT', '/policy/profile')[0]?.body as { layer: object }).layer).toEqual({ customDuration: false, reporting: { thanks: 'Thanks for the report.' } });
  });

  it('Discard changes puts the draft back to what is saved', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Hostile: how long'), '6 hours');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Hostile: how long')).toHaveValue('24h');
    expect(screen.getByText('No unsaved changes.')).toBeInTheDocument();
  });

  it('a double click on the final button sends one save', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'because');
    await user.dblClick(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Saved the steps and ladder.');
    expect(requests(w, 'PUT', '/policy/profile')).toHaveLength(1);
  });

  it('a second save from a stale screen conflicts: it says so, offers Reload, and Reload shows their change', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await w.clientFor('bea@example.test', 'owner').savePolicyProfile({ layer: { durations: [H] }, version: 0, reason: 'Bea got there first' });
    await save(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Someone else changed these settings.');
    expect(w.cw.profile.customDuration).toBe(true);
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Lengths offered' })).getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByRole('checkbox', { name: 'Let moderators type their own length' })).toBeChecked();
    expect(screen.queryByText('Someone else changed these settings.')).toBeNull();
    expect(gets(w)).toBe(2);
  });

  it('a dropped connection keeps the edits and offers Retry', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    let down = true;
    w.intercept.fn = (req) => {
      if (down && req.method === 'PUT') throw new Error('offline');
      return undefined;
    };
    await save(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not reach the server.');
    expect(screen.getByRole('checkbox', { name: 'Let moderators type their own length' })).not.toBeChecked();
    down = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByText('Saved the steps and ladder.');
    expect(w.cw.profile.customDuration).toBe(false);
  });

  it('a 403 from the server (the role changed) shows a plain message', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    await save(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your role cannot do this.');
  });

  it('the settings, saved, change what the next hub screen offers: the guide, the audit label, the rules read again', async () => {
    const w = await owner();
    const { user, router } = await open(w);
    const policyReads = () => requests(w, 'GET', '/policy').length;
    const first = policyReads();
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    router.navigate('/audit');
    await screen.findByText('Changed the settings');
    router.navigate('/guide');
    await screen.findByRole('region', { name: 'Escalation ladder' });
    expect(policyReads()).toBeGreaterThan(first);
  });
});

describe('Reset', () => {
  async function savedTwo(w: HubWorld, user: User) {
    await user.selectOptions(screen.getByLabelText('Hostile: how long'), '6 hours');
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await user.click(screen.getByRole('button', { name: 'Remove 30 days' }));
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset lengths' })).toBeEnabled());
    expect(w.cw.profile.firstOffense.hostile).toEqual({ kind: 'chat', durationMs: 6 * H });
  }

  it('a section is reset only after an in-page confirm that asks why; the others stay', async () => {
    const w = await owner();
    const { user } = await open(w);
    await savedTwo(w, user);
    const spy = vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('confirm() must not be used');
    });
    await user.click(screen.getByRole('button', { name: 'Reset lengths' }));
    const confirm = screen.getByRole('group', { name: 'Reset lengths?' });
    expect(requests(w, 'DELETE', '/policy/profile')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Reset' }));
    expect(within(confirm).getByText('Say why you are resetting this.')).toBeInTheDocument();
    expect(requests(w, 'DELETE', '/policy/profile')).toHaveLength(0);
    await user.type(within(confirm).getByRole('textbox', { name: /Why are you resetting this/ }), 'Back to the defaults');
    await user.click(within(confirm).getByRole('button', { name: 'Reset' }));
    await screen.findByText('Reset the lengths.');
    spy.mockRestore();
    const sent = requests(w, 'DELETE', '/policy/profile');
    expect(sent.map((r) => r.query?.section).sort()).toEqual(['customDuration', 'durations']);
    expect(sent.every((r) => (r.body as { reason: string }).reason === 'Back to the defaults')).toBe(true);
    expect(w.cw.profile.durations).toEqual([H, 6 * H, 12 * H, D, 3 * D, 7 * D, 30 * D]);
    expect(w.cw.profile.customDuration).toBe(true);
    expect(w.cw.profile.firstOffense.hostile).toEqual({ kind: 'chat', durationMs: 6 * H });
    expect(within(screen.getByRole('list', { name: 'Lengths offered' })).getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByLabelText('Hostile: how long')).toHaveValue(String(6 * H));
  });

  it('Keep my settings sends nothing', async () => {
    const w = await owner();
    const { user } = await open(w);
    await savedTwo(w, user);
    await user.click(screen.getByRole('button', { name: 'Reset lengths' }));
    await user.click(screen.getByRole('button', { name: 'Keep my settings' }));
    expect(screen.queryByRole('group', { name: 'Reset lengths?' })).toBeNull();
    expect(requests(w, 'DELETE', '/policy/profile')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Reset lengths' })).toHaveFocus();
  });

  it('a section with nothing saved cannot be reset', async () => {
    const w = await owner();
    await open(w);
    for (const name of ['Reset lengths', 'Reset the ladder', 'Reset first offence', 'Reset repeated', 'Reset rules', 'Reset guidelines', 'Reset steps and ladder']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('Reset steps and ladder drops every saved edit, one call for each section it names (never a call that names none)', async () => {
    const w = await owner();
    const { user } = await open(w);
    await savedTwo(w, user);
    await user.click(screen.getByRole('button', { name: 'Reset steps and ladder' }));
    const confirm = screen.getByRole('group', { name: 'Reset steps and ladder?' });
    await user.type(within(confirm).getByRole('textbox', { name: /Why are you resetting this/ }), 'Start over');
    await user.click(within(confirm).getByRole('button', { name: 'Reset' }));
    await screen.findByText('Reset the steps and ladder.');
    const sent = requests(w, 'DELETE', '/policy/profile');
    expect(sent.map((r) => r.query?.section).sort()).toEqual(['customDuration', 'durations', 'firstOffense']);
    expect(w.cw.policy.get().layer).toEqual({});
    expect(screen.getByLabelText('Hostile: how long')).toHaveValue('24h');
  });

  it.each([
    ['Reset the ladder', 'ladder'],
    ['Reset first offence', 'firstOffense'],
    ['Reset repeated', 'repeat'],
    ['Reset rules', 'areaRules'],
    ['Reset guidelines', 'guidelines'],
  ])('%s resets its own section (%s)', async (button, section) => {
    const w = await owner();
    w.cw.policy.save(
      {
        ladder: plainLadder(w),
        firstOffense: { rude: 'note' },
        repeat: { notes: 4 },
        areaRules: [6],
        severeRules: [1, 2],
        guidelines: [{ outcome: 'No action at all.' }],
      },
      { version: 0, actor: 'x', reason: 'seed' },
    );
    const { user } = await open(w);
    await user.click(screen.getByRole('button', { name: button }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'Reset it');
    await user.click(within(screen.getByRole('group', { name: /\?$/ })).getByRole('button', { name: 'Reset' }));
    await within(screen.getByRole('region', { name: 'Notifications' })).findByText(/^Reset the /);
    const left = Object.keys(w.cw.policy.get().layer);
    expect(left).not.toContain(section);
    expect(left.length).toBeGreaterThan(0);
  });

  it('a reset keeps unsaved edits in other sections', async () => {
    const w = await owner();
    w.cw.policy.save({ durations: [H, D] }, { version: 0, actor: 'x', reason: 'seed' });
    const { user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Rude: what happens'), 'Note');
    await user.click(screen.getByRole('button', { name: 'Reset lengths' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'Default again');
    await user.click(within(screen.getByRole('group', { name: 'Reset lengths?' })).getByRole('button', { name: 'Reset' }));
    await screen.findByText('Reset the lengths.');
    expect(screen.getByLabelText('Rude: what happens')).toHaveValue('note');
    expect(within(screen.getByRole('list', { name: 'Lengths offered' })).getAllByRole('listitem')).toHaveLength(7);
  });
});


describe('fix round 1', () => {
  const kitWords = /\bkit\b|your code|set in code|from code/i;

  it('says nothing about the kit or the code to a moderator: the refusal, the reset question and the notices', async () => {
    const w = await owner();
    w.cw.policy.save({ durations: [H] }, { version: 0, actor: 'x', reason: 'seed' });
    const { user, container } = await open(w);
    await user.selectOptions(screen.getByLabelText('Severe: what happens'), 'No action');
    await save(user);
    await screen.findByText("That setting isn't allowed.");
    expect(screen.getByText("This setting isn't allowed.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset lengths' }));
    expect(screen.getByText(/puts the setting back to the default/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(kitWords);
  });

  it('a 400 that names no field keeps the reason form open and says so without pointing at a marked setting', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    w.intercept.fn = (req) =>
      req.method === 'PUT' ? { status: 400, body: { error: 'invalid_profile', message: 'x', path: 'layer.profanity' } } : undefined;
    await save(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("These settings aren't allowed.");
    expect(alert).not.toHaveTextContent(/marked/);
    expect(screen.getByRole('textbox', { name: /Why are you changing this/ })).toHaveValue('Lighter steps, asked for by the team');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('a section saved by someone else after this page loaded survives Reset steps and ladder (the call names only what this screen knows)', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('button', { name: 'Remove 30 days' }));
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset lengths' })).toBeEnabled());
    expect(w.cw.policy.save({ reporting: { flow: 'reason_first' }, ...w.cw.policy.get().layer }, { version: w.cw.policy.get().version, actor: 'maya@example.test', reason: 'reporting' }).ok).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Reset steps and ladder' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'ladder only');
    await user.click(within(screen.getByRole('group', { name: 'Reset steps and ladder?' })).getByRole('button', { name: 'Reset' }));
    await screen.findByText('Reset the steps and ladder.');
    expect(w.cw.profile.reporting.flow).toBe('reason_first');
  });

  it('Reset steps and ladder says that unsaved edits are lost too, only when there are some', async () => {
    const w = await owner();
    w.cw.policy.save({ durations: [H] }, { version: 0, actor: 'x', reason: 'seed' });
    const { user } = await open(w);
    await user.click(screen.getByRole('button', { name: 'Reset steps and ladder' }));
    expect(screen.queryByText(/unsaved changes will be lost/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Keep my settings' }));
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await user.click(screen.getByRole('button', { name: 'Reset steps and ladder' }));
    expect(screen.getByText(/Your unsaved changes will be lost too./)).toBeInTheDocument();
  });

  it('a reset of two sections whose second call fails still refreshes: the first section is back, the version is current, the next save is not a conflict', async () => {
    const w = await owner();
    w.cw.policy.save({ durations: [H], customDuration: false }, { version: 0, actor: 'x', reason: 'seed' });
    const { user } = await open(w);
    expect(within(screen.getByRole('list', { name: 'Lengths offered' })).getAllByRole('listitem')).toHaveLength(1);
    const policyReads = () => requests(w, 'GET', '/policy').length;
    // A kit that answers a reset without the new state (so the screen reads it), and a read that is slow: the failure of the second call is
    // known before the new state arrives.
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === '/policy/profile') await new Promise((r) => setTimeout(r, 80));
      if (req.method !== 'DELETE') return undefined;
      if (req.query?.section === 'customDuration') return { status: 500, body: { error: 'internal', message: 'x' } };
      const done = await w.direct.resetPolicyProfile({ section: req.query?.section as 'durations', reason: (req.body as { reason: string }).reason });
      return { status: 200, body: { ok: true, version: done.version, changed: done.changed } };
    };
    await user.click(screen.getByRole('button', { name: 'Reset lengths' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'Back to the default');
    await user.click(within(screen.getByRole('group', { name: 'Reset lengths?' })).getByRole('button', { name: 'Reset' }));
    expect(await within(screen.getByRole('group', { name: 'Reset lengths?' })).findByRole('alert')).toBeInTheDocument();
    // The first call went through: the lengths are back to the default on the server and in the draft, and the version moved.
    expect(w.cw.profile.durations).toHaveLength(7);
    expect(w.cw.profile.customDuration).toBe(false);
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Lengths offered' })).getAllByRole('listitem')).toHaveLength(7));
    // The remembered policy was dropped: the next read of it asks the server again.
    const before = policyReads();
    await w.client.policy();
    expect(policyReads()).toBe(before + 1);
    w.intercept.fn = null;
    await user.click(screen.getByRole('button', { name: 'Keep my settings' }));
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await save(user, 'Second try');
    await screen.findByText('Saved the steps and ladder.');
    expect(screen.queryByText('Someone else changed these settings.')).toBeNull();
    const put = requests(w, 'PUT', '/policy/profile').at(-1)?.body as { version: number };
    expect(put.version).toBe(2);
    expect(w.cw.profile.customDuration).toBe(true);
  });

  it('a failed Reload does not leave the screen waiting to throw the draft away on the next state', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await w.clientFor('bea@example.test', 'owner').savePolicyProfile({ layer: { durations: [H] }, version: 0, reason: 'Bea' });
    await save(user);
    const alert = await screen.findByRole('alert');
    // The Reload read fails: the edits are kept.
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/policy/profile' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(gets(w)).toBe(2));
    w.intercept.fn = null;
    // A later read that works (the Try again of the error) is not a Reload: the edit stays.
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(gets(w)).toBe(3));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByRole('checkbox', { name: 'Let moderators type their own length' })).not.toBeChecked();
  });
});

describe('fix round 1: the preview under StrictMode and on open', () => {
  it('the first preview is asked for at once, even when effects run twice', async () => {
    const w = await owner();
    const user = userEvent.setup();
    render(
      <StrictMode>
        <Hub client={w.client} router={memoryRouter('/settings/ladder')} now={w.now} mode="detailed" />
      </StrictMode>,
    );
    await screen.findByRole('list', { name: 'Lengths offered' });
    const started = Date.now();
    await screen.findByRole('region', { name: 'Preview of suggestions' }, { timeout: 3000 });
    expect(Date.now() - started).toBeLessThan(350);
    expect(user).toBeDefined();
  });
});

describe('leaving with unsaved edits', () => {
  it('asks in the page, and "Keep editing" stays', async () => {
    const w = await owner();
    const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('confirm() must not be used');
    });
    const { user, router } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await user.click(screen.getByRole('link', { name: 'Reports' }));
    const dialog = screen.getByRole('dialog', { name: 'Leave without saving?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(router.path).toBe('/settings/ladder');
    expect(screen.getByRole('checkbox', { name: 'Let moderators type their own length' })).not.toBeChecked();
    confirm.mockRestore();
  });

  it('"Leave" goes where the moderator was going', async () => {
    const w = await owner();
    const { user, router } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await user.click(screen.getByRole('link', { name: 'Audit' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(router.path).toBe('/audit'));
  });

  it('a clean screen leaves at once, and a saved one too', async () => {
    const w = await owner();
    const { user, router } = await open(w);
    await user.click(screen.getByRole('link', { name: 'Audit' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(router.path).toBe('/audit');
  });

  it('after a save there is nothing to lose', async () => {
    const w = await owner();
    const { user, router } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await save(user);
    await screen.findByText('Saved the steps and ladder.');
    await waitFor(() => expect(screen.getByText('No unsaved changes.')).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Audit' }));
    expect(router.path).toBe('/audit');
  });

  it('closing the page asks the browser to confirm, only while there are unsaved edits', async () => {
    const w = await owner();
    const { user } = await open(w);
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it('Escape closes the question and keeps the edits', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await user.click(screen.getByRole('link', { name: 'Audit' }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Leave without saving?' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Let moderators type their own length' })).not.toBeChecked();
  });
});
