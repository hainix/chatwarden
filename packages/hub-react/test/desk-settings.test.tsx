import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Settings > Advanced > "The desk": three switches (staff comments and a second look, Insights, the report surge) with one sentence each,
// and the surge numbers. Off by default; the owner edits, everyone else reads; saved through the layer with a reason.

afterEach(() => cleanup());

const owner = (o: WorldOptions = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
type User = ReturnType<typeof renderHub>['user'];

const panel = (): HTMLElement => screen.getByRole('region', { name: 'The desk' });
async function open(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/advanced' });
  await screen.findByRole('heading', { level: 2, name: 'Advanced' });
  await screen.findByRole('region', { name: 'The desk' });
  return r;
}
const sw = (name: string): HTMLInputElement => within(panel()).getByRole('checkbox', { name }) as HTMLInputElement;
const num = (name: string): HTMLInputElement => within(panel()).getByLabelText(name) as HTMLInputElement;
const puts = (w: HubWorld) => w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile');
async function save(user: User, why = 'The team asked for it') {
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), why);
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
}
const WORKFLOW = 'Staff comments and asking for a second look';
const INSIGHTS = 'Insights page';
const SURGE = 'Name a report surge on a case';

describe('the panel', () => {
  it('is in Advanced and lazy; everything is off by default, each switch has one sentence, the surge numbers show the defaults', async () => {
    const { partLoaders, resetLazyParts } = await import('../src/lazyParts.js');
    resetLazyParts();
    const asked: string[] = [];
    const real = { ...partLoaders };
    (partLoaders as Record<string, () => unknown>)['deskPanel'] = () => {
      asked.push('deskPanel');
      return (real as Record<string, () => unknown>)['deskPanel']?.();
    };
    try {
      const w = await owner();
      await open(w);
      expect(asked).toEqual(['deskPanel']);
    } finally {
      Object.assign(partLoaders, real);
    }
    expect(sw(WORKFLOW).checked).toBe(false);
    expect(sw(INSIGHTS).checked).toBe(false);
    expect(sw(SURGE).checked).toBe(false);
    expect(num('Reports that make a surge').value).toBe('5');
    expect(num('Within how many minutes').value).toBe('10');
    expect(num('Accounts younger than how many days count as new').value).toBe('2');
    expect(within(panel()).getAllByText(/./, { selector: '.cw-flowopt-line' })).toHaveLength(3);
  });

  it('seniors and moderators read the values, read-only, with no save bar', async () => {
    for (const role of ['senior', 'moderator'] as const) {
      cleanup();
      const w = await hubWorld({ role, actor: `${role}@example.test`, overrides: { desk: { workflow: true, surge: { enabled: true, reports: 8 } } } });
      await open(w);
      expect(sw(WORKFLOW).checked).toBe(true);
      expect(num('Reports that make a surge').value).toBe('8');
      for (const el of within(panel()).getAllByRole('checkbox')) expect(el).toBeDisabled();
      expect(num('Reports that make a surge')).toBeDisabled();
      expect(within(panel()).queryByRole('button', { name: 'Save changes' })).toBeNull();
    }
  });
});

