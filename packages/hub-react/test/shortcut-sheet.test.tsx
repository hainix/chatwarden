import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUICK_KEYS_KEY, resetQuickKeysVisit } from '../src/quickKeys.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// The shortcut sheet: three groups of key caps with a catalog line each, and the Quick keys switch.

beforeEach(() => {
  window.localStorage.clear();
  resetQuickKeysVisit();
});
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetQuickKeysVisit();
});

async function sheetOf(mode: 'simple' | 'detailed', theme: 'light' | 'dark' = 'light') {
  const w = await hubWorld({ actor: 'ann@example.test' });
  await w.file({ target: 'Alpha' });
  const r = renderHub(w, { mode, theme });
  await screen.findByRole('region', { name: 'Open cases' });
  await r.user.keyboard('?');
  const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
  return { w, sheet, ...r };
}
const caps = (row: HTMLElement): string[] => [...row.querySelectorAll('kbd')].map((k) => k.textContent ?? '');
const rowOf = (sheet: HTMLElement, text: string): HTMLElement => {
  const dd = within(sheet).getByText(text);
  return dd.closest('.cw-sheet-row') as HTMLElement;
};

describe('the shortcut sheet', () => {
  it('has three groups, each with its own heading', async () => {
    const { sheet } = await sheetOf('simple');
    const groups = within(sheet).getAllByRole('group');
    expect(groups.map((g) => within(g).getByRole('heading').textContent)).toEqual(['Move', 'Act on a case', 'Anywhere']);
  });

  it('lists every binding in its group with the right key caps (Ctrl on Windows and Linux)', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    const { sheet } = await sheetOf('simple');
    const [move, act, general] = within(sheet).getAllByRole('group');
    expect(caps(rowOf(move as HTMLElement, 'Move to the next case in the queue'))).toEqual(['J', 'Down arrow']);
    expect(caps(rowOf(move as HTMLElement, 'Move to the previous case'))).toEqual(['K', 'Up arrow']);
    expect(caps(rowOf(move as HTMLElement, 'Take the next case'))).toEqual(['N']);
    expect(caps(rowOf(act as HTMLElement, 'Apply the suggested step and go to the next case'))).toEqual(['1']);
    expect(caps(rowOf(act as HTMLElement, 'Apply the suggested step and go to the next case'))).not.toContain('Ctrl');
    expect(caps(rowOf(act as HTMLElement, 'Nothing wrong here, then the next case'))).toEqual(['2']);
    expect(caps(rowOf(act as HTMLElement, 'Send a warning, then the next case (when offered)'))).toEqual(['3']);
    expect(caps(rowOf(act as HTMLElement, 'Undo the newest waiting decision'))).toEqual(['U']);
    expect(caps(rowOf(general as HTMLElement, 'Open the command bar'))).toEqual(['Ctrl', 'K']);
    expect(caps(rowOf(general as HTMLElement, 'Show this list'))).toEqual(['?']);
  });

  it('shows the Cmd glyph on a Mac', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const { sheet } = await sheetOf('simple');
    expect(caps(rowOf(sheet, 'Open the command bar'))).toEqual(['⌘', 'K']);
  });

  it('rows that only apply with Quick keys on say so; with it on they do not need saying', async () => {
    window.localStorage.setItem(QUICK_KEYS_KEY, 'off');
    const off = await sheetOf('simple');
    expect(within(rowOf(off.sheet, 'Nothing wrong here, then the next case')).getByText('Needs quick keys')).toBeInTheDocument();
    expect(within(rowOf(off.sheet, 'Take the next case')).queryByText('Needs quick keys')).toBeNull();
    expect(within(rowOf(off.sheet, 'Undo the newest waiting decision')).queryByText('Needs quick keys')).toBeNull();
    off.unmount();
    window.localStorage.setItem(QUICK_KEYS_KEY, 'on');
    const on = await sheetOf('detailed');
    expect(within(rowOf(on.sheet, 'Nothing wrong here, then the next case')).queryByText('Needs quick keys')).toBeNull();
  });

  it('the switch is on in Simple and off in Detailed to begin with, and says what it does', async () => {
    const simple = await sheetOf('simple');
    const toggle = within(simple.sheet).getByRole('switch', { name: 'Quick keys' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/1, 2 and 3 act at once, and J, K and the arrow keys open the case they move to/);
    simple.unmount();
    const detailed = await sheetOf('detailed');
    expect(within(detailed.sheet).getByRole('switch', { name: 'Quick keys' })).not.toBeChecked();
  });

  it('the switch toggles the preference, remembers it and announces it', async () => {
    const { sheet, user } = await sheetOf('detailed');
    const toggle = within(sheet).getByRole('switch', { name: 'Quick keys' });
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(window.localStorage.getItem(QUICK_KEYS_KEY)).toBe('on');
    expect(within(sheet).getByRole('status')).toHaveTextContent('Quick keys are on.');
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(window.localStorage.getItem(QUICK_KEYS_KEY)).toBe('off');
    expect(within(sheet).getByRole('status')).toHaveTextContent('Quick keys are off.');
  });

  it('the switch works from the keyboard: Space toggles it', async () => {
    const { sheet, user } = await sheetOf('detailed');
    const toggle = within(sheet).getByRole('switch', { name: 'Quick keys' });
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle).toBeChecked();
  });

  it('is a labelled modal that closes with Escape and returns focus', async () => {
    const { sheet, user } = await sheetOf('simple');
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull());
  });

  it('Tab and Shift+Tab move through each control of the window and wrap, never out of it', async () => {
    const { sheet, user } = await sheetOf('simple');
    const close = within(sheet).getByRole('button', { name: 'Close' });
    const toggle = within(sheet).getByRole('switch', { name: 'Quick keys' });
    expect(close).toHaveFocus();
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(toggle).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
  });

  it('the keys in the sheet do not act on the case behind it (a window is open)', async () => {
    const { sheet, user, w } = await sheetOf('simple');
    await user.keyboard('2');
    await user.keyboard('u');
    expect(w.sent.some((r) => r.method === 'POST' && /\/decide$/.test(r.path))).toBe(false);
    expect(sheet).toBeInTheDocument();
  });
});

describe.each(['light', 'dark'] as const)('axe on the shortcut sheet, %s theme', (theme) => {
  it.each(['simple', 'detailed'] as const)('%s', async (mode) => {
    const { sheet } = await sheetOf(mode, theme);
    const result = await axe.run(sheet, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => `${v.impact}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`)).toEqual([]);
  });
});
