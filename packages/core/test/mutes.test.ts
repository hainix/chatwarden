import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomRoster } from '../src/evidence.js';
import { MAX_MUTES_PER_VIEWER, MUTE_TTL_MS, MuteService } from '../src/mutes.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, Logger, SubjectId } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function who(clientKey: string | null, accountId: string | null = null, ipHash: string | null = null): Identifiers {
  return { clientKey, accountId, ipHash };
}

function setup(opts: { store?: MemoryStore } = {}) {
  const store = opts.store ?? new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const logs: Array<{ event: string; detail?: Record<string, string | number | boolean> }> = [];
  const logger: Logger = {
    warn(event, detail) {
      logs.push({ event, detail });
    },
  };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const mutes = new MuteService(store, clock, subjects, { logger });
  /** Resolve a person; every call advances the clock 1 ms so "older subject survives" is deterministic. */
  const person = (ids: Identifiers): SubjectId => {
    clock.t += 1;
    const s = subjects.resolve(ids);
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  return { store, clock, subjects, mutes, logs, person };
}

const count = (store: MemoryStore) => store.rawMutes().length;
const at = (list: SubjectId[], i: number): SubjectId => list[i] as SubjectId;

describe('set / isMuted basics', () => {
  it('mutes a target for a viewer, and unmute removes it', () => {
    const { mutes, store, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    expect(mutes.isMuted(v, t)).toBe(false);
    mutes.set(v, t, true);
    expect(mutes.isMuted(v, t)).toBe(true);
    mutes.set(v, t, false);
    expect(mutes.isMuted(v, t)).toBe(false);
    expect(count(store)).toBe(0);
  });

  it('is directional: muting B does not mute A for B', () => {
    const { mutes, person } = setup();
    const a = person(who('a'));
    const b = person(who('b'));
    mutes.set(a, b, true);
    expect(mutes.isMuted(b, a)).toBe(false);
  });

  it('only the muting viewer is affected, not other viewers', () => {
    const { mutes, person } = setup();
    const a = person(who('a'));
    const c = person(who('c'));
    const t = person(who('t'));
    mutes.set(a, t, true);
    expect(mutes.isMuted(c, t)).toBe(false);
  });

  it('only the muted target is affected, not other targets', () => {
    const { mutes, person } = setup();
    const a = person(who('a'));
    const t = person(who('t'));
    const u = person(who('u'));
    mutes.set(a, t, true);
    expect(mutes.isMuted(a, u)).toBe(false);
  });

  it('unmuting a pair that was never muted is harmless and leaves other mutes alone', () => {
    const { mutes, store, person } = setup();
    const a = person(who('a'));
    const t = person(who('t'));
    const u = person(who('u'));
    mutes.set(a, t, true);
    mutes.set(a, u, false);
    expect(mutes.isMuted(a, t)).toBe(true);
    expect(count(store)).toBe(1);
  });

  it('never matches on the IP: two people behind one address stay separate', () => {
    const { mutes, store, person } = setup();
    const v = person(who('vk', null, 'same-ip'));
    const t = person(who('tk', null, 'ip-1'));
    mutes.set(v, t, true);
    const sameIpAsTarget = person(who('other', null, 'ip-1'));
    const sameIpAsViewer = person(who('other2', null, 'same-ip'));
    expect(mutes.isMuted(v, sameIpAsTarget)).toBe(false);
    expect(mutes.isMuted(sameIpAsViewer, t)).toBe(false);
    expect(JSON.stringify(store.rawMutes())).not.toMatch(/ip-1|same-ip/);
  });

  it('stores exactly the subject ids as given, with the clock time', () => {
    const { mutes, store, clock, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    mutes.set(v, t, true);
    expect(store.rawMutes()).toEqual([{ viewer: v, target: t, createdAt: clock.t }]);
  });

  it('set is synchronous: the very next isMuted sees it', () => {
    const { mutes, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    const out = mutes.set(v, t, true);
    expect(out).toBeUndefined();
    expect(mutes.isMuted(v, t)).toBe(true);
  });
});

describe('matching by subject (the Moxgate key-or-account cases)', () => {
  it('two identifiers of one viewer: a mute from browser A holds on browser B', () => {
    const { mutes, person } = setup();
    const t = person(who('tk', 'acct-t'));
    const viaA = person(who('browser-a', 'acct-v'));
    mutes.set(viaA, t, true);
    const viaB = person(who('browser-b', 'acct-v'));
    expect(viaB).toBe(viaA);
    expect(mutes.isMuted(viaB, t)).toBe(true);
  });

  it('the target switches browsers but keeps the account: still muted', () => {
    const { mutes, person } = setup();
    const v = person(who('vk', 'acct-v'));
    const t1 = person(who('t-browser-1', 'acct-t'));
    mutes.set(v, t1, true);
    const t2 = person(who('t-browser-2', 'acct-t'));
    expect(mutes.isMuted(v, t2)).toBe(true);
  });

  it('the target signs out (same browser key, no account): still muted', () => {
    const { mutes, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk', 'acct-t'));
    mutes.set(v, t, true);
    expect(mutes.isMuted(v, person(who('tk')))).toBe(true);
  });

  it('an anonymous viewer on a new browser (new key, no account) is a different person, not muting', () => {
    const { mutes, person } = setup();
    const a = person(who('browser-a'));
    const t = person(who('tk'));
    mutes.set(a, t, true);
    expect(mutes.isMuted(person(who('browser-b')), t)).toBe(false);
  });

  it('account-only subjects match by account, and another account does not', () => {
    const { mutes, person } = setup();
    const v = person(who(null, 'acct-v'));
    const t = person(who(null, 'acct-t'));
    mutes.set(v, t, true);
    expect(mutes.isMuted(person(who('later-key', 'acct-v')), person(who('other', 'acct-t')))).toBe(true);
    expect(mutes.isMuted(person(who(null, 'acct-x')), t)).toBe(false);
  });

  it('a person without any subject (IP only) is never muted and never mutes', () => {
    const { mutes, subjects, store, person } = setup();
    const v = person(who('vk'));
    const none = subjects.resolve(who(null, null, 'ip-only'));
    expect(none).toBeNull();
    expect(mutes.isMuted(v, none)).toBe(false);
    expect(mutes.isMuted(none, v)).toBe(false);
    expect(count(store)).toBe(0);
  });

  it('a viewer match alone is not enough: the target must match too', () => {
    const { mutes, person } = setup();
    const v = person(who('vk', 'acct-v'));
    const t = person(who('tk', 'acct-t'));
    mutes.set(v, t, true);
    expect(mutes.isMuted(v, person(who('zz', 'acct-zz')))).toBe(false);
  });

  it('unmute from another device removes the mute for both devices', () => {
    const { mutes, store, person } = setup();
    const t = person(who('tk', 'acct-t'));
    const a = person(who('browser-a', 'acct-v'));
    mutes.set(a, t, true);
    const b = person(who('browser-b', 'acct-v'));
    mutes.set(b, t, false);
    expect(mutes.isMuted(a, t)).toBe(false);
    expect(count(store)).toBe(0);
  });

  it('isMuted(null, x) and isMuted(x, null) are false', () => {
    const { mutes, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    mutes.set(v, t, true);
    expect(mutes.isMuted(null, t)).toBe(false);
    expect(mutes.isMuted(v, null)).toBe(false);
    expect(mutes.isMuted(null, null)).toBe(false);
  });
});

describe('merges', () => {
  it('mute survives a target merge: muting t1, then t1 and t2 are found to be one person', () => {
    const { mutes, person } = setup();
    const v = person(who('vk'));
    const t1 = person(who('t-key'));
    const t2 = person(who(null, 't-acct'));
    mutes.set(v, t1, true);
    expect(mutes.isMuted(v, t2)).toBe(false);
    const merged = person(who('t-key', 't-acct')); // signs in: the two subjects merge
    expect(mutes.isMuted(v, merged)).toBe(true);
    expect(mutes.isMuted(v, t1)).toBe(true);
    expect(mutes.isMuted(v, t2)).toBe(true);
  });

  it('mute survives a viewer merge when stored under the absorbed viewer id', () => {
    const { mutes, person } = setup();
    const v1 = person(who('v-key'));
    const v2 = person(who(null, 'v-acct'));
    const t = person(who('tk'));
    mutes.set(v2, t, true); // stored under the younger viewer subject
    person(who('v-key', 'v-acct')); // v1 (older) survives; v2 is absorbed
    expect(mutes.isMuted(v1, t)).toBe(true);
    expect(mutes.isMuted(v2, t)).toBe(true);
  });

  it('mute stored under the surviving viewer id also survives', () => {
    const { mutes, person } = setup();
    const v1 = person(who('v-key'));
    const v2 = person(who(null, 'v-acct'));
    const t = person(who('tk'));
    mutes.set(v1, t, true);
    person(who('v-key', 'v-acct'));
    expect(mutes.isMuted(v2, t)).toBe(true);
  });

  it('a merge that makes viewer and target one person mutes nobody (never self)', () => {
    const { mutes, person } = setup();
    const a = person(who('a-key'));
    const b = person(who(null, 'b-acct'));
    mutes.set(a, b, true);
    expect(mutes.isMuted(a, b)).toBe(true);
    person(who('a-key', 'b-acct'));
    expect(mutes.isMuted(a, b)).toBe(false);
    expect(mutes.isMuted(b, a)).toBe(false);
  });

  it('unmute after a target merge removes the row stored under the old id', () => {
    const { mutes, store, person } = setup();
    const v = person(who('vk'));
    const t1 = person(who('t-key'));
    person(who(null, 't-acct'));
    mutes.set(v, t1, true);
    const merged = person(who('t-key', 't-acct'));
    mutes.set(v, merged, false);
    expect(mutes.isMuted(v, t1)).toBe(false);
    expect(mutes.isMuted(v, merged)).toBe(false);
    expect(count(store)).toBe(0);
  });

  it('unmute after a viewer merge removes the row stored under the absorbed id', () => {
    const { mutes, store, person } = setup();
    const v1 = person(who('v-key'));
    const v2 = person(who(null, 'v-acct'));
    const t = person(who('tk'));
    mutes.set(v2, t, true);
    person(who('v-key', 'v-acct'));
    mutes.set(v1, t, false);
    expect(mutes.isMuted(v2, t)).toBe(false);
    expect(count(store)).toBe(0);
  });

  it('muting again after a target merge keeps ONE row for the person', () => {
    const { mutes, store, person } = setup();
    const v = person(who('vk'));
    const t1 = person(who('t-key'));
    person(who(null, 't-acct'));
    mutes.set(v, t1, true);
    const merged = person(who('t-key', 't-acct'));
    mutes.set(v, merged, true);
    expect(count(store)).toBe(1);
    expect(mutes.isMuted(v, t1)).toBe(true);
  });

  it('after a viewer merge, a new mute moves the rows under the surviving viewer', () => {
    const { mutes, store, person } = setup();
    const v1 = person(who('v-key'));
    const v2 = person(who(null, 'v-acct'));
    const targets = Array.from({ length: 3 }, (_, i) => person(who(`t${i}`)));
    mutes.set(v1, at(targets, 0), true);
    mutes.set(v2, at(targets, 1), true);
    const merged = person(who('v-key', 'v-acct'));
    mutes.set(merged, at(targets, 2), true);
    const viewers = new Set(store.rawMutes().map((r) => r.viewer));
    expect([...viewers]).toEqual([merged]);
    expect(count(store)).toBe(3);
    for (const t of targets) expect(mutes.isMuted(v2, t)).toBe(true);
  });

  it('rekeying keeps the newer time when both viewer ids had muted the same target', () => {
    const { mutes, store, clock, person } = setup();
    const person1 = person(who('v-key'));
    const v2 = person(who(null, 'v-acct'));
    const t = person(who('tk'));
    const other = person(who('ok'));
    mutes.set(person1, t, true);
    const first = clock.t;
    clock.t += 5 * DAY;
    mutes.set(v2, t, true);
    const second = clock.t;
    const merged = person(who('v-key', 'v-acct'));
    mutes.set(merged, other, true);
    const rows = store.rawMutes().filter((r) => r.target === t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdAt).toBe(second);
    expect(second).toBeGreaterThan(first);
  });

  it('survives a reload from the store after a merge', async () => {
    const { mutes, store, clock, subjects, person } = setup();
    const v = person(who('vk'));
    const t1 = person(who('t-key'));
    person(who(null, 't-acct'));
    mutes.set(v, t1, true);
    person(who('t-key', 't-acct'));
    await subjects.flush();
    const subjects2 = new SubjectIndex(store, clock, { logger: { warn() {} } });
    await subjects2.load();
    const mutes2 = new MuteService(store, clock, subjects2);
    await mutes2.load();
    const t2 = subjects2.resolve(who(null, 't-acct'));
    expect(mutes2.isMuted(v, t2)).toBe(true);
  });
});

describe('dedupe and refresh', () => {
  it('repeated mutes of the same pair keep one row', () => {
    const { mutes, store, clock, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    for (let i = 0; i < 5; i++) {
      clock.t += 1;
      mutes.set(v, t, true);
    }
    expect(count(store)).toBe(1);
  });

  it('a repeat refreshes created_at, so the TTL restarts', () => {
    const { mutes, store, clock, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    mutes.set(v, t, true);
    clock.t += 100 * DAY;
    mutes.set(v, t, true);
    expect(store.rawMutes()[0]?.createdAt).toBe(clock.t);
    clock.t += 100 * DAY; // 200 days after the first, 100 after the refresh
    expect(mutes.isMuted(v, t)).toBe(true);
  });

  it('a repeat revives a mute that had expired', () => {
    const { mutes, store, clock, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    mutes.set(v, t, true);
    clock.t += 200 * DAY;
    expect(mutes.isMuted(v, t)).toBe(false);
    mutes.set(v, t, true);
    expect(mutes.isMuted(v, t)).toBe(true);
    expect(count(store)).toBe(1);
  });

  it('a repeat from another device of the same account keeps one row', () => {
    const { mutes, store, person } = setup();
    const t = person(who('tk'));
    mutes.set(person(who('browser-a', 'acct-v')), t, true);
    mutes.set(person(who('browser-b', 'acct-v')), t, true);
    expect(count(store)).toBe(1);
  });

  it('different targets are different rows', () => {
    const { mutes, store, person } = setup();
    const v = person(who('vk'));
    mutes.set(v, person(who('t1')), true);
    mutes.set(v, person(who('t2')), true);
    expect(count(store)).toBe(2);
  });

  it('the cap counts distinct pairs, not repeat mutes', () => {
    const { mutes, store, person } = setup();
    const v = person(who('vk'));
    const ts = Array.from({ length: 500 }, (_, i) => person(who(`t${i}`)));
    for (const t of ts) mutes.set(v, t, true);
    for (const t of ts.slice(0, 100)) mutes.set(v, t, true); // repeats must evict nothing
    expect(count(store)).toBe(500);
    for (const t of ts) expect(mutes.isMuted(v, t)).toBe(true);
  });
});

describe('cap', () => {
  it('uses the brief values', () => {
    expect(MAX_MUTES_PER_VIEWER).toBe(500);
    expect(MUTE_TTL_MS).toBe(180 * DAY);
  });

  it('cap drops oldest: the 501st mute evicts the oldest, in the store too', () => {
    const { mutes, store, clock, person } = setup();
    const v = person(who('vk'));
    const ts = Array.from({ length: 501 }, (_, i) => person(who(`t${i}`)));
    for (const t of ts.slice(0, 500)) {
      clock.t += 1;
      mutes.set(v, t, true);
    }
    expect(count(store)).toBe(500);
    clock.t += 1;
    mutes.set(v, at(ts, 500), true);
    expect(count(store)).toBe(500);
    expect(mutes.isMuted(v, at(ts, 0))).toBe(false);
    expect(mutes.isMuted(v, at(ts, 1))).toBe(true);
    expect(mutes.isMuted(v, at(ts, 500))).toBe(true);
    expect(store.rawMutes().some((r) => r.target === ts[0])).toBe(false);
  });

  it('evicts by created_at, so a refreshed old pair survives', () => {
    const { mutes, clock, person } = setup();
    const v = person(who('vk'));
    const ts = Array.from({ length: 501 }, (_, i) => person(who(`t${i}`)));
    for (const t of ts.slice(0, 500)) {
      clock.t += 1;
      mutes.set(v, t, true);
    }
    clock.t += 1;
    mutes.set(v, at(ts, 0), true); // t0 is now the newest
    clock.t += 1;
    mutes.set(v, at(ts, 500), true);
    expect(mutes.isMuted(v, at(ts, 0))).toBe(true);
    expect(mutes.isMuted(v, at(ts, 1))).toBe(false);
  });

  it('a mute landing in the same millisecond as others evicts exactly one row and keeps itself', () => {
    const { mutes, store, person } = setup();
    const v = person(who('vk'));
    const ts = Array.from({ length: 501 }, (_, i) => person(who(`t${i}`)));
    // The clock is frozen once the people exist: every mute below lands in the same ms.
    for (const t of ts.slice(0, 500)) mutes.set(v, t, true);
    mutes.set(v, at(ts, 500), true);
    expect(count(store)).toBe(500);
    expect(mutes.isMuted(v, at(ts, 500))).toBe(true);
    expect(mutes.isMuted(v, at(ts, 0))).toBe(false);
  });

  it("is per viewer: another viewer's mutes are not evicted", () => {
    const { mutes, clock, person } = setup();
    const other = person(who('other'));
    const keep = person(who('keep'));
    mutes.set(other, keep, true);
    const v = person(who('vk'));
    const ts = Array.from({ length: 501 }, (_, i) => person(who(`t${i}`)));
    for (const t of ts) {
      clock.t += 1;
      mutes.set(v, t, true);
    }
    expect(mutes.isMuted(other, keep)).toBe(true);
  });

  it('an account-only viewer is capped like any other', () => {
    const { mutes, store, clock, person } = setup();
    const v = person(who(null, 'acct-v'));
    const ts = Array.from({ length: 501 }, (_, i) => person(who(`t${i}`)));
    for (const t of ts) {
      clock.t += 1;
      mutes.set(v, t, true);
    }
    expect(count(store)).toBe(500);
    expect(mutes.isMuted(v, at(ts, 0))).toBe(false);
    expect(mutes.isMuted(v, at(ts, 1))).toBe(true);
  });

  it('the cap is counted per person across merged viewer ids', () => {
    const { mutes, store, clock, person } = setup();
    const v1 = person(who('v-key'));
    const v2 = person(who(null, 'v-acct'));
    const ts = Array.from({ length: 502 }, (_, i) => person(who(`t${i}`)));
    for (const t of ts.slice(0, 250)) {
      clock.t += 1;
      mutes.set(v1, t, true);
    }
    for (const t of ts.slice(250, 501)) {
      clock.t += 1;
      mutes.set(v2, t, true);
    }
    const merged = person(who('v-key', 'v-acct'));
    clock.t += 1;
    mutes.set(merged, at(ts, 501), true); // 502nd distinct target for one person
    expect(count(store)).toBe(500);
    expect(mutes.isMuted(merged, at(ts, 0))).toBe(false);
    expect(mutes.isMuted(merged, at(ts, 1))).toBe(false);
    expect(mutes.isMuted(merged, at(ts, 2))).toBe(true);
    expect(mutes.isMuted(merged, at(ts, 501))).toBe(true);
  });
});

describe('expiry', () => {
  it('expired mute ignored: 181 days old does not apply', () => {
    const { mutes, clock, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    mutes.set(v, t, true);
    clock.t += 181 * DAY;
    expect(mutes.isMuted(v, t)).toBe(false);
  });

  it('a 179-day-old mute still applies', () => {
    const { mutes, clock, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    mutes.set(v, t, true);
    clock.t += 179 * DAY;
    expect(mutes.isMuted(v, t)).toBe(true);
  });

  it('a mute exactly 180 days old still applies, one ms older does not (Moxgate boundary)', () => {
    const { mutes, clock, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    mutes.set(v, t, true);
    const start = clock.t;
    clock.t = start + 180 * DAY;
    expect(mutes.isMuted(v, t)).toBe(true);
    clock.t = start + 180 * DAY + 1;
    expect(mutes.isMuted(v, t)).toBe(false);
  });

  it('an expired mute can still be unmuted (the stale row is removed)', () => {
    const { mutes, store, clock, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    mutes.set(v, t, true);
    clock.t += 400 * DAY;
    mutes.set(v, t, false);
    expect(count(store)).toBe(0);
  });

  it('an expired mute is the first evicted, so it never costs a live mute its place', () => {
    const { mutes, store, clock, person } = setup();
    const v = person(who('vk'));
    const old = person(who('old'));
    mutes.set(v, old, true);
    clock.t += 200 * DAY;
    const ts = Array.from({ length: 500 }, (_, i) => person(who(`t${i}`)));
    for (const t of ts) {
      clock.t += 1;
      mutes.set(v, t, true);
    }
    expect(count(store)).toBe(500);
    for (const t of ts) expect(mutes.isMuted(v, t)).toBe(true);
  });
});

describe('no-ops', () => {
  it('muting yourself is a no-op', () => {
    const { mutes, store, person } = setup();
    const v = person(who('vk'));
    mutes.set(v, v, true);
    expect(count(store)).toBe(0);
    expect(mutes.isMuted(v, v)).toBe(false);
  });

  it('muting yourself from another device (two identifiers, one subject) is a no-op', () => {
    const { mutes, store, person } = setup();
    const a = person(who('a', 'acct'));
    const b = person(who('b', 'acct'));
    mutes.set(a, b, true);
    expect(count(store)).toBe(0);
  });

  it('muting your own pre-merge alias is a no-op after the merge', () => {
    const { mutes, store, person } = setup();
    const a = person(who('a-key'));
    const b = person(who(null, 'b-acct'));
    person(who('a-key', 'b-acct'));
    mutes.set(a, b, true);
    expect(count(store)).toBe(0);
  });

  it('empty-string ids write nothing and match nothing', () => {
    const { mutes, store, person } = setup();
    const v = person(who('vk'));
    mutes.set(v, '', true);
    mutes.set('', v, true);
    expect(count(store)).toBe(0);
    expect(mutes.isMuted(v, '')).toBe(false);
    expect(mutes.isMuted('', '')).toBe(false);
  });

  it('unmuting with an unknown id leaves other mutes alone', () => {
    const { mutes, store, person } = setup();
    const v = person(who('vk'));
    const t = person(who('tk'));
    mutes.set(v, t, true);
    mutes.set('s_unknown', t, false);
    mutes.set(v, 's_unknown', false);
    expect(count(store)).toBe(1);
  });

  it('a no-op set does not touch the store at all', () => {
    const store = new MemoryStore();
    const spy = vi.spyOn(store, 'transaction');
    const { mutes, person } = setup({ store });
    const v = person(who('vk'));
    mutes.set(v, v, true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('load', () => {
  it('rebuilds from the store: mutes survive a restart', async () => {
    const env = setup();
    const v = env.person(who('vk'));
    const t = env.person(who('tk'));
    env.mutes.set(v, t, true);
    const fresh = new MuteService(env.store, env.clock, env.subjects);
    expect(fresh.isMuted(v, t)).toBe(false);
    await fresh.load();
    expect(fresh.isMuted(v, t)).toBe(true);
  });

  it('skips expired rows and keeps the ones inside the window', async () => {
    const env = setup();
    const v = env.person(who('vk'));
    const old = env.person(who('old'));
    const fresh = env.person(who('fresh'));
    env.mutes.set(v, old, true);
    env.clock.t += 200 * DAY;
    env.mutes.set(v, fresh, true);
    const again = new MuteService(env.store, env.clock, env.subjects);
    await again.load();
    expect(again.isMuted(v, old)).toBe(false);
    expect(again.isMuted(v, fresh)).toBe(true);
  });

  it('a row exactly 180 days old is loaded; one ms older is not', async () => {
    const env = setup();
    const v = env.person(who('vk'));
    const t = env.person(who('tk'));
    env.mutes.set(v, t, true);
    const start = env.clock.t;
    env.clock.t = start + 180 * DAY;
    const a = new MuteService(env.store, env.clock, env.subjects);
    await a.load();
    expect(a.isMuted(v, t)).toBe(true);
    env.clock.t = start + 180 * DAY + 1;
    const b = new MuteService(env.store, env.clock, env.subjects);
    await b.load();
    expect(b.isMuted(v, t)).toBe(false);
  });

  it('replaces whatever was in memory', async () => {
    const env = setup();
    const v = env.person(who('vk'));
    const t = env.person(who('tk'));
    env.mutes.set(v, t, true);
    await env.mutes.load();
    await env.mutes.load();
    expect(env.mutes.isMuted(v, t)).toBe(true);
    expect(count(env.store)).toBe(1);
  });

  it('rejects when the store cannot be read', async () => {
    const store = new MemoryStore();
    store.loadMutes = () => {
      throw new Error('disk');
    };
    const { mutes } = setup({ store });
    await expect(mutes.load()).rejects.toThrow('disk');
  });
});

describe('write failures never reach the caller', () => {
  it('a throwing logger never makes set() throw (mute and unmute)', () => {
    const store = new MemoryStore();
    const clock = { t: NOW, now: () => clock.t };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const angry: Logger = {
      warn() {
        throw new Error('logger down');
      },
    };
    const mutes = new MuteService(store, clock, subjects, { logger: angry });
    const v = subjects.resolve(who('vk')) as SubjectId;
    const t = subjects.resolve(who('tk')) as SubjectId;
    store.upsertMute = () => {
      throw new TypeError('db is down');
    };
    store.deleteMute = () => {
      throw new TypeError('db is down');
    };
    expect(() => mutes.set(v, t, true)).not.toThrow();
    expect(() => mutes.set(v, t, false)).not.toThrow();
    expect(mutes.isMuted(v, t)).toBe(false);
  });

  it('a failed mute is logged, memory and store are unchanged, and nothing throws', () => {
    const store = new MemoryStore();
    const { mutes, logs, person } = setup({ store });
    const v = person(who('vk'));
    const t = person(who('tk'));
    store.upsertMute = () => {
      throw new TypeError('db is down');
    };
    expect(() => mutes.set(v, t, true)).not.toThrow();
    expect(mutes.isMuted(v, t)).toBe(false);
    expect(count(store)).toBe(0);
    expect(logs).toEqual([{ event: 'mutes.write_failed', detail: { op: 'mute', error: 'TypeError' } }]);
  });

  it('a failure after the upsert (in the cap prune) rolls the whole write back', () => {
    const store = new MemoryStore();
    const { mutes, logs, person } = setup({ store });
    const v = person(who('vk'));
    const t = person(who('tk'));
    store.pruneMutes = () => {
      throw new RangeError('boom');
    };
    expect(() => mutes.set(v, t, true)).not.toThrow();
    expect(count(store)).toBe(0);
    expect(mutes.isMuted(v, t)).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.detail?.error).toBe('RangeError');
  });

  it('a failed refresh keeps the old time in memory and store', () => {
    const store = new MemoryStore();
    const { mutes, clock, person } = setup({ store });
    const v = person(who('vk'));
    const t = person(who('tk'));
    mutes.set(v, t, true);
    const first = store.rawMutes()[0]?.createdAt ?? 0;
    clock.t += 50 * DAY;
    store.pruneMutes = () => {
      throw new Error('x');
    };
    mutes.set(v, t, true);
    expect(store.rawMutes()[0]?.createdAt).toBe(first);
    clock.t = first + 180 * DAY + 1;
    expect(mutes.isMuted(v, t)).toBe(false); // still judged on the old time
  });

  it('a failed unmute leaves the mute in place', () => {
    const store = new MemoryStore();
    const { mutes, logs, person } = setup({ store });
    const v = person(who('vk'));
    const t = person(who('tk'));
    mutes.set(v, t, true);
    store.deleteMute = () => {
      throw new Error('locked');
    };
    expect(() => mutes.set(v, t, false)).not.toThrow();
    expect(mutes.isMuted(v, t)).toBe(true);
    expect(count(store)).toBe(1);
    expect(logs[0]).toEqual({ event: 'mutes.write_failed', detail: { op: 'unmute', error: 'Error' } });
  });

  it('a failure part way through a viewer-merge rekey leaves the store as it was', () => {
    const store = new MemoryStore();
    const { mutes, person } = setup({ store });
    const v1 = person(who('v-key'));
    const v2 = person(who(null, 'v-acct'));
    const t = person(who('tk'));
    const u = person(who('uk'));
    mutes.set(v2, t, true);
    const merged = person(who('v-key', 'v-acct'));
    const before = store.rawMutes();
    const orig = store.deleteMute.bind(store);
    store.deleteMute = (viewer, target) => {
      orig(viewer, target);
      throw new Error('mid-way');
    };
    mutes.set(merged, u, true);
    expect(store.rawMutes()).toEqual(before);
    expect(mutes.isMuted(v1, t)).toBe(true);
    expect(mutes.isMuted(v1, u)).toBe(false);
  });

  it('a log line carries no identifier', () => {
    const store = new MemoryStore();
    const { mutes, logs, person } = setup({ store });
    const v = person(who('secret-vk'));
    const t = person(who('secret-tk'));
    store.upsertMute = () => {
      throw new Error(`failed for ${v} and ${t}`);
    };
    mutes.set(v, t, true);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(v);
    expect(text).not.toContain(t);
    expect(text).not.toContain('secret');
  });

  it('defaults to console.warn when no logger is given', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new MemoryStore();
    const clock = { now: () => NOW };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const mutes = new MuteService(store, clock, subjects);
    const v = subjects.resolve(who('vk')) as SubjectId;
    const t = subjects.resolve(who('tk')) as SubjectId;
    store.upsertMute = () => {
      throw new Error('down');
    };
    mutes.set(v, t, true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('mutes.write_failed');
  });

  it('a later successful write works after a failed one', () => {
    const store = new MemoryStore();
    const { mutes, person } = setup({ store });
    const v = person(who('vk'));
    const t = person(who('tk'));
    const real = store.upsertMute.bind(store);
    store.upsertMute = () => {
      throw new Error('once');
    };
    mutes.set(v, t, true);
    store.upsertMute = real;
    mutes.set(v, t, true);
    expect(mutes.isMuted(v, t)).toBe(true);
    expect(count(store)).toBe(1);
  });
});

describe('mutedSeats', () => {
  function room() {
    const env = setup();
    const roster = new RoomRoster();
    const sit = (seat: string, ids: Identifiers | null, handle = seat): SubjectId => {
      const subject = ids === null ? null : env.person(ids);
      roster.seat('R', seat, subject, handle);
      return subject as SubjectId;
    };
    return { ...env, roster, sit };
  }

  it('returns the other seats occupied by a muted person', () => {
    const { mutes, roster, sit } = room();
    const v = sit('p1', who('vk'));
    const bad = sit('p2', who('bad'));
    sit('p3', who('fine'));
    mutes.set(v, bad, true);
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual(['p2']);
  });

  it('returns several muted seats, sorted by seat id', () => {
    const { mutes, roster, sit } = room();
    const v = sit('p1', who('vk'));
    const c = sit('p4', who('c'));
    const a = sit('p2', who('a'));
    sit('p3', who('b'));
    const d = sit('p10', who('d'));
    mutes.set(v, c, true);
    mutes.set(v, a, true);
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual(['p2', 'p4']);
    mutes.set(v, d, true);
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual(['p10', 'p2', 'p4']);
  });

  it('is empty when nothing is muted', () => {
    const { mutes, roster, sit } = room();
    sit('p1', who('vk'));
    sit('p2', who('a'));
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual([]);
  });

  it("never includes the viewer's own seat, even with a stray self row", async () => {
    const { mutes, store, roster, sit, clock } = room();
    const v = sit('p1', who('vk'));
    sit('p2', who('a'));
    store.upsertMute({ viewer: v, target: v, createdAt: clock.t });
    await mutes.load();
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual([]);
  });

  it("never lists the viewer's own second seat (two identifiers of one person)", () => {
    const { mutes, roster, sit } = room();
    const v1 = sit('p1', who('tok-v1', 'acct-v'));
    sit('p2', who('tok-v2', 'acct-v'));
    expect(roster.occupant('R', 'p2')?.subject).toBe(v1);
    mutes.set(v1, v1, true);
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual([]);
  });

  it('skips seats with no subject (AI, unknown)', () => {
    const { mutes, roster, sit } = room();
    const v = sit('p1', who('vk'));
    sit('ai', null, 'robot');
    const x = sit('p3', who('x'));
    mutes.set(v, x, true);
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual(['p3']);
  });

  it('follows the occupant: a seat handed to someone else is no longer muted', () => {
    const { mutes, roster, sit, person } = room();
    const v = sit('p1', who('vk'));
    const bad = sit('p2', who('bad'));
    mutes.set(v, bad, true);
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual(['p2']);
    roster.seat('R', 'p2', person(who('new-player')), 'new');
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual([]);
    roster.seat('R', 'p2', bad, 'bad');
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual(['p2']);
  });

  it('an unseated seat is not listed', () => {
    const { mutes, roster, sit } = room();
    const v = sit('p1', who('vk'));
    const bad = sit('p2', who('bad'));
    mutes.set(v, bad, true);
    roster.unseat('R', 'p2');
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual([]);
  });

  it('matches a muted person who joined on a different browser (same account)', () => {
    const { mutes, roster, sit, person } = room();
    const v = sit('p1', who('tok-v', 'acct-v'));
    const t = person(who('old-target-browser', 'acct-t'));
    mutes.set(v, t, true);
    sit('p2', who('tok-t-new', 'acct-t'));
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual(['p2']);
  });

  it('matches a seat whose stored subject was merged away since', () => {
    const { mutes, roster, sit, person } = room();
    const v = sit('p1', who('vk'));
    const bad = sit('p2', who('bad-key'));
    mutes.set(v, bad, true);
    person(who('bad-key', 'bad-acct'));
    const other = person(who(null, 'bad-acct'));
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual(['p2']);
    roster.seat('R', 'p3', other, 'same person, other seat');
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual(['p2', 'p3']);
  });

  it('a viewer with no subject, an unseated viewer, or an unknown room gets an empty list', () => {
    const { mutes, roster, sit } = room();
    sit('p1', null, 'guest');
    sit('p2', who('a'));
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual([]);
    expect(mutes.mutedSeats('R', 'nobody', roster)).toEqual([]);
    expect(mutes.mutedSeats('NOPE', 'p1', roster)).toEqual([]);
  });

  it('ignores expired mutes and is judged at the clock time', () => {
    const { mutes, roster, clock, sit } = room();
    const v = sit('p1', who('vk'));
    const bad = sit('p2', who('bad'));
    mutes.set(v, bad, true);
    clock.t += 179 * DAY;
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual(['p2']);
    clock.t += 2 * DAY;
    expect(mutes.mutedSeats('R', 'p1', roster)).toEqual([]);
  });

  it('is scoped to the room and returns seat ids only', () => {
    const { mutes, roster, sit } = room();
    const v = sit('p1', who('vk'));
    const bad = sit('p2', who('bad'));
    roster.seat('OTHER', 'q1', bad, 'bad');
    mutes.set(v, bad, true);
    const seats = mutes.mutedSeats('R', 'p1', roster);
    expect(seats).toEqual(['p2']);
    expect(JSON.stringify(seats)).not.toContain('s_');
    expect(mutes.mutedSeats('OTHER', 'q1', roster)).toEqual([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
