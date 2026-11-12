import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PACE_SUGGESTIONS } from '@chatwarden/core';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Settings > Advanced > "Slow mode and flooding" (flood control and signals, design 4.8): the one door for power settings. Off by default, edited in
// seconds, saved through the same policy machinery as the other settings (a draft, a reason, a conflict offers a reload, a per-section reset).
// Only the owner edits; seniors and moderators read.

afterEach(() => cleanup());

const owner = (o: WorldOptions = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
type User = ReturnType<typeof renderHub>['user'];

async function open(w: HubWorld, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: '/settings/advanced', ...options });
  await screen.findByRole('heading', { level: 2, name: 'Advanced' });
  await screen.findByRole('region', { name: 'Slow mode and flooding' });
  return r;
}
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Slow mode and flooding' });
const sw = (name: string): HTMLInputElement => within(panel()).getByRole('checkbox', { name }) as HTMLInputElement;
const num = (name: string): HTMLInputElement => within(panel()).getByLabelText(name) as HTMLInputElement;
const puts = (w: HubWorld) => w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile');
async function type(user: User, name: string, value: string): Promise<void> {
  const el = num(name);
  await user.clear(el);
  if (value !== '') await user.type(el, value);
}
async function save(user: User, why = 'A tournament night') {
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), why);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
}

const SLOW = 'Slow mode';
const SLOW_S = 'Seconds between one player’s messages';
const BURST = 'Burst limit';
const BURST_N = 'Messages';
const BURST_S = 'Within seconds';
const REPEAT = 'Repeated messages';
const REPEAT_S = 'Seconds before the same message is allowed again';

