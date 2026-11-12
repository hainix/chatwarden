import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { appealsHub } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import type { WorldOptions } from './world.js';

// Settings > Advanced > "Appeals" (appeals, design 4.9): on or off, how many a player may file a week, whether the person who made a decision may decide its
// appeal, the statement limit (read only), and "Mistakes by rule" behind a disclosure. The same machinery as the other panels: a draft, a reason, a
// conflict offers a reload, a per-section reset. Only the owner edits; seniors and moderators read.

afterEach(() => cleanup());

const owner = (o: Parameters<typeof appealsHub>[0] = {}) => appealsHub({ role: 'owner', actor: 'owen@example.test', appeals: false, ...o });
type User = ReturnType<typeof renderHub>['user'];

async function open(w: AppealsHub, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: '/settings/advanced', ...options });
  await screen.findByRole('heading', { level: 2, name: 'Advanced' });
  await screen.findByRole('region', { name: 'Appeals' });
  return r;
}
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Appeals' });
const ON = 'Let players appeal their sanctions';
const LIMIT = 'How many a player may file a week';
const SELF = 'Allow the moderator who made the decision to decide it';
const sw = (name: string): HTMLInputElement => within(panel()).getByRole('checkbox', { name }) as HTMLInputElement;
const limit = (): HTMLInputElement => within(panel()).getByLabelText(LIMIT) as HTMLInputElement;
const puts = (w: AppealsHub) => w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile');
async function typeLimit(user: User, value: string): Promise<void> {
  await user.clear(limit());
  if (value !== '') await user.type(limit(), value);
}
async function save(user: User, why = 'Players asked for it') {
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), why);
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
}

