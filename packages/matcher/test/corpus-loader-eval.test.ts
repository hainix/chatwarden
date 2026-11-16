import { describe, expect, it, vi } from 'vitest';
import { createCorpusLoader, type CorpusEvalLoader, type CorpusLoader, type CorpusLoaderOptions } from '../src/corpus/loader.js';
import type { EvalSet } from '../src/corpus/evalset.js';
import { MemoryCache, fakeClock, newTerms, rig, type Rig } from './corpus-loader-world.js';
import { evalRelease, exampleCase, type EvalParts } from './corpus-eval-world.js';
import { sha256HexNode, type Json } from './corpus-world.js';

const ZIP = 'eval/2026.12.0/eval-2026.12.0.zip';

/** Adds an eval release to the rig's world and republishes the index (terms release kept). */
async function publishEval(r: Rig, version = '2026.12.0', parts: EvalParts = {}, sequence = 14): Promise<Uint8Array> {
  const made = await evalRelease(r.w.k1, version, parts, sequence);
  r.w.files.set(made.zipPath, made.zip);
  r.w.files.set(`${made.zipPath}.sig`, made.sig);
  r.w.releases = r.w.releases.filter((e) => !(e.kind === 'eval' && e.version === version));
  r.w.releases.push(made.entry);
  await r.w.publishIndex({ latest: { ...(r.w.latest === null ? {} : { terms: r.w.latest }), eval: version } });
  return made.zip;
}

const evalLoader = (r: Rig, over: Partial<CorpusLoaderOptions> & Record<string, unknown> = {}): CorpusEvalLoader =>
  r.make({ kind: 'eval', ...over }) as unknown as CorpusEvalLoader;

