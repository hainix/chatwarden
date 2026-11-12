import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createRouter, playerRoutes } from '@chatwarden/http';
import type { ReportingSettings } from '@chatwarden/core';
import type { TransportRequest } from '../src/transport.js';
import { PlayersSee } from '../src/policy/ReportingPanels.js';
import { HubProvider } from '../src/provider.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The Reporting settings screen, on the real staff routes and the real kit: the flow, the reasons (add, edit, group, reorder, switch off,
// rule mapping, asks for a note), the thank-you, the "What players see" mock, save with a reason, a conflict, a refusal that points at its
// field, reset, and the roles. After each save the player's GET /rules (the real player routes on the same kit) shows what players will get.

const WAIT = { timeout: 4000 };
const owner = (o: Parameters<typeof hubWorld>[0] = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
type User = ReturnType<typeof renderHub>['user'];

async function open(w: HubWorld, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: '/settings/reporting', ...options });
  await screen.findByRole('heading', { level: 2, name: 'Reporting' });
  await screen.findByRole('list', { name: 'Reasons' });
  return r;
}
const requests = (w: HubWorld, method: string, path: string): TransportRequest[] => w.sent.filter((r) => r.method === method && r.path === path);
/** What a player would be sent right now: the real GET /rules. */
async function rules(w: HubWorld) {
  const handle = createRouter(playerRoutes(w.cw, { identify: () => ({}) }));
  const res = await handle({ method: 'GET', path: '/rules', query: {}, headers: {}, body: undefined });
  return (res.body as { reporting: { flow: string; thanks: string; reasons: Array<{ id: string; label: string; hint: string; group: string; asksNote: boolean }> } }).reporting;
}
const row = (name: string): HTMLElement => screen.getByRole('group', { name: `Reason: ${name}` });
const labels = (): string[] => within(screen.getByRole('list', { name: 'Reasons' })).getAllByRole('group').map((g) => (within(g).getByLabelText('Name players see') as HTMLInputElement).value);
async function save(user: User, reason = 'Players asked for a shorter list') {
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), reason);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
}
const mock = (): HTMLElement => screen.getByRole('region', { name: 'What players see' });

describe('the screen', () => {
  it('is reached from the Settings sections, beside Steps and ladder', async () => {
    const w = await owner();
    const { user } = renderHub(w, { path: '/settings/ladder' });
    await screen.findByRole('heading', { level: 2, name: 'Steps and ladder' });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Steps and ladder', 'Reporting', 'AI', 'Advanced']);
    expect(within(nav).getByRole('link', { name: 'Steps and ladder' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(nav).getByRole('link', { name: 'Reporting' }));
    await screen.findByRole('heading', { level: 2, name: 'Reporting' });
    expect(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', { name: 'Reporting' })).toHaveAttribute('aria-current', 'page');
  });

  it('is reached from More in Simple', async () => {
    const w = await owner();
    const { user } = renderHub(w, { mode: 'simple' });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('link', { name: 'Reporting' }));
    await screen.findByRole('heading', { level: 2, name: 'Reporting' });
  });

  it('shows the settings in force: one tap, the ten default reasons in order, the thank-you', async () => {
    const w = await owner();
    await open(w);
    for (const name of ['How players report', 'Reasons', 'Thank-you', 'What players see']) expect(screen.getByRole('region', { name })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'One tap' })).toBeChecked();
    expect(labels()).toEqual(['Insults or harassment', 'Hate', 'Sexual content', 'Threats', 'Spam or ads', 'Sharing personal info', 'Cheating', 'Throwing or griefing', 'Leaving or AFK', 'Something else']);
    const hate = within(row('Hate'));
    expect(hate.getByLabelText('Hint (optional)')).toHaveValue('Hate aimed at who someone is');
    expect(hate.getByLabelText('Group (optional)')).toHaveValue('Chat');
    expect(hate.getByRole('checkbox', { name: 'Switched on' })).toBeChecked();
    expect(hate.getByRole('checkbox', { name: 'Asks for a note' })).not.toBeChecked();
    expect(within(row('Something else')).getByRole('checkbox', { name: 'Asks for a note' })).toBeChecked();
    expect(screen.getByLabelText('What players read after they report')).toHaveValue("Thanks for the report. We'll look into it.");
  });

  it('reads the settings once when it opens, and not again by itself', async () => {
    const w = await owner();
    await open(w);
    await new Promise((r) => setTimeout(r, 600));
    expect(requests(w, 'GET', '/policy/profile')).toHaveLength(1);
  });
});

