import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUICK_ACT_COOLDOWN_MS } from '../src/case/actGuard.js';
import { forgetHiddenAi } from '../src/ai/hide.js';
import { QUICK_KEYS_KEY, resetQuickKeysVisit, writeQuickKeys } from '../src/quickKeys.js';
import { aiBar, aiWorld, decides, decision, open, rewrite, settle } from './aiHub.js';
import { renderHub } from './render.js';
import { advanceGuardTime, useExactGuardClock } from './guardTime.js';

// The one-key accept goes through the same act guard as every other act key (src/case/actGuard.ts): a case accepts a key only
// QUICK_ACT_COOLDOWN_MS after it was drawn. This file freezes the guard's clock and moves it by hand, so "299 ms" is exact.
useExactGuardClock();

afterEach(() => {
  vi.useRealTimers();
  forgetHiddenAi();
  resetQuickKeysVisit();
  window.localStorage.removeItem(QUICK_KEYS_KEY);
  cleanup();
});

const press = (key: string): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
};
const held = (): HTMLElement | null => within(decision()).queryByText('Decision queued.');

describe('A and the cooldown', () => {
  it('a case does not accept A until it has been drawn for the cooldown, then does', async () => {
    writeQuickKeys(true);
    const { w, f } = await aiWorld({ level: 2 });
    await open(w, f.id, { stay: true });
    await aiBar();
    await settle(30);
    press('a');
    await settle(30);
    expect(held()).toBeNull();
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS - 1);
    press('a');
    await settle(30);
    expect(held()).toBeNull();
    advanceGuardTime(1);
    press('a');
    await waitFor(() => expect(held()).not.toBeNull());
    expect(decides(w)).toHaveLength(0);
  });

  it('the button is drawn disabled for that moment, and a click inside it does nothing', async () => {
    writeQuickKeys(true);
    const { w, f } = await aiWorld({ level: 2 });
    await open(w, f.id, { stay: true });
    const bar = await aiBar();
    const accept = within(bar).getByRole('button', { name: /^Accept AI suggestion/ });
    fireEvent.click(accept, { detail: 1 });
    await settle(30);
    expect(held()).toBeNull();
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    await waitFor(() => expect(accept).toBeTruthy());
    fireEvent.click(accept, { detail: 1 });
    await waitFor(() => expect(held()).not.toBeNull());
  });

  it('E opens the editor once the case has aged', async () => {
    writeQuickKeys(true);
    const { w, f } = await aiWorld({ level: 2 });
    await open(w, f.id, { stay: true });
    await aiBar();
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    press('e');
    await waitFor(() => expect(within(decision()).getByRole('group', { name: 'Action 1' })).toBeInTheDocument());
    expect(screen.queryByText('Decision queued.')).toBeNull();
  });
});

describe('the wait when the AI suggestion appears', () => {
  it('starts again: the key that meant the ladder step does not send the AI suggestion the instant it appears', async () => {
    writeQuickKeys(true);
    const { w, f } = await aiWorld({ level: 2 });
    // The read is stale to begin with (the suggestion cannot be accepted: the ladder's step is on offer); it is fresh at the next look.
    let stale = true;
    rewrite(w, f.id, (b) => {
      b.ai.stale = stale;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple', stay: true });
    for (let i = 0; i < 8; i += 1) await tick(0);
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS + 1);
    stale = false;
    // The strip reads the case again (a stale read is waited on): the suggestion appears.
    await tick(5_200);
    for (let i = 0; i < 8; i += 1) await tick(0);
    expect(screen.getByRole('button', { name: /^Accept AI suggestion/ })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: '1' });
    await tick(0);
    expect(screen.queryByText('Decision queued.')).toBeNull();
    advanceGuardTime(QUICK_ACT_COOLDOWN_MS - 1);
    fireEvent.keyDown(document.body, { key: '1' });
    await tick(0);
    expect(screen.queryByText('Decision queued.')).toBeNull();
    advanceGuardTime(1);
    fireEvent.keyDown(document.body, { key: '1' });
    await tick(0);
    expect(screen.getByText('Decision queued.')).toBeInTheDocument();
    expect(decides(w)).toHaveLength(0);
  });
});
