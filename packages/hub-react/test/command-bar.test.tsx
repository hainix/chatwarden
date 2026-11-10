import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { personTag } from '../src/format.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

const input = (): HTMLElement => screen.getByRole('combobox', { name: 'Search people, reports, terms or screens' });
const bar = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Command bar' });
const options = (): HTMLElement[] => within(screen.getByRole('listbox', { name: 'Results' })).queryAllByRole('option');
const labels = (): string[] => options().map((o) => o.querySelector('.cw-cmdk-label')?.textContent ?? '');
const selected = (): HTMLElement | undefined => options().find((o) => o.getAttribute('aria-selected') === 'true');

async function ready() {
  const pane = await screen.findByRole('region', { name: 'Open cases' });
  await waitFor(() => expect(within(pane).queryByText('Loading the queue')).not.toBeInTheDocument());
}

async function setup(options: Parameters<typeof hubWorld>[0] = { actor: 'ann@example.test' }) {
  const w: HubWorld = await hubWorld(options);
  const a = await w.file({ target: 'Vantablob' });
  w.clock.t += 1000;
  const b = await w.file({ target: 'GrimJaw' });
  const view = renderHub(w);
  await ready();
  return { w, a, b, ...view };
}
async function open(user: ReturnType<typeof renderHub>['user']) {
  await user.click(screen.getByRole('button', { name: /Search or jump to/ }));
  return input();
}

