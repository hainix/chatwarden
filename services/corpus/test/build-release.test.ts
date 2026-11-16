import { VERSION, buildMatcher, loadTermPack } from '@chatwarden/matcher';
import { parseTermsRelease, readZip, releaseToPack, type TermsRelease } from '@chatwarden/matcher/corpus';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { BuildError, buildTermsRelease, dedupeByWordKey, nextSequence, nextVersion, type BuildOptions, type BuildResult } from '../src/build/release.js';
import type { TermRecord } from '../src/build/snapshot.js';
import { makeBuildWorld, type BuildWorld } from './build-world.js';

// The release builder (design 6.4 to 6.7, 13), judged by the kit's own readers. Invented words only; the test corpus is generated here.

let w: BuildWorld;
beforeEach(async () => {
  w = await makeBuildWorld();
});

const opts = (over: Partial<BuildOptions> = {}): BuildOptions => ({ clock: w.clock, version: '2026.12.0', sequence: 1, previous: null, ...over });
const build = (over: Partial<BuildOptions> = {}): Promise<BuildResult> => buildTermsRelease(w.db, opts(over));
const read = async (r: BuildResult): Promise<TermsRelease> => parseTermsRelease(await readZip(r.zip), { version: r.summary.version, sequence: r.summary.sequence });
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const text = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);

/** The design's example shape, in invented words: an English slur, an abuse word in two languages, a disputed and a withdrawn row, a default-off row. */
async function seed(): Promise<void> {
  await w.term({ id: 'CWT-2026-00001', term: 'zorbak', category: 'slur', target: 'ethnicity', severity: 'severe', approvals: 2 });
  await w.term({ id: 'CWT-2026-00002', term: 'vlemmo', languages: ['en', 'es'], category: 'abuse', severity: 'hostile', status: 'provisional', approvals: 1 });
  await w.term({ id: 'CWT-2026-00003', term: 'quissel', languages: ['es'], category: 'sexual', severity: 'rude', status: 'accepted' });
  await w.term({ id: 'CWT-2026-00004', term: 'drakkuun', languages: ['pt'], status: 'disputed' });
  await w.term({ id: 'CWT-2026-00005', term: 'fenrisk', status: 'withdrawn' });
  await w.term({ id: 'CWT-2026-00006', term: 'glarn', defaultActive: false });
  await w.innocent('en', ['zorbakian', 'unvlemmo', 'quisselx'], 100);
  await w.negative('en', ['a plain english sentence', 'another sentence about tarvo lake']);
  await w.negative('es', ['una frase sencilla']);
}

