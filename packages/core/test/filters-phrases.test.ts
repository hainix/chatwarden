import { describe, expect, it } from 'vitest';
import { parsePattern, type PatternToken } from '../src/filters/phrases.js';

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