describe('the Advanced section', () => {
  it('appears in the settings list for roles with policy.read, and is the last entry', async () => {
    const w = await owner();
    renderHub(w, { path: '/settings/ladder' });
    await screen.findByRole('heading', { level: 2, name: 'Steps and ladder' });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Steps and ladder', 'Reporting', 'AI', 'Advanced']);
  });

  it('a role without policy.read has no Advanced and cannot reach it', async () => {
    const w = await hubWorld({ role: 'moderator', actor: 'm@example.test', permissions: { 'policy.read': 'owner' } as never });
    renderHub(w, { path: '/settings/advanced' });
    await waitFor(() => expect(screen.queryByRole('heading', { level: 2, name: 'Advanced' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Slow mode and flooding' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Advanced' })).toBeNull();
  });

  it('seniors and moderators read the values, read-only, with no save bar', async () => {
    for (const role of ['moderator', 'senior'] as const) {
      cleanup();
      const w = await hubWorld({ role, actor: `${role}@example.test`, overrides: { pace: { slowModeMs: 4000 } } });
      await open(w);
      expect(sw(SLOW).checked).toBe(true);
      expect(num(SLOW_S).value).toBe('4');
      for (const el of within(panel()).getAllByRole('checkbox')) expect(el).toBeDisabled();
      for (const el of within(panel()).getAllByRole('spinbutton')) expect(el).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Use suggested values' })).toBeNull();
      expect(screen.getByText(/You can see these settings/i)).toBeInTheDocument();
    }
  });

  it('only the owner can save', async () => {
    const w = await owner();
    await open(w);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });
});

describe('the form', () => {
  it('defaults to all off, with the inputs disabled until each is switched on', async () => {
    const w = await owner();
    await open(w);
    for (const name of [SLOW, BURST, REPEAT]) expect(sw(name).checked).toBe(false);
    for (const name of [SLOW_S, BURST_N, BURST_S, REPEAT_S]) expect(num(name)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows what is in force: seconds, converted back from milliseconds', async () => {
    const w = await owner({ overrides: { pace: { slowModeMs: 2500, burst: { lines: 6, windowMs: 10_000 }, duplicateWindowMs: 15_000 } } });
    await open(w);
    expect(num(SLOW_S).value).toBe('2.5');
    expect([num(BURST_N).value, num(BURST_S).value]).toEqual(['6', '10']);
    expect(num(REPEAT_S).value).toBe('15');
    for (const name of [SLOW, BURST, REPEAT]) expect(sw(name).checked).toBe(true);
  });

  it('seconds convert to ms on save, with the whole layer, and back on load', async () => {
    const w = await owner();
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { customDuration: false }, version: state.version, reason: 'Fewer lengths' });
    const { user } = await open(w);
    await user.click(sw(SLOW));
    await type(user, SLOW_S, '3');
    await user.click(sw(BURST));
    await type(user, BURST_N, '5');
    await type(user, BURST_S, '10');
    await user.click(sw(REPEAT));
    await type(user, REPEAT_S, '15');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const body = puts(w)[0]!.body as { layer: Record<string, unknown>; reason: string; version: number };
    expect(body.layer).toEqual({ customDuration: false, pace: { slowModeMs: 3000, burst: { lines: 5, windowMs: 10_000 }, duplicateWindowMs: 15_000 } });
    expect(body.reason).toBe('A tournament night');
    expect((await w.client.policyProfile()).effective.pace).toEqual({ slowModeMs: 3000, burst: { lines: 5, windowMs: 10_000 }, duplicateWindowMs: 15_000 });
    await screen.findByText('Slow mode and flooding settings saved.');
    expect(num(SLOW_S).value).toBe('3');
  });

  it('a switched-off setting is saved as off (null), so it stays off whatever the code says', async () => {
    const w = await owner({ overrides: { pace: { slowModeMs: 2000 } } });
    const { user } = await open(w);
    await user.click(sw(SLOW));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: { pace: unknown } }).layer.pace).toEqual({ slowModeMs: null, burst: null, duplicateWindowMs: null });
    expect((await w.client.policyProfile()).effective.pace.slowModeMs).toBeNull();
  });

  it.each([
    ['slow mode below half a second', SLOW, SLOW_S, '0.2', /0\.5 to 600/],
    ['slow mode above 600 seconds', SLOW, SLOW_S, '601', /0\.5 to 600/],
    ['a burst of one message', BURST, BURST_N, '1', /2 to 100/],
    ['a burst window of 0 seconds', BURST, BURST_S, '0', /1 to 600/],
    ['a repeat window above an hour', REPEAT, REPEAT_S, '3601', /1 to 3600/],
    ['an empty value', SLOW, SLOW_S, '', /number/i],
  ])('%s shows the field error and does not save', async (_name, toggle, field, value, message) => {
    const w = await owner({ overrides: { pace: toggle === BURST ? { burst: { lines: 5, windowMs: 10_000 } } : undefined } });
    const { user } = await open(w);
    if (!sw(toggle).checked) await user.click(sw(toggle));
    if (toggle === BURST && field !== BURST_N) await type(user, BURST_N, '5');
    if (toggle === BURST && field !== BURST_S) await type(user, BURST_S, '10');
    await type(user, field, value);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await within(panel()).findByText(message)).toBeInTheDocument();
    expect(num(field)).toHaveAttribute('aria-invalid', 'true');
    expect(puts(w)).toHaveLength(0);
    expect(screen.queryByRole('textbox', { name: /Why are you changing this/ })).toBeNull();
  });

  it('whole numbers only for messages: 2.5 messages is refused', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(sw(BURST));
    await type(user, BURST_N, '2.5');
    await type(user, BURST_S, '10');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await within(panel()).findByText(/2 to 100/)).toBeInTheDocument();
    expect(puts(w)).toHaveLength(0);
  });
});

describe('suggested values', () => {
  it('"Use suggested values" fills the form for the profile preset and saves nothing', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('button', { name: 'Use suggested values' }));
    const s = PACE_SUGGESTIONS.standard;
    expect(sw(BURST).checked).toBe(true);
    expect([num(BURST_N).value, num(BURST_S).value]).toEqual([String(s.burst!.lines), String(s.burst!.windowMs / 1000)]);
    expect(num(REPEAT_S).value).toBe(String(s.duplicateWindowMs! / 1000));
    expect(sw(SLOW).checked).toBe(false);
    expect(puts(w)).toHaveLength(0);
    expect((await w.client.policyProfile()).effective.pace).toEqual({ slowModeMs: null, burst: null, duplicateWindowMs: null });
    // It is a draft like any other: Save is now offered, and Discard puts the form back.
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'false');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(sw(BURST).checked).toBe(false);
  });

  it('follows the preset: the strict profile suggests slow mode too', async () => {
    const w = await owner({ profile: 'strict' });
    const { user } = await open(w);
    await user.click(screen.getByRole('button', { name: 'Use suggested values' }));
    expect(sw(SLOW).checked).toBe(true);
    expect(num(SLOW_S).value).toBe(String(PACE_SUGGESTIONS.strict.slowModeMs! / 1000));
  });

  it('a default is never applied: with no stored settings nothing is on, and nothing is sent just by opening the page', async () => {
    const w = await owner();
    await open(w);
    expect(puts(w)).toHaveLength(0);
    expect((await w.client.policyProfile()).layer.pace).toBeUndefined();
  });
});

