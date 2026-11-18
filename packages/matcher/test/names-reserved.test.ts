import { describe, expect, it } from 'vitest';
import { buildMatcher, matchReserved, skeleton } from '../src/index.js';

// M6: reserved names. `skeleton` reads a text the way the matcher does (hidden characters off, look-alikes and leetspeak folded, repeats cut) and keeps only a-z0-9; `matchReserved` asks whether a NAME, read as whole
// words, is one of the protected entries. Only invented words are used.

describe('skeleton', () => {
  it('M0d_Anna, Mod_Anna, m.o.d anna and MODDD anna fold to one key', () => {
    const keys = ['M0d_Anna', 'Mod_Anna', 'm.o.d anna', 'MODDD anna', 'mod anna', 'MOD-ANNA'].map(skeleton);
    expect(new Set(keys)).toEqual(new Set(['modana']));
  });

  it('the result is only a-z0-9, whatever goes in', () => {
    for (const text of ['M0d_Anna', 'caf\u00e9 au lait', '\u2620 skull 42', 'a\u200bb\u200dc', '\u0000\u0007x', 'tab\there', '\u202eevil\u202c', '']) {
      expect(skeleton(text), JSON.stringify(text)).toMatch(/^[a-z0-9]*$/);
    }
    expect(skeleton('')).toBe('');
    expect(skeleton('___ ...')).toBe('');
  });

  it('Cyrillic and fullwidth look-alikes fold to the Latin letters', () => {
    expect(skeleton('\u043c\u043eder\u0430tor')).toBe(skeleton('moderator'));
    expect(skeleton('\uff2d\uff4f\uff44\uff45\uff52\uff41\uff54\uff4f\uff52')).toBe(skeleton('moderator'));
    expect(skeleton('\u0430dmin')).toBe(skeleton('admin'));
  });

  it('leetspeak folds and repeated letters are cut', () => {
    expect(skeleton('4dm1n')).toBe(skeleton('admin'));
    expect(skeleton('M0D3R4T0R')).toBe(skeleton('moderator'));
    expect(skeleton('adminnnn')).toBe(skeleton('admin'));
    expect(skeleton('g@me m@ster')).toBe(skeleton('game master'));
  });

  it('zero-width characters, accents and format characters vanish', () => {
    expect(skeleton('m\u200bo\u200dd\u2060erator')).toBe(skeleton('moderator'));
    expect(skeleton('M\u00f3d\u00e9r\u00e4t\u00f6r')).toBe(skeleton('moderator'));
    expect(skeleton('mo\u00addera\ufefftor')).toBe(skeleton('moderator'));
  });

  it('a word that is not a look-alike stays different, and digits the chain does not read stay', () => {
    expect(skeleton('moderators')).not.toBe(skeleton('moderator'));
    expect(skeleton('admin8')).toBe(`${skeleton('admin')}8`);
  });
});

