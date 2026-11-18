import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCare, setCare } from '../src/care.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The C8+C9 fix round, hub side: focus goes somewhere sensible after a case-menu item that opens a form and after a line is taken back (M-3), and the break note's
// Escape is not taken from an open menu (M-4).

const menuButton = (): HTMLElement => screen.getByRole('button', { name: 'More actions on this case' });
const lineMenu = (text: string): HTMLElement => {
  const li = screen.getAllByRole('listitem').find((x) => x.textContent?.includes(text) && x.classList.contains('cw-line'));
  if (li === undefined) throw new Error(`no line ${text}`);
  return within(li).getByRole('button', { name: /Remove options for the line at/ });
};

describe('M-3: focus after a case-menu item that opens a form', () => {
  it('Lock this room and Emergency mode move the focus into their form (its first control), not to the page', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ room: 'lobby-1', target: 'Mallory', reporter: 'Rhea' });
    const { user } = renderHub(w, { path: `/reports/${f.id}` });
    await screen.findByRole('tablist');
    for (const [item, group] of [['Lock this room', 'Lock this room'], ['Emergency mode', 'Emergency mode']] as const) {
      await user.click(menuButton());
      await user.click(screen.getByRole('button', { name: item }));
      const form = await screen.findByRole('group', { name: group });
      await waitFor(() => expect(form.contains(document.activeElement), item).toBe(true));
      expect(document.activeElement).not.toBe(document.body);
      // Cancel hands the focus back to the menu's button, as it did.
      await user.click(within(form).getByRole('button', { name: 'Cancel' }));
      expect(menuButton()).toHaveFocus();
    }
  });

  it('a second look (Ask a senior to look) moves the focus into its form, and Escape from there closes the menu onto its button', async () => {
    const w = await hubWorld({ overrides: { desk: { workflow: true } } });
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    const { user } = renderHub(w, { path: `/reports/${f.id}` });
    await screen.findByRole('tablist');
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Ask a senior to look' }));
    const form = await screen.findByRole('group', { name: 'Ask a senior to look' });
    await waitFor(() => expect(form.contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    expect(menuButton()).toHaveFocus();
  });
});

describe('M-3: focus after a line is taken back', () => {
  async function roomCase() {
    const w = await hubWorld();
    const f = await w.fileRich({ room: 'lobby-1', target: 'Mallory', reporter: 'Rhea' });
    const r = renderHub(w, { path: `/reports/${f.id}` });
    await screen.findByRole('tablist');
    return { w, f, ...r };
  }
  const lineOf = (text: string): HTMLElement => screen.getAllByRole('listitem').find((x) => x.textContent?.includes(text) && x.classList.contains('cw-line')) as HTMLElement;

  it('after "Remove from the room" the focus is on that line, not the page, once the line reads Removed from the room', async () => {
    const { user } = await roomCase();
    await user.click(lineMenu('a line from the target'));
    await user.click(screen.getByRole('button', { name: 'Remove from the room' }));
    await waitFor(() => expect(screen.getAllByText('Removed from the room').length).toBe(1));
    await waitFor(() => expect(lineOf('a line from the target').contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('after "Remove all recent lines from this player" the focus stays in the transcript', async () => {
    const { user } = await roomCase();
    await user.click(lineMenu('a line from the target'));
    await user.click(screen.getByRole('button', { name: 'Remove all recent lines from this player' }));
    await waitFor(() => expect(screen.getAllByText('Removed from the room').length).toBe(2));
    await waitFor(() => expect(document.activeElement?.closest('li.cw-line')).not.toBeNull());
  });

  it('a refused retraction keeps the menu open and the focus where it was (inside the menu)', async () => {
    const { w, user } = await roomCase();
    await user.click(lineMenu('a line from the target'));
    w.cw.rooms.close('lobby-1');
    const remove = screen.getByRole('button', { name: 'Remove from the room' });
    await user.click(remove);
    await screen.findByRole('alert');
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('button', { name: 'Remove from the room' })).toBeInTheDocument();
  });
});

describe('M-4: the break note does not swallow an Escape meant for an open menu', () => {
  beforeEach(() => {
    resetCare();
    try {
      localStorage.clear();
    } catch {
      // no storage
    }
  });
  afterEach(() => {
    resetCare();
    vi.restoreAllMocks();
  });

  async function withNote() {
    const w: HubWorld = await hubWorld();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await w.fileRich({ target: `Target${i}`, reporter: `Reporter${i}` })).id);
    setCare({ hideExcerpts: true, countOpened: true, breakAfter: 2 });
    const view = renderHub(w, { path: `/reports/${ids[0]}` });
    await screen.findByRole('button', { name: /^Show the chat/ });
    await view.user.click(screen.getByRole('button', { name: /^Show the chat/ }));
    view.router.navigate(`/reports/${ids[1]}`);
    await screen.findByRole('button', { name: /^Show the chat/ });
    await view.user.click(screen.getByRole('button', { name: /^Show the chat/ }));
    return { w, ids, ...view };
  }
  const note = (): HTMLElement | null => screen.queryByText(/A short break may help/)?.closest('[role="status"]') ?? null;

  it('with the note up and the case menu open, the first Escape closes the menu (focus back on its button) and the note stays; the second dismisses the note', async () => {
    const { user, router, ids } = await withNote();
    expect(note()).not.toBeNull();
    await user.click(menuButton());
    expect(menuButton()).toHaveAttribute('aria-expanded', 'true');
    const item = screen.getByRole('button', { name: 'Mark as urgent' });
    item.focus();
    await user.keyboard('{Escape}');
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(menuButton()).toHaveFocus();
    expect(note()).not.toBeNull();
    expect(router.path).toBe(`/reports/${ids[1]}`);
    await user.keyboard('{Escape}');
    expect(note()).toBeNull();
    expect(router.path).toBe(`/reports/${ids[1]}`);
  });

  it('the same with the focus on the menu button itself', async () => {
    const { user } = await withNote();
    await user.click(menuButton());
    menuButton().focus();
    await user.keyboard('{Escape}');
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(note()).not.toBeNull();
  });

  it('control: with no menu open the Escape dismisses the note, as before, and does not leave the case', async () => {
    const { user, router, ids } = await withNote();
    await user.keyboard('{Escape}');
    expect(note()).toBeNull();
    expect(router.path).toBe(`/reports/${ids[1]}`);
  });
});
