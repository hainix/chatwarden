// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enChat } from '../src/chat/words.js';
import { createT, en } from '../src/i18n.js';
import { loadPlayerT } from '../src/locales/load.js';
import { matchLocale } from '../src/locales/match.js';

describe('matchLocale', () => {
  it.each([
    ['es', 'es'],
    ['es-MX', 'es'],
    ['es-419', 'es'],
    ['ES', 'es'],
    ['es_AR', 'es'],
    ['es-es', 'es'],
    ['pt', 'pt'],
    ['pt-BR', 'pt'],
    ['pt-PT', 'pt'],
    ['PT-br', 'pt'],
    ['pt_BR', 'pt'],
    [' es ', 'es'],
  ])('%s gives %s', (requested, expected) => {
    expect(matchLocale(requested)).toBe(expected);
  });

  it.each([['en'], ['en-US'], ['de'], ['de-AT'], [''], ['   '], ['e'], ['espanol'], ['pt1'], ['-es'], ['x-es'], ['a'.repeat(300)], ['es' + 'x'.repeat(300)]])('%j gives null', (requested) => {
    expect(matchLocale(requested)).toBeNull();
  });

  it.each([[undefined], [null], [42], [{}], [['es']], [true], [Symbol('es')]])('a non-string (%s) gives null', (requested) => {
    expect(matchLocale(requested)).toBeNull();
  });

  it('answers only from the locales it is given', () => {
    expect(matchLocale('es', ['pt'])).toBeNull();
    expect(matchLocale('de-CH', ['de', 'es'])).toBe('de');
    expect(matchLocale('es', [])).toBeNull();
  });
});

describe('loadPlayerT', () => {
  it('es: the notice title is Spanish, and a key the catalogue lacks is the English', async () => {
    const { es } = await import('../src/locales/es.js');
    const t = await loadPlayerT('es');
    expect(t('player.notice.title.warning')).toBe((es as Record<string, string>)['player.notice.title.warning']);
    expect(t('player.notice.title.warning')).not.toBe(en['player.notice.title.warning']);
    // The chat words are in the catalogue too: the box needs no second load.
    expect(t('player.chat.send')).toBe((es as Record<string, string>)['player.chat.send']);
    expect(t('player.chat.send')).not.toBe(enChat['player.chat.send']);
    // A key nobody has comes back as the key (the visible gap), the same as English.
    expect(t('player.nope' as never)).toBe('player.nope');
  });

  it('pt: the same', async () => {
    const { pt } = await import('../src/locales/pt.js');
    const t = await loadPlayerT('pt-BR');
    expect(t('player.notice.title.ban')).toBe((pt as Record<string, string>)['player.notice.title.ban']);
    expect(t('player.notice.title.ban')).not.toBe(en['player.notice.title.ban']);
  });

  it('en, an unknown locale, an empty string and a non-string give the English t', async () => {
    const english = createT(en, 'en');
    for (const locale of ['en', 'de', 'xx-YY', '', undefined, null, 7]) {
      const t = await loadPlayerT(locale as string);
      expect(t('player.notice.title.warning'), String(locale)).toBe(english('player.notice.title.warning'));
      expect(t('player.report.cancel'), String(locale)).toBe(english('player.report.cancel'));
    }
  });

  it('numbers and plurals follow the locale asked for (es-MX, pt-BR)', async () => {
    const t = await loadPlayerT('es-MX');
    expect(t('player.report.remaining', { count: 1234 })).toContain('1,234');
    const pt = await loadPlayerT('pt-BR');
    expect(pt('player.report.remaining', { count: 1234 })).toContain('1.234');
  });
});

describe('a missing key and a failed load', () => {
  afterEach(() => {
    vi.doUnmock('../src/locales/es.js');
    vi.resetModules();
  });

  it('a catalogue with one key: that key is Spanish, every other is the English', async () => {
    vi.resetModules();
    vi.doMock('../src/locales/es.js', () => ({ es: { 'player.notice.title.warning': 'Aviso' }, meta: {} }));
    const { loadPlayerT: load } = await import('../src/locales/load.js');
    const t = await load('es');
    expect(t('player.notice.title.warning')).toBe('Aviso');
    expect(t('player.notice.title.ban')).toBe(en['player.notice.title.ban']);
  });

  it('a module that cannot be loaded leaves the English t and does not throw', async () => {
    vi.resetModules();
    vi.doMock('../src/locales/es.js', () => {
      throw new Error('chunk failed');
    });
    const { loadPlayerT: load } = await import('../src/locales/load.js');
    const t = await load('es');
    expect(t('player.notice.title.warning')).toBe(en['player.notice.title.warning']);
  });

  it('a later call tries again after a failure (nothing is remembered)', async () => {
    vi.resetModules();
    let fail = true;
    vi.doMock('../src/locales/es.js', () => {
      if (fail) throw new Error('chunk failed');
      return { es: { 'player.notice.title.warning': 'Aviso' }, meta: {} };
    });
    const { loadPlayerT: load } = await import('../src/locales/load.js');
    expect((await load('es'))('player.notice.title.warning')).toBe(en['player.notice.title.warning']);
    fail = false;
    expect((await load('es'))('player.notice.title.warning')).toBe('Aviso');
  });
});

describe('the catalogues are lazy chunks', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));

  async function split() {
    const result = await build({
      entryPoints: [`${root}src/index.ts`],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/*', '@chatwarden/*'],
      splitting: true,
      outdir: `${root}.size-out`,
      entryNames: 'entry',
      chunkNames: 'chunk-[name]-[hash]',
      metafile: true,
      logLevel: 'silent',
    });
    return result.outputFiles.map((o) => ({ name: o.path.split(/[\\/]/).pop() ?? '', text: o.text }));
  }

  it('the main entry does not contain the Spanish or the Portuguese text, and each language is a chunk of its own', async () => {
    const [{ es }, { pt }] = await Promise.all([import('../src/locales/es.js'), import('../src/locales/pt.js')]);
    const files = await split();
    const entry = files.find((f) => f.name === 'entry.js');
    expect(entry).toBeDefined();
    // esbuild writes non-ASCII as \u escapes; compare the decoded text.
    const decode = (s: string): string => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    const entryText = decode((entry as { text: string }).text);
    const sample = (c: Record<string, string>): string => c['player.notice.title.ban'] as string;
    expect(entryText).not.toContain(sample(es as Record<string, string>));
    expect(entryText).not.toContain(sample(pt as Record<string, string>));
    const holding = (needle: string) => files.filter((f) => f.name !== 'entry.js' && decode(f.text).includes(needle));
    expect(holding(sample(es as Record<string, string>)).length).toBe(1);
    expect(holding(sample(pt as Record<string, string>)).length).toBe(1);
    // The entry reaches them by a dynamic import(), not a static one.
    expect((entry as { text: string }).text).toMatch(/import\("\.\/chunk-/);
  });
});
