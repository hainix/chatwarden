// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aiEn } from '../src/ai/i18n.js';
import { en } from '../src/i18n.js';
import { es, esAi, esPrivacy } from '../src/locales/es.js';
import { pt, ptAi, ptPrivacy } from '../src/locales/pt.js';
import { privacyEn } from '../src/privacy/i18n.js';

// The moderator guide defines a few words; each has one Spanish and one Portuguese word throughout. The glossary is a comment at the top of
// each locale file, one line per term: `//   <English term> -> <stem>* (<words>)`. This test reads that comment and checks every string whose
// English holds the term: its translation holds the stem. A new translator follows the glossary; a different word fails here.

const TERMS = ['Community Rule', 'ladder', 'sanction', 'strike', 'appeal'] as const;
const ALL = {
  english: { ...en, ...aiEn, ...privacyEn } as Record<string, string>,
  es: { ...es, ...esAi, ...esPrivacy } as Record<string, string>,
  pt: { ...pt, ...ptAi, ...ptPrivacy } as Record<string, string>,
};

function glossary(file: string): Map<string, { stem: string; words: string }> {
  // The comment is ASCII (non-ASCII is written as a \u escape in source): read the escapes back into letters.
  const source = readFileSync(fileURLToPath(new URL(`../src/locales/${file}`, import.meta.url)), 'utf8').replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  const out = new Map<string, { stem: string; words: string }>();
  for (const m of source.matchAll(/^\/\/ {3}(.+?) -> ([^\s*]+)\* \((.+)\)$/gm)) out.set(m[1] as string, { stem: m[2] as string, words: m[3] as string });
  return out;
}

/** The English string holds the term as a word (or the start of one: "sanctions", "appealed"). */
const holds = (text: string, term: string): boolean => new RegExp(`(^|[^A-Za-z])${term}`, 'i').test(text);
const MARKS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
const fold = (s: string): string => s.normalize('NFD').replace(MARKS, '').toLowerCase();

describe.each(['es', 'pt'] as const)('glossary, %s', (locale) => {
  const defined = glossary(`${locale}.ts`);

  it('the glossary comment defines the five terms, each with a stem that its own words hold', () => {
    expect([...defined.keys()].sort()).toEqual([...TERMS].sort());
    for (const [term, { stem, words }] of defined) {
      for (const word of words.split(/,\s*/)) expect(fold(word).includes(fold(stem)), `${term}: ${word}`).toBe(true);
    }
  });

  it.each(TERMS)('every string that holds %s uses its one word', (term) => {
    const { stem } = defined.get(term) ?? { stem: '' };
    const lines = Object.entries(ALL.english).filter(([k, v]) => holds(v, term) && ALL[locale][k] !== undefined);
    const wrong = lines.filter(([k]) => !fold(ALL[locale][k] as string).includes(fold(stem))).map(([k]) => k);
    expect(wrong).toEqual([]);
  });

  it('the terms are used (the glossary is not vacuous for ladder, sanction, Community Rule and appeal)', () => {
    for (const term of ['Community Rule', 'ladder', 'sanction', 'appeal'] as const) {
      expect(Object.values(ALL.english).filter((v) => holds(v, term)).length, term).toBeGreaterThan(3);
    }
  });
});

describe('the controls', () => {
  it('a string that uses another word fails the check', () => {
    expect(fold('Escalera de castigos').includes(fold('escala'))).toBe(false);
    expect(fold('Escala de sanciones').includes(fold('escala'))).toBe(true);
    expect(fold('Sanci' + String.fromCharCode(0xf3) + 'n').includes(fold('sanci'))).toBe(true);
  });
});
