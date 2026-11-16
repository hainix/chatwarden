import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CorpusError, readZip } from '../src/corpus/index.js';
import { parseTermsRelease, sha256Hex, type TermsRelease } from '../src/corpus/release.js';
import { exampleExceptions, exampleNegative, exampleTerms, releaseFiles, releaseZip, sha256HexNode, termRow, type Json, type ReleaseParts } from './corpus-world.js';

const enc = new TextEncoder();
const WORDS = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];

interface Outcome {
  code: string;
  stage: string;
  err: CorpusError | null;
  release: TermsRelease | null;
}
function run(files: ReadonlyMap<string, Uint8Array>, expected?: Parameters<typeof parseTermsRelease>[1]): Outcome {
  try {
    return { code: 'ok', stage: '', err: null, release: parseTermsRelease(files, expected) };
  } catch (e) {
    expect(e).toBeInstanceOf(CorpusError);
    const err = e as CorpusError;
    return { code: err.code, stage: err.stage, err, release: null };
  }
}
const withTerms = (rows: unknown, over: ReleaseParts = {}): Outcome => run(releaseFiles({ terms: rows, ...over }));
const oneRow = (over: Json): Outcome => withTerms([termRow(over)]);
const tamperText = (from: string, to: string) => (bytes: Uint8Array): Uint8Array => enc.encode(new TextDecoder().decode(bytes).replace(from, to));

