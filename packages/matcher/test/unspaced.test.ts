import { afterEach, describe, expect, it } from 'vitest';
import { buildMatcher } from '../src/index.js';
import type { ExceptionRow, TermRow } from '../src/index.js';

// L1: matching terms in scripts written without spaces. A `segment` term must occupy whole segments of the text (the dictionary segmenter of Node's ICU, per language); `contains` hits anywhere inside a run; a run
// ends at anything that is not a letter of those scripts. The oracle in these tests is Intl.Segmenter itself, so a different ICU changes the fixtures' premises loudly instead of the matcher silently. Invented
// strings only: transliterations of zorbak, an invented fragment of a place name, a fragment of Thai \u0e1b\u0e23\u0e30\u0e40\u0e17\u0e28.

const row = (term: string, language: string, matchMode?: TermRow['matchMode'], id = term, active = true): TermRow => ({ id, term, language, active, ...(matchMode === undefined ? {} : { matchMode }) });
const build = (rows: TermRow[], exceptions: ExceptionRow[] = []) => buildMatcher(rows, exceptions);
const hit = (id: string) => ({ termId: id });

const HAN = '\u4f50\u5c14\u5df4\u514b';
const HAN_FRAGMENT = '\u5c14\u5df4\u5c3c'; // inside the place name below
const PLACE = '\u963f\u5c14\u5df4\u5c3c\u4e9a'; // one dictionary word
const KATA = '\u30be\u30eb\u30d0\u30af';
const THAI = '\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01';
const THAI_FRAGMENT = '\u0e1b\u0e23\u0e30\u0e40\u0e17'; // inside \u0e1b\u0e23\u0e30\u0e40\u0e17\u0e28\u0e44\u0e17\u0e22

/** The segment edges Node's ICU puts in `text` for `language` (the first and last included). */
function edges(language: string, text: string): Set<number> {
  const out = new Set<number>([0, text.length]);
  for (const s of new Intl.Segmenter(language, { granularity: 'word' }).segment(text)) {
    out.add(s.index);
    out.add(s.index + s.segment.length);
  }
  return out;
}
const hitsInside = (language: string, text: string, term: string): boolean => {
  const e = edges(language, text);
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) if (e.has(at) && e.has(at + term.length)) return true;
  return false;
};

