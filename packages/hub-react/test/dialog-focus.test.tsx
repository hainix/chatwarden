import { act, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/Hub.js';
import type { HubProps } from '../src/Hub.js';
import { memoryRouter } from '../src/router.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Where focus goes when a window closes and the element that had it is gone. It must stay in the hub, on its root: on the page body
// the keys of a hub that is not the page's only (or primary) hub would be dead until the next click.

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await tick(0);
};
const rows = (c: ParentNode): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('.cw-queue .cw-case-link')];
const names = (c: ParentNode): string[] => rows(c).map((r) => r.querySelector('.cw-case-name')?.textContent ?? '');

function mountHub(w: HubWorld, props: Partial<Omit<HubProps, 'client'>> = {}) {
  const container = document.body.appendChild(document.createElement('div'));
  render(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" {...props} />, { container });
  return container;
}

describe('a window closes and what had focus before it is gone', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  async function twoHubs() {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const alpha = await w.file({ target: 'Alpha' });
    w.clock.t += 1000;
    await w.file({ target: 'Bravo' });
    w.clock.t += 1000;
    await w.file({ target: 'Charlie' });
    const a = mountHub(w);
    mountHub(w);
    await settle();
    expect(names(a)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    return { w, a, alpha };
  }

  it('Ctrl+K from a row, the row goes while the bar is open, the bar closes: focus is on the hub root and J works', async () => {
    const { w, a, alpha } = await twoHubs();
    const row = rows(a)[0] as HTMLElement;
    row.focus();
    fireEvent.keyDown(row, { key: 'k', ctrlKey: true });
    await settle();
    expect(within(a).getByRole('dialog', { name: 'Command bar' })).toBeInTheDocument();
    // Focus is in the bar, so the list lets go of a closed case: Alpha is decided elsewhere and its row leaves.
    await w.clientFor('maya@example.test').decide(alpha.id, { verdict: 'no_action', reason: 'fine', actions: [] });
    await tick(5_000);
    expect(names(a)).toEqual(['Bravo', 'Charlie']);
    expect(row.isConnected).toBe(false);
    fireEvent.keyDown(within(a).getByRole('combobox', { name: 'Search people, reports, terms or screens' }), { key: 'Escape' });
    await settle();
    expect(within(a).queryByRole('dialog')).toBeNull();
    const root = a.querySelector('.cw-hub') as HTMLElement;
    expect(document.activeElement).toBe(root);
    // Two hubs on the page and none primary: a key on the body would reach neither. On the hub root it reaches this one.
    fireEvent.keyDown(root, { key: 'j' });
    expect(document.activeElement).toBe(rows(a)[0]);
    expect(rowName(document.activeElement)).toBe('Bravo');
  });

  it('a window opened with focus on the body hands focus to the hub root when it closes', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    await w.file({ target: 'Alpha' });
    const a = mountHub(w, { primary: true });
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: '?' });
    await settle();
    expect(within(a).getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    fireEvent.keyDown(within(a).getByRole('dialog'), { key: 'Escape' });
    await settle();
    expect(within(a).queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(a.querySelector('.cw-hub'));
  });

  it('when the element that had focus is still there, focus goes back to it, as before', async () => {
    const { a } = await twoHubs();
    const row = rows(a)[1] as HTMLElement;
    row.focus();
    fireEvent.keyDown(row, { key: '?' });
    await settle();
    fireEvent.keyDown(within(a).getByRole('dialog'), { key: 'Escape' });
    await settle();
    expect(document.activeElement).toBe(row);
  });
});

const rowName = (el: Element | null): string => el?.querySelector('.cw-case-name')?.textContent ?? '';