describe('saving', () => {
  it('saves the three switches through the layer with a reason, and the kit takes them', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(sw(WORKFLOW));
    await user.click(sw(INSIGHTS));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const body = puts(w)[0]?.body as { layer: { desk: unknown }; reason: string };
    expect(body.reason).toBe('The team asked for it');
    expect(body.layer.desk).toEqual({ workflow: true, insights: true, surge: { enabled: false, reports: 5, windowMinutes: 10, newAccountDays: 2 } });
    expect(w.cw.profile.desk).toMatchObject({ workflow: true, insights: true });
    await screen.findByText('Desk settings saved.');
  });

  it('the surge fields are edited and saved as whole numbers', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(sw(SURGE));
    await user.clear(num('Reports that make a surge'));
    await user.type(num('Reports that make a surge'), '12');
    await user.clear(num('Within how many minutes'));
    await user.type(num('Within how many minutes'), '20');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect(w.cw.profile.desk.surge).toEqual({ enabled: true, reports: 12, windowMinutes: 20, newAccountDays: 2 });
  });

  it('keeps what another screen saved', async () => {
    const w = await owner();
    w.cw.policy.save({ pace: { slowModeMs: 4000 } }, { version: 0, actor: 'x', reason: 'seed' });
    const { user } = await open(w);
    await user.click(sw(INSIGHTS));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]?.body as { layer: Record<string, unknown> }).layer['pace']).toEqual({ slowModeMs: 4000 });
  });

  it('a switch changed and changed back is not a change', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(sw(WORKFLOW));
    await user.click(sw(WORKFLOW));
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(screen.queryByRole('textbox', { name: /Why are you changing this/ })).toBeNull();
    expect(puts(w)).toHaveLength(0);
  });

  it('a conflict offers a reload, and reset brings back what the code says', async () => {
    const w = await owner({ overrides: { desk: { insights: true } } });
    w.cw.policy.save({ desk: { insights: false } }, { version: 0, actor: 'x', reason: 'seed' });
    const { user } = await open(w);
    expect(sw(INSIGHTS).checked).toBe(false);
    await user.click(within(panel()).getByRole('button', { name: 'Reset desk settings' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting/ }), 'Back to the base');
    await user.click(within(screen.getByRole('group', { name: 'Reset desk settings?' })).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(sw(INSIGHTS).checked).toBe(true));
    await user.click(sw(WORKFLOW));
    await w.clientFor('bea@example.test', 'owner').savePolicyProfile({ layer: { desk: { workflow: false } }, version: 2, reason: 'first' });
    await save(user);
    await screen.findByText('Someone else changed these settings.');
  });

  it('a refusal from the kit that names a surge field marks that field', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(sw(SURGE));
    w.intercept.fn = (req) => (req.method === 'PUT' && req.path === '/policy/profile' ? { status: 400, body: { error: 'invalid_profile', message: 'x', path: 'layer.desk.surge.reports' } } : undefined);
    await save(user);
    await waitFor(() => expect(num('Reports that make a surge')).toHaveAttribute('aria-invalid', 'true'));
  });
});

describe('the surge numbers are checked in words before anything is sent', () => {
  it.each([
    ['Reports that make a surge', '2', 'Reports must be a whole number from 3 to 100.'],
    ['Reports that make a surge', '101', 'Reports must be a whole number from 3 to 100.'],
    ['Reports that make a surge', '4.5', 'Reports must be a whole number from 3 to 100.'],
    ['Within how many minutes', '0', 'Minutes must be a whole number from 1 to 120.'],
    ['Within how many minutes', '121', 'Minutes must be a whole number from 1 to 120.'],
    ['Accounts younger than how many days count as new', '31', 'Days must be a whole number from 1 to 30.'],
    ['Accounts younger than how many days count as new', 'abc', 'Days must be a whole number from 1 to 30.'],
  ])('%s = %s', async (label, value, message) => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(sw(SURGE));
    fireEvent.change(num(label), { target: { value } });
    expect(within(panel()).getByText(message)).toBeInTheDocument();
    expect(num(label)).toHaveAttribute('aria-invalid', 'true');
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(puts(w)).toHaveLength(0);
  });

  it('the edges are accepted: 3 and 100, 1 and 120, 1 and 30', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(sw(SURGE));
    for (const [label, value] of [['Reports that make a surge', '3'], ['Reports that make a surge', '100'], ['Within how many minutes', '1'], ['Within how many minutes', '120'], ['Accounts younger than how many days count as new', '1'], ['Accounts younger than how many days count as new', '30']] as const) {
      fireEvent.change(num(label), { target: { value } });
      expect(num(label)).not.toHaveAttribute('aria-invalid');
    }
  });

  it('a switched-off surge is not checked (its numbers are not sent as typed)', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(sw(WORKFLOW));
    fireEvent.change(num('Reports that make a surge'), { target: { value: '1' } });
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
  });
});