describe('the command bar: opening and closing', () => {
  it('opens from the top bar button as a modal window with the search box focused', async () => {
    const { user } = await setup();
    await open(user);
    const dialog = bar();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(input()).toHaveFocus();
    expect(input()).toHaveAttribute('aria-expanded', 'true');
    expect(input()).toHaveAttribute('aria-autocomplete', 'list');
    expect(screen.getByRole('listbox', { name: 'Results' })).toHaveAttribute('id', input().getAttribute('aria-controls'));
  });

  it('Escape closes it and focus returns to the button', async () => {
    const { user } = await setup();
    const button = screen.getByRole('button', { name: /Search or jump to/ });
    await open(user);
    await user.keyboard('{Escape}');
    expect(bar()).toBeNull();
    expect(button).toHaveFocus();
  });

  it('a click outside closes it', async () => {
    const { user, container } = await setup();
    await open(user);
    fireEvent.mouseDown(container.querySelector('.cw-scrim') as HTMLElement);
    expect(bar()).toBeNull();
  });

  it('keeps focus inside while open: Tab does not leave the window', async () => {
    const { user } = await setup();
    await open(user);
    await user.tab();
    expect(bar()!.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(bar()!.contains(document.activeElement)).toBe(true);
  });
});

describe('the command bar: results', () => {
  it('with nothing typed lists the actions and the screens the role can open, and no people', async () => {
    const { user } = await setup({ role: 'moderator' });
    await open(user);
    expect(labels()).toEqual(['Take next case', 'Show keyboard shortcuts', 'Overview', 'Reports', 'Blocked', 'Terms', 'Rule gaps', 'Guide']);
    expect(options().map((o) => o.querySelector('.cw-cmdk-kind')?.textContent)).toEqual(['Action', 'Action', 'Screen', 'Screen', 'Screen', 'Screen', 'Screen', 'Screen']);
  });

  it('leaves out Audit for a moderator and offers it to a senior; leaves out Take next without reports.decide', async () => {
    const mod = await setup({ role: 'moderator' });
    await open(mod.user);
    expect(labels()).not.toContain('Audit');
    mod.unmount();
    const senior = await setup({ role: 'senior' });
    await open(senior.user);
    expect(labels()).toContain('Audit');
    senior.unmount();
    const limited = await setup({ role: 'moderator', permissions: { 'reports.decide': 'senior' } });
    await open(limited.user);
    expect(labels()).not.toContain('Take next case');
  });

  it('finds a person in the queue by handle, case-insensitively, and shows their short tag', async () => {
    const { user, a } = await setup();
    await open(user);
    await user.keyboard('VANTA');
    expect(labels()).toContain('Vantablob');
    const hit = options().find((o) => o.getAttribute('data-kind') === 'person' && o.textContent?.includes('Vantablob'));
    expect(hit).toHaveTextContent(personTag(a.person));
    expect(hit).toHaveTextContent('Person');
    expect(document.body.textContent).not.toContain(a.person);
  });

  it('finds a person by their short tag', async () => {
    const { user, b } = await setup();
    await open(user);
    await user.keyboard(personTag(b.person));
    expect(labels()).toContain('GrimJaw');
  });

  it('finds a report by its id and names who it is against', async () => {
    const { user, a } = await setup();
    await open(user);
    await user.keyboard(a.id.slice(0, 6));
    const hit = options().find((o) => o.textContent?.includes(`Report ${a.id}`));
    expect(hit).toBeDefined();
    expect(hit).toHaveTextContent('Vantablob');
    expect(hit).toHaveTextContent('Report');
  });

  it('finds a screen by name', async () => {
    const { user } = await setup();
    await open(user);
    await user.keyboard('gaps');
    expect(labels()).toEqual(['Rule gaps']);
  });

  it('says nothing matches, and the count is announced for a screen reader', async () => {
    const { user } = await setup();
    await open(user);
    await user.keyboard('zzzzz');
    expect(options()).toHaveLength(0);
    expect(within(bar()!).getByText('Nothing matches zzzzz.')).toBeInTheDocument();
    await user.clear(input());
    await user.keyboard('rep');
    expect(within(bar()!).getByRole('status')).toHaveTextContent(/\d+ results?/);
  });

  it('finds a term for a role that can read terms, and reads terms only when the bar opens', async () => {
    const w = await hubWorld({ role: 'senior', actor: 'sam@example.test' });
    await w.direct.addTerm({ term: 'quibblex', language: 'en' });
    const { user } = renderHub(w);
    await ready();
    expect(w.sent.some((r) => r.path === '/terms')).toBe(false);
    await open(user);
    await user.keyboard('quibb');
    await waitFor(() => expect(labels()).toContain('quibblex'));
    expect(options().find((o) => o.textContent?.includes('quibblex'))).toHaveTextContent('Term');
  });

  it('never reads terms for a role that cannot', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'terms.read': 'owner' } });
    const { user } = renderHub(w);
    await ready();
    await open(user);
    await user.keyboard('quibb');
    expect(w.sent.some((r) => r.path === '/terms')).toBe(false);
  });

  it('copes with the terms call failing: the rest still works', async () => {
    const w = await hubWorld({ role: 'senior' });
    await w.file({ target: 'Alpha' });
    w.intercept.fn = (req) => (req.path === '/terms' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { user } = renderHub(w);
    await ready();
    await open(user);
    await user.keyboard('alpha');
    expect(labels()).toContain('Alpha');
  });
});

