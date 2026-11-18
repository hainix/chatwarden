import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { RawWho } from '../src/types.js';
import { A, NOW, dump, privacyWorld } from './privacyWorld.js';
import { fullStore } from './legalWorld.js';

// Several processes on one database (design 5.3): another process still has the person in memory. Erase moves the erasure epoch; every process re-reads it at most once
// every 30 seconds on its next subject lookup and reloads when it changed; a store write for a subject that no longer exists is a no-op.

const OWNER = 'owner_ann';

async function second(store: ReturnType<typeof fullStore>, clock: { t: number; now: () => number }) {
  return createChatwarden({ store, secret: 'reporting-secret', platform: { identify: (ctx) => ctx as RawWho }, clock, retention: false });
}

describe('two cw instances on one store', () => {
  it('after one erases, the other reloads within 30 seconds on the fake clock and never writes an identifier for the dead subject', async () => {
    const store = fullStore();
    const w = await privacyWorld({}, store);
    // the second process loads the person from the store
    const other = await second(store, w.clock);
    other.rooms.seat('R7', 'p1', { clientKey: A.key, accountId: A.account }, 'Alpha');
    await other.flush();
    expect(other.rooms.subjectAt('R7', 'p1')).toBe(w.aId);

    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    expect((await store.loadSubjects()).subjects.map((s) => s.id)).toEqual([w.bId]);

    // inside the 30 seconds the other process still believes in the person: its writes are dropped by the store, never recreating anything
    w.clock.t = NOW + 10_000;
    other.rooms.seat('R7', 'p1', { clientKey: A.key, accountId: A.account, ip: '10.9.9.9' }, 'Alpha');
    await other.flush();
    expect((await store.loadSubjects()).ids.some((r) => r.subjectId === w.aId)).toBe(false);
    expect(dump(store)).not.toContain(w.aId);

    // after 30 seconds its next lookup reloads: the same key now makes a NEW subject
    w.clock.t = NOW + 31_000;
    other.rooms.seat('R7', 'p1', { clientKey: A.key, accountId: A.account }, 'Alpha');
    await other.flush();
    other.rooms.seat('R7', 'p1', { clientKey: A.key, accountId: A.account }, 'Alpha');
    await other.flush();
    const fresh = other.rooms.subjectAt('R7', 'p1') as string;
    expect(fresh).not.toBe(w.aId);
    expect(dump(store)).not.toContain(w.aId);
    expect((await store.loadSubjects()).ids.filter((r) => r.subjectId === fresh).length).toBeGreaterThan(0);
    await other.close();
  });

  it('a process that has not seen an erase does not reload at all: the epoch is read at most every 30 seconds, and a read that changes nothing reloads nothing', async () => {
    const store = fullStore();
    const w = await privacyWorld({}, store);
    let reads = 0;
    const real = store.erasureEpoch.bind(store);
    store.erasureEpoch = () => {
      reads += 1;
      return real();
    };
    for (let i = 0; i < 20; i++) {
      w.clock.t = NOW + i * 1000;
      w.cw.rooms.seat('R8', 'p1', { clientKey: A.key, accountId: A.account }, 'Alpha');
    }
    expect(reads).toBeLessThanOrEqual(1);
    w.clock.t = NOW + 61_000;
    w.cw.rooms.seat('R8', 'p1', { clientKey: A.key, accountId: A.account }, 'Alpha');
    w.clock.t = NOW + 62_000;
    w.cw.rooms.seat('R8', 'p1', { clientKey: A.key, accountId: A.account }, 'Alpha');
    expect(reads).toBeLessThanOrEqual(3);
    await w.cw.flush();
    expect(w.cw.rooms.subjectAt('R8', 'p1')).toBe(w.aId);
  });

  it('the erasing process itself does not reload for its own erase', async () => {
    const store = fullStore();
    const w = await privacyWorld({}, store);
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    let loads = 0;
    const real = store.loadSubjects.bind(store);
    store.loadSubjects = () => {
      loads += 1;
      return real();
    };
    w.clock.t = NOW + 120_000;
    w.cw.rooms.seat('R8', 'p2', { clientKey: 'key-new-person' }, 'New');
    await w.cw.flush();
    expect(loads).toBe(0);
  });

  it('a failing epoch read is logged by class and never breaks a lookup', async () => {
    const store = fullStore();
    const w = await privacyWorld({}, store);
    store.erasureEpoch = () => {
      throw new TypeError('epoch secret detail');
    };
    w.clock.t = NOW + 60_000;
    expect(() => w.cw.rooms.seat('R8', 'p1', { clientKey: A.key }, 'Alpha')).not.toThrow();
    expect(w.logged.some(([e, d]) => e === 'chatwarden.epoch_failed' && d?.error === 'TypeError')).toBe(true);
    expect(JSON.stringify(w.logged)).not.toContain('secret detail');
  });

  it('a write queued between the flush and the commit cannot survive: the second sweep removes the rows it wrote', async () => {
    const store = fullStore();
    const w = await privacyWorld({}, store);
    // A stale writer puts rows under the person's id at the moment the erase commits (after the flush, before the forget).
    const realErase = store.eraseSubjects.bind(store);
    store.eraseSubjects = (plan) => {
      const counts = realErase(plan);
      if (plan.dryRun !== true) {
        store.insertStrike({ id: 'raced', at: NOW, subject: w.aId, roomId: 'R', termId: 't', rawLine: 'raced line' });
        store.insertSignal({ id: 'raced-sig', kind: 'muted_by_player', subject: w.aId, sourceKey: 'd:9', bySubject: null, roomId: null, at: NOW, weight: 1, capBucket: 1 });
      }
      return counts;
    };
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    expect(dump(store)).not.toContain('raced');
  });
});
