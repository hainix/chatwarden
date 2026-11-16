import { loadTermPack } from '@chatwarden/matcher';
import { beforeEach, describe, expect, it } from 'vitest';
import { INNOCENT_TOP_RANK, loadInnocentWords, innocentRank } from '../src/dictionary.js';
import { MAX_NEGATIVES, SUPPORTED_LANGUAGES, arrivalGate, crossLanguageGate, readNote } from '../src/gates.js';
import { wordKey } from '../src/wordkey.js';
import { applySchema, createD1, type TestD1 } from './d1.js';

// Invented words only (zorbak, vlemmo, quissel, drakkuun, fenrisk, tarvo, snerp, glarn); non-ASCII as \u escapes.

let db: TestD1;
beforeEach(async () => {
  db = createD1();
  await applySchema(db);
});

const seed = async (rows: [string, string, number | null][]) => {
  for (const [language, key, rank] of rows) await db.prepare('INSERT INTO innocent_words VALUES (?, ?, ?)').bind(language, key, rank).run();
};
const valid = (over: Record<string, unknown> = {}) => ({ term: 'zorbak', language: 'en', category: 'slur', target: 'none', note: null, ...over });

describe("wordKey equals the kit's duplicate key (parity test against loadTermPack's rule for accents, repeats, fullwidth)", () => {
  const pack = (a: string, b: string) => ({
    id: 'p',
    version: '1',
    terms: [
      { id: 'a', term: a, language: 'en', positive: [], negative: [] },
      { id: 'b', term: b, language: 'en', positive: [], negative: [] },
    ],
    exceptions: [],
    negativeCorpus: [],
    knownLosses: [],
  });
  const kitSaysSame = (a: string, b: string): boolean => {
    try {
      loadTermPack(pack(a, b));
      return false;
    } catch (e) {
      return /reads as the same word/.test((e as Error).message);
    }
  };

  const pairs: [string, string][] = [
    ['zorbak', 'Zorbak'],
    ['zorbak', 'ZORBAK'],
    ['zorbak', 'z\u00f3rbak'], // accent
    ['zorbak', 'zo\u0301rbak'], // combining accent
    ['zorbak', 'zorbaak'], // a repeated letter that collapses
    ['vlemmo', 'vlemmmo'],
    ['drakkuun', 'drakun'],
    ['snerp', 'snerrrp'],
    ['glarn', 'gl\u00e0rn'],
    ['tarvo', 'tarvoo'], // o keeps two: different words
    ['fenrisk', 'fenris'],
    ['quissel', 'quisel'], // s and e keep two: quisel is different from quissel
    ['quissel', 'quisssel'], // three s collapse to two
    ['zorbak', 'zorbaks'],
    ['zorbak', '\uff5a\uff4f\uff52\uff42\uff41\uff4b'], // fullwidth letters are not plain letters: never the same word
  ];
  it.each(pairs)('%s and %s: the same key exactly when the kit reads them as one word', (a, b) => {
    expect(wordKey(a) === wordKey(b)).toBe(kitSaysSame(a, b));
  });

  it('the parity oracle is not vacuous: the kit does call some pairs one word and others two', () => {
    expect(kitSaysSame('zorbak', 'Zorbak')).toBe(true);
    expect(kitSaysSame('zorbak', 'zorbaks')).toBe(false);
  });

  it('is the lower-case folded, collapsed word, and trims', () => {
    expect(wordKey('  Z\u00d3RBAAK ')).toBe('zorbak');
    expect(wordKey('drakkuun')).toBe('drakun');
  });
});

