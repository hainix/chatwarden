import { describe, expect, it } from 'vitest';
import {
  MatcherBuildError,
  buildMatcher,
  collapseLikePreset,
  foldPhrase,
  foldTerm,
  stripInvisible,
} from '../src/index.js';
import { SYNTHETIC_EXCEPTIONS, SYNTHETIC_TERMS, UNLISTED_WORDS } from '../src/fixtures/syntheticPack.js';
import { exception, packExceptionRows, packTermRows, term } from './fixtures/rows.js';

const pack = () => buildMatcher(packTermRows(), packExceptionRows());

describe('the synthetic pack', () => {
  const m = pack();

  it('every term is a unique lowercase word, built without error', () => {
    const words = SYNTHETIC_TERMS.map((t) => t.term);
    expect(new Set(words).size).toBe(words.length);
    for (const w of words) expect(w).toMatch(/^[a-z]+$/);
    expect(() => pack()).not.toThrow();
  });

  it('every positive line is refused', () => {
    const misses = SYNTHETIC_TERMS.flatMap((t) => t.positive).filter((l) => m.match(l) === null);
    expect(misses).toEqual([]);
  });

  it('no negative line is refused', () => {
    const hits = SYNTHETIC_TERMS.flatMap((t) => t.negative).filter((l) => m.match(l) !== null);
    expect(hits).toEqual([]);
  });

  it('every term has at least 4 positives and 4 negatives', () => {
    for (const t of SYNTHETIC_TERMS) {
      expect(t.positive.length, t.term).toBeGreaterThanOrEqual(4);
      expect(t.negative.length, t.term).toBeGreaterThanOrEqual(4);
    }
  });

  it('every positive hits its own row (checked with a one-row matcher, so no line is credited to the wrong term)', () => {
    for (const t of SYNTHETIC_TERMS) {
      const single = buildMatcher([term(t.id, t.term)], packExceptionRows());
      for (const line of t.positive) expect(single.match(line), `${t.term}: ${line}`).toEqual({ termId: t.id });
    }
  });

  it('unlisted invented words are not refused (only listed terms block)', () => {
    for (const w of UNLISTED_WORDS) {
      expect(m.match(w), w).toBeNull();
      expect(m.match(`${w}!`), w).toBeNull();
      expect(m.match(`you ${w}, ${w.toUpperCase()}`), w).toBeNull();
    }
  });

  it('every exception phrase contains a pack term', () => {
    const words = SYNTHETIC_TERMS.map((t) => t.term);
    for (const e of SYNTHETIC_EXCEPTIONS) {
      expect(e.phrase.split(' ').some((w) => words.includes(w)), e.phrase).toBe(true);
    }
  });
});

describe('Review Focus 4: unicode evasion and innocent embeddings', () => {
  const m = pack();
  it('zero-width joiner inside a term blocks', () => {
    expect(m.match('zor\u200Dbak')).toEqual({ termId: 'syn:zorbak' });
  });
  it('combining accents block', () => {
    expect(m.match('zórbák')).toEqual({ termId: 'syn:zorbak' });
    expect(m.match('zo\u0308rbak')).not.toBeNull();
    expect(m.match('z\u0301o\u0300rbak')).not.toBeNull();
  });
  it('fullwidth letters block (via NFKD)', () => {
    expect(m.match('ｚｏｒｂａｋ')).toEqual({ termId: 'syn:zorbak' });
    expect(m.match('ＺＯＲＢＡＫ')).not.toBeNull();
  });
  it('glued punctuation blocks', () => {
    expect(m.match('zorbak!')).not.toBeNull();
    expect(m.match('(zorbak)')).not.toBeNull();
  });
  it('innocent embedding passes', () => {
    expect(m.match('snerpington')).toBeNull();
    expect(m.match('the snerpington road')).toBeNull();
  });
  it('spaced letters do NOT block (documented residual)', () => {
    expect(m.match('z o r b a k')).toBeNull();
  });
  it('malformed term throws MatcherBuildError naming the row', () => {
    for (const [id, bad] of [['row-spaced', 'zo rbak'], ['row-collapse', 'zzz']] as const) {
      try {
        buildMatcher([term(id, bad)], []);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MatcherBuildError);
        expect((e as MatcherBuildError).rowId).toBe(id);
        expect((e as Error).message).toContain(id);
      }
    }
  });
});

