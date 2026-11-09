import { describe, expect, it } from 'vitest';
import type { ProfanityConfig } from '@chatwarden/core';
import { createProfanityFilter, ProfanityConfigError, SUPPORTED_LANGUAGES } from '../src/index.js';

// This is the one place in the repo where ordinary swearing may appear (it is the built-in English list under
// test). Mild words only, as few as will do: 'turd', 'bastard' and 'piss' are in the list. 'snerp' and 'glarn' are
// synthetic stand-ins for an adopter's own words.

const config = (over: Partial<ProfanityConfig> = {}): ProfanityConfig => ({
  mode: 'star',
  style: 'full',
  add: [],
  remove: [],
  only: null,
  languages: ['en'],
  ...over,
});
const filterFor = (over: Partial<ProfanityConfig> = {}) => createProfanityFilter(config(over));
const hits = (over: Partial<ProfanityConfig>, text: string): boolean => filterFor(over).apply(text).hit;

describe('the built-in English list', () => {
  const f = filterFor();

  it('reports no hit, and the very same text, for a clean line', () => {
    expect(f.apply('good game everyone')).toEqual({ hit: false, text: 'good game everyone' });
    expect(f.apply('')).toEqual({ hit: false, text: '' });
  });

  it('catches a listed word whatever its case, and leaves the rest of the line alone', () => {
    expect(f.apply('what a TuRd you are')).toEqual({ hit: true, text: 'what a **** you are' });
  });

  it('does not catch listed words inside innocent ones (no Scunthorpe problem)', () => {
    expect(f.apply('a classic assassin in the bassist band').hit).toBe(false);
  });

  it('catches evasion: repeated letters, a zero-width character, punctuation next to the word', () => {
    expect(f.apply('turrrd').hit).toBe(true);
    expect(f.apply('t​urd').hit).toBe(true);
    expect(f.apply('(turd)').text).toBe('(****)');
    expect(f.apply('turd!').text).toBe('****!');
  });

  it('is stateless: the same line gets the same answer every time, and filters do not share state', () => {
    const other = filterFor({ remove: ['turd'] });
    for (let i = 0; i < 5; i++) {
      expect(f.apply('you turd').hit).toBe(true);
      expect(other.apply('you turd').hit).toBe(false);
    }
  });

  it('ignores the mode: the filter reports, the chat service decides', () => {
    for (const mode of ['allow', 'star', 'refuse'] as const) {
      expect(hits({ mode }, 'you turd')).toBe(true);
    }
  });
});

describe('style', () => {
  it('full: an asterisk for each letter of the hit', () => {
    expect(filterFor({ style: 'full' }).apply('you turd, you bastard').text).toBe('you ****, you *******');
  });

  it('keepFirst: the first letter, then asterisks', () => {
    expect(filterFor({ style: 'keepFirst' }).apply('you turd, you bastard').text).toBe('you t***, you b******');
  });

  it('grawlix: a cycle of #$%@!& to the length of the hit, restarting for each hit', () => {
    expect(filterFor({ style: 'grawlix' }).apply('you turd, you bastard').text).toBe('you #$%@, you #$%@!&#');
  });

  it('measures the mask by the letters the reader sees, not by hidden characters', () => {
    expect(filterFor({ style: 'full' }).apply('t​u​rd').text).toBe('****');
    expect(filterFor({ style: 'keepFirst' }).apply('t​u​rd').text).toBe('t***');
  });

  it('masks every hit in a line', () => {
    expect(filterFor().apply('turd turd piss').text).toBe('**** **** ****');
  });

  it('an unknown style throws', () => {
    expect(() => filterFor({ style: 'blocks' as never })).toThrow(ProfanityConfigError);
  });
});

