import { describe, expect, it, vi } from 'vitest';
import { MemoryTermStore } from '../src/fixtures/index.js';
import type { CorpusErrorCode, CorpusStage } from '../src/corpus/index.js';
import { exampleTerms, makeKey, sigFileBytes, sigFileFor, termRow, type Json } from './corpus-world.js';
import { World, newTerms, rig, type Rig } from './corpus-loader-world.js';

// One test per row of design 9's failure table. Each asserts (a) status() code and stage, (b) the live list unchanged, (c) the log holds
// { stage, code } only, and a refresh that never throws.

const SECRETS = ['secret-host', 'secret-path', 'zorbak', 'vlemmo', 'tarvox', 'glarn', 'snerp', 'quissel', 'releases.example.test', 'index.json', '.zip'];

/** What the log may hold: one event name and exactly { stage, code }. */
function expectCleanLog(r: Rig, expected?: { stage: CorpusStage; code: CorpusErrorCode }): void {
  for (const call of r.warn.mock.calls) {
    expect(call[0]).toBe('corpus.refresh_failed');
    expect(Object.keys(call[1] as object).sort()).toEqual(['code', 'stage']);
  }
  const text = JSON.stringify(r.warn.mock.calls).toLowerCase();
  for (const s of SECRETS) expect(text, s).not.toContain(s);
  if (expected !== undefined) expect(r.warn).toHaveBeenCalledWith('corpus.refresh_failed', expected);
}

/** A loader with 2026.12.0 applied to a live list; returns what must stay the same through a failed refresh. */
async function applied(over: Record<string, unknown> = {}) {
  const r = await rig({ apply: 'auto', ...over });
  const t = newTerms();
  const loader = r.make({ terms: t.live });
  await loader.refresh();
  expect(loader.status().applied).toBe('2026.12.0');
  r.warn.mockClear();
  r.w.calls.length = 0;
  r.w.etags = false;
  return { r, t, loader, store: structuredClone(t.store.state), blocks: () => ['you zorbak', 'you vlemmo'].map((l) => t.live.match(l) !== null) };
}

async function failsWith(setup: (r: Rig) => Promise<void> | void, code: CorpusErrorCode, stage: CorpusStage, state: 'failed' | 'offline' | 'stale' | 'none' = 'failed') {
  const a = await applied();
  await setup(a.r);
  const res = await a.loader.refresh();
  expect(res.status.state).toBe(state);
  expect(res.status.lastError).toMatchObject({ code, stage });
  expect(res.changed).toBe(false);
  expect(a.t.store.state).toEqual(a.store); // the live list: store, audit and matcher
  expect(a.blocks()).toEqual([true, true]);
  expect(a.loader.pack()?.version).toBe('2026.12.0');
  expect(res.status.applied).toBe('2026.12.0');
  expectCleanLog(a.r, { stage, code });
  return a;
}