describe('the flow', () => {
  it('has three choices with one plain line each', async () => {
    const w = await owner();
    await open(w);
    const group = screen.getByRole('radiogroup', { name: 'How players report' });
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['one_tap', 'reason_first', 'reason_required']);
    // The window is one step: there is no "afterwards" and no skip.
    expect(screen.getByRole('radio', { name: 'One tap' })).toHaveAccessibleDescription('Players press Report on a message, then Report in the window. Saying why is optional.');
    expect(screen.getByRole('radio', { name: 'Pick a reason first' })).toHaveAccessibleDescription('Players are asked "Why?" in the same window. Saying why is still optional.');
    expect(screen.getByRole('radio', { name: 'Reason required' })).toHaveAccessibleDescription('Players must choose a reason in the window before Report sends.');
    expect(screen.getByText('A reason is only a hint. Moderators decide what a report really is.')).toBeInTheDocument();
  });

  it.each([
    ['Pick a reason first', 'reason_first'],
    ['Reason required', 'reason_required'],
  ])('choosing "%s" and saving changes what players are sent (%s)', async (name, flow) => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('radio', { name }));
    expect(screen.getByText('1 section has unsaved changes.')).toBeInTheDocument();
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect((await rules(w)).flow).toBe(flow);
    expect(w.cw.profile.reporting.flow).toBe(flow);
    expect(requests(w, 'PUT', '/policy/profile')[0]?.body).toEqual({ layer: { reporting: { flow } }, version: 0, reason: 'Players asked for a shorter list' });
  });

  it('going back to the default before saving is not a change', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('radio', { name: 'Reason required' }));
    await user.click(screen.getByRole('radio', { name: 'One tap' }));
    expect(screen.getByText('No unsaved changes.')).toBeInTheDocument();
  });
});

