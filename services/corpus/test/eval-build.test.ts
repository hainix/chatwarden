import { buildMatcher, VERSION } from '@chatwarden/matcher';
import { parseEvalSet, readZip, type EvalSet } from '@chatwarden/matcher/corpus';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildEvalRelease, type EvalBuildOptions, type EvalBuildResult } from '../src/build/eval.js';
import { BuildError } from '../src/build/release.js';
import { makePublishWorld, type PublishWorld } from './publish-world.js';
import { verifyLive } from '../src/tools/verifyLive.js';
import { makeClock } from './world.js';

// The eval and calibration set builder (design 6.10, 12): read back by the kit's own parseEvalSet and loader. Invented words only.

const corpus = buildMatcher([{ id: 'a', term: 'quissel', language: 'en', active: true }, { id: 'b', term: 'zorbak', language: 'es', active: true }], []);
const clock = makeClock('2026-12-01T09:00:00Z');

/** A case in the AI eval's shape plus meta, with the pieces a test changes. */
const mk = (id: string, over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  group: 'rude',
  reason: 'harassment',
  note: null,
  rules: 'standard',
  pointedAt: 2,
  lines: [
    { who: 'reporter', text: 'that was a fair fight' },
    { who: 'reported', text: 'you play like a quissel', blocked: true },
    { who: 'reporter', text: 'ok' },
  ],
  expect: { severity: 'rude', rule: 2, verdict: 'noted', mustCite: [2] },
  meta: { language: 'en', source: 'synthetic', reviewed: 3, ...meta },
  ...over,
});

const opts = (over: Partial<EvalBuildOptions> = {}): EvalBuildOptions => ({ clock, version: '2026.12.0', sequence: 1, previous: null, corpus, ...over });
const build = (cases: Record<string, unknown[]>, over: Partial<EvalBuildOptions> = {}): EvalBuildResult => buildEvalRelease(cases, opts(over));
const read = async (r: EvalBuildResult): Promise<EvalSet> => parseEvalSet(await readZip(r.zip), { version: r.summary.version, sequence: r.summary.sequence });
const text = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);