describe('the failure table: nothing changes, one { stage, code } log line, a status that says why', () => {
  it('no network, DNS or timeout: offline (a throw, a 5xx, a hang, a response that is not one)', async () => {
    await failsWith((r) => r.w.fault('index.json', { kind: 'throw' }), 'offline', 'index', 'offline');
    await failsWith((r) => r.w.fault('index.json', { kind: 'status', status: 503 }), 'offline', 'index', 'offline');
    await failsWith((r) => r.w.fault('index.json', { kind: 'status', status: 404 }), 'offline', 'index', 'offline');
    const a = await applied();
    const broken = Object.assign(async () => ({ not: 'a response' }) as unknown as Response, {});
    const loader = a.r.make({ terms: a.t.live, fetch: broken });
    const res = await loader.refresh();
    expect(res.status.lastError).toMatchObject({ code: 'offline', stage: 'index' });
    // A timeout on a hanging index.
    const b = await applied();
    b.r.w.fault('index.json', { kind: 'hang' });
    const pending = b.loader.refresh();
    await vi.waitFor(() => expect(b.r.schedule.delays).toEqual([10_000]));
    b.r.schedule.advance(10_000);
    const timed = await pending;
    expect(timed.status).toMatchObject({ state: 'offline', lastError: { code: 'timeout', stage: 'index' } });
    expect(b.t.store.state).toEqual(b.store);
  });

  it('nothing cached, no seed, offline: state none, the adopter\'s own list is all there is', async () => {
    const r = await rig();
    r.w.fault('index.json', { kind: 'throw' });
    const res = await r.loader.refresh();
    expect(res.status).toMatchObject({ state: 'none', applied: null, available: null, pending: null, lastError: { code: 'offline', stage: 'index' } });
    expect(r.loader.pack()).toBeNull();
    expect(r.loader.release()).toBeNull();
    expect(r.cache.writes()).toEqual([]);
    expectCleanLog(r, { stage: 'index', code: 'offline' });
  });

  it('index signature bad, unknown or revoked key: refused', async () => {
    // A flipped signature, a signature file that is not one, an index signed by a stranger, and bytes that changed after signing.
    await failsWith((r) => r.w.fault('index.json.sig', { kind: 'flip' }), 'bad_signature', 'verify');
    await failsWith((r) => r.w.fault('index.json.sig', { kind: 'bytes', bytes: new TextEncoder().encode('{}') }), 'bad_signature', 'verify');
    await failsWith((r) => r.w.fault('index.json', { kind: 'flip' }), 'bad_signature', 'verify');
    await failsWith(async (r) => {
      const stranger = await makeKey('k9');
      await r.w.publishIndex({}, stranger);
    }, 'unknown_key', 'verify');
    // A key an earlier index revoked stays revoked: the loader remembers it, so a later index signed by it is refused at once.
    const a = await applied();
    const saved = a.r.cache.json('state.json');
    a.r.cache.files.set('state.json', new TextEncoder().encode(JSON.stringify({ ...saved, revokedKeyIds: ['k1'] })));
    a.r.w.sequence = 15;
    await a.r.w.publishIndex();
    const restarted = a.r.make({ terms: a.t.live });
    const res = await restarted.refresh();
    expect(res.status).toMatchObject({ state: 'failed', lastError: { code: 'revoked_key', stage: 'verify' } });
    expect(a.t.store.state).toEqual(a.store);
    expectCleanLog(a.r, { stage: 'verify', code: 'revoked_key' });
  });

  it('a hostile download is bounded: an index over 256 KiB or a zip over its size is too_large', async () => {
    await failsWith((r) => r.w.fault('index.json', { kind: 'oversize', bytes: 300 * 1024 }), 'too_large', 'index');
    const a = await applied();
    await a.r.w.addRelease('2027.01.0', { sequence: 15 });
    a.r.w.sequence = 15;
    await a.r.w.publishIndex();
    a.r.w.fault('terms/2027.01.0/terms-2027.01.0.zip', { kind: 'oversize', bytes: 100 * 1024 * 1024 });
    const res = await a.loader.refresh();
    expect(res.status.lastError).toMatchObject({ code: 'too_large', stage: 'download' });
    expect(a.t.store.state).toEqual(a.store);
    expect(a.r.cache.json('state.json').release).toBe('2026.12.0');
  });

  it('index sequence lower than seen: rollback (the replayed index of an older month)', async () => {
    await failsWith(async (r) => {
      r.w.sequence = 9;
      await r.w.publishIndex();
    }, 'rollback', 'index');
  });

  it('index expired: stale, the applied list keeps working', async () => {
    const a = await applied();
    a.r.clock.t = Date.UTC(2027, 5, 1);
    const res = await a.loader.refresh();
    expect(res.status).toMatchObject({ state: 'stale', applied: '2026.12.0', lastError: { code: 'index_expired', stage: 'index' } });
    expect(a.t.store.state).toEqual(a.store);
    expect(a.blocks()).toEqual([true, true]);
    expectCleanLog(a.r, { stage: 'index', code: 'index_expired' });
  });

  it('the index claims a key id other than the key that signed it: refused', async () => {
    await failsWith(async (r) => {
      r.w.sequence = 15;
      // signed by k1, but the index says k2 signed it
      await r.w.publishIndex({ keyId: 'k2' }, r.w.k1);
    }, 'bad_signature', 'verify');
  });

  it('pinned version not on the index, revoked, or needing a newer kit: refused', async () => {
    const missing = await rig({ pin: '2026.10.0', follow: undefined });
    const res = await missing.loader.refresh();
    expect(res.status).toMatchObject({ state: 'failed', lastError: { code: 'no_such_version', stage: 'index' } });
    expectCleanLog(missing, { stage: 'index', code: 'no_such_version' });

    const revoked = await rig({ pin: '2026.11.0', follow: undefined }, false);
    await revoked.w.addRelease('2026.11.0', { sequence: 13 });
    await revoked.w.addRelease('2026.12.0', { sequence: 14 });
    revoked.w.revokedReleases = [{ kind: 'terms', version: '2026.11.0', reason: 'bad_release' }];
    await revoked.w.publishIndex({ latest: { terms: '2026.12.0' } });
    expect((await revoked.loader.refresh()).status).toMatchObject({ state: 'failed', lastError: { code: 'revoked_release', stage: 'index' } });
    expect(revoked.loader.pack()).toBeNull();
    expect(revoked.w.callsTo('terms/2026.11.0/terms-2026.11.0.zip')).toHaveLength(0);

    const old = await rig({ kit: '0.1.6' });
    expect((await old.loader.refresh()).status).toMatchObject({ state: 'failed', lastError: { code: 'kit_too_old', stage: 'index' } });
    expect(old.w.callsTo('terms/2026.12.0/terms-2026.12.0.zip')).toHaveLength(0);
  });

  it('a release that is revoked after it was loaded is dropped from pack(): it can no longer be applied', async () => {
    const r = await rig();
    const t = newTerms();
    const l = r.make({ terms: t.live });
    await l.refresh();
    expect(l.pack()).not.toBeNull();
    r.w.sequence = 15;
    r.w.revokedReleases = [{ kind: 'terms', version: '2026.12.0', reason: 'bad_release' }];
    await r.w.publishIndex();
    const res = await l.refresh();
    expect(res.status.lastError).toMatchObject({ code: 'revoked_release' });
    expect(l.pack()).toBeNull();
    expect(l.release()).toBeNull();
    expect(l.applyTo(t.live)).toBeNull();
    expect(t.store.state.terms).toHaveLength(0);
  });

  it('download hash differs from the index: refused (a flipped bit, a truncated body, another release\'s bytes)', async () => {
    for (const fault of [{ kind: 'flip' }, { kind: 'truncate' }, { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) }] as const) {
      const a = await applied();
      await a.r.w.addRelease('2027.01.0', { sequence: 15 });
      a.r.w.sequence = 15;
      await a.r.w.publishIndex();
      a.r.w.fault('terms/2027.01.0/terms-2027.01.0.zip', fault);
      const res = await a.loader.refresh();
      expect(res.status).toMatchObject({ state: 'failed', applied: '2026.12.0', lastError: { code: 'hash_mismatch', stage: 'download' } });
      expect(a.t.store.state).toEqual(a.store);
      expect(a.loader.pack()?.version).toBe('2026.12.0');
      expect(a.r.cache.writes().some((w) => w.includes('2027.01.0'))).toBe(false); // an unverified file never reaches the cache
      expectCleanLog(a.r, { stage: 'download', code: 'hash_mismatch' });
    }
  });

  it('zip signature bad: a signature by an unknown key, a flipped signature, a signature over other bytes', async () => {
    const cases: [string, (r: Rig) => Promise<void> | void][] = [
      ['unknown_key', async (r) => {
        const stranger = await makeKey('k9');
        const zip = r.w.files.get('terms/2027.01.0/terms-2027.01.0.zip')!;
        r.w.files.set('terms/2027.01.0/terms-2027.01.0.zip.sig', sigFileBytes(await sigFileFor(stranger, 'zip', zip)));
      }],
      ['bad_signature', (r) => r.w.fault('terms/2027.01.0/terms-2027.01.0.zip.sig', { kind: 'flip' })],
      ['bad_signature', async (r) => {
        const other = r.w.files.get('terms/2026.12.0/terms-2026.12.0.zip')!;
        r.w.files.set('terms/2027.01.0/terms-2027.01.0.zip.sig', sigFileBytes(await sigFileFor(r.w.k1, 'zip', other)));
      }],
      ['bad_signature', async (r) => {
        // signed as an index, not as a zip: domain separation
        const zip = r.w.files.get('terms/2027.01.0/terms-2027.01.0.zip')!;
        r.w.files.set('terms/2027.01.0/terms-2027.01.0.zip.sig', sigFileBytes(await sigFileFor(r.w.k1, 'index', zip)));
      }],
    ];
    for (const [code, setup] of cases) {
      const a = await applied();
      await a.r.w.addRelease('2027.01.0', { sequence: 15 });
      a.r.w.sequence = 15;
      await a.r.w.publishIndex();
      await setup(a.r);
      const res = await a.loader.refresh();
      expect(res.status, code).toMatchObject({ state: 'failed', applied: '2026.12.0', lastError: { code, stage: 'verify' } });
      expect(a.t.store.state).toEqual(a.store);
      expect(a.r.cache.writes().some((w) => w.includes('2027.01.0'))).toBe(false);
      expectCleanLog(a.r, { stage: 'verify', code: code as CorpusErrorCode });
    }
  });

  it('a release signed by a key the index revoked is refused (the index verified under another key)', async () => {
    const control = await rig({}, false);
    await control.w.addRelease('2026.12.0', { key: control.w.k2 });
    await control.w.publishIndex(); // signed by k1, release by k2, nothing revoked
    expect((await control.loader.refresh()).status).toMatchObject({ state: 'ready', lastError: null });

    const r = await rig({}, false);
    await r.w.addRelease('2026.12.0', { key: r.w.k2 });
    r.w.revokedKeyIds = ['k2'];
    await r.w.publishIndex();
    const res = await r.loader.refresh();
    expect(res.status).toMatchObject({ state: 'failed', lastError: { code: 'revoked_key', stage: 'verify' } });
    expect(r.loader.pack()).toBeNull();
    // Only the ratchet (the revoked key the verified index named) is recorded; no release is cached or named.
    expect(r.cache.writes()).toEqual(['state.json']);
    expect(r.cache.json('state.json')).toMatchObject({ release: null, revokedKeyIds: ['k2'] });
    expectCleanLog(r, { stage: 'verify', code: 'revoked_key' });

    // An index cannot revoke the key that signed it (it would lock every kit out of the fix): that revocation is ignored.
    const self = await rig({}, false);
    await self.w.addRelease('2026.12.0');
    self.w.revokedKeyIds = ['k1'];
    await self.w.publishIndex();
    expect((await self.loader.refresh()).status).toMatchObject({ state: 'ready' });
    // ... but the next index, signed by the other key, revokes it: a release k1 signed is no longer trusted (it is dropped, not applied
    // later), and the re-release under k2 is what the loader moves to.
    self.w.sequence = 15;
    await self.w.publishIndex({}, self.w.k2);
    self.w.etags = false;
    const dropped = await self.loader.refresh();
    expect(dropped.status.lastError).toMatchObject({ code: 'revoked_key', stage: 'verify' });
    expect(self.loader.pack()).toBeNull();
    await self.w.addRelease('2027.01.0', { sequence: 15, key: self.w.k2 });
    await self.w.publishIndex({}, self.w.k2);
    const healed = await self.loader.refresh();
    expect(healed.status).toMatchObject({ state: 'ready', lastError: null, available: '2027.01.0' });
    self.w.sequence = 16;
    await self.w.publishIndex({ revokedKeyIds: [] }, self.w.k1);
    expect((await self.loader.refresh()).status.lastError).toMatchObject({ code: 'revoked_key', stage: 'verify' });
  });

  it('the index\'s sequence is the bound on the release\'s own: a manifest above it is refused, one below it is fine', async () => {
    const above = await rig({}, false);
    await above.w.addRelease('2026.12.0', { sequence: 15 }); // the index below says 14
    await above.w.publishIndex({ sequence: 14 });
    expect((await above.loader.refresh()).status).toMatchObject({ state: 'failed', lastError: { code: 'bad_manifest', stage: 'unpack' } });
    expect(above.loader.pack()).toBeNull();
    const below = await rig({}, false);
    await below.w.addRelease('2026.12.0', { sequence: 3 });
    await below.w.publishIndex({ sequence: 14 });
    expect((await below.loader.refresh()).status.state).toBe('ready');
  });

  it('a downgrade is refused when following, and allowed when pinned', async () => {
    const r = await rig();
    await r.loader.refresh();
    // The index now says the latest is an older release (a rollback of the list, not of the index).
    await r.w.addRelease('2026.11.0', { sequence: 13 });
    r.w.latest = '2026.11.0';
    r.w.sequence = 15;
    await r.w.publishIndex();
    const res = await r.loader.refresh();
    expect(res.status).toMatchObject({ state: 'failed', lastError: { code: 'rollback', stage: 'index' } });
    expect(r.loader.pack()?.version).toBe('2026.12.0');
    expect(r.w.callsTo('terms/2026.11.0/terms-2026.11.0.zip')).toHaveLength(0);
    // A pin names the version outright: going back is the adopter's choice.
    const pinned = r.make({ pin: '2026.11.0', follow: undefined });
    await pinned.refresh();
    expect(pinned.pack()?.version).toBe('2026.11.0');
    // And a follower whose latest release has a lower manifest sequence than the loaded one is refused after the download.
    const seq = await rig({}, false);
    await seq.w.addRelease('2026.12.0', { sequence: 14 });
    await seq.w.publishIndex();
    await seq.loader.refresh();
    await seq.w.addRelease('2027.01.0', { sequence: 9 }); // a newer version with an older build sequence
    seq.w.sequence = 15;
    await seq.w.publishIndex();
    seq.w.etags = false;
    expect((await seq.loader.refresh()).status.lastError).toMatchObject({ code: 'rollback' });
    expect(seq.loader.pack()?.version).toBe('2026.12.0');
  });

  it('zip malformed, over a limit, a bad manifest or a bad hash inside: refused at unpack', async () => {
    const junk = new Uint8Array(500).fill(7);
    const cases: [string, Parameters<World['addRelease']>[1], CorpusErrorCode][] = [
      ['junk bytes (signed, hash right)', { zipBytes: junk }, 'bad_zip'],
      ['an entry hash that does not match', { parts: { tamper: { 'terms.json': (b: Uint8Array) => b.slice(0, b.length - 1) } } }, 'bad_manifest'],
      ['a manifest for another version', { parts: { manifest: { version: '2026.12.1' } } }, 'bad_manifest'],
      ['a manifest whose counts disagree with the rows', { parts: { manifest: { counts: { terms: { en: 99, es: 2, pt: 2 }, exceptions: { en: 2, es: 0, pt: 1 }, status: { accepted: 4, provisional: 2, disputed: 1, withdrawn: 1 } } } } }, 'bad_manifest'],
      ['an entry that is not listed', { parts: { unlisted: { 'extra.json': '{}' } } }, 'bad_manifest'],
    ];
    for (const [label, spec, code] of cases) {
      const a = await applied();
      await a.r.w.addRelease('2027.01.0', { sequence: 15, ...spec });
      a.r.w.sequence = 15;
      await a.r.w.publishIndex();
      const res = await a.loader.refresh();
      expect(res.status, label).toMatchObject({ state: 'failed', applied: '2026.12.0', lastError: { code, stage: 'unpack' } });
      expect(a.t.store.state, label).toEqual(a.store);
      expect(a.r.cache.writes().some((w) => w.includes('2027.01.0')), label).toBe(false);
      expectCleanLog(a.r, { stage: 'unpack', code });
    }
  });

  it('rows that fail loadTermPack or the row format: refused as bad_pack at validate', async () => {
    const bad: Json[][] = [
      [...exampleTerms(), termRow({ id: 'CWT-2026-00050', term: 'zorbak' })], // the same word as another row
      [termRow({ term: '\uff5aorbak' })], // a look-alike spelling
      [termRow({ term: 'ab' })], // too short
      [{ id: 'CWT-2026-00001' }],
    ];
    for (const terms of bad) {
      const a = await applied();
      await a.r.w.addRelease('2027.01.0', { sequence: 15, parts: { terms } });
      a.r.w.sequence = 15;
      await a.r.w.publishIndex();
      const res = await a.loader.refresh();
      expect(res.status).toMatchObject({ state: 'failed', lastError: { code: expect.stringMatching(/^(bad_pack|bad_manifest)$/), stage: expect.stringMatching(/^(validate|unpack)$/) } });
      expect(a.t.store.state).toEqual(a.store);
      expect(a.loader.pack()?.version).toBe('2026.12.0');
      expectCleanLog(a.r);
    }
  });

  it('syncPack refuses (no active term would remain, or the store fails): do not apply, failed bad_pack, the version stays available', async () => {
    // A release whose every English row is withdrawn: the pack loads, but a list with no active term is refused by the sync.
    const withdrawn = await rig({}, false);
    await withdrawn.w.addRelease('2026.12.0', { parts: { terms: [termRow({ status: 'withdrawn' }), termRow({ id: 'CWT-2026-00002', term: 'vlemmo', status: 'disputed' })] } });
    await withdrawn.w.publishIndex();
    const t = newTerms();
    const seeded = await t.live.change('moderator', (e) => e.addTerm({ term: 'snerp', language: 'en' }));
    expect(seeded.ok).toBe(true);
    // The adopter's own term keeps a list alive, so use an empty live list to see the refusal.
    const empty = newTerms();
    const auto = withdrawn.make({ apply: 'auto', terms: empty.live });
    const res = await auto.refresh();
    expect(res.status).toMatchObject({ state: 'failed', applied: null, available: '2026.12.0', lastError: { code: 'bad_pack', stage: 'validate' } });
    expect(empty.store.state.terms).toHaveLength(0);
    expect(empty.store.state.audit).toHaveLength(0);
    expectCleanLog(withdrawn, { stage: 'validate', code: 'bad_pack' });

    // The store throws halfway through the sync: rolled back, same status.
    const a = await rig({ apply: 'auto' });
    const flaky = newTerms();
    let n = 0;
    flaky.store.fail = (m) => {
      if (m === 'insertTerm' && (n += 1) === 2) throw new Error('disk gone: secret-path');
    };
    const l = a.make({ terms: flaky.live });
    const bad = await l.refresh();
    expect(bad.status).toMatchObject({ state: 'failed', applied: null, available: '2026.12.0', lastError: { code: 'bad_pack', stage: 'validate' } });
    expect(flaky.store.state.terms).toHaveLength(0);
    expectCleanLog(a, { stage: 'validate', code: 'bad_pack' });
    // The store recovers: the next refresh applies the same, already verified, release without downloading it again.
    flaky.store.fail = () => {};
    a.w.calls.length = 0;
    a.w.etags = false;
    const good = await l.refresh();
    expect(good.status).toMatchObject({ state: 'ready', applied: '2026.12.0', lastError: null });
    expect(a.w.callsTo('terms/2026.12.0/terms-2026.12.0.zip')).toHaveLength(0);
  });

  it('manual apply with a pack the sync would refuse: failed bad_pack at validate, available kept, pending empty', async () => {
    const r = await rig({}, false);
    await r.w.addRelease('2026.12.0', { parts: { terms: [termRow({ status: 'withdrawn' })] } });
    await r.w.publishIndex();
    const t = newTerms();
    const res = await r.make({ terms: t.live }).refresh();
    expect(res.status).toMatchObject({ state: 'failed', available: '2026.12.0', pending: null, lastError: { code: 'bad_pack', stage: 'validate' } });
    expect(t.store.state.terms).toHaveLength(0);
  });
});

