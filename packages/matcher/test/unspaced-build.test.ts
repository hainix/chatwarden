import { afterEach, describe, expect, it } from 'vitest';
import { MatcherBuildError, buildMatcher, isUnspacedTerm, UNSPACED_SCRIPTS } from '../src/index.js';
import type { TermRow } from '../src/index.js';

// L1: what the matcher accepts as a term in a script written without spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar). Every string here is invented: transliterations of the test word zorbak, fragments
// of ordinary place names and runs of one repeated character, never a real slur.

const row = (term: string, language: string, matchMode?: TermRow['matchMode'], id = 'r1', active = true): TermRow => ({ id, term, language, active, ...(matchMode === undefined ? {} : { matchMode }) });
const build = (...rows: TermRow[]) => buildMatcher(rows, []);

function failure(fn: () => unknown): MatcherBuildError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MatcherBuildError);
    return err as MatcherBuildError;
  }
  throw new Error('expected a MatcherBuildError');
}

const HAN = '\u4f50\u5c14\u5df4\u514b'; // zorbak, character by character
const KATA = '\u30be\u30eb\u30d0\u30af';
const HIRA = '\u305e\u308b\u3070\u304f';
const THAI = '\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01';

describe('the script set and isUnspacedTerm', () => {
  it('lists the seven scripts, and a term is unspaced when every letter of it is in one of them', () => {
    expect([...UNSPACED_SCRIPTS]).toEqual(['Han', 'Hiragana', 'Katakana', 'Thai', 'Lao', 'Khmer', 'Myanmar']);
    for (const t of [HAN, KATA, HIRA, THAI, '\u0e9a\u0eb2\u0e81', '\u1780\u17d2\u1780', '\u1019\u1004\u103a']) expect(isUnspacedTerm(t), t).toBe(true);
    for (const t of ['zorbak', 'Zorbak', '', ' ', '\u0437\u043e\u0440', '\uc870\ub974', '12', '\u4f50 \u5c14', '\u4f50\u3001', '\u4f50a']) expect(isUnspacedTerm(t), JSON.stringify(t)).toBe(false);
  });

  it('half-width and full-width forms read as the letters they are (NFKC), and an ideographic comma is punctuation', () => {
    expect(isUnspacedTerm('\uff7f\uff9e\uff99')).toBe(true);
    expect(isUnspacedTerm('\u3001')).toBe(false);
    expect(isUnspacedTerm('\u30fc')).toBe(false);
    expect(isUnspacedTerm('\u30be\u30fc\u30eb')).toBe(true);
  });
});

