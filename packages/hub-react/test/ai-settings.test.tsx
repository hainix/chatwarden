import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HubProvider } from '../src/provider.js';
import { usePolicy } from '../src/policyHooks.js';
import { rulesCss } from './css.js';
import { settle } from './aiHub.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Settings > AI: Off, Read, Recommend; the status line; and one Advanced disclosure with the numbers. On the real routes and the real kit,
// with the scripted fake behind them. Only the owner can save, and a save asks why, like the ladder screen.

afterEach(() => cleanup());

const owner = (o: WorldOptions = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ai: { level: 0 }, ...o });
type User = ReturnType<typeof renderHub>['user'];

async function open(w: HubWorld, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: '/settings/ai', ...options });
  await screen.findByRole('heading', { level: 2, name: 'AI' });
  await screen.findByText(/^(Working|Off|Unavailable|Not set up on this server|Paused)/, { selector: '.cw-ai-status *, .cw-ai-status' });
  return r;
}
const level = (name: 'Off' | 'Read' | 'Recommend'): HTMLInputElement => screen.getByRole('radio', { name: new RegExp(`^${name}`) }) as HTMLInputElement;
const puts = (w: HubWorld) => w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile');
async function save(user: User, why = 'The team wants a second opinion') {
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), why);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
}
/** Answers GET /ai/status with the real answer changed. */
function status(w: HubWorld, change: (body: Record<string, unknown>) => void): void {
  w.intercept.fn = async (req) => {
    if (req.method !== 'GET' || req.path !== '/ai/status') return undefined;
    const res = await w.raw({ method: 'GET', path: req.path });
    const body = JSON.parse(JSON.stringify(res.body)) as Record<string, unknown>;
    change(body);
    return { ...res, body };
  };
}

describe('the level', () => {
  it('defaults to Off', async () => {
    const w = await owner();
    await open(w);
    expect(level('Off').checked).toBe(true);
    expect(level('Read').checked).toBe(false);
    expect(level('Recommend').checked).toBe(false);
  });

  it('shows the level that is saved', async () => {
    const w = await owner({ ai: { level: 2 } });
    await open(w);
    expect(level('Recommend').checked).toBe(true);
  });

  it('says what each does, in the words the site uses', async () => {
    const w = await owner();
    await open(w);
    expect(screen.getByText('An AI read of each report: how serious, which rule, a one-line summary and the evidence lines. It ranks the queue. People decide.')).toBeInTheDocument();
    expect(screen.getByText('It proposes the whole decision, pre-filled and marked as an AI suggestion. A moderator confirms or edits it in one click.')).toBeInTheDocument();
  });

  it('levels 3 and 4 are absent', async () => {
    const w = await owner();
    await open(w);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.queryByText(/act on clear cases|watch/i)).toBeNull();
    expect(screen.queryByRole('radio', { name: /level 3|level 4|Act|Watch/i })).toBeNull();
  });

  it('a level above what the server allows is disabled, and says so', async () => {
    const w = await owner({ ai: { level: 0 }, overrides: {} });
    await open(w);
    // The fake server in these tests allows up to level 2 (its status says so); a server that allows only Read:
    cleanup();
    status(w, (b) => {
      b['maxLevel'] = 1;
    });
    await open(w);
    expect(level('Recommend')).toBeDisabled();
    expect(level('Read')).toBeEnabled();
    expect(screen.getByText('Your server allows up to Read.')).toBeInTheDocument();
  });
});