describe('the built set parses with the kit\u2019s parseEvalSet', () => {
  it('writes manifest, one cases file for each language (an empty one for a language with none), the licence and the readme', async () => {
    const r = build({ en: [mk('rude-quissel-1'), mk('rude-quissel-2', { group: 'hostile' })], es: [mk('rude-zorbak-1', {}, { language: 'es' })] });
    const files = await readZip(r.zip);
    expect([...files.keys()]).toEqual(['manifest.json', 'cases.en.json', 'cases.es.json', 'cases.pt.json', 'LICENSE.txt', 'README.txt']);
    expect(JSON.parse(text(files.get('cases.pt.json')))).toEqual([]);
    const set = await read(r);
    expect(set.manifest.kind).toBe('eval');
    expect(set.manifest.languages).toEqual(['en', 'es', 'pt']);
    expect(set.cases.map((c) => c.id)).toEqual(['rude-quissel-1', 'rude-quissel-2', 'rude-zorbak-1']);
    expect(set.byLanguage.es?.[0]?.meta).toEqual({ language: 'es', source: 'synthetic', reviewed: 3, since: '2026.12.0' });
  });

  it('the manifest has exactly the eval keys: no matcher gate, counts of cases per language and per group', async () => {
    const r = build({ en: [mk('a-1'), mk('a-2', { group: 'hostile' }), mk('a-3', { group: 'hostile' })], es: [], pt: [] });
    const manifest = JSON.parse(text((await readZip(r.zip)).get('manifest.json'))) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual(['schema', 'kind', 'version', 'sequence', 'builtAt', 'previous', 'license', 'languages', 'counts', 'files']);
    expect(manifest.counts).toEqual({ cases: { en: 3, es: 0, pt: 0 }, groups: { hostile: 2, rude: 1 } });
    expect(manifest).not.toHaveProperty('gate');
  });

  it('a case is written in the shape of the AI eval, in a fixed key order, and only keys the kit knows', async () => {
    const r = build({ en: [mk('a-1', {}, { junk: 'dropped', language: 'en' })] });
    const raw = JSON.parse(text((await readZip(r.zip)).get('cases.en.json'))) as Record<string, unknown>[];
    expect(Object.keys(raw[0] as object)).toEqual(['id', 'group', 'reason', 'note', 'rules', 'pointedAt', 'lines', 'expect', 'meta']);
    expect(Object.keys((raw[0] as { meta: object }).meta)).toEqual(['language', 'source', 'reviewed', 'since']);
    expect(Object.keys((raw[0] as { lines: object[] }).lines[1] as object)).toEqual(['who', 'text', 'blocked']);
    expect(Object.keys((raw[0] as { expect: object }).expect)).toEqual(['severity', 'rule', 'verdict', 'mustCite']);
  });

  it('counts in the manifest equal the files, whatever mix of languages and groups', async () => {
    const r = build({
      en: Array.from({ length: 5 }, (_, i) => mk(`en-${i}`, { group: i % 2 === 0 ? 'rude' : 'banter' })),
      pt: Array.from({ length: 2 }, (_, i) => mk(`pt-${i}`, { group: 'severe-slur' }, { language: 'pt' })),
    });
    const set = await read(r); // parseEvalSet itself refuses a manifest whose counts differ from the files
    expect(set.manifest.counts.cases).toEqual({ en: 5, es: 0, pt: 2 });
    expect(set.manifest.counts.groups).toEqual({ banter: 2, rude: 3, 'severe-slur': 2 });
    expect(r.summary.languages).toEqual({ en: { cases: 5 }, es: { cases: 0 }, pt: { cases: 2 } });
    for (const [name, entry] of Object.entries(set.manifest.files)) {
      const bytes = (await readZip(r.zip)).get(name) as Uint8Array;
      expect(entry).toEqual({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  });

  it('the summary is what the index needs: kind, hash, size, paths, the minimum kit', async () => {
    const r = build({ en: [mk('a-1')] });
    expect(r.summary).toMatchObject({ kind: 'eval', version: '2026.12.0', sequence: 1, minKit: VERSION, bytes: r.zip.length, zip: 'eval/2026.12.0/eval-2026.12.0.zip', sig: 'eval/2026.12.0/eval-2026.12.0.zip.sig' });
    expect(r.summary.sha256).toBe(createHash('sha256').update(r.zip).digest('hex'));
  });

  it('is deterministic: the same input twice is the same bytes, and the input order does not matter', () => {
    const a = build({ en: [mk('b-2'), mk('a-1')] });
    const b = build({ en: [mk('a-1'), mk('b-2')] });
    expect(a.summary.sha256).toBe(b.summary.sha256);
  });

  it('an empty set builds, with zero counts', async () => {
    const r = build({});
    expect((await read(r)).cases).toEqual([]);
    expect(r.held).toEqual([]);
  });
});

describe('reference labels need three reviewers (meta.reviewed >= 3)', () => {
  it('holds a case reviewed by fewer than three, or with no count, by id', () => {
    const r = build({ en: [mk('ok-1'), mk('two-1', {}, { reviewed: 2 }), mk('none-1', {}, { reviewed: undefined }), mk('three-2', {}, { reviewed: 3 })] });
    expect(r.held).toEqual([
      { id: 'none-1', language: 'en', code: 'unreviewed' },
      { id: 'two-1', language: 'en', code: 'unreviewed' },
    ]);
    expect(r.set.cases.map((c) => c.id)).toEqual(['ok-1', 'three-2']);
  });

  it('a case with no meta at all is not published, and the number can be raised', () => {
    expect(build({ en: [mk('x-1', { meta: undefined })] }).held).toEqual([{ id: 'x-1', language: 'en', code: 'unreviewed' }]);
    expect(build({ en: [mk('x-1', {}, { reviewed: 3 })] }, { minReviewed: 4 }).held).toEqual([{ id: 'x-1', language: 'en', code: 'unreviewed' }]);
  });
});

describe('the privacy rules hold at build time too: a case that fails checkCase is held, by id and code', () => {
  it('holds a contributed case with a URL, an identifier, a 13th line, and one whose blocked line is not a corpus term', () => {
    const lines13 = Array.from({ length: 13 }, (_, i) => ({ who: 'reporter', text: `line ${i}` }));
    const r = build({
      en: [
        mk('url-1', { lines: [{ who: 'reporter', text: 'see https://example.test' }] }, { source: 'contributed' }),
        mk('id-1', { lines: [{ who: 'Alice', text: 'hello' }] }, { source: 'contributed' }),
        mk('long-1', { lines: lines13 }, { source: 'contributed' }),
        mk('term-1', { lines: [{ who: 'reported', text: 'you snerpux', blocked: true }] }, { source: 'contributed' }),
        mk('fine-1', {}, { source: 'contributed' }),
      ],
    });
    expect(r.held).toEqual([
      { id: 'id-1', language: 'en', code: 'identifier' },
      { id: 'long-1', language: 'en', code: 'too_long' },
      { id: 'term-1', language: 'en', code: 'unknown_term' },
      { id: 'url-1', language: 'en', code: 'contact' },
    ]);
    expect(r.set.cases.map((c) => c.id)).toEqual(['fine-1']);
  });

  it('a synthetic long-room case may have 64 lines; a contributed one may not, and 65 never', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ who: 'reporter', text: `line ${i}` }));
    const r = build({ en: [mk('lr-1', { group: 'long-room', lines: many(64), pointedAt: 1, expect: { severity: 'rude', verdict: 'noted', mustCite: [1] } }), mk('lr-2', { group: 'long-room', lines: many(64) }, { source: 'contributed' }), mk('lr-3', { group: 'long-room', lines: many(65) })] });
    expect(r.held).toEqual([
      { id: 'lr-2', language: 'en', code: 'too_long' },
      { id: 'lr-3', language: 'en', code: 'too_long' },
    ]);
  });

  it('holds a case the kit would refuse (an unknown key, a citation outside the lines) as bad_case, and never fails the build for it', () => {
    const r = build({ en: [mk('ok-1'), mk('bad-1', { extra: true }), mk('bad-2', { expect: { severity: 'rude', verdict: 'noted', mustCite: [9] } }), mk('bad-3', { lines: [] }), { nope: 1 }] });
    expect(r.held.map((h) => h.code)).toEqual(['bad_case', 'bad_case', 'bad_case', 'bad_case']);
    expect(r.held.map((h) => h.id)).toEqual(['#4', 'bad-1', 'bad-2', 'bad-3']);
    expect(r.set.cases.map((c) => c.id)).toEqual(['ok-1']);
  });

  it('a case in the wrong language\u2019s file, and an id used twice, are held', () => {
    const r = build({ en: [mk('a-1'), mk('a-2', {}, { language: 'es' })], es: [mk('a-1', {}, { language: 'es' })] });
    expect(r.held).toEqual([
      { id: 'a-1', language: 'es', code: 'duplicate_id' },
      { id: 'a-2', language: 'en', code: 'bad_case' },
    ]);
  });

  it('a hold carries an id, a language and a code: never a line', () => {
    const r = build({ en: [mk('url-1', { lines: [{ who: 'reporter', text: 'see https://example.test/secret-path' }] }, { source: 'contributed' })] });
    expect(JSON.stringify(r.held)).not.toMatch(/secret-path|example/);
  });
});