describe('trailing and surrounding punctuation does not defeat whole-word matching', () => {
  const m = pack();
  it.each([
    'zorbak!',
    'zorbak!!',
    'quissel.',
    'vlemmo?',
    'fenrisk;',
    'zorbak,',
    '"quissel"',
    '(zorbak)',
    '$zorbak',
    'zorbak/quissel',
    '@quissel',
    'you quissel!!! leave',
    'seu drakkuun|',
    'ZORBAK!',
    'f3nr1sk!',
  ])('refuses %s', (line) => {
    expect(m.match(line)).not.toBeNull();
  });

  it('a plural row with glued punctuation is refused', () => {
    const mm = buildMatcher([term('p', 'zorbaks')], []);
    expect(mm.match('zorbaks!')).toEqual({ termId: 'p' });
    expect(mm.match('(zorbaks)')).toEqual({ termId: 'p' });
  });

  it('a leetspeak "!" or digit inside the word still resolves to the letter', () => {
    expect(m.match('fenr!sk')).not.toBeNull();
    expect(m.match('qu1ss3l')).not.toBeNull();
    expect(m.match('zorb4k')).not.toBeNull();
    expect(m.match('f3nr1sk')).toEqual({ termId: 'syn:fenrisk' });
  });

  it('exclamation marks on innocent text do not create matches', () => {
    expect(m.match('gg wp!')).toBeNull();
    expect(m.match('Zorbek!')).toBeNull();
    expect(m.match('Snerpington!')).toBeNull();
    expect(m.match('exile it!!')).toBeNull();
    expect(m.match('Hullbreaker! Horror!')).toBeNull();
  });

  it('the second pass only adds blocks: text without those marks matches as before', () => {
    expect(m.match('zorbak')).not.toBeNull();
    expect(m.match('plain words here')).toBeNull();
  });
});

describe('whole-word behaviour', () => {
  const m = pack();
  it('does not match inside longer words', () => {
    for (const w of ['snerpington', 'snerping', 'zorbakian', 'zorbaking', 'vlemmoid', 'unquissel', 'drakkuunish', 'zorbek']) {
      expect(m.match(`${w} is a word`), w).toBeNull();
    }
  });

  it('plurals are their own rows: "zorbaks" matches via its row, not "zorbak"', () => {
    const only = buildMatcher([term('a', 'zorbak')], []);
    expect(only.match('zorbaks')).toBeNull();
    expect(only.match('zorbak')).toEqual({ termId: 'a' });
  });

  it('a singular is fine when only the plural is listed', () => {
    const plural = buildMatcher([term('p', 'vlemmos')], []);
    expect(plural.match('vlemmo sauce goes in the pot')).toBeNull();
    expect(plural.match('you vlemmos')).toEqual({ termId: 'p' });
  });

  it('returns the id of the row that matched', () => {
    const mm = buildMatcher([term('t1', 'zorbak'), term('t2', 'quissel')], []);
    expect(mm.match('you quissel')).toEqual({ termId: 't2' });
    expect(mm.match('you zorbak')).toEqual({ termId: 't1' });
  });

  it('empty and whitespace-only text is clean', () => {
    expect(m.match('')).toBeNull();
    expect(m.match('   ')).toBeNull();
    expect(m.match('\n\t')).toBeNull();
  });

  it('a term spelled with a doubled letter the transformers collapse still matches (vlemmo, drakkuun)', () => {
    expect(m.match('vlemmo')).not.toBeNull();
    expect(m.match('VLEMMO')).not.toBeNull();
    const custom = buildMatcher([term('k', 'drakkuun')], []);
    expect(custom.match('drakkuun')).toEqual({ termId: 'k' });
    expect(custom.match('drakun')).toEqual({ termId: 'k' });
    expect(custom.match('drakkun')).toEqual({ termId: 'k' });
  });

  it('a doubled letter the preset keeps (quissel) is not matched by the single-letter spelling', () => {
    const custom = buildMatcher([term('q', 'quissel')], []);
    expect(custom.match('quissel')).toEqual({ termId: 'q' });
    expect(custom.match('quisssel')).toEqual({ termId: 'q' });
    expect(custom.match('quisel')).toBeNull();
  });

  it('a moderator-entered term is normalised: case, padding and accents', () => {
    const mm = buildMatcher([term('x', '  ZÓRBAK ')], []);
    expect(mm.match('eres un zorbak')).toEqual({ termId: 'x' });
    expect(mm.match('ERES UN ZÓRBAK')).toEqual({ termId: 'x' });
  });

  it('a term does not match across a word break', () => {
    expect(m.match('zor bak')).toBeNull();
    expect(m.match('zorbak-ian')).not.toBeNull(); // the hyphen ends the word: a documented precision choice
  });
});

