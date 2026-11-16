import { describe, expect, it, vi } from 'vitest';
import { LiveTerms } from '../src/index.js';
import { MemoryTermStore } from '../src/fixtures/index.js';
import { T0, rig, type Rig } from './corpus-loader-world.js';

// Review A2 I1: after a restart the loader believes the release is applied (state.json), but a new LiveTerms still holds the app's own
// pack. The shared pack must be handed over once per process, whatever state.json says, or the canary and check() go back to the
// adopter's own pack (and a store that did not survive the restart stays empty).

const liveOn = async (store: MemoryTermStore): Promise<LiveTerms> => {
  const live = new LiveTerms({ store, pack: null, clock: { now: () => T0 }, logger: { warn: () => {} } });
  await live.load();
  return live;
};

/** The first process: refresh with apply auto on `store`, so state.json says the release is applied. */
async function firstProcess(r: Rig, store: MemoryTermStore): Promise<void> {
  const live = await liveOn(store);
  const res = await r.make({ terms: live, apply: 'auto' }).refresh();
  expect(res.status).toMatchObject({ applied: '2026.12.0', lastError: null });
  expect(r.cache.json('state.json')).toMatchObject({ applied: '2026.12.0' });
}

/** An exception that would unblock a line the shared pack says must keep blocking: refused only while that pack is the live one. */
const tryUnblock = (live: LiveTerms) => live.changeSync('alice', (e) => e.addException({ phrase: 'you zorbak', language: 'en' }));

describe('a restart hands the shared pack to the live list again (apply stays what state.json says)', () => {
  for (const apply of ['auto', 'manual'] as const) {
    for (const online of [true, false]) {
      it(`apply ${apply}, ${online ? 'online' : 'offline'}: a store that survived the restart gets the pack back, so the canary refuses an exception that would unblock a corpus line`, async () => {
        const r = await rig();
        const store = new MemoryTermStore();
        await firstProcess(r, store);
        const persisted = structuredClone(store.state);
        const rowsBefore = structuredClone(persisted.terms);

        // Control: a restarted LiveTerms with no pack of its own does not know the line must keep blocking.
        expect(tryUnblock(await liveOn(store)).ok).toBe(true);
        // Restart: a new LiveTerms on a store that kept the rows, and a new loader on the same cache.
        const store2 = new MemoryTermStore();
        store2.state.terms.push(...structuredClone(persisted.terms));
        store2.state.exceptions.push(...structuredClone(persisted.exceptions));
        const live2 = await liveOn(store2);
        if (!online) r.w.fault('index.json', { kind: 'throw' });
        const loader = r.make({ terms: live2, apply });
        const res = await loader.refresh();
        expect(res.status.applied).toBe('2026.12.0');
        expect(res.status.pending).toBeNull();
        expect(tryUnblock(live2)).toMatchObject({ ok: false, code: 'unblocks_known' });
        // Idempotent: the same release writes nothing to the rows and adds no audit rows.
        expect(store2.state.terms).toEqual(rowsBefore);
        expect(store2.state.audit).toHaveLength(0);
      });

      it(`apply ${apply}, ${online ? 'online' : 'offline'}: a store that did not survive (memory) is filled again`, async () => {
        const r = await rig();
        await firstProcess(r, new MemoryTermStore());
        const empty = new MemoryTermStore();
        const live = await liveOn(empty);
        if (!online) r.w.fault('index.json', { kind: 'throw' });
        const res = await r.make({ terms: live, apply }).refresh();
        expect(res.status.applied).toBe('2026.12.0');
        expect(empty.state.terms.length).toBeGreaterThan(0);
        expect(empty.state.terms.every((t) => t.addedBy === 'corpus:2026.12.0')).toBe(true);
        expect(live.match('you zorbak')).not.toBeNull();
      });
    }
  }

  it('it happens once per process: a second refresh does not sync again, and a refused first sync is retried', async () => {
    const r = await rig();
    await firstProcess(r, new MemoryTermStore());
    const live = await liveOn(new MemoryTermStore());
    const spy = vi.spyOn(live, 'syncPack');
    const loader = r.make({ terms: live, apply: 'manual' });
    await loader.refresh();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ actor: 'corpus:2026.12.0' });
    expect(spy.mock.calls[0]?.[1]?.dryRun).not.toBe(true);
    await loader.refresh();
    await loader.refresh();
    expect(spy).toHaveBeenCalledTimes(1);

    // A refusal (the store was not loaded yet) is a failure now and is tried again on the next refresh.
    const later = await rig();
    await firstProcess(later, new MemoryTermStore());
    const unloaded = new LiveTerms({ store: new MemoryTermStore(), pack: null, clock: { now: () => T0 }, logger: { warn: () => {} } });
    const refusing = vi.spyOn(unloaded, 'syncPack').mockReturnValueOnce({ ok: false, code: 'not_loaded' });
    const l2 = later.make({ terms: unloaded, apply: 'manual' });
    const first = await l2.refresh();
    expect(first.status.lastError).toMatchObject({ code: 'bad_pack', stage: 'validate' });
    const second = await l2.refresh();
    expect(second.status.lastError).toBeNull();
    expect(refusing).toHaveBeenCalledTimes(2);
  });

  it('a new release is still only pending in manual mode (the once-per-process sync is for the applied version only)', async () => {
    const r = await rig();
    await firstProcess(r, new MemoryTermStore());
    await r.w.addRelease('2027.01.0', { sequence: 15 });
    r.w.sequence = 15;
    await r.w.publishIndex();
    const store = new MemoryTermStore();
    const live = await liveOn(store);
    const res = await r.make({ terms: live, apply: 'manual' }).refresh();
    expect(res.status).toMatchObject({ applied: '2026.12.0', available: '2027.01.0' });
    expect(store.state.terms.every((t) => t.addedBy !== 'corpus:2027.01.0')).toBe(true);
  });
});