describe('builds a release from a seeded D1 of invented words; the output parses with the kit\u2019s parseTermsRelease and passes loadTermPack', () => {
  it('is read by the kit: manifest, rows (all 13 fields, in order), exceptions, one negative file for each language, positive.json', async () => {
    await seed();
    const r = await build();
    const files = await readZip(r.zip);
    expect([...files.keys()]).toEqual(['manifest.json', 'terms.json', 'exceptions.json', 'negative.en.json', 'negative.es.json', 'negative.pt.json', 'positive.json', 'LICENSE.txt', 'README.txt']);
    const rel = await read(r);
    expect(rel.version).toBe('2026.12.0');
    expect(rel.sequence).toBe(1);
    expect(rel.manifest.languages).toEqual(['en', 'es', 'pt']);
    expect(rel.terms.map((t) => t.id)).toEqual(['CWT-2026-00001', 'CWT-2026-00002', 'CWT-2026-00003', 'CWT-2026-00004', 'CWT-2026-00005', 'CWT-2026-00006']);
    const raw = JSON.parse(text(files.get('terms.json'))) as Record<string, unknown>[];
    expect(Object.keys(raw[0] as object)).toEqual(['id', 'term', 'languages', 'category', 'target', 'severity', 'status', 'defaultActive', 'collidesWith', 'since', 'approvals', 'positive', 'negative']);
    expect(JSON.parse(text(files.get('exceptions.json')))).toEqual([]);
    const positive = JSON.parse(text(files.get('positive.json'))) as { schema: string; lines: string[] };
    expect(positive.schema).toBe('chatwarden-corpus-positive/1');
    expect(positive.lines.length).toBeGreaterThan(0);
    expect(rel.negative.en?.lines).toEqual(['a plain english sentence', 'another sentence about tarvo lake']);
    expect(rel.negative.pt?.lines).toEqual([]);
  });

  it('the manifest counts every manifest language including zeros (a row in two languages counts in both), the statuses, and the matcher gate', async () => {
    await seed();
    const rel = await read(await build());
    expect(rel.manifest.counts.terms).toEqual({ en: 4, es: 2, pt: 1 });
    expect(rel.manifest.counts.exceptions).toEqual({ en: 0, es: 0, pt: 0 });
    expect(rel.manifest.counts.status).toEqual({ accepted: 3, provisional: 1, disputed: 1, withdrawn: 1 });
    expect(rel.manifest.gate.matcher).toBe(VERSION);
    expect(rel.manifest.gate.passed).toBe(true);
    expect(rel.manifest.gate.positiveLines).toBeGreaterThan(10);
    expect(rel.manifest.license).toEqual({ spdx: 'CC-BY-4.0', attribution: 'Contains the Chatwarden community term list (chatwarden.dev), CC BY 4.0.' });
    expect(rel.manifest.previous).toBeNull();
    expect(rel.manifest.builtAt).toBe(Date.parse('2026-12-01T09:00:00Z'));
  });

  it('counts zero for a language no row lists, and lists only the languages asked for', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    expect((await read(await build())).manifest.counts.terms).toEqual({ en: 1, es: 0, pt: 0 });
    const only = await read(await build({ languages: ['en'] }));
    expect(only.manifest.languages).toEqual(['en']);
    expect(only.manifest.counts.terms).toEqual({ en: 1 });
    expect(Object.keys(only.negative)).toEqual(['en']);
  });

  it('the pack the kit makes from it passes loadTermPack, for every language selection', async () => {
    await seed();
    const rel = await read(await build());
    for (const languages of [['en'], ['es'], ['pt'], ['en', 'es'], ['en', 'es', 'pt']]) {
      const pack = releaseToPack(rel, { languages, minSeverity: 'rude' });
      expect(() => loadTermPack(JSON.parse(JSON.stringify(pack)))).not.toThrow();
      expect(pack.id).toBe('chatwarden-corpus');
    }
  });

  it('rows carry status, defaultActive, approvals and category as the database holds them; disputed and withdrawn rows are published (inactive in a store)', async () => {
    await seed();
    const rel = await read(await build());
    const by = Object.fromEntries(rel.terms.map((t) => [t.id, t]));
    expect(by['CWT-2026-00001']).toMatchObject({ term: 'zorbak', category: 'slur', target: 'ethnicity', severity: 'severe', status: 'accepted', defaultActive: true, approvals: 2, languages: ['en'] });
    expect(by['CWT-2026-00002']).toMatchObject({ status: 'provisional', approvals: 1, languages: ['en', 'es'] });
    expect(by['CWT-2026-00004']?.status).toBe('disputed');
    expect(by['CWT-2026-00005']?.status).toBe('withdrawn');
    expect(by['CWT-2026-00006']?.defaultActive).toBe(false);
    const pack = releaseToPack(rel, { languages: ['en', 'es', 'pt'], minSeverity: 'rude' });
    const active = Object.fromEntries(pack.terms.map((t) => [t.id, t.active]));
    expect(active['CWT-2026-00004']).toBe(false);
    expect(active['CWT-2026-00005']).toBe(false);
    expect(active['CWT-2026-00006']).toBe(false);
    expect(active['CWT-2026-00001']).toBe(true);
  });

  it('stamps `since` with this version for a term never released, and keeps the version of one that was', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', since: '2026.11.0' });
    await w.term({ id: 'CWT-2026-00002', term: 'vlemmo', since: null });
    const built = await build({ previous: '2026.11.0' });
    const rel = await read(built);
    expect(Object.fromEntries(rel.terms.map((t) => [t.id, t.since]))).toEqual({ 'CWT-2026-00001': '2026.11.0', 'CWT-2026-00002': '2026.12.0' });
    // `stamped` is what the database must be told once the release is out: the ids that got their `since` from this release (a held term is not one).
    expect(built.stamped).toEqual(['CWT-2026-00002']);
    expect(rel.manifest.previous).toBe('2026.11.0');
  });

  it('the summary names what the index needs: sha-256 and size of the zip, the paths, the per-language counts, the minimum kit', async () => {
    await seed();
    const r = await build();
    expect(r.summary).toMatchObject({
      kind: 'terms',
      version: '2026.12.0',
      sequence: 1,
      minKit: VERSION,
      bytes: r.zip.length,
      sha256: sha(r.zip),
      zip: 'terms/2026.12.0/terms-2026.12.0.zip',
      sig: 'terms/2026.12.0/terms-2026.12.0.zip.sig',
      languages: { en: { terms: 4, exceptions: 0 }, es: { terms: 2, exceptions: 0 }, pt: { terms: 1, exceptions: 0 } },
    });
  });

  it('an empty term table builds a valid empty release', async () => {
    const rel = await read(await build());
    expect(rel.terms).toEqual([]);
    expect(rel.manifest.counts.status).toEqual({ accepted: 0, provisional: 0, disputed: 0, withdrawn: 0 });
  });
});

