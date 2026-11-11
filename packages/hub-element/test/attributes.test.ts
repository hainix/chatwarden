import { waitFor } from '@testing-library/dom';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { goTo, hubShown, inside, mount } from './helpers.js';
import { hubWorld } from './world.js';

// The attributes: base-url, mode, theme, locale, game-name, shortcuts and router. Each one is read when the hub draws and again
// whenever it changes.

const body = (el: Element) => el.shadowRoot?.querySelector('.cw-body');
const root = (el: Element) => el.shadowRoot?.querySelector('.cw-hub');

describe('mode', () => {
  it('simple and detailed pick the layout, and a change re-renders', async () => {
    const w = await hubWorld();
    const el = mount({ mode: 'simple' }, { client: w.client });
    await hubShown(el);
    expect(body(el)?.getAttribute('data-mode')).toBe('simple');
    el.setAttribute('mode', 'detailed');
    await waitFor(() => expect(body(el)?.getAttribute('data-mode')).toBe('detailed'));
    el.setAttribute('mode', 'simple');
    await waitFor(() => expect(body(el)?.getAttribute('data-mode')).toBe('simple'));
  });

  it('is case-insensitive and ignores spaces around the value', async () => {
    const w = await hubWorld();
    const el = mount({ mode: ' Detailed ' }, { client: w.client });
    await hubShown(el);
    expect(body(el)?.getAttribute('data-mode')).toBe('detailed');
  });

  it('with the attribute removed, the hub chooses for itself again (Simple in a browser that kept nothing)', async () => {
    const w = await hubWorld();
    localStorage.clear();
    const el = mount({ mode: 'detailed' }, { client: w.client });
    await hubShown(el);
    el.removeAttribute('mode');
    await waitFor(() => expect(body(el)?.getAttribute('data-mode')).toBe('simple'));
  });
});

describe('theme', () => {
  it('light and dark force a scheme on the hub root; auto (the default) forces none', async () => {
    const w = await hubWorld();
    const el = mount({ theme: 'dark' }, { client: w.client });
    await hubShown(el);
    expect(root(el)?.getAttribute('data-cw-theme')).toBe('dark');
    el.setAttribute('theme', 'light');
    await waitFor(() => expect(root(el)?.getAttribute('data-cw-theme')).toBe('light'));
    el.setAttribute('theme', 'auto');
    await waitFor(() => expect(root(el)?.hasAttribute('data-cw-theme')).toBe(false));
    el.removeAttribute('theme');
    await Promise.resolve();
    expect(root(el)?.hasAttribute('data-cw-theme')).toBe(false);
  });
});

describe('game-name', () => {
  it('is shown in the top bar, and a change shows the new name', async () => {
    const w = await hubWorld();
    const el = mount({ 'game-name': 'Dragon Duel' }, { client: w.client });
    await hubShown(el);
    expect(inside(el).getAllByText('Dragon Duel').length).toBeGreaterThan(0);
    el.setAttribute('game-name', 'Space Pals');
    await waitFor(() => expect(inside(el).queryAllByText('Space Pals').length).toBeGreaterThan(0));
    expect(inside(el).queryAllByText('Dragon Duel')).toHaveLength(0);
  });
});

describe('locale', () => {
  it('sets the language of times: the same report, 2 days old, read in German ("vorgestern")', async () => {
    const w = await hubWorld();
    // The element reads the real clock, so the report is filed two days before it.
    w.clock.t = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const f = await w.fileRich({ reporter: 'Saffron' });
    goTo(`/reports/${f.id}`);
    const el = mount({ mode: 'simple' }, { client: w.client });
    const q = inside(el);
    await q.findByText(/Reported for harassment by Saffron, 2 days ago\./, {}, { timeout: 5000 });
    el.setAttribute('locale', 'de');
    // The words stay English (the catalog is English); the time is formed by Intl in the new locale.
    await waitFor(() => expect(q.queryByText(/Reported for harassment by Saffron, 2 days ago\./)).toBeNull());
    expect(q.getByText(/Reported for harassment by Saffron, vorgestern\./)).toBeTruthy();
  });
});

describe('shortcuts', () => {
  it('on by default: ? opens the shortcut sheet; "false" turns every shortcut off, and back on again', async () => {
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    await hubShown(el);
    const user = userEvent.setup();
    const q = inside(el);
    const focusable = el.shadowRoot?.querySelector<HTMLElement>('.cw-skip');
    focusable?.focus();
    await user.keyboard('?');
    await q.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(q.queryByRole('dialog')).toBeNull());

    el.setAttribute('shortcuts', 'false');
    await new Promise((r) => setTimeout(r, 50));
    el.shadowRoot?.querySelector<HTMLElement>('.cw-skip')?.focus();
    await user.keyboard('?');
    await new Promise((r) => setTimeout(r, 30));
    expect(q.queryByRole('dialog')).toBeNull();

    el.setAttribute('shortcuts', 'true');
    await new Promise((r) => setTimeout(r, 50));
    el.shadowRoot?.querySelector<HTMLElement>('.cw-skip')?.focus();
    await user.keyboard('?');
    await q.findByRole('dialog', { name: 'Keyboard shortcuts' });
  });

  it('the bare attribute (shortcuts with no value) leaves them on', async () => {
    const w = await hubWorld();
    const el = mount({ shortcuts: '' }, { client: w.client });
    await hubShown(el);
    const user = userEvent.setup();
    el.shadowRoot?.querySelector<HTMLElement>('.cw-skip')?.focus();
    await user.keyboard('?');
    await inside(el).findByRole('dialog', { name: 'Keyboard shortcuts' });
  });
});

describe('router', () => {
  async function firstLink(el: Element): Promise<HTMLAnchorElement> {
    const q = inside(el);
    await waitFor(() => expect(q.getAllByRole('link').some((a) => a.getAttribute('href')?.startsWith('#/reports') === true)).toBe(true));
    return q.getAllByRole('link').find((a) => a.getAttribute('href')?.startsWith('#/reports')) as HTMLAnchorElement;
  }

  it('hash (the default) keeps the place in the page URL hash', async () => {
    const w = await hubWorld();
    const el = mount({ mode: 'detailed' }, { client: w.client });
    await hubShown(el);
    const link = await firstLink(el);
    await userEvent.setup().click(link);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/reports/));
  });

  it('memory keeps the place inside the element and never touches the page URL', async () => {
    const w = await hubWorld();
    const el = mount({ mode: 'detailed', router: 'memory' }, { client: w.client });
    await hubShown(el);
    const link = await firstLink(el);
    await userEvent.setup().click(link);
    await new Promise((r) => setTimeout(r, 30));
    expect(window.location.hash).toBe('');
    // ...and the hub did move: the Reports screen is showing.
    await waitFor(() => expect(el.shadowRoot?.querySelector('.cw-screen-title')?.textContent ?? '').toMatch(/report|case/i));
  });

  it('switching hash to memory and back re-renders on the right router', async () => {
    const w = await hubWorld();
    goTo('/blocked');
    const el = mount({ mode: 'detailed' }, { client: w.client });
    await hubShown(el);
    await inside(el).findByRole('heading', { name: /Blocked/ }, { timeout: 5000 });
    el.setAttribute('router', 'memory');
    // A new memory router starts at the overview, not at the page's hash.
    await waitFor(() => expect(inside(el).queryByRole('heading', { name: /Blocked/ })).toBeNull());
    el.setAttribute('router', 'hash');
    await inside(el).findByRole('heading', { name: /Blocked/ }, { timeout: 5000 });
  });
});
