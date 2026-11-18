import { describe, expect, it } from 'vitest';
import { buildMatcher } from '../src/index.js';
import type { Matcher, TermRow } from '../src/index.js';

// L1: `spans()` still gives exact ranges on the text as typed for the unspaced path: after a dropped zero-width character, a half-width katakana, an expansion (one character that reads as two) and a combining
// sequence. Invented strings only.

const row = (term: string, language: string, matchMode?: TermRow['matchMode'], id = term): TermRow => ({ id, term, language, active: true, ...(matchMode === undefined ? {} : { matchMode }) });
const build = (...rows: TermRow[]): Matcher => buildMatcher(rows, []);
const said = (m: Matcher, text: string): string[] => (m.spans?.(text) ?? []).map((s) => text.slice(s.start, s.end));

const HAN = '\u4f50\u5c14\u5df4\u514b';
const KATA = '\u30be\u30eb\u30d0\u30af';
const THAI = '\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01';

describe('exact ranges', () => {
  it('the original text of a hit is recovered exactly, in the middle of a line and at its edges', () => {
    const m = build(row(HAN, 'zh'));
    expect(said(m, `\u4f60\u597d${HAN}\u518d\u89c1`)).toEqual([HAN]);
    expect(said(m, HAN)).toEqual([HAN]);
    expect(said(m, `x${HAN}y`)).toEqual([HAN]);
    expect(m.spans?.(`ab${HAN}`)).toEqual([{ start: 2, end: 6, termId: HAN }]);
  });

  it('includes a zero-width character inside the hit, and one outside it stays outside', () => {
    const m = build(row(HAN, 'zh'));
    const typed = `\u4f50\u200b\u5c14\u200d\u5df4\u2060\u514b`;
    expect(said(m, typed)).toEqual([typed]);
    expect(said(m, `\u200b${HAN}\u200b`)).toEqual([HAN]);
    expect(said(m, `\u4f60\u597d\u200b${HAN}`)).toEqual([HAN]);
  });

  it('a half-width katakana is one hit of the letters it becomes, its voiced mark included', () => {
    const m = build(row(KATA, 'ja'));
    const half = '\uff7f\uff9e\uff99\uff8a\uff9e\uff78';
    const typed = `\u3053\u308c\u306f${half}\u3067\u3059`;
    expect(m.match(typed)).toEqual({ termId: KATA });
    expect(said(m, typed)).toEqual([half]);
  });

  it('a character that reads as two (a squared katakana word) is one range', () => {
    const m = build(row('\u30ad\u30ed\u30e1', 'ja', 'contains', 'kiro'));
    const typed = `\u3053\u308c\u306f\u3314\u30e1\u3067\u3059`;
    expect(typed.normalize('NFKC')).toContain('\u30ad\u30ed\u30e1');
    expect(said(m, typed)).toEqual(['\u3314\u30e1']);
  });

  it('a combining sequence (Thai vowel and tone marks) is recovered whole', () => {
    const m = build(row(THAI, 'th'));
    const typed = `\u0e09\u0e31\u0e19\u0e40\u0e2b\u0e47\u0e19${THAI}\u0e17\u0e35\u0e48\u0e19\u0e31\u0e48\u0e19`;
    expect(said(m, typed)).toEqual([THAI]);
    const spaced = `${THAI.slice(0, 4)}\u200c${THAI.slice(4)}`;
    expect(said(m, spaced)).toEqual([spaced]);
  });

  it('an astral Han character (two UTF-16 units) is one, and the range counts both units', () => {
    const term = '\ud840\udc00\ud840\udc01';
    const m = build(row(term, 'zh'));
    expect(m.spans?.(`a${term}b`)).toEqual([{ start: 1, end: 5, termId: term }]);
  });

  it('the hiragana and katakana spellings both give their own ranges', () => {
    const m = build(row(KATA, 'ja'));
    const hira = '\u305e\u308b\u3070\u304f';
    expect(said(m, `\u3053\u308c\u306f${hira}\u3067\u3059`)).toEqual([hira]);
  });
});

describe('merging and order', () => {
  it('overlapping hits merge into one range, and hits that only touch stay separate', () => {
    const over = build(row('\u30be\u30eb\u30d0', 'ja', 'contains', 'a'), row('\u30eb\u30d0\u30af', 'ja', 'contains', 'b'));
    expect(over.spans?.(KATA)).toEqual([{ start: 0, end: 4, termId: 'a' }]);
    const touch = build(row('\u30be\u30eb\u30d0', 'ja', 'contains', 'a'), row('\u30af\u30b9\u30ad', 'ja', 'contains', 'b'));
    expect(touch.spans?.(`${KATA}\u30b9\u30ad`)).toEqual([
      { start: 0, end: 3, termId: 'a' },
      { start: 3, end: 6, termId: 'b' },
    ]);
  });

  it('a Latin hit and a Han hit in one line both appear, in order, with their own term ids', () => {
    const m = build(row('zorbak', 'en', undefined, 'lat'), row(HAN, 'zh', undefined, 'han'));
    const text = `you zorbak \u4f60\u597d${HAN} and zorbak`;
    expect(said(m, text)).toEqual(['zorbak', HAN, 'zorbak']);
    expect((m.spans?.(text) ?? []).map((s) => s.termId)).toEqual(['lat', 'han', 'lat']);
    const starts = (m.spans?.(text) ?? []).map((s) => s.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('a Latin hit right next to an unspaced one stays its own range', () => {
    const m = build(row('zorbak', 'en', undefined, 'lat'), row('\u4f60\u597d\u5417', 'zh', 'contains', 'han'));
    expect(said(m, 'zorbak\u4f60\u597d\u5417')).toEqual(['zorbak', '\u4f60\u597d\u5417']);
  });
});

describe('spans and match agree', () => {
  it('spans is empty exactly when match is null, over a set of lines of both kinds', () => {
    const m = build(row('zorbak', 'en', undefined, 'lat'), row(HAN, 'zh', undefined, 'han'), row(KATA, 'ja', undefined, 'kata'), row(THAI, 'th', undefined, 'thai'));
    const lines = [
      '',
      'hello',
      'zorbak',
      HAN,
      `\u4f60\u597d${HAN}\u518d\u89c1`,
      `\u3053\u308c\u306f${KATA}\u3067\u3059`,
      `${KATA}\u30b9\u30ad\u30fc`,
      `\u0e09\u0e31\u0e19${THAI}`,
      '\u4f60\u597d\u4e16\u754c',
      `${HAN.slice(0, 2)} ${HAN.slice(2)}`,
      '\u4f50\u200b\u5c14\u5df4\u514b',
    ];
    for (const line of lines) {
      const found = m.match(line) !== null;
      expect((m.spans?.(line) ?? []).length > 0, JSON.stringify(line)).toBe(found);
      for (const s of m.spans?.(line) ?? []) {
        expect(s.start).toBeGreaterThanOrEqual(0);
        expect(s.end).toBeLessThanOrEqual(line.length);
        expect(s.end).toBeGreaterThan(s.start);
      }
    }
  });
});
