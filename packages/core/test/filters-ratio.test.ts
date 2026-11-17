import { describe, expect, it } from 'vitest';
import { resolveFilters, type ResolvedRatio } from '../src/filters.js';
import { scanRatio, soften } from '../src/filters/ratio.js';

const cfg = (extra: Record<string, unknown> = {}): ResolvedRatio => resolveFilters({ ratio: { action: 'mask', ...extra } } as never).ratio!;
const details = (text: string, c: ResolvedRatio = cfg()): string[] => scanRatio(text, c).map((m) => m.detail);

describe('caps', () => {
  it('caps over 70 percent of 12 or more letters', () => {
    expect(details('THIS IS ALL SHOUTING NOW')).toEqual(['caps']);
    expect(details('AAAAAAAAAAAA')).toContain('caps');
    expect(details('AAAAAAAAAAA')).not.toContain('caps'); // 11 letters never
    expect(details('ABCDEFGHIJK lm')).toContain('caps'); // 13 letters, 11 of them upper
  });

  it('11 letters never, however loud', () => {
    expect(details('HELLO THERE!!')).not.toContain('caps'); // 10 letters
    expect(details('ABCDEFGHIJK')).not.toContain('caps');
  });

  it('the percentage is over, not at: 21 of 30 is 70 percent and does not count', () => {
    const at = `${'A'.repeat(21)}${'b'.repeat(9)}`;
    expect(details(at)).not.toContain('caps');
    expect(details(`${'A'.repeat(22)}${'b'.repeat(8)}`)).toContain('caps');
  });

  it('digits, punctuation and spaces are not letters', () => {
    expect(details('1234567890 !!!! ???? 5555 6666')).toEqual([]);
    expect(details(`${'A'.repeat(12)} ${'1'.repeat(100)}`)).toContain('caps');
  });

  it('only cased letters count (a script without case never shouts)', () => {
    expect(details('\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}\u{4e16}\u{754c}\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}\u{4e16}\u{754c}\u{3053}\u{3093}')).toEqual([]);
  });

  it('the numbers come from the settings', () => {
    expect(details('ABCDEFGHI jk', cfg({ caps: { minLetters: 8, maxPercent: 80 } }))).toContain('caps');
    expect(details('ABCDEFGHI jk', cfg({ caps: { minLetters: 12, maxPercent: 50 } }))).not.toContain('caps');
    expect(details('AAAAAAAAAAAA', cfg({ caps: null }))).not.toContain('caps');
  });
});

describe('repeats', () => {
  it('7 of one character counts; 6 does not', () => {
    expect(details('nooooooo')).toEqual(['repeats']); // 7 o
    expect(details('noooooo')).toEqual([]); // 6 o
    expect(details('!!!!!!!')).toEqual(['repeats']);
    expect(details('aaaaaaa')).toEqual(['repeats']);
  });

  it('spaces and asterisks are not a repeat', () => {
    expect(details(`a${' '.repeat(50)}b`)).toEqual([]);
    expect(details('*'.repeat(30))).toEqual([]);
  });

  it('a different character breaks the run', () => {
    expect(details('aaaaabaaaaabaaaaab')).toEqual([]);
    expect(details('aAaAaAaAaAaA')).toEqual([]);
  });

  it('counts a repeated emoji or other astral character as one repeated character', () => {
    expect(details('\u{1f600}'.repeat(7), cfg({ emoji: null }))).toEqual(['repeats']);
    expect(details('\u{1f600}'.repeat(6), cfg({ emoji: null }))).toEqual([]);
  });

  it('the run length comes from the settings, and null turns it off', () => {
    expect(details('aaaa', cfg({ repeats: { maxRun: 3 } }))).toContain('repeats');
    expect(details('aaaaaaaaaaaa', cfg({ repeats: null }))).toEqual([]);
  });
});

describe('emoji', () => {
  it('over 8 counts, 8 does not', () => {
    expect(details('\u{1f600}\u{1f601}\u{1f602}\u{1f603}\u{1f604}\u{1f605}\u{1f606}\u{1f607}\u{1f608}')).toEqual(['emoji']);
    expect(details('\u{1f600}\u{1f601}\u{1f602}\u{1f603}\u{1f604}\u{1f605}\u{1f606}\u{1f607}')).toEqual([]);
  });

  it('a ZWJ sequence, a skin tone and a flag count once', () => {
    const family = '\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}';
    expect(details(family.repeat(8))).toEqual([]);
    expect(details(family.repeat(9))).toEqual(['emoji']);
    const wave = '\u{1f44b}\u{1f3fd}';
    expect(details(wave.repeat(8))).toEqual([]);
    expect(details(wave.repeat(9))).toEqual(['emoji']);
    const flag = '\u{1f1fa}\u{1f1f8}';
    expect(details(flag.repeat(8))).toEqual([]);
    expect(details(flag.repeat(9))).toEqual(['emoji']);
  });

  it('plain text, digits and punctuation are not emoji', () => {
    expect(details('hello 123 #*! world')).toEqual([]);
  });

  it('the number comes from the settings', () => {
    expect(details('\u{1f600}\u{1f601}\u{1f602}', cfg({ emoji: { max: 2 } }))).toEqual(['emoji']);
    expect(details('\u{1f600}'.repeat(3), cfg({ emoji: { max: 2 }, repeats: null }))).toEqual(['emoji']);
    expect(details('\u{1f600}\u{1f601}\u{1f602}\u{1f603}\u{1f604}\u{1f605}\u{1f606}\u{1f607}\u{1f608}', cfg({ emoji: null }))).toEqual([]);
  });
});

