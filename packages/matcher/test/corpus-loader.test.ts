import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createCorpusLoader, type CorpusLoaderOptions } from '../src/corpus/loader.js';
import { releaseZip, sigFileBytes, sigFileFor, makeKey, termRow } from './corpus-world.js';
import { BASE, MemoryCache, T0, World, fakeClock, newTerms, rig, settle } from './corpus-loader-world.js';

describe('happy path', () => {
  it('first refresh downloads, verifies index then zip, unzips, builds the pack and writes the cache; the second refresh makes one conditional request and no download', async () => {
    const r = await rig();
    const first = await r.loader.refresh();
    expect(first.changed).toBe(true);
    expect(first.status).toMatchObject({ state: 'ready', applied: null, available: '2026.12.0', lastError: null, pending: null, lastCheckedAt: T0 });
    expect(r.loader.release()?.version).toBe('2026.12.0');
    const pack = r.loader.pack();
    expect(pack?.id).toBe('chatwarden-corpus');
    expect(pack?.version).toBe('2026.12.0');
    expect(pack?.terms.filter((t) => t.active).map((t) => t.term)).toEqual(['zorbak', 'vlemmo']);
    // The requests, in order: index, its signature, then the zip and its signature.
    expect(r.w.calls.map((c) => c.url.slice(BASE.length + 1))).toEqual([
      'index.json',
      'index.json.sig',
      'terms/2026.12.0/terms-2026.12.0.zip',
      'terms/2026.12.0/terms-2026.12.0.zip.sig',
    ]);
    // The cache layout of design 8.2, with state.json last.
    expect(r.cache.writes()).toEqual([
      'releases/terms-2026.12.0.zip',
      'releases/terms-2026.12.0.zip.sig',
      'index.json',
      'index.json.sig',
      'state.json',
    ]);
    expect(r.cache.json('state.json')).toMatchObject({ maxSequence: 14, release: '2026.12.0', applied: null, checkedAt: T0 });

    r.w.calls.length = 0;
    const second = await r.loader.refresh();
    expect(second.changed).toBe(false);
    expect(second.status.state).toBe('ready');
    expect(r.w.calls).toHaveLength(1);
    expect(r.w.calls[0]).toMatchObject({ method: 'GET', ifNoneMatch: expect.stringMatching(/^"[0-9a-f]{16}"$/) });
    expect(r.w.calls[0]!.url).toBe(`${BASE}/index.json`);
  });

  it('a new process on the same cache makes the same one conditional request... only after it verified the cached release again', async () => {
    const a = await rig();
    await a.loader.refresh();
    const b = a.make();
    expect(b.pack()).toBeNull(); // nothing is trusted until a refresh has read and verified the disk
    a.w.calls.length = 0;
    const res = await b.refresh();
    expect(res.status.state).toBe('ready');
    expect(b.pack()?.version).toBe('2026.12.0');
    // No ETag is known to a new process, so the index is fetched whole; the zip is not downloaded again.
    expect(a.w.calls.map((c) => c.url.slice(BASE.length + 1))).toEqual(['index.json', 'index.json.sig']);
  });

  it('pin: never moves; fetches its version if the cache lacks it', async () => {
    const r = await rig({ pin: '2026.11.0', follow: undefined }, false);
    await r.w.addRelease('2026.11.0', { sequence: 13, parts: { terms: World.termsWith() } });
    await r.w.addRelease('2026.12.0', { sequence: 14, parts: { terms: World.termsWith(['tarvox']) } });
    await r.w.publishIndex({ latest: { terms: '2026.12.0' } });
    const res = await r.loader.refresh();
    expect(res.status.available).toBe('2026.11.0');
    expect(r.w.callsTo('terms/2026.11.0/terms-2026.11.0.zip')).toHaveLength(1);
    expect(r.w.callsTo('terms/2026.12.0/terms-2026.12.0.zip')).toHaveLength(0);
    // A newer index with a newer latest changes nothing.
    await r.w.addRelease('2027.01.0', { sequence: 16 });
    r.w.sequence = 16;
    await r.w.publishIndex();
    r.w.etags = false;
    const again = await r.loader.refresh();
    expect(again.changed).toBe(false);
    expect(r.loader.pack()?.version).toBe('2026.11.0');
    expect(r.w.callsTo('terms/2027.01.0/terms-2027.01.0.zip')).toHaveLength(0);
    // A pinned release older than the index's sequence is fine: the manifest sequence is only bounded above.
    expect(r.cache.json('state.json')).toMatchObject({ maxSequence: 16, release: '2026.11.0' });
  });

  it('follow: moves to latest after a newer index; apply manual leaves it pending and apply auto syncs', async () => {
    const manual = await rig();
    const t = newTerms();
    const m = manual.make({ terms: t.live });
    const first = await m.refresh();
    expect(first.status).toMatchObject({ state: 'ready', applied: null, available: '2026.12.0' });
    expect(first.status.pending).toEqual({ added: 6, deactivated: 0, reactivated: 0, changed: 0, keptYours: 0, skipped: 0 });
    expect(t.store.state.terms).toHaveLength(0); // manual: nothing written
    const sync = m.applyTo(t.live);
    expect(sync).toMatchObject({ ok: true, version: '2026.12.0' });
    expect(t.store.state.terms.length).toBeGreaterThan(0);
    expect(t.store.state.terms.every((x) => x.addedBy === 'corpus:2026.12.0')).toBe(true);
    expect(m.status()).toMatchObject({ applied: '2026.12.0', available: null, pending: null });

    // A newer release arrives.
    await manual.w.addRelease('2027.01.0', { sequence: 15, parts: { terms: World.termsWith(['tarvox']) } });
    manual.w.sequence = 15;
    await manual.w.publishIndex();
    const next = await m.refresh();
    expect(next.changed).toBe(true);
    expect(next.status).toMatchObject({ applied: '2026.12.0', available: '2027.01.0' });
    expect(next.status.pending).toMatchObject({ added: 1 });
    expect(m.pack()?.version).toBe('2027.01.0');
    expect(t.store.state.terms.some((x) => x.term === 'tarvox')).toBe(false);

    // Auto applies inside refresh().
    const auto = await rig({ apply: 'auto' });
    const t2 = newTerms();
    const a = auto.make({ terms: t2.live });
    const res = await a.refresh();
    expect(res.status).toMatchObject({ state: 'ready', applied: '2026.12.0', available: null, pending: null });
    expect(t2.store.state.audit.every((x) => x.actor === 'corpus:2026.12.0')).toBe(true);
    expect(t2.live.match('you zorbak')).not.toBeNull();
    // A second refresh with nothing new applies nothing again.
    const writes = t2.store.state.audit.length;
    await a.refresh();
    expect(t2.store.state.audit).toHaveLength(writes);
  });

  it('applyTo before anything is verified is null; a refused sync is reported and the version stays unapplied', async () => {
    const r = await rig();
    const t = newTerms();
    expect(r.loader.applyTo(t.live)).toBeNull();
    await r.loader.refresh();
    const before = structuredClone(t.store.state);
    const refuse = { syncPack: () => ({ ok: false as const, code: 'invalid' as const }) };
    expect(r.loader.applyTo(refuse)).toEqual({ ok: false, code: 'invalid' });
    expect(r.loader.status().applied).toBeNull();
    expect(t.store.state).toEqual(before);
    // An explicit actor is passed through.
    const seen: string[] = [];
    r.loader.applyTo({ syncPack: (_p, o) => (seen.push(o.actor), { ok: false as const, code: 'invalid' as const }) }, 'corpus:custom');
    expect(seen).toEqual(['corpus:custom']);
  });

  it('the selection narrows the pack: a status outside `statuses` is left out (not carried inactive), and a later sync never switches a row it added earlier off', async () => {
    const wide = await rig({ select: { languages: ['en', 'es'] } });
    const t = newTerms();
    const a = wide.make({ terms: t.live, apply: 'auto' });
    await a.refresh();
    // drakkuun is a provisional es row (it collides with en, so it is added but inactive): it is in the pack, and so in the store.
    expect(a.pack()?.terms.map((x) => x.term)).toContain('drakkuun');
    expect(t.store.state.terms.some((x) => x.term === 'drakkuun')).toBe(true);
    const before = structuredClone(t.store.state.terms);
    // The adopter now asks for accepted rows only: provisional rows are not in the pack at all.
    const narrow = wide.make({ terms: t.live, apply: 'auto', select: { languages: ['en', 'es'], statuses: ['accepted'] } });
    await narrow.refresh();
    expect(narrow.pack()?.terms.map((x) => x.term)).not.toContain('drakkuun');
    expect(narrow.pack()?.terms.map((x) => x.term)).not.toContain('quissel');
    // Rows added under the wider selection stay exactly as they were: nothing is deleted or switched off for being out of selection.
    expect(t.store.state.terms.filter((x) => before.some((b) => b.id === x.id)).map((x) => [x.id, x.active])).toEqual(before.map((b) => [b.id, b.active]));
  });

  it('start(): ticks on the schedule with jitter, stops on the returned function, and never overlaps two refreshes', async () => {
    const r = await rig();
    const stop = r.loader.start({ everyMs: 1000, random: () => 0 });
    expect(r.schedule.delays).toEqual([900]); // everyMs minus 10 percent
    expect(r.w.calls).toHaveLength(0); // start() does not refresh by itself
    r.schedule.advance(900);
    await vi.waitFor(() => expect(r.loader.status().state).toBe('ready'));
    await vi.waitFor(() => expect(r.schedule.delays).toHaveLength(1)); // rescheduled only after the refresh finished
    expect(r.schedule.delays[0]).toBe(900);

    // jitter range
    stop();
    expect(r.schedule.timers).toHaveLength(0);
    const lo = r.make().start({ everyMs: 1000, random: () => 0 });
    const hi = r.make().start({ everyMs: 1000, random: () => 1 });
    expect(r.schedule.delays.sort((a, b) => a - b)).toEqual([900, 1100]);
    lo();
    hi();
    // the default period is 24 hours, plus or minus 10 percent
    const day = r.make().start({ random: () => 0.5 });
    expect(r.schedule.delays).toEqual([86_400_000]);
    day();

    // A refresh that hangs: the next tick is not scheduled until it ends, so two never overlap.
    const h = await rig();
    h.w.fault('index.json', { kind: 'hang' });
    const stopH = h.loader.start({ everyMs: 1000, random: () => 0.5 });
    h.schedule.advance(1000);
    await vi.waitFor(() => expect(h.schedule.delays).toEqual([10_000])); // only the index timeout is waiting: no second tick
    h.schedule.advance(10_000);
    await vi.waitFor(() => expect(h.loader.status().lastError).toMatchObject({ code: 'timeout', stage: 'index' }));
    expect(h.w.callsTo('index.json')).toHaveLength(1);
    stopH();

    // stop() while a refresh is in flight: no tick is scheduled afterwards.
    const s = await rig();
    s.w.fault('index.json', { kind: 'hang' });
    const stopS = s.loader.start({ everyMs: 1000, random: () => 0.5 });
    s.schedule.advance(1000);
    await vi.waitFor(() => expect(s.schedule.delays).toEqual([10_000]));
    stopS();
    s.schedule.advance(10_000);
    await vi.waitFor(() => expect(s.loader.status().lastError).toMatchObject({ code: 'timeout' }));
    await settle();
    expect(s.schedule.timers).toHaveLength(0);
  });

  it('start() never throws, even with a hostile schedule or a logger that throws, and a stopped loader can be started again', async () => {
    const r = await rig();
    const bad = r.make({ schedule: { after: () => { throw new Error('no timers'); } } });
    expect(() => bad.start()()).not.toThrow();
    const loud = r.make({ logger: { warn: () => { throw new Error('logger down: secret'); } } });
    r.w.fault('index.json', { kind: 'throw' });
    await expect(loud.refresh()).resolves.toMatchObject({ status: { lastError: { code: 'offline' } } });
    const stop = r.loader.start({ everyMs: 1000 });
    stop();
    stop(); // idempotent
    const again = r.loader.start({ everyMs: 1000 });
    expect(r.schedule.timers).toHaveLength(1);
    again();
  });

  it('two refreshes started together share one download', async () => {
    const r = await rig();
    const [a, b, c] = await Promise.all([r.loader.refresh(), r.loader.refresh(), r.loader.refresh()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(r.w.callsTo('index.json')).toHaveLength(1);
    expect(r.w.callsTo('terms/2026.12.0/terms-2026.12.0.zip')).toHaveLength(1);
    // And a refresh after they finished is a new one.
    expect(await r.loader.refresh()).not.toBe(a);
  });

  it('two refreshes with apply auto sync once', async () => {
    const r = await rig({ apply: 'auto' });
    const t = newTerms();
    const l = r.make({ terms: t.live });
    await Promise.all([l.refresh(), l.refresh()]);
    const adds = t.store.state.audit.filter((x) => x.action === 'term.add');
    expect(new Set(adds.map((x) => x.subjectRef)).size).toBe(adds.length);
  });

  it('a hanging fetch times out at the limit (10 s for the index, 60 s for the zip); a throwing fetch is offline', async () => {
    const r = await rig();
    r.w.fault('index.json', { kind: 'hang' });
    const pending = r.loader.refresh();
    await vi.waitFor(() => expect(r.schedule.delays).toEqual([10_000]));
    r.schedule.advance(10_000);
    const res = await pending;
    expect(res.status.lastError).toMatchObject({ code: 'timeout', stage: 'index', at: T0 });
    expect(r.schedule.timers).toHaveLength(0); // the timer of a finished request is cancelled

    r.w.fault('index.json', null);
    r.w.fault('terms/2026.12.0/terms-2026.12.0.zip', { kind: 'hang-until-abort' });
    const second = r.loader.refresh();
    await vi.waitFor(() => expect(r.schedule.delays).toEqual([60_000]));
    r.schedule.advance(60_000);
    expect((await second).status.lastError).toMatchObject({ code: 'timeout', stage: 'download' });

    r.w.fault('terms/2026.12.0/terms-2026.12.0.zip', { kind: 'throw' });
    expect((await r.loader.refresh()).status.lastError).toMatchObject({ code: 'offline', stage: 'download' });
  });

  it('the seed: a verified seed is applied on first start with no network; an unverified seed is ignored with bad_signature and the loader continues', async () => {
    const r = await rig();
    const zip = r.w.files.get('terms/2026.12.0/terms-2026.12.0.zip')!;
    const sig = r.w.files.get('terms/2026.12.0/terms-2026.12.0.zip.sig')!;
    r.w.fault('index.json', { kind: 'throw' });
    const t = newTerms();
    const seeded = r.make({ seed: { zip, sig }, apply: 'auto', terms: t.live });
    const res = await seeded.refresh();
    expect(res.status).toMatchObject({ state: 'offline', applied: '2026.12.0', available: null });
    expect(res.status.lastError).toMatchObject({ code: 'offline' });
    expect(t.live.match('you zorbak')).not.toBeNull();
    expect(seeded.release()?.version).toBe('2026.12.0');

    // A seed signed by a key the kit does not trust, or with a flipped bit, is not used.
    const stranger = await makeKey('k9');
    const strangerSig = sigFileBytes(await sigFileFor(stranger, 'zip', zip));
    const flipped = zip.slice();
    flipped[100] = (flipped[100] as number) ^ 1;
    for (const seed of [{ zip, sig: strangerSig }, { zip: flipped, sig }]) {
      const t2 = newTerms();
      const l = r.make({ seed, apply: 'auto', terms: t2.live });
      const bad = await l.refresh();
      expect(bad.status.state).toBe('failed');
      expect(bad.status.lastError).toMatchObject({ code: expect.stringMatching(/^(bad_signature|unknown_key)$/) });
      expect(l.pack()).toBeNull();
      expect(t2.store.state.terms).toHaveLength(0);
    }
    // ... and with the network back, the loader carries on and downloads the real release.
    r.w.fault('index.json', null);
    const t3 = newTerms();
    const l3 = r.make({ seed: { zip, sig: strangerSig }, apply: 'auto', terms: t3.live });
    const good = await l3.refresh();
    expect(good.status).toMatchObject({ state: 'ready', applied: '2026.12.0', lastError: null });
  });

  it('the index sequence only ever rises in state.json', async () => {
    const r = await rig();
    await r.loader.refresh();
    expect(r.cache.json('state.json').maxSequence).toBe(14);
    await r.w.addRelease('2027.01.0', { sequence: 20 });
    r.w.sequence = 20;
    await r.w.publishIndex();
    await r.loader.refresh();
    expect(r.cache.json('state.json').maxSequence).toBe(20);
    // A replay of the older index is refused and the stored maximum does not move.
    r.w.sequence = 15;
    await r.w.publishIndex();
    r.w.etags = false;
    const res = await r.loader.refresh();
    expect(res.status.lastError).toMatchObject({ code: 'rollback', stage: 'index' });
    expect(r.cache.json('state.json').maxSequence).toBe(20);
    // Equal is accepted (the same index again).
    r.w.sequence = 20;
    await r.w.publishIndex();
    expect((await r.loader.refresh()).status.lastError).toBeNull();
  });

  it('index_expired keeps the applied list and reports stale', async () => {
    const r = await rig({ apply: 'auto' });
    const t = newTerms();
    const l = r.make({ terms: t.live });
    await l.refresh();
    const before = structuredClone(t.store.state);
    r.clock.t = Date.UTC(2027, 2, 2); // after the index's expiresAt of 2027-03-01
    r.w.etags = false;
    const res = await l.refresh();
    expect(res.status).toMatchObject({ state: 'stale', applied: '2026.12.0' });
    expect(res.status.lastError).toMatchObject({ code: 'index_expired', stage: 'index', at: r.clock.t });
    expect(l.pack()?.version).toBe('2026.12.0');
    expect(t.store.state).toEqual(before);
    expect(t.live.match('you zorbak')).not.toBeNull();
  });

  it('the base URL fails and the Zenodo-style mirror serves the same bytes: accepted because the signature verifies; a mirror serving other bytes: hash_mismatch', async () => {
    const mirrorUrl = 'https://zenodo.example.test/records/1/files/terms-2026.12.0.zip?download=1';
    const mirrorSig = 'https://zenodo.example.test/records/1/files/terms-2026.12.0.zip.sig?download=1';
    const r = await rig({}, false);
    const zip = await r.w.addRelease('2026.12.0', { mirrors: [{ kind: 'zenodo', doi: '10.5281/zenodo.0000000', url: mirrorUrl }] });
    await r.w.publishIndex();
    r.w.mirrorFiles.set(mirrorUrl, zip);
    r.w.mirrorFiles.set(mirrorSig, r.w.files.get('terms/2026.12.0/terms-2026.12.0.zip.sig')!);
    r.w.fault('terms/2026.12.0/terms-2026.12.0.zip', { kind: 'throw' });
    r.w.fault('terms/2026.12.0/terms-2026.12.0.zip.sig', { kind: 'status', status: 503 });
    const ok = await r.loader.refresh();
    expect(ok.status).toMatchObject({ state: 'ready', lastError: null, available: '2026.12.0' });

    const bad = await rig({}, false);
    await bad.w.addRelease('2026.12.0', { mirrors: [{ kind: 'zenodo', doi: '10.5281/zenodo.0000000', url: mirrorUrl }] });
    await bad.w.publishIndex();
    const other = releaseZip({ terms: [termRow({ term: 'tarvox' })], manifest: { version: '2026.12.0' } });
    bad.w.mirrorFiles.set(mirrorUrl, other);
    bad.w.fault('terms/2026.12.0/terms-2026.12.0.zip', { kind: 'throw' });
    const res = await bad.loader.refresh();
    expect(res.status).toMatchObject({ state: 'failed', lastError: { code: 'hash_mismatch', stage: 'download' } });
    expect(bad.loader.pack()).toBeNull();
    expect(bad.cache.writes()).toEqual([]);
  });

  it('options.mirrors are tried after the base URL, for the index and for the files', async () => {
    const r = await rig({ mirrors: ['https://mirror.example.test/v1'] });
    for (const [path, bytes] of r.w.files) r.w.mirrorFiles.set(`https://mirror.example.test/v1/${path}`, bytes);
    r.w.fault('index.json', { kind: 'throw' });
    r.w.fault('terms/2026.12.0/terms-2026.12.0.zip', { kind: 'status', status: 500 });
    const res = await r.loader.refresh();
    expect(res.status).toMatchObject({ state: 'ready', lastError: null });
  });

  it('nothing in the loader calls Date.now: the fake clock drives expiry and timestamps', async () => {
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now was called');
    });
    try {
      const r = await rig({ apply: 'auto' });
      const t = newTerms();
      const l = r.make({ terms: t.live });
      expect((await l.refresh()).status.state).toBe('ready');
      r.clock.t += 5_000;
      r.w.etags = false;
      expect((await l.refresh()).status.lastCheckedAt).toBe(T0 + 5_000);
      const stop = l.start({ everyMs: 1000 });
      stop();
    } finally {
      spy.mockRestore();
    }
    const source = readFileSync(new URL('../src/corpus/loader.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Date\.now|new Date\(|performance\.now/);
    // Browser-bundled code must not name the words that trip scripts/browser-bundle.test.ts, nor import node:.
    expect(source).not.toMatch(/\b(process|require)\b/);
    expect(source).not.toMatch(/node:/);
  });

  it('createCorpusLoader refuses a configuration that cannot work, with a RangeError that names the option', () => {
    const base = { select: { languages: ['en'] }, cache: new MemoryCache(), clock: fakeClock() };
    expect(() => createCorpusLoader({ ...base } as unknown as CorpusLoaderOptions)).toThrow(RangeError); // neither pin nor follow
    expect(() => createCorpusLoader({ ...base, pin: '2026.12.0', follow: 'stable' } as unknown as CorpusLoaderOptions)).toThrow(RangeError);
    expect(() => createCorpusLoader({ ...base, follow: 'latest' } as unknown as CorpusLoaderOptions)).toThrow(RangeError);
    expect(() => createCorpusLoader({ ...base, follow: 'stable', cache: null } as unknown as CorpusLoaderOptions)).toThrow(RangeError);
    expect(() => createCorpusLoader({ ...base, follow: 'stable', clock: null } as unknown as CorpusLoaderOptions)).toThrow(RangeError);
    expect(() => createCorpusLoader({ ...base, follow: 'stable', kit: 'next' } as unknown as CorpusLoaderOptions)).toThrow(RangeError);
    expect(() => createCorpusLoader({ ...base, follow: 'stable', apply: 'sometimes' } as unknown as CorpusLoaderOptions)).toThrow(RangeError);
    expect(() => createCorpusLoader({ ...base, follow: 'stable', kind: 'eval' } as unknown as CorpusLoaderOptions)).toThrow(RangeError);
    expect(() => createCorpusLoader({ ...base, follow: 'stable' } as unknown as CorpusLoaderOptions)).not.toThrow();
  });

  it('with no trusted key it says so, makes no request and touches nothing', async () => {
    const r = await rig({ keys: [] });
    const res = await r.loader.refresh();
    expect(res.status).toMatchObject({ state: 'failed', lastError: { code: 'no_trusted_keys', stage: 'verify' } });
    expect(r.w.calls).toHaveLength(0);
    expect(r.cache.log).toEqual([]);
    expect(r.loader.pack()).toBeNull();
    // The kit's own constants have no keys yet either.
    const defaults = createCorpusLoader({ select: { languages: ['en'] }, cache: r.cache, clock: r.clock, follow: 'stable', fetch: r.w.fetch });
    expect((await defaults.refresh()).status.lastError).toMatchObject({ code: 'no_trusted_keys' });
    expect(r.w.calls).toHaveLength(0);
  });
});

