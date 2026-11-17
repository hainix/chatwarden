import { describe, expect, it } from 'vitest';
import { FILTER_SUGGESTIONS, resolveFilters, type ResolvedFilters } from '../src/filters.js';
import { __foldSteps, foldChunks } from '../src/filters/fold.js';
import { __personalSteps, scanPersonal } from '../src/filters/personal.js';
import { __phraseSteps, compilePhrases, matchPhrases } from '../src/filters/phrases.js';
import { __ratioSteps, scanRatio, soften } from '../src/filters/ratio.js';

// Hostile text for the personal-info, ratio, phrase and fold engines: long runs of digits, separators, @, #, ~, emoji and capitals. Nothing
// throws, and doubling the input at most 2.5 times the work (measured below the 2 000 character cap the engines apply themselves).

const FAMILIES: Record<string, (n: number) => string> = {
  digits: (n) => '1'.repeat(n),
  'digits and spaces': (n) => '1 '.repeat(Math.ceil(n / 2)),
  'digits and dashes': (n) => '1-'.repeat(Math.ceil(n / 2)),
  'groups of three': (n) => '555 '.repeat(Math.ceil(n / 4)),
  'phone-like groups': (n) => '(555) 010-9999 '.repeat(Math.ceil(n / 15)),
  'plus runs': (n) => '+1 '.repeat(Math.ceil(n / 3)),
  parens: (n) => '('.repeat(n),
  separators: (n) => '. - . - '.repeat(Math.ceil(n / 8)),
  '@': (n) => '@'.repeat(n),
  'a@': (n) => 'a@'.repeat(Math.ceil(n / 2)),
  'a@b.com runs': (n) => 'a@b.com '.repeat(Math.ceil(n / 8)),
  '[at] runs': (n) => '[at]'.repeat(Math.ceil(n / 4)),
  'a [at] b [dot] runs': (n) => 'a [at] b [dot] '.repeat(Math.ceil(n / 15)),
  '#': (n) => '#'.repeat(n),
  'snap runs': (n) => 'snap '.repeat(Math.ceil(n / 5)),
  'snap x1 runs': (n) => 'snap x1 '.repeat(Math.ceil(n / 8)),
  'numbers and words': (n) => '12 Oak '.repeat(Math.ceil(n / 7)),
  '~': (n) => '~'.repeat(n),
  'zorbak ~': (n) => 'zorbak ~ '.repeat(Math.ceil(n / 9)),
  'zorbak runs': (n) => 'zorbak '.repeat(Math.ceil(n / 7)),
  emoji: (n) => '\u{1f600}'.repeat(Math.ceil(n / 2)),
  'zwj emoji': (n) => '\u{1f468}\u{200d}'.repeat(Math.ceil(n / 3)),
  'regional indicators': (n) => '\u{1f1fa}'.repeat(Math.ceil(n / 2)),
  capitals: (n) => 'A'.repeat(n),
  'caps and spaces': (n) => 'AB '.repeat(Math.ceil(n / 3)),
  'repeated letters': (n) => 'o'.repeat(n),
  'dots between letters': (n) => 'g.'.repeat(Math.ceil(n / 2)),
  'look-alikes': (n) => 'g0'.repeat(Math.ceil(n / 2)),
  hidden: (n) => '\u{200b}'.repeat(n),
  mixed: (n) => 'A1 @b#2 ~g.0.l.d \u{1f600}'.repeat(Math.ceil(n / 20)),
};

const RULES: ResolvedFilters = resolveFilters({
  personalInfo: { action: 'mask', address: 'flag', phone: 'any' },
  ratio: { action: 'mask' },
  phrases: [{ id: 'a', action: 'count', phrases: ['zorbak ~ ~ vlemmo', 'zorbak ~ vlemmo ~ quissel', 'g0ld*', 'buy|sell ~ gold'] }],
});
const compiled = compilePhrases(RULES.phrases);

