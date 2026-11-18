import { describe, expect, it } from 'vitest';
import { buildMatcher, loadTermPack } from '../src/index.js';
import { CorpusError } from '../src/corpus/index.js';
import { parseTermsRelease } from '../src/corpus/release.js';
import { releaseToPack, selectedLanguages } from '../src/corpus/select.js';
import { exampleTerms, releaseFiles, termRow, type Json } from './corpus-world.js';

// L2: the shared term list carries terms in scripts written without spaces: a release row may have a `matchMode` and the languages zh, ja, th, lo, km and my; the manifest schema string stays /1. The terms
// here are invented transliterations and a fragment of a place name, never a real term.

const HAN = '\u4f50\u5c14\u5df4\u514b';
const FRAGMENT = '\u5c14\u5df4\u5c3c';
const PLACE_LINE = '\u6211\u53bb\u8fc7\u963f\u5c14\u5df4\u5c3c\u4e9a\u65c5\u6e38';
const KATA = '\u30be\u30eb\u30d0\u30af';
const HIRA = '\u305e\u308b\u3070\u304f';
const THAI = '\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01';
const LAO = '\u0e9a\u0eb2\u0e81\u0eb2';
const KHMER = '\u1780\u17d2\u1780\u17d2\u1780';
const MYANMAR = '\u1019\u1004\u103a\u1039\u1002\u101c\u102c';

const LANGS = ['en', 'es', 'pt', 'zh', 'ja', 'th', 'lo', 'km', 'my'];

/** A release whose manifest lists the extra languages and counts exactly the rows given. */
function releaseOf(rows: Json[], extra: { exceptions?: Json[] } = {}) {
  const exceptions = extra.exceptions ?? [];
  const count = (lang: string, list: Json[]): number => list.filter((r) => (r.languages as string[]).includes(lang)).length;
  const statuses = ['accepted', 'provisional', 'disputed', 'withdrawn'];
  return releaseFiles({
    terms: rows,
    exceptions,
    negative: {},
    manifest: {
      languages: LANGS,
      counts: {
        terms: Object.fromEntries(LANGS.map((l) => [l, count(l, rows)])),
        exceptions: Object.fromEntries(LANGS.map((l) => [l, count(l, exceptions)])),
        status: Object.fromEntries(statuses.map((s) => [s, rows.filter((r) => r.status === s).length])),
      },
    },
  });
}
const row = (n: number, over: Json): Json => termRow({ id: `CWT-2026-${String(n).padStart(5, '0')}`, positive: [], negative: [], ...over });
const parse = (rows: Json[]) => parseTermsRelease(releaseOf(rows));
function code(rows: Json[]): string {
  try {
    parse(rows);
    return 'ok';
  } catch (e) {
    expect(e).toBeInstanceOf(CorpusError);
    return (e as CorpusError).code;
  }
}