describe('collapseLikePreset, foldTerm, foldPhrase', () => {
  it('collapses repeats like the preset: one of each letter, two of b/e/o/l/s/g', () => {
    expect(collapseLikePreset('vlemmo')).toBe('vlemo');
    expect(collapseLikePreset('drakkuun')).toBe('drakun');
    expect(collapseLikePreset('quissel')).toBe('quissel');
    expect(collapseLikePreset('quisssel')).toBe('quissel');
    expect(collapseLikePreset('booo')).toBe('boo');
    expect(collapseLikePreset('zzz')).toBe('z');
    expect(collapseLikePreset('')).toBe('');
  });
  it('foldTerm strips accents, trims and lowercases', () => {
    expect(foldTerm('  ZÓRBÁK ')).toBe('zorbak');
    expect(foldTerm('zorbak')).toBe('zorbak');
  });
  it('foldPhrase trims, ASCII-lowercases and collapses whitespace runs', () => {
    expect(foldPhrase('  Tarvo   LAKE ')).toBe('tarvo lake');
    expect(foldPhrase('tarvo\t\nlake')).toBe('tarvo lake');
  });
});

describe('exceptions', () => {
  const m = pack();

  it('every pack exception phrase suppresses its match', () => {
    for (const e of SYNTHETIC_EXCEPTIONS) {
      expect(m.match(e.phrase), e.phrase).toBeNull();
      expect(m.match(`sorry, ${e.phrase} today`), e.phrase).toBeNull();
      expect(m.match(e.phrase.toUpperCase()), e.phrase).toBeNull();
      expect(m.match(`${e.phrase}!`), e.phrase).toBeNull();
    }
  });

  it('the bare term in another sentence still blocks, for every exception phrase', () => {
    for (const e of SYNTHETIC_EXCEPTIONS) {
      for (const t of SYNTHETIC_TERMS.map((s) => s.term).filter((w) => e.phrase.split(' ').includes(w))) {
        expect(m.match(`you ${t}`), `${t} (from ${e.phrase})`).not.toBeNull();
        expect(m.match(`nobody likes a ${t}, just leave`), `${t} (from ${e.phrase})`).not.toBeNull();
      }
    }
  });

  it('the headline cases', () => {
    expect(m.match('sorry, I walked to tarvo lake')).toBeNull();
    expect(m.match('you tarvo')).not.toBeNull();
    expect(m.match('he is glarn zorbak today')).toBeNull();
    expect(m.match('you zorbak')).not.toBeNull();
  });

  it('is narrow: neighbouring uses of the same term still block', () => {
    expect(m.match('tarvo, lake')).not.toBeNull();
    expect(m.match('tarvo and lake')).not.toBeNull();
    expect(m.match('glarn, zorbak')).not.toBeNull();
    expect(m.match('glarn and zorbak')).not.toBeNull();
    expect(m.match('he is zorbak')).not.toBeNull();
  });

  it('does not shield a different slur in the same message', () => {
    expect(m.match('tarvo lake quissel')).not.toBeNull();
    expect(m.match('glarn zorbak, you quissel')).not.toBeNull();
    expect(m.match('tarvo lake and ponds, fenrisk')).not.toBeNull();
    expect(m.match('you zorbak, sorry I am glarn zorbak')).not.toBeNull();
  });

  // obscenity's own whitelist is a raw substring search, so a word that merely ENDS in the first letters of an
  // exception phrase ("unglarn zorbak" ~ "glarn zorbak") would suppress the slur. The bounding is done here.
  it.each([
    'unglarn zorbak',
    'xglarn zorbak',
    'shut up unglarn zorbak',
    'myglarn zorbak',
    'you cruel unglarn zorbak',
    'run unglarn zorbak',
    'shut up, unglarn zorbak',
  ])('left edge is word-bounded: %s still blocks', (line) => {
    expect(m.match(line)).not.toBeNull();
  });

  it.each([
    'tarvo lakes',
    'tarvo lakeside',
    'tarvo laked',
    'tarvo lakes and ponds',
    'tarvo lakex',
  ])('right edge is word-bounded: %s still blocks', (line) => {
    expect(m.match(line)).not.toBeNull();
  });

  it('digits count as word characters at the edges', () => {
    expect(m.match('9glarn zorbak')).not.toBeNull();
    expect(m.match('1glarn zorbak')).not.toBeNull();
    expect(m.match('tarvo lake9')).not.toBeNull();
    expect(m.match('tarvo lake1')).not.toBeNull();
  });

  it('every pack exception passes in ordinary sentences, with non-letters on either side', () => {
    for (const e of SYNTHETIC_EXCEPTIONS) {
      for (const line of [
        `we talked about ${e.phrase} again yesterday`,
        `${e.phrase}, ok?`,
        `(${e.phrase})`,
        `"${e.phrase}" he said`,
        `so ${e.phrase.replace(/ /g, '   ')}.`,
        `${e.phrase.toUpperCase()}!`,
      ]) {
        expect(m.match(line), line).toBeNull();
      }
    }
  });

  it('the slur must lie INSIDE the bounded occurrence, not merely touch it', () => {
    expect(m.match('tarvo lake tarvo')).not.toBeNull();
    expect(m.match('tarvo tarvo lake')).not.toBeNull();
    expect(m.match('tarvo lake, you tarvo, tarvo lake')).not.toBeNull();
    expect(m.match('glarn zorbak zorbak')).not.toBeNull();
    expect(m.match('zorbak glarn zorbak')).not.toBeNull();
  });

  it('an exception phrase containing leetspeak punctuation still works (matched on the original text)', () => {
    const slash = buildMatcher([term('a', 'vlemmo')], [exception('e', 'vlemmo/swap')]);
    expect(slash.match('the vlemmo/swap kit')).toBeNull();
    expect(slash.match('a vlemmo/swapper')).not.toBeNull();
    expect(slash.match('you vlemmo')).not.toBeNull();
    const paren = buildMatcher([term('a', 'vlemmo')], [exception('e', 'vlemmo (fluid)')]);
    expect(paren.match('check the vlemmo (fluid) level')).toBeNull();
    expect(paren.match('vlemmo (fluid')).not.toBeNull();
    const bang = buildMatcher([term('a', 'zorbak')], [exception('e', 'zorbak! time')]);
    expect(bang.match('zorbak! time')).toBeNull();
    const dollar = buildMatcher([term('a', 'zorbak')], [exception('e', 'zorbak$ time')]);
    expect(dollar.match('zorbak$ time')).toBeNull();
    expect(dollar.match('zorbak$ times')).not.toBeNull();
  });

  it('exception rows are matched case-insensitively with collapsed spaces', () => {
    const mm = buildMatcher([term('a', 'zorbak')], [exception('e', 'Time Zorbak')]);
    expect(mm.match('the time   zorbak effect')).toBeNull();
    expect(mm.match('the TIME\tZORBAK effect')).toBeNull();
    expect(mm.match('you zorbak')).not.toBeNull();
  });

  it('an accented exception phrase lines up with accented text', () => {
    const mm = buildMatcher([term('a', 'zorbak')], [exception('e', 'Glárn Zórbak')]);
    expect(mm.match('glarn zorbak')).toBeNull();
    expect(mm.match('GLÁRN ZÓRBAK')).toBeNull();
    expect(mm.match('unglarn zorbak')).not.toBeNull();
  });

  it('inactive exceptions are ignored', () => {
    const mm = buildMatcher([term('a', 'zorbak')], [exception('e', 'glarn zorbak', false)]);
    expect(mm.match('glarn zorbak')).toEqual({ termId: 'a' });
  });

  it('a malformed exception phrase throws MatcherBuildError naming the row', () => {
    expect(() => buildMatcher([term('a', 'zorbak')], [exception('e', '   ')])).toThrow(MatcherBuildError);
    expect(() => buildMatcher([term('a', 'zorbak')], [exception('e', '')])).toThrow(MatcherBuildError);
    try {
      buildMatcher([term('a', 'zorbak')], [exception('ex-9', '')]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as MatcherBuildError).rowId).toBe('ex-9');
      expect((e as Error).message).toContain('ex-9');
    }
  });

  it('a malformed but inactive exception is ignored', () => {
    expect(() => buildMatcher([term('a', 'zorbak')], [exception('e', '', false)])).not.toThrow();
  });

  it('an exception phrase made only of invisible characters is malformed', () => {
    expect(() => buildMatcher([term('a', 'zorbak')], [exception('e', '\u200B\u200D')])).toThrow(MatcherBuildError);
  });
});

