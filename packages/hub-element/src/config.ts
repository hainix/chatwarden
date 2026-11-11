import type { HubMode } from '@chatwarden/hub-react';

// What the element's attributes say, read into one plain object. A bad value never breaks the hub: it falls back to the default and
// `warn` is told, once per attribute.

/** The attributes, read and checked. */
export interface HubElementConfig {
  /** Where the staff routes are mounted. Default `/admin`. */
  baseUrl: string;
  /** `simple` or `detailed`; undefined leaves the choice to the moderator's last pick (Simple, in a browser that kept none). */
  mode: HubMode | undefined;
  theme: 'auto' | 'light' | 'dark';
  /** A BCP 47 tag for dates and numbers. Default `en`. */
  locale: string;
  gameName: string | undefined;
  shortcuts: boolean;
  /** `hash` keeps the place in the page's URL hash; `memory` keeps it inside the element. */
  router: 'hash' | 'memory';
}

export const DEFAULTS: HubElementConfig = {
  baseUrl: '/admin',
  mode: undefined,
  theme: 'auto',
  locale: 'en',
  gameName: undefined,
  shortcuts: true,
  router: 'hash',
};

const MODES = ['simple', 'detailed'] as const;
const THEMES = ['auto', 'light', 'dark'] as const;
const ROUTERS = ['hash', 'memory'] as const;

/** The attribute names the element observes. */
export const ATTRIBUTES = ['base-url', 'mode', 'theme', 'locale', 'game-name', 'shortcuts', 'router'] as const;

const oneOf = <T extends string>(allowed: readonly T[], value: string): T | undefined => allowed.find((a) => a === value.trim().toLowerCase());

/**
 * Reads the attributes. `get` is `getAttribute`; `warn` hears one message for each value that is not allowed (the default is used
 * instead). An empty value means "not set", and says nothing.
 */
export function readConfig(get: (name: string) => string | null, warn: (message: string) => void): HubElementConfig {
  const bad = (name: string, value: string, allowed: string): void =>
    warn(`<chatwarden-hub>: ${name}="${value}" is not ${allowed}; using the default.`);
  const text = (name: string): string | undefined => {
    const value = get(name);
    return value === null || value.trim() === '' ? undefined : value;
  };
  const choice = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = text(name);
    if (value === undefined) return fallback;
    const found = oneOf(allowed, value);
    if (found === undefined) {
      bad(name, value, `one of ${allowed.join(', ')}`);
      return fallback;
    }
    return found;
  };

  const baseRaw = get('base-url');
  let baseUrl = DEFAULTS.baseUrl;
  if (baseRaw !== null) {
    if (baseRaw.trim() === '') bad('base-url', baseRaw, 'an address such as /admin');
    else baseUrl = baseRaw.trim();
  }

  let mode: HubMode | undefined;
  const modeRaw = text('mode');
  if (modeRaw !== undefined) {
    mode = oneOf(MODES, modeRaw);
    if (mode === undefined) bad('mode', modeRaw, `one of ${MODES.join(', ')}`);
  }

  let locale = DEFAULTS.locale;
  const localeRaw = text('locale');
  if (localeRaw !== undefined) {
    try {
      locale = Intl.getCanonicalLocales(localeRaw.trim())[0] ?? DEFAULTS.locale;
    } catch {
      bad('locale', localeRaw, 'a language tag such as en or pt-BR');
    }
  }

  let shortcuts = DEFAULTS.shortcuts;
  const shortcutsRaw = get('shortcuts');
  if (shortcutsRaw !== null && shortcutsRaw.trim() !== '') {
    const value = shortcutsRaw.trim().toLowerCase();
    if (value === 'false') shortcuts = false;
    else if (value !== 'true') bad('shortcuts', shortcutsRaw, '"true" or "false"');
  }

  return {
    baseUrl,
    mode,
    theme: choice('theme', THEMES, DEFAULTS.theme),
    locale,
    gameName: text('game-name')?.trim(),
    shortcuts,
    router: choice('router', ROUTERS, DEFAULTS.router),
  };
}