describe('segment: a term must occupy whole segments', () => {
  it('hits where its two edges are segment edges: a term on its own, between ordinary words and at both ends of a line', () => {
    const m = build([row(HAN, 'zh'), row(KATA, 'ja'), row(THAI, 'th')]);
    expect(m.match(HAN)).toEqual(hit(HAN));
    expect(m.match(`\u4f60\u597d${HAN}\u518d\u89c1`)).toEqual(hit(HAN));
    expect(m.match(`\u3053\u308c\u306f${KATA}\u3067\u3059`)).toEqual(hit(KATA));
    expect(m.match(`\u0e09\u0e31\u0e19\u0e40\u0e2b\u0e47\u0e19${THAI}\u0e17\u0e35\u0e48\u0e19\u0e31\u0e48\u0e19`)).toEqual(hit(THAI));
  });

  it('does not hit the same characters inside a longer dictionary word (asserted against the ICU that is running)', () => {
    const lines: Array<[string, string, string]> = [
      ['zh', HAN_FRAGMENT, `\u6211\u53bb\u8fc7${PLACE}\u65c5\u6e38`],
      ['th', THAI_FRAGMENT, '\u0e1b\u0e23\u0e30\u0e40\u0e17\u0e28\u0e44\u0e17\u0e22\u0e2a\u0e27\u0e22\u0e07\u0e32\u0e21'],
      ['ja', KATA, '\u30be\u30eb\u30d0\u30af\u30b9\u30ad\u30fc'],
    ];
    for (const [language, term, line] of lines) {
      expect(hitsInside(language, line, term), `premise: ${language} puts no edge at both ends`).toBe(false);
      expect(build([row(term, language)]).match(line), language).toBeNull();
      expect(build([row(term, language, 'contains')]).match(line), `${language} contains`).toEqual(hit(term));
    }
  });

  it('a slang term the segmenter splits into single characters still hits', () => {
    const line = `\u4f60\u597d${HAN}\u518d\u89c1`;
    const segments = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(line)].map((s) => s.segment);
    expect(segments.slice(1, 5), 'premise: ICU splits the unknown term into its characters').toEqual([...HAN]);
    expect(build([row(HAN, 'zh')]).match(line)).toEqual(hit(HAN));
  });

  it('agrees with the oracle on a set of lines: a hit exactly when both edges of an occurrence are segment edges', () => {
    const terms: Array<[string, string]> = [['zh', HAN], ['zh', HAN_FRAGMENT], ['ja', KATA], ['th', THAI], ['th', THAI_FRAGMENT]];
    const pieces: Record<string, string[]> = {
      zh: ['\u4f60\u597d', PLACE, HAN, HAN_FRAGMENT, '\u518d\u89c1', '\u6211\u53bb\u8fc7', '\u4eba\u6c11\u5171\u548c\u56fd'],
      ja: ['\u3053\u308c\u306f', KATA, `${KATA}\u30b9\u30ad\u30fc`, '\u3067\u3059', '\u3072\u3089\u304c\u306a', '\u6771\u4eac\u90fd\u306b'],
      th: ['\u0e09\u0e31\u0e19', THAI, '\u0e1b\u0e23\u0e30\u0e40\u0e17\u0e28\u0e44\u0e17\u0e22', THAI_FRAGMENT, '\u0e2a\u0e27\u0e22\u0e07\u0e32\u0e21', `${THAI}\u0e40\u0e01\u0e2d\u0e23\u0e4c`],
    };
    let checked = 0;
    for (const [language, term] of terms) {
      const m = build([row(term, language)]);
      const list = pieces[language] as string[];
      for (const a of list) {
        for (const b of list) {
          const line = `${a}${b}`;
          expect(m.match(line) !== null, `${language} ${JSON.stringify(line)}`).toBe(hitsInside(language, line, term));
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('contains hits anywhere in a run, and only inside a run', () => {
    const m = build([row(HAN, 'zh', 'contains')]);
    expect(m.match(`\u4f60${HAN}\u597d`)).toEqual(hit(HAN));
    expect(m.match(`\u4f60${HAN.slice(0, 2)} ${HAN.slice(2)}\u597d`)).toBeNull();
    expect(m.match(HAN.slice(0, 3))).toBeNull();
  });

  it('contains does not cut a grapheme cluster: a Thai letter without its vowel mark is not the term', () => {
    const m = build([row('\u0e17\u0e35\u0e19', 'th', 'contains', 't')]);
    expect(m.match('\u0e17\u0e35\u0e19')).toEqual(hit('t'));
    expect(m.match('\u0e17\u0e35\u0e19\u0e31')).toBeNull();
  });
});

describe('runs', () => {
  const m = build([row(HAN, 'zh', undefined, 'han'), row(HAN, 'zh', 'contains', 'han-c')]);

  it('punctuation, spaces, digits, Latin letters and emoji end a run, so a term split by one of them does not match (a documented limit)', () => {
    const half = [HAN.slice(0, 2), HAN.slice(2)] as const;
    for (const gap of [' ', '\t', ',', '\u3001', '\u3002', '!', '1', '\u0e51', 'a', 'Z', '\ud83d\ude00', '\u00b7', '\u30fb', '-', '_', '\n']) {
      expect(m.match(`${half[0]}${gap}${half[1]}`), JSON.stringify(gap)).toBeNull();
    }
  });

  it('a term at the start and the end of the text matches, and so does one next to those separators', () => {
    for (const line of [HAN, `${HAN}!`, `!${HAN}`, `\u4f60\u597d ${HAN}`, `${HAN}\u3002`, `1${HAN}2`, `a${HAN}b`, `\ud83d\ude00${HAN}\ud83d\ude00`]) expect(m.match(line) !== null, line).toBe(true);
  });

  it('a Latin letter inside the line is not part of the run, even next to the term', () => {
    const only = build([row(HAN, 'zh', 'contains')]);
    expect(only.match(`${HAN.slice(0, 2)}x${HAN.slice(2)}`)).toBeNull();
    expect(only.match(`x${HAN}x`)).toEqual(hit(HAN));
  });

  it('a very long line is read without trouble and is not slow', () => {
    const line = `${'\u4f60\u597d'.repeat(2500)}${HAN}${'\u518d\u89c1'.repeat(2500)}`;
    const started = Date.now();
    expect(m.match(line)).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(m.match('\u4f60\u597d'.repeat(5000))).toBeNull();
  });
});

describe('both paths run on one line', () => {
  const m = build([row('zorbak', 'en', undefined, 'lat'), row(HAN, 'zh', undefined, 'han'), row(KATA, 'ja', undefined, 'kata')]);

  it('either may block a line, and a line with neither is clean', () => {
    expect(m.match('you zorbak')).toEqual(hit('lat'));
    expect(m.match(`\u4f60\u597d${HAN}`)).toEqual(hit('han'));
    expect(m.match(`hello ${KATA}`)).toEqual(hit('kata'));
    expect(m.match(`zorbak ${HAN}`)).toEqual(hit('lat'));
    expect(m.match('hello \u4f60\u597d')).toBeNull();
    expect(m.match('')).toBeNull();
  });

  it('matchName reads a name through both paths: an underscore, a digit run or a camel hump breaks the words', () => {
    expect(m.matchName?.(`Mod_${HAN}`)).toEqual(hit('han'));
    expect(m.matchName?.(`${HAN}99`)).toEqual(hit('han'));
    expect(m.matchName?.('Big_Zorbak')).toEqual(hit('lat'));
    expect(m.matchName?.('Friendly Fox')).toBeNull();
  });
});

describe('exceptions', () => {
  const term = (id: string, t: string, language: string): TermRow => row(t, language, 'contains', id);
  const except = (id: string, phrase: string, language: string): ExceptionRow => ({ id, phrase, language, active: true });

  it('an unspaced exception phrase suppresses a hit inside it only when its own edges are boundaries', () => {
    const m = build([term('inner', '\u30be\u30eb\u30d0', 'ja')], [except('x', KATA, 'ja')]);
    const aligned = `\u3053\u308c\u306f${KATA}\u3067\u3059`;
    const glued = `${KATA}\u30b9\u30ad\u30fc`;
    expect(hitsInside('ja', aligned, KATA), 'premise: the phrase is whole segments here').toBe(true);
    expect(hitsInside('ja', glued, KATA), 'premise: the phrase is a prefix of a longer word here').toBe(false);
    expect(m.match(aligned)).toBeNull();
    expect(m.match(glued)).toEqual(hit('inner'));
    expect(m.match('\u30be\u30eb\u30d0')).toEqual(hit('inner'));
  });

  it('an exception covers only hits inside one occurrence of it, in the same run', () => {
    const m = build([term('t', HAN.slice(0, 3), 'zh')], [except('x', HAN, 'zh')]);
    expect(m.match(HAN)).toBeNull();
    expect(m.match(`${HAN} ${HAN.slice(0, 3)}`)).toEqual(hit('t'));
    expect(m.match(`${HAN.slice(0, 3)}\u3002${HAN}`)).toEqual(hit('t'));
  });

  it('an inactive exception does nothing, and a Latin exception beside an unspaced term still works as before', () => {
    const m = build([row('zorbak', 'en', undefined, 'lat'), term('t', '\u30be\u30eb\u30d0', 'ja')], [{ id: 'x', phrase: KATA, language: 'ja', active: false }, { id: 'y', phrase: 'glarn zorbak', language: 'en', active: true }]);
    expect(m.match(KATA)).toEqual(hit('t'));
    expect(m.match('glarn zorbak')).toBeNull();
    expect(m.match('hi zorbak')).toEqual(hit('lat'));
  });
});

describe('Latin behaviour is untouched', () => {
  const real = Intl.Segmenter;
  afterEach(() => {
    (Intl as { Segmenter: unknown }).Segmenter = real;
  });
  const spy = (): { made: number } => {
    const counts = { made: 0 };
    (Intl as { Segmenter: unknown }).Segmenter = class extends real {
      constructor(locales?: string | string[], options?: Intl.SegmenterOptions) {
        super(locales, options);
        counts.made += 1;
      }
    };
    return counts;
  };

  it('a Latin-only matcher takes no segmenter path at all (a spy), whatever it is asked', () => {
    const counts = spy();
    const m = build([row('zorbak', 'en')]);
    expect(m.match('you zorbak')).toEqual(hit('zorbak'));
    expect(m.match(`\u4f60\u597d${HAN}`)).toBeNull();
    expect(m.spans?.('zorbak')).toHaveLength(1);
    expect(m.matchName?.('Zorbak_99')).toEqual(hit('zorbak'));
    expect(counts.made).toBe(0);
  });

  it('a matcher with an unspaced term builds no segmenter for a line with no unspaced letter in it', () => {
    const counts = spy();
    const m = build([row(HAN, 'zh'), row('zorbak', 'en')]);
    expect(m.match('you zorbak')).toEqual(hit('zorbak'));
    expect(m.match('hello there, friend 123 \ud83d\ude00')).toBeNull();
    expect(counts.made).toBe(0);
  });

  it('a Latin line costs the same with unspaced terms in the matcher as without (a loose bound, many repeats)', () => {
    const latin = build([row('zorbak', 'en')]);
    const mixed = build([row('zorbak', 'en'), ...Array.from({ length: 200 }, (_v, i) => row(`${String.fromCodePoint(0x4e00 + i)}${String.fromCodePoint(0x4f00 + i)}`, 'zh', undefined, `h${i}`))]);
    const line = 'hello there friend, this is an ordinary line of chat with nothing in it to match at all.';
    const time = (m: ReturnType<typeof build>): number => {
      for (let i = 0; i < 300; i += 1) m.match(line);
      const started = performance.now();
      for (let i = 0; i < 3000; i += 1) m.match(line);
      return performance.now() - started;
    };
    const a = Math.min(time(latin), time(latin));
    const b = Math.min(time(mixed), time(mixed));
    expect(b).toBeLessThan(a * 3 + 15);
  });
});

describe('performance', () => {
  it('2000 unspaced terms and a 200-character mixed line match within a generous budget', () => {
    const rows: TermRow[] = [];
    for (let i = 0; i < 2000; i += 1) {
      rows.push(row(`${String.fromCodePoint(0x4e00 + (i % 400))}${String.fromCodePoint(0x5000 + Math.floor(i / 400) * 30 + (i % 30))}${String.fromCodePoint(0x5400 + ((i * 7) % 900))}`, 'zh', i % 3 === 0 ? 'contains' : undefined, `t${i}`));
    }
    rows.push(row('zorbak', 'en', undefined, 'lat'));
    const built = performance.now();
    const m = build(rows);
    const buildMs = performance.now() - built;
    const line = `hello there ${'\u4f60\u597d\u4e16\u754c'.repeat(15)} friend ${'\u3053\u3093\u306b\u3061\u306f'.repeat(12)} and some more text ${'\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35'.repeat(6)} end`;
    expect(line.length).toBeGreaterThan(190);
    for (let i = 0; i < 20; i += 1) m.match(line);
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) m.match(line);
    const each = (performance.now() - started) / 200;
    expect(buildMs).toBeLessThan(3000);
    expect(each).toBeLessThan(10);
  });
});
