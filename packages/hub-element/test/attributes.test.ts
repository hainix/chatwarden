import { waitFor } from '@testing-library/dom';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { goTo, hubShown, inside, mount } from './helpers.js';
import { hubWorld } from './world.js';

// The attributes: base-url, mode, theme, locale, game-name, shortcuts, primary and router. Each one is read when the hub draws and again
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
    await q.findByText(/Reported as Insults or harassment by Saffron, 2 days ago\./, {}, { timeout: 5000 });
    el.setAttribute('locale', 'de');
    // The words stay English (the catalog is English); the time is formed by Intl in the new locale.
    await waitFor(() => expect(q.queryByText(/Reported as Insults or harassment by Saffron, 2 days ago\./)).toBeNull());
    expect(q.getByText(/Reported as Insults or harassment by Saffron, vorgestern\./)).toBeTruthy();
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

describe('primary', () => {
  // (Through any shadow root: the page's own activeElement is only a host.)
  const blur = (): void => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    (el as HTMLElement | null)?.blur();
  };

  async function twoWithKeys(first: Record<string, string>, second: Record<string, string>) {
    const w = await hubWorld();
    const a = mount(first, { client: w.client });
    const b = mount(second, { client: w.client });
    await hubShown(a);
    await hubShown(b);
    blur();
    return { a, b };
  }
  const sheets = (el: Element): number => el.shadowRoot?.querySelectorAll('[role="dialog"]').length ?? 0;

  it('the bare attribute and "true" make an element the one that answers keys with nothing focused', async () => {
    for (const value of ['', 'true']) {
      const { a, b } = await twoWithKeys({ router: 'memory' }, { router: 'memory', primary: value });
      await userEvent.setup().keyboard('?');
      await inside(b).findByRole('dialog', { name: 'Keyboard shortcuts' });
      expect(sheets(a)).toBe(0);
      document.body.replaceChildren();
    }
  });

  it('"false" and no attribute are the same: not primary', async () => {
    const { a, b } = await twoWithKeys({ router: 'memory', primary: 'false' }, { router: 'memory' });
    await userEvent.setup().keyboard('?');
    await new Promise((r) => setTimeout(r, 30));
    expect(sheets(a) + sheets(b)).toBe(0);
  });

  it('a change is picked up: adding it, then removing it, moves the answer and takes it away', async () => {
    const { a, b } = await twoWithKeys({ router: 'memory' }, { router: 'memory' });
    const user = userEvent.setup();
    a.setAttribute('primary', '');
    await new Promise((r) => setTimeout(r, 50));
    await user.keyboard('?');
    await inside(a).findByRole('dialog', { name: 'Keyboard shortcuts' });
    await user.keyboard('{Escape}');
    a.removeAttribute('primary');
    await new Promise((r) => setTimeout(r, 50));
    blur();
    await user.keyboard('?');
    await new Promise((r) => setTimeout(r, 30));
    expect(sheets(a) + sheets(b)).toBe(0);
  });

  it('a value that is not true or false warns once and counts as not primary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = await hubWorld();
    const el = mount({ router: 'memory', primary: 'maybe' }, { client: w.client });
    await hubShown(el);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('primary="maybe"'))).toHaveLength(1);
    warn.mockRestore();
  });
});
