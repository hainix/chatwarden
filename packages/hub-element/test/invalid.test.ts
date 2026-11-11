import { waitFor } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { hubShown, mount } from './helpers.js';
import { hubWorld } from './world.js';

// A bad attribute value never breaks the hub: it falls back to the default, and says so once.

afterEach(() => {
  vi.restoreAllMocks();
});

const attrs = (o: Record<string, string>) => (name: string) => o[name] ?? null;

describe('readConfig: the defaults', () => {
  it('with no attributes: /admin, hub chooses the mode, auto theme, English, no game name, shortcuts on, hash router', () => {
    const warnings: string[] = [];
    expect(readConfig(attrs({}), (m) => warnings.push(m))).toEqual({
      baseUrl: '/admin',
      mode: undefined,
      theme: 'auto',
      locale: 'en',
      gameName: undefined,
      shortcuts: true,
      primary: false,
      router: 'hash',
    });
    expect(warnings).toEqual([]);
  });

  it('reads every attribute', () => {
    const warnings: string[] = [];
    const config = readConfig(
      attrs({ 'base-url': 'https://ops.example/mod/', mode: 'detailed', theme: 'dark', locale: 'pt-BR', 'game-name': 'Dragon Duel', shortcuts: 'false', router: 'memory' }),
      (m) => warnings.push(m),
    );
    expect(config).toEqual({ baseUrl: 'https://ops.example/mod/', mode: 'detailed', theme: 'dark', locale: 'pt-BR', gameName: 'Dragon Duel', shortcuts: false, primary: false, router: 'memory' });
    expect(warnings).toEqual([]);
  });

  it('an empty value means "not set", silently', () => {
    const warnings: string[] = [];
    const config = readConfig(attrs({ mode: '', theme: '', locale: '', 'game-name': '', router: '' }), (m) => warnings.push(m));
    expect(config.mode).toBeUndefined();
    expect(config.theme).toBe('auto');
    expect(config.locale).toBe('en');
    expect(config.gameName).toBeUndefined();
    expect(config.router).toBe('hash');
    expect(warnings).toEqual([]);
  });
});

describe('readConfig: invalid values', () => {
  it.each([
    ['mode', 'huge', (c: ReturnType<typeof readConfig>) => c.mode, undefined],
    ['theme', 'neon', (c: ReturnType<typeof readConfig>) => c.theme, 'auto'],
    ['router', 'url', (c: ReturnType<typeof readConfig>) => c.router, 'hash'],
    ['shortcuts', 'maybe', (c: ReturnType<typeof readConfig>) => c.shortcuts, true],
    ['primary', 'maybe', (c: ReturnType<typeof readConfig>) => c.primary, false],
    ['locale', 'not a locale!!', (c: ReturnType<typeof readConfig>) => c.locale, 'en'],
    ['base-url', '   ', (c: ReturnType<typeof readConfig>) => c.baseUrl, '/admin'],
  ])('%s="%s" falls back to the default with one warning that names it', (name, value, pick, fallback) => {
    const warnings: string[] = [];
    const config = readConfig(attrs({ [name]: value }), (m) => warnings.push(m));
    expect(pick(config)).toBe(fallback);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${name}="${value}"`);
    expect(warnings[0]).toContain('<chatwarden-hub>');
  });

  it('several bad attributes give one warning each, and the good ones still apply', () => {
    const warnings: string[] = [];
    const config = readConfig(attrs({ mode: 'x', theme: 'y', 'game-name': 'Fine' }), (m) => warnings.push(m));
    expect(warnings).toHaveLength(2);
    expect(config.gameName).toBe('Fine');
  });

  it('a warning lists what is allowed, so the page author can fix it', () => {
    const warnings: string[] = [];
    readConfig(attrs({ mode: 'x' }), (m) => warnings.push(m));
    expect(warnings[0]).toMatch(/simple.*detailed/);
  });
});

describe('the element warns once per bad value', () => {
  it('falls back, warns once, does not repeat on a re-render, and warns again for a different bad value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = await hubWorld();
    const el = mount({ theme: 'neon' }, { client: w.client });
    await hubShown(el);
    expect(el.shadowRoot?.querySelector('.cw-hub')?.hasAttribute('data-cw-theme')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    // An unrelated change draws again, and the same bad value is not announced again.
    el.setAttribute('game-name', 'Dragon Duel');
    await waitFor(() => expect(el.shadowRoot?.textContent).toContain('Dragon Duel'));
    expect(warn).toHaveBeenCalledTimes(1);
    // A different bad value is news.
    el.setAttribute('theme', 'plaid');
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    // A good value is not.
    el.setAttribute('theme', 'dark');
    await waitFor(() => expect(el.shadowRoot?.querySelector('.cw-hub')?.getAttribute('data-cw-theme')).toBe('dark'));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a hub with only bad values still draws, with the defaults', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = await hubWorld();
    const el = mount({ mode: 'huge', theme: 'neon', router: 'url', shortcuts: 'maybe', locale: '???' }, { client: w.client });
    await hubShown(el);
    expect(el.shadowRoot?.querySelector('.cw-body')?.getAttribute('data-mode')).toBe('simple');
  });
});