describe('the hints', () => {
  it('say the settings apply per process and to every room unless the game overrides a room', async () => {
    const w = await owner();
    await open(w);
    expect(within(panel()).getByText(/apply to this server process and to every room unless your game overrides a room/i)).toBeInTheDocument();
  });

  it('the built-in limit hint shows beside a burst looser than 3 per 5 seconds and not beside a tighter or equal one', async () => {
    const w = await owner();
    const { user } = await open(w);
    const hint = /built-in limit of 3 messages per 5 seconds applies first/i;
    expect(within(panel()).queryByText(hint)).toBeNull();
    await user.click(sw(BURST));
    await type(user, BURST_N, '10');
    await type(user, BURST_S, '10');
    expect(within(panel()).getByText(hint)).toBeInTheDocument();
    await type(user, BURST_N, '3');
    await type(user, BURST_S, '5');
    expect(within(panel()).queryByText(hint)).toBeNull();
    await type(user, BURST_N, '2');
    await type(user, BURST_S, '10');
    expect(within(panel()).queryByText(hint)).toBeNull();
    await type(user, BURST_N, '4');
    await type(user, BURST_S, '5');
    expect(within(panel()).getByText(hint)).toBeInTheDocument();
  });
});

describe('conflicts, refusals and reset', () => {
  it('a 409 offers to reload, and Reload shows what the other owner saved', async () => {
    const w = await owner();
    const { user } = await open(w);
    const other = w.clientFor('olga@example.test', 'owner');
    const state = await other.policyProfile();
    await other.savePolicyProfile({ layer: { pace: { slowModeMs: 9000 } }, version: state.version, reason: 'Slower' });
    await user.click(sw(REPEAT));
    await type(user, REPEAT_S, '20');
    await save(user);
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(num(SLOW_S).value).toBe('9'));
  });

  it('a refusal from the server marks the field and keeps the draft', async () => {
    const w = await owner();
    const { user } = await open(w);
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 400, headers: {}, body: { error: 'invalid_profile', message: 'no', path: 'layer.pace.burst.lines' } } : undefined);
    await user.click(sw(BURST));
    await type(user, BURST_N, '5');
    await type(user, BURST_S, '10');
    await save(user);
    await screen.findByText(/That setting isn't allowed/i);
    expect(num(BURST_N)).toHaveAttribute('aria-invalid', 'true');
    expect(num(BURST_N).value).toBe('5');
  });

  it('keeps what another screen saved: the whole layer goes back with pace merged', async () => {
    const w = await owner();
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { ai: { level: 1 } }, version: state.version, reason: 'Read on' });
    const { user } = await open(w);
    await user.click(sw(SLOW));
    await type(user, SLOW_S, '2');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: Record<string, unknown> }).layer).toEqual({ ai: { level: 1 }, pace: { slowModeMs: 2000, burst: null, duplicateWindowMs: null } });
  });

  it('reset restores the base: the saved pace goes, the other sections stay', async () => {
    const w = await owner({ overrides: { pace: { duplicateWindowMs: 9000 } } });
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { ai: { level: 1 }, pace: { slowModeMs: 5000 } }, version: state.version, reason: 'Slow' });
    const { user } = await open(w);
    expect(num(SLOW_S).value).toBe('5');
    await user.click(screen.getByRole('button', { name: 'Reset slow mode and flooding' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'Back to the code');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(sw(SLOW).checked).toBe(false));
    expect(num(REPEAT_S).value).toBe('9');
    const after = await w.client.policyProfile();
    expect(after.layer.pace).toBeUndefined();
    expect(after.layer.ai).toEqual({ level: 1 });
  });

  it('Reset is offered only when something is saved', async () => {
    const w = await owner();
    await open(w);
    expect(screen.getByRole('button', { name: 'Reset slow mode and flooding' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Simple mode', () => {
  it('has no new entry in its menu: Settings is reached as before, and the Advanced screen opens there too', async () => {
    const w = await owner();
    const r = renderHub(w, { path: '/', mode: 'simple' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).toBeNull());
    expect(r.container.textContent).not.toMatch(/Slow mode|flooding|Advanced/);
    cleanup();
    renderHub(w, { path: '/settings/advanced', mode: 'simple' });
    expect(await screen.findByRole('region', { name: 'Slow mode and flooding' })).toBeInTheDocument();
  });
});