describe('remove', () => {
  it('lets a listed word through, and the others still count', () => {
    const f = filterFor({ remove: ['turd'] });
    expect(f.apply('you turd')).toEqual({ hit: false, text: 'you turd' });
    expect(f.apply('you bastard').hit).toBe(true);
  });

  it('matches case-insensitively, whatever the case of either side, and ignores stray spaces', () => {
    expect(hits({ remove: ['TURD'] }, 'you turd')).toBe(false);
    expect(hits({ remove: [' Turd '] }, 'you TURD')).toBe(false);
  });

  it('lets the evasion forms of the removed word through too (the whole entry is gone)', () => {
    const f = filterFor({ remove: ['turd'] });
    expect(f.apply('t​urd').hit).toBe(false);
    expect(f.apply('turrrd').hit).toBe(false);
  });

  it('removes several words', () => {
    const f = filterFor({ remove: ['turd', 'bastard'] });
    expect(f.apply('turd bastard').hit).toBe(false);
    expect(f.apply('piss').hit).toBe(true);
  });

  it('a word that is not in the list is harmless', () => {
    expect(hits({ remove: ['glarn'] }, 'you turd')).toBe(true);
  });

  it('removing a word does not remove a different word that merely contains it', () => {
    // 'ass' is its own entry; removing 'bass' (not an entry) must change nothing.
    expect(hits({ remove: ['bass'] }, 'you ass')).toBe(true);
  });

  it('wins over add for the same word', () => {
    expect(hits({ add: ['snerp'], remove: ['snerp'] }, 'oh snerp')).toBe(false);
  });
});

describe('add', () => {
  const f = filterFor({ add: ['snerp'] });

  it('catches a custom whole word and keeps the built-in list', () => {
    expect(f.apply('oh snerp it')).toEqual({ hit: true, text: 'oh ***** it' });
    expect(f.apply('you turd').hit).toBe(true);
  });

  it('catches case, leetspeak, repeated letters and a hidden character', () => {
    expect(f.apply('SNERP').hit).toBe(true);
    expect(f.apply('sn3rp').hit).toBe(true);
    expect(f.apply('snerrrp').hit).toBe(true);
    expect(f.apply('sn​erp').hit).toBe(true);
    expect(f.apply('sn⁠e­rp').hit).toBe(true);
    expect(f.apply('snërp').hit).toBe(true);
  });

  it('catches the word next to punctuation, including the marks leetspeak reads as letters', () => {
    expect(f.apply('snerp!').text).toBe('*****!');
    expect(f.apply('(snerp)').text).toBe('(*****)');
    expect(f.apply('$snerp$').hit).toBe(true);
  });

  it('is whole-word: not inside a longer word', () => {
    expect(f.apply('snerpy').hit).toBe(false);
    expect(f.apply('asnerp').hit).toBe(false);
    expect(f.apply('crasnerpish').hit).toBe(false);
  });

  it('accepts the word in any case and with accents in the config', () => {
    expect(hits({ add: ['SNÉRP'] }, 'oh snerp')).toBe(true);
  });

  it('adds several words', () => {
    const g = filterFor({ add: ['snerp', 'glarn'] });
    expect(g.apply('snerp glarn').text).toBe('***** *****');
  });

  it('a word that is not plain letters throws, without echoing it', () => {
    for (const bad of ['sn3rp', 'sn erp', 'sn-erp', 'sn[e]rp', 'sn|rp', '', 'ab', 'aab', 'sne\\rp']) {
      let message = '';
      try {
        filterFor({ add: [bad] });
      } catch (err) {
        expect(err).toBeInstanceOf(ProfanityConfigError);
        message = (err as Error).message;
      }
      expect(message, `add word ${JSON.stringify(bad)}`).not.toBe('');
      if (bad.length > 2) expect(message).not.toContain(bad);
      expect(message).toContain('profanity.add[0]');
    }
  });

  it('a non-string word throws', () => {
    expect(() => filterFor({ add: [42 as never] })).toThrow(ProfanityConfigError);
  });
});

