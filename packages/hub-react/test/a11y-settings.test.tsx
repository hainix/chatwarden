import { cleanup, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { MemoryStore, withMemoryAi, withMemorySignals } from '@chatwarden/store-memory';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The Steps and ladder screen, the length pickers and the quick warning under axe, in both themes and in each state a moderator
// meets: the screen, a custom length with its message, the save and reset questions, a refusal, the leave question, a role that
// only reads, and the Simple card. jsdom paints no colours, so `color-contrast` is off here; the stylesheet's contrast is computed
// from its tokens by the static tests (the screen adds no colour token of its own).
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

describe.each(['light', 'dark'] as const)('axe on steps and ladder, %s theme', (theme) => {
  async function open(w: HubWorld) {
    const r = renderHub(w, { theme, path: '/settings/ladder' });
    await screen.findByRole('list', { name: 'Lengths offered' });
    await screen.findByRole('region', { name: 'Preview of suggestions' }, { timeout: 4000 });
    return r;
  }

  it('the screen has no violations', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container } = await open(w);
    expect(await violations(container)).toEqual([]);
  });

  it('a custom length with its message, and a length that was refused, have none', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container, user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Step 3, lighter: how long'), 'Custom length');
    expect(screen.getByText('Enter a length, such as 6 and hours.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Enter a length, such as 6 and hours.', { selector: 'p' })).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('the save question, a refusal from the kit and the conflict message have none', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container, user } = await open(w);
    await user.selectOptions(screen.getByLabelText('Severe: what happens'), 'No action');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await violations(container)).toEqual([]);
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'x');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText("That setting isn't allowed.");
    expect(await violations(container)).toEqual([]);
    await user.selectOptions(screen.getByLabelText('Severe: what happens'), 'Chat restriction');
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await w.clientFor('bea@example.test', 'owner').savePolicyProfile({ layer: { customDuration: false }, version: 0, reason: 'first' });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Someone else changed these settings.');
    expect(await violations(container)).toEqual([]);
  });

  it('the reset question and the leave question have none', async () => {
    const w = await hubWorld({ role: 'owner' });
    w.cw.policy.save({ durations: [3_600_000] }, { version: 0, actor: 'x', reason: 'seed' });
    const { container, user } = await open(w);
    await user.click(screen.getByRole('button', { name: 'Reset lengths' }));
    await user.click(within(screen.getByRole('group', { name: 'Reset lengths?' })).getByRole('button', { name: 'Reset' }));
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Keep my settings' }));
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    await user.click(screen.getByRole('link', { name: 'Audit' }));
    await screen.findByRole('dialog', { name: 'Leave without saving?' });
    expect(await violations(container)).toEqual([]);
  });

  it('a role that only reads, and a store that cannot save, have none', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const { container } = await open(w);
    expect(await violations(container)).toEqual([]);
  });
});