describe('a word in the top-ranked innocent words is known_innocent; one outside is ok', () => {
  it('declines a top-ranked word of the same language, with the closed code and no word in the result', async () => {
    await seed([['en', 'glarn', 12]]);
    const res = await arrivalGate(valid({ term: 'Glarn' }), db);
    expect(res).toEqual({ ok: false, code: 'known_innocent' });
    expect(JSON.stringify(res)).not.toMatch(/glarn/i);
  });

  it('is exact at the rank boundary', async () => {
    await seed([
      ['en', 'snerp', INNOCENT_TOP_RANK],
      ['en', 'tarvo', INNOCENT_TOP_RANK + 1],
    ]);
    expect((await arrivalGate(valid({ term: 'snerp' }), db)).ok).toBe(false);
    expect((await arrivalGate(valid({ term: 'tarvo' }), db)).ok).toBe(true);
  });

  it('lets through a dictionary word with no rank, a word not in the dictionary, and a top word of another language', async () => {
    await seed([
      ['en', 'vlemmo', null],
      ['es', 'glarn', 3],
    ]);
    expect(await arrivalGate(valid({ term: 'vlemmo' }), db)).toMatchObject({ ok: true, wordKey: 'vlemo' });
    expect(await arrivalGate(valid({ term: 'zorbak' }), db)).toMatchObject({ ok: true });
    expect(await arrivalGate(valid({ term: 'glarn', language: 'en' }), db)).toMatchObject({ ok: true });
    expect(await arrivalGate(valid({ term: 'glarn', language: 'es' }), db)).toEqual({ ok: false, code: 'known_innocent' });
  });

  it('compares the folded, collapsed key: an accent or a repeated letter does not get round the dictionary', async () => {
    await seed([['en', 'drakun', 40]]);
    for (const term of ['drakkuun', 'DRAKKUUN', 'dr\u00e1kkuun', 'drakkkuun']) {
      expect(await arrivalGate(valid({ term }), db), term).toEqual({ ok: false, code: 'known_innocent' });
    }
  });

  it('innocentRank returns the rank, null for a word with no rank and for a word that is not there', async () => {
    await seed([
      ['en', 'glarn', 7],
      ['en', 'snerp', null],
    ]);
    expect(await innocentRank(db, 'en', 'glarn')).toBe(7);
    expect(await innocentRank(db, 'en', 'snerp')).toBeNull();
    expect(await innocentRank(db, 'en', 'tarvo')).toBeNull();
    expect(await innocentRank(db, 'es', 'glarn')).toBeNull();
  });
});