describe('positive lines are blocked by their term, negatives never are', () => {
  it('every row positive line is blocked by its own term, the templates are capped at 8, and the bare term is the first', async () => {
    await seed();
    const rel = await read(await build());
    for (const t of rel.terms) {
      const own = buildMatcher([{ id: t.id, term: t.term, language: 'en', active: true }], []);
      expect(t.positive.length, t.id).toBeGreaterThan(0);
      expect(t.positive.length, t.id).toBeLessThanOrEqual(8);
      expect(t.positive[0]).toBe(t.term);
      for (const line of t.positive) expect(own.match(line), `${t.id} ${JSON.stringify(line)}`).not.toBeNull();
    }
  });

  it('every line of positive.json is blocked by the pack of all three languages', async () => {
    await seed();
    const rel = await read(await build());
    const pack = releaseToPack(rel, { languages: ['en', 'es', 'pt'], minSeverity: 'rude' });
    const m = buildMatcher(pack.terms, pack.exceptions);
    expect(rel.positive.length).toBeGreaterThan(0);
    for (const line of rel.positive) expect(m.match(line), JSON.stringify(line)).not.toBeNull();
  });

  it('no row negative line and no negative-corpus line is blocked by the pack of the languages it belongs to', async () => {
    await seed();
    const rel = await read(await build());
    for (const languages of [['en'], ['es'], ['en', 'es', 'pt']]) {
      const pack = releaseToPack(rel, { languages, minSeverity: 'rude' });
      const m = buildMatcher(pack.terms, pack.exceptions);
      for (const line of pack.negativeCorpus) expect(m.match(line), JSON.stringify(line)).toBeNull();
    }
    for (const t of rel.terms) {
      const own = buildMatcher([{ id: t.id, term: t.term, language: 'en', active: true }], []);
      for (const line of t.negative.filter((l) => l !== t.term)) expect(own.match(line), `${t.id} ${JSON.stringify(line)}`).toBeNull();
    }
  });

  it('a row\u2019s negatives are the reviewers\u2019 lines first, then dictionary words that contain the term, at most 50, none longer than 200', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    await w.line('CWT-2026-00001', 'negative', 'the zorbakian lake');
    await w.line('CWT-2026-00001', 'negative', 'x'.repeat(201));
    await w.innocent('en', Array.from({ length: 80 }, (_, i) => `zorbak${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}b`), 50);
    const row = (await read(await build())).terms[0]!;
    expect(row.negative[0]).toBe('the zorbakian lake');
    expect(row.negative).toHaveLength(50);
    expect(row.negative.every((l) => l.length <= 200)).toBe(true);
    expect(new Set(row.negative).size).toBe(50);
  });

  it('a reviewer\u2019s positive line joins the templates after them, and is held to the same gate', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    await w.line('CWT-2026-00001', 'positive', 'a long zorbak of a night');
    const row = (await read(await build())).terms[0]!;
    expect(row.positive).toContain('a long zorbak of a night');
    expect(row.positive.indexOf('a long zorbak of a night')).toBeGreaterThan(row.positive.indexOf('you zorbak'));
  });

  it('negative.<lang>.json holds at most 2 000 lines of at most 500 characters, sorted; the whole set is still gated', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    const lines = Array.from({ length: 2100 }, (_, i) => `plain sentence number ${String(i).padStart(4, '0')}`);
    await w.negative('en', [...lines, 'z'.repeat(501)]);
    const rel = await read(await build());
    expect(rel.negative.en?.lines).toHaveLength(2000);
    expect(rel.negative.en?.lines).toEqual([...lines].sort().slice(0, 2000));
    // A line past the 2 000th that the term would block is caught by the gate, not shipped and not ignored: the term is held.
    await w.negative('en', ['zz after the cap: zorbak']);
    const held = await build();
    expect(held.held).toEqual([{ id: 'CWT-2026-00001', code: 'negative_corpus_blocked' }]);
  });
});