describe("createCorpusLoader({ kind: 'eval' })", () => {
  it('downloads, verifies, reads the set and answers release() with an EvalSet of the selected languages; pack() and applyTo() have nothing', async () => {
    const r = await rig();
    await publishEval(r);
    const loader = evalLoader(r);
    const res = await loader.refresh();
    expect(res.changed).toBe(true);
    expect(res.status).toMatchObject({ state: 'ready', applied: null, available: '2026.12.0', lastError: null, pending: null });
    const set = loader.release() as EvalSet;
    expect(set.version).toBe('2026.12.0');
    expect(set.manifest.kind).toBe('eval');
    expect(Object.keys(set.byLanguage)).toEqual(['en']);
    expect(set.cases).toHaveLength(4);
    expect(set.cases[0]).toEqual(exampleCase());
    // The manifest is whole: what the release holds, not what was selected.
    expect(set.manifest.counts.cases).toEqual({ en: 4, es: 1 });
    expect((loader as unknown as CorpusLoader).pack()).toBeNull();
    expect((loader as unknown as CorpusLoader).applyTo(newTerms().live)).toBeNull();
    // The requests are the eval's own paths; the terms release is never fetched.
    expect(r.w.calls.map((c) => c.url.slice(c.url.indexOf('/v1/') + 4))).toEqual(['index.json', 'index.json.sig', ZIP, `${ZIP}.sig`]);
  });

  it('selects languages: both, none that exist (pt-BR is pt), and a bad selection is a RangeError', async () => {
    const r = await rig();
    await publishEval(r);
    const both = evalLoader(r, { select: { languages: ['es', 'en'] } });
    await both.refresh();
    expect(Object.keys((both.release() as EvalSet).byLanguage).sort()).toEqual(['en', 'es']);
    expect((both.release() as EvalSet).cases.map((c) => c.id)).toEqual(['rude-quissel-1', 'hostile-zorbak-1', 'injection-vlemmo-1', 'banter-glarn-1', 'rude-quissel-es-1']);
    const none = evalLoader(r, { select: { languages: ['pt-BR'] } });
    await none.refresh();
    expect((none.release() as EvalSet).cases).toEqual([]);
    for (const select of [{ languages: [] }, { languages: ['english'] }, {}, null]) {
      expect(() => evalLoader(r, { select: select as never })).toThrow(RangeError);
    }
  });

  it('keeps the cache of an eval set apart from a term list: its own release and state names, and the two work in one folder', async () => {
    const r = await rig();
    await publishEval(r);
    const terms = r.make({ terms: undefined });
    await terms.refresh();
    const evals = evalLoader(r);
    await evals.refresh();
    expect(r.cache.writes()).toContain('releases/terms-2026.12.0.zip');
    expect(r.cache.writes()).toContain('releases/eval-2026.12.0.zip');
    expect(r.cache.writes()).toContain('releases/eval-2026.12.0.zip.sig');
    expect(r.cache.json('state.json')).toMatchObject({ release: '2026.12.0' });
    expect(r.cache.json('state-eval.json')).toMatchObject({ release: '2026.12.0', maxSequence: 14, applied: null });
    expect(terms.release()?.version).toBe('2026.12.0');
    expect((terms.release() as unknown as { terms?: unknown }).terms).toBeDefined();
    expect((evals.release() as EvalSet).cases.length).toBeGreaterThan(0);
  });

  it('a second refresh makes one conditional request; a restart offline reads the verified cache', async () => {
    const r = await rig();
    await publishEval(r);
    const first = evalLoader(r);
    await first.refresh();
    r.w.calls.length = 0;
    const again = await first.refresh();
    expect(again.changed).toBe(false);
    expect(r.w.calls).toHaveLength(1);
    // A new loader on the same cache, with no network: the cached release is verified again and used.
    r.w.fault('index.json', { kind: 'throw' });
    const restarted = evalLoader(r);
    const res = await restarted.refresh();
    expect(res.status).toMatchObject({ state: 'offline', lastError: { code: 'offline', stage: 'index' } });
    expect((restarted.release() as EvalSet).version).toBe('2026.12.0');
  });

  it('a cached release that was tampered with is not used (the disk is untrusted)', async () => {
    const r = await rig();
    await publishEval(r);
    await evalLoader(r).refresh();
    const name = 'releases/eval-2026.12.0.zip';
    const bytes = r.cache.files.get(name) as Uint8Array;
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] as number) ^ 1;
    r.w.fault('index.json', { kind: 'throw' });
    const restarted = evalLoader(r);
    const res = await restarted.refresh();
    expect(restarted.release()).toBeNull();
    expect(res.status.lastError?.code).toBe('bad_signature');
  });

  it('refuses, and keeps nothing: a flipped zip, a wrong signer, a terms release served as eval, a bad case, counts that lie', async () => {
    const cases: [string, (r: Rig) => Promise<void>, string, string][] = [
      ['a flipped zip', async (r) => { await publishEval(r); r.w.fault(ZIP, { kind: 'flip' }); }, 'hash_mismatch', 'download'],
      ['a flipped signature', async (r) => { await publishEval(r); r.w.fault(`${ZIP}.sig`, { kind: 'flip' }); }, 'bad_signature', 'verify'],
      ['a manifest of kind terms', async (r) => { await publishEval(r, '2026.12.0', { manifest: { kind: 'terms' } }); }, 'bad_manifest', 'unpack'],
      ['a case with an unknown key', async (r) => { await publishEval(r, '2026.12.0', { cases: { en: [exampleCase({ surprise: 1 })] } }); }, 'bad_pack', 'validate'],
      ['counts that do not match', async (r) => { await publishEval(r, '2026.12.0', { manifest: { counts: { cases: { en: 9, es: 1 }, groups: {} } } }); }, 'bad_manifest', 'unpack'],
      ['a version the index does not say', async (r) => { await publishEval(r, '2026.12.0', { manifest: { version: '2026.12.1' } }); }, 'bad_manifest', 'unpack'],
    ];
    for (const [name, setup, code, stage] of cases) {
      const r = await rig();
      await setup(r);
      const loader = evalLoader(r);
      const res = await loader.refresh();
      expect({ name, state: res.status.state, code: res.status.lastError?.code, stage: res.status.lastError?.stage }).toEqual({ name, state: 'failed', code, stage });
      expect(loader.release()).toBeNull();
      expect(r.cache.files.has('state-eval.json')).toBe(false);
      expect(r.cache.writes().some((n) => n.startsWith('releases/eval-'))).toBe(false);
      for (const w of r.warn.mock.calls) expect(JSON.stringify(w)).not.toMatch(/quissel|zorbak|surprise/);
    }
  });

  it('a terms zip served under the eval entry is refused, and an eval zip served under a terms entry is refused', async () => {
    const r = await rig();
    await publishEval(r);
    // The eval entry's path now serves the terms zip (hash and signature of the terms zip, so only the content is wrong).
    const termsZip = r.w.files.get('terms/2026.12.0/terms-2026.12.0.zip') as Uint8Array;
    const termsSig = r.w.files.get('terms/2026.12.0/terms-2026.12.0.zip.sig') as Uint8Array;
    r.w.files.set(ZIP, termsZip);
    r.w.files.set(`${ZIP}.sig`, termsSig);
    const entry = r.w.releases.find((e) => e.kind === 'eval') as Json;
    entry.bytes = termsZip.length;
    entry.sha256 = sha256HexNode(termsZip);
    await r.w.publishIndex({ latest: { terms: '2026.12.0', eval: '2026.12.0' } });
    const loader = evalLoader(r);
    const res = await loader.refresh();
    expect(res.status.lastError).toMatchObject({ code: 'bad_manifest', stage: 'unpack' });
    expect(loader.release()).toBeNull();

    const r2 = await rig();
    await publishEval(r2);
    const evalZipBytes = r2.w.files.get(ZIP) as Uint8Array;
    const evalSig = r2.w.files.get(`${ZIP}.sig`) as Uint8Array;
    r2.w.files.set('terms/2026.12.0/terms-2026.12.0.zip', evalZipBytes);
    r2.w.files.set('terms/2026.12.0/terms-2026.12.0.zip.sig', evalSig);
    const termsEntry = r2.w.releases.find((e) => e.kind === 'terms') as Json;
    termsEntry.bytes = evalZipBytes.length;
    termsEntry.sha256 = sha256HexNode(evalZipBytes);
    await r2.w.publishIndex({ latest: { terms: '2026.12.0', eval: '2026.12.0' } });
    const terms = r2.make();
    const res2 = await terms.refresh();
    expect(res2.status.lastError).toMatchObject({ code: 'bad_manifest', stage: 'unpack' });
    expect(terms.pack()).toBeNull();
  });

  it('a release for the other kind in the index is not chosen: no eval release is no_such_version', async () => {
    const r = await rig();
    const loader = evalLoader(r);
    const res = await loader.refresh();
    expect(res.status.state).toBe('failed');
    expect(res.status.lastError?.stage).toBe('index');
    expect(loader.release()).toBeNull();
  });

  it('pin and follow work as for terms; following never goes back, a pin may', async () => {
    const r = await rig();
    await publishEval(r, '2026.12.0', {}, 14);
    await publishEval(r, '2027.01.0', { cases: { en: [exampleCase({ id: 'newer-1' })] } }, 15);
    r.w.sequence = 15;
    await r.w.publishIndex({ latest: { terms: '2026.12.0', eval: '2027.01.0' } });
    const follow = evalLoader(r);
    await follow.refresh();
    expect((follow.release() as EvalSet).version).toBe('2027.01.0');
    const pinned = evalLoader(r, { follow: undefined, pin: '2026.12.0' });
    await pinned.refresh();
    expect((pinned.release() as EvalSet).version).toBe('2026.12.0');
  });

  it('apply: auto never touches a live list for an eval set, and the live list is untouched', async () => {
    const r = await rig();
    await publishEval(r);
    const t = newTerms();
    const sync = vi.spyOn(t.live, 'syncPack');
    const loader = evalLoader(r, { apply: 'auto', terms: t.live });
    const res = await loader.refresh();
    expect(res.status).toMatchObject({ state: 'ready', applied: null, pending: null, lastError: null });
    expect(sync).not.toHaveBeenCalled();
    expect(t.store.state.terms).toHaveLength(0);
  });

  it('a seed is read as an eval set too, and a seed of the other kind is refused', async () => {
    const r = await rig();
    const zip = await publishEval(r);
    const sig = r.w.files.get(`${ZIP}.sig`) as Uint8Array;
    const offline = await rig({}, false);
    offline.w.fault('index.json', { kind: 'throw' });
    const seeded = evalLoader(offline, { seed: { zip, sig }, keys: r.w.keys() });
    const res = await seeded.refresh();
    expect(res.status.state).toBe('offline');
    expect((seeded.release() as EvalSet).version).toBe('2026.12.0');
  });

  it('createCorpusLoader still refuses a kind it does not know', () => {
    const base = { select: { languages: ['en'] }, cache: new MemoryCache(), clock: fakeClock(), follow: 'stable' };
    for (const kind of ['calibration', 5, null]) expect(() => createCorpusLoader({ ...base, kind } as unknown as CorpusLoaderOptions)).toThrow(RangeError);
    expect(() => createCorpusLoader({ ...base, kind: 'eval' } as unknown as CorpusLoaderOptions)).not.toThrow();
    expect(() => createCorpusLoader({ ...base, kind: 'terms' } as unknown as CorpusLoaderOptions)).not.toThrow();
  });
});