describe('who sees it and who edits', () => {
  it('is a panel of Advanced, after the others', async () => {
    const w = await owner();
    await open(w);
    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label') ?? within(r).queryByRole('heading')?.textContent);
    expect(names).toContain('Slow mode and flooding');
    expect(names.indexOf('Appeals')).toBeGreaterThan(names.indexOf('Slow mode and flooding'));
  });

  it('only the owner can save; seniors and moderators read the values, read-only, with no save bar', async () => {
    for (const role of ['moderator', 'senior'] as const) {
      cleanup();
      const w = await appealsHub({ role, actor: `${role}@example.test`, appeals: { perPlayerPerWeek: 5 } });
      await open(w);
      expect(sw(ON).checked).toBe(true);
      expect(limit().value).toBe('5');
      for (const el of within(panel()).getAllByRole('checkbox')) expect(el).toBeDisabled();
      expect(limit()).toBeDisabled();
      expect(within(panel()).queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(within(panel()).getByText(/You can see these settings/i)).toBeInTheDocument();
    }
    cleanup();
    const w = await owner();
    await open(w);
    expect(within(panel()).getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });
});

describe('the form', () => {
  it('defaults to off, with the limit at 3, self review off, and nothing sent just by opening the page', async () => {
    const w = await owner();
    await open(w);
    expect(sw(ON).checked).toBe(false);
    expect(limit().value).toBe('3');
    expect(sw(SELF).checked).toBe(false);
    expect(limit()).toBeDisabled();
    expect(within(panel()).getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'true');
    expect(puts(w)).toHaveLength(0);
    expect((await w.client.policyProfile()).layer.appeals).toBeUndefined();
  });

  it('shows what is in force', async () => {
    const w = await owner({ appeals: { perPlayerPerWeek: 7, allowSelfReview: true } });
    await open(w);
    expect([sw(ON).checked, limit().value, sw(SELF).checked]).toEqual([true, '7', true]);
  });

  it('states the statement limit, read only', async () => {
    const w = await owner();
    await open(w);
    expect(within(panel()).getByText('A statement can be up to 1,000 characters. This limit is fixed.')).toBeInTheDocument();
  });

  it('saving sends the whole layer with appeals merged and a reason, and the server then reads it back', async () => {
    const w = await owner();
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { ai: { level: 1 } }, version: state.version, reason: 'Read on' });
    const { user } = await open(w);
    await user.click(sw(ON));
    await typeLimit(user, '5');
    await user.click(sw(SELF));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const body = puts(w)[0]!.body as { layer: Record<string, unknown>; reason: string };
    expect(body.layer).toEqual({ ai: { level: 1 }, appeals: { enabled: true, perPlayerPerWeek: 5, allowSelfReview: true } });
    expect(body.reason).toBe('Players asked for it');
    expect((await w.client.policyProfile()).effective.appeals).toEqual({ enabled: true, perPlayerPerWeek: 5, allowSelfReview: true });
    await screen.findByText('Appeals settings saved.');
  });

  it('turning it off saves enabled false and keeps the other two', async () => {
    const w = await owner({ appeals: { perPlayerPerWeek: 4 } });
    const { user } = await open(w);
    await user.click(sw(ON));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: { appeals: unknown } }).layer.appeals).toEqual({ enabled: false, perPlayerPerWeek: 4, allowSelfReview: false });
  });

  it.each([
    ['0', '0'],
    ['21', '21'],
    ['a fraction', '2.5'],
    ['a negative', '-1'],
    ['empty', ''],
    ['words', 'three'],
  ])('the weekly limit validates 1 to 20: %s is refused and nothing is sent', async (_name, value) => {
    const w = await owner({ appeals: { enabled: true, perPlayerPerWeek: 5 } });
    const { user } = await open(w);
    await typeLimit(user, value);
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(await within(panel()).findByText('Enter a whole number from 1 to 20.')).toBeInTheDocument();
    expect(limit()).toHaveAttribute('aria-invalid', 'true');
    expect(puts(w)).toHaveLength(0);
    expect(screen.queryByRole('textbox', { name: /Why are you changing this/ })).toBeNull();
  });

  it.each(['99', '0', '', 'three', '2.5'])('a bad weekly limit (%j) does not hold the form once appeals are switched off: it saves enabled false with the limit in force', async (value) => {
    const w = await owner({ appeals: { enabled: true, perPlayerPerWeek: 5, allowSelfReview: true } });
    const { user } = await open(w);
    await typeLimit(user, value);
    await user.click(sw(ON));
    expect(sw(ON).checked).toBe(false);
    expect(limit()).toBeDisabled();
    // the field is disabled, so it must not be a dead end: no error, and Save goes through
    expect(within(panel()).queryByText('Enter a whole number from 1 to 20.')).toBeNull();
    expect(limit()).not.toHaveAttribute('aria-invalid');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: { appeals: unknown } }).layer.appeals).toEqual({ enabled: false, perPlayerPerWeek: 5, allowSelfReview: true });
    expect((await w.client.policyProfile()).effective.appeals).toEqual({ enabled: false, perPlayerPerWeek: 5, allowSelfReview: true });
  });

  it('switching appeals back on brings the error back, and Save is held again', async () => {
    const w = await owner({ appeals: { enabled: true, perPlayerPerWeek: 5 } });
    const { user } = await open(w);
    await typeLimit(user, '99');
    await user.click(sw(ON));
    await user.click(sw(ON));
    expect(sw(ON).checked).toBe(true);
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(await within(panel()).findByText('Enter a whole number from 1 to 20.')).toBeInTheDocument();
    expect(puts(w)).toHaveLength(0);
  });

  it('a limit that is already off and untouched saves nothing new, and an untouched bad draft with appeals off is not dirty', async () => {
    const w = await owner({ appeals: { enabled: true, perPlayerPerWeek: 5 } });
    const { user } = await open(w);
    await typeLimit(user, '99');
    await user.click(sw(ON));
    await user.click(sw(ON));
    await typeLimit(user, '5');
    // back to what is in force: nothing to save
    expect(within(panel()).getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'true');
  });

  it.each(['1', '20', '10'])('%s is accepted', async (value) => {
    const w = await owner({ appeals: { enabled: true, perPlayerPerWeek: 5 } });
    const { user } = await open(w);
    await typeLimit(user, value);
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: { appeals: { perPlayerPerWeek: number } } }).layer.appeals.perPlayerPerWeek).toBe(Number(value));
  });

  it('Discard puts the form back to what is in force', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(sw(ON));
    await user.click(within(panel()).getByRole('button', { name: 'Discard changes' }));
    expect(sw(ON).checked).toBe(false);
  });
});

