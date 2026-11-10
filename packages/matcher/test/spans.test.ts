import { describe, expect, it } from 'vitest';
import { maskSpans } from '@chatwarden/core';
import { LiveTerms, buildMatcher, type Matcher } from '../src/index.js';
import { MemoryTermStore, SYNTHETIC_TERMS, syntheticTermPack } from '../src/fixtures/index.js';
import { packExceptionRows, packTermRows, term } from './fixtures/rows.js';

const m = () => buildMatcher(packTermRows(), packExceptionRows());
const spansOf = (mm: Matcher, text: string) => mm.spans!(text);
const slices = (mm: Matcher, text: string) => spansOf(mm, text).map((s) => text.slice(s.start, s.end));

describe('spans: basic hits', () => {
  it('a plain hit covers the word, end exclusive, with the term id', () => {
    expect(spansOf(m(), 'you zorbak')).toEqual([{ start: 4, end: 10, termId: 'syn:zorbak' }]);
  });

  it('a clean line has no spans', () => {
    expect(spansOf(m(), 'hello there friend')).toEqual([]);
    expect(spansOf(m(), '')).toEqual([]);
  });

  it('two hits give two spans in order', () => {
    expect(spansOf(m(), 'zorbak and vlemmo')).toEqual([
      { start: 0, end: 6, termId: 'syn:zorbak' },
      { start: 11, end: 17, termId: 'syn:vlemmo' },
    ]);
  });

  it('the same term twice gives two spans', () => {
    expect(slices(m(), 'zorbak zorbak')).toEqual(['zorbak', 'zorbak']);
  });

  it('adjacent separate hits stay separate spans', () => {
    expect(slices(m(), 'drakkuun/vlemmo')).toEqual(['drakkuun', 'vlemmo']);
  });

  it('a glued-punctuation hit covers the word, not the punctuation', () => {
    expect(slices(m(), 'Zorbak!')).toEqual(['Zorbak']);
    expect(slices(m(), '(zorbak)')).toEqual(['zorbak']);
    expect(slices(m(), '"zorbak"')).toEqual(['zorbak']);
    expect(slices(m(), '$zorbak')).toEqual(['zorbak']);
    expect(slices(m(), 'zorbak,')).toEqual(['zorbak']);
    expect(slices(m(), 'you quissel!!! leave')).toEqual(['quissel']);
  });

  it('collapsed doubles and leetspeak are covered whole', () => {
    expect(slices(m(), 'DRAKKUUUN')).toEqual(['DRAKKUUUN']);
    expect(slices(m(), 'vlemmmo')).toEqual(['vlemmmo']);
    expect(slices(m(), 'f3nr1sk!')).toEqual(['f3nr1sk']);
    expect(slices(m(), 'fenr!sk')).toEqual(['fenr!sk']);
  });
});

