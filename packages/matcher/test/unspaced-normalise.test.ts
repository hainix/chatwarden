import { describe, expect, it } from 'vitest';
import { buildMatcher, foldKana, normaliseUnspaced } from '../src/index.js';
import { unspacedView } from '../src/unspaced.js';

// L1: how the unspaced path reads text. NFKC, not NFKD: decomposing would turn Japanese \u304c into \u304b plus a mark and then drop the mark, and Thai vowel signs and tone marks are marks that carry the word. Only
// format characters, the blank fillers and variation selectors are removed, and hiragana and katakana are one. Invented strings only.

describe('foldKana', () => {
  it('turns every hiragana into its katakana, one character for one, and leaves everything else alone', () => {
    expect(foldKana('\u305e\u308b\u3070\u304f')).toBe('\u30be\u30eb\u30d0\u30af');
    expect(foldKana('\u3041\u3042\u3093\u3096')).toBe('\u30a1\u30a2\u30f3\u30f6');
    expect(foldKana('\u309d\u309e')).toBe('\u30fd\u30fe');
    for (const same of ['\u30be\u30eb', '\u30fc', '\u4f50\u5c14', '\u0e0b\u0e2d', 'zorbak', '', '\u3001']) expect(foldKana(same), same).toBe(same);
    expect(foldKana('\u3053\u308c\u306f\u30be\u30eb\u4f50')).toBe('\u30b3\u30ec\u30cf\u30be\u30eb\u4f50');
  });

  it('keeps the length (so ranges still line up) and is idempotent', () => {
    for (const text of ['\u3072\u3089\u304c\u306a\u30ab\u30bf\u30ab\u30ca\u6f22\u5b57', '\u3041\u3096', '']) {
      expect(foldKana(text)).toHaveLength(text.length);
      expect(foldKana(foldKana(text))).toBe(foldKana(text));
    }
  });
});

describe('normaliseUnspaced', () => {
  it('Japanese voiced and half-voiced kana survive (\u304c stays \u304c; NFKD would have made it \u304b)', () => {
    expect('\u304c'.normalize('NFKD')).not.toBe('\u304c');
    expect(normaliseUnspaced('\u304c')).toBe('\u30ac');
    expect(normaliseUnspaced('\u3071')).toBe('\u30d1');
    expect(normaliseUnspaced('\u30ac')).toBe('\u30ac');
    expect(normaliseUnspaced('\u304c')).not.toBe(normaliseUnspaced('\u304b'));
    expect(normaliseUnspaced('\u305e\u308b\u3070\u304f')).toBe('\u30be\u30eb\u30d0\u30af');
  });

  it('Thai vowel signs and tone marks survive', () => {
    const word = '\u0e17\u0e35\u0e48\u0e19\u0e31\u0e48\u0e19';
    expect(normaliseUnspaced(word)).toBe(word);
    expect(normaliseUnspaced('\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01')).toBe('\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01');
    expect(normaliseUnspaced(word)).not.toBe(word.normalize('NFKD').replace(/\p{M}/gu, ''));
  });

  it('full-width Latin and half-width katakana fold by NFKC', () => {
    expect(normaliseUnspaced('\uff5a\uff4f\uff52')).toBe('zor');
    expect(normaliseUnspaced('\uff76\uff9e')).toBe('\u30ac');
    expect(normaliseUnspaced('\uff7f\uff9e\uff99\uff8a\uff9e\uff78')).toBe('\u30be\u30eb\u30d0\u30af');
    expect(normaliseUnspaced('\u3314')).toBe('\u30ad\u30ed');
  });

  it('format characters, zero-width joiners, the blank fillers and variation selectors are dropped', () => {
    expect(normaliseUnspaced('\u30be\u200b\u30eb\u200d\u30d0\u2060\u30af')).toBe('\u30be\u30eb\u30d0\u30af');
    expect(normaliseUnspaced('\u4f50\ufe0f\u5c14\ufe00')).toBe('\u4f50\u5c14');
    expect(normaliseUnspaced('\u4f50\u3164\u5c14\u2800\u5df4\u034f')).toBe('\u4f50\u5c14\u5df4');
    expect(normaliseUnspaced('\u4f50\udb40\udd00\u5c14')).toBe('\u4f50\u5c14');
    expect(normaliseUnspaced('\u202e\u4f50\u202c')).toBe('\u4f50');
  });

  it('a Han term and a text read the same way, so a hit does not depend on which side has the odd character', () => {
    expect(normaliseUnspaced('\u4f50\u5c14')).toBe('\u4f50\u5c14');
    expect(normaliseUnspaced('')).toBe('');
  });
});