describe('the reasons', () => {
  it('rename, hint and group: saved, and players are sent the new words', async () => {
    const w = await owner();
    const { user } = await open(w);
    const hate = within(row('Hate'));
    await user.clear(hate.getByLabelText('Name players see'));
    await user.type(hate.getByLabelText('Name players see'), 'Hate speech');
    await user.clear(hate.getByLabelText('Hint (optional)'));
    await user.type(hate.getByLabelText('Hint (optional)'), 'Words aimed at who someone is');
    await user.clear(hate.getByLabelText('Group (optional)'));
    await user.type(hate.getByLabelText('Group (optional)'), 'Words');
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    const got = (await rules(w)).reasons.find((r) => r.id === 'hate');
    expect(got).toEqual({ id: 'hate', label: 'Hate speech', hint: 'Words aimed at who someone is', group: 'Words', asksNote: false });
    expect(screen.getByRole('group', { name: 'Reason: Hate speech' })).toBeInTheDocument();
  });

  it('adds a reason before "Something else"; its id comes from its name; players see it', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('button', { name: 'Add a reason' }));
    expect(labels().slice(-2)).toEqual(['', 'Something else']);
    const fresh = within(row('new reason'));
    await user.type(fresh.getByLabelText('Name players see'), 'Lag switching');
    await user.type(fresh.getByLabelText('Group (optional)'), 'Gameplay');
    await user.click(fresh.getByRole('checkbox', { name: 'Asks for a note' }));
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    const list = (await rules(w)).reasons;
    expect(list.map((r) => r.id)).toEqual(['harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info', 'cheating', 'griefing', 'afk', 'lag_switching', 'other']);
    expect(list.find((r) => r.id === 'lag_switching')).toMatchObject({ label: 'Lag switching', group: 'Gameplay', asksNote: true });
    // The saved row keeps its place and now has its id: renaming it later does not change what old reports mean.
    expect(labels().at(-2)).toBe('Lag switching');
  });

  it('a renamed saved reason keeps its id (old reports keep their meaning)', async () => {
    const w = await owner();
    const { user } = await open(w);
    const spam = within(row('Spam or ads'));
    await user.clear(spam.getByLabelText('Name players see'));
    await user.type(spam.getByLabelText('Name players see'), 'Advertising');
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect((await rules(w)).reasons.map((r) => r.id)).toContain('spam');
    expect(w.cw.profile.reporting.reasons.find((r) => r.id === 'spam')?.label).toBe('Advertising');
  });

  it('reorders with buttons, never by drag: up, down, and the ends do nothing', async () => {
    const w = await owner();
    const { user } = await open(w);
    expect(within(row('Insults or harassment')).getByRole('button', { name: 'Move Insults or harassment up' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(within(row('Hate')).getByRole('button', { name: 'Move Hate up' }));
    expect(labels().slice(0, 3)).toEqual(['Hate', 'Insults or harassment', 'Sexual content']);
    await user.click(within(row('Hate')).getByRole('button', { name: 'Move Hate down' }));
    expect(labels().slice(0, 2)).toEqual(['Insults or harassment', 'Hate']);
    await user.click(within(row('Threats')).getByRole('button', { name: 'Move Threats down' }));
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect((await rules(w)).reasons.map((r) => r.id).slice(0, 5)).toEqual(['harassment', 'hate', 'sexual', 'spam', 'threat']);
  });

  it('"Something else" stays last: it has no move buttons, and the reason above it cannot be moved below it', async () => {
    const w = await owner();
    await open(w);
    expect(within(row('Something else')).queryByRole('button', { name: /^Move/ })).toBeNull();
    expect(within(row('Leaving or AFK')).getByRole('button', { name: 'Move Leaving or AFK down' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(row('Leaving or AFK')).getByRole('button', { name: 'Move Leaving or AFK up' })).toHaveAttribute('aria-disabled', 'false');
  });

  it('says where a row went after a move, in a polite status', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(row('Hate')).getByRole('button', { name: 'Move Hate up' }));
    const note = await screen.findByText('Moved Hate to 1 of 10.');
    expect(note.closest('[role="status"]')).not.toBeNull();
    await user.click(within(row('Hate')).getByRole('button', { name: 'Move Hate down' }));
    expect(await screen.findByText('Moved Hate to 2 of 10.')).toBeInTheDocument();
    // A move that goes nowhere says nothing new.
    await user.click(within(row('Leaving or AFK')).getByRole('button', { name: 'Move Leaving or AFK down' }));
    expect(screen.queryByText(/Moved Leaving or AFK/)).toBeNull();
  });

  it('a moved row keeps keyboard focus on its button', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(row('Hate')).getByRole('button', { name: 'Move Hate down' }));
    await waitFor(() => expect(within(row('Hate')).getByRole('button', { name: 'Move Hate down' })).toHaveFocus());
  });

  it('switching a reason off keeps it in the list for the studio but players no longer see it', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(row('Sexual content')).getByRole('checkbox', { name: 'Switched on' }));
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect((await rules(w)).reasons.map((r) => r.id)).not.toContain('sexual');
    expect(labels()).toContain('Sexual content');
    expect(within(row('Sexual content')).getByRole('checkbox', { name: 'Switched on' })).not.toBeChecked();
  });

  it('removes a reason', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(row('Leaving or AFK')).getByRole('button', { name: 'Remove Leaving or AFK' }));
    expect(labels()).toHaveLength(9);
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect((await rules(w)).reasons.map((r) => r.id)).not.toContain('afk');
  });

  it('maps a reason to rules with a multi-picker; the first is the suggested one', async () => {
    const w = await owner();
    const { user } = await open(w);
    const hate = within(row('Hate'));
    const toggle = hate.getByRole('button', { name: /^Rules/ });
    expect(hate.queryByText(/lowest-numbered/)).toBeNull();
    expect(toggle).toHaveTextContent('Rules: 1');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(hate.getByText('In Detailed the lowest-numbered rule is suggested. In Simple the moderator is asked when there is more than one. A decision under any of them counts as a match for the reporter.')).toBeInTheDocument();
    const picker = hate.getByRole('group', { name: 'Rules this usually means' });
    expect(within(picker).getByRole('checkbox', { name: /^Rule 1:/ })).toBeChecked();
    await user.click(within(picker).getByRole('checkbox', { name: /^Rule 3:/ }));
    expect(toggle).toHaveTextContent('Rules: 2');
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect(w.cw.profile.reporting.reasons.find((r) => r.id === 'hate')?.rules).toEqual([1, 3]);
  });

  it('"asks for a note" is saved, and players are told', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(row('Cheating')).getByRole('checkbox', { name: 'Asks for a note' }));
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect((await rules(w)).reasons.find((r) => r.id === 'cheating')?.asksNote).toBe(true);
  });

  it('"Something else" cannot be removed or switched off, and the page says so; it can be renamed and mapped', async () => {
    const w = await owner();
    const { user } = await open(w);
    const other = within(row('Something else'));
    expect(other.queryByRole('button', { name: /^Remove/ })).toBeNull();
    const on = other.getByRole('checkbox', { name: 'Switched on' });
    expect(on).toBeChecked();
    expect(on).toBeDisabled();
    expect(other.getByText('Always on. It is what is left when no other reason fits, so it cannot be removed or switched off. You can rename it.')).toBeInTheDocument();
    await user.clear(other.getByLabelText('Name players see'));
    await user.type(other.getByLabelText('Name players see'), 'Anything else');
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect((await rules(w)).reasons.find((r) => r.id === 'other')?.label).toBe('Anything else');
  });

  it('only "Something else" left on is still a list the kit accepts (it cannot be switched off)', async () => {
    const w = await owner();
    const { user } = await open(w);
    for (const g of within(screen.getByRole('list', { name: 'Reasons' })).getAllByRole('group')) {
      const on = within(g).getByRole('checkbox', { name: 'Switched on' });
      if (!(on as HTMLInputElement).disabled) await user.click(on);
    }
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect((await rules(w)).reasons.map((r) => r.id)).toEqual(['other']);
  });

  it('at most 20 reasons: the button says so and adds nothing more', async () => {
    const w = await owner();
    const { user } = await open(w);
    expect(screen.getByText('10 of 20 reasons.')).toBeInTheDocument();
    for (let i = 0; i < 10; i += 1) await user.click(screen.getByRole('button', { name: 'Add a reason' }));
    expect(labels()).toHaveLength(20);
    expect(screen.getByRole('button', { name: 'Add a reason' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Add a reason' }));
    expect(labels()).toHaveLength(20);
    expect(screen.getByText('20 of 20 reasons.')).toBeInTheDocument();
  });

  it('a new row takes keyboard focus on its name', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('button', { name: 'Add a reason' }));
    await waitFor(() => expect(within(row('new reason')).getByLabelText('Name players see')).toHaveFocus());
  });
});