describe('matchReserved', () => {
  const entries = ['moderator', 'mod', 'game master', 'admin'];

  it('entry moderator matches Moderator and M0derator', () => {
    for (const name of ['Moderator', 'M0derator', 'moderator', 'MODERATOR', 'm\u043ederator']) {
      expect(matchReserved(name, ['moderator'], []), name).toBe(true);
    }
  });

  it('entry mod matches Mod_Anna, M0d_Anna, ModAnna, mod anna and m o d anna', () => {
    for (const name of ['Mod_Anna', 'M0d_Anna', 'ModAnna', 'mod anna', 'm o d anna', 'Mod-Anna', 'MODDD anna', 'mod']) {
      expect(matchReserved(name, ['mod'], []), name).toBe(true);
    }
  });

  it('neither matches xXmodXx, Sodmin (for admin) or a longer different word such as Moderately', () => {
    expect(matchReserved('xXmodXx', ['mod', 'moderator'], [])).toBe(false);
    expect(matchReserved('Sodmin', ['admin'], [])).toBe(false);
    expect(matchReserved('Moderately', ['mod', 'moderator'], [])).toBe(false);
    expect(matchReserved('Admiral', ['admin'], [])).toBe(false);
    expect(matchReserved('Modest_Anna', ['mod'], [])).toBe(false);
    expect(matchReserved('Anna', entries, [])).toBe(false);
  });

  it('a two-word entry matches game_master, GameMaster and game master, and the words run together', () => {
    for (const name of ['game_master', 'GameMaster', 'game master', 'Game_Master_7', 'GAMEMASTER', 'g4me m4ster']) {
      expect(matchReserved(name, ['game master'], []), name).toBe(true);
    }
    expect(matchReserved('game', ['game master'], [])).toBe(false);
    expect(matchReserved('master_game', ['game master'], [])).toBe(false);
  });

  it('digits and punctuation around a word do not hide it: Mod_Anna99, 007_admin, [admin]', () => {
    for (const name of ['Mod_Anna99', '007_admin', '[admin]', 'admin123', 'the_admin_']) expect(matchReserved(name, ['admin', 'mod'], []), name).toBe(true);
  });

  it('look-alike letters count: a Cyrillic a in admin matches', () => {
    expect(matchReserved('\u0430dmin_Ann', ['admin'], [])).toBe(true);
    expect(matchReserved('Adm\u0456n', ['admin'], [])).toBe(true);
  });

  it('hidden characters cannot split a protected word', () => {
    expect(matchReserved('mod\u200b_Anna', ['mod'], [])).toBe(true);
    expect(matchReserved('ad\u200dmin', ['admin'], [])).toBe(true);
  });

  it('no entries, an empty name or a name of only symbols match nothing', () => {
    expect(matchReserved('Moderator', [], [])).toBe(false);
    expect(matchReserved('', entries, [])).toBe(false);
    expect(matchReserved('___', entries, [])).toBe(false);
    expect(matchReserved('\u2620\u2620', entries, [])).toBe(false);
  });

  it('an entry whose skeleton is empty never matches (it would match everything)', () => {
    expect(matchReserved('Anna', ['___'], [])).toBe(false);
    expect(matchReserved('Anna', ['\u200b\u200b'], [])).toBe(false);
  });

  it('a long name is read up to 256 characters, and a huge one is cheap and never throws', () => {
    expect(matchReserved(`${'word_'.repeat(40)}admin`, ['admin'], [])).toBe(true);
    expect(matchReserved('x'.repeat(5000), ['admin'], [])).toBe(false);
    const started = Date.now();
    expect(matchReserved('a_'.repeat(50_000), ['admin', 'moderator', 'game master'], [])).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('reservedAllow', () => {
  it('a name whose whole skeleton equals an allowed one passes: Moderator passes if allowed, ModeratorX does not', () => {
    expect(matchReserved('Moderator', ['moderator'], ['Moderator'])).toBe(false);
    expect(matchReserved('ModeratorX', ['mod', 'moderator'], ['Moderator'])).toBe(true);
    expect(matchReserved('Mod_Anna', ['mod'], ['Moderator'])).toBe(true);
    expect(matchReserved('Mod', ['mod'], ['Moderator'])).toBe(true);
  });

  it('the allowed name is compared whole, by skeleton: M0derator and moderator are one name', () => {
    expect(matchReserved('M0derator', ['moderator'], ['moderator'])).toBe(false);
    expect(matchReserved('moderator_', ['moderator'], ['moderator'])).toBe(false);
    expect(matchReserved('Moderator Moderator', ['moderator'], ['moderator'])).toBe(true);
  });

  it('an allowed name that is only symbols allows nothing', () => {
    expect(matchReserved('Mod_Anna', ['mod'], ['___'])).toBe(true);
  });

  it('an allowed name does not allow a different reserved word inside a longer name', () => {
    expect(matchReserved('admin_moderator', ['admin', 'moderator'], ['moderator'])).toBe(true);
  });
});

describe('the matcher carries it', () => {
  const matcher = buildMatcher([{ id: 't1', term: 'zorbak', language: 'en', active: true }], []);

  it('a built matcher answers matchReserved like the function, and still answers matchName and match as before', () => {
    expect(matcher.matchReserved?.('Mod_Anna', ['mod'], [])).toBe(true);
    expect(matcher.matchReserved?.('Anna', ['mod'], [])).toBe(false);
    expect(matcher.matchReserved?.('Mod_Anna', ['mod'], ['Mod_Anna'])).toBe(false);
    expect(matcher.matchName?.('Zorbak_99')).toEqual({ termId: 't1' });
    expect(matcher.match('hello')).toBeNull();
  });

  it('a matcher with no active term still answers matchReserved (the two lists are independent)', () => {
    const empty = buildMatcher([], []);
    expect(empty.matchReserved?.('Moderator', ['moderator'], [])).toBe(true);
  });

  it('the same entries object is compiled once and a changed list is read fresh', () => {
    const entries = ['mod'];
    expect(matcher.matchReserved?.('Mod_Anna', entries, [])).toBe(true);
    expect(matcher.matchReserved?.('Mod_Anna', entries, [])).toBe(true);
    expect(matcher.matchReserved?.('Mod_Anna', ['admin'], [])).toBe(false);
  });
});

describe('an entry matches itself exactly when it protects something (the kit probes this, review m9)', () => {
  it('a Latin entry matches itself; an entry with no Latin skeleton (Han, dashes) does not', () => {
    const han = String.fromCodePoint(0x7ba1, 0x7406, 0x5458);
    const entries = ['mod', 'M0derator', han, '---', 'staff team'];
    const verdicts = entries.map((e) => matchReserved(e, entries, []));
    expect(verdicts).toEqual([true, true, false, false, true]);
  });
});