describe('the cache is untrusted, and failing to write it never changes the list in use', () => {
  it('a tampered cached zip, a tampered cached sig and a cached state.json from a newer sequence are handled: re-download or rollback refusal', async () => {
    const files = ['releases/terms-2026.12.0.zip', 'releases/terms-2026.12.0.zip.sig'];
    for (const name of files) {
      const first = await rig();
      await first.loader.refresh();
      const good = first.cache.files.get(name)!.slice();
      const bad = good.slice();
      bad[Math.floor(bad.length / 2)] = (bad[Math.floor(bad.length / 2)] as number) ^ 0x10;
      first.cache.files.set(name, bad);
      // Offline: the tampered file is not trusted; the status says why and there is no pack.
      const off = first.make();
      first.w.fault('index.json', { kind: 'throw' });
      const down = await off.refresh();
      expect(down.status).toMatchObject({ state: 'failed', lastError: { code: 'bad_signature', stage: 'verify' } });
      expect(off.pack()).toBeNull();
      expectCleanLog(first);
      // Online: it is a cache miss; the release is downloaded again, verified, and the cache is repaired.
      first.w.fault('index.json', null);
      first.w.calls.length = 0;
      const on = first.make();
      const up = await on.refresh();
      expect(up.status).toMatchObject({ state: 'ready', lastError: null });
      expect(first.w.callsTo('terms/2026.12.0/terms-2026.12.0.zip')).toHaveLength(1);
      expect(first.cache.files.get(name)).toEqual(good);
    }
    // A cached zip replaced by another valid archive nobody signed.
    const swap = await rig();
    await swap.loader.refresh();
    swap.cache.files.set('releases/terms-2026.12.0.zip', swap.w.files.get('terms/2026.12.0/terms-2026.12.0.zip')!.slice(0, 200));
    const res = await swap.make().refresh();
    expect(res.status.state).toBe('ready'); // re-downloaded
    expect(swap.w.callsTo('terms/2026.12.0/terms-2026.12.0.zip')).toHaveLength(2);

    // A state.json that claims a newer sequence than the index: the real index is a rollback, refused (and the verified cached list stays in use).
    const newer = await rig();
    await newer.loader.refresh();
    const state = newer.cache.json('state.json');
    newer.cache.files.set('state.json', new TextEncoder().encode(JSON.stringify({ ...state, maxSequence: 99 })));
    const fresh = newer.make();
    const refused = await fresh.refresh();
    expect(refused.status.lastError).toMatchObject({ code: 'rollback', stage: 'index' });
    expect(fresh.pack()?.version).toBe('2026.12.0');
    expect(newer.cache.json('state.json').maxSequence).toBe(99);
  });

  it('a state.json that is garbage is ignored: not JSON, a list, wrong types, a huge sequence is just a rollback', async () => {
    for (const junk of ['not json', '[]', '{"maxSequence":"x","release":5,"applied":{},"revokedKeyIds":"k1"}', '{"maxSequence":-1,"release":"../etc","revokedKeyIds":[1,2]}', '']) {
      const a = await rig();
      await a.loader.refresh();
      a.cache.files.set('state.json', new TextEncoder().encode(junk));
      const b = a.make();
      const res = await b.refresh();
      expect(res.status, junk).toMatchObject({ state: 'ready', lastError: null });
      expect(b.pack()?.version).toBe('2026.12.0');
    }
  });

  it('an interrupted cache write (fail after the zip, before state.json) leaves the previous release in use', async () => {
    const r = await rig();
    await r.loader.refresh();
    const t = newTerms();
    const l = r.make({ apply: 'auto', terms: t.live });
    await l.refresh(); // 2026.12.0 from the cache, applied
    await r.w.addRelease('2027.01.0', { sequence: 15, parts: { terms: World.termsWith(['tarvox']) } });
    r.w.sequence = 15;
    await r.w.publishIndex();
    r.w.etags = false;
    r.cache.fail = (op, name) => op === 'write' && name === 'state.json';
    const res = await l.refresh();
    expect(res.status).toMatchObject({ state: 'failed', applied: '2026.12.0', lastError: { code: 'cache_failed', stage: 'cache' } });
    expect(l.pack()?.version).toBe('2026.12.0');
    expect(res.changed).toBe(false);
    expect(t.store.state.terms.some((x) => x.term === 'tarvox')).toBe(false);
    expectCleanLog(r, { stage: 'cache', code: 'cache_failed' });
    // The zip and its signature did reach the disk, but state.json still points at the old release: a new process uses that one.
    expect(r.cache.files.has('releases/terms-2027.01.0.zip')).toBe(true);
    expect(r.cache.json('state.json').release).toBe('2026.12.0');
    r.cache.fail = () => false;
    r.w.fault('index.json', { kind: 'throw' });
    const restarted = r.make();
    const off = await restarted.refresh();
    expect(off.status.state).toBe('offline');
    expect(restarted.pack()?.version).toBe('2026.12.0');
  });

  it('every write position can fail: the first refresh adopts nothing, and an offline restart finds either the old release or none', async () => {
    for (let nth = 1; nth <= 5; nth += 1) {
      const r = await rig();
      r.cache.fail = (op, _name, n) => op === 'write' && n === nth;
      const res = await r.loader.refresh();
      expect(res.status, `write ${nth}`).toMatchObject({ state: 'failed', lastError: { code: 'cache_failed', stage: 'cache' } });
      expect(r.loader.pack(), `write ${nth}`).toBeNull();
      expect(res.status.applied).toBeNull();
      r.cache.fail = () => false;
      r.w.fault('index.json', { kind: 'throw' });
      const off = r.make();
      await off.refresh();
      // state.json is the last write, so a failure before it means no release is committed; the cache holds no way to use a half-written one.
      expect(off.pack(), `restart after write ${nth}`).toBeNull();
      expectCleanLog(r);
    }
  });

  it('a cache that throws on read, or whose bytes are the wrong type, is a miss and nothing more', async () => {
    const r = await rig();
    r.cache.fail = (op) => op === 'read';
    const res = await r.loader.refresh();
    expect(res.status).toMatchObject({ state: 'ready', lastError: null });
    const weird = r.make({ cache: { read: async () => 'text' as unknown as Uint8Array, write: async () => {}, remove: async () => {} } });
    expect((await weird.refresh()).status.state).toBe('ready');
    const nullish = r.make({ cache: { read: () => { throw new Error('sync throw'); }, write: async () => { throw new Error('read only'); }, remove: async () => {} } });
    const out = await nullish.refresh();
    expect(out.status).toMatchObject({ state: 'failed', lastError: { code: 'cache_failed', stage: 'cache' } });
  });

  it('refresh() never rejects, whatever the world does', async () => {
    const r = await rig();
    const hostile: [string, Parameters<World['fault']>[1]][] = [
      ['index.json', { kind: 'fn', fn: () => new Uint8Array(0) }],
      ['index.json', { kind: 'fn', fn: () => new TextEncoder().encode('{"schema":') }],
      ['index.json.sig', { kind: 'fn', fn: () => new Uint8Array(5000) }],
      ['terms/2026.12.0/terms-2026.12.0.zip', { kind: 'fn', fn: () => new Uint8Array(0) }],
      ['terms/2026.12.0/terms-2026.12.0.zip.sig', { kind: 'truncate' }],
    ];
    for (const [path, fault] of hostile) {
      r.w.fault(path, fault);
      await expect(r.make().refresh()).resolves.toBeDefined();
      r.w.fault(path, null);
    }
    const store = new MemoryTermStore();
    expect(store.state.terms).toHaveLength(0);
  });
});
