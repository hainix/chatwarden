import { describe, expect, it } from 'vitest';
import { createT, en } from '../src/i18n.js';
import type { PlayerText } from '../src/i18n.js';

// Test catalogs use keys the real catalog does not have, so the keys are cast.
const k = (key: string): PlayerText => key as PlayerText;
const text = (key: string): string => (en as Record<string, string>)[key] as string;

describe('createT', () => {
  it('returns the catalog text for a key', () => {
    const t = createT({ 'a.b': 'Hello' }, 'en');
    expect(t(k('a.b'))).toBe('Hello');
  });

  it('falls back to the key itself when the catalog has no such key', () => {
    const t = createT({}, 'en');
    expect(t(k('player.missing.key'))).toBe('player.missing.key');
  });

  it('fills {name} placeholders and leaves a placeholder with no value as written', () => {
    const t = createT({ greet: 'Hi {name}, you have {n} left, {unknown}' }, 'en');
    expect(t(k('greet'), { name: 'Ann', n: 3 })).toBe('Hi Ann, you have 3 left, {unknown}');
  });

  it('fills a placeholder every time it appears', () => {
    const t = createT({ twice: '{x} and {x}' }, 'en');
    expect(t(k('twice'), { x: 'a' })).toBe('a and a');
  });

  it('does not expand a placeholder that arrives inside a value', () => {
    const t = createT({ greet: 'Hi {name} {other}' }, 'en');
    expect(t(k('greet'), { name: '{other}', other: 'X' })).toBe('Hi {other} X');
  });

  it('does not treat $ in a value specially', () => {
    const t = createT({ price: 'Cost {p}' }, 'en');
    expect(t(k('price'), { p: "$& $1 $'" })).toBe("Cost $& $1 $'");
  });

  it('formats numbers for the locale', () => {
    expect(createT({ n: '{count} lines' }, 'en')(k('n'), { count: 1234 })).toBe('1,234 lines');
    expect(createT({ n: '{count} lines' }, 'de')(k('n'), { count: 1234 })).toBe('1.234 lines');
  });

  describe('plurals', () => {
    const cat = { 'r.one': '{count} report', 'r.other': '{count} reports', 'r.zero': 'No reports' };
    it('picks .one and .other by the English rule', () => {
      const t = createT(cat, 'en');
      expect(t(k('r'), { count: 1 })).toBe('1 report');
      expect(t(k('r'), { count: 2 })).toBe('2 reports');
      expect(t(k('r'), { count: 11 })).toBe('11 reports');
      expect(t(k('r'), { count: 1.5 })).toBe('1.5 reports');
    });
    it('uses .zero for zero when the catalog has it, in any locale', () => {
      expect(createT(cat, 'en')(k('r'), { count: 0 })).toBe('No reports');
      expect(createT(cat, 'pl')(k('r'), { count: 0 })).toBe('No reports');
    });
    it('uses .other for zero when there is no .zero', () => {
      const t = createT({ 'r.one': '{count} report', 'r.other': '{count} reports' }, 'en');
      expect(t(k('r'), { count: 0 })).toBe('0 reports');
    });
    it('follows the locale rules (Polish has few and many) and falls back to .other for a category the catalog lacks', () => {
      const pl = {
        'r.one': '{count} zgłoszenie',
        'r.few': '{count} zgłoszenia',
        'r.many': '{count} zgłoszeń',
        'r.other': '{count} zgłoszenia (inne)',
      };
      const t = createT(pl, 'pl');
      expect(t(k('r'), { count: 1 })).toBe('1 zgłoszenie');
      expect(t(k('r'), { count: 3 })).toBe('3 zgłoszenia');
      expect(t(k('r'), { count: 12 })).toBe('12 zgłoszeń');
      expect(t(k('r'), { count: 1.5 })).toBe('1,5 zgłoszenia (inne)');
      const sparse = createT({ 'r.one': 'one', 'r.other': 'other {count}' }, 'pl');
      expect(sparse(k('r'), { count: 3 })).toBe('other 3');
    });
    it('uses the plain key when there are no plural forms, and the key when nothing matches', () => {
      expect(createT({ r: 'Reports' }, 'en')(k('r'), { count: 2 })).toBe('Reports');
      expect(createT({}, 'en')(k('r'), { count: 2 })).toBe('r');
    });
    it('a plural form wins over the plain key when there is a count', () => {
      const t = createT({ r: 'plain', 'r.other': 'many' }, 'en');
      expect(t(k('r'), { count: 5 })).toBe('many');
      expect(t(k('r'))).toBe('plain');
    });
    it('ignores a non-numeric count', () => {
      const t = createT({ 'r.one': 'one', 'r.other': 'other', r: 'plain' }, 'en');
      expect(t(k('r'), { count: 'x' })).toBe('plain');
    });
  });

  it('survives a locale the runtime does not know', () => {
    const t = createT({ a: 'x', 'p.one': '1', 'p.other': 'n' }, 'not a locale');
    expect(t(k('a'))).toBe('x');
    expect(t(k('p'), { count: 2 })).toBe('n');
  });
});

describe('the English catalog', () => {
  it('is the player catalog, not the hub one: no hub.* key', () => {
    expect(Object.keys(en).filter((k) => k.startsWith('hub.'))).toEqual([]);
  });
  const keys = Object.keys(en);
  it('is keyed player.* and has no empty text', () => {
    expect(keys.length).toBeGreaterThan(50);
    for (const key of keys) {
      expect(key, key).toMatch(/^player(\.[a-z][A-Za-z0-9_]*)+$/);
      expect(text(key), key).not.toBe('');
    }
  });
  it('gives every plural form both .one and .other', () => {
    const bases = new Set(keys.filter((x) => /\.(zero|one|two|few|many|other)$/.test(x)).map((x) => x.replace(/\.[a-z]+$/, '')));
    expect(bases.size).toBeGreaterThanOrEqual(2);
    for (const base of bases) {
      expect(keys, base).toContain(`${base}.one`);
      expect(keys, base).toContain(`${base}.other`);
    }
  });
  it('uses {count} in every .other form', () => {
    for (const key of keys.filter((x) => x.endsWith('.other'))) expect(text(key), key).toContain('{count}');
  });
  it('writes every placeholder as {name} with letters only', () => {
    for (const key of keys) {
      for (const m of text(key).matchAll(/\{([^}]*)\}/g)) expect(m[1], key).toMatch(/^[a-zA-Z]+$/);
    }
  });
  it('is plain: no marketing words, no em dash, no exclamation mark', () => {
    for (const key of keys) {
      expect(text(key), key).not.toMatch(/[—!]/);
      expect(text(key), key).not.toMatch(/\b(seamless|powerful|robust|blazing)\b/i);
    }
  });
});