describe('a row in a script written without spaces', () => {
  it('a release row with a zh, ja or th language parses and keeps its matchMode', () => {
    const r = parse([
      row(1, { term: HAN, languages: ['zh'], matchMode: 'segment' }),
      row(2, { term: FRAGMENT, languages: ['zh', 'ja'], matchMode: 'contains' }),
      row(3, { term: KATA, languages: ['ja'] }),
      row(4, { term: THAI, languages: ['th'] }),
    ]);
    expect(r.terms.map((t) => t.languages)).toEqual([['zh'], ['zh', 'ja'], ['ja'], ['th']]);
    expect(r.terms[0]).toMatchObject({ term: HAN, matchMode: 'segment' });
    expect(r.terms[1]).toMatchObject({ matchMode: 'contains' });
    expect(Object.hasOwn(r.terms[2] as object, 'matchMode')).toBe(false);
  });

  it('Lao, Khmer and Myanmar rows parse with their own language', () => {
    expect(code([row(1, { term: LAO, languages: ['lo'] }), row(2, { term: KHMER, languages: ['km'] }), row(3, { term: MYANMAR, languages: ['my'] })])).toBe('ok');
  });

  it('a row with no matchMode still parses, and so does a Latin row with word', () => {
    expect(code(exampleTerms())).toBe('ok');
    expect(parseTermsRelease(releaseFiles()).terms).toHaveLength(8);
    expect(code([row(1, { term: 'zorbak', matchMode: 'word' })])).toBe('ok');
  });

  it('an unknown mode, a mode of the wrong type and null are bad_pack, on either kind of term', () => {
    for (const bad of ['fuzzy', '', 'Segment', 5, null, {}, ['segment'], true]) {
      expect(code([row(1, { term: HAN, languages: ['zh'], matchMode: bad })]), `han ${JSON.stringify(bad)}`).toBe('bad_pack');
      expect(code([row(1, { term: 'zorbak', matchMode: bad })]), `latin ${JSON.stringify(bad)}`).toBe('bad_pack');
    }
  });

  it('a mode that does not fit the script is bad_pack: word on Han, segment or contains on a Latin term', () => {
    expect(code([row(1, { term: HAN, languages: ['zh'], matchMode: 'word' })])).toBe('bad_pack');
    expect(code([row(1, { term: 'zorbak', matchMode: 'segment' })])).toBe('bad_pack');
    expect(code([row(1, { term: 'zorbak', matchMode: 'contains' })])).toBe('bad_pack');
  });

  it('the languages must be unspaced languages that fit the script: en with Han, th with Han, zh with Thai, an empty list', () => {
    for (const languages of [['en'], ['zh', 'en'], ['th'], ['ja', 'th']]) expect(code([row(1, { term: HAN, languages })]), JSON.stringify(languages)).toBe('bad_pack');
    expect(code([row(1, { term: THAI, languages: ['zh'] })])).toBe('bad_pack');
    expect(code([row(1, { term: KATA, languages: ['zh'] })])).toBe('bad_pack');
  });

  it('the length rules are the matcher\'s: 1 code point refused, 2 accepted, contains needs 3, 24 accepted and 25 refused', () => {
    expect(code([row(1, { term: '\u4f50', languages: ['zh'] })])).toBe('bad_pack');
    expect(code([row(1, { term: HAN.slice(0, 2), languages: ['zh'] })])).toBe('ok');
    expect(code([row(1, { term: HAN.slice(0, 2), languages: ['zh'], matchMode: 'contains' })])).toBe('bad_pack');
    expect(code([row(1, { term: HAN.slice(0, 3), languages: ['zh'], matchMode: 'contains' })])).toBe('ok');
    expect(code([row(1, { term: '\u4f50'.repeat(24), languages: ['zh'] })])).toBe('ok');
    expect(code([row(1, { term: '\u4f50'.repeat(25), languages: ['zh'] })])).toBe('bad_pack');
  });

  it('a space, punctuation, a digit or a Latin letter in the term, and a script that is not supported, are bad_pack', () => {
    for (const term of ['\u4f50 \u5c14', '\u4f50\u3001\u5c14', '\u4f50\u5c142', '\u4f50a', '\u0437\u043e\u0440\u0431\u0430\u043a', '\uc870\ub974\ubc15', '\u4f50\u0e0b']) {
      expect(code([row(1, { term, languages: ['zh'] })]), term).toBe('bad_pack');
    }
  });

  it('the old Latin rule for a Latin term is unchanged', () => {
    for (const term of ['zorbak1', 'zor bak', 'zo', 'zzz', '\uff5a\uff4f\uff52\uff42\uff41\uff4b', 'z\u043erbak', 'zorbak!']) expect(code([row(1, { term })]), term).toBe('bad_pack');
    for (const term of ['zorbak', 'ZORBAK', 'z\u00f3rb\u00e1k']) expect(code([row(1, { term })]), term).toBe('ok');
  });

  it('a word is one row for the whole release: the hiragana and the katakana of one word are the same word', () => {
    expect(code([row(1, { term: KATA, languages: ['ja'] }), row(2, { term: HIRA, languages: ['ja'] })])).toBe('bad_pack');
    expect(code([row(1, { term: '\u0e01\u0e31\u0e1a', languages: ['th'] }), row(2, { term: '\u0e01\u0e1a', languages: ['th'] })])).toBe('ok');
  });

  it('the manifest schema string is still /1', () => {
    expect(parse([row(1, { term: HAN, languages: ['zh'] })]).manifest.schema).toBe('chatwarden-corpus-manifest/1');
  });
});

describe('selecting them', () => {
  it('the languages zh, ja, th, lo, km and my are accepted by a selection, in the order asked for', () => {
    expect(selectedLanguages({ languages: ['zh', 'ja', 'th', 'lo', 'km', 'my'] })).toEqual(['zh', 'ja', 'th', 'lo', 'km', 'my']);
    expect(selectedLanguages({ languages: ['zh-CN', 'ja_JP'] })).toEqual(['zh', 'ja']);
  });

  const rows = [
    row(1, { term: HAN, languages: ['zh'], matchMode: 'segment' }),
    row(2, { term: FRAGMENT, languages: ['zh'], matchMode: 'contains' }),
    row(3, { term: KATA, languages: ['ja'] }),
    row(4, { term: THAI, languages: ['th'] }),
    row(5, { term: 'zorbak', languages: ['en'] }),
  ];
  const release = parseTermsRelease(releaseOf(rows));

  it('a zh selection gives the Han rows with their language and mode, and nothing of the others', () => {
    const pack = releaseToPack(release, { languages: ['zh'] });
    expect(pack.terms.map((t) => [t.term, t.language, t.matchMode ?? null])).toEqual([[HAN, 'zh', 'segment'], [FRAGMENT, 'zh', 'contains']]);
  });

  it('the pack loads, builds, and the modes hold: contains hits inside the place name, segment does not', () => {
    const pack = loadTermPack(JSON.parse(JSON.stringify(releaseToPack(release, { languages: ['zh', 'ja', 'th', 'en'] }))));
    const m = buildMatcher(pack.terms, pack.exceptions);
    expect(m.match(PLACE_LINE)?.termId).toBe('CWT-2026-00002');
    expect(m.match(`\u4f60\u597d${HAN}\u518d\u89c1`)?.termId).toBe('CWT-2026-00001');
    expect(m.match(`\u3053\u308c\u306f${KATA}\u3067\u3059`)?.termId).toBe('CWT-2026-00003');
    expect(m.match(`\u0e09\u0e31\u0e19\u0e40\u0e2b\u0e47\u0e19${THAI}`)?.termId).toBe('CWT-2026-00004');
    expect(m.match('you zorbak')?.termId).toBe('CWT-2026-00005');
  });

  it('a row of a language that is not selected rides along nowhere, and a row without a mode has none in the pack', () => {
    const pack = releaseToPack(release, { languages: ['ja'] });
    expect(pack.terms.map((t) => t.id)).toEqual(['CWT-2026-00003']);
    expect(Object.hasOwn(pack.terms[0] as object, 'matchMode')).toBe(false);
  });
});