describe('only', () => {
  it('counts exactly the listed words: the built-in list is not used', () => {
    const f = filterFor({ only: ['snerp'] });
    expect(f.apply('you turd')).toEqual({ hit: false, text: 'you turd' });
    expect(f.apply('oh snerp').text).toBe('oh *****');
  });

  it('can list a word the built-in list also has, as a whole-word entry', () => {
    const f = filterFor({ only: ['turd'] });
    expect(f.apply('you TURD').text).toBe('you ****');
    expect(f.apply('you bastard').hit).toBe(false);
    expect(f.apply('t​urd').hit).toBe(true);
  });

  it('an empty list means nothing counts', () => {
    const f = filterFor({ only: [] });
    expect(f.apply('turd bastard piss')).toEqual({ hit: false, text: 'turd bastard piss' });
  });

  it('add still applies on top of only', () => {
    const f = filterFor({ only: ['snerp'], add: ['glarn'] });
    expect(f.apply('snerp glarn turd').text).toBe('***** ***** turd');
  });

  it('remove still applies to the listed words', () => {
    const f = filterFor({ only: ['snerp', 'glarn'], remove: ['glarn'] });
    expect(f.apply('snerp glarn').text).toBe('***** glarn');
  });

  it('is whole-word and has the same evasion handling as add', () => {
    const f = filterFor({ only: ['snerp'] });
    expect(f.apply('snerpy').hit).toBe(false);
    expect(f.apply('sn3rp').hit).toBe(true);
    expect(f.apply('sn​erp').hit).toBe(true);
  });

  it('a word that is not plain letters throws, naming the field', () => {
    expect(() => filterFor({ only: ['ok1'] })).toThrow(/profanity\.only\[0\]/);
  });

  it('only null is the built-in list', () => {
    expect(hits({ only: null }, 'you turd')).toBe(true);
  });
});

describe('languages', () => {
  it('en is the only built-in list today', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['en']);
    expect(hits({ languages: ['en'] }, 'you turd')).toBe(true);
  });

  it('an unknown language throws, naming the field and the language', () => {
    expect(() => filterFor({ languages: ['xx'] })).toThrow(ProfanityConfigError);
    expect(() => filterFor({ languages: ['en', 'xx'] })).toThrow(/profanity\.languages\[1\].*xx/);
  });

  it('an unknown language throws even when only is set (a typo should not pass silently)', () => {
    expect(() => filterFor({ only: ['snerp'], languages: ['xx'] })).toThrow(ProfanityConfigError);
  });

  it('language codes are exact: EN is not en', () => {
    expect(() => filterFor({ languages: ['EN'] })).toThrow(ProfanityConfigError);
  });

  it('no languages means no built-in list, so only add counts', () => {
    const f = filterFor({ languages: [], add: ['snerp'] });
    expect(f.apply('turd').hit).toBe(false);
    expect(f.apply('snerp').hit).toBe(true);
  });
});

describe('the config', () => {
  it('works from a frozen config (a resolved profile is deep-frozen) and copies it', () => {
    const cfg = config({ add: ['snerp'] });
    const frozen = Object.freeze({ ...cfg, add: Object.freeze([...cfg.add]) as string[] });
    const f = createProfanityFilter(frozen);
    cfg.add.push('glarn');
    expect(f.apply('snerp').hit).toBe(true);
    expect(f.apply('glarn').hit).toBe(false);
  });

  it('later changes to the config arrays do not reach a built filter', () => {
    const cfg = config({ remove: ['turd'] });
    const f = createProfanityFilter(cfg);
    cfg.remove.length = 0;
    expect(f.apply('turd').hit).toBe(false);
  });

  it('a list that is not an array throws', () => {
    expect(() => filterFor({ add: 'snerp' as never })).toThrow(ProfanityConfigError);
    expect(() => filterFor({ remove: null as never })).toThrow(ProfanityConfigError);
    expect(() => filterFor({ languages: undefined as never })).toThrow(ProfanityConfigError);
  });

  it('a config that is not an object throws', () => {
    expect(() => createProfanityFilter(null as never)).toThrow(ProfanityConfigError);
  });
});