describe('mentions', () => {
  it('over 3 counts, 3 does not', () => {
    expect(details('@zorbak @vlemmo @quissel')).toEqual([]);
    expect(details('@zorbak @vlemmo @quissel @drakkuun')).toEqual(['mentions']);
  });

  it('an email address or a lone @ is not a mention', () => {
    expect(details('a@b.com c@d.com e@f.com g@h.com')).toEqual([]);
    expect(details('@ @ @ @ @')).toEqual([]);
  });

  it('the number comes from the settings', () => {
    expect(details('@a1 @b2', cfg({ mentions: { max: 1 } }))).toEqual(['mentions']);
    expect(details('@a1 @b2 @c3 @d4 @e5', cfg({ mentions: null }))).toEqual([]);
  });
});

describe('several at once, and the clean line', () => {
  it('reports each that applies, in the fixed order', () => {
    const line = `${'A'.repeat(14)} ${'!'.repeat(8)} @a1 @b2 @c3 @d4 ${'\u{1f600}\u{1f601}\u{1f602}\u{1f603}\u{1f604}\u{1f605}\u{1f606}\u{1f607}\u{1f608}'}`;
    expect(details(line)).toEqual(['caps', 'repeats', 'emoji', 'mentions']);
  });

  it('an ordinary line reports nothing', () => {
    for (const t of ['hello everyone, good game!', 'GG', 'lol that was close :)', 'see you at 8 pm', '']) expect(details(t), t).toEqual([]);
  });

  it('non-string input gives nothing and does not throw', () => {
    expect(scanRatio(undefined as never, cfg())).toEqual([]);
    expect(scanRatio(5 as never, cfg())).toEqual([]);
  });
});

describe('soften', () => {
  it('caps: lowercase except the first letter of a sentence', () => {
    expect(soften('THIS IS ALL SHOUTING NOW. AND MORE!', cfg())).toBe('This is all shouting now. And more!');
    expect(soften('HELLO THERE FRIEND OF MINE', cfg())).toBe('Hello there friend of mine');
  });

  it('repeats: a run is cut to the maximum', () => {
    expect(soften('nooooooooo way!!!!!!!!!', cfg())).toBe('noooooo way!!!!!!');
    expect(soften('aaaaaaaaaa', cfg({ repeats: { maxRun: 3 } }))).toBe('aaa');
  });

  it('emoji: the extras are cut, a sequence is kept or cut whole', () => {
    const nine = '\u{1f600}\u{1f601}\u{1f602}\u{1f603}\u{1f604}\u{1f605}\u{1f606}\u{1f607}\u{1f608}';
    expect(soften(`hi ${nine}`, cfg())).toBe('hi \u{1f600}\u{1f601}\u{1f602}\u{1f603}\u{1f604}\u{1f605}\u{1f606}\u{1f607}');
    const family = '\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}';
    expect(soften(`${family}${family}${family}`, cfg({ emoji: { max: 2 } }))).toBe(`${family}${family}`);
    expect(soften('\u{1f1fa}\u{1f1f8}\u{1f1ec}\u{1f1e7}\u{1f1eb}\u{1f1f7}', cfg({ emoji: { max: 2 } }))).toBe('\u{1f1fa}\u{1f1f8}\u{1f1ec}\u{1f1e7}');
  });

  it('mentions: the extras are cut', () => {
    expect(soften('@a1 @b2 @c3 @d4 hi', cfg())).toBe('@a1 @b2 @c3  hi');
    expect(soften('hey @a1 @b2 @c3 @d4 @e5', cfg({ mentions: { max: 1 } }))).toBe('hey @a1    ');
  });

  it('a line that triggers nothing comes back unchanged', () => {
    for (const t of ['hello world', 'GG', 'ok!!!', '']) expect(soften(t, cfg()), t).toBe(t);
  });

  it('only the checks that triggered are applied: a short shout is left alone', () => {
    expect(soften('HELLO THERE', cfg())).toBe('HELLO THERE');
  });

  it('never grows the text, whatever the input', () => {
    const inputs = ['\u{130}'.repeat(30), 'A\u{130}B '.repeat(20), '\u{df}'.repeat(40), 'STRA\u{df}E '.repeat(10), '\u{1f600}'.repeat(100), '@x1 '.repeat(50), `${'Z'.repeat(40)}!!!!!!!!!!!!`, '\u{1c5}'.repeat(30)];
    for (const t of inputs) {
      const out = soften(t, cfg());
      expect(out.length, JSON.stringify(t)).toBeLessThanOrEqual(t.length);
    }
  });

  it('is idempotent: softening a softened line changes nothing', () => {
    const t = `${'A'.repeat(20)} nooooooooo @a1 @b2 @c3 @d4 ${'\u{1f600}'.repeat(12)}`;
    const once = soften(t, cfg());
    expect(soften(once, cfg())).toBe(once);
  });

  it('non-string input comes back as an empty string and does not throw', () => {
    expect(soften(undefined as never, cfg())).toBe('');
  });
});