describe('hostile text', () => {
  for (const [name, make] of Object.entries(FAMILIES)) {
    it(`${name}: 100 000 characters do not throw`, () => {
      const text = make(100_000);
      expect(() => scanPersonal(text, RULES.personalInfo!)).not.toThrow();
      expect(() => scanRatio(text, RULES.ratio!)).not.toThrow();
      expect(() => soften(text, RULES.ratio!)).not.toThrow();
      expect(() => matchPhrases(compiled, text)).not.toThrow();
      expect(() => foldChunks(text)).not.toThrow();
      expect(soften(text, RULES.ratio!).length).toBeLessThanOrEqual(text.length);
    });

    it(`${name}: steps for 2n are at most 2.5 times the steps for n`, () => {
      const run = (n: number): number => {
        __personalSteps.n = 0;
        __phraseSteps.n = 0;
        __ratioSteps.n = 0;
        __foldSteps.n = 0;
        const text = make(n);
        scanPersonal(text, RULES.personalInfo!);
        scanRatio(text, RULES.ratio!);
        soften(text, RULES.ratio!);
        matchPhrases(compiled, text);
        return __personalSteps.n + __phraseSteps.n + __ratioSteps.n + __foldSteps.n;
      };
      const small = run(400);
      const big = run(800);
      expect(small).toBeGreaterThan(0);
      expect(big).toBeLessThanOrEqual(small * 2.5);
    });
  }

  it('the match lists stay bounded however many words match', () => {
    const text = 'zorbak vlemmo '.repeat(100_000);
    expect(matchPhrases(compiled, text).length).toBeLessThanOrEqual(50);
    expect(scanPersonal('a@b.com '.repeat(100_000), RULES.personalInfo!).length).toBeLessThanOrEqual(50);
  });

  it('lone surrogates, NUL and control characters do not throw', () => {
    for (const t of ['\ud800 buy gold', 'buy\udc00 gold', '\u0000'.repeat(50), 'zorbak\u0000vlemmo', '555\u0000010\u00009999', '\u{1f600}\ud800\u{200d}']) {
      expect(() => scanPersonal(t, RULES.personalInfo!)).not.toThrow();
      expect(() => scanRatio(t, RULES.ratio!)).not.toThrow();
      expect(() => soften(t, RULES.ratio!)).not.toThrow();
      expect(() => matchPhrases(compiled, t)).not.toThrow();
    }
  });
});

describe('the phrase compiler', () => {
  it('refuses nothing the settings accepted: every pattern F1 validates compiles, and never throws on a validated rule', () => {
    const suggested = Object.values(FILTER_SUGGESTIONS).flatMap((s) => resolveFilters(s).phrases);
    const many = resolveFilters({
      phrases: Array.from({ length: 5 }, (_, k) => ({
        id: `r${k}`,
        action: 'count',
        phrases: Array.from({ length: 100 }, (_, i) => [`zorbak${k}x${i} vlemmo`, `a${k}b${i}c|d${k}e${i}f ~ glarn*`, `quissel${i} * ~ tarvo${k}`, `g0ld${k}${i} ~ ~ snerp`][i % 4]!),
      })),
    } as never).phrases;
    for (const rules of [suggested, many, [] as typeof many]) {
      const total = rules.reduce((n, r) => n + r.phrases.length, 0);
      const c = compilePhrases(rules);
      expect(c.count).toBe(total);
      expect(() => matchPhrases(c, 'zorbak0x0 vlemmo a0b0c glarn quissel1 x tarvo0 g0ld01 snerp')).not.toThrow();
    }
  });

  it('the compiled count shows a pattern it could not read, never a throw', () => {
    const c = compilePhrases([{ id: 'x', label: 'x', action: 'count', rule: 4, phrases: ['okay one', '[bad]', 7 as never] }]);
    expect(c.count).toBe(1);
  });
});
