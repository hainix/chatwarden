import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

const pane = (): HTMLElement => screen.getByRole('region', { name: 'Open cases' });
const links = (): HTMLElement[] => within(pane()).getAllByRole('link');
const linkNames = (): string[] => links().map((a) => a.querySelector('.cw-case-name')?.textContent ?? '');
const focusedName = (): string => (document.activeElement as HTMLElement | null)?.querySelector('.cw-case-name')?.textContent ?? '';

async function ready() {
  await screen.findByRole('region', { name: 'Open cases' });
  await waitFor(() => expect(within(pane()).queryByText('Loading the queue')).not.toBeInTheDocument());
}

async function world(names = ['Alpha', 'Bravo', 'Charlie'], options: Parameters<typeof hubWorld>[0] = { actor: 'ann@example.test' }) {
  const w = await hubWorld(options);
  const filed = [];
  for (const name of names) {
    filed.push(await w.file({ target: name }));
    w.clock.t += 1000;
  }
  return { w, filed };
}
const nextCalls = (w: HubWorld): number => w.sent.filter((r) => r.path === '/cases/next').length;
const sheet = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Keyboard shortcuts' });
const bar = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Command bar' });

describe('J and K move through the queue', () => {
  it('J goes to the first row, then down; K goes up; both stop at the ends', async () => {
    const { w } = await world();
    const { user } = renderHub(w);
    await ready();
    expect(linkNames()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await user.keyboard('j');
    expect(focusedName()).toBe('Alpha');
    await user.keyboard('j');
    expect(focusedName()).toBe('Bravo');
    await user.keyboard('J');
    expect(focusedName()).toBe('Charlie');
    await user.keyboard('j');
    expect(focusedName()).toBe('Charlie');
    await user.keyboard('k');
    expect(focusedName()).toBe('Bravo');
    await user.keyboard('K');
    await user.keyboard('k');
    expect(focusedName()).toBe('Alpha');
  });

  it('K from nothing goes to the last row', async () => {
    const { w } = await world();
    const { user } = renderHub(w);
    await ready();
    await user.keyboard('k');
    expect(focusedName()).toBe('Charlie');
  });

  it('moving does not open or claim anything; Enter opens the row you are on', async () => {
    const { w, filed } = await world();
    const { user, router } = renderHub(w);
    await ready();
    await user.keyboard('jj');
    expect(router.path).toBe('/');
    expect(w.sent.some((r) => r.path.endsWith('/claim'))).toBe(false);
    await user.keyboard('{Enter}');
    expect(router.path).toBe(`/reports/${filed[1]!.id}`);
    await waitFor(() => expect(w.cw.cases.holder(filed[1]!.person)?.by).toBe('ann@example.test'));
  });

  it('from the open case, J goes to the row after it and K to the row before', async () => {
    const { w, filed } = await world();
    const { user } = renderHub(w, { path: `/reports/${filed[1]!.id}` });
    await ready();
    // Focus is in the case, not the list: start from the open case's row.
    await user.keyboard('j');
    expect(focusedName()).toBe('Charlie');
    await user.keyboard('kk');
    expect(focusedName()).toBe('Alpha');
  });

  it('does nothing for an empty queue', async () => {
    const w = await hubWorld();
    const { user } = renderHub(w);
    await ready();
    await user.keyboard('jk');
    expect(document.body).toHaveFocus();
  });

  it('works across the filter: only the rows shown are visited', async () => {
    const { w, filed } = await world();
    await w.clientFor('maya@example.test').claimCase(filed[1]!.person);
    const { user } = renderHub(w);
    await ready();
    await user.click(within(pane()).getByRole('button', { name: 'Unclaimed' }));
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('jj');
    expect(focusedName()).toBe('Charlie');
  });
});

describe('N takes the next case', () => {
  it('claims and opens the oldest unclaimed case', async () => {
    const { w, filed } = await world();
    const { user, router } = renderHub(w);
    await ready();
    await user.keyboard('n');
    await waitFor(() => expect(router.path).toBe(`/reports/${filed[0]!.id}`));
    expect(await screen.findByRole('group', { name: 'Who is handling this case' })).toBeInTheDocument();
    expect(screen.queryByText(/^You took the/)).toBeNull();
    expect(w.cw.cases.holder(filed[0]!.person)?.by).toBe('ann@example.test');
  });

  it('a held key takes one case, not a case per repeat', async () => {
    const { w } = await world();
    renderHub(w);
    await ready();
    for (let i = 0; i < 6; i += 1) fireEvent.keyDown(document.body, { key: 'n', repeat: i > 0 });
    await waitFor(() => expect(nextCalls(w)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(nextCalls(w)).toBe(1);
  });

  it('N N in a moment is one case (a double press is not a second case)', async () => {
    const { w } = await world();
    const { user } = renderHub(w);
    await ready();
    await user.keyboard('nn');
    await waitFor(() => expect(nextCalls(w)).toBeGreaterThanOrEqual(1));
    expect(nextCalls(w)).toBe(1);
  });

  it('does nothing for a role that cannot decide', async () => {
    const { w } = await world(['Alpha'], { role: 'moderator', permissions: { 'reports.decide': 'senior' } });
    const { user } = renderHub(w);
    await ready();
    await user.keyboard('n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(nextCalls(w)).toBe(0);
  });
});

describe('? shows the shortcuts', () => {
  it('opens a window that lists every shortcut, and Escape closes it and gives focus back', async () => {
    const { w } = await world();
    const { user } = renderHub(w);
    await ready();
    const row = links()[0]!;
    row.focus();
    await user.keyboard('?');
    const dialog = sheet();
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    for (const text of [
      'Move to the next case in the queue',
      'Move to the previous case',
      'Take the next case',
      'Open the command bar',
      'Show this list',
      'Close a window, or go back to the queue',
    ]) {
      expect(within(dialog!).getByText(text)).toBeInTheDocument();
    }
    expect(within(dialog!).getAllByText('K').length).toBeGreaterThanOrEqual(2);
    expect(within(dialog!).getByText('Ctrl')).toBeInTheDocument();
    expect(within(dialog!).getByText('Esc')).toBeInTheDocument();
    expect(within(dialog!).getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(sheet()).toBeNull();
    expect(row).toHaveFocus();
  });

  it('J, K and N do nothing behind the open window, and Tab stays inside it', async () => {
    const { w } = await world();
    const { user } = renderHub(w);
    await ready();
    await user.keyboard('?');
    await user.keyboard('jkn');
    expect(nextCalls(w)).toBe(0);
    expect(sheet()).not.toBeNull();
    await user.tab();
    expect(sheet()!.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(sheet()!.contains(document.activeElement)).toBe(true);
  });

  it('can be closed with the Close button or by clicking outside', async () => {
    const { w } = await world();
    const { user, container } = renderHub(w);
    await ready();
    await user.keyboard('?');
    await user.click(within(sheet()!).getByRole('button', { name: 'Close' }));
    expect(sheet()).toBeNull();
    await user.keyboard('?');
    fireEvent.mouseDown(container.querySelector('.cw-scrim') as HTMLElement);
    expect(sheet()).toBeNull();
  });
});

describe('Ctrl or Cmd and K open the command bar', () => {
  it.each([
    ['Ctrl+K', '{Control>}k{/Control}'],
    ['Cmd+K', '{Meta>}k{/Meta}'],
    ['Ctrl+K with caps lock on', '{Control>}K{/Control}'],
  ])('%s', async (_name, keys) => {
    const { w } = await world();
    const { user } = renderHub(w);
    await ready();
    await user.keyboard(keys);
    expect(bar()).not.toBeNull();
  });

  it('Escape closes it and focus goes back to where it was', async () => {
    const { w } = await world();
    const { user } = renderHub(w);
    await ready();
    const row = links()[1]!;
    row.focus();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('combobox', { name: 'Search people, reports, terms or screens' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(bar()).toBeNull();
    expect(row).toHaveFocus();
  });
});

describe('Escape with no window open goes back to the queue', () => {
  it('focuses the open case\'s row, or the first row', async () => {
    const { w, filed } = await world();
    const { user } = renderHub(w, { path: `/reports/${filed[1]!.id}` });
    await ready();
    await screen.findByRole('heading', { level: 2, name: /Harassment report against Bravo/ });
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('{Escape}');
    expect(focusedName()).toBe('Bravo');
  });
});

describe('no shortcut fires while typing', () => {
  async function setup() {
    const { w, filed } = await world();
    const view = renderHub(w, { path: `/reports/${filed[0]!.id}` });
    await ready();
    await screen.findByRole('heading', { level: 2, name: /Harassment report against Alpha/ });
    return { w, filed, ...view };
  }

  it('in the reason box of a decision: j k n ? and Escape are letters, not commands', async () => {
    const { w, user } = await setup();
    const reason = await screen.findByRole('textbox', { name: /Reason/ });
    await user.click(reason);
    await user.keyboard('jknJKN? why');
    expect(reason).toHaveValue('jknJKN? why');
    expect(nextCalls(w)).toBe(0);
    expect(sheet()).toBeNull();
    expect(bar()).toBeNull();
    expect(reason).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(reason).toHaveFocus();
  });

  it('in a select (the category filter)', async () => {
    const { w, user } = await setup();
    const select = within(pane()).getByRole('combobox', { name: 'Category' });
    select.focus();
    await user.keyboard('n?jk');
    expect(nextCalls(w)).toBe(0);
    expect(sheet()).toBeNull();
    expect(select).toHaveFocus();
  });

  it('in an editable region', async () => {
    const { w, user } = await setup();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.tabIndex = 0;
    document.body.append(editable);
    editable.focus();
    await user.keyboard('n?');
    expect(nextCalls(w)).toBe(0);
    expect(sheet()).toBeNull();
    editable.remove();
  });

  it('in the command bar: letters search, and ? and n do not open the sheet or take a case', async () => {
    const { w, user } = await setup();
    await user.keyboard('{Control>}k{/Control}');
    const input = screen.getByRole('combobox', { name: 'Search people, reports, terms or screens' });
    await user.keyboard('n?jk');
    expect(input).toHaveValue('n?jk');
    expect(nextCalls(w)).toBe(0);
    expect(sheet()).toBeNull();
  });

  it('Ctrl+K does not open the bar from inside a text box either', async () => {
    const { user } = await setup();
    const reason = await screen.findByRole('textbox', { name: /Reason/ });
    await user.click(reason);
    await user.keyboard('{Control>}k{/Control}');
    expect(bar()).toBeNull();
  });
});

describe('combinations the browser owns are left alone', () => {
  it.each([
    ['Ctrl+N', '{Control>}n{/Control}'],
    ['Cmd+N', '{Meta>}n{/Meta}'],
    ['Alt+N', '{Alt>}n{/Alt}'],
    ['Ctrl+J', '{Control>}j{/Control}'],
    ['Cmd+J', '{Meta>}j{/Meta}'],
    ['Ctrl+Shift+K', '{Control>}{Shift>}k{/Shift}{/Control}'],
    ['Alt+K', '{Alt>}k{/Alt}'],
    ['Ctrl+?', '{Control>}?{/Control}'],
  ])('%s does nothing', async (_name, keys) => {
    const { w } = await world();
    const { user } = renderHub(w);
    await ready();
    await user.keyboard(keys);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nextCalls(w)).toBe(0);
    expect(sheet()).toBeNull();
    expect(bar()).toBeNull();
    expect(document.body).toHaveFocus();
  });
});

describe('shortcuts={false} turns them all off', () => {
  it('J K N ? Ctrl+K and Escape do nothing', async () => {
    const { w, filed } = await world();
    const { user } = renderHub(w, { shortcuts: false, path: `/reports/${filed[0]!.id}` });
    await ready();
    await screen.findByRole('heading', { level: 2, name: /Harassment report against Alpha/ });
    (document.activeElement as HTMLElement | null)?.blur();
    const before = document.activeElement;
    await user.keyboard('jkn?');
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('{Escape}');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nextCalls(w)).toBe(0);
    expect(sheet()).toBeNull();
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it('drops the key hints: no N or Ctrl K caps, no aria-keyshortcuts', async () => {
    const { w } = await world();
    const { container } = renderHub(w, { shortcuts: false });
    await ready();
    expect(container.querySelector('.cw-kbd')).toBeNull();
    expect(container.querySelector('[aria-keyshortcuts]')).toBeNull();
  });

  it('the buttons still work: Take next, and the command bar button, whose own Escape still closes it', async () => {
    const { w, filed } = await world();
    const { user, router } = renderHub(w, { shortcuts: false });
    await ready();
    await user.click(within(pane()).getByRole('button', { name: /Take next case/ }));
    await waitFor(() => expect(router.path).toBe(`/reports/${filed[0]!.id}`));
    await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
    expect(bar()).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(bar()).toBeNull();
  });

  it('are on by default, with hints', async () => {
    const { w } = await world();
    const { container } = renderHub(w);
    await ready();
    expect(container.querySelectorAll('.cw-kbd').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Search or jump to/ })).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
  });
});
