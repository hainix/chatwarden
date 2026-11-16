import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CorpusError } from '../src/corpus/errors.js';
import { parseEvalSet, type EvalSet } from '../src/corpus/evalset.js';
import { sha256HexNode, type Json } from './corpus-world.js';
import { evalFiles, exampleCase, exampleCases, type EvalParts } from './corpus-eval-world.js';

const enc = new TextEncoder();
const WORDS = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];

interface Outcome {
  code: string;
  stage: string;
  err: CorpusError | null;
  set: EvalSet | null;
}
function run(files: ReadonlyMap<string, Uint8Array>, expected?: Parameters<typeof parseEvalSet>[1]): Outcome {
  try {
    return { code: 'ok', stage: '', err: null, set: parseEvalSet(files, expected) };
  } catch (e) {
    expect(e).toBeInstanceOf(CorpusError);
    const err = e as CorpusError;
    return { code: err.code, stage: err.stage, err, set: null };
  }
}
const withCases = (cases: unknown, over: EvalParts = {}): Outcome => run(evalFiles({ cases: { en: cases }, ...over }));
const oneCase = (over: Json): Outcome => withCases([exampleCase(over)]);
const tamperText = (from: string, to: string) => (bytes: Uint8Array): Uint8Array => enc.encode(new TextDecoder().decode(bytes).replace(from, to));

