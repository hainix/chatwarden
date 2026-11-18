import { describe, expect, it } from 'vitest';
import { SYNTHETIC_UNSPACED_TERMS } from '@chatwarden/matcher/fixtures';
import { buildMatcher } from '../src/index.js';
import type { Matcher, TermRow } from '../src/index.js';

// L1: the corpus gate. Every synthetic unspaced term ships with lines it must hit and lines it must not hit, in its script, and the gate checks them with the matcher the term is built into. The gate runs on
// both Node versions in CI because the segmenter's dictionary moves between ICU versions. Invented strings only.

type Fixture = (typeof SYNTHETIC_UNSPACED_TERMS)[number];

const rowOf = (t: Fixture, over: Partial<TermRow> = {}): TermRow => ({ id: t.id, term: t.term, language: t.language, active: true, ...(t.matchMode === undefined ? {} : { matchMode: t.matchMode }), ...over });
const matcherOf = (terms: readonly Fixture[]): Matcher => buildMatcher(terms.map((t) => rowOf(t)), []);

/** The gate: for each fixture, every positive line must hit that term and no negative line may hit anything. Returns the failures as `id: line`. */
function gate(terms: readonly Fixture[], over: (t: Fixture) => Partial<TermRow> = () => ({})): string[] {
  const failures: string[] = [];
  const whole = buildMatcher(terms.map((t) => rowOf(t, over(t))), []);
  for (const t of terms) {
    const own = buildMatcher([rowOf(t, over(t))], []);
    for (const line of t.positive) {
      if (own.match(line)?.termId !== t.id) failures.push(`${t.id}: must hit: ${line}`);
    }
    for (const line of t.negative) {
      if (whole.match(line) !== null) failures.push(`${t.id}: must not hit: ${line}`);
    }
  }
  return failures;
}

describe('the synthetic unspaced terms', () => {
  it('cover Han, Hiragana, Katakana and Thai, each with positive and negative lines', () => {
    expect(SYNTHETIC_UNSPACED_TERMS.length).toBeGreaterThanOrEqual(5);
    const languages = new Set(SYNTHETIC_UNSPACED_TERMS.map((t) => t.language));
    for (const language of ['zh', 'ja', 'th']) expect(languages.has(language), language).toBe(true);
    const scripts = new Set<string>(SYNTHETIC_UNSPACED_TERMS.map((t) => (/\p{Script=Han}/u.test(t.term) ? 'Han' : /\p{Script=Hiragana}/u.test(t.term) ? 'Hiragana' : /\p{Script=Katakana}/u.test(t.term) ? 'Katakana' : /\p{Script=Thai}/u.test(t.term) ? 'Thai' : 'other')));
    for (const script of ['Han', 'Hiragana', 'Katakana', 'Thai']) expect(scripts.has(script), script).toBe(true);
    expect(scripts.has('other')).toBe(false);
  });

  it('every term ships with must-hit and must-not-hit lines in its own script', () => {
    for (const t of SYNTHETIC_UNSPACED_TERMS) {
      expect(t.id, t.id).toMatch(/^syn:/);
      expect(t.positive.length, `${t.id} positives`).toBeGreaterThanOrEqual(2);
      expect(t.negative.length, `${t.id} negatives`).toBeGreaterThanOrEqual(2);
      const script = /\p{Script=Thai}/u.test(t.term) ? /\p{Script=Thai}/u : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
      for (const line of [...t.positive, ...t.negative]) expect(script.test(line), `${t.id}: ${line}`).toBe(true);
      expect(t.mechanism.length).toBeGreaterThan(10);
    }
  });

  it('the gate runs and passes', () => {
    expect(gate(SYNTHETIC_UNSPACED_TERMS)).toEqual([]);
  });

  it('every term is a row the matcher accepts, with a mode its script allows, and the ids are unique', () => {
    const ids = SYNTHETIC_UNSPACED_TERMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => matcherOf(SYNTHETIC_UNSPACED_TERMS)).not.toThrow();
    for (const t of SYNTHETIC_UNSPACED_TERMS) expect(['segment', 'contains', undefined]).toContain(t.matchMode);
  });

  it('a hiragana fixture is read as its katakana spelling: both spellings are among the positives', () => {
    const hira = SYNTHETIC_UNSPACED_TERMS.find((t) => /\p{Script=Hiragana}/u.test(t.term));
    expect(hira).toBeDefined();
    expect(hira?.positive.some((l) => /\p{Script=Katakana}/u.test(l))).toBe(true);
  });

  it('a deliberately loosened term (contains on a short term) fails the gate with the line shown by id', () => {
    const short = SYNTHETIC_UNSPACED_TERMS.find((t) => [...t.term].length <= 3 && t.negative.length > 0 && t.matchMode !== 'contains');
    expect(short, 'a short fixture with a negative line').toBeDefined();
    const loosened = gate(SYNTHETIC_UNSPACED_TERMS, (t) => (t.id === short?.id ? { matchMode: 'contains' as const } : {}));
    expect(loosened.length).toBeGreaterThan(0);
    expect(loosened.some((f) => f.startsWith(`${short?.id}: must not hit: `))).toBe(true);
    // and the control: the same gate with the real modes passes
    expect(gate(SYNTHETIC_UNSPACED_TERMS)).toEqual([]);
  });

  it('a deliberately broken positive fails the gate by id (the gate is not blind)', () => {
    const broken = SYNTHETIC_UNSPACED_TERMS.map((t, i) => (i === 0 ? { ...t, positive: [...t.positive, '\u4f60\u597d'] } : t));
    const found = gate(broken);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^syn:.*: must hit: /);
  });

  it('no fixture holds a real word of abuse: only the invented transliterations and the ordinary words the segmenter tests need', () => {
    const allowed = new Set(['\u4f50\u5c14\u5df4\u514b', '\u5c14\u5df4\u5c3c', '\u30be\u30eb\u30d0\u30af', '\u305e\u308b\u3070\u304f', '\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01', '\u0e1b\u0e23\u0e30\u0e40\u0e17']);
    for (const t of SYNTHETIC_UNSPACED_TERMS) expect(allowed.has(t.term), t.id).toBe(true);
  });
});
