import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createT, en } from '../src/i18n.js';
import { loadHubCatalog, hubLocaleLoaders } from '../src/locales/load.js';
import { matchLocale } from '../src/locales/match.js';
import { es, esAi, esPrivacy } from '../src/locales/es.js';
import { pt } from '../src/locales/pt.js';
import { aiEn } from '../src/ai/i18n.js';
import { privacyEn } from '../src/privacy/i18n.js';
import { renderHub } from './render.js';
import { renderPieces } from './pieces-kit.js';
import { useHub } from '../src/context.js';
import { HubProvider } from '../src/provider.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// A language is loaded on demand: the catalogue is its own chunk, and the provider shows its loading state until the words arrive, so a
// Spanish-speaking moderator never sees a flash of English. A `t` the adopter gives always wins.

const realLoaders = { ...hubLocaleLoaders };
afterEach(() => {
  Object.assign(hubLocaleLoaders, realLoaders);
  cleanup();
});

const text = (c: Record<string, string>, key: string): string => c[key] as string;

describe('matchLocale', () => {
  it.each([
    ['es', 'es'],
    ['es-MX', 'es'],
    ['es-419', 'es'],
    ['ES', 'es'],
    ['es_AR', 'es'],
    ['pt', 'pt'],
    ['pt-BR', 'pt'],
    ['pt-PT', 'pt'],
    ['PT-br', 'pt'],
  ])('%s gives %s', (requested, expected) => {
    expect(matchLocale(requested)).toBe(expected);
  });

  it.each([['en'], ['en-GB'], ['de'], ['fr-CA'], [''], [' '], ['a'.repeat(300)], ['espanol'], ['x-es']])('%j gives null', (requested) => {
    expect(matchLocale(requested)).toBeNull();
  });

  it.each([[undefined], [null], [7], [{}], [['es']]])('a non-string (%s) gives null', (requested) => {
    expect(matchLocale(requested)).toBeNull();
  });
});