describe('a term that fails the cross-language gate is held, not published', () => {
  it('an English word that equals an ordinary word of its own language (at any rank) is held; the others are published; the build says which', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    await w.term({ id: 'CWT-2026-00002', term: 'vlemmo' });
    await w.innocent('en', ['vlemmo'], 90_000); // a rare ordinary word: the arrival gate lets it through, a reviewer overrode, the builder holds it
    const r = await build();
    expect(r.held).toEqual([{ id: 'CWT-2026-00002', code: 'innocent_word_blocked' }]);
    expect((await read(r)).terms.map((t) => t.id)).toEqual(['CWT-2026-00001']);
    expect((await read(r)).manifest.counts.terms.en).toBe(1);
  });

  it('a negative-corpus line that a term blocks holds that term', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    await w.term({ id: 'CWT-2026-00002', term: 'vlemmo' });
    await w.negative('en', ['the old vlemmo of the lake']);
    expect((await build()).held).toEqual([{ id: 'CWT-2026-00002', code: 'negative_corpus_blocked' }]);
  });

  it('a reviewer\u2019s negative line that the term itself blocks holds it (the lines contradict the word)', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    await w.line('CWT-2026-00001', 'negative', 'a zorbak is a zorbak');
    expect((await build()).held).toEqual([{ id: 'CWT-2026-00001', code: 'negative_blocked' }]);
  });

  it('a reviewer\u2019s positive line that the term does not block holds it', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    await w.line('CWT-2026-00001', 'positive', 'nothing to see here');
    expect((await build()).held).toEqual([{ id: 'CWT-2026-00001', code: 'positive_not_blocked' }]);
  });

  it('every failing term is held, in one build, and the rest is published', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    await w.term({ id: 'CWT-2026-00002', term: 'vlemmo' });
    await w.term({ id: 'CWT-2026-00003', term: 'quissel' });
    await w.negative('en', ['a vlemmo', 'a quissel']);
    const r = await build();
    expect(r.held.map((h) => h.id)).toEqual(['CWT-2026-00002', 'CWT-2026-00003']);
    expect((await read(r)).terms.map((t) => t.id)).toEqual(['CWT-2026-00001']);
  });

  it('a held term is not counted as added, and the diff lists it as held, by id', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    await w.line('CWT-2026-00001', 'negative', 'a zorbak is a zorbak');
    const r = await build();
    expect(r.diff.held).toEqual([{ id: 'CWT-2026-00001', code: 'negative_blocked' }]);
    expect(r.diff.added).toEqual([]);
  });

  it('a term that was already released and now fails stops the build: nothing may silently leave a published list', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', since: '2026.11.0' });
    await w.negative('en', ['the zorbak line']);
    const err = await build().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildError);
    expect(err).toMatchObject({ code: 'gate_failed', ids: ['CWT-2026-00001'] });
    expect(String((err as Error).message)).not.toMatch(/zorbak/);
  });

  it('a term the previous release carried counts as published even when its `since` was never recorded: a failing gate stops the build', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', since: null });
    const first = await build({ version: '2026.11.0', previous: null });
    expect((await read(first)).terms.map((t) => t.id)).toEqual(['CWT-2026-00001']);
    await w.negative('en', ['the zorbak line']);
    const err = await build({ previous: '2026.11.0', previousTerms: (await read(first)).terms }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'gate_failed', ids: ['CWT-2026-00001'] });
  });

  it('without the previous rows the same term (since unset) is held, as before', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', since: null });
    await w.negative('en', ['the zorbak line']);
    expect((await build()).held).toEqual([{ id: 'CWT-2026-00001', code: 'negative_corpus_blocked' }]);
  });

  it('reports the published terms whose `since` the database still lacks (the record SQL was not applied), by id', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', since: null });
    await w.term({ id: 'CWT-2026-00002', term: 'vlemmo', since: '2026.11.0' });
    await w.term({ id: 'CWT-2026-00003', term: 'quissel', since: null });
    const first = await build({ version: '2026.11.0', previous: null });
    const prev = (await read(first)).terms;
    const next = await build({ previous: '2026.11.0', previousTerms: prev });
    expect(next.unrecorded).toEqual(['CWT-2026-00001', 'CWT-2026-00003']);
    expect((await build()).unrecorded).toEqual([]);
  });

  // distinct made-up words with no repeated neighbour letters (the word key folds repeats): x between letters from a 25-letter alphabet
  const manyWord = (n: number): string => {
    const letters = 'abcdefghijklmnopqrstuvwy';
    let out = 'zorb';
    for (let rest = n + 1000; rest > 0; rest = Math.floor(rest / letters.length)) out += `x${letters[rest % letters.length]}`;
    return out;
  };

  it('says how many rows got no pack-wide positive line when there are more than the kit reads (2 000)', async () => {
    for (let i = 1; i <= 2003; i += 1) await w.term({ id: `CWT-2026-${String(i).padStart(5, '0')}`, term: manyWord(i) });
    const r = await build({ allowBulk: true });
    expect(r.positiveUncovered).toBe(3);
    const small = await build({ allowBulk: true, languages: ['en'] });
    expect(small.positiveUncovered).toBe(3);
  });

  it('is zero when every row has one', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    expect((await build()).positiveUncovered).toBe(0);
  });

  it('a collision is judged the way the loader judges it: the row is off when the other language is installed, so the row is published and its negatives hold', async () => {
    // "quissel" is an ordinary Spanish word here. The English row collides with es, and the equal word is one of its negatives.
    await w.term({ id: 'CWT-2026-00001', term: 'quissel', languages: ['en'] });
    await w.innocent('es', ['quissel'], 20);
    await w.negative('es', ['una frase con quissel']);
    const r = await build();
    expect(r.held).toEqual([]);
    const rel = await read(r);
    expect(rel.terms[0]?.collidesWith).toEqual(['es']);
    expect(rel.terms[0]?.negative).toContain('quissel');
    expect(releaseToPack(rel, { languages: ['en'], minSeverity: 'rude' }).terms[0]?.active).toBe(true);
    expect(releaseToPack(rel, { languages: ['en', 'es'], minSeverity: 'rude' }).terms[0]?.active).toBe(false);
    expect(releaseToPack(rel, { languages: ['es'], minSeverity: 'rude' }).terms).toEqual([]);
  });

  it('a term of two languages that is ordinary in neither is simply on, for Spanish alone too', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', languages: ['en', 'es'] });
    const r = await build();
    expect(r.held).toEqual([]);
    expect(releaseToPack(await read(r), { languages: ['es'], minSeverity: 'rude' }).terms[0]?.active).toBe(true);
  });

  it('a stored collidesWith is kept even when the dictionary does not (yet) say so, and a new collision is added', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', collidesWith: ['pt'] });
    await w.term({ id: 'CWT-2026-00002', term: 'vlemmo' });
    await w.innocent('pt', ['vlemmo'], 10);
    const rel = await read(await build());
    expect(rel.terms.map((t) => t.collidesWith)).toEqual([['pt'], ['pt']]);
  });

  it('a default-off or disputed row is never held for blocking a word: it never blocks', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', defaultActive: false });
    await w.term({ id: 'CWT-2026-00002', term: 'vlemmo', status: 'disputed' });
    await w.negative('en', ['a zorbak', 'a vlemmo']);
    const r = await build();
    expect(r.held).toEqual([]);
    expect((await read(r)).terms).toHaveLength(2);
  });
});