describe('sha256Hex', () => {
  it('matches node:crypto for every length around the block edges, for random data and for a megabyte', () => {
    for (let n = 0; n <= 200; n += 1) {
      const data = new Uint8Array(randomBytes(n));
      expect(sha256Hex(data), `length ${n}`).toBe(sha256HexNode(data));
    }
    for (const n of [255, 256, 257, 1000, 4096, 65_535, 1024 * 1024]) {
      const data = new Uint8Array(randomBytes(n));
      expect(sha256Hex(data), `length ${n}`).toBe(sha256HexNode(data));
    }
    expect(sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(enc.encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // a view over a bigger buffer is hashed as the view
    const big = new Uint8Array(randomBytes(100));
    expect(sha256Hex(big.subarray(10, 60))).toBe(sha256HexNode(big.slice(10, 60)));
    expect(() => sha256Hex('abc' as unknown as Uint8Array)).toThrow(TypeError);
  });
});

describe('parseTermsRelease', () => {
  it("parseTermsRelease: the example round-trips; every field's allowed and refused values (category, target, severity, status, id shape)", async () => {
    const r = run(releaseFiles()).release!;
    expect(r.version).toBe('2026.12.0');
    expect(r.sequence).toBe(14);
    expect(r.manifest.kind).toBe('terms');
    expect(r.manifest.gate).toEqual({ matcher: '0.1.11', positiveLines: 15, negativeLines: 40, crossLanguageLines: 90, passed: true });
    expect(r.manifest.license.spdx).toBe('CC-BY-4.0');
    expect(r.terms).toEqual(exampleTerms());
    expect(r.exceptions).toEqual(exampleExceptions());
    expect(Object.keys(r.negative).sort()).toEqual(['en', 'es', 'pt']);
    expect(r.negative.es).toEqual({ schema: 'chatwarden-corpus-negative/1', language: 'es', lines: ['a plain es sentence', 'another es sentence'], knownLosses: ['una frase que se pierde'] });
    expect(r.positive).toEqual(['a pack wide line that must block: you zorbak']);
    // the same release through a real zip: written, encrypted, read back, parsed
    const viaZip = parseTermsRelease(await readZip(releaseZip()));
    expect(viaZip.terms).toEqual(r.terms);
    expect(viaZip.manifest).toEqual(r.manifest);
    // the result is a copy: changing the input bytes afterwards changes nothing
    const files = releaseFiles();
    const parsed = parseTermsRelease(files);
    files.get('terms.json')!.fill(0);
    expect(parsed.terms).toHaveLength(8);
    // positive.json is optional
    expect(run(releaseFiles({ positive: null })).release!.positive).toEqual([]);
    // a release of no terms and no exceptions is a valid, empty one
    expect(withTerms([], { exceptions: [] }).code).toBe('ok');

    const allowed = {
      category: ['slur', 'abuse', 'sexual', 'other'],
      target: ['none', 'ethnicity', 'religion', 'gender', 'sexuality', 'disability', 'nationality', 'other'],
      severity: ['rude', 'hostile', 'severe'],
      status: ['provisional', 'accepted', 'disputed', 'withdrawn'],
    } as const;
    for (const [field, values] of Object.entries(allowed)) {
      for (const v of values) expect(oneRow({ [field]: v }).code, `${field}=${v}`).toBe('ok');
      for (const bad of ['', 'Slur', 'SEVERE', 'banter', 'zorbak', ' accepted', 'accepted ', 'extreme', 'none ', 7, null, ['slur'], {}, true]) {
        const o = oneRow({ [field]: bad });
        expect(o.code, `${field}=${JSON.stringify(bad)}`).toBe('bad_pack');
        expect(o.stage).toBe('validate');
      }
    }
    for (const id of ['CWT-2026-00042', 'CWT-1999-00001', 'CWT-2026-99999']) expect(oneRow({ id }).code, id).toBe('ok');
    for (const id of ['CWT-2026-0042', 'CWT-26-00042', 'cwt-2026-00042', 'CWT-2026-000420', 'zorbak', '', 'CWT-2026-00042\n', 'CWX-2026-00042', ' CWT-2026-00042', 'CWT_2026_00042', 'CWT-2026-0004a', 42, null]) {
      expect(oneRow({ id }).code, JSON.stringify(id)).toBe('bad_pack');
    }
  });

  it('the other row fields: languages, collidesWith, since, approvals, defaultActive, positive and negative lines', () => {
    const ok = (over: Json): void => expect(oneRow(over).code, JSON.stringify(over)).toBe('ok');
    const refused = (over: Json): void => expect(oneRow(over).code, JSON.stringify(over)).toBe('bad_pack');
    ok({ languages: ['en', 'es', 'pt'] });
    ok({ collidesWith: ['es', 'pt'] });
    ok({ approvals: 0 });
    ok({ approvals: 99 });
    ok({ positive: [], negative: [] });
    ok({ positive: ['x'.repeat(200)] });
    ok({ positive: Array.from({ length: 50 }, (_, i) => `line ${i}`) });
    for (const languages of [[], ['english'], ['EN'], ['pt-BR'], ['e'], ['en', 'en'], 'en', null, [1], ['en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'sv', 'da']]) refused({ languages });
    for (const collidesWith of [['EN'], ['en', 'en'], 'en', null, [3], ['pt-BR'], undefined]) refused({ collidesWith });
    for (const since of ['2026.13.0', 'v1', '', 5, null, '2026.12', undefined]) refused({ since });
    for (const approvals of [-1, 1.5, '2', 100, null, NaN, undefined]) refused({ approvals });
    for (const defaultActive of ['true', 1, null, undefined]) refused({ defaultActive });
    for (const lines of ['abc', null, [1], [null], [''], ['x'.repeat(201)], Array.from({ length: 51 }, (_, i) => `l${i}`), {}]) {
      refused({ positive: lines });
      refused({ negative: lines });
    }
    // a key the format does not have, and a key missing
    refused({ extra: 1 });
    refused({ note: 'a reviewer note must never ride along' });
    for (const key of Object.keys(termRow())) {
      const row = termRow();
      delete row[key];
      expect(withTerms([row]).code, `missing ${key}`).toBe('bad_pack');
    }
    // rows that are not objects, and a terms file that is not a list
    for (const bad of [null, 5, 'zorbak', [], [[]]]) expect(withTerms([bad]).code).toBe('bad_pack');
    for (const bad of [{}, null, 'x', 5, { rows: [] }]) expect(withTerms(bad).code).toBe('bad_pack');
  });

  it('the term itself: one word of plain letters after foldTerm, three letters once repeats collapse, 40 as written; the same word twice is refused', () => {
    // accents fold away; case folds; the word as written may be up to 40 characters
    const forty = 'xaxbxcxdxexfxgxhxixjxkxlxmxnxoxpxqxrxsxtx'.slice(0, 40);
    expect(forty).toHaveLength(40);
    for (const term of ['zorbak', 'ZORBAK', 'Zorbak', 'z\u00f3rb\u00e1k', 'zorb\u00e4k', 'z\u00e5rbak', 'abc', 'zzorbak', forty]) {
      expect(oneRow({ term }).code, term).toBe('ok');
    }
    const refused = [
      '',
      '   ',
      'zorbak vlemmo',
      'zor-bak',
      'zorbak1',
      '1zorbak',
      'zo',
      'zzz',
      'aaaa',
      'a'.repeat(41),
      'xa'.repeat(21),
      'zorbak!',
      "zor'bak",
      // fullwidth forms and a Cyrillic look-alike are not plain letters once folded: they are refused, not quietly converted
      '\uff5a\uff4f\uff52\uff42\uff41\uff4b',
      'z\u043erbak',
      'z\u0430rbak',
      '\u65e5\u672c\u8a9e',
      'zor\u200bbak',
      5,
      null,
    ];
    for (const term of refused) {
      const o = oneRow({ term });
      expect(o.code, JSON.stringify(term)).toBe('bad_pack');
      expect(o.stage).toBe('validate');
    }
    // two rows that fold to one word: by case, by accent, by collapsed repeat, by the preset's doubling rules
    const pairs: Array<[string, string]> = [
      ['zorbak', 'ZORBAK'],
      ['zorbak', 'z\u00f3rb\u00e1k'],
      ['zorbak', 'zzorbak'],
      ['vlemmo', 'vlemo'],
      ['glarn', 'glaarn'],
      ['zorbak', 'zorbak'],
    ];
    for (const [a, b] of pairs) {
      const o = withTerms([termRow({ term: a }), termRow({ id: 'CWT-2026-00002', term: b })]);
      expect(o.code, `${a}/${b}`).toBe('bad_pack');
    }
    // two rows with one id
    expect(withTerms([termRow(), termRow({ term: 'vlemmo' })]).code).toBe('bad_pack');
    // a withdrawn row still holds its word (the id and the word are never reused)
    expect(withTerms([termRow({ status: 'withdrawn' }), termRow({ id: 'CWT-2026-00002', term: 'ZORBAK' })]).code).toBe('bad_pack');
    // different words are fine
    expect(withTerms([termRow(), termRow({ id: 'CWT-2026-00002', term: 'vlemmo' })]).code).toBe('ok');
  });

  it('exceptions and negative and positive files: their own fields are checked the same way', () => {
    const ex = (over: Json): Outcome => withTerms(exampleTerms(), { exceptions: [{ id: 'CWX-2026-00007', phrase: 'snerp glarn', languages: ['en'], status: 'accepted', ...over }] });
    expect(ex({}).code).toBe('ok');
    for (const over of [
      { id: 'CWT-2026-00007' },
      { id: 'zorbak' },
      { phrase: '' },
      { phrase: ' ' },
      { phrase: 'x'.repeat(101) },
      { phrase: 'a\nb' },
      { phrase: 5 },
      { languages: [] },
      { languages: ['EN'] },
      { status: 'nonsense' },
      { extra: true },
    ]) {
      expect(ex(over).code, JSON.stringify(over)).toBe('bad_pack');
    }
    expect(withTerms(exampleTerms(), { exceptions: [{ id: 'CWX-2026-00007', phrase: 'a', languages: ['en'], status: 'accepted' }, { id: 'CWX-2026-00007', phrase: 'b', languages: ['en'], status: 'accepted' }] }).code).toBe('bad_pack');
    for (const status of ['provisional', 'accepted', 'disputed', 'withdrawn']) expect(ex({ status }).code).toBe('ok');

    const neg = (file: unknown): Outcome => run(releaseFiles({ negative: { en: file } }));
    expect(neg(exampleNegative('en')).code).toBe('ok');
    expect(neg(exampleNegative('en', { lines: Array.from({ length: 2000 }, (_, i) => `a plain line ${i}`) })).code).toBe('ok');
    for (const bad of [
      exampleNegative('en', { lines: Array.from({ length: 2001 }, (_, i) => `a plain line ${i}`) }),
      exampleNegative('en', { knownLosses: Array.from({ length: 2001 }, (_, i) => `a loss ${i}`) }),
      exampleNegative('es'),
      exampleNegative('en', { schema: 'chatwarden-corpus-negative/2' }),
      exampleNegative('en', { lines: [5] }),
      exampleNegative('en', { lines: 'x' }),
      exampleNegative('en', { knownLosses: [null] }),
      exampleNegative('en', { lines: [''] }),
      exampleNegative('en', { lines: ['x'.repeat(501)] }),
      exampleNegative('en', { extra: [] }),
      { schema: 'chatwarden-corpus-negative/1', language: 'en', lines: [] },
      [],
      null,
    ]) {
      expect(neg(bad).code, JSON.stringify(bad).slice(0, 80)).toBe('bad_pack');
    }
    for (const positive of [{ schema: 'chatwarden-corpus-positive/1', lines: [5] }, { schema: 'chatwarden-corpus-positive/2', lines: [] }, { lines: [] }, [], 'x', { schema: 'chatwarden-corpus-positive/1', lines: [], extra: 1 }]) {
      expect(run(releaseFiles({ positive })).code, JSON.stringify(positive)).toBe('bad_pack');
    }
    // not JSON, a BOM, a different encoding, invalid UTF-8
    expect(run(releaseFiles({ raw: { 'terms.json': 'not json' }, terms: [] })).code).toBe('bad_pack');
    expect(withTerms([], { tamper: { 'terms.json': () => enc.encode('\ufeff[]') } }).code).toBe('bad_manifest');
    expect(run(releaseFiles({ raw: { 'terms.json': '[' } })).code).toBe('bad_pack');
  });

  it('a manifest whose file hash differs, whose version differs from the index entry, whose kind is eval, or whose gate.passed is false: refused', () => {
    const good = (): Map<string, Uint8Array> => releaseFiles();
    expect(run(good(), { version: '2026.12.0', sequence: 14 }).code).toBe('ok');
    expect(run(good(), { version: '2026.12.0', sequence: 20 }).code).toBe('ok');
    // the file hash: one changed letter, one added byte, a hash in upper case, a wrong length, a file the manifest does not list
    const flipped = run(releaseFiles({ tamper: { 'terms.json': tamperText('zorbak', 'zorbaq') } }));
    expect(flipped.code).toBe('bad_manifest');
    expect(flipped.stage).toBe('unpack');
    for (const name of ['terms.json', 'exceptions.json', 'negative.en.json', 'negative.es.json', 'negative.pt.json', 'positive.json']) {
      const bytes = releaseFiles().get(name)!;
      expect(run(releaseFiles({ tamper: { [name]: (b) => Uint8Array.from([...b, 32]) } })).code, `appended to ${name}`).toBe('bad_manifest');
      expect(run(releaseFiles({ tamper: { [name]: (b) => b.slice(0, b.length - 1) } })).code, `cut ${name}`).toBe('bad_manifest');
      expect(run(releaseFiles({ tamper: { [name]: () => new Uint8Array(bytes.length) } })).code, `zeroed ${name}`).toBe('bad_manifest');
    }
    const upper = (name: string) => (b: Uint8Array): Uint8Array => enc.encode(new TextDecoder().decode(b).replace(new RegExp(`("${name.replace('.', '\\.')}":\\{"bytes":\\d+,"sha256":")([0-9a-f]+)`), (_m, a: string, h: string) => a + h.toUpperCase()));
    expect(run(releaseFiles({ tamper: { 'manifest.json': upper('terms.json') } })).code).toBe('bad_manifest');
    expect(run(releaseFiles({ unlisted: { 'negative.fr.json': JSON.stringify(exampleNegative('fr')) } })).code).toBe('bad_manifest');
    expect(run(releaseFiles({ unlisted: { 'terms2.json': '[]' } })).code).toBe('bad_manifest');
    expect(run(releaseFiles({ unlisted: { 'positive.json': '{}' }, positive: null })).code).toBe('bad_manifest');
    // a listed file that is not in the archive, and a required one that is missing everywhere
    const files = releaseFiles();
    files.delete('exceptions.json');
    expect(run(files).code).toBe('bad_manifest');
    expect(run(releaseFiles({ omit: ['exceptions.json'] })).code).toBe('bad_manifest');
    expect(run(releaseFiles({ omit: ['terms.json'] })).code).toBe('bad_manifest');
    const noManifest = releaseFiles();
    noManifest.delete('manifest.json');
    expect(run(noManifest).code).toBe('bad_manifest');
    // entries the format has no place for, even when listed and hashed: refused
    for (const name of ['evil.json', 'negative.json', 'negative.EN.json', 'negative.english.json', 'negative.en.json.bak', 'terms.JSON', 'eval.json', 'cases.en.json']) {
      const extra = enc.encode('[]');
      const m = releaseFiles({ unlisted: { [name]: extra } });
      const listed = JSON.parse(new TextDecoder().decode(m.get('manifest.json')!)) as Json;
      (listed.files as Json)[name] = { bytes: extra.length, sha256: sha256HexNode(extra) };
      m.set('manifest.json', enc.encode(JSON.stringify(listed)));
      expect(run(m).code, name).toBe('bad_manifest');
    }
    // the licence and readme are carried but are not parsed and need not be listed
    expect(run(releaseFiles({ unlisted: { 'LICENSE.txt': 'changed', 'README.txt': 'changed' } })).code).toBe('ok');

    // the version and the sequence against the index entry that led here
    expect(run(good(), { version: '2026.12.1' }).code).toBe('bad_manifest');
    expect(run(good(), { version: '2026.11.0', sequence: 14 }).code).toBe('bad_manifest');
    expect(run(good(), { sequence: 13 }).code).toBe('bad_manifest');
    expect(run(good(), { version: '2026.12.0', sequence: 14 }).code).toBe('ok');
    // the kind and the gate
    expect(run(releaseFiles({ manifest: { kind: 'eval' } })).code).toBe('bad_manifest');
    expect(run(releaseFiles({ manifest: { kind: 'zip' } })).code).toBe('bad_manifest');
    expect(run(releaseFiles({ manifest: { kind: undefined } })).code).toBe('bad_manifest');
    const gate = { matcher: '0.1.11', positiveLines: 1, negativeLines: 1, crossLanguageLines: 1 };
    expect(run(releaseFiles({ manifest: { gate: { ...gate, passed: false } } })).code).toBe('bad_manifest');
    for (const passed of ['true', 1, null, undefined]) expect(run(releaseFiles({ manifest: { gate: { ...gate, passed } } })).code, String(passed)).toBe('bad_manifest');
    expect(run(releaseFiles({ manifest: { gate: undefined } })).code).toBe('bad_manifest');
    expect(run(releaseFiles({ manifest: { gate: { ...gate, passed: true, extra: 1 } } })).code).toBe('bad_manifest');
    // the rest of the manifest
    const m = (over: Json): string => run(releaseFiles({ manifest: over })).code;
    for (const over of [
      { schema: 'chatwarden-corpus-manifest/2' },
      { schema: undefined },
      { version: '2026.12' },
      { version: 'latest' },
      { sequence: -1 },
      { sequence: 1.5 },
      { sequence: '14' },
      { builtAt: '2026-12-01' },
      { builtAt: 5 },
      { previous: 5 },
      { previous: 'x' },
      { previous: undefined },
      { license: undefined },
      { license: { spdx: 'CC-BY-4.0' } },
      { license: { spdx: '', attribution: 'x' } },
      { license: { spdx: 'CC-BY-4.0', attribution: 'x', extra: 1 } },
      { languages: 'en' },
      { languages: ['EN'] },
      { counts: undefined },
      { counts: { terms: {}, exceptions: {} } },
      { counts: { terms: { en: -1 }, exceptions: {}, status: { accepted: 0, provisional: 0, disputed: 0, withdrawn: 0 } } },
      { counts: { terms: {}, exceptions: {}, status: { accepted: 0, provisional: 0, disputed: 0 } } },
      { files: undefined },
      { files: [] },
      { files: { 'terms.json': { bytes: 1 } } },
      { extra: 1 },
      { note: 'x' },
    ]) {
      expect(m(over), JSON.stringify(over)).toBe('bad_manifest');
    }
    // a manifest that is not JSON, not an object, or not text
    expect(run(releaseFiles({ tamper: { 'manifest.json': () => enc.encode('{') } })).code).toBe('bad_manifest');
    expect(run(releaseFiles({ tamper: { 'manifest.json': () => enc.encode('[]') } })).code).toBe('bad_manifest');
    expect(run(releaseFiles({ tamper: { 'manifest.json': () => Uint8Array.from([0xff, 0xfe]) } })).code).toBe('bad_manifest');
    // not a map of bytes at all
    for (const bad of [null, undefined, {}, [], 'x', new Map([['manifest.json', 'text']])] as unknown[]) {
      expect(run(bad as Map<string, Uint8Array>).code).toBe('bad_manifest');
    }
  });

  it('no function in release.ts or select.ts puts a term or line in an error message (Review Focus 4)', () => {
    // dynamically: every refusal above, with invented words wherever the format takes text
    const nasty = (w: string): Json => ({ term: w, positive: [w], negative: [w] });
    const cases: Outcome[] = [
      ...WORDS.map((w) => oneRow({ category: w })),
      ...WORDS.map((w) => oneRow({ id: w })),
      ...WORDS.map((w) => oneRow({ term: `${w}1` })),
      ...WORDS.map((w) => oneRow({ ...nasty(w), languages: [w] })),
      ...WORDS.map((w) => oneRow({ positive: [w.repeat(60)], extra: w })),
      withTerms([termRow(), termRow({ id: 'CWT-2026-00002', term: 'ZORBAK' })]),
      withTerms([termRow(), termRow()]),
      run(releaseFiles({ tamper: { 'terms.json': tamperText('zorbak', 'zorbaq') } })),
      run(releaseFiles({ manifest: { kind: 'vlemmo' } })),
      run(releaseFiles({ manifest: { version: 'quissel' } })),
      run(releaseFiles({ unlisted: { 'drakkuun.json': 'fenrisk' } })),
      run(releaseFiles({ raw: { 'terms.json': 'tarvo snerp glarn' } })),
      run(releaseFiles({ exceptions: [{ id: 'CWX-2026-00007', phrase: 'snerp glarn'.repeat(20), languages: ['en'], status: 'accepted' }] })),
      run(releaseFiles({ negative: { en: exampleNegative('en', { lines: ['zorbak'.repeat(100)] }) } })),
    ];
    expect(cases.every((c) => c.err !== null)).toBe(true);
    for (const c of cases) {
      const err = c.err!;
      for (const t of [err.message, String(err), JSON.stringify(err), JSON.stringify(Object.getOwnPropertyNames(err)), err.code, err.stage]) {
        for (const w of WORDS) expect(t.toLowerCase(), t).not.toContain(w);
      }
    }
    // statically: no template literal or concatenation inside an Error constructor in the two files
    for (const file of ['release.ts', 'select.ts', 'sha256.ts']) {
      const source = readFileSync(new URL(`../src/corpus/${file}`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/new (?:\w*Error)\(([^)]*)\)/g)) {
        expect(match[1], `${file}: ${match[0]}`).not.toMatch(/\$\{|'\s*\+|\+\s*'/);
      }
    }
  });
});

describe('the manifest agrees with the rows it describes', () => {
  const counts = (over: Json = {}): Json => ({
    terms: { en: 5, es: 2, pt: 2 },
    exceptions: { en: 2, es: 0, pt: 1 },
    status: { accepted: 4, provisional: 2, disputed: 1, withdrawn: 1 },
    ...over,
  });
  const m = (manifest: Json): Outcome => run(releaseFiles({ manifest }));

  it('the example release is consistent (the counts the helper computes are the counts the design describes)', () => {
    const out = run(releaseFiles());
    expect(out.code).toBe('ok');
    expect(out.release?.manifest.counts).toEqual(counts() as unknown);
  });

  it('a count that is off by one, in any table, refuses the release as bad_manifest at unpack', () => {
    const cases: Json[] = [
      { counts: counts({ terms: { en: 6, es: 2, pt: 2 } }) },
      { counts: counts({ terms: { en: 4, es: 2, pt: 2 } }) },
      { counts: counts({ terms: { en: 5, es: 2, pt: 1 } }) },
      { counts: counts({ exceptions: { en: 3, es: 0, pt: 1 } }) },
      { counts: counts({ exceptions: { en: 2, es: 1, pt: 1 } }) },
      { counts: counts({ status: { accepted: 5, provisional: 2, disputed: 1, withdrawn: 1 } }) },
      { counts: counts({ status: { accepted: 4, provisional: 2, disputed: 0, withdrawn: 2 } }) },
      { counts: counts({ status: { accepted: 4, provisional: 2, disputed: 1, withdrawn: 0 } }) },
    ];
    for (const over of cases) {
      const out = m(over);
      expect(out.code, JSON.stringify(over)).toBe('bad_manifest');
      expect(out.stage).toBe('unpack');
    }
  });

  it('a count table that leaves a listed language out, or names one the manifest does not list, is refused', () => {
    expect(m({ counts: counts({ terms: { en: 5, es: 2 } }) }).code).toBe('bad_manifest');
    expect(m({ counts: counts({ exceptions: { en: 2, pt: 1 } }) }).code).toBe('bad_manifest');
    expect(m({ counts: counts({ terms: { en: 5, es: 2, pt: 2, fr: 0 } }) }).code).toBe('bad_manifest');
  });

  it('a row in a language the manifest does not list is refused (whatever the counts say)', () => {
    const rows = [...exampleTerms(), termRow({ id: 'CWT-2026-00099', term: 'tarvox', languages: ['fr'] })];
    expect(withTerms(rows).code).toBe('bad_manifest');
    const exRows = [...exampleExceptions(), { id: 'CWX-2026-00099', phrase: 'glarn lake', languages: ['fr'], status: 'accepted' }];
    expect(run(releaseFiles({ exceptions: exRows })).code).toBe('bad_manifest');
  });

  it('a manifest that lists languages the rows do not use is fine (an empty language is a real state: pt: 0)', () => {
    const rows = exampleTerms().filter((r) => !(r.languages as string[]).includes('pt'));
    const out = withTerms(rows);
    expect(out.code).toBe('ok');
    expect(out.release?.manifest.counts.terms.pt).toBe(0);
  });

  it('a row in two languages counts once in each', () => {
    const rows = [termRow({ id: 'CWT-2026-00001', term: 'zorbak', languages: ['en', 'es'] })];
    const out = withTerms(rows);
    expect(out.code).toBe('ok');
    expect(out.release?.manifest.counts.terms).toEqual({ en: 1, es: 1, pt: 0 });
  });
});
