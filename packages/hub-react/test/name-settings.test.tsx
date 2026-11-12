import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { appealsHub } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import type { WorldOptions } from './world.js';

// Settings > Advanced > "Names" (names, design 5.6): four switches with one sentence each, each saved through the layer with a reason. Only the owner edits;
// seniors and moderators read. A name the word list refuses is refused whatever these say: they add to that.

afterEach(() => cleanup());

const owner = (o: WorldOptions & { names?: Record<string, unknown> } = {}) => appealsHub({ role: 'owner', actor: 'owen@example.test', ...o });
type User = ReturnType<typeof renderHub>['user'];

async function open(w: AppealsHub, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: '/settings/advanced', ...options });
  await screen.findByRole('heading', { level: 2, name: 'Advanced' });
  await screen.findByRole('region', { name: 'Names' });
  return r;
}
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Names' });
const PROFANITY = 'Also check names for swearing';
const KEEP = 'Keep blocked names as evidence';
const RENAMES = 'Let moderators ask a player for a new name';
const MASK = 'Hide flagged names until shown';
const sw = (name: string): HTMLInputElement => within(panel()).getByRole('checkbox', { name }) as HTMLInputElement;
const puts = (w: AppealsHub) => w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile');
async function save(user: User, why = 'Our game is for families') {
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), why);
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
}

describe('the panel', () => {
  it('shows four switches, each with one sentence, after the Appeals panel', async () => {
    const w = await owner();
    await open(w);
    expect(within(panel()).getAllByRole('checkbox').map((c) => c.getAttribute('aria-labelledby') !== null)).toEqual([true, true, true, true]);
    for (const name of [PROFANITY, KEEP, RENAMES, MASK]) expect(sw(name)).toBeInTheDocument();
    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label') ?? within(r).queryByRole('heading')?.textContent);
    expect(names.indexOf('Names')).toBeGreaterThan(names.indexOf('Appeals'));
  });

  it('defaults: swearing off, keeping off, renames off, and hiding flagged names ON; nothing is sent by opening it', async () => {
    const w = await owner();
    await open(w);
    expect([sw(PROFANITY).checked, sw(KEEP).checked, sw(RENAMES).checked, sw(MASK).checked]).toEqual([false, false, false, true]);
    expect(puts(w)).toHaveLength(0);
    expect((await w.client.policyProfile()).layer.names).toBeUndefined();
  });

  it('shows what is in force', async () => {
    const w = await owner({ names: { profanity: true, keepBlocked: true, renames: true, maskInHub: false } });
    await open(w);
    expect([sw(PROFANITY).checked, sw(KEEP).checked, sw(RENAMES).checked, sw(MASK).checked]).toEqual([true, true, true, false]);
  });

  it('keepBlocked states the retention in words', async () => {
    const w = await owner();
    await open(w);
    expect(within(panel()).getByText(/for 30 days unless your server sets another time/)).toBeInTheDocument();
  });

  it('only the owner edits: seniors and moderators read the values, read-only, with no save bar', async () => {
    for (const role of ['moderator', 'senior'] as const) {
      cleanup();
      const w = await appealsHub({ role, actor: `${role}@example.test`, names: { renames: true } });
      await open(w);
      expect(sw(RENAMES).checked).toBe(true);
      for (const el of within(panel()).getAllByRole('checkbox')) expect(el).toBeDisabled();
      expect(within(panel()).queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(within(panel()).getByText(/You can see these settings/i)).toBeInTheDocument();
    }
  });
});

describe('saving', () => {
  it.each([
    [PROFANITY, { profanity: true, keepBlocked: false, renames: false, maskInHub: true }],
    [KEEP, { profanity: false, keepBlocked: true, renames: false, maskInHub: true }],
    [RENAMES, { profanity: false, keepBlocked: false, renames: true, maskInHub: true }],
    [MASK, { profanity: false, keepBlocked: false, renames: false, maskInHub: false }],
  ])('each switch is saved through the layer with a reason: %s', async (name, names) => {
    const w = await owner();
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { ai: { level: 1 } }, version: state.version, reason: 'Read on' });
    const { user } = await open(w);
    await user.click(sw(name));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const body = puts(w)[0]!.body as { layer: Record<string, unknown>; reason: string };
    expect(body.layer).toEqual({ ai: { level: 1 }, names });
    expect(body.reason).toBe('Our game is for families');
    expect((await w.client.policyProfile()).effective.names).toEqual(names);
    await screen.findByText('Names settings saved.');
  });

  it('several switches in one save', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(sw(PROFANITY));
    await user.click(sw(KEEP));
    await user.click(sw(RENAMES));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: { names: unknown } }).layer.names).toEqual({ profanity: true, keepBlocked: true, renames: true, maskInHub: true });
  });

  it('turning one on and back off is no change: nothing to save', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(sw(RENAMES));
    await user.click(sw(RENAMES));
    expect(within(panel()).getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('turning renames on makes the server offer the rename (features.renames follows)', async () => {
    const w = await owner();
    expect((await w.client.me()).features).toEqual({ appeals: true, renames: false, keepBlocked: false });
    const { user } = await open(w);
    await user.click(sw(RENAMES));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    await waitFor(async () => expect((await w.client.me()).features).toEqual({ appeals: true, renames: true, keepBlocked: false }));
  });

  it('a 409 offers to reload, and Reload shows what the other owner saved', async () => {
    const w = await owner();
    const { user } = await open(w);
    const other = w.clientFor('olga@example.test', 'owner');
    const state = await other.policyProfile();
    await other.savePolicyProfile({ layer: { names: { keepBlocked: true } }, version: state.version, reason: 'Evidence' });
    await user.click(sw(PROFANITY));
    await save(user);
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(sw(KEEP).checked).toBe(true));
  });

  it('a refusal from the server keeps the draft', async () => {
    const w = await owner();
    const { user } = await open(w);
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 400, headers: {}, body: { error: 'invalid_profile', message: 'no', path: 'layer.names' } } : undefined);
    await user.click(sw(PROFANITY));
    await save(user);
    await screen.findByText(/aren't allowed|isn't allowed/i);
    expect(sw(PROFANITY).checked).toBe(true);
  });

  it('reset restores the base: the saved names go, the other sections stay', async () => {
    const w = await owner();
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { ai: { level: 1 }, names: { renames: true } }, version: state.version, reason: 'Renames' });
    const { user } = await open(w);
    expect(sw(RENAMES).checked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Reset names' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'Back to the code');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(sw(RENAMES).checked).toBe(false));
    const after = await w.client.policyProfile();
    expect(after.layer.names).toBeUndefined();
    expect(after.layer.ai).toEqual({ level: 1 });
  });

  it('Reset is offered only when something is saved', async () => {
    const w = await owner();
    await open(w);
    expect(screen.getByRole('button', { name: 'Reset names' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Simple mode', () => {
  it('gets nothing new from names: no menu entry, and the panel is reached through Advanced as before', async () => {
    const w = await owner();
    const r = renderHub(w, { path: '/', mode: 'simple' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).toBeNull());
    expect(r.container.textContent).not.toMatch(/swearing|flagged names|new name/i);
    cleanup();
    renderHub(w, { path: '/settings/advanced', mode: 'simple' });
    expect(await screen.findByRole('region', { name: 'Names' })).toBeInTheDocument();
  });
});