describe('two languages sharing a folded word become one row', () => {
  it('a word listed for en and es is one row with both languages, counted in both', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', languages: ['en', 'es'] });
    const rel = await read(await build());
    expect(rel.terms).toHaveLength(1);
    expect(rel.terms[0]?.languages).toEqual(['en', 'es']);
    expect(rel.manifest.counts.terms).toEqual({ en: 1, es: 1, pt: 0 });
  });

  it('the database cannot hold two rows with one folded word (the unique key)', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', languages: ['en'] });
    await expect(w.term({ id: 'CWT-2026-00002', term: 'Z\u00f3rbak', languages: ['es'] })).rejects.toThrow(/UNIQUE/);
    await expect(w.term({ id: 'CWT-2026-00003', term: 'zorbaaak', languages: ['pt'] })).rejects.toThrow(/UNIQUE/);
  });

  it('dedupeByWordKey merges rows that fold to one word if a snapshot ever holds them: the lowest id wins, languages and lines are united', () => {
    const rec = (over: Partial<TermRecord>): TermRecord => ({
      id: 'CWT-2026-00002', wordKey: 'zorbak', term: 'zorbak', languages: ['en'], category: 'abuse', target: 'none', severity: 'hostile', status: 'accepted', defaultActive: true,
      storedCollidesWith: [], freshCollidesWith: [], since: null, approvals: 1, positiveLines: [], negativeLines: [], dictionary: [], ...over,
    });
    const merged = dedupeByWordKey([
      rec({ id: 'CWT-2026-00007', term: 'z\u00f3rbak', languages: ['es'], approvals: 2, negativeLines: ['b line'], since: '2026.11.0' }),
      rec({ id: 'CWT-2026-00002', languages: ['en'], negativeLines: ['a line'], storedCollidesWith: ['pt'] }),
      rec({ id: 'CWT-2026-00009', wordKey: 'vlemmo', term: 'vlemmo' }),
    ]);
    expect(merged.map((r) => r.id)).toEqual(['CWT-2026-00002', 'CWT-2026-00009']);
    expect(merged[0]).toMatchObject({ languages: ['en', 'es'], negativeLines: ['a line', 'b line'], storedCollidesWith: ['pt'], approvals: 2, since: '2026.11.0' });
  });
});

