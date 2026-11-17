import { describe, expect, it } from 'vitest';
import { __foldSteps, foldChunks, foldWord, letterCount, lowerKeepLength } from '../src/filters/fold.js';

const words = (text: string): string[] => foldChunks(text).map((c) => c.folded);

describe('fold', () => {
  it.each([
    ['g0ld', 'gold'],
    ['g.o.l.d', 'gold'],
    ['g*o*l*d', 'gold'],
    ['goooold', 'gold'],
    ['GOLD', 'gold'],
    ['g\u{f6}ld', 'gold'],
    ['g\u{f3}ld', 'gold'],
    ['\u{ff47}\u{ff4f}\u{ff4c}\u{ff44}', 'gold'],
    ['g\u{200b}o\u{200c}l\u{200d}d', 'gold'],
    ['g\u{43e}ld', 'gold'],
    ['\u{440}\u{430}yp\u{430}l', 'paypal'],
    ['\u{3b1}pple', 'apple'],
    ['\u{3bf}\u{3c1}\u{3b1}cle', 'opacle'],
    ['g0000ld', 'gold'],
    ['$old', 'sold'],
    ['b@ck', 'back'],
    ['l33t', 'leet'],
  ])('%s folds to %s', (input, want) => {
    // Cyrillic and Greek look-alikes of Latin letters are read as those letters.
    expect(words(input)).toEqual([want]);
  });

  it('the split reading treats a full stop and an asterisk as a boundary', () => {
    expect(foldChunks('buy.gold', { split: true }).map((c) => c.folded)).toEqual(['buy', 'gold']);
    expect(foldChunks('buy*gold g.o.l.d', { split: true }).map((c) => c.folded)).toEqual(['buy', 'gold', 'g', 'o', 'l', 'd']);
    expect(foldChunks('buy.gold').map((c) => c.folded)).toEqual(['buygold']);
  });

  it('the bang reading keeps a ! or | between two letters as a letter', () => {
    expect(foldChunks('f!sh f|sh', { bang: true }).map((c) => c.folded)).toEqual(['fish', 'flsh']);
    expect(foldChunks('wow! look |x', { bang: true }).map((c) => c.folded)).toEqual(['wow', 'look', 'x']);
    expect(foldChunks('f!sh').map((c) => c.folded)).toEqual(['f', 'sh']);
  });

  it('500 and 2000 stay numbers; a chunk with no letter is never leet-mapped', () => {
    expect(words('500 2000 1337 $5 007')).toEqual(['500', '2000', '1337', '5', '007']);
    expect(words('level 1 gold 3x')).toEqual(['level', '1', 'gold', 'ex']);
  });

  it('a word is split on whitespace and the listed separators, not on . or *', () => {
    expect(words('buy-gold/now|please,ok;fine:yes!no?(a)[b]{c}"d"~e+f=g<h>i')).toEqual(['buy', 'gold', 'now', 'please', 'ok', 'fine', 'yes', 'no', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    expect(words('buy_gold')).toEqual(['buy', 'gold']);
    expect(words('evil.com')).toEqual(['evilcom']);
  });

  it('a full stop or an asterisk at the edge of a word is not part of it', () => {
    expect(words('gold. *gold* ...gold...')).toEqual(['gold', 'gold', 'gold']);
  });

  it('spaced-out letters do not fold together', () => {
    expect(words('g o l d')).toEqual(['g', 'o', 'l', 'd']);
    expect(words('b u y')).toEqual(['b', 'u', 'y']);
  });

  it('two of one letter stay two; three or more become one', () => {
    expect(words('book boook booook')).toEqual(['book', 'bok', 'bok']);
    expect(words('wooow')).toEqual(['wow']);
  });

  it('a line of punctuation and a blank line fold to nothing', () => {
    expect(foldChunks('')).toEqual([]);
    expect(foldChunks('   ')).toEqual([]);
    expect(foldChunks('... --- !!!')).toEqual([]);
    expect(foldChunks('\u{200b}\u{200d}')).toEqual([]);
  });

  it("every chunk's start and end index the original text, including after stripped characters", () => {
    const text = 'x  g\u{200b}0\u{200b}ld,  ok g.o.l.d! \u{ff47}\u{ff4f}\u{ff4c}\u{ff44} \u{1f600}gold';
    for (const c of foldChunks(text)) {
      const slice = text.slice(c.start, c.end);
      expect(slice.length).toBeGreaterThan(0);
      expect(slice.trim()).toBe(slice);
      expect(foldChunks(slice).map((k) => k.folded)).toEqual([c.folded]);
    }
    const found = foldChunks(text).find((c) => c.folded === 'gold' && text.slice(c.start, c.end).includes('\u{200b}'))!;
    expect(text.slice(found.start, found.end)).toBe('g\u{200b}0\u{200b}ld');
  });

  it('offsets survive a ligature and a supplementary-plane letter', () => {
    const text = 'a \u{fb01}sh \u{1d41e}\u{1d42f}il end';
    const chunks = foldChunks(text);
    expect(chunks.map((c) => c.folded)).toEqual(['a', 'fish', 'evil', 'end']);
    expect(text.slice(chunks[1]!.start, chunks[1]!.end)).toBe('\u{fb01}sh');
    expect(text.slice(chunks[2]!.start, chunks[2]!.end)).toBe('\u{1d41e}\u{1d42f}il');
  });

  it('foldWord is the folded form of exactly one word', () => {
    expect(foldWord('G0LD')).toBe('gold');
    expect(foldWord('two words')).toBeNull();
    expect(foldWord('a-b')).toBeNull();
    expect(foldWord('...')).toBeNull();
    expect(foldWord('')).toBeNull();
  });

  it('letterCount counts letters of any script', () => {
    expect(letterCount('gold')).toBe(4);
    expect(letterCount('g0ld')).toBe(3);
    expect(letterCount('500')).toBe(0);
    expect(letterCount('\u{434}\u{430}')).toBe(2);
  });

  it('lowerKeepLength never changes the length', () => {
    expect(lowerKeepLength('ABC')).toBe('abc');
    const dotted = '\u{130}';
    expect(lowerKeepLength(dotted)).toHaveLength(1);
    expect(lowerKeepLength('A\u{130}B')).toHaveLength(3);
  });

  it('is deterministic and does not throw on lone surrogates and control characters', () => {
    const weird = '\ud800 gold \udc00 \u0000 buy \u0001';
    expect(() => foldChunks(weird)).not.toThrow();
    expect(foldChunks(weird)).toEqual(foldChunks(weird));
  });

  it('linear: doubling the input at most 2.5 times the steps', () => {
    for (const unit of ['a.', 'g0 ', '-', '***', '\u{200b}', 'ooo', '1 ']) {
      __foldSteps.n = 0;
      foldChunks(unit.repeat(5000));
      const one = __foldSteps.n;
      __foldSteps.n = 0;
      foldChunks(unit.repeat(10_000));
      expect(__foldSteps.n, unit).toBeLessThanOrEqual(one * 2.5);
    }
  });
});
