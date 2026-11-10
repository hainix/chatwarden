import { describe, expect, it } from 'vitest';
import { languageLabel, sortLanguages } from '../src/terms/languages.js';

// A language code, named in the viewer's language by Intl.DisplayNames. Where that is unsupported or throws, the code stands.

describe('languageLabel', () => {
  it('names a known code in English and keeps the code beside it', () => {
    expect(languageLabel('en', 'en')).toBe('English (en)');
    expect(languageLabel('es', 'en')).toBe('Spanish (es)');
  });

  it('names a regional tag', () => {
    const label = languageLabel('pt-BR', 'en');
    expect(label).toMatch(/Portuguese/);
    expect(label).toMatch(/\(pt-BR\)$/);
  });

  it('follows the locale', () => {
    expect(languageLabel('es', 'de')).toMatch(/^Spanisch \(es\)$/);
  });

  it('an unknown code is the code alone', () => {
    expect(languageLabel('zz', 'en')).toBe('zz');
    expect(languageLabel('qqq', 'en')).toBe('qqq');
  });

  it('a code Intl refuses (it throws) is the code alone', () => {
    expect(languageLabel('x', 'en')).toBe('x');
    expect(languageLabel('not a code', 'en')).toBe('not a code');
  });

  it('a locale Intl refuses falls back to English names or to the code, never throws', () => {
    expect(() => languageLabel('en', 'not a locale!!')).not.toThrow();
    expect(languageLabel('en', 'not a locale!!')).toMatch(/en/);
  });

  it('an environment without Intl.DisplayNames gives the code', () => {
    expect(languageLabel('en', 'en', null)).toBe('en');
  });

  it('a DisplayNames that throws when built or when asked gives the code', () => {
    const builds = () => {
      throw new RangeError('no');
    };
    const asks = () => ({
      of: () => {
        throw new RangeError('no');
      },
    });
    expect(languageLabel('en', 'en', builds)).toBe('en');
    expect(languageLabel('en', 'en', asks)).toBe('en');
  });

  it('a name that is only the code again, or empty, is the code alone', () => {
    expect(languageLabel('en', 'en', () => ({ of: () => 'en' }))).toBe('en');
    expect(languageLabel('en', 'en', () => ({ of: () => '' }))).toBe('en');
    expect(languageLabel('en', 'en', () => ({ of: () => undefined }))).toBe('en');
  });
});

describe('sortLanguages', () => {
  it('lists each code once, by its label, with the codes it cannot name last', () => {
    expect(sortLanguages(['pt', 'en', 'es', 'en', 'zz'], 'en')).toEqual(['en', 'pt', 'es', 'zz']);
  });

  it('is stable for an empty list', () => {
    expect(sortLanguages([], 'en')).toEqual([]);
  });
});