describe('saving', () => {
  it('saving sends the whole layer with ai merged and a reason', async () => {
    const w = await owner();
    // Something else is already saved: it must come back in the layer.
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { customDuration: false }, version: state.version, reason: 'Fewer lengths' });
    const { user } = await open(w);
    await user.click(level('Read'));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const body = puts(w)[0]!.body as { layer: Record<string, unknown>; version: number; reason: string };
    expect(body.layer).toEqual({ customDuration: false, ai: { level: 1, learn: true } });
    expect(body.reason).toBe('The team wants a second opinion');
    expect(body.version).toBeGreaterThan(0);
    // The server now has it: the level in force is Read.
    expect((await w.client.policyProfile()).effective.ai.level).toBe(1);
    await screen.findByText('AI settings saved.');
  });

  it('keeps what is already saved in the ai section (the daily call ceiling)', async () => {
    const w = await owner();
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { ai: { dailyCalls: 200 } }, version: state.version, reason: 'A smaller ceiling' });
    const { user } = await open(w);
    await user.click(level('Recommend'));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: { ai: unknown } }).layer.ai).toEqual({ dailyCalls: 200, level: 2, learn: true });
  });

  it('nothing is sent until a reason is given', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(level('Read'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(puts(w)).toHaveLength(0);
    expect(screen.getByText(/Say why/i)).toBeInTheDocument();
  });

  it('Save is not offered, and nothing is dirty, until something changes; Discard puts it back', async () => {
    const w = await owner();
    const { user } = await open(w);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(level('Read'));
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'false');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(level('Off').checked).toBe(true);
  });

  it('a 409 offers to reload', async () => {
    const w = await owner();
    const { user } = await open(w);
    // Somebody else saves first.
    const other = w.clientFor('olga@example.test', 'owner');
    const state = await other.policyProfile();
    await other.savePolicyProfile({ layer: { ai: { level: 2, learn: false } }, version: state.version, reason: 'Turned it up' });
    await user.click(level('Read'));
    await save(user);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(level('Recommend').checked).toBe(true));
  });

  it('learn toggle saves through the same layer', async () => {
    const w = await owner();
    const { user } = await open(w);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    const learn = screen.getByRole('checkbox', { name: 'Learn from our decisions' });
    expect(learn).toBeChecked();
    await user.click(learn);
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: { ai: unknown } }).layer.ai).toEqual({ level: 0, learn: false });
    expect((await w.client.policyProfile()).effective.ai.learn).toBe(false);
  });

  it('a refusal from the server is shown, and the draft is kept', async () => {
    const w = await owner();
    const { user } = await open(w);
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 400, headers: {}, body: { error: 'invalid_profile', message: 'no', path: 'layer.ai.level' } } : undefined);
    await user.click(level('Read'));
    await save(user);
    await screen.findByText(/These settings aren't allowed/i);
    expect(level('Read').checked).toBe(true);
  });
});