describe('hiragana and katakana are one spelling', () => {
  const kata = '\u30be\u30eb\u30d0\u30af';
  const hira = '\u305e\u308b\u3070\u304f';
  it('a term in either spelling matches both, and a half-width spelling too', () => {
    const asKata = buildMatcher([{ id: 'k', term: kata, language: 'ja', active: true }], []);
    const asHira = buildMatcher([{ id: 'h', term: hira, language: 'ja', active: true }], []);
    for (const line of [kata, hira, `\u3053\u308c\u306f${kata}\u3067\u3059`, `\u3053\u308c\u306f${hira}\u3067\u3059`, '\uff7f\uff9e\uff99\uff8a\uff9e\uff78']) {
      expect(asKata.match(line)?.termId, JSON.stringify(line)).toBe('k');
      expect(asHira.match(line)?.termId, JSON.stringify(line)).toBe('h');
    }
  });

  it('a kana that differs by one voiced mark is a different word', () => {
    const m = buildMatcher([{ id: 'k', term: kata, language: 'ja', active: true }], []);
    expect(m.match('\u30be\u30eb\u30cf\u30af')).toBeNull();
    expect(m.match('\u305e\u308b\u306f\u304f')).toBeNull();
  });
});

describe('unspacedView', () => {
  it('gives the text, the folded text of the same length, and where every unit came from', () => {
    const raw = 'a\u305e\u200b\u308bb';
    const v = unspacedView(raw);
    expect(v.text).toBe('a\u305e\u308bb');
    expect(v.folded).toBe('a\u30be\u30ebb');
    expect(v.folded).toHaveLength(v.text.length);
    expect(v.from).toHaveLength(v.text.length);
    expect(v.to).toHaveLength(v.text.length);
    // the dropped zero-width space sits inside the cluster of the first kana's follower, never in the output
    expect(v.from[0]).toBe(0);
    expect(v.to[v.text.length - 1]).toBe(raw.length);
    for (let i = 0; i < v.text.length; i += 1) expect(v.to[i]!).toBeGreaterThan(v.from[i]!);
  });

  it('one output unit for each unit of the normalised text, an expansion sharing the range of its character, a mark staying with its letter', () => {
    const v = unspacedView('\u3314');
    expect(v.text).toBe('\u30ad\u30ed');
    expect(v.from).toEqual([0, 0]);
    expect(v.to).toEqual([1, 1]);
    const thai = unspacedView('\u0e17\u0e35\u0e48');
    expect(thai.text).toBe('\u0e17\u0e35\u0e48');
    expect(thai.clusterStart).toEqual([true, false, false]);
    const kata = unspacedView('\uff76\uff9e');
    expect(kata.text).toBe('\u30ac');
    expect(kata.from).toEqual([0]);
    expect(kata.to).toEqual([2]);
  });

  it('an astral character is two output units that start one cluster', () => {
    const v = unspacedView('\ud840\udc00');
    expect(v.text).toBe('\ud840\udc00');
    expect(v.clusterStart).toEqual([true, false]);
    expect(v.from).toEqual([0, 0]);
    expect(v.to).toEqual([2, 2]);
  });

  it('an empty text and a text of only hidden characters give an empty view', () => {
    for (const raw of ['', '\u200b\u200d', '\ufe0f']) {
      const v = unspacedView(raw);
      expect(v.text).toBe('');
      expect(v.from).toEqual([]);
    }
  });
});