describe('parseEvalSet: the design example and every expect shape', () => {
  it('parses the design example; every expect shape (single level, a band), optional keys absent', () => {
    const out = run(evalFiles());
    expect(out.code).toBe('ok');
    const set = out.set as EvalSet;
    expect(set.version).toBe('2026.12.0');
    expect(set.sequence).toBe(14);
    expect(set.manifest.kind).toBe('eval');
    expect(set.manifest.counts.cases).toEqual({ en: 4, es: 1 });
    expect(set.manifest.counts.groups).toEqual({ rude: 2, hostile: 1, injection: 1, banter: 1 });
    expect(set.cases).toHaveLength(5);
    expect(Object.keys(set.byLanguage)).toEqual(['en', 'es']);

    const [design, band, injection, bare] = set.byLanguage.en as EvalSet['cases'];
    // The design's example, key for key.
    expect(design).toEqual(exampleCase());
    // A band, a rule that is `uncovered`, a blocked line, both citation lists.
    expect(band?.expect).toEqual({ severity: ['hostile', 'severe'], rule: 'uncovered', verdict: 'upheld', mustCite: [1], mustNotCite: [2] });
    expect(band?.lines[0]).toEqual({ who: 'reported', text: 'you zorbak', blocked: true });
    // Unknown meta keys are dropped, known ones are kept.
    expect(band?.meta).toEqual({ language: 'en', source: 'contributed', reviewed: 2, since: '2026.12.0' });
    // A single level, a null reason, an injection flag, no pointedAt and no meta.
    expect(injection?.reason).toBeNull();
    expect(injection?.expect).toEqual({ severity: 'banter', verdict: 'no_action', injection: true });
    expect(injection && 'pointedAt' in injection).toBe(false);
    expect(injection && 'meta' in injection).toBe(false);
    // Nothing optional at all.
    expect(bare).toEqual({
      id: 'banter-glarn-1',
      group: 'banter',
      reason: 'other',
      note: null,
      lines: [
        { who: 'reported', text: 'gg glarn' },
        { who: 'reporter', text: 'lol' },
      ],
      expect: { severity: 'banter', verdict: 'unclear' },
    });
    for (const key of ['rules', 'pointedAt', 'meta']) expect(bare && key in bare).toBe(false);
    for (const key of ['rule', 'mustCite', 'mustNotCite', 'injection']) expect(bare && key in bare.expect).toBe(false);
  });

  it('takes any non-empty group (the eval list is advisory), every level, every verdict, every rules value', () => {
    for (const group of ['banter', 'a-group-the-eval-does-not-know', 'x']) expect(oneCase({ group }).code).toBe('ok');
    for (const severity of ['banter', 'rude', 'hostile', 'severe', ['banter', 'rude'], ['rude']]) {
      expect(oneCase({ expect: { severity, verdict: 'noted' } }).code).toBe('ok');
    }
    for (const verdict of ['upheld', 'noted', 'no_action', 'unclear']) expect(oneCase({ expect: { severity: 'rude', verdict } }).code).toBe('ok');
    for (const rules of ['relaxed', 'standard', 'strict']) expect(oneCase({ rules }).code).toBe('ok');
    expect(oneCase({ expect: { severity: 'rude', verdict: 'noted', rule: 7 } }).code).toBe('ok');
  });

  it('accepts exactly the limits: 12 lines, a 200-character line, 500 cases a file', () => {
    const lines12 = Array.from({ length: 12 }, (_, i) => ({ who: i % 2 === 0 ? 'reported' : 'reporter', text: `line ${i}` }));
    expect(oneCase({ lines: lines12, pointedAt: 12, expect: { severity: 'rude', verdict: 'noted', mustCite: [12], mustNotCite: [1] } }).code).toBe('ok');
    expect(oneCase({ lines: [{ who: 'reported', text: 'z'.repeat(200) }], pointedAt: 1, expect: { severity: 'rude', verdict: 'noted' } }).code).toBe('ok');
    const many = Array.from({ length: 500 }, (_, i) => exampleCase({ id: `c-${i}` }));
    const out = withCases(many);
    expect(out.code).toBe('ok');
    expect(out.set?.cases).toHaveLength(500);
  });

  it('a synthetic long-room case may have up to 64 lines (the AI eval has such cases); no other group, and no contributed one, may have more than 12', () => {
    const lines = (n: number): Json[] => Array.from({ length: n }, (_, i) => ({ who: i % 2 === 0 ? 'reported' : 'reporter', text: `line ${i}` }));
    const expectCited = { severity: 'rude', verdict: 'noted', mustCite: [64], mustNotCite: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43] };
    expect(oneCase({ group: 'long-room', lines: lines(64), pointedAt: 64, expect: expectCited }).code).toBe('ok');
    expect(oneCase({ group: 'long-room', lines: lines(64), pointedAt: 64, meta: { source: 'synthetic' }, expect: expectCited }).code).toBe('ok');
    for (const over of [
      { group: 'long-room', lines: lines(65), pointedAt: 1, expect: { severity: 'rude', verdict: 'noted' } },
      { group: 'long-room', lines: lines(13), pointedAt: 1, meta: { source: 'contributed' }, expect: { severity: 'rude', verdict: 'noted' } },
      { group: 'rude', lines: lines(13), pointedAt: 1, expect: { severity: 'rude', verdict: 'noted' } },
      { group: 'rude', lines: lines(64), pointedAt: 1, meta: { source: 'synthetic' }, expect: { severity: 'rude', verdict: 'noted' } },
    ]) {
      expect({ over: over.group, code: oneCase(over).code }).toEqual({ over: over.group, code: 'bad_pack' });
    }
  });

  it('keeps the order of the files and of the cases in them', () => {
    const out = run(evalFiles({ cases: { es: [exampleCase({ id: 'b' }), exampleCase({ id: 'a' })], en: [exampleCase({ id: 'c' })] } }));
    expect(out.set?.cases.map((c) => c.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('parseEvalSet: refusals', () => {
  const bad = (over: Json): void => {
    const out = oneCase(over);
    expect({ over, code: out.code, stage: out.stage }).toEqual({ over, code: 'bad_pack', stage: 'validate' });
  };

  it('refuses: an unknown who, a citation outside the lines, 13 lines, a 201-character line, 501 cases, a duplicate id, an unknown top-level key, __proto__', () => {
    bad({ lines: [{ who: 'moderator', text: 'hi' }], pointedAt: undefined });
    bad({ lines: [{ who: 'Reported', text: 'hi' }], pointedAt: undefined });
    // A citation outside the lines: 0, one past the end, negative, fractional, a string.
    for (const mustCite of [[0], [4], [-1], [1.5], ['1']]) bad({ expect: { severity: 'rude', verdict: 'noted', mustCite } });
    for (const mustNotCite of [[0], [4], [2.5]]) bad({ expect: { severity: 'rude', verdict: 'noted', mustNotCite } });
    for (const pointedAt of [0, 4, -2, 1.5, '2', null]) bad({ pointedAt });
    bad({ lines: Array.from({ length: 13 }, () => ({ who: 'reported', text: 'x' })), pointedAt: 1, expect: { severity: 'rude', verdict: 'noted' } });
    bad({ lines: [{ who: 'reported', text: 'z'.repeat(201) }], pointedAt: 1, expect: { severity: 'rude', verdict: 'noted' } });
    expect(withCases(Array.from({ length: 501 }, (_, i) => exampleCase({ id: `c-${i}` }))).code).toBe('bad_pack');
    expect(withCases([exampleCase(), exampleCase()]).code).toBe('bad_pack');
    expect(run(evalFiles({ cases: { en: [exampleCase({ id: 'same' })], es: [exampleCase({ id: 'same' })] } })).code).toBe('bad_pack');
    bad({ surprise: 1 });
    bad({ expect: { severity: 'rude', verdict: 'noted', surprise: 1 } });
    bad({ lines: [{ who: 'reported', text: 'hi', surprise: 1 }], pointedAt: undefined });
    // __proto__ as an own key (JSON.parse makes one) at the top of a case, in expect and in a line.
    const proto = (text: string): Outcome => withCases(JSON.parse(text) as unknown);
    const base = JSON.stringify(exampleCase());
    expect(proto(`[${base.slice(0, -1)},"__proto__":{"polluted":true}}]`).code).toBe('bad_pack');
    expect(proto(`[${base.replace('"verdict":"noted"', '"verdict":"noted","__proto__":{"x":1}')}]`).code).toBe('bad_pack');
    expect(proto(`[${base.replace('"text":"ok"', '"text":"ok","__proto__":{"x":1}')}]`).code).toBe('bad_pack');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a group may be named like a property every object has: constructor, toString, valueOf, hasOwnProperty, isPrototypeOf', () => {
    const names = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'toLocaleString', 'propertyIsEnumerable'];
    const cases = names.flatMap((group, i) => [exampleCase({ id: `g-${i}-a`, group }), exampleCase({ id: `g-${i}-b`, group })]);
    const out = withCases(cases);
    expect(out.code).toBe('ok');
    const set = out.set as EvalSet;
    expect(Object.fromEntries(Object.entries(set.manifest.counts.groups))).toEqual(Object.fromEntries(names.map((n) => [n, 2])));
    expect(set.cases).toHaveLength(names.length * 2);
    // The counts must still agree: a manifest that says one fewer is refused, and so is one that names a group with no cases.
    const wrong = evalFiles({ cases: { en: cases }, manifest: { counts: { cases: { en: cases.length }, groups: Object.fromEntries(names.map((n) => [n, n === 'constructor' ? 1 : 2])) } } });
    expect(run(wrong).code).toBe('bad_manifest');
    const extra = evalFiles({ cases: { en: cases }, manifest: { counts: { cases: { en: cases.length }, groups: Object.fromEntries([...names, 'toJSON'].map((n) => [n, 2])) } } });
    expect(run(extra).code).toBe('bad_manifest');
  });

  it('a single case in a group called constructor is counted once, and a manifest that says so is accepted', () => {
    const out = withCases([exampleCase({ group: 'constructor' })]);
    expect(out.code).toBe('ok');
    expect((out.set as EvalSet).manifest.counts.groups.constructor).toBe(1);
  });

  it('refuses every wrong type and out-of-range value', () => {
    for (const id of ['', 5, null, 'has space', 'x'.repeat(81), '../up']) bad({ id });
    for (const group of [5, null, '__proto__']) bad({ group });
    for (const group of ['', 'g'.repeat(65)]) expect(oneCase({ group }).code).not.toBe('ok');
    for (const reason of ['', 5, undefined as unknown as string]) bad({ reason });
    for (const note of [5, '', 'n'.repeat(501)]) bad({ note });
    for (const rules of ['loose', 5, null]) bad({ rules });
    bad({ lines: [] , pointedAt: undefined, expect: { severity: 'rude', verdict: 'noted' } });
    bad({ lines: 'ok' });
    bad({ lines: [{ who: 'reported', text: '' }], pointedAt: undefined });
    bad({ lines: [{ who: 'reported', text: 5 }], pointedAt: undefined });
    bad({ lines: [{ who: 'reported', text: 'hi', blocked: 'yes' }], pointedAt: undefined });
    for (const severity of ['mild', 5, [], ['rude', 'mild'], ['rude', 'rude'], ['banter', 'rude', 'hostile', 'severe', 'severe'], null]) bad({ expect: { severity, verdict: 'noted' } });
    for (const verdict of ['guilty', 5, null]) bad({ expect: { severity: 'rude', verdict } });
    for (const rule of [0, -1, 1.5, 'none', null]) bad({ expect: { severity: 'rude', verdict: 'noted', rule } });
    bad({ expect: { severity: 'rude', verdict: 'noted', injection: 'yes' } });
    bad({ expect: { verdict: 'noted' } });
    bad({ expect: { severity: 'rude' } });
    bad({ expect: 'rude' });
    bad({ meta: 'en' });
    bad({ meta: [] });
    bad({ meta: { language: 5 } });
    bad({ meta: { source: 'invented' } });
    bad({ meta: { reviewed: -1 } });
    bad({ meta: { since: 'soon' } });
    for (const not of [null, 5, 'case', [[]]]) expect(withCases([not]).code).toBe('bad_pack');
    expect(withCases({ cases: [] }).code).toBe('bad_pack');
  });

  it('refuses a file that is not JSON, not UTF-8, or not an array', () => {
    expect(run(evalFiles({ raw: { 'cases.en.json': '[{"id":' }, manifest: { files: undefined } })).code).not.toBe('ok');
    expect(withCases('nope').code).toBe('bad_pack');
    const broken = evalFiles();
    broken.set('cases.en.json', new Uint8Array([0xff, 0xfe, 0x5b, 0x5d]));
    expect(run(broken).code).toBe('bad_manifest');
  });
});

describe('parseEvalSet: the manifest and the archive', () => {
  it('a manifest of kind terms is refused', () => {
    const out = run(evalFiles({ manifest: { kind: 'terms' } }));
    expect({ code: out.code, stage: out.stage }).toEqual({ code: 'bad_manifest', stage: 'unpack' });
  });

  it('counts in the manifest must equal the files', () => {
    const wrong = (counts: unknown): Outcome => run(evalFiles({ manifest: { counts } }));
    const ok = { cases: { en: 4, es: 1 }, groups: { rude: 2, hostile: 1, injection: 1, banter: 1 } };
    expect(wrong(ok).code).toBe('ok');
    for (const counts of [
      { ...ok, cases: { en: 5, es: 1 } },
      { ...ok, cases: { en: 4, es: 0 } },
      { ...ok, cases: { en: 4 } },
      { ...ok, cases: { en: 4, es: 1, pt: 0 } },
      { ...ok, groups: { rude: 3, hostile: 1, injection: 1, banter: 1 } },
      { ...ok, groups: { rude: 2, hostile: 1, injection: 1 } },
      { ...ok, groups: { rude: 2, hostile: 1, injection: 1, banter: 1, extra: 0 } },
      { cases: ok.cases },
      { ...ok, surprise: {} },
      null,
      [],
    ]) {
      const out = wrong(counts);
      expect({ counts, code: out.code, stage: out.stage }).toEqual({ counts, code: 'bad_manifest', stage: 'unpack' });
    }
  });

  it('the languages, the files and the hashes must agree with the entries', () => {
    expect(run(evalFiles({ manifest: { languages: ['en'] } })).code).toBe('bad_manifest');
    expect(run(evalFiles({ manifest: { languages: ['en', 'es', 'pt'] } })).code).toBe('bad_manifest');
    expect(run(evalFiles({ tamper: { 'cases.en.json': tamperText('quissel', 'quisseL') } })).code).toBe('bad_manifest');
    expect(run(evalFiles({ unlisted: { 'cases.pt.json': '[]' } })).code).toBe('bad_manifest');
    expect(run(evalFiles({ unlisted: { 'terms.json': '[]' } })).code).toBe('bad_manifest');
    expect(run(evalFiles({ omit: ['cases.es.json'] })).code).toBe('bad_manifest');
    const noManifest = evalFiles();
    noManifest.delete('manifest.json');
    expect(run(noManifest).code).toBe('bad_manifest');
    for (const name of ['cases.EN.json', 'cases.english.json', 'cases..json', 'cases.en.json.bak']) {
      expect(run(evalFiles({ unlisted: { [name]: '[]' } })).code).toBe('bad_manifest');
    }
  });

  it('every file is hashed before any is parsed: a bad hash wins over a bad case', () => {
    const files = evalFiles({ cases: { en: [{ nonsense: true }] } });
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json'))) as Json;
    (manifest.files as Record<string, { sha256: string }>)['cases.en.json']!.sha256 = sha256HexNode(enc.encode('other'));
    files.set('manifest.json', enc.encode(JSON.stringify(manifest)));
    expect(run(files).code).toBe('bad_manifest');
  });

  it('the manifest must say what the index said: version, and a sequence no higher', () => {
    expect(run(evalFiles(), { version: '2026.12.0', sequence: 14 }).code).toBe('ok');
    expect(run(evalFiles(), { version: '2026.12.1' }).code).toBe('bad_manifest');
    expect(run(evalFiles(), { sequence: 13 }).code).toBe('bad_manifest');
  });

  it('refuses a bad manifest: unknown key, bad version, bad date, bad license, no cases files listed', () => {
    for (const manifest of [
      { surprise: 1 },
      { version: '26.12' },
      { sequence: -1 },
      { builtAt: 'yesterday' },
      { previous: 5 },
      { license: { spdx: 'CC-BY-4.0' } },
      { schema: 'chatwarden-corpus-manifest/2' },
      { gate: { passed: true } },
    ]) {
      const out = run(evalFiles({ manifest }));
      expect({ manifest, code: out.code }).toEqual({ manifest, code: 'bad_manifest' });
    }
    const notAMap = parseEvalSetOrCode({} as never);
    expect(notAMap).toBe('bad_manifest');
  });

  it('a speaker value that looks like a handle, an id or an email in text is not rejected here (that is the service\'s checkCase) but never appears in an error', () => {
    // Text is free text here: a handle, an email, a long number, a URL all parse.
    const lines = [
      { who: 'reported', text: '@someone_77 mail me at a.person@example.test or call 555123456789' },
      { who: 'reporter', text: 'see https://example.test/invite/abc123' },
    ];
    const ok = oneCase({ lines, pointedAt: 1, expect: { severity: 'rude', verdict: 'noted' } });
    expect(ok.code).toBe('ok');
    expect(ok.set?.cases[0]?.lines[0]?.text).toContain('@someone_77');
    // A speaker that is a handle, an id or an email is refused, and nothing it says is in the error.
    for (const who of ['@someone_77', 'player-8841', 'a.person@example.test', 'zorbak']) {
      const out = oneCase({ lines: [{ who, text: 'hi' }], pointedAt: undefined, expect: { severity: 'rude', verdict: 'noted' } });
      expect(out.code).toBe('bad_pack');
      const text = `${out.err?.message}|${out.err?.code}|${out.err?.stage}|${JSON.stringify(out.err)}`;
      expect(text).not.toContain(who);
      expect(text).not.toContain('someone');
    }
  });

  it('no error message holds anything from the input (invented words through every failure path)', () => {
    const outcomes: Outcome[] = [];
    for (const word of WORDS) {
      outcomes.push(oneCase({ id: word, group: word, surprise: word }));
      outcomes.push(oneCase({ lines: [{ who: word, text: word }], pointedAt: undefined }));
      outcomes.push(oneCase({ expect: { severity: word, verdict: word } }));
      outcomes.push(run(evalFiles({ manifest: { kind: word } })));
      outcomes.push(run(evalFiles({ unlisted: { [`${word}.json`]: word } })));
      outcomes.push(run(evalFiles({ raw: { 'cases.en.json': word } })));
    }
    for (const out of outcomes) {
      expect(out.code).not.toBe('ok');
      const shown = `${out.err?.message} ${JSON.stringify(out.err)} ${out.err?.stack?.split('\n')[0]}`;
      for (const word of WORDS) expect(shown).not.toContain(word);
    }
  });
});

function parseEvalSetOrCode(files: Parameters<typeof parseEvalSet>[0]): string {
  try {
    parseEvalSet(files);
    return 'ok';
  } catch (e) {
    return (e as CorpusError).code;
  }
}

describe('compat with the AI eval', () => {
  const root = new URL('../../../examples/ai-anthropic/eval/', import.meta.url);

  it('compat: every case in examples/ai-anthropic/eval/cases.json parses unchanged', () => {
    const raw = JSON.parse(readFileSync(new URL('cases.json', root), 'utf8')) as Json[];
    expect(raw.length).toBeGreaterThan(30);
    expect(raw.length).toBeLessThanOrEqual(500);
    const out = run(evalFiles({ cases: { en: raw } }));
    expect(out.code).toBe('ok');
    expect(out.set?.cases).toEqual(raw);
    // The eval's own group list is advisory here, but the shipped cases are all inside it.
    const source = readFileSync(new URL('cases.ts', root), 'utf8');
    for (const group of new Set(raw.map((c) => c.group as string))) expect(source).toContain(`'${group}'`);
  });

  it('compat: the same cases with every optional meta added still parse', () => {
    const raw = (JSON.parse(readFileSync(new URL('cases.json', root), 'utf8')) as Json[]).map((c) => ({ ...c, meta: { language: 'en', source: 'synthetic', reviewed: 3, since: '2026.12.0', other: [1] } }));
    const out = run(evalFiles({ cases: { en: raw } }));
    expect(out.code).toBe('ok');
    expect(out.set?.cases.every((c) => c.meta?.source === 'synthetic')).toBe(true);
  });
});

describe('the cases a set reads are the cases it was given', () => {
  it('does not share objects with the input entries, and a frozen-looking input is not changed', () => {
    const files = evalFiles({ cases: { en: exampleCases() } });
    const before = new Map([...files].map(([k, v]) => [k, v.slice()]));
    const out = run(files);
    expect(out.code).toBe('ok');
    for (const [name, bytes] of files) expect(bytes).toEqual(before.get(name));
  });
});