describe('who can see and who can save', () => {
  it('only the owner can save', async () => {
    for (const role of ['moderator', 'senior'] as const) {
      cleanup();
      const w = await hubWorld({ role, actor: `${role}@example.test`, ai: { level: 1 } });
      await open(w);
      expect(level('Read').checked).toBe(true);
      for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(screen.getByText(/You can see these settings/i)).toBeInTheDocument();
    }
    cleanup();
    const w = await owner();
    await open(w);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('the section appears in the settings nav only with policy.read', async () => {
    const w = await owner();
    renderHub(w, { path: '/settings/ladder' });
    await screen.findByRole('heading', { level: 2, name: 'Steps and ladder' });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Steps and ladder', 'Reporting', 'AI']);
    cleanup();
    // A role the server does not let read the settings has no Settings, and so no AI section to reach.
    const closed = await hubWorld({ role: 'moderator', permissions: { 'policy.read': 'owner' }, ai: { level: 0 } });
    renderHub(closed, { path: '/settings/ai' });
    await settle();
    expect(screen.queryByRole('link', { name: 'AI' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('is reached from More in Simple', async () => {
    const w = await owner();
    const { user } = renderHub(w, { mode: 'simple' });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('link', { name: 'AI' }));
    await screen.findByRole('heading', { level: 2, name: 'AI' });
  });
});

describe('the status line', () => {
  it('the status line for working, paused and unavailable', async () => {
    const w = await owner({ ai: { level: 1 } });
    await open(w);
    expect(screen.getByText('Working')).toBeInTheDocument();
    cleanup();
    status(w, (b) => {
      b['state'] = 'paused_budget';
    });
    await open(w);
    expect(screen.getByText('Paused: daily limit reached, resumes 00:00 UTC')).toBeInTheDocument();
    cleanup();
    status(w, (b) => {
      b['state'] = 'unavailable';
    });
    await open(w);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    cleanup();
    status(w, (b) => {
      b['state'] = 'off';
    });
    await open(w);
    expect(screen.getByText('Off', { selector: '.cw-ai-status *' })).toBeInTheDocument();
  });

  it('a real pause: the call ceiling is reached', async () => {
    const w = await owner({ ai: { level: 1 }, overrides: { ai: { dailyCalls: 1 } } });
    await w.file();
    await w.aiIdle();
    await open(w);
    expect(screen.getByText('Paused: daily limit reached, resumes 00:00 UTC')).toBeInTheDocument();
  });

  it('controls are disabled with a pointer when no adapter is configured', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'owen@example.test' });
    await open(w);
    expect(screen.getByText('Not set up on this server')).toBeInTheDocument();
    expect(screen.getByText(/See the AI section of the Chatwarden docs/)).toBeInTheDocument();
    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled();
    expect(level('Off').checked).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('an older server with no AI routes reads as not set up, not as an error', async () => {
    const w = await owner();
    w.intercept.fn = (req) => (req.path === '/ai/status' ? { status: 404, headers: {}, body: { error: 'not_found', message: 'x' } } : undefined);
    await open(w);
    expect(screen.getByText('Not set up on this server')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a status that cannot be read says so and can be tried again; the level can still be seen', async () => {
    const w = await owner({ ai: { level: 1 } });
    let n = 0;
    w.intercept.fn = (req) => {
      if (req.path !== '/ai/status') return undefined;
      n += 1;
      return n === 1 ? { status: 500, headers: {}, body: { error: 'server', message: 'x' } } : undefined;
    };
    const { user } = renderHub(w, { path: '/settings/ai' });
    await screen.findByRole('heading', { level: 2, name: 'AI' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load the AI status/);
    expect(level('Read').checked).toBe(true);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByText('Working');
  });
});

describe('Advanced', () => {
  it('Advanced is collapsed by default and holds the numbers', async () => {
    const w = await owner({ ai: { level: 2 } });
    const f = await w.file();
    await w.aiIdle();
    await w.client.decide(f.id, { verdict: 'no_action', actions: [] });
    const { user } = await open(w);
    const toggle = screen.getByRole('button', { name: 'Advanced' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Reads today/)).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Learn from our decisions' })).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Reads today: 1 of 5,000')).toBeInTheDocument();
    expect(screen.getByText(/^Spent today: \$0\.00 of \$1\.00$/)).toBeInTheDocument();
    expect(screen.getByText('Cache hit rate')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Learn from our decisions' })).toBeChecked();
    expect(screen.getByText('Agreement with moderators')).toBeInTheDocument();
    expect(screen.getByText('Accepted in one click')).toBeInTheDocument();
    // The per-rule table and the appeals note.
    const table = screen.getByRole('table', { name: 'By rule' });
    expect(within(table).getAllByRole('row').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Granted appeals will appear here once appeals exist.')).toBeInTheDocument();
  });

  it('the cap and the adapter are read-only: said, and not a field', async () => {
    const w = await owner({ ai: { level: 1 } });
    const { user } = await open(w);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByText(/set in your server code/i)).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /cap|limit|adapter/i })).toBeNull();
  });

  it('rates with no decisions yet say so instead of 0%', async () => {
    const w = await owner({ ai: { level: 1 } });
    const { user } = await open(w);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getAllByText('Not enough decisions yet.').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('No decisions yet.')).toBeInTheDocument();
  });

  it('a role that only reads sees the numbers but cannot change learn', async () => {
    const w = await hubWorld({ role: 'senior', actor: 's@example.test', ai: { level: 1 } });
    const { user } = await open(w);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByRole('checkbox', { name: 'Learn from our decisions' })).toBeDisabled();
  });
});

describe('the four ways to adopt still render settings', () => {
  it('the provider and the usePolicy hook see the ai section (the pieces and the headless controller use the same client)', async () => {
    const w = await owner({ ai: { level: 1 } });
    function Probe() {
      const { data, canEdit } = usePolicy();
      return <p data-testid="p">{data === undefined ? 'loading' : `level ${data.effective.ai.level} learn ${String(data.effective.ai.learn)} edit ${String(canEdit)}`}</p>;
    }
    render(
      <HubProvider client={w.client}>
        <Probe />
      </HubProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('p')).toHaveTextContent('level 1 learn true edit true'));
  });

  it('the hub still shows its other two settings screens beside it', async () => {
    const w = await owner();
    renderHub(w, { path: '/settings/reporting' });
    await screen.findByRole('heading', { level: 2, name: 'Reporting' });
    cleanup();
    renderHub(w, { path: '/settings/ladder' });
    await screen.findByRole('heading', { level: 2, name: 'Steps and ladder' });
  });
});

describe('at 360 px nothing scrolls sideways', () => {
  const css = rulesCss();
  const rule = (selector: string): string =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => (m[1] as string).split(',').map((s) => s.trim()).includes(selector))
      .map((m) => m[2])
      .join(';');

  it('the status line and the table wrap, and the table scrolls inside its own box', () => {
    expect(rule('.cw-hub .cw-ai-status')).toMatch(/flex-wrap:\s*wrap|display:\s*grid/);
    expect(rule('.cw-hub .cw-flowopts')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-scroll')).toMatch(/overflow:\s*auto/);
  });

  it('the screen uses no colour of its own: the neutral tokens, and the red of nothing', () => {
    for (const s of ['.cw-hub .cw-ai-status', '.cw-hub .cw-ai-advanced', '.cw-hub .cw-ai-numbers']) expect(rule(s), s).not.toMatch(/var\(--cw-(accent|bad|warn|good)/);
  });
});