describe('the 200-term guard', () => {
  const seedMany = async (n: number, since: string | null): Promise<void> => {
    const letters = 'bcdfghjklmnpqrstvwxz';
    for (let i = 0; i < n; i += 1) {
      const word = `zo${letters[i % 20]}${letters[Math.floor(i / 20) % 20]}${letters[Math.floor(i / 400) % 20]}ak`;
      await w.term({ id: `CWT-2026-${String(i + 1).padStart(5, '0')}`, term: word, since });
    }
  };

  it('201 terms new in this release are refused without allowBulk, 200 are not', async () => {
    await seedMany(201, null);
    await expect(build()).rejects.toMatchObject({ code: 'bulk_guard' });
    expect((await read(await build({ allowBulk: true }))).terms).toHaveLength(201);
    await w.db.prepare("UPDATE terms SET since = '2026.11.0' WHERE id = 'CWT-2026-00001'").run();
    expect((await read(await build())).terms).toHaveLength(201);
  });

  it('terms already released do not count, however many there are', async () => {
    await seedMany(260, '2026.11.0');
    expect((await read(await build())).terms).toHaveLength(260);
  });
});

describe('the build is deterministic: the same input twice gives byte-identical files (sorted keys, fixed timestamps from the injected clock)', () => {
  it('two builds are the same bytes, file by file and as a zip, and a later clock changes only the stamps', async () => {
    await seed();
    const a = await build();
    const b = await build();
    expect(Buffer.from(a.zip).equals(Buffer.from(b.zip))).toBe(true);
    expect(a.summary.sha256).toBe(b.summary.sha256);
    expect([...a.files.keys()]).toEqual([...b.files.keys()]);
    for (const [name, bytes] of a.files) expect(Buffer.from(bytes).equals(Buffer.from(b.files.get(name) as Uint8Array)), name).toBe(true);
    w.clock.advance(7200_000);
    const c = await build();
    expect(c.summary.sha256).not.toBe(a.summary.sha256);
    expect(Buffer.from(c.files.get('terms.json') as Uint8Array).equals(Buffer.from(a.files.get('terms.json') as Uint8Array))).toBe(true);
  });

  it('the insertion order of the rows does not matter (rows are sorted by id)', async () => {
    await w.term({ id: 'CWT-2026-00002', term: 'vlemmo' });
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    const a = await build();
    const w2 = await makeBuildWorld();
    await w2.term({ id: 'CWT-2026-00001', term: 'zorbak' });
    await w2.term({ id: 'CWT-2026-00002', term: 'vlemmo' });
    const b = await buildTermsRelease(w2.db, opts({ clock: w2.clock }));
    expect(a.summary.sha256).toBe(b.summary.sha256);
  });
});

