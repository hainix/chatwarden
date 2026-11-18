import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { MUTE_TTL_MS, MuteService } from '../src/mutes.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, SubjectId } from '../src/types.js';

// M-5: visibility asks the mute index twice per recipient per line. A miss (nobody muted anybody) must cost a lookup, not a scan of every viewer, however many viewers hold a
// mute or a block; merges (a row stored under an id merged away since) must still be found, in both directions and for both kinds.

const NOW = 1_800_000_000_000;
const who = (clientKey: string | null, accountId: string | null = null): Identifiers => ({ clientKey, accountId, ipHash: null });

function setup() {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  let canonicalCalls = 0;
  const real = subjects.canonical.bind(subjects);
  subjects.canonical = (id: SubjectId): SubjectId => {
    canonicalCalls += 1;
    return real(id);
  };
  const mutes = new MuteService(store, clock, subjects, { logger: { warn() {} } });
  const person = (ids: Identifiers): SubjectId => {
    clock.t += 1;
    const s = subjects.resolve(ids);
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  return { store, clock, subjects, mutes, person, calls: () => canonicalCalls, reset: () => void (canonicalCalls = 0) };
}

/** Fill the service with `n` viewers, each with one mute or block of a shared target. */
function crowd(s: ReturnType<typeof setup>, n: number): { target: SubjectId; viewers: SubjectId[] } {
  const target = s.person(who('crowd-target'));
  const viewers: SubjectId[] = [];
  for (let i = 0; i < n; i += 1) {
    const v = s.person(who(`crowd-viewer-${i}`));
    viewers.push(v);
    s.mutes.set(v, target, true, i % 2 === 0 ? 'block' : 'mute');
  }
  return { target, viewers };
}

describe('a lookup that finds nothing does not scan the viewers', () => {
  it('with 3000 viewers holding a mute or a block, a miss costs a handful of canonical calls, not thousands', () => {
    const s = setup();
    crowd(s, 3000);
    const a = s.person(who('plain-a'));
    const b = s.person(who('plain-b'));
    s.reset();
    expect(s.mutes.isMuted(a, b)).toBe(false);
    expect(s.mutes.isBlocked(b, a)).toBe(false);
    expect(s.calls()).toBeLessThanOrEqual(8);
  });

  it('a hit costs the same, and answers right for each kind at that scale', () => {
    const s = setup();
    const { target, viewers } = crowd(s, 3000);
    s.reset();
    expect(s.mutes.isMuted(viewers[0]!, target)).toBe(true);
    expect(s.mutes.isBlocked(viewers[0]!, target)).toBe(true);
    expect(s.mutes.isMuted(viewers[1]!, target)).toBe(true);
    expect(s.mutes.isBlocked(viewers[1]!, target)).toBe(false);
    expect(s.mutes.blockedBetween(target, viewers[0]!)).toBe(true);
    expect(s.mutes.blockedBetween(target, viewers[1]!)).toBe(false);
    expect(s.mutes.isMuted(target, viewers[0]!)).toBe(false);
    expect(s.calls()).toBeLessThanOrEqual(40);
  });

  it('a miss stays cheap after a merge that touches none of the stored rows, and after one that does (the index is rebuilt once, not per lookup)', () => {
    const s = setup();
    const { viewers, target } = crowd(s, 2000);
    s.person(who('x-key'));
    s.person(who('y-acct', 'acct-y'));
    s.person(who('x-key', 'acct-y')); // those two are one person now
    const a = s.person(who('plain-a'));
    const b = s.person(who('plain-b'));
    expect(s.mutes.isMuted(a, b)).toBe(false); // the first lookup after a merge may rebuild the index
    s.reset();
    for (let i = 0; i < 20; i += 1) expect(s.mutes.isMuted(a, b)).toBe(false);
    expect(s.calls()).toBeLessThanOrEqual(8 * 20);
    // a merge that does touch a stored row: viewers 4 and 5 muted or blocked `target`; `target` merges with another person
    const t2 = s.person(who('t2-key', 'acct-t2'));
    s.person(who('crowd-target', 'acct-t2'));
    expect(s.subjects.canonical(t2)).toBe(s.subjects.canonical(target));
    expect(s.mutes.isMuted(viewers[5]!, t2)).toBe(true);
    expect(s.mutes.isBlocked(viewers[4]!, t2)).toBe(true);
    expect(s.mutes.isBlocked(viewers[5]!, t2)).toBe(false);
    expect(s.mutes.isMuted(a, b)).toBe(false);
    s.reset();
    for (let i = 0; i < 20; i += 1) expect(s.mutes.isMuted(a, b)).toBe(false);
    expect(s.calls()).toBeLessThanOrEqual(8 * 20);
  });
});

describe('rows filed under an id merged away since are still found, at scale', () => {
  it('a block stored under the absorbed viewer id is found for the merged person, both ways, and a mute of it too', () => {
    const s = setup();
    crowd(s, 500);
    const v1 = s.person(who('v-key'));
    const v2 = s.person(who('v-acct-key', 'v-acct'));
    const t = s.person(who('tt-key'));
    const m = s.person(who('mm-key'));
    s.mutes.set(v1, t, true, 'block');
    s.mutes.set(v1, m, true);
    const merged = s.person(who('v-key', 'v-acct')); // v1 and v2 become one
    expect(s.subjects.canonical(v1)).toBe(s.subjects.canonical(v2));
    for (const v of [v1, v2, merged]) {
      expect(s.mutes.isBlocked(v, t), 'block, viewer side').toBe(true);
      expect(s.mutes.isBlocked(t, v), 'isBlocked is one direction').toBe(false);
      expect(s.mutes.blockedBetween(t, v), 'blockedBetween reads both').toBe(true);
      expect(s.mutes.isMuted(v, m)).toBe(true);
      expect(s.mutes.isBlocked(v, m)).toBe(false);
    }
  });

  it('a row whose TARGET was merged away is found for the merged target, and the TTL still ends a mute but never a block', () => {
    const s = setup();
    crowd(s, 500);
    const v = s.person(who('vv-key'));
    const t1 = s.person(who('t1-key'));
    const t2 = s.person(who('t2-acct-key', 't2-acct'));
    const u1 = s.person(who('u1-key'));
    const u2 = s.person(who('u2-acct-key', 'u2-acct'));
    s.mutes.set(v, t1, true);
    s.mutes.set(v, u1, true, 'block');
    s.person(who('t1-key', 't2-acct'));
    s.person(who('u1-key', 'u2-acct'));
    expect(s.mutes.isMuted(v, t2)).toBe(true);
    expect(s.mutes.isBlocked(v, u2)).toBe(true);
    s.clock.t += MUTE_TTL_MS + 5;
    expect(s.mutes.isMuted(v, t2)).toBe(false);
    expect(s.mutes.isBlocked(v, u2)).toBe(true);
  });

  it('a block under one id and a newer mute under another id of the same pair: the block wins', () => {
    const s = setup();
    crowd(s, 100);
    const v1 = s.person(who('w1-key'));
    const v2 = s.person(who('w2-acct-key', 'w2-acct'));
    const t = s.person(who('wt-key'));
    s.mutes.set(v1, t, true, 'block');
    s.mutes.set(v2, t, true);
    s.person(who('w1-key', 'w2-acct'));
    expect(s.mutes.isBlocked(v1, t)).toBe(true);
    expect(s.mutes.isBlocked(v2, t)).toBe(true);
  });

  it('unmuting and muting after a merge keep working with the index in place (one row left for the person, and the answers follow)', () => {
    const s = setup();
    crowd(s, 300);
    const v = s.person(who('uv-key'));
    const t1 = s.person(who('ut1-key'));
    const t2 = s.person(who('ut2-acct-key', 'ut2-acct'));
    s.mutes.set(v, t1, true);
    s.person(who('ut1-key', 'ut2-acct'));
    expect(s.mutes.isMuted(v, t2)).toBe(true);
    s.mutes.set(v, t2, false);
    expect(s.mutes.isMuted(v, t1)).toBe(false);
    expect(s.mutes.isMuted(v, t2)).toBe(false);
    s.mutes.set(v, t2, true, 'block');
    expect(s.mutes.isBlocked(v, t1)).toBe(true);
    expect(s.store.rawMutes().filter((r) => r.viewer === v)).toHaveLength(1);
  });

  it('a service rebuilt from the store (restart) with merged rows answers the same, and the other direction is a miss', async () => {
    const s = setup();
    crowd(s, 200);
    const v1 = s.person(who('r1-key'));
    const v2 = s.person(who('r2-acct-key', 'r2-acct'));
    const t = s.person(who('rt-key'));
    s.mutes.set(v1, t, true, 'block');
    s.person(who('r1-key', 'r2-acct'));
    const again = new MuteService(s.store, s.clock, s.subjects);
    await again.load();
    expect(again.isBlocked(v2, t)).toBe(true);
    expect(again.blockedBetween(t, v2)).toBe(true);
    expect(again.isMuted(t, v2)).toBe(false);
  });
});