// Review A3 I1: the default is apply 'manual', so the usual month is "a release is applied and a newer one is waiting". A restart then must
// still hand the APPLIED pack to the live list (its canary and negative corpus); the newer one is only dry-run for the pending summary.

/** Process 1 applies 2026.12.0; process 2 (manual) downloads 2027.01.0 and leaves it pending. state.json: applied 2026.12.0, release 2027.01.0. */
async function pendingWorld(): Promise<Rig> {
  const r = await rig();
  await firstProcess(r, new MemoryTermStore());
  await r.w.addRelease('2027.01.0', { sequence: 15 });
  r.w.sequence = 15;
  await r.w.publishIndex();
  const second = await r.make({ terms: await liveOn(new MemoryTermStore()), apply: 'manual' }).refresh();
  expect(second.status).toMatchObject({ applied: '2026.12.0', available: '2027.01.0' });
  expect(r.cache.json('state.json')).toMatchObject({ applied: '2026.12.0', release: '2027.01.0' });
  return r;
}

describe('a restart while a newer release is waiting (the usual manual state)', () => {
  for (const online of [true, false]) {
    it(`${online ? 'online' : 'offline'}: a store that did not survive gets the applied version's rows, the canary refuses an unblocking exception, and the newer one stays pending`, async () => {
      const r = await pendingWorld();
      const store = new MemoryTermStore();
      const live = await liveOn(store);
      if (!online) r.w.fault('index.json', { kind: 'throw' });
      const res = await r.make({ terms: live, apply: 'manual' }).refresh();
      expect(res.status).toMatchObject({ applied: '2026.12.0', available: '2027.01.0' });
      expect(res.status.pending).not.toBeNull();
      expect(store.state.terms.length).toBeGreaterThan(0);
      expect(store.state.terms.every((t) => t.addedBy === 'corpus:2026.12.0')).toBe(true);
      expect(live.match('you zorbak')).not.toBeNull();
      expect(tryUnblock(live)).toMatchObject({ ok: false, code: 'unblocks_known' });
      // The newer one was only looked at: nothing of it is in the store.
      expect(store.state.terms.some((t) => t.addedBy === 'corpus:2027.01.0')).toBe(false);
    });

    it(`${online ? 'online' : 'offline'}: a store that survived is left byte for byte as it was, and the canary refuses an unblocking exception`, async () => {
      const r = await pendingWorld();
      const first = new MemoryTermStore();
      await firstProcess(await rig(), first);
      const survived = new MemoryTermStore();
      survived.state.terms.push(...structuredClone(first.state.terms));
      survived.state.exceptions.push(...structuredClone(first.state.exceptions));
      const rowsBefore = structuredClone(survived.state.terms);
      const live = await liveOn(survived);
      if (!online) r.w.fault('index.json', { kind: 'throw' });
      const res = await r.make({ terms: live, apply: 'manual' }).refresh();
      expect(res.status).toMatchObject({ applied: '2026.12.0', available: '2027.01.0' });
      expect(tryUnblock(live)).toMatchObject({ ok: false, code: 'unblocks_known' });
      expect(survived.state.terms).toEqual(rowsBefore);
      expect(survived.state.audit).toHaveLength(0);
    });
  }

  it('the applied pack is handed over once per process: a second refresh does not sync again, and the dry run of the newer one is still a dry run', async () => {
    const r = await pendingWorld();
    const live = await liveOn(new MemoryTermStore());
    const spy = vi.spyOn(live, 'syncPack');
    const loader = r.make({ terms: live, apply: 'manual' });
    await loader.refresh();
    await loader.refresh();
    const real = spy.mock.calls.filter((c) => c[1]?.dryRun !== true);
    expect(real).toHaveLength(1);
    expect(real[0]?.[1]).toMatchObject({ actor: 'corpus:2026.12.0' });
    expect(spy.mock.calls.filter((c) => c[1]?.dryRun === true).length).toBeGreaterThan(0);
  });

  it('applying the newer one afterwards still works and moves the live list on', async () => {
    const r = await pendingWorld();
    const store = new MemoryTermStore();
    const live = await liveOn(store);
    const loader = r.make({ terms: live, apply: 'manual' });
    await loader.refresh();
    const applied = loader.applyTo(live);
    expect(applied).toMatchObject({ ok: true, version: '2027.01.0' });
    expect(loader.status()).toMatchObject({ applied: '2027.01.0', available: null, pending: null });
  });

  it('auto mode is unchanged: the newer release is applied for real on the restart, and the older pack is not installed first', async () => {
    const r = await pendingWorld();
    const live = await liveOn(new MemoryTermStore());
    const spy = vi.spyOn(live, 'syncPack');
    const res = await r.make({ terms: live, apply: 'auto' }).refresh();
    expect(res.status).toMatchObject({ applied: '2027.01.0', available: null });
    expect(spy.mock.calls.filter((c) => c[1]?.dryRun !== true).map((c) => (c[1] as { actor: string }).actor)).toEqual(['corpus:2027.01.0']);
  });

  it('a cached copy of the applied version that is gone (cache_failed) or no longer verifies (bad_signature) is said in the status, nothing is installed, and the newer one is still pending', async () => {
    for (const damage of ['gone', 'flipped'] as const) {
      const r = await pendingWorld();
      const name = 'releases/terms-2026.12.0.zip';
      if (damage === 'gone') r.cache.files.delete(name);
      else {
        const bytes = r.cache.files.get(name) as Uint8Array;
        bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0xff;
      }
      const store = new MemoryTermStore();
      const live = await liveOn(store);
      const res = await r.make({ terms: live, apply: 'manual' }).refresh();
      // A file that is not there is a cache problem; one that is there and does not verify says so.
      expect(res.status.lastError, damage).toMatchObject(damage === 'gone' ? { code: 'cache_failed', stage: 'cache' } : { code: 'bad_signature', stage: 'verify' });
      expect(res.status).toMatchObject({ applied: '2026.12.0', available: '2027.01.0' });
      expect(res.status.pending, damage).not.toBeNull();
      expect(store.state.terms, damage).toHaveLength(0);
      expect(live.match('you zorbak'), damage).toBeNull();
    }
  });

  it('a revoked applied version is not installed, and says so', async () => {
    const r = await pendingWorld();
    r.w.revokedReleases = [{ kind: 'terms', version: '2026.12.0', reason: 'bad_release' }];
    await r.w.publishIndex();
    const store = new MemoryTermStore();
    const live = await liveOn(store);
    const res = await r.make({ terms: live, apply: 'manual' }).refresh();
    expect(store.state.terms).toHaveLength(0);
    expect(res.status.lastError).not.toBeNull();
  });
});