describe.each(['light', 'dark'] as const)('axe on the pickers and the quick warning, %s theme', (theme) => {
  it('the Simple card with Send a warning has no violations', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.fileRich({});
    const { container } = renderHub(w, { theme, path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByRole('button', { name: /^Send a warning/ });
    expect(await violations(container)).toEqual([]);
  });

  it('Something else with a custom length and its message has none', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.fileRich({});
    const { container, user } = renderHub(w, { theme, path: `/reports/${f.id}` });
    const suggests = await screen.findByRole('group', { name: 'The ladder suggests' });
    await user.click(within(suggests).getByRole('button', { name: 'Change' }));
    const action = screen.getByRole('group', { name: 'Action 1' });
    await user.selectOptions(within(action).getByLabelText('What happens'), 'Something else');
    await user.selectOptions(within(action).getByLabelText('Length'), 'Custom length');
    await user.click(screen.getByRole('radio', { name: 'Fair' }));
    await user.click(screen.getByRole('button', { name: 'Decide' }));
    await waitFor(() => expect(within(action).getByLabelText('Number')).toHaveAttribute('aria-invalid', 'true'));
    expect(await violations(container)).toEqual([]);
  });

  it('the Sanction form with a custom length has none', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Mallory' });
    const { container, user } = renderHub(w, { theme, path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await user.click(await screen.findByRole('button', { name: 'Sanction' }));
    await screen.findByRole('region', { name: 'Sanction Mallory' });
    await user.selectOptions(screen.getByLabelText('What happens'), 'chat');
    await user.selectOptions(screen.getByLabelText('How long'), 'Custom length');
    expect(await violations(container)).toEqual([]);
  });
});

describe.each(['light', 'dark'] as const)('axe on Settings > AI, %s theme', (theme) => {
  async function open(w: HubWorld) {
    const r = renderHub(w, { theme, path: '/settings/ai' });
    await screen.findByRole('heading', { level: 2, name: 'AI' });
    await screen.findByText('Working');
    return r;
  }

  it('axe: no violations: the screen, Advanced open, and the save question', async () => {
    const w = await hubWorld({ role: 'owner', ai: { level: 1 } });
    const f = await w.file();
    await w.aiIdle();
    await w.client.decide(f.id, { verdict: 'no_action', actions: [] });
    const { container, user } = await open(w);
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('radio', { name: /^Recommend/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await violations(container)).toEqual([]);
  });

  it('a role that only reads, a server with no adapter and a status that failed have none', async () => {
    const w = await hubWorld({ role: 'senior', actor: 's@example.test', ai: { level: 1 } });
    const { container } = await open(w);
    expect(await violations(container)).toEqual([]);
    cleanup();
    const none = await hubWorld({ role: 'owner' });
    const r = renderHub(none, { theme, path: '/settings/ai' });
    await screen.findByText('Not set up on this server');
    expect(await violations(r.container)).toEqual([]);
  });
});

describe.each(['light', 'dark'] as const)('axe on Settings > Advanced > Slow mode and flooding, %s theme', (theme) => {
  async function open(w: HubWorld) {
    const r = renderHub(w, { theme, path: '/settings/advanced' });
    await screen.findByRole('region', { name: 'Slow mode and flooding' });
    return r;
  }

  it('axe: no violations: off, switched on, with field errors, with the save question, and the built-in limit hint', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'owen@example.test' });
    const { container, user } = await open(w);
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('checkbox', { name: 'Burst limit' }));
    await user.type(screen.getByLabelText('Messages'), '10');
    await user.type(screen.getByLabelText('Within seconds'), '10');
    expect(await screen.findByText(/built-in limit of 3 messages per 5 seconds/)).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
    await user.clear(screen.getByLabelText('Messages'));
    await user.click(within(screen.getByRole('region', { name: 'Slow mode and flooding' })).getByRole('button', { name: 'Save changes' }));
    await screen.findByText(/whole number of messages/);
    expect(await violations(container)).toEqual([]);
    await user.type(screen.getByLabelText('Messages'), '5');
    await user.click(within(screen.getByRole('region', { name: 'Slow mode and flooding' })).getByRole('button', { name: 'Save changes' }));
    expect(await violations(container)).toEqual([]);
  });

  it('a role that only reads has none, and the Reset question has none', async () => {
    const w = await hubWorld({ role: 'senior', actor: 's@example.test' });
    const { container } = await open(w);
    expect(await violations(container)).toEqual([]);
    cleanup();
    const o = await hubWorld({ role: 'owner', actor: 'o@example.test', overrides: { pace: { slowModeMs: 2000 } } });
    const state = await o.direct.policyProfile();
    await o.direct.savePolicyProfile({ layer: { pace: { slowModeMs: 3000 } }, version: state.version, reason: 'x' });
    const r = await open(o);
    await r.user.click(screen.getByRole('button', { name: 'Reset slow mode and flooding' }));
    expect(await violations(r.container)).toEqual([]);
  });
});

describe.each(['light', 'dark'] as const)('axe on Settings > Advanced > Signals, %s theme', (theme) => {
  const KINDS = {
    muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const },
    commended: { label: 'Commended by other players', polarity: 'positive' as const },
  };
  async function open(w: HubWorld) {
    const r = renderHub(w, { theme, path: '/settings/advanced' });
    await screen.findByRole('region', { name: 'Signals' });
    return r;
  }

  it('axe: no violations: the kinds, every form switched on, a rule, field errors and the save question', async () => {
    const w = await hubWorld({
      role: 'owner',
      actor: 'owen@example.test',
      store: withMemorySignals(withMemoryAi(new MemoryStore())),
      overrides: { signals: { kinds: KINDS } } as never,
      ai: { level: 1 },
    });
    const { container, user } = await open(w);
    expect(await violations(container)).toEqual([]);
    for (const name of ['Show on a person’s record', 'Put these people sooner in the queue', 'Add to the suggested step', 'Give the AI read as background']) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    expect(await violations(container)).toEqual([]);
    await user.click(within(screen.getByRole('region', { name: 'Signals' })).getByRole('button', { name: 'Save changes' }));
    await screen.findAllByText(/Choose at least one kind/);
    expect(await violations(container)).toEqual([]);
  });

  it('read-only, with a dropped note, and with no declared kinds, has none', async () => {
    const store = withMemorySignals(withMemoryAi(new MemoryStore()));
    store.savePolicyLayer?.({ signals: { feeds: { queue: { kinds: ['removed_kind'], minDistinct: 3, windowDays: 7 } } } } as never, 0);
    const w = await hubWorld({ role: 'senior', actor: 's@example.test', store, overrides: { signals: { kinds: KINDS } } as never });
    const { container } = await open(w);
    await screen.findByRole('status', { name: 'Saved settings that could not be used' });
    expect(await violations(container)).toEqual([]);
    cleanup();
    const none = await hubWorld({ role: 'owner', actor: 'o@example.test' });
    const r = await open(none);
    expect(await violations(r.container)).toEqual([]);
  });
});
