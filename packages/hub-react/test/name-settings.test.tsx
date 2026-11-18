import { cleanup, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
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
    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label') ?? within(r).queryAllByRole('heading')[0]?.textContent);
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
    expect((await w.client.policyProfile()).effective.names).toMatchObject(names);
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

const PROTECTED = 'Protected names';
const ALLOWED = 'Allowed exceptions';
const lists = (): { protectedBox: HTMLTextAreaElement; allowedBox: HTMLTextAreaElement } => ({
  protectedBox: within(panel()).getByRole('textbox', { name: PROTECTED }) as HTMLTextAreaElement,
  allowedBox: within(panel()).getByRole('textbox', { name: ALLOWED }) as HTMLTextAreaElement,
});

describe('the two lists of protected names', () => {
  it('are two textareas inside the existing panel, empty by default, each with a sentence, and nothing is sent by opening them', async () => {
    const w = await owner();
    await open(w);
    const { protectedBox, allowedBox } = lists();
    expect(protectedBox.value).toBe('');
    expect(allowedBox.value).toBe('');
    expect(protectedBox).toHaveAccessibleDescription(/one name per line/i);
    expect(allowedBox).toHaveAccessibleDescription(/one name per line/i);
    expect(within(panel()).getAllByRole('checkbox')).toHaveLength(4);
    expect(puts(w)).toHaveLength(0);
  });

  it('say what a dry run changes: nothing a player already has, only names checked from now on', async () => {
    const w = await owner();
    await open(w);
    expect(within(panel()).getByText(/names that players already have are not changed/i)).toBeInTheDocument();
  });

  it('show what is in force, one name to a line', async () => {
    const w = await owner({ names: { reserved: ['admin', 'game master'], reservedAllow: ['Admin Ann'] } });
    await open(w);
    const { protectedBox, allowedBox } = lists();
    expect(protectedBox.value).toBe('admin\ngame master');
    expect(allowedBox.value).toBe('Admin Ann');
  });

  it('are saved through the layer with a reason: the lines become the lists, trimmed, blanks dropped', async () => {
    const w = await owner();
    const { user } = await open(w);
    const { protectedBox, allowedBox } = lists();
    await user.type(protectedBox, '  admin  {Enter}{Enter}game master{Enter}   ');
    await user.type(allowedBox, 'Admin Ann');
    await save(user, 'Staff names are protected');
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const body = puts(w)[0]!.body as { layer: { names: Record<string, unknown> }; reason: string };
    expect(body.layer.names).toEqual({ profanity: false, keepBlocked: false, renames: false, maskInHub: true, reserved: ['admin', 'game master'], reservedAllow: ['Admin Ann'] });
    expect(body.reason).toBe('Staff names are protected');
    const effective = (await w.client.policyProfile()).effective.names;
    expect(effective).toMatchObject({ reserved: ['admin', 'game master'], reservedAllow: ['Admin Ann'], reservedRule: 2 });
    await screen.findByText('Names settings saved.');
  });

  it('a switch saved alone sends no list (the layer is what it was), and a saved list is kept when a switch changes', async () => {
    const w = await owner({ names: { reserved: ['admin'] } });
    const { user } = await open(w);
    await user.click(sw(RENAMES));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: { names: Record<string, unknown> } }).layer.names).toMatchObject({ renames: true, reserved: ['admin'] });
    cleanup();
    const other = await owner();
    const second = await open(other);
    await second.user.click(sw(MASK));
    await save(second.user);
    await waitFor(() => expect(puts(other)).toHaveLength(1));
    const names = (puts(other)[0]!.body as { layer: { names: Record<string, unknown> } }).layer.names;
    expect(Object.hasOwn(names, 'reserved')).toBe(false);
    expect(Object.hasOwn(names, 'reservedAllow')).toBe(false);
  });

  it('clearing a saved list saves an empty one', async () => {
    const w = await owner({ names: { reserved: ['admin'] } });
    const { user } = await open(w);
    await user.clear(lists().protectedBox);
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: { names: Record<string, unknown> } }).layer.names).toMatchObject({ reserved: [] });
    expect((await w.client.policyProfile()).effective.names.reserved).toEqual([]);
  });

  it('typing and deleting the same text is no change: nothing to save', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.type(lists().protectedBox, 'admin');
    await user.clear(lists().protectedBox);
    expect(within(panel()).getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('an entry the server refuses (too short) keeps the draft', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.type(lists().protectedBox, 'x');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    await screen.findByRole('alert');
    expect(lists().protectedBox.value).toBe('x');
  });

  it('only the owner edits them: seniors and moderators read them, read-only', async () => {
    for (const role of ['moderator', 'senior'] as const) {
      cleanup();
      const w = await appealsHub({ role, actor: `${role}@example.test`, names: { reserved: ['admin'] } });
      await open(w);
      const { protectedBox, allowedBox } = lists();
      expect(protectedBox.value).toBe('admin');
      expect(protectedBox).toBeDisabled();
      expect(allowedBox).toBeDisabled();
      expect(within(panel()).queryByRole('button', { name: 'Save changes' })).toBeNull();
    }
  });

  it('the Names reset takes the lists back to the code', async () => {
    const w = await owner();
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { names: { reserved: ['admin'] } }, version: state.version, reason: 'Staff names' });
    const { user } = await open(w);
    expect(lists().protectedBox.value).toBe('admin');
    await user.click(screen.getByRole('button', { name: 'Reset names' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'Back to the code');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(lists().protectedBox.value).toBe(''));
  });

  it('a name is text: markup in an entry is never made into markup', async () => {
    const w = await owner({ names: { reserved: ['<img src=x onerror=alert(1)>'] } });
    const { container } = await open(w);
    expect(lists().protectedBox.value).toBe('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('has no axe violations in the light and the dark theme', async () => {
    for (const theme of ['light', 'dark'] as const) {
      cleanup();
      const w = await owner({ names: { reserved: ['admin'] } });
      const { container } = await open(w, { theme });
      const found = (await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] })).violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
      expect(found, theme).toEqual([]);
    }
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
