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
