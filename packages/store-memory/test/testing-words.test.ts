import { describe, expect, it } from 'vitest';
import { wordFilter, wordMatcher } from '../src/testing/words.js';

describe('wordMatcher', () => {
  const m = wordMatcher(['zorbak', 'vlemmo']);

  it('whole words only (zorbakian is not zorbak), case-insensitive, punctuation-adjacent', () => {
    expect(m.match('you zorbak')).not.toBeNull();
    expect(m.match('ZORBAK')).not.toBeNull();
    expect(m.match('Zorbak!')).not.toBeNull();
    expect(m.match('(vlemmo)')).not.toBeNull();
    expect(m.match('well,zorbak.')).not.toBeNull();
    expect(m.match('zorbakian')).toBeNull();
    expect(m.match('azorbak')).toBeNull();
    expect(m.match('zorbak_x')).toBeNull();
    expect(m.match('zorbak2')).toBeNull();
    expect(m.match('zorba k')).toBeNull();
    expect(m.match('')).toBeNull();
    expect(m.match('nothing here')).toBeNull();
  });

  it('a hit carries a term id that does not hold the word typed and is stable per word', () => {
    const a = m.match('ZORBAK')!;
    expect(a).toEqual(m.match('zorbak'));
    expect(a.termId).not.toEqual(m.match('vlemmo')!.termId);
    expect(a.termId).toMatch(/^test:/);
  });

  it('spans are on the original text', () => {
    expect(m.spans!('you ZORBAK and vlemmo.')).toEqual([
      { start: 4, end: 10, termId: m.match('zorbak')!.termId },
      { start: 15, end: 21, termId: m.match('vlemmo')!.termId },
    ]);
    expect(m.spans!('zorbakian')).toEqual([]);
    expect(m.spans!('')).toEqual([]);
    // Empty exactly when match is null.
    for (const text of ['x', 'zorbak', 'a vlemmo b', 'zorbakx']) expect(m.spans!(text).length === 0, text).toBe(m.match(text) === null);
  });

  it('a word at the very start and the very end of the text is found', () => {
    expect(m.spans!('zorbak')).toEqual([{ start: 0, end: 6, termId: m.match('zorbak')!.termId }]);
    expect(m.spans!('x zorbak')).toEqual([{ start: 2, end: 8, termId: m.match('zorbak')!.termId }]);
  });

  it('an empty list blocks nothing', () => {
    const none = wordMatcher([]);
    expect(none.match('zorbak')).toBeNull();
    expect(none.spans!('zorbak')).toEqual([]);
  });

  it('a regex metacharacter in a word is literal', () => {
    const dots = wordMatcher(['a.c', 'x+y', '(q)', '[z]', 'f*k', '^s$', 'a|b']);
    expect(dots.match('a.c')).not.toBeNull();
    expect(dots.match('abc')).toBeNull();
    expect(dots.match('x+y')).not.toBeNull();
    expect(dots.match('xxy')).toBeNull();
    expect(dots.match('f*k')).not.toBeNull();
    expect(dots.match('ffk')).toBeNull();
    expect(dots.match('^s$')).not.toBeNull();
    expect(dots.match('a|b')).not.toBeNull();
    expect(dots.match('a')).toBeNull();
    expect(dots.match('say (q) now')).not.toBeNull();
    expect(dots.match('see [z]')).not.toBeNull();
  });

  it('a word list that is not strings, or has an empty word, is refused when it is built', () => {
    expect(() => wordMatcher([''])).toThrow(TypeError);
    expect(() => wordMatcher([5 as unknown as string])).toThrow(TypeError);
    expect(() => wordMatcher('zorbak' as unknown as string[])).toThrow(TypeError);
    expect(() => wordMatcher(['  '])).toThrow(TypeError);
  });

  it('the longest word wins where two overlap, and a repeated word is found each time', () => {
    const both = wordMatcher(['go', 'go go']);
    expect(both.spans!('go go').map((s) => [s.start, s.end])).toEqual([[0, 5]]);
    expect(m.spans!('zorbak zorbak').length).toBe(2);
  });

  it('does not change when the list it was built from changes', () => {
    const words = ['zorbak'];
    const copy = wordMatcher(words);
    words.push('vlemmo');
    expect(copy.match('vlemmo')).toBeNull();
  });

  it('works for letters beyond ASCII (the word boundary is Unicode-aware)', () => {
    const accents = wordMatcher(['quissel']);
    expect(accents.match('équissel')).toBeNull();
    expect(accents.match('quisselé')).toBeNull();
    expect(accents.match('é quissel é')).not.toBeNull();
  });
});

describe('wordFilter', () => {
  const f = wordFilter(['snerp', 'glarn']);

  it('stars whole words and reports hit', () => {
    expect(f.apply('what a snerp')).toEqual({ hit: true, text: 'what a *****' });
    expect(f.apply('SNERP and glarn!')).toEqual({ hit: true, text: '***** and *****!' });
    expect(f.apply('snerpy')).toEqual({ hit: false, text: 'snerpy' });
    expect(f.apply('nothing')).toEqual({ hit: false, text: 'nothing' });
    expect(f.apply('')).toEqual({ hit: false, text: '' });
  });

  it('the stars are as many as the letters, so a line keeps its length', () => {
    for (const text of ['snerp', 'a snerp b', 'glarn glarn']) expect(f.apply(text).text.length).toBe(text.length);
  });

  it('an empty list changes nothing', () => {
    expect(wordFilter([]).apply('snerp')).toEqual({ hit: false, text: 'snerp' });
  });

  it('a metacharacter is literal here too, and a bad list is refused', () => {
    expect(wordFilter(['a.c']).apply('abc a.c')).toEqual({ hit: true, text: 'abc ***' });
    expect(() => wordFilter([''])).toThrow(TypeError);
  });
});
