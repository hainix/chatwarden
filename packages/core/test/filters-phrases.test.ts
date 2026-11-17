import { describe, expect, it } from 'vitest';
import { resolveFilters, type ResolvedPhraseRule } from '../src/filters.js';
import { __phraseSteps, compilePhrases, matchPhrases, parsePattern, type PatternToken } from '../src/filters/phrases.js';

const ok = (p: string): PatternToken[] => {
  const r = parsePattern(p);
  if (!r.ok) throw new Error(`expected ${JSON.stringify(p)} to parse, got: ${r.reason}`);
  return r.tokens;
};
const bad = (p: unknown): string => {
  const r = parsePattern(p);
  if (r.ok) throw new Error(`expected ${JSON.stringify(p)} to be refused`);
  return r.reason;
};

describe('pattern grammar', () => {
  it('a whole word, alternatives, a prefix, one word and up to three words', () => {
    expect(ok('gold')).toEqual([{ kind: 'alt', alts: [{ word: 'gold', prefix: false }] }]);
    expect(ok('buy|sell|selling gold*')).toEqual([
      { kind: 'alt', alts: [{ word: 'buy', prefix: false }, { word: 'sell', prefix: false }, { word: 'selling', prefix: false }] },
      { kind: 'alt', alts: [{ word: 'gold', prefix: true }] },
    ]);
    expect(ok('buy * gold').map((t) => t.kind)).toEqual(['alt', 'one', 'alt']);
    expect(ok('buy ~ gold').map((t) => t.kind)).toEqual(['alt', 'skip', 'alt']);
  });

  it('words are folded like a line: G0LD is gold', () => {
    expect(ok('BUY G0LD')).toEqual(ok('buy gold'));
    expect(ok('g.o.l.d')).toEqual(ok('gold'));
  });

  it('alternation up to 8, the 9th refused', () => {
    expect(() => ok('zorbak|vlemmo|quissel|drakkuun|fenrisk|tarvo|snerp|glarn')).not.toThrow();
    expect(bad('zorbak|vlemmo|quissel|drakkuun|fenrisk|tarvo|snerp|glarn|gluk')).toContain('alternatives');
    expect(bad('zorbak||vlemmo')).toContain('empty');
    expect(bad('|zorbak')).toContain('empty');
  });

  it('a * or ~ first token is refused', () => {
    expect(bad('* gold')).toContain('start with a word');
    expect(bad('~ gold')).toContain('start with a word');
    expect(bad('*')).toContain('start');
  });

  it('a first word under 3 letters is refused, in every alternative and as a prefix', () => {
    expect(bad('to gold')).toContain('3 letters');
    expect(bad('buy|go gold')).toContain('3 letters');
    expect(bad('go* gold')).toContain('3 letters');
    expect(bad('12 gold')).toContain('3 letters');
    expect(() => ok('buy to')).not.toThrow();
    expect(() => ok('buy 2')).not.toThrow();
  });

  it('more than 6 tokens, more than 2 ~, an 81 character pattern refused', () => {
    expect(() => ok('zorbak vlemmo quissel drakkuun fenrisk tarvo')).not.toThrow();
    expect(bad('zorbak vlemmo quissel drakkuun fenrisk tarvo snerp')).toContain('at most 6');
    expect(() => ok('zorbak ~ vlemmo ~ quissel')).not.toThrow();
    expect(bad('zorbak ~ ~ ~ vlemmo')).toContain('at most 2 ~');
    expect(() => ok('ab'.repeat(40))).not.toThrow();
    expect(bad(`${'ab'.repeat(40)}c`)).toContain('80');
  });

  it('a pattern that folds to nothing, or is empty, or is not text, is refused', () => {
    for (const p of ['', '   ', '...', '---', '\u{200b}\u{200b}', '@@@ ...']) expect(() => bad(p)).not.toThrow();
    expect(bad(5)).toBe('must be text');
    expect(bad(null)).toBe('must be text');
    expect(bad(undefined)).toBe('must be text');
    expect(bad({})).toBe('must be text');
  });

  it('no regular-expression syntax is accepted: brackets, groups, plus, question mark, backslash, caret, braces and a mid-word wildcard', () => {
    for (const p of ['[gold]', 'gol[dD]', '(gold)', 'gold+', 'gold?', '\\bgold', '^gold', 'go{2}ld', 'g*ld', '*gold', 'g~ld', 'a-b', 'gold,coin', '\\d+', '.*', 'gold|(a)']) {
      expect(() => bad(p), p).not.toThrow();
    }
  });

  it('a refusal never echoes the pattern', () => {
    for (const p of ['zorbak*[x]', 'vlemmo+', 'quissel '.repeat(20), '* zorbak']) expect(bad(p)).not.toContain('zorbak');
    expect(bad('vlemmo+')).not.toContain('vlemmo');
    expect(bad('quissel '.repeat(20))).not.toContain('quissel');
  });

  it('never throws on hostile input', () => {
    for (const p of ['\u0000', 'a'.repeat(100_000), '|'.repeat(1000), '~ '.repeat(1000), '\ud800', 'x\u{200b}'.repeat(40)]) expect(() => parsePattern(p)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Matching

const rules = (...defs: Array<[id: string, ...patterns: string[]]>): ResolvedPhraseRule[] =>
  resolveFilters({ phrases: defs.map(([id, ...phrases]) => ({ id, action: 'count', phrases })) } as never).phrases;
const find = (patterns: string[], text: string): string[] => {
  const c = compilePhrases(rules(['r', ...patterns]));
  return matchPhrases(c, text).map((m) => text.slice(m.span.start, m.span.end));
};
const hit = (patterns: string[], text: string): boolean => find(patterns, text).length > 0;

describe('pattern matching', () => {
  it('a whole word', () => {
    expect(hit(['gold'], 'buy gold now')).toBe(true);
    expect(hit(['gold'], 'goldfish')).toBe(false);
    expect(hit(['gold'], 'marigold')).toBe(false);
    expect(hit(['gold'], 'GOLD!')).toBe(true);
    expect(find(['gold'], 'a gold, b gold')).toEqual(['gold', 'gold']);
  });

  it('folded words: g0ld, g.o.l.d, goooold, accents and full-width letters all match gold', () => {
    for (const t of ['g0ld', 'g.o.l.d', 'goooold', 'g\u{f6}ld', '\u{ff47}\u{ff4f}\u{ff4c}\u{ff44}', 'G0LD']) expect(hit(['gold'], `buy ${t} now`), t).toBe(true);
    expect(hit(['gold'], 'g o l d')).toBe(false);
  });

  it('alternation', () => {
    expect(find(['buy|sell|selling gold'], 'we sell gold and selling gold')).toEqual(['sell gold', 'selling gold']);
    expect(hit(['buy|sell gold'], 'borrow gold')).toBe(false);
  });

  it('a prefix with *', () => {
    expect(hit(['gold*'], 'goldfarm')).toBe(true);
    expect(hit(['gold*'], 'golds')).toBe(true);
    expect(hit(['gold*'], 'gold')).toBe(true);
    expect(hit(['gold*'], 'golf')).toBe(false);
    expect(hit(['zorbak gold*'], 'zorbak goldfarm')).toBe(true);
  });

  it('a lone * is exactly one word of any kind', () => {
    expect(hit(['buy * gold'], 'buy cheap gold')).toBe(true);
    expect(hit(['buy * gold'], 'buy gold')).toBe(false);
    expect(hit(['buy * gold'], 'buy some cheap gold')).toBe(false);
  });

  it('~ is zero to three words of any kind', () => {
    const p = ['buy ~ gold'];
    for (const t of ['buy gold', 'buy some gold', 'buy lots of cheap gold']) expect(hit(p, t), t).toBe(true);
    expect(hit(p, 'buy a very very cheap gold')).toBe(false);
    expect(find(p, 'x buy lots of cheap gold y')).toEqual(['buy lots of cheap gold']);
  });

  it('two ~ at most, each zero to three', () => {
    expect(hit(['zorbak ~ vlemmo ~ quissel'], 'zorbak a b vlemmo c quissel')).toBe(true);
    expect(hit(['zorbak ~ vlemmo ~ quissel'], 'zorbak vlemmo quissel')).toBe(true);
    expect(hit(['zorbak ~ vlemmo ~ quissel'], 'zorbak a b c d vlemmo quissel')).toBe(false);
  });

  it('a trailing ~ matches with nothing after it', () => {
    expect(find(['buy ~'], 'buy gold now')).toEqual(['buy']);
  });

  it('the order of words matters', () => {
    expect(hit(['buy gold'], 'gold buy')).toBe(false);
    expect(hit(['buy ~ gold'], 'gold then buy')).toBe(false);
  });

  it('punctuation between words is a boundary: "buy, gold" and "buy-gold" read as two words', () => {
    expect(hit(['buy gold'], 'buy, gold')).toBe(true);
    expect(hit(['buy gold'], 'buy-gold')).toBe(true);
    expect(hit(['buy gold'], 'buy/gold!')).toBe(true);
  });

  it('numbers are words: "buy 500 gold" matches "buy * gold", and 500 stays 500', () => {
    expect(hit(['buy * gold'], 'buy 500 gold')).toBe(true);
    expect(hit(['buy 500 gold'], 'buy 500 gold')).toBe(true);
    expect(hit(['buy 500 gold'], 'buy soo gold')).toBe(false);
  });

  it('the span covers the matched words on the original text, including stripped characters', () => {
    const text = 'x  buy  g\u{200b}0ld! y';
    expect(find(['buy gold'], text)).toEqual(['buy  g\u{200b}0ld']);
  });

  it('a rule id comes back with each match, in text order, and rules do not mix', () => {
    const c = compilePhrases(rules(['ads', 'free gold'], ['links', 'visit site'], ['both', 'gold']));
    const text = 'visit site for free gold';
    expect(matchPhrases(c, text).map((m) => [m.ruleId, text.slice(m.span.start, m.span.end)])).toEqual([
      ['links', 'visit site'],
      ['ads', 'free gold'],
      ['both', 'gold'],
    ]);
  });

  it('a bad pattern in a rule is skipped, never thrown on', () => {
    const bad = [{ id: 'x', label: 'x', action: 'count', rule: 4, phrases: ['[nope]', 'fine word', '* nope'] }] as ResolvedPhraseRule[];
    const c = compilePhrases(bad);
    expect(matchPhrases(c, 'a fine word b').map((m) => m.ruleId)).toEqual(['x']);
    expect(matchPhrases(c, '[nope] nope')).toEqual([]);
  });

  it('compiling is cached by the settings (the same rules give the same compiled object), and a change is a new one', () => {
    const r = rules(['a', 'zorbak vlemmo']);
    expect(compilePhrases(r)).toBe(compilePhrases(r));
    expect(compilePhrases(rules(['a', 'zorbak vlemmo']))).not.toBe(compilePhrases(r));
  });

  it('no rules, an empty line and a non-string give nothing', () => {
    expect(matchPhrases(compilePhrases([]), 'buy gold')).toEqual([]);
    expect(matchPhrases(compilePhrases(rules(['a', 'buy gold'])), '')).toEqual([]);
    expect(matchPhrases(compilePhrases(rules(['a', 'buy gold'])), undefined as never)).toEqual([]);
  });

  it('only the first 2 000 characters are read', () => {
    const c = compilePhrases(rules(['a', 'buy gold']));
    expect(matchPhrases(c, `${'x '.repeat(1100)}buy gold`)).toEqual([]);
  });
});

describe('phrase performance', () => {
  const many = (n: number): ResolvedPhraseRule[] => {
    const patterns = Array.from({ length: n }, (_, i) => `w${i.toString(36).padStart(4, 'q')}word tail${i % 7} end`);
    return resolveFilters({ phrases: Array.from({ length: Math.ceil(n / 100) }, (_, k) => ({ id: `r${k}`, action: 'count', phrases: patterns.slice(k * 100, k * 100 + 100) })) } as never).phrases;
  };

  it('500 patterns, a 200 character line: steps bounded and independent of the pattern count beyond the first-word bucket', () => {
    const line = 'hello there how are you doing today my friend i hope that you are well and that the game is going nicely for you all';
    expect(line.length).toBeLessThanOrEqual(200);
    const few = compilePhrases(many(5));
    const lots = compilePhrases(many(500));
    __phraseSteps.n = 0;
    matchPhrases(few, line);
    const small = __phraseSteps.n;
    __phraseSteps.n = 0;
    matchPhrases(lots, line);
    const big = __phraseSteps.n;
    expect(small).toBeGreaterThan(0);
    expect(big).toBeLessThanOrEqual(small + 5);
  });

  it('patterns that share a first word cost only their own bucket', () => {
    const shared = resolveFilters({ phrases: [{ id: 'a', action: 'count', phrases: Array.from({ length: 100 }, (_, i) => `zorbak t${i} end`) }] } as never).phrases;
    const c = compilePhrases(shared);
    __phraseSteps.n = 0;
    matchPhrases(c, 'zorbak t5 end and zorbak t99 end');
    expect(__phraseSteps.n).toBeLessThan(1000);
    expect(matchPhrases(c, 'zorbak t5 end and zorbak t99 end')).toHaveLength(2);
  });

  it('a line made of one bucket word repeated stays linear', () => {
    const c = compilePhrases(rules(['a', 'zorbak ~ ~ vlemmo', 'zorbak ~ vlemmo ~ quissel']));
    __phraseSteps.n = 0;
    matchPhrases(c, 'zorbak '.repeat(100));
    const small = __phraseSteps.n;
    __phraseSteps.n = 0;
    matchPhrases(c, 'zorbak '.repeat(200));
    expect(__phraseSteps.n).toBeLessThanOrEqual(small * 2.5);
  });
});