describe('term rows', () => {
  it('an inactive term is ignored', () => {
    const mm = buildMatcher([term('a', 'zorbak', false), term('b', 'quissel')], []);
    expect(mm.match('zorbak')).toBeNull();
    expect(mm.match('quissel')).toEqual({ termId: 'b' });
  });

  it('a malformed but inactive term does not throw', () => {
    expect(() => buildMatcher([term('a', 'a b[c', false)], [])).not.toThrow();
  });

  it('no active terms: matches nothing, exceptions alone are harmless', () => {
    const mm = buildMatcher([], [exception('e', 'glarn zorbak')]);
    expect(mm.match('zorbak')).toBeNull();
    const none = buildMatcher([term('a', 'zorbak', false)], []);
    expect(none.match('zorbak')).toBeNull();
    const nothing = buildMatcher([], []);
    expect(nothing.match('zorbak')).toBeNull();
  });

  it('no active terms: a malformed ACTIVE exception still throws (rows are validated before the shortcut)', () => {
    expect(() => buildMatcher([], [exception('e', '')])).toThrow(MatcherBuildError);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['two words', 'two words'],
    ['pattern bracket', 'ab[c]'],
    ['pattern optional', 'abc?'],
    ['pattern pipe', '|abc|'],
    ['pattern backslash', 'ab\\c'],
    ['digits', 'abc123'],
    ['punctuation', 'ab-cd'],
    ['single letter', 'a'],
    ['two letters', 'ab'],
    ['emoji', 'ab😀cd'],
    ['non-latin', '日本語'],
  ])('a malformed term (%s) throws MatcherBuildError', (_label, bad) => {
    expect(() => buildMatcher([term('bad', bad)], [])).toThrow(MatcherBuildError);
  });

  // The minimum length applies to the COLLAPSED form: "zzz" collapses to "z" and would otherwise block
  // every standalone "z".
  it.each([
    ['zzz', 'zzz'],
    ['aaa', 'aaa'],
    ['ooo', 'ooo'],
    ['zzzz', 'zzzz'],
    ['eee', 'eee'],
    ['aab', 'aab'],
    ['ooo with case', 'OOO'],
    ['accented', 'ááá'],
  ])('a term that collapses below the minimum length throws (%s)', (_label, bad) => {
    expect(() => buildMatcher([term('collapse-row', bad)], [])).toThrow(MatcherBuildError);
  });

  it('the collapsed-length error names the row id', () => {
    expect(() => buildMatcher([term('row-zzz', 'zzz')], [])).toThrow(/row-zzz/);
  });

  it('a standalone letter is never blocked by any build that succeeds', () => {
    const mm = buildMatcher([term('a', 'zorbak')], []);
    expect(mm.match('z')).toBeNull();
    expect(mm.match('ok z')).toBeNull();
  });

  it('the minimum is exactly 3: a three-letter plain term builds and blocks', () => {
    const mm = buildMatcher([term('a', 'zap')], []);
    expect(mm.match('you zap')).toEqual({ termId: 'a' });
  });

  it.each(['zorbak', 'booo', 'good', 'vlemmo', 'drakkuun', 'quissel', 'zap'])(
    'control: a legitimate term (%s) still builds and matches itself',
    (word) => {
      const mm = buildMatcher([term('ok', word)], []);
      expect(mm.match(`you ${word}`)).toEqual({ termId: 'ok' });
    },
  );

  it('the build error names the offending row', () => {
    try {
      buildMatcher([term('row-42', 'no good')], []);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MatcherBuildError);
      expect((e as Error).message).toContain('row-42');
      expect((e as MatcherBuildError).rowId).toBe('row-42');
    }
  });

  it('MatcherBuildError is an Error', () => {
    expect(new MatcherBuildError('x')).toBeInstanceOf(Error);
    expect(new MatcherBuildError('x').name).toBe('MatcherBuildError');
    expect(new MatcherBuildError('x').rowId).toBeUndefined();
    expect(new MatcherBuildError('x', 'r1').rowId).toBe('r1');
  });
});