describe('spans: indices on the original text', () => {
  it('a zero-width joiner inside a term is inside the span', () => {
    expect(spansOf(m(), 'say zor‍bak now')).toEqual([{ start: 4, end: 11, termId: 'syn:zorbak' }]);
  });

  it('several hidden characters inside (soft hyphen, filler, BOM) are inside the span', () => {
    const text = 'zo­rㅤb﻿ak!';
    expect(slices(m(), text)).toEqual(['zo­rㅤb﻿ak']);
  });

  it('hidden characters BEFORE the term do not shift the span', () => {
    expect(spansOf(m(), '​​​zorbak')).toEqual([{ start: 3, end: 9, termId: 'syn:zorbak' }]);
  });

  it('accents (combining marks after NFKD) stay inside the span', () => {
    expect(slices(m(), 'a zórbák b')).toEqual(['zórbák']);
    const decomposed = 'a zórbák b';
    expect(slices(m(), decomposed)).toEqual(['zórbák']);
  });

  it('fullwidth letters map one-to-one', () => {
    expect(spansOf(m(), 'x ｚｏｒｂａｋ y')).toEqual([{ start: 2, end: 8, termId: 'syn:zorbak' }]);
  });

  it('a character that NFKD expands (ligature) before the term does not shift the span', () => {
    expect(slices(m(), 'ﬁﬁ zorbak ①')).toEqual(['zorbak']);
  });

  it('an expanding character right after the term does not widen the span', () => {
    expect(slices(m(), '😀ﬁ vlemmo ﬁ')).toEqual(['vlemmo']);
  });

  it('an expanding character INSIDE a hit maps the end past the whole original character', () => {
    // U+FB01 expands to "fi": "fenrisk" with its "i" written as that ligature minus the f is not possible, so use a
    // term whose letter pair is the ligature: no such synthetic term, so check the mapping through a custom matcher.
    const mm = buildMatcher([term('x', 'wolfik')], []);
    const text = 'a wolﬁk b';
    expect(slices(mm, text)).toEqual(['wolﬁk']);
    expect(spansOf(mm, text)).toEqual([{ start: 2, end: 7, termId: 'x' }]);
  });

  it('a hit ending in an expanding character covers that whole character', () => {
    const mm = buildMatcher([term('x', 'wolfi')], []);
    expect(spansOf(mm, 'wolﬁ')).toEqual([{ start: 0, end: 4, termId: 'x' }]);
  });

  it('a hit starting with an expanding character starts at that character', () => {
    const mm = buildMatcher([term('x', 'fiwol')], []);
    expect(spansOf(mm, 'zz ﬁwol')).toEqual([{ start: 3, end: 7, termId: 'x' }]);
  });

  it('a hit after an astral character is indexed in UTF-16 units', () => {
    expect(spansOf(m(), '😀 zorbak')).toEqual([{ start: 3, end: 9, termId: 'syn:zorbak' }]);
  });

  it('a lone surrogate does not break the map', () => {
    expect(slices(m(), '\uD83D zorbak \uDE00')).toEqual(['zorbak']);
  });

  it('second-pass (leet punctuation) hits keep their offsets after hidden characters', () => {
    expect(slices(m(), '​(zorbak) !quissel!')).toEqual(['zorbak', 'quissel']);
  });
});

describe('spans: exceptions', () => {
  it('an excepted phrase gives no span', () => {
    expect(spansOf(m(), 'sorry, tarvo lake today')).toEqual([]);
    expect(spansOf(m(), 'glarn zorbak')).toEqual([]);
  });

  it('an excepted phrase beside a real hit spans only the real hit', () => {
    expect(spansOf(m(), 'tarvo lake, you tarvo')).toEqual([{ start: 16, end: 21, termId: 'syn:tarvo' }]);
  });

  it('exception edges are word-bounded, so no borrowed exception', () => {
    expect(slices(m(), 'tarvo lakes')).toEqual(['tarvo']);
    expect(slices(m(), 'unglarn zorbak')).toEqual(['zorbak']);
  });

  it('hidden characters inside an exception phrase still honour the exception', () => {
    expect(spansOf(m(), 'tar​vo lake')).toEqual([]);
  });
});

describe('spans: merging and ordering', () => {
  it('the two passes never produce duplicate spans for one hit', () => {
    expect(slices(m(), 'zorbak! fenr!sk')).toEqual(['zorbak', 'fenr!sk']);
    expect(slices(m(), '!zorbak!')).toEqual(['zorbak']);
  });

  it('spans are sorted, non-empty, in range and non-overlapping on every line of the pack', () => {
    const mm = m();
    for (const t of SYNTHETIC_TERMS) {
      for (const line of [...t.positive, ...t.negative]) {
        const s = spansOf(mm, line);
        for (let i = 0; i < s.length; i++) {
          expect(s[i]!.start, line).toBeGreaterThanOrEqual(0);
          expect(s[i]!.end, line).toBeGreaterThan(s[i]!.start);
          expect(s[i]!.end, line).toBeLessThanOrEqual(line.length);
          if (i > 0) expect(s[i]!.start, line).toBeGreaterThanOrEqual(s[i - 1]!.end);
        }
      }
    }
  });
});