describe('loadHubCatalog', () => {
  it('es merges the English, the AI words, the privacy words and the catalogue', async () => {
    const merged = await loadHubCatalog('es');
    expect(merged['hub.nav.reports']).toBe(text(es, 'hub.nav.reports'));
    expect(merged['hub.nav.reports']).not.toBe(en['hub.nav.reports']);
    const aiKey = Object.keys(aiEn)[0] as string;
    expect(merged[aiKey]).toBe(text(esAi, aiKey));
    const privacyKey = Object.keys(privacyEn)[0] as string;
    expect(merged[privacyKey]).toBe(text(esPrivacy, privacyKey));
    // Every key of the three English sets is there.
    for (const key of [...Object.keys(en), ...Object.keys(aiEn), ...Object.keys(privacyEn)]) expect(Object.hasOwn(merged, key), key).toBe(true);
  });

  it('a key the catalogue does not have is the English', async () => {
    hubLocaleLoaders.es = () => Promise.resolve({ es: { 'hub.nav.reports': 'Casos' }, esAi: {}, esPrivacy: {} });
    const merged = await loadHubCatalog('es');
    expect(merged['hub.nav.reports']).toBe('Casos');
    expect(merged['hub.nav.overview']).toBe(en['hub.nav.overview']);
    expect(merged[Object.keys(aiEn)[0] as string]).toBe(Object.values(aiEn)[0]);
  });

  it('pt-PT loads pt', async () => {
    const merged = await loadHubCatalog('pt-PT');
    expect(merged['hub.nav.reports']).toBe(text(pt, 'hub.nav.reports'));
  });

  it('en and an unknown locale give the English catalogue and import no locale module', async () => {
    const spy = vi.fn(() => Promise.reject(new Error('must not load')));
    hubLocaleLoaders.es = spy;
    hubLocaleLoaders.pt = spy;
    for (const locale of ['en', 'en-US', 'de', '', undefined, null, 7]) {
      const merged = await loadHubCatalog(locale);
      expect(merged['hub.nav.reports'], String(locale)).toBe(en['hub.nav.reports']);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('a module that cannot be loaded rejects (the provider keeps English) and a later call tries again', async () => {
    hubLocaleLoaders.es = () => Promise.reject(new Error('chunk failed'));
    await expect(loadHubCatalog('es')).rejects.toThrow('chunk failed');
    hubLocaleLoaders.es = realLoaders.es;
    expect((await loadHubCatalog('es'))['hub.nav.reports']).toBe(text(es, 'hub.nav.reports'));
  });

  it('the merged catalogue works with createT: numbers and plurals follow the locale', async () => {
    const t = createT(await loadHubCatalog('pt-BR'), 'pt-BR');
    expect(t('hub.simple.home.waiting', { count: 1 })).toBe(text(pt, 'hub.simple.home.waiting.one').replace('{count}', '1'));
    expect(t('hub.nav.reports')).toBe(text(pt, 'hub.nav.reports'));
  });
});

/** Every text the container shows from now on: what a moderator would see painted, in order. */
function watchText(container: HTMLElement): { seen: () => string[] } {
  const seen: string[] = [container.textContent ?? ''];
  new MutationObserver(() => seen.push(container.textContent ?? '')).observe(container, { childList: true, subtree: true, characterData: true, attributes: true });
  return { seen: () => seen };
}

describe('the provider', () => {
  function Probe() {
    const { t } = useHub();
    return <p data-testid="probe">{t('hub.nav.reports')}</p>;
  }

  it('with locale es and no t it shows its loading state, then Spanish, and English never shows', async () => {
    const w = await hubWorld();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    hubLocaleLoaders.es = async () => {
      await gate;
      return realLoaders.es();
    };
    const view = renderPieces(w, <Probe />, { locale: 'es' });
    const watch = watchText(view.container);
    // The loading state is up while the catalogue is on its way, and holds none of the hub's English.
    await act(async () => undefined);
    expect(screen.queryByTestId('probe')).toBeNull();
    expect(view.container.querySelector('.cw-gate [role="status"]')).not.toBeNull();
    expect(view.container.textContent).not.toMatch(/Loading|Reports|Sign in/);
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(text(es, 'hub.nav.reports')));
    for (const painted of watch.seen()) expect(painted).not.toContain(en['hub.nav.reports']);
    expect(watch.seen().join(' ')).not.toMatch(/Loading/);
  });

  it('the whole hub: the first thing painted is not English, and Spanish follows', async () => {
    const w = await hubWorld();
    const view = renderHub(w, { locale: 'es' });
    const watch = watchText(view.container);
    await screen.findByRole('navigation', { name: text(es, 'hub.nav.label') });
    for (const painted of watch.seen()) expect(painted).not.toMatch(/Moderator hub sections|Skip to the main content/);
  });

  it('with a failed import it renders English and does not throw', async () => {
    const w = await hubWorld();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    hubLocaleLoaders.pt = () => Promise.reject(new Error('chunk failed'));
    renderPieces(w, <Probe />, { locale: 'pt-BR' });
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(en['hub.nav.reports']));
    expect(log).not.toHaveBeenCalled();
  });

  it('with a given t the catalogue is never imported', async () => {
    const w = await hubWorld();
    const spy = vi.fn(() => realLoaders.es());
    hubLocaleLoaders.es = spy;
    renderPieces(w, <Probe />, { locale: 'es', t: createT({ ...en, 'hub.nav.reports': 'Mine' }, 'es') });
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('Mine'));
    await act(async () => undefined);
    expect(spy).not.toHaveBeenCalled();
  });

  it('with locale en or none, nothing is imported and English shows at once', async () => {
    const w = await hubWorld();
    const spy = vi.fn(() => realLoaders.es());
    hubLocaleLoaders.es = spy;
    hubLocaleLoaders.pt = spy;
    renderPieces(w, <Probe />, { locale: 'en' });
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(en['hub.nav.reports']));
    expect(spy).not.toHaveBeenCalled();
  });

  it('changing the locale at run time loads the new language and keeps the hub mounted meanwhile', async () => {
    const w = await hubWorld();
    const view = render(
      <Provider w={w} locale="es">
        <Probe />
      </Provider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(text(es, 'hub.nav.reports')));
    const probe = screen.getByTestId('probe');
    view.rerender(
      <Provider w={w} locale="pt-BR">
        <Probe />
      </Provider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(text(pt, 'hub.nav.reports')));
    expect(probe.isConnected).toBe(true);
    // And back to English: at once, with no import.
    view.rerender(
      <Provider w={w} locale="en">
        <Probe />
      </Provider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(en['hub.nav.reports']));
  });
});

function Provider({ w, locale, children }: { w: HubWorld; locale: string; children: ReactNode }) {
  return (
    <HubProvider client={w.client} now={w.now} mode="detailed" locale={locale}>
      {children}
    </HubProvider>
  );
}