describe('no real word is needed: the test corpus is generated', () => {
  it('a release of 300 generated words builds, parses and gates in a stated time', async () => {
    const start = Date.now();
    const syll = ['za', 'vo', 'qui', 'dra', 'fen', 'tar', 'sne', 'gla'];
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const word = `${syll[i % 8]}${syll[Math.floor(i / 8) % 8]}${syll[Math.floor(i / 64) % 8]}x${'abcdefghij'[i % 10]}${'klmnopqrst'[Math.floor(i / 10) % 10]}`;
      expect(seen.has(word)).toBe(false);
      seen.add(word);
      await w.term({ id: `CWT-2026-${String(i + 1).padStart(5, '0')}`, term: word, since: '2026.11.0', languages: [['en'], ['es'], ['pt'], ['en', 'es']][i % 4] as string[] });
    }
    const rel = await read(await build({ allowBulk: true }));
    expect(rel.terms).toHaveLength(300);
    expect(Date.now() - start).toBeLessThan(60_000);
  });
});

describe('version and sequence', () => {
  it('nextVersion is YYYY.MM.0 for a new month and the next patch for the same month; nextSequence follows the highest release', async () => {
    expect(await nextVersion(w.db, w.clock)).toBe('2026.12.0');
    expect(await nextSequence(w.db)).toBe(1);
    await w.release('terms', '2026.12.0', 3);
    await w.release('eval', '2026.12.0', 4);
    await w.release('terms', '2026.11.7', 2);
    expect(await nextVersion(w.db, w.clock)).toBe('2026.12.1');
    expect(await nextSequence(w.db)).toBe(5);
    // each kind has its own versions: the eval set follows its own releases
    expect(await nextVersion(w.db, w.clock, 'eval')).toBe('2026.12.1');
    w.clock.set('2026-11-20T00:00:00Z');
    expect(await nextVersion(w.db, w.clock, 'eval')).toBe('2026.11.0');
    w.clock.set('2026-12-01T09:00:00Z');
    w.clock.set('2027-01-03T00:00:00Z');
    expect(await nextVersion(w.db, w.clock)).toBe('2027.01.0');
  });

  it('refuses a version that is not CalVer, a sequence that is not a positive whole number, and a previous that is not a version', async () => {
    for (const version of ['2026.13.0', '26.12.0', '2026.12', '2026.12.01', 'latest', '']) await expect(build({ version }), version).rejects.toMatchObject({ code: 'bad_options' });
    for (const sequence of [0, -1, 1.5, Number.NaN]) await expect(build({ sequence }), String(sequence)).rejects.toMatchObject({ code: 'bad_options' });
    await expect(build({ previous: 'x' })).rejects.toMatchObject({ code: 'bad_options' });
    await expect(build({ languages: [] })).rejects.toMatchObject({ code: 'bad_options' });
    await expect(build({ languages: ['en', 'xx'] })).rejects.toMatchObject({ code: 'bad_options' });
  });

  it('a row in a language the release does not list is a refusal, not a silent drop', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', languages: ['en', 'es'] });
    await expect(build({ languages: ['en'] })).rejects.toMatchObject({ code: 'bad_row' });
  });
});

describe('errors and logs carry codes, never content', () => {
  it('a BuildError message is fixed and never holds a term, a line or an id from the data', async () => {
    await w.term({ id: 'CWT-2026-00001', term: 'zorbak', since: '2026.11.0' });
    await w.line('CWT-2026-00001', 'negative', 'a zorbak line');
    const err = (await build().catch((e: unknown) => e)) as BuildError;
    expect(err.code).toBe('gate_failed');
    expect(err.message).toBe('a published term fails the gates; dispute or fix it before building');
    expect(JSON.stringify(err.ids)).toBe('["CWT-2026-00001"]');
    expect(err.message + String(err.stack).split('\n')[0]).not.toMatch(/zorbak/);
  });
});