describe('the command bar: the keyboard', () => {
  it('the first result is chosen; the arrow keys move it, with wrap, and aria-activedescendant follows', async () => {
    const { user } = await setup();
    await open(user);
    const first = options()[0]!;
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(input()).toHaveAttribute('aria-activedescendant', first.id);
    await user.keyboard('{ArrowDown}');
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    expect(input()).toHaveAttribute('aria-activedescendant', options()[1]!.id);
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(selected()).toBe(options()[options().length - 1]);
    await user.keyboard('{ArrowDown}');
    expect(selected()).toBe(options()[0]);
    await user.keyboard('{End}');
    expect(selected()).toBe(options()[options().length - 1]);
    await user.keyboard('{Home}');
    expect(selected()).toBe(options()[0]);
    expect(input()).toHaveFocus();
  });

  it('typing puts the first match back as the chosen one', async () => {
    const { user } = await setup();
    await open(user);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.keyboard('r');
    expect(selected()).toBe(options()[0]);
  });

  it('option ids are unique', async () => {
    const { user } = await setup();
    await open(user);
    const ids = options().map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id !== '')).toBe(true);
  });

  it('Enter on a person goes to their record and closes the bar', async () => {
    const { user, router, a } = await setup();
    await open(user);
    await user.keyboard('vantab{Enter}');
    expect(router.path).toBe(`/people/${a.person}`);
    expect(bar()).toBeNull();
  });

  it('Enter on a report goes to it', async () => {
    const { user, router, b } = await setup();
    await open(user);
    await user.keyboard(`${b.id}{Enter}`);
    expect(router.path).toBe(`/reports/${b.id}`);
  });

  it('Enter on a screen goes there, and focus lands on the new screen\'s heading', async () => {
    const { user, router } = await setup();
    await open(user);
    await user.keyboard('rule gaps{Enter}');
    expect(router.path).toBe('/gaps');
    expect(await screen.findByRole('heading', { level: 2, name: 'Rule gaps' })).toHaveFocus();
  });

  it('Enter with no result does nothing and keeps the bar open', async () => {
    const { user, router } = await setup();
    await open(user);
    await user.keyboard('zzzzz{Enter}');
    expect(bar()).not.toBeNull();
    expect(router.path).toBe('/');
  });

  it('the Take next action takes a case', async () => {
    const { user, router, a } = await setup();
    await open(user);
    await user.keyboard('take next{Enter}');
    await waitFor(() => expect(router.path).toBe(`/reports/${a.id}`));
    expect(bar()).toBeNull();
    expect(await screen.findByRole('group', { name: 'Who is handling this case' })).toBeInTheDocument();
  });

  it('the shortcuts action opens the shortcut sheet in its place', async () => {
    const { user } = await setup();
    await open(user);
    await user.keyboard('shortcuts{Enter}');
    expect(bar()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('terms arriving late do not move the result the pointer or the arrows chose', async () => {
    const { user, w } = await setup({ actor: 'ann@example.test', role: 'owner' });
    // A term that ranks above the people for "a": when it arrives, everything below it moves down one place.
    await w.direct.addTerm({ term: 'abacusword', language: 'en' });
    // The terms answer is held until the person has already chosen a result: the one flake of the full-package runs.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    w.intercept.fn = async (req) => {
      if (req.path === '/terms') await held;
      return undefined;
    };
    await open(user);
    await user.keyboard('a');
    const target = options().find((o) => o.getAttribute('data-kind') === 'person' && o.textContent?.includes('Vantablob'))!;
    fireEvent.mouseMove(target);
    expect(target).toHaveAttribute('aria-selected', 'true');
    const before = labels();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(options().some((o) => o.getAttribute('data-kind') === 'term')).toBe(true));
    expect(labels().length).toBeGreaterThan(before.length);
    // Still the same result, wherever it sits in the longer list.
    expect(selected()).toBe(target);
    // And Enter takes it.
    await user.keyboard('{Enter}');
    expect(bar()).toBeNull();
  });

  // The one flake of the full-package runs (4c fix round 1) was here: "Vantablob" is in the person's result and in the report's result
  // (as its hint), and a report's random id decides how well it matches "a", so now and then the report ranked first and
  // `find` took that one. These pick the person's result by its kind.
  it('a click on a result chooses it, and the pointer moving over one chooses it for Enter', async () => {
    const { user, router, a } = await setup();
    await open(user);
    await user.keyboard('a');
    // The bar reads the terms when it opens, and they join the results whenever the answer lands: a result the pointer is over
    // would then be a different one. Wait for the terms before touching the list, so the order cannot change under the pointer.
    await waitFor(() => expect(options().some((o) => o.getAttribute('data-kind') === 'term')).toBe(true));
    const target = options().find((o) => o.getAttribute('data-kind') === 'person' && o.textContent?.includes('Vantablob'))!;
    fireEvent.mouseMove(target);
    expect(target).toHaveAttribute('aria-selected', 'true');
    await user.click(target);
    expect(router.path).toBe(`/people/${a.person}`);
    expect(bar()).toBeNull();
  });
});