describe('invisible-character evasion', () => {
  const m = pack();
  // Each filler sits inside the term; none of them is a letter, a space or ASCII punctuation, so without
  // stripInvisible the word would fall apart and slip through.
  const FILLERS: [string, string][] = [
    ['zero-width space', '\u200B'],
    ['zero-width joiner', '\u200D'],
    ['zero-width non-joiner', '\u200C'],
    ['soft hyphen', '\u00AD'],
    ['word joiner', '\u2060'],
    ['byte order mark', '\uFEFF'],
    ['right-to-left mark', '\u200F'],
    ['bidi override', '\u202E'],
    ['hangul filler U+3164', '\u3164'],
    ['halfwidth hangul filler U+FFA0', '\uFFA0'],
    ['hangul choseong filler U+115F', '\u115F'],
    ['hangul jungseong filler U+1160', '\u1160'],
    ['braille blank U+2800', '\u2800'],
    ['combining grapheme joiner U+034F', '\u034F'],
    ['variation selector U+FE0F', '\uFE0F'],
    ['variation selector U+FE00', '\uFE00'],
  ];

  it.each(FILLERS)('blocks a term split by a %s', (_n, ch) => {
    expect(m.match(`zor${ch}bak`)).not.toBeNull();
    expect(m.match(`you z${ch}orbak!`)).not.toBeNull();
    expect(m.match(`ZORBA${ch}K`)).not.toBeNull();
    expect(m.match(`zo${ch}r${ch}b${ch}ak`)).not.toBeNull();
    expect(m.match(`${ch}zorbak${ch}`)).not.toBeNull();
  });

  it('blocks a term whose letter carries a combining mark (decomposed diaeresis)', () => {
    expect(m.match('zo\u0308rbak')).not.toBeNull();
    expect(m.match('z\u0301o\u0300rbak')).not.toBeNull();
  });

  it('blocks in the leet-punctuation second pass too', () => {
    expect(m.match('(zor\u200Dbak)')).not.toBeNull();
    expect(m.match('zor\u3164bak!')).not.toBeNull();
  });

  it('does not touch the delivered text: it is a matching-only view', () => {
    const text = 'zor\u200Dbak';
    m.match(text);
    expect(text).toBe('zor\u200Dbak');
  });

  it('a clean word that happens to carry an invisible character is still allowed', () => {
    expect(m.match('hel\u200Blo there')).toBeNull();
    expect(m.match('cafe\u0301 au lait')).toBeNull();
    expect(m.match('Moon\u200B Ring')).toBeNull();
  });

  it('an invisible character beside an exception phrase does not make the exception count', () => {
    // a hidden character used to read as a clean edge, so a hidden-character prefix would borrow the exception
    expect(m.match('un\u200Bglarn zorbak')).not.toBeNull();
    expect(m.match('unglarn\u200B zorbak')).not.toBeNull();
    expect(m.match('un\u3164glarn zorbak')).not.toBeNull();
    expect(m.match('tarvo lake\u200Bs')).not.toBeNull();
    expect(m.match('glarn zorbak')).toBeNull();
    expect(m.match('sorry, I am glarn zorbak')).toBeNull();
    // an invisible character INSIDE the phrase leaves it excepted: the visible text is the phrase
    expect(m.match('glarn\u200B zorbak')).toBeNull();
    expect(m.match('tarvo\u200D lake')).toBeNull();
  });

  it('separators stay the accepted precision-first residual (not caught)', () => {
    expect(m.match('zor-bak')).toBeNull();
    expect(m.match('z o r b a k')).toBeNull();
    expect(m.match('z.o.r.b.a.k')).toBeNull();
  });
});

describe('stripInvisible', () => {
  it('removes format characters, fillers and combining marks', () => {
    expect(stripInvisible('a\u200Bb\u200Dc\u00ADd\u2060e\uFEFFf')).toBe('abcdef');
    expect(stripInvisible('a\u3164b\uFFA0c\u115Fd\u1160e\u2800f\u034Fg\uFE0Fh\uFE00i')).toBe('abcdefghi');
    expect(stripInvisible('zo\u0308rbak')).toBe('zorbak');
    expect(stripInvisible('e\u0301')).toBe('e');
  });
  it('folds compatibility forms (NFKD) and leaves ordinary text alone', () => {
    expect(stripInvisible('ＺＯ')).toBe('ZO');
    expect(stripInvisible('plain text, 123 !?')).toBe('plain text, 123 !?');
    expect(stripInvisible('')).toBe('');
  });
  it('keeps real spaces and non-Latin letters', () => {
    expect(stripInvisible('a b')).toBe('a b');
    expect(stripInvisible('日本語')).toBe('日本語');
  });
});