describe('term rules', () => {
  it('2 code points are accepted for segment and 1 is refused; contains needs 3', () => {
    expect(() => build(row(HAN.slice(0, 2), 'zh'))).not.toThrow();
    expect(failure(() => build(row(HAN.slice(0, 1), 'zh', undefined, 'short'))).rowId).toBe('short');
    expect(failure(() => build(row(HAN.slice(0, 2), 'zh', 'contains', 'c2'))).rowId).toBe('c2');
    expect(() => build(row(HAN.slice(0, 3), 'zh', 'contains'))).not.toThrow();
  });

  it('24 code points are accepted and 25 refused, counted as code points (an astral character is one)', () => {
    expect(() => build(row('\u4f50'.repeat(24), 'zh'))).not.toThrow();
    expect(failure(() => build(row('\u4f50'.repeat(25), 'zh', undefined, 'long'))).rowId).toBe('long');
    const astral = '\ud840\udc00';
    expect(() => build(row(astral.repeat(24), 'zh'))).not.toThrow();
    expect(() => build(row(astral.repeat(25), 'zh'))).toThrow(MatcherBuildError);
  });

  it('the length is the normalised one: a half-width katakana term counts as the letters it becomes', () => {
    expect(() => build(row('\uff7f\uff9e\uff99', 'ja'))).not.toThrow();
    expect(() => build(row('\uff7f\uff9e', 'ja'))).toThrow(MatcherBuildError);
  });

  it('a space, punctuation or a digit inside a term is refused naming the row', () => {
    for (const bad of ['\u4f50 \u5c14', '\u4f50\u3001\u5c14', '\u4f50\u5c14!', '\u4f50\u5c142', '\u4f50\u5c14\u3002', '\u4f50\u5c14\u0e51', '\u4f50\u5c14\u00b7', '\u4f50\u5c14\u30fb\u5df4', '\u4f50\u5c14\u0000']) {
      expect(failure(() => build(row(bad, 'zh', undefined, 'bad-1'))).rowId, JSON.stringify(bad)).toBe('bad-1');
    }
  });

  it('a Han, Hiragana and Katakana mix is accepted for ja, and refused for zh', () => {
    expect(() => build(row('\u30be\u30eb\u4f50\u3070', 'ja'))).not.toThrow();
    expect(() => build(row('\u4f50\u5c14', 'ja'))).not.toThrow();
    expect(() => build(row(KATA, 'ja'))).not.toThrow();
    expect(failure(() => build(row('\u30be\u30eb\u4f50', 'zh', undefined, 'mix'))).rowId).toBe('mix');
    expect(() => build(row(HIRA, 'zh'))).toThrow(MatcherBuildError);
  });

  it('Han with Thai is refused, in either language', () => {
    for (const language of ['zh', 'th', 'ja']) expect(failure(() => build(row('\u4f50\u0e0b\u0e2d', language, undefined, 'both'))).rowId, language).toBe('both');
  });

  it('Cyrillic, Arabic and Hangul are refused as an unsupported script, naming the row id and never the term', () => {
    const terms: Array<[string, string]> = [
      ['\u0417\u043e\u0440\u0431\u0430\u043a', 'ru'],
      ['\u0632\u0648\u0631\u0628\u0643', 'ar'],
      ['\uc870\ub974\ubc15', 'ko'],
      ['\u0436\u043e\u0440', 'zh'],
    ];
    for (const [term, language] of terms) {
      const err = failure(() => build(row(term, language, undefined, 'foreign-7')));
      expect(err.rowId).toBe('foreign-7');
      expect(err.message).toMatch(/not supported/i);
      expect(JSON.stringify([err.message, err.reason])).not.toContain(term);
    }
  });

  it('a Latin-plus-other-script term is refused without echoing the other part', () => {
    const err = failure(() => build(row('zorbak\u0436', 'en', undefined, 'half')));
    expect(err.rowId).toBe('half');
    expect(JSON.stringify([err.message, err.reason])).not.toContain('\u0436');
  });

  it('inactive rows are skipped and not validated', () => {
    expect(() => build(row('\u0436\u043e\u0440', 'ru', undefined, 'a', false), row('\u4f50', 'xx', 'contains', 'b', false), row('', 'zh', 'fuzzy' as never, 'c', false), row(HAN, 'zh'))).not.toThrow();
  });

  it('the Latin rule is unchanged: a plain a-z term builds, a term with a digit or a space is still refused with its row', () => {
    expect(() => build(row('zorbak', 'en'))).not.toThrow();
    expect(failure(() => build(row('zor bak', 'en', undefined, 'sp'))).rowId).toBe('sp');
    expect(failure(() => build(row('zorbak2', 'en', undefined, 'dg'))).rowId).toBe('dg');
  });
});

describe('mode and script must fit', () => {
  it('word on a Han term, and segment or contains on a Latin term, are MatcherBuildErrors', () => {
    expect(failure(() => build(row(HAN, 'zh', 'word', 'w'))).rowId).toBe('w');
    expect(failure(() => build(row('zorbak', 'en', 'segment', 's'))).rowId).toBe('s');
    expect(failure(() => build(row('zorbak', 'en', 'contains', 'c'))).rowId).toBe('c');
  });

  it('a mode that is not one of the three is refused, on either kind of term', () => {
    for (const bad of ['fuzzy', '', 'Segment', 5, {}]) {
      expect(() => build(row(HAN, 'zh', bad as never)), String(bad)).toThrow(MatcherBuildError);
      expect(() => build(row('zorbak', 'en', bad as never)), String(bad)).toThrow(MatcherBuildError);
    }
  });

  it('null and an absent mode pick word for a-z and segment for an unspaced term; word is fine on a Latin term', () => {
    for (const mode of [undefined, null, 'word'] as const) expect(() => build(row('zorbak', 'en', mode as never)), String(mode)).not.toThrow();
    for (const mode of [undefined, null, 'segment', 'contains'] as const) expect(() => build(row(HAN, 'zh', mode as never)), String(mode)).not.toThrow();
    // null is segment: the term does not hit inside a longer dictionary word, and contains does
    const line = '\u6211\u53bb\u8fc7\u963f\u5c14\u5df4\u5c3c\u4e9a\u65c5\u6e38';
    const term = '\u5c14\u5df4\u5c3c';
    expect(build(row(term, 'zh', null)).match(line)).toBeNull();
    expect(build(row(term, 'zh', 'contains')).match(line)).toEqual({ termId: 'r1' });
  });
});