describe('spans: inactive and empty matchers', () => {
  it('a matcher with no active term has no spans', () => {
    expect(spansOf(buildMatcher([term('a', 'zorbak', false)], []), 'zorbak')).toEqual([]);
  });

  it('an inactive term gives no span while an active one does', () => {
    const mm = buildMatcher([term('a', 'zorbak', false), term('b', 'vlemmo')], []);
    expect(spansOf(mm, 'zorbak vlemmo')).toEqual([{ start: 7, end: 13, termId: 'b' }]);
  });
});

describe('spans: agree with match over the whole synthetic pack', () => {
  const mm = m();
  const positives = SYNTHETIC_TERMS.flatMap((t) => t.positive);
  const negatives = SYNTHETIC_TERMS.flatMap((t) => t.negative);

  it('spans are empty exactly when match is null (positives and negatives)', () => {
    const disagree = [...positives, ...negatives].filter((l) => (spansOf(mm, l).length === 0) !== (mm.match(l) === null));
    expect(disagree).toEqual([]);
  });

  it('every positive line has a span, every negative none', () => {
    expect(positives.filter((l) => spansOf(mm, l).length === 0)).toEqual([]);
    expect(negatives.filter((l) => spansOf(mm, l).length > 0)).toEqual([]);
  });

  it('the span term ids include the one match reports', () => {
    for (const l of positives) {
      expect(spansOf(mm, l).map((s) => s.termId), l).toContain(mm.match(l)!.termId);
    }
  });

  it('masking each positive line with its spans leaves nothing detectable', () => {
    const left = positives.filter((l) => mm.match(maskSpans(l, spansOf(mm, l))) !== null);
    expect(left).toEqual([]);
  });

  it('masking keeps the line length and masks something', () => {
    for (const l of positives) {
      const masked = maskSpans(l, spansOf(mm, l));
      expect(masked.length).toBe(l.length);
      expect(masked).toContain('*');
    }
  });

  it('masking a negative line leaves it unchanged', () => {
    for (const l of negatives) expect(maskSpans(l, spansOf(mm, l))).toBe(l);
  });

  it('masking lines with hidden characters leaves nothing detectable', () => {
    for (const l of ['zor‍bak', '​z​o​r​b​a​k​', 'v­lemmo!', 'f́enrisk']) {
      expect(mm.match(maskSpans(l, spansOf(mm, l))), l).toBeNull();
    }
  });
});

describe('LiveTerms.spans', () => {
  const clock = { now: () => 1_700_000_000_000 };
  const logger = { warn: () => {} };

  it('delegates to the current matcher, and follows a live change', async () => {
    const live = new LiveTerms({ store: new MemoryTermStore(), pack: syntheticTermPack(), clock, logger });
    await live.load();
    expect(live.spans('you zorbak')).toEqual([{ start: 4, end: 10, termId: 'syn:zorbak' }]);
    expect(live.spans('sorry, tarvo lake today')).toEqual([]);
    expect((await live.change('alice', (e) => e.setTermActive('syn:zorbak', false))).ok).toBe(true);
    expect(live.spans('you zorbak')).toEqual([]);
    expect(live.spans('vlemmo')).toHaveLength(1);
  });

  it('before load (pack fallback) spans agree with match', () => {
    const live = new LiveTerms({ store: new MemoryTermStore(), pack: syntheticTermPack(), clock, logger });
    expect(live.spans('zorbak')).toHaveLength(1);
  });

  it('with no pack and no store terms, spans are empty', () => {
    const live = new LiveTerms({ store: new MemoryTermStore(), pack: null, clock, logger });
    expect(live.spans('zorbak')).toEqual([]);
  });
});
