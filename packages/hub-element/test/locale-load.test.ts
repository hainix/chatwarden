import { waitFor } from '@testing-library/dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createT, en, loadHubCatalog } from '@chatwarden/hub-react';
import { hubShown, inside, mount } from './helpers.js';
import { hubWorld } from './world.js';

// The `locale` attribute reaches the hub's provider: a language the package ships (es, pt) loads its catalogue on demand, a language it does not
// ship reads English, a bad value falls back as before, and a `t` property always wins. Changing the attribute reloads.

afterEach(() => {
  vi.restoreAllMocks();
});

const text = (c: Readonly<Record<string, string>>, key: string): string => c[key] as string;
let es: Readonly<Record<string, string>>;
let pt: Readonly<Record<string, string>>;
beforeAll(async () => {
  es = await loadHubCatalog('es');
  pt = await loadHubCatalog('pt');
});
// The rail's name is the first word the hub paints from the catalogue: a landmark named in the language asked for.
const rail = (el: Element, name: string) => inside(el).findByRole('navigation', { name }, { timeout: 5000 });

describe('<chatwarden-hub locale>', () => {
  it('pt-BR loads the Portuguese catalogue', async () => {
    const w = await hubWorld();
    const el = mount({ locale: 'pt-BR' }, { client: w.client });
    await hubShown(el);
    expect(await rail(el, text(pt, 'hub.nav.label'))).toBeTruthy();
    expect(inside(el).queryByRole('navigation', { name: en['hub.nav.label'] })).toBeNull();
  });

  it('es-419 loads the Spanish one, and changing the attribute reloads', async () => {
    const w = await hubWorld();
    const el = mount({ locale: 'es-419' }, { client: w.client });
    await hubShown(el);
    expect(await rail(el, text(es, 'hub.nav.label'))).toBeTruthy();
    el.setAttribute('locale', 'pt');
    await waitFor(() => expect(inside(el).queryByRole('navigation', { name: text(pt, 'hub.nav.label') })).not.toBeNull(), { timeout: 5000 });
    el.setAttribute('locale', 'en');
    await waitFor(() => expect(inside(el).queryByRole('navigation', { name: en['hub.nav.label'] })).not.toBeNull(), { timeout: 5000 });
  });

  it('an invalid locale falls back as today (English, one warning) and loads nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = await hubWorld();
    const el = mount({ locale: 'not a locale!' }, { client: w.client });
    await hubShown(el);
    expect(await rail(el, en['hub.nav.label'])).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a language the package does not ship reads English', async () => {
    const w = await hubWorld();
    const el = mount({ locale: 'de' }, { client: w.client });
    await hubShown(el);
    expect(await rail(el, en['hub.nav.label'])).toBeTruthy();
  });

  it('a t property wins over the locale attribute', async () => {
    const w = await hubWorld();
    const el = mount({ locale: 'pt-BR' }, { client: w.client, t: createT({ ...en, 'hub.nav.label': 'Mine' }, 'pt-BR') });
    await hubShown(el);
    expect(await rail(el, 'Mine')).toBeTruthy();
    expect(inside(el).queryByRole('navigation', { name: text(pt, 'hub.nav.label') })).toBeNull();
  });
});