describe('the language of the row', () => {
  it('a language outside zh, ja, th, lo, km and my is a build error for an unspaced term, whatever its case or shape', () => {
    for (const language of ['en', 'xx', '', 'ZH', 'zh-Hans', 'ja-JP', 'th ']) expect(failure(() => build(row(HAN, language, undefined, 'lang'))).rowId, language).toBe('lang');
  });

  it('each script needs its own language: Thai with zh, Han with th, Lao with km are refused; the matching ones are accepted', () => {
    expect(() => build(row(THAI, 'zh'))).toThrow(MatcherBuildError);
    expect(() => build(row(HAN, 'th'))).toThrow(MatcherBuildError);
    expect(() => build(row('\u0e9a\u0eb2\u0e81', 'km'))).toThrow(MatcherBuildError);
    expect(() => build(row(THAI, 'th'))).not.toThrow();
    expect(() => build(row('\u0e9a\u0eb2\u0e81', 'lo'))).not.toThrow();
    expect(() => build(row('\u1780\u17d2\u1780', 'km'))).not.toThrow();
    expect(() => build(row('\u1019\u1004\u103a', 'my'))).not.toThrow();
  });

  it('a Latin term keeps any language, as before', () => {
    for (const language of ['en', 'pt', 'xx', '']) expect(() => build(row('zorbak', language)), language).not.toThrow();
  });
});

describe('a runtime without Intl.Segmenter', () => {
  const real = Intl.Segmenter;
  afterEach(() => {
    (Intl as { Segmenter?: unknown }).Segmenter = real;
  });
  const without = (): void => {
    (Intl as { Segmenter?: unknown }).Segmenter = undefined;
  };

  it('fails buildMatcher with a clear message when an active segment term exists, and builds when none does', () => {
    without();
    const err = failure(() => build(row(HAN, 'zh', undefined, 'needs')));
    expect(err.message).toMatch(/Intl\.Segmenter/);
    expect(JSON.stringify([err.message, err.reason])).not.toContain(HAN);
    expect(() => build(row(HAN, 'zh', 'contains'))).not.toThrow();
    expect(() => build(row('zorbak', 'en'))).not.toThrow();
    expect(() => build(row(HAN, 'zh', undefined, 'off', false))).not.toThrow();
    expect(() => build()).not.toThrow();
  });

  it('a contains matcher with no segmenter still matches', () => {
    without();
    const m = build(row(HAN, 'zh', 'contains'));
    expect(m.match(`\u4f60\u597d${HAN}\u518d\u89c1`)).toEqual({ termId: 'r1' });
    expect(m.match('\u4f60\u597d\u518d\u89c1')).toBeNull();
  });
});

describe('exceptions', () => {
  it('an exception that spans a Latin and a Han part is refused at build with the row id', () => {
    for (const phrase of ['ab \u4f60\u597d', 'ab\u4f60\u597d', '\u4f60\u597dab']) {
      const err = failure(() => buildMatcher([row(HAN, 'zh')], [{ id: 'mixed-1', phrase, language: 'zh', active: true }]));
      expect(err.rowId, phrase).toBe('mixed-1');
      expect(JSON.stringify([err.message, err.reason])).not.toContain('\u4f60');
    }
  });

  it('an unspaced exception with a space or punctuation inside, or a language that does not fit, is refused with its row', () => {
    for (const [phrase, language] of [['\u4f60 \u597d', 'zh'], ['\u4f60\u3001\u597d', 'zh'], ['\u4f60\u597d', 'en'], ['\u4f60\u597d', 'th']] as const) {
      expect(() => buildMatcher([row(HAN, 'zh')], [{ id: 'e', phrase, language, active: true }]), `${phrase} ${language}`).toThrow(MatcherBuildError);
    }
  });

  it('a Latin exception still builds and works as before beside an unspaced term, and an inactive bad exception is skipped', () => {
    const m = buildMatcher([row('zorbak', 'en', undefined, 'lat'), row(HAN, 'zh', undefined, 'han')], [
      { id: 'x1', phrase: 'glarn zorbak', language: 'en', active: true },
      { id: 'x2', phrase: 'ab \u4f60\u597d', language: 'zh', active: false },
    ]);
    expect(m.match('you zorbak')).toEqual({ termId: 'lat' });
    expect(m.match('glarn zorbak')).toBeNull();
    expect(m.match(`\u4f60${HAN}`)).toEqual({ termId: 'han' });
  });
});

describe('the segmenter is the row\'s language', () => {
  const real = Intl.Segmenter;
  afterEach(() => {
    (Intl as { Segmenter: unknown }).Segmenter = real;
  });

  it('a zh row asks for a zh segmenter and a ja row for a ja one, each once however many lines are matched', () => {
    const asked: string[] = [];
    (Intl as { Segmenter: unknown }).Segmenter = class extends real {
      constructor(locales?: string | string[], options?: Intl.SegmenterOptions) {
        super(locales, options);
        if (options?.granularity === 'word') asked.push(String(locales));
      }
    };
    const m = build(row(HAN, 'zh', undefined, 'z'), row(KATA, 'ja', undefined, 'j'), row(THAI, 'th', undefined, 't'));
    for (let i = 0; i < 5; i += 1) {
      m.match(`\u4f60\u597d${HAN}`);
      m.match(`\u3053\u308c\u306f${KATA}`);
      m.match(`\u0e09\u0e31\u0e19${THAI}`);
    }
    expect(asked.sort()).toEqual(['ja', 'th', 'zh']);
  });
});