describe('options and errors', () => {
  it('more than 500 cases in one language is a clear BuildError (the kit reads at most 500), with the count, not an opaque self-check failure', () => {
    const cases = Array.from({ length: 501 }, (_, i) => mk(`rude-quissel-${i}`));
    const err = (() => {
      try {
        build({ en: cases });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(BuildError);
    expect(err).toMatchObject({ code: 'too_many_cases' });
    expect(String((err as Error).message)).toContain('500');
    expect(String((err as Error).message)).toContain('501');
    expect(build({ en: cases.slice(0, 500) }).set.cases).toHaveLength(500);
  });

  it('refuses a version, a sequence, a language or a corpus that is not valid, with a fixed BuildError', () => {
    for (const bad of [{ version: '2026.13.0' }, { sequence: 0 }, { previous: 'x' }, { languages: ['en', 'xx'] }, { languages: [] }] as Partial<EvalBuildOptions>[]) {
      expect(() => build({}, bad), JSON.stringify(bad)).toThrow(BuildError);
    }
    expect(() => buildEvalRelease({}, { ...opts(), corpus: undefined as never })).toThrow(BuildError);
  });

  it('refuses cases in a language the release does not list', () => {
    expect(() => build({ fr: [mk('a-1', {}, { language: 'fr' })] })).toThrow(BuildError);
  });
});

describe('the eval set through the whole chain: build, sign, publish, then the kit\u2019s loader and verify-live', () => {
  let pw: PublishWorld;
  beforeEach(async () => {
    pw = await makePublishWorld();
  });

  it('a signed, published eval set is read by the kit\u2019s eval loader, and verify-live passes for it', async () => {
    const { signBytes } = await import('../src/tools/sign.js');
    const { createCorpusLoader } = await import('@chatwarden/matcher/corpus');
    const r = build({ en: [mk('a-1'), mk('a-2')], es: [mk('b-1', {}, { language: 'es' })] });
    const zipSig = signBytes('zip', r.zip, pw.key.key, 'k1');
    await pw.publish(r, zipSig);
    const BASE = 'https://releases.example.test/v1';
    const fetchOf = (async (input: Parameters<typeof fetch>[0]) => {
      const bytes = pw.store.files.get(`v1/${String(input).slice(BASE.length + 1)}`);
      return bytes === undefined ? new Response('no', { status: 404 }) : new Response(bytes.slice());
    }) as typeof fetch;
    const files = new Map<string, Uint8Array>();
    const loader = createCorpusLoader({
      kind: 'eval',
      select: { languages: ['en'] },
      cache: { read: async (n) => files.get(n) ?? null, write: async (n, b) => void files.set(n, b.slice()), remove: async (n) => void files.delete(n) },
      clock: pw.bw.clock,
      baseUrl: BASE,
      keys: pw.keys,
      fetch: fetchOf,
      follow: 'stable',
    });
    const done = await loader.refresh();
    expect(done.status).toMatchObject({ state: 'ready', lastError: null });
    expect(loader.release()?.cases.map((c) => c.id)).toEqual(['a-1', 'a-2']);
    const live = await verifyLive({ fetch: fetchOf, baseUrl: BASE, keys: pw.keys, clock: pw.bw.clock });
    expect(live.checks).toEqual([{ kind: 'eval', version: '2026.12.0', ok: true, detail: '3 cases in en, es, pt' }]);
  });
});