describe('arrivalGate: the cheap checks, one closed code each', () => {
  it('accepts a good submission and returns the key and the cleaned fields', async () => {
    const res = await arrivalGate(valid({ term: 'Zorbak', note: 'seen in lobby chat' }), db);
    expect(res).toEqual({
      ok: true,
      wordKey: 'zorbak',
      term: 'Zorbak',
      language: 'en',
      category: 'slur',
      target: 'none',
      note: 'seen in lobby chat',
    });
  });

  it('defaults the target to none and an empty or missing note to null', async () => {
    expect(await arrivalGate({ term: 'zorbak', language: 'en', category: 'abuse' }, db)).toMatchObject({ ok: true, target: 'none', note: null });
    expect(await arrivalGate(valid({ note: '   ' }), db)).toMatchObject({ ok: true, note: null });
  });

  const invalidTerms: [string, unknown][] = [
    ['not a string', 42],
    ['null', null],
    ['empty', ''],
    ['spaces', '   '],
    ['two words', 'zor bak'],
    ['a digit', 'zorbak1'],
    ['a hyphen', 'zor-bak'],
    ['leading space', ' zorbak'],
    ['an underscore', 'zorbak_'],
    ['41 letters', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmno'],
    ['under 3 letters once repeats collapse', 'aaab'],
    ['two letters', 'zo'],
    ['cyrillic', '\u0437\u043e\u0440\u0431\u0430\u043a'],
    ['fullwidth', '\uff5a\uff4f\uff52\uff42\uff41\uff4b'],
    ['an emoji', 'zorbak\u{1f600}'],
    ['a right-to-left word', '\u0632\u0648\u0631\u0628\u0627\u0643'],
    ['a zero-width joiner inside', 'zor\u200dbak'],
    ['a letter with no ascii fold', 'zorb\u00f8k'],
    ['a newline', 'zorbak\nzorbak'],
  ];
  it.each(invalidTerms)('refuses a term that is %s as invalid', async (_n, term) => {
    expect(await arrivalGate(valid({ term }), db)).toEqual({ ok: false, code: 'invalid' });
  });

  it('accepts a 40-character word and a word with accents that fold to plain letters', async () => {
    expect((await arrivalGate(valid({ term: 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn' }), db)).ok).toBe(true);
    expect(await arrivalGate(valid({ term: 'Zorb\u00e1k', language: 'es' }), db)).toMatchObject({ ok: true, wordKey: 'zorbak' });
  });

  it('separates a language we do not serve from a malformed one', async () => {
    for (const language of ['fr', 'de', 'ja', 'xx', 'zho']) expect(await arrivalGate(valid({ language }), db), language).toEqual({ ok: false, code: 'unsupported_language' });
    for (const language of ['EN', 'en-US', 'e', 'english', '', ' en', 'en ', 7, null, undefined, ['en']]) {
      expect(await arrivalGate(valid({ language }), db), String(language)).toEqual({ ok: false, code: 'invalid' });
    }
    for (const language of SUPPORTED_LANGUAGES) expect((await arrivalGate(valid({ language }), db)).ok).toBe(true);
  });

  it('refuses a category or a target outside the closed lists', async () => {
    for (const category of ['Slur', 'hate', '', 1, null, undefined]) expect(await arrivalGate(valid({ category }), db), String(category)).toEqual({ ok: false, code: 'invalid' });
    for (const target of ['race', 'NONE', '', 3, null]) expect(await arrivalGate(valid({ target }), db), String(target)).toEqual({ ok: false, code: 'invalid' });
    for (const category of ['slur', 'abuse', 'sexual', 'other']) expect((await arrivalGate(valid({ category }), db)).ok).toBe(true);
    for (const target of ['none', 'ethnicity', 'religion', 'gender', 'sexuality', 'disability', 'nationality', 'other']) expect((await arrivalGate(valid({ target }), db)).ok).toBe(true);
  });

  it('a slur with target none is accepted at arrival (a reviewer sets the target; design 10.3)', async () => {
    expect((await arrivalGate(valid({ category: 'slur', target: 'none' }), db)).ok).toBe(true);
  });
});

describe('the note rules (design 6.8): at most 200 characters, no control character, no @, no digit run over 4, no URL', () => {
  const bad = [
    'see https://example.test/x',
    'http://x',
    'ftp://host',
    'visit www.example',
    'example.com',
    'try snerp.gg now',
    'a.dev',
    'mail me@example',
    'ping @someone',
    'full width \uff20 sign',
    'call 12345',
    'ref 1234567890',
    'a\u0000b',
    'a\tb',
    'line\nbreak',
    'x'.repeat(201),
    'right to left \u202e override',
    'isolate \u2066 mark',
    'next line \u0085 here',
    'line separator \u2028 here',
  ];
  it.each(bad)('refuses %j as invalid', async (note) => {
    expect(await arrivalGate(valid({ note }), db)).toEqual({ ok: false, code: 'invalid' });
  });

  it('accepts ordinary notes: 200 characters exactly, a digit run of 4, punctuation, accents, an emoji', async () => {
    for (const note of ['x'.repeat(200), 'rank 1234 in the lobby', 'a, b; c: d! (e) "f"', 'caf\u00e9 \u00f1', 'rude \u{1f600}', "it's <b>not</b> html"]) {
      expect(await arrivalGate(valid({ note }), db), note).toMatchObject({ ok: true, note });
    }
  });

  it('refuses a note that is not a string or null', async () => {
    for (const note of [5, {}, [], true]) expect(await arrivalGate(valid({ note }), db)).toEqual({ ok: false, code: 'invalid' });
  });

  it('readNote returns the cleaned note, null for none, and undefined for a refusal', () => {
    expect(readNote(undefined)).toBeNull();
    expect(readNote(null)).toBeNull();
    expect(readNote('  hi  ')).toBe('hi');
    expect(readNote('http://x')).toBeUndefined();
  });
});

describe('a candidate that contains or collapses to an innocent word of another language lists that language in collidesWith and that word in negatives', () => {
  it('lists every other language where the spelling (after collapsing) is an ordinary word, and the word as a negative', async () => {
    await seed([
      ['es', 'glarn', 200],
      ['pt', 'glarn', null],
      ['en', 'snerp', 10],
    ]);
    const res = await crossLanguageGate({ term: 'glarn', languages: ['en'] }, db);
    expect(res.collidesWith).toEqual(['es', 'pt']);
    expect(res.negatives).toEqual(['glarn']);
  });

  it('collapses the candidate first: a spelling with a doubled letter meets the plain word', async () => {
    await seed([['es', 'glarn', 5]]);
    expect(await crossLanguageGate({ term: 'GLAARN', languages: ['en'] }, db)).toEqual({ collidesWith: ['es'], negatives: ['glarn'] });
    await seed([['pt', 'drakun', 5]]);
    expect((await crossLanguageGate({ term: 'drakkuun', languages: ['en'] }, db)).collidesWith).toEqual(['pt']);
  });

  it('never lists the language the term itself is for, but still lists that language\u2019s containing words as negatives', async () => {
    await seed([
      ['es', 'glarn', 1],
      ['pt', 'glarn', 1],
    ]);
    expect((await crossLanguageGate({ term: 'glarn', languages: ['es'] }, db)).collidesWith).toEqual(['pt']);
    expect((await crossLanguageGate({ term: 'glarn', languages: ['es', 'pt'] }, db)).collidesWith).toEqual([]);
  });

  it('lists dictionary words that contain the candidate as negatives (not as collisions), the equal word first', async () => {
    await seed([
      ['en', 'glarnish', 30],
      ['es', 'glarnes', null],
      ['pt', 'sglarn', 5],
      ['en', 'snerp', 1],
      ['es', 'glarn', 90],
    ]);
    const res = await crossLanguageGate({ term: 'glarn', languages: ['en'] }, db);
    expect(res.collidesWith).toEqual(['es']);
    expect(res.negatives).toEqual(['glarn', 'sglarn', 'glarnish', 'glarnes']);
  });

  it('is empty for a word nothing contains, and ignores a language outside the supported ones', async () => {
    await seed([
      ['en', 'snerp', 1],
      ['fr', 'zorbak', 1],
    ]);
    expect(await crossLanguageGate({ term: 'zorbak', languages: ['en'] }, db)).toEqual({ collidesWith: [], negatives: [] });
  });

  it('caps the negatives and keeps the equal word when it cuts', async () => {
    const rows: [string, string, number | null][] = [['es', 'glarn', null]];
    for (let i = 0; i < MAX_NEGATIVES + 50; i += 1) rows.push(['en', `glarn${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, i]);
    await db.batch(rows.map(([l, k, r]) => db.prepare('INSERT INTO innocent_words VALUES (?, ?, ?)').bind(l, k, r)));
    const res = await crossLanguageGate({ term: 'glarn', languages: ['en'] }, db);
    expect(res.negatives).toHaveLength(MAX_NEGATIVES);
    expect(res.negatives[0]).toBe('glarn');
    expect(res.collidesWith).toEqual(['es']);
  });

  it('answers empty for a candidate that is not a plain word, rather than throwing or matching everything', async () => {
    await seed([['en', 'snerp', 1]]);
    for (const term of ['', ' ', '%', '_', 'a', 'zo', "x' OR 1=1 --", 'z\u0000b', '\uff5a\uff4f\uff52', 'sn%rp', 7, null]) {
      expect(await crossLanguageGate({ term: term as string, languages: ['en'] }, db), String(term)).toEqual({ collidesWith: [], negatives: [] });
    }
  });
});

describe('the gate never throws on odd input (empty, 10 000 characters, emoji, RTL)', () => {
  const odd: unknown[] = [
    undefined,
    null,
    0,
    'zorbak',
    [],
    {},
    { term: '' },
    { term: 'a'.repeat(10_000), language: 'en', category: 'slur' },
    { term: '\u{1f600}'.repeat(5000), language: 'en', category: 'slur' },
    { term: '\u202e\u0632\u0648'.repeat(3000), language: 'en', category: 'slur' },
    valid({ note: '\u{1f600}'.repeat(10_000) }),
    valid({ note: 'x'.repeat(10_000) }),
    JSON.parse('{"__proto__": {"term": "zorbak"}, "term": "zorbak", "language": "en", "category": "slur"}'),
    Object.create(null),
    { get term(): string {
      throw new Error('boom');
    }, language: 'en', category: 'slur' },
    new Proxy({}, { get: () => { throw new Error('boom'); } }),
    { term: Symbol('x'), language: 'en', category: 'slur' },
    { term: 10n, language: 'en', category: 'slur' },
    { term: () => 'zorbak', language: 'en', category: 'slur' },
    { term: ['zorbak'], language: 'en', category: 'slur' },
  ];
  it.each(odd.map((v, i) => [i, v] as const))('input %i resolves to a closed result', async (_i, input) => {
    const res = await arrivalGate(input, db);
    expect(res.ok === true || ['invalid', 'unsupported_language', 'known_innocent'].includes(res.code)).toBe(true);
  });

  it('answers quickly for a 10 000-character word and never touches the dictionary for it', async () => {
    const started = process.hrtime.bigint();
    await arrivalGate({ term: 'a'.repeat(10_000), language: 'en', category: 'slur' }, db);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(200);
  });

  it('wordKey of a non-string is the empty key, and of a 10 000-character word is computed without throwing', () => {
    expect(wordKey(undefined as unknown as string)).toBe('');
    expect(wordKey(null as unknown as string)).toBe('');
    expect(wordKey('a'.repeat(10_000))).toBe('a');
  });
});

describe('no message holds the word', () => {
  it('a refusal is a closed code whatever the word, for every kind of refusal', async () => {
    await seed([['en', 'glarn', 1]]);
    const cases = [
      valid({ term: 'zorbak!' }),
      valid({ term: 'zorbak', language: 'fr' }),
      valid({ term: 'zorbak', category: 'x' }),
      valid({ term: 'zorbak', note: 'http://zorbak.example' }),
      valid({ term: 'glarn' }),
    ];
    for (const c of cases) {
      const res = await arrivalGate(c, db);
      expect(res.ok).toBe(false);
      expect(Object.keys(res).sort()).toEqual(['code', 'ok']);
      expect(JSON.stringify(res)).not.toMatch(/zorbak|glarn/);
    }
  });

  it('a database failure surfaces as an error whose message holds no word', async () => {
    const broken = createD1();
    const err = await arrivalGate(valid({ term: 'quissel' }), broken).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/quissel/);
  });
});

describe('loadInnocentWords (the owner imports a dictionary; the repo holds none)', () => {
  it('stores each word under its key with its rank, keeps the best rank for a repeated key, and skips what is not a word', async () => {
    const stored = await loadInnocentWords(db, 'en', [
      { word: 'Glarn', rank: 50 },
      { word: 'glaarn', rank: 20 },
      { word: 'snerp' },
      { word: 'not a word' },
      { word: 'it\u2019s' },
      { word: 'caf\u00e9', rank: 1 },
    ]);
    expect(stored).toBe(3);
    expect(await innocentRank(db, 'en', 'glarn')).toBe(20);
    expect(await innocentRank(db, 'en', 'snerp')).toBeNull();
    expect(await innocentRank(db, 'en', 'cafe')).toBe(1);
  });

  it('refuses a language that is not supported, and handles a list bigger than one batch', async () => {
    await expect(loadInnocentWords(db, 'fr', [{ word: 'glarn' }])).rejects.toThrow(/language/);
    const many = Array.from({ length: 450 }, (_v, i) => ({ word: `snerp${String.fromCharCode(97 + (i % 10))}${String.fromCharCode(107 + (Math.floor(i / 10) % 10))}${String.fromCharCode(117 + Math.floor(i / 100))}`, rank: i }));
    expect(await loadInnocentWords(db, 'es', many)).toBe(450);
    expect((await db.prepare("SELECT COUNT(*) AS c FROM innocent_words WHERE language = 'es'").first<{ c: number }>())?.c).toBe(450);
  });
});