describe('the thank-you', () => {
  it('is edited, saved, and sent to players', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = screen.getByLabelText('What players read after they report');
    await user.clear(box);
    await user.type(box, 'Got it. A moderator will have a look.');
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect((await rules(w)).thanks).toBe('Got it. A moderator will have a look.');
  });
});

describe('what the kit would refuse is said before anything is sent', () => {
  it.each([
    ['an empty name', 'Hate', 'Name players see', '   ', 'Give the reason a name players will understand.'],
    ['a name over 60', 'Hate', 'Name players see', 'x'.repeat(61), 'Use at most 60 characters.'],
    ['a hint over 160', 'Hate', 'Hint (optional)', 'x'.repeat(161), 'Use at most 160 characters.'],
    ['a group over 40', 'Hate', 'Group (optional)', 'x'.repeat(41), 'Use at most 40 characters.'],
  ])('%s is marked, focused, and nothing is sent', async (_n, reason, field, value, message) => {
    const w = await owner();
    const { user } = await open(w);
    const input = within(row(reason)).getByLabelText(field);
    fireEvent.change(input, { target: { value } });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(within(input.closest('[role="group"]') as HTMLElement).getByText(message)).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
    expect(requests(w, 'PUT', '/policy/profile')).toHaveLength(0);
    expect(screen.queryByRole('textbox', { name: /Why are you changing this/ })).toBeNull();
  });

  it('an empty or over-long thank-you', async () => {
    const w = await owner();
    const { user } = await open(w);
    const box = screen.getByLabelText('What players read after they report');
    fireEvent.change(box, { target: { value: '  ' } });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Write what players read after they report.')).toBeInTheDocument();
    expect(box).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(box, { target: { value: 't'.repeat(301) } });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Use at most 300 characters.')).toBeInTheDocument();
    expect(requests(w, 'PUT', '/policy/profile')).toHaveLength(0);
  });

  it('exactly at the limits is saved', async () => {
    const w = await owner();
    const { user } = await open(w);
    fireEvent.change(within(row('Hate')).getByLabelText('Name players see'), { target: { value: 'x'.repeat(60) } });
    fireEvent.change(screen.getByLabelText('What players read after they report'), { target: { value: 't'.repeat(300) } });
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect(w.cw.profile.reporting.thanks).toHaveLength(300);
  });

  it('a refusal from the kit that names a row marks that row and puts focus there', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(within(row('Hate')).getByRole('checkbox', { name: 'Asks for a note' }));
    w.intercept.fn = (req) =>
      req.method === 'PUT' && req.path === '/policy/profile'
        ? { status: 400, body: { error: 'invalid_profile', message: 'no', path: 'layer.reporting.reasons[1].label' } }
        : undefined;
    await save(user);
    expect(await screen.findByText("That setting isn't allowed.")).toBeInTheDocument();
    const name = within(row('Hate')).getByLabelText('Name players see');
    await waitFor(() => expect(name).toHaveFocus(), WAIT);
    expect(name).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('saving and conflicts', () => {
  it('a second save from a stale page conflicts and offers Reload, which brings the other change in', async () => {
    const w = await owner();
    const { user } = await open(w);
    expect(w.cw.policy.save({ reporting: { flow: 'reason_required' } }, { version: 0, actor: 'maya@example.test', reason: 'stricter' }).ok).toBe(true);
    await user.click(screen.getByRole('radio', { name: 'Pick a reason first' }));
    await save(user);
    expect(await screen.findByText('Someone else changed these settings.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Reason required' })).toBeChecked(), WAIT);
  });

  it('keeps the steps and ladder another screen saved', async () => {
    const w = await owner();
    expect(w.cw.policy.save({ durations: [3_600_000, 7_200_000] }, { version: 0, actor: 'owen@example.test', reason: 'two lengths' }).ok).toBe(true);
    const { user } = await open(w);
    await user.click(screen.getByRole('radio', { name: 'Reason required' }));
    await save(user);
    await screen.findByText('Saved the reporting settings.');
    expect(w.cw.profile.durations).toEqual([3_600_000, 7_200_000]);
    expect(w.cw.profile.reporting.flow).toBe('reason_required');
    expect(requests(w, 'PUT', '/policy/profile')[0]?.body).toMatchObject({ layer: { durations: [3_600_000, 7_200_000], reporting: { flow: 'reason_required' } } });
  });

  it('and a ladder save keeps the reporting another screen saved', async () => {
    const w = await owner();
    expect(w.cw.policy.save({ reporting: { flow: 'reason_first' } }, { version: 0, actor: 'owen@example.test', reason: 'reason first' }).ok).toBe(true);
    const { user } = renderHub(w, { path: '/settings/ladder' });
    await screen.findByRole('list', { name: 'Lengths offered' });
    await user.click(screen.getByRole('button', { name: 'Remove 30 days' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'drop 30 days');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Saved the steps and ladder.');
    expect(w.cw.profile.reporting.flow).toBe('reason_first');
    expect(w.cw.profile.durations).not.toContain(30 * 86_400_000);
  });
});

describe('reset', () => {
  async function savedWorld() {
    const w = await owner();
    const layer: ReportingSettings = { flow: 'reason_required', thanks: 'Thanks!' };
    expect(w.cw.policy.save({ reporting: layer, durations: [3_600_000, 7_200_000] }, { version: 0, actor: 'owen@example.test', reason: 'set up' }).ok).toBe(true);
    return w;
  }

  it('Reset reporting asks why, puts the defaults back, and leaves the steps and ladder alone', async () => {
    const w = await savedWorld();
    const { user } = await open(w);
    expect(screen.getByRole('radio', { name: 'Reason required' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Reset reporting' }));
    const confirm = screen.getByRole('group', { name: 'Reset reporting?' });
    await user.click(within(confirm).getByRole('button', { name: 'Reset' }));
    expect(within(confirm).getByText('Say why you are resetting this.')).toBeInTheDocument();
    await user.type(within(confirm).getByRole('textbox', { name: /Why are you resetting this/ }), 'Back to the default');
    await user.click(within(confirm).getByRole('button', { name: 'Reset' }));
    await screen.findByText('Reset the reporting settings.');
    expect(screen.getByRole('radio', { name: 'One tap' })).toBeChecked();
    expect((await rules(w)).flow).toBe('one_tap');
    expect(w.cw.profile.durations).toEqual([3_600_000, 7_200_000]);
    const call = requests(w, 'DELETE', '/policy/profile')[0];
    expect(call?.query).toEqual({ section: 'reporting' });
  });

  it('is off when nothing is saved for reporting', async () => {
    const w = await owner();
    await open(w);
    expect(screen.getByRole('button', { name: 'Reset reporting' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('"Reset steps and ladder" leaves reporting alone', async () => {
    const w = await savedWorld();
    const { user } = renderHub(w, { path: '/settings/ladder' });
    await screen.findByRole('list', { name: 'Lengths offered' });
    await user.click(screen.getByRole('button', { name: 'Reset steps and ladder' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'ladder only');
    await user.click(within(screen.getByRole('group', { name: 'Reset steps and ladder?' })).getByRole('button', { name: 'Reset' }));
    await screen.findByText('Reset the steps and ladder.');
    expect(w.cw.profile.reporting.flow).toBe('reason_required');
    expect(w.cw.profile.durations).not.toEqual([3_600_000, 7_200_000]);
  });
});

describe('who can change it', () => {
  it('a moderator reads it: every control is off, no Save and no Reset, one plain sentence', async () => {
    const w = await hubWorld({ role: 'moderator' });
    await open(w);
    expect(screen.getByText('You can see these settings. Changing them needs permission to edit settings.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reset/ })).toBeNull();
    expect(screen.getByRole('radio', { name: 'One tap' })).toBeDisabled();
    expect(within(row('Hate')).getByLabelText('Name players see')).toBeDisabled();
    expect(screen.getByLabelText('What players read after they report')).toBeDisabled();
  });

  it('a role without policy.read gets the no-access page and nothing is asked', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'policy.read': 'owner' } });
    renderHub(w, { path: '/settings/reporting' });
    await screen.findByText('Not available for your role');
    expect(requests(w, 'GET', '/policy/profile')).toHaveLength(0);
  });
});

describe('What players see', () => {
  // The player's dialog is ONE step: the question, the line, "Why? (optional)" (a select, the reasons in groups), a door to a note,
  // Report and Cancel; then "Report sent" and the thank-you. The picture shows exactly that, in every flow.
  const OLD_STEP = ['Add a reason', 'Skip and report', 'Send report', 'Report a player', 'What happened?', 'Optional. They can add a reason and a note to the same report.'];

  it('one tap: the question, the line, "Why? (optional)" with the reasons, the note door, Report and Cancel, then "Report sent" and the thank-you', async () => {
    const w = await owner();
    await open(w);
    const m = within(mock());
    expect(m.getByText('Report this message?')).toBeInTheDocument();
    expect(m.getByText('An example message from another player')).toBeInTheDocument();
    expect(m.getByText('Why? (optional)')).toBeInTheDocument();
    expect(m.getByText('Choose a reason (optional)')).toBeInTheDocument();
    expect(m.getByText('Chat')).toBeInTheDocument();
    expect(m.getAllByRole('listitem').map((li) => li.textContent).at(-1)).toBe('Something else');
    expect(m.getByText('Add a note')).toBeInTheDocument();
    expect(m.getByText('Report', { selector: '.cw-mock-btn' })).toBeInTheDocument();
    expect(m.getByText('Cancel', { selector: '.cw-mock-btn' })).toBeInTheDocument();
    expect(m.getByText('Report sent')).toBeInTheDocument();
    expect(m.getByText("Thanks for the report. We'll look into it.")).toBeInTheDocument();
    for (const gone of OLD_STEP) expect(m.queryByText(gone), gone).toBeNull();
  });

  it('shows the parts in the order the dialog has them', async () => {
    const w = await owner();
    await open(w);
    const text = mock().textContent ?? '';
    const order = ['Report this message?', 'An example message', 'Why? (optional)', 'Choose a reason (optional)', 'Chat', 'Something else', 'Add a note', 'Report', 'Cancel', 'Report sent', "Thanks for the report"];
    let at = -1;
    for (const part of order) {
      const found = text.indexOf(part, at + 1);
      expect(found, `${part} after ${at}`).toBeGreaterThan(at);
      at = found;
    }
  });

  it('is the same one step in pick-a-reason-first (no skip), and the reasons stay by group with "Something else" last', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('radio', { name: 'Pick a reason first' }));
    const m = within(mock());
    expect(m.getByText('Why? (optional)')).toBeInTheDocument();
    expect(m.getByText('Chat')).toBeInTheDocument();
    expect(m.getByText('Gameplay')).toBeInTheDocument();
    expect(m.getAllByRole('listitem').map((li) => li.textContent).at(-1)).toBe('Something else');
    expect(m.getByText('Add a note')).toBeInTheDocument();
    for (const gone of OLD_STEP) expect(m.queryByText(gone), gone).toBeNull();
  });

  it('reason required: "Why?" with the required mark, no "(optional)", and the first option asks for a reason', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('radio', { name: 'Reason required' }));
    const m = within(mock());
    expect(m.getByText('Why?')).toBeInTheDocument();
    expect(mock().querySelector('.cw-mock-req')).not.toBeNull();
    expect(mock().querySelector('.cw-mock-req')?.getAttribute('aria-hidden')).toBe('true');
    expect(m.getByText('Choose a reason')).toBeInTheDocument();
    expect(m.queryByText('Why? (optional)')).toBeNull();
    expect(m.queryByText('Choose a reason (optional)')).toBeNull();
    expect(m.getByText('Report', { selector: '.cw-mock-btn' })).toBeInTheDocument();
    expect(m.getByText('Cancel', { selector: '.cw-mock-btn' })).toBeInTheDocument();
    // and back: the mark and the required wording go with the flow
    await user.click(screen.getByRole('radio', { name: 'One tap' }));
    expect(mock().querySelector('.cw-mock-req')).toBeNull();
    expect(within(mock()).getByText('Why? (optional)')).toBeInTheDocument();
  });

  it('optional has no required mark in any flow but reason required', async () => {
    const w = await owner();
    const { user } = await open(w);
    for (const flow of ['One tap', 'Pick a reason first']) {
      await user.click(screen.getByRole('radio', { name: flow }));
      expect(mock().querySelector('.cw-mock-req'), flow).toBeNull();
    }
  });

  it.each([['one_tap'], ['reason_first'], ['reason_required']] as const)(
    'with no reason to offer (%s) there is nothing to choose: the question, the line, Report and Cancel, no select and no note door',
    async (flow) => {
      const w = await hubWorld();
      render(
        <HubProvider client={w.client}>
          <PlayersSee draft={{ flow, reasons: [], thanks: 'Thanks.' }} />
        </HubProvider>,
      );
      const m = within(await screen.findByRole('region', { name: 'What players see' }));
      expect(m.getByText('Report this message?')).toBeInTheDocument();
      expect(m.getByText('An example message from another player')).toBeInTheDocument();
      expect(m.queryByText(/^Why\?/)).toBeNull();
      expect(m.queryByText(/^Choose a reason/)).toBeNull();
      expect(m.queryByText('Add a note')).toBeNull();
      expect(mock().querySelector('.cw-mock-req')).toBeNull();
      expect(m.queryAllByRole('listitem')).toHaveLength(0);
      expect(m.getByText('Report', { selector: '.cw-mock-btn' })).toBeInTheDocument();
      expect(m.getByText('Cancel', { selector: '.cw-mock-btn' })).toBeInTheDocument();
      expect(m.getByText('Report sent')).toBeInTheDocument();
      expect(m.getByText('Thanks.')).toBeInTheDocument();
    },
  );

  it('follows every edit at once: a rename, a switched-off reason, a new group, the thank-you', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('radio', { name: 'Pick a reason first' }));
    await user.click(within(row('Sexual content')).getByRole('checkbox', { name: 'Switched on' }));
    const hate = within(row('Hate'));
    fireEvent.change(hate.getByLabelText('Name players see'), { target: { value: 'Hate speech' } });
    fireEvent.change(hate.getByLabelText('Group (optional)'), { target: { value: 'Words' } });
    fireEvent.change(screen.getByLabelText('What players read after they report'), { target: { value: 'We have it.' } });
    const m = within(mock());
    expect(m.queryByText('Sexual content')).toBeNull();
    expect(m.getByText('Hate speech')).toBeInTheDocument();
    expect(m.getByText('Words')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'One tap' }));
    expect(within(mock()).getByText('We have it.')).toBeInTheDocument();
  });

  it('shows text, never markup, and nothing of a blank row', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('radio', { name: 'Pick a reason first' }));
    fireEvent.change(within(row('Hate')).getByLabelText('Name players see'), { target: { value: '<b>Bold</b>' } });
    await user.click(screen.getByRole('button', { name: 'Add a reason' }));
    const m = within(mock());
    expect(m.getByText('<b>Bold</b>')).toBeInTheDocument();
    expect(mock().querySelector('b')).toBeNull();
    expect(m.getAllByRole('listitem')).toHaveLength(10);
  });

  it('does not ask the server for a preview (it is drawn from the draft)', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('radio', { name: 'Reason required' }));
    await act(async () => new Promise((r) => setTimeout(r, 600)));
    expect(requests(w, 'POST', '/policy/profile/preview')).toHaveLength(0);
  });
});

