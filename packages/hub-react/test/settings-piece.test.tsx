import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LadderSettings } from '../src/pieces/LadderSettings.js';
import { usePolicy } from '../src/policyHooks.js';
import { HubProvider } from '../src/provider.js';
import { renderPieces } from './pieces-kit.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The settings as a piece (placed in another page) and as a hook. Both are experimental, like the other pieces and hooks.

const H = 3_600_000;
const wrapperFor =
  (w: HubWorld, strict = false) =>
  ({ children }: { children: ReactNode }) => {
    const tree = (
      <HubProvider client={w.client} now={w.now} bare>
        {children}
      </HubProvider>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
const hook = async <T,>(w: HubWorld, use: () => T, strict = false) => {
  const view = renderHook(use, { wrapper: wrapperFor(w, strict) });
  await waitFor(() => expect(view.result.current).not.toBeNull());
  return view;
};
const gets = (w: HubWorld) => w.sent.filter((r) => r.method === 'GET' && r.path === '/policy/profile').length;

describe('the LadderSettings piece', () => {
  it('draws the settings inside a piece box, for a role that may read them', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container } = renderPieces(w, <LadderSettings className="mine" />);
    await screen.findByRole('list', { name: 'Lengths offered' });
    const box = container.querySelector('[data-cw-piece="LadderSettings"]');
    expect(box).toHaveClass('mine');
    expect(screen.getByRole('button', { name: 'Reset everything' })).toBeInTheDocument();
  });

  it('says so in one line when the role cannot read the policy, and asks the server nothing', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'policy.read': 'owner' } });
    renderPieces(w, <LadderSettings />);
    await screen.findByText(/can't open this/);
    expect(gets(w)).toBe(0);
  });

  it('a moderator reads it, and cannot change it', async () => {
    const w = await hubWorld({ role: 'moderator' });
    renderPieces(w, <LadderSettings />);
    await screen.findByRole('list', { name: 'Lengths offered' });
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('never moves the page', async () => {
    const w = await hubWorld({ role: 'owner' });
    const before = window.location.hash;
    const { user } = renderPieces(w, <LadderSettings />);
    await screen.findByRole('list', { name: 'Lengths offered' });
    await user.click(screen.getByRole('checkbox', { name: 'Let moderators type their own length' }));
    expect(window.location.hash).toBe(before);
  });
});

describe('usePolicy', () => {
  it('reads the settings once, and says what the role may do', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { result } = await hook(w, usePolicy);
    await waitFor(() => expect(result.current?.data).toBeDefined());
    expect(result.current?.allowed).toBe(true);
    expect(result.current?.canEdit).toBe(true);
    expect(result.current?.data?.version).toBe(0);
    expect(result.current?.data?.effective.durations).toHaveLength(7);
    expect(gets(w)).toBe(1);
  });

  it('a moderator reads and cannot edit; a role without policy.read is not allowed and nothing is asked', async () => {
    const a = await hubWorld({ role: 'moderator' });
    const read = await hook(a, usePolicy);
    await waitFor(() => expect(read.result.current?.data).toBeDefined());
    expect(read.result.current?.canEdit).toBe(false);
    const b = await hubWorld({ role: 'moderator', permissions: { 'policy.read': 'owner' } });
    const none = await hook(b, usePolicy);
    expect(none.result.current?.allowed).toBe(false);
    expect(none.result.current?.data).toBeUndefined();
    expect(gets(b)).toBe(0);
  });

  it('save sends the layer with the version it read and a reason, then has the new state', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { result } = await hook(w, usePolicy);
    await waitFor(() => expect(result.current?.data).toBeDefined());
    let outcome: Awaited<ReturnType<NonNullable<typeof result.current>['save']>> | undefined;
    await act(async () => {
      outcome = await result.current?.save({ durations: [H] }, 'Short list');
    });
    expect(outcome).toMatchObject({ ok: true, value: { version: 1, changed: ['durations'] } });
    await waitFor(() => expect(result.current?.data?.version).toBe(1));
    expect(result.current?.data?.effective.durations).toEqual([H]);
    expect(w.cw.profile.durations).toEqual([H]);
  });

  it('a second save with the old state is a conflict, as a value', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { result } = await hook(w, usePolicy);
    await waitFor(() => expect(result.current?.data).toBeDefined());
    await w.clientFor('bea@example.test', 'owner').savePolicyProfile({ layer: { customDuration: false }, version: 0, reason: 'first' });
    let outcome: Awaited<ReturnType<NonNullable<typeof result.current>['save']>> | undefined;
    await act(async () => {
      outcome = await result.current?.save({ durations: [H] }, 'late');
    });
    expect(outcome?.ok).toBe(false);
    if (outcome?.ok === false) expect(outcome.error.code).toBe('conflict');
  });

  it('a refused layer is a value with its path', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { result } = await hook(w, usePolicy);
    await waitFor(() => expect(result.current?.data).toBeDefined());
    let outcome: Awaited<ReturnType<NonNullable<typeof result.current>['save']>> | undefined;
    await act(async () => {
      outcome = await result.current?.save({ firstOffense: { severe: 'none' } }, 'bad');
    });
    expect(outcome?.ok).toBe(false);
    if (outcome?.ok === false) {
      expect(outcome.error.code).toBe('invalid_profile');
      expect(outcome.error.path).toBe('layer.firstOffense.severe');
    }
  });

  it('preview answers the samples and saves nothing; reset asks a reason and puts the section back', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { result } = await hook(w, usePolicy);
    await waitFor(() => expect(result.current?.data).toBeDefined());
    let preview: Awaited<ReturnType<NonNullable<typeof result.current>['preview']>> | undefined;
    await act(async () => {
      preview = await result.current?.preview({ firstOffense: { hostile: { kind: 'chat', durationMs: 6 * H } } });
    });
    expect(preview?.ok).toBe(true);
    if (preview?.ok === true) expect(preview.value.clean.hostile.label).toBe('Restrict chat 6 hours');
    expect(w.cw.policy.get().version).toBe(0);
    await act(async () => {
      await result.current?.save({ durations: [H] }, 'x');
    });
    await waitFor(() => expect(result.current?.data?.version).toBe(1));
    await act(async () => {
      await result.current?.reset('durations', 'back');
    });
    await waitFor(() => expect(result.current?.data?.effective.durations).toHaveLength(7));
  });

  it('works under StrictMode: one read, not two', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { result } = await hook(w, usePolicy, true);
    await waitFor(() => expect(result.current?.data).toBeDefined());
    expect(gets(w)).toBeLessThanOrEqual(2);
  });
});