describe('conflicts, refusals and reset', () => {
  it('a 409 offers to reload, and Reload shows what the other owner saved', async () => {
    const w = await owner();
    const { user } = await open(w);
    const other = w.clientFor('olga@example.test', 'owner');
    const state = await other.policyProfile();
    await other.savePolicyProfile({ layer: { appeals: { enabled: true, perPlayerPerWeek: 9 } }, version: state.version, reason: 'Open the doors' });
    await user.click(sw(SELF));
    await save(user);
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(limit().value).toBe('9'));
    expect(sw(ON).checked).toBe(true);
  });

  it('a refusal from the server marks the field and keeps the draft', async () => {
    const w = await owner({ appeals: { enabled: true } });
    const { user } = await open(w);
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 400, headers: {}, body: { error: 'invalid_profile', message: 'no', path: 'layer.appeals.perPlayerPerWeek' } } : undefined);
    await typeLimit(user, '5');
    await save(user);
    await screen.findByText(/That setting isn't allowed/i);
    expect(limit()).toHaveAttribute('aria-invalid', 'true');
    expect(limit().value).toBe('5');
  });

  it('reset restores the base: the saved appeals go, the other sections stay', async () => {
    const w = await owner({ appeals: { enabled: true, perPlayerPerWeek: 2 } });
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { ai: { level: 1 }, appeals: { perPlayerPerWeek: 8 } }, version: state.version, reason: 'More' });
    const { user } = await open(w);
    expect(limit().value).toBe('8');
    await user.click(screen.getByRole('button', { name: 'Reset appeals' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'Back to the code');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(limit().value).toBe('2'));
    const after = await w.client.policyProfile();
    expect(after.layer.appeals).toBeUndefined();
    expect(after.layer.ai).toEqual({ level: 1 });
  });

  it('Reset is offered only when something is saved', async () => {
    const w = await owner();
    await open(w);
    expect(screen.getByRole('button', { name: 'Reset appeals' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Mistakes by rule', () => {
  const disclosure = (): HTMLElement => within(panel()).getByRole('button', { name: 'Mistakes by rule' });
  const table = (): HTMLElement => within(panel()).getByRole('table', { name: 'Mistakes by rule' });
  const row = (rule: string): HTMLElement => within(table()).getByRole('row', { name: new RegExp(`^${rule}\\b`) });

  /** `n` sanctions under rule 2, each appealed; the first `revoked` of them are removed on appeal and the next `lighter` made lighter. */
  async function mistakes(n: number, revoked: number, lighter = 0, o: WorldOptions = {}) {
    const w = await appealsHub({ role: 'owner', actor: 'owen@example.test', ...o });
    const a = [];
    for (let i = 0; i < n; i += 1) a.push(await w.appeal({ target: `Player${i}`, rule: 2 }));
    const judge = w.clientFor('senior@example.test', 'senior');
    for (let i = 0; i < revoked; i += 1) await judge.decideAppeal((a[i] as (typeof a)[number]).appealId, { outcome: 'revoke', reason: 'a mistake' });
    for (let i = revoked; i < revoked + lighter; i += 1) await judge.decideAppeal((a[i] as (typeof a)[number]).appealId, { outcome: 'reduce', reason: 'too long', to: { kind: 'warning', durationMs: null } });
    return w;
  }

  it('is collapsed by default: nothing is asked of the server until it is opened', async () => {
    const w = await mistakes(1, 0);
    await open(w);
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(within(panel()).queryByRole('table')).toBeNull();
    expect(w.sent.filter((r) => r.path === '/appeals/stats')).toEqual([]);
  });

  it('shows the table with bands as words, and no number outside the table', async () => {
    const w = await mistakes(10, 1);
    const { user } = await open(w);
    await user.click(disclosure());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    await within(panel()).findByRole('table', { name: 'Mistakes by rule' });
    const cells = within(row('Rule 2')).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['Rule 2', '10', '10', '1', '0', 'usually fine']);
    expect(within(table()).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Rule', 'Sanctions', 'Appealed', 'Removed on appeal', 'Made lighter on appeal', 'How often it is reversed']);
    // Outside the table there are words only: no count, no rate, no percentage.
    const region = disclosure().closest('.cw-appeal-mistakes') as HTMLElement;
    const copy = region.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('table').forEach((x) => x.remove());
    expect(copy.textContent).not.toMatch(/\d/);
    expect(region.textContent).not.toMatch(/%/);
    expect(w.sent.filter((r) => r.path === '/appeals/stats')).toHaveLength(1);
  });

  it.each([
    [1, 'usually fine'],
    [2, 'often reversed'],
    [3, 'frequently reversed'],
    [5, 'frequently reversed'],
  ])('%s removed of 10 reads "%s"', async (revoked, words) => {
    const w = await mistakes(10, revoked);
    const { user } = await open(w);
    await user.click(disclosure());
    await within(panel()).findByRole('table');
    expect(within(row('Rule 2')).getAllByRole('cell')[5]).toHaveTextContent(words);
    expect(within(row('Rule 2')).getAllByRole('cell')[3]).toHaveTextContent(String(revoked));
  });

  it('a null rate reads "not enough decisions yet"', async () => {
    const w = await mistakes(3, 1);
    const { user } = await open(w);
    await user.click(disclosure());
    await within(panel()).findByRole('table');
    expect(within(row('Rule 2')).getAllByRole('cell')[5]).toHaveTextContent('not enough decisions yet');
  });

  it('the made-lighter column shows reduces and does not change the band', async () => {
    const plain = await mistakes(10, 1);
    const a = renderHub(plain, { path: '/settings/advanced' });
    await screen.findByRole('region', { name: 'Appeals' });
    await a.user.click(disclosure());
    await within(panel()).findByRole('table');
    const band = within(row('Rule 2')).getAllByRole('cell')[5]?.textContent;
    cleanup();
    const lighter = await mistakes(10, 1, 4);
    const { user } = await open(lighter);
    await user.click(disclosure());
    await within(panel()).findByRole('table');
    const cells = within(row('Rule 2')).getAllByRole('cell').map((c) => c.textContent);
    expect(cells[3]).toBe('1');
    expect(cells[4]).toBe('4');
    expect(cells[5]).toBe(band);
  });

  it('no colour class carries a band', async () => {
    const w = await mistakes(10, 5);
    const { user } = await open(w);
    await user.click(disclosure());
    await within(panel()).findByRole('table');
    const region = disclosure().closest('.cw-appeal-mistakes') as HTMLElement;
    expect(region.querySelectorAll('[class*="--bad"], [class*="--warn"], [class*="--good"], [class*="--accent"], .cw-tag').length).toBe(0);
  });

  it('a role that holds policy.read but not appeals.read sees the panel without the disclosure: no endless Loading, nothing asked', async () => {
    const w = await appealsHub({ role: 'senior', actor: 'bea@example.test', permissions: { 'appeals.read': 'owner' } });
    await open(w);
    expect(within(panel()).queryByRole('button', { name: 'Mistakes by rule' })).toBeNull();
    expect(within(panel()).queryByText(/Loading/)).toBeNull();
    expect(w.sent.filter((r) => r.path === '/appeals/stats')).toEqual([]);
    // the rest of the panel is there, read-only
    expect(sw(ON).checked).toBe(true);
  });

  it('with appeals.read the disclosure is there, for the owner and for a senior', async () => {
    for (const role of ['owner', 'senior'] as const) {
      cleanup();
      const w = await appealsHub({ role, actor: `${role}@example.test` });
      await open(w);
      expect(disclosure()).toBeInTheDocument();
    }
  });

  it('with appeals off it says so and asks for nothing', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(disclosure());
    expect(await within(panel()).findByText('Appeals are off, so there is nothing to show yet.')).toBeInTheDocument();
    expect(w.sent.filter((r) => r.path === '/appeals/stats')).toEqual([]);
  });

  it('with none filed it says so', async () => {
    const w = await appealsHub({ role: 'owner', actor: 'owen@example.test' });
    const { user } = await open(w);
    await user.click(disclosure());
    expect(await within(panel()).findByText('No sanctions or appeals in this time yet.')).toBeInTheDocument();
  });

  it('a failed read says so and offers to try again; seniors and moderators read it too', async () => {
    const w = await mistakes(10, 1, 0, { role: 'senior', actor: 'bea@example.test' });
    const { user } = await open(w);
    w.intercept.fn = (req) => (req.path === '/appeals/stats' ? { status: 500, headers: {}, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(disclosure());
    const alert = await within(panel()).findByRole('alert');
    w.intercept.fn = null;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(panel()).findByRole('table')).toBeInTheDocument();
  });

  it('Rule gaps are named in words for a rule that no rule covers', async () => {
    const w = await appealsHub({ role: 'owner', actor: 'owen@example.test' });
    await w.appeal({ rule: 2 });
    const { user } = await open(w);
    await user.click(disclosure());
    await within(panel()).findByRole('table');
    expect(within(table()).getByRole('row', { name: /^Rule 2/ })).toBeInTheDocument();
  });
});

describe('Simple mode', () => {
  it('has no new menu entry: Advanced opens as before', async () => {
    const w = await owner();
    const r = renderHub(w, { path: '/', mode: 'simple' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).toBeNull());
    expect(r.container.textContent).not.toMatch(/Appeals \(|mistakes/i);
    cleanup();
    renderHub(w, { path: '/settings/advanced', mode: 'simple' });
    expect(await screen.findByRole('region', { name: 'Appeals' })).toBeInTheDocument();
  });
});