describe('leaving with unsaved edits', () => {
  it('asks first, and Keep editing stays', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('radio', { name: 'Reason required' }));
    await user.click(screen.getByRole('link', { name: 'Steps and ladder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Reporting' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Reason required' })).toBeChecked();
    await user.click(screen.getByRole('link', { name: 'Steps and ladder' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', { name: 'Leave' }));
    await screen.findByRole('heading', { level: 2, name: 'Steps and ladder' });
  });
});

describe('the picture matches what players are sent (the real /rules after a save)', () => {
  /** The picture's groups, from the draft the screen was left on, read off the page. */
  const pictureOf = (): Array<{ name: string; labels: string[] }> =>
    [...mock().querySelectorAll('.cw-mock-group')].map((g) => ({ name: g.querySelector('.cw-mock-heading')?.textContent ?? '', labels: [...g.querySelectorAll('li')].map((li) => li.textContent ?? '') }));
  /** What the player dialog draws from the payload: groups in order of first appearance, "Something else" last, enabled reasons only. */
  const playerGroupsOf = (reasons: Array<{ id: string; label: string; group: string }>) => {
    const groups: Array<{ name: string; labels: string[] }> = [];
    for (const r of reasons) {
      if (r.id === 'other') continue;
      const into = groups.find((g) => g.name === r.group);
      if (into === undefined) groups.push({ name: r.group, labels: [r.label] });
      else into.labels.push(r.label);
    }
    const other = reasons.find((r) => r.id === 'other');
    if (other !== undefined) {
      const last = groups.at(-1);
      if (last !== undefined && last.name === '') last.labels.push(other.label);
      else groups.push({ name: '', labels: [other.label] });
    }
    return groups;
  };

  it.each([
    ['the defaults', async () => undefined],
    [
      'a renamed reason, a new group, one switched off and one moved',
      async (user: User) => {
        fireEvent.change(within(row('Hate')).getByLabelText('Name players see'), { target: { value: 'Hate speech' } });
        fireEvent.change(within(row('Cheating')).getByLabelText('Group (optional)'), { target: { value: 'Tricks' } });
        await user.click(within(row('Sexual content')).getByRole('checkbox', { name: 'Switched on' }));
        await user.click(within(row('Threats')).getByRole('button', { name: 'Move Threats up' }));
      },
    ],
    [
      'a new reason with no group, a group on Something else, and a reason with spaces around its group',
      async (user: User) => {
        await user.click(screen.getByRole('button', { name: 'Add a reason' }));
        const fresh = within(screen.getByRole('list', { name: 'Reasons' })).getAllByRole('listitem')[9] as HTMLElement;
        fireEvent.change(within(fresh).getByLabelText('Name players see'), { target: { value: 'Tilt' } });
        fireEvent.change(within(row('Something else')).getByLabelText('Group (optional)'), { target: { value: 'Chat' } });
        fireEvent.change(within(row('Spam or ads')).getByLabelText('Group (optional)'), { target: { value: '  Chat  ' } });
      },
    ],
  ])('%s', async (_name, edit) => {
    const w = await owner();
    const { user } = await open(w, { mode: 'detailed' });
    await user.click(screen.getByRole('radio', { name: 'Pick a reason first' }));
    await edit(user);
    const picture = pictureOf();
    await save(user, 'matching the picture');
    await screen.findByText('Saved the reporting settings.');
    expect(playerGroupsOf((await rules(w)).reasons)).toEqual(picture);
  });
});
