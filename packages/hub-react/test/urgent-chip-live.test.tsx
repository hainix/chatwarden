import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { MINUTE, hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The urgent chip while the queue polls (fake timers): a new urgent report is announced once, politely, "An urgent report arrived", on
// the move from none to some and on an increase; never on a poll that changes nothing, never at the first load, never assertively. The
// chip goes away when the last urgent case is decided.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  spoken = 0;
  watcher = new MutationObserver((records) => {
    for (const r of records) for (const n of Array.from(r.addedNodes)) if (n.nodeType === 1 && (n.textContent ?? '').includes('An urgent report arrived') && (n as HTMLElement).className.includes('cw-sr')) spoken += 1;
  });
  watcher.observe(document.body, { childList: true, subtree: true });
});
afterEach(() => {
  watcher?.disconnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await tick(0);
};
// Every time the phrase is ADDED to the page (a node that holds it appears): what a polite live region speaks. Counted from the start of each test.
let spoken = 0;
let watcher: MutationObserver | null = null;
const live = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[aria-live="polite"], [role="status"]'));
const heard = (): number => spoken;
const shown = (): number => (live().map((el) => el.textContent ?? '').join(' ').match(/An urgent report arrived/g) ?? []).length;
const chip = (): HTMLElement | null => document.querySelector<HTMLElement>('.cw-urgent-chip');

async function urgent(w: HubWorld, target: string) {
  const f = await w.file({ target, reason: 'threat' });
  w.clock.t += MINUTE;
  return f;
}

async function started(w: HubWorld) {
  const view = renderHub(w);
  await settle();
  return view;
}

describe('the urgent chip announces a new urgent report', () => {
  it('is silent at the first load even with urgent reports waiting, then announces once on 0 to 1 and stays quiet for a poll that changes nothing', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    await started(w);
    expect(chip()).toBeNull();
    expect(heard()).toBe(0);
    await urgent(w, 'Threatener');
    await tick(5_100);
    await settle();
    expect(chip()?.textContent).toMatch(/^1 urgent/);
    expect(heard()).toBe(1);
    // Never assertive.
    expect(document.querySelectorAll('[aria-live="assertive"], [role="alert"]')).toHaveLength(0);
    await tick(5_100);
    await tick(5_100);
    expect(heard()).toBe(1);
  });

  it('does not announce what was already waiting when the hub opened', async () => {
    const w = await hubWorld();
    await urgent(w, 'Threatener');
    await started(w);
    expect(chip()).not.toBeNull();
    expect(heard()).toBe(0);
    await tick(5_100);
    expect(heard()).toBe(0);
  });

  it('announces again on an increase, once', async () => {
    const w = await hubWorld();
    await started(w);
    await urgent(w, 'First');
    await tick(5_100);
    await settle();
    expect(heard()).toBe(1);
    await urgent(w, 'Second');
    await tick(5_100);
    await settle();
    expect(chip()?.textContent).toMatch(/^2 urgent/);
    // Spoken twice (a new node each time), and one copy on the page.
    expect(heard()).toBe(2);
    expect(shown()).toBe(1);
    expect(screen.queryAllByText('An urgent report arrived').length).toBe(1);
  });

  it('a decrease announces nothing and the chip follows the count', async () => {
    const w = await hubWorld({ role: 'senior' });
    await urgent(w, 'First');
    const second = await urgent(w, 'Second');
    await started(w);
    expect(chip()?.textContent).toMatch(/^2 urgent/);
    await w.direct.decide(second.id, { verdict: 'no_action', actions: [] });
    await tick(5_100);
    await settle();
    expect(chip()?.textContent).toMatch(/^1 urgent/);
    expect(heard()).toBe(0);
  });

  it('goes away when the last urgent case is decided', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await urgent(w, 'Threatener');
    await started(w);
    expect(chip()).not.toBeNull();
    await w.direct.decide(f.id, { verdict: 'no_action', actions: [] });
    await tick(5_100);
    await settle();
    expect(chip()).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Open cases' })).queryByRole('button', { name: /urgent/ })).toBeNull();
  });
});
