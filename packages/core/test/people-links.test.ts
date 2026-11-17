import { describe, expect, it } from 'vitest';
import { HOUR, roomsWorld } from './roomsWorld.js';
import type { RoomsWorld } from './roomsWorld.js';

// R2: cw.people.links(subject): how many accounts and devices the kit has linked to a person, how many other subjects were merged into them, and how many sanctions in force sit on a merged
// alias rather than the person's own subject. Counts only: never an id, a key, a hash or an address, and the IP rows are never read.

const subjectOf = (w: RoomsWorld, room: string, seat: string): string => w.cw.rooms.subjectAt(room, seat) as string;

type Apply = (subject: string, kind: 'ban' | 'chat' | 'area' | 'warning', durationMs: number | null) => Promise<{ groupId: string }>;
const applier = (w: RoomsWorld): Apply => (subject, kind, durationMs) =>
  w.cw.sanctions.apply({ kind, subject, includeIp: false, durationMs, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 2 });

/**
 * A person with 2 accounts, 1 key and 1 merged alias: the key and account 1 are the surviving subject; account 2 was first seen alone (the alias) and is then presented with the key, which links them.
 * beforeMerge runs while the alias is still its own person: a sanction written then stays on the alias after the merge (a sanction names the canonical subject at write time).
 */
async function linked(w: RoomsWorld, beforeMerge?: (ids: { root: string; alias: string }) => Promise<void>) {
  w.cw.rooms.seat('L1', 'p1', { clientKey: 'links-key-aaaaaaaaaaaa', accountId: 'links-acct-1' }, 'One');
  const root = subjectOf(w, 'L1', 'p1');
  w.cw.rooms.seat('L2', 'p1', { accountId: 'links-acct-2' }, 'Two');
  const alias = subjectOf(w, 'L2', 'p1');
  expect(alias).not.toBe(root);
  await beforeMerge?.({ root, alias });
  w.cw.rooms.seat('L3', 'p1', { clientKey: 'links-key-aaaaaaaaaaaa', accountId: 'links-acct-2' }, 'Both');
  const person = subjectOf(w, 'L3', 'p1');
  return { person, root, alias };
}

describe('cw.people.links', () => {
  it('a person with 2 accounts, 1 key and 1 merged alias returns 2, 1, 1', async () => {
    const w = await roomsWorld();
    const { person } = await linked(w);
    expect(w.cw.people.links(person)).toEqual({ accounts: 2, devices: 1, merged: 1, inForceOnLinked: { ban: 0, area: 0, chat: 0 } });
  });

  it('asked by any alias of the person gives the same answer', async () => {
    const w = await roomsWorld();
    const { root, alias } = await linked(w);
    expect(w.cw.people.links(alias)).toEqual(w.cw.people.links(root));
  });

  it('a guest, a person with a key only and an unknown subject return zeros', async () => {
    const w = await roomsWorld();
    w.cw.rooms.seat('G1', 'p1', { clientKey: 'links-solo-key-aaaaaaaa' }, 'Solo');
    const solo = subjectOf(w, 'G1', 'p1');
    const zero = { accounts: 0, devices: 0, merged: 0, inForceOnLinked: { ban: 0, area: 0, chat: 0 } };
    expect(w.cw.people.links(solo)).toEqual({ ...zero, devices: 1 });
    expect(w.cw.people.links('s_unknown_subject')).toEqual(zero);
    for (const bad of ['', null, undefined, 5, {}]) expect(w.cw.people.links(bad as never), String(bad)).toEqual(zero);
  });

  it('inForceOnLinked counts a ban placed on a merged alias and not one on the person own subject', async () => {
    const w = await roomsWorld();
    const apply = applier(w);
    const { person } = await linked(w, async ({ root, alias }) => {
      await apply(root, 'ban', null);
      await apply(alias, 'ban', null);
      await apply(alias, 'chat', HOUR);
      await apply(alias, 'area', HOUR);
      // a warning is a record, not a restriction: never counted
      await apply(alias, 'warning', null);
    });
    expect(w.cw.people.links(person).inForceOnLinked).toEqual({ ban: 1, area: 1, chat: 1 });
  });

  it('a ban on the person own subject alone is not counted', async () => {
    const w = await roomsWorld();
    const apply = applier(w);
    const { person, root } = await linked(w);
    await apply(root, 'ban', null);
    expect(w.cw.people.links(person).inForceOnLinked).toEqual({ ban: 0, area: 0, chat: 0 });
  });

  it('a sanction that has ended or been revoked is not in force', async () => {
    const w = await roomsWorld();
    const apply = applier(w);
    let banGroup = '';
    const { person } = await linked(w, async ({ alias }) => {
      await apply(alias, 'chat', HOUR);
      banGroup = (await apply(alias, 'ban', null)).groupId;
    });
    expect(w.cw.people.links(person).inForceOnLinked).toEqual({ ban: 1, area: 0, chat: 1 });
    w.clock.t += 2 * HOUR;
    expect(w.cw.people.links(person).inForceOnLinked).toEqual({ ban: 1, area: 0, chat: 0 });
    expect(await w.cw.sanctions.revoke(banGroup, 'mod_ann', 'mistake')).toBe(true);
    expect(w.cw.people.links(person).inForceOnLinked).toEqual({ ban: 0, area: 0, chat: 0 });
  });

  it('IPs are never counted and never read: the same person seen from three addresses has the same counts', async () => {
    const w = await roomsWorld();
    const { person } = await linked(w);
    const before = w.cw.people.links(person);
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) w.cw.rooms.seat('L9', 'p1', { clientKey: 'links-key-aaaaaaaaaaaa', accountId: 'links-acct-1', ip }, 'Ip');
    expect(w.cw.people.links(person)).toEqual(before);
  });

  it('the result has no string values other than kinds (key scan: no ids, keys, hashes or ips)', async () => {
    const w = await roomsWorld();
    const { person } = await linked(w);
    await w.cw.sanctions.apply({ kind: 'ban', subject: person, includeIp: false, durationMs: null, reason: 'PRIVATE-REASON', actor: 'mod_ann', source: 'moderator', automated: false, rule: 2 });
    const out = w.cw.people.links(person);
    const strings: string[] = [];
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (typeof v === 'object' && v !== null) {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
      }
    };
    walk(out);
    expect(strings).toEqual([]);
    expect(keys.sort()).toEqual(['accounts', 'area', 'ban', 'chat', 'devices', 'inForceOnLinked', 'merged']);
    const text = JSON.stringify(out);
    for (const needle of ['links-key', 'links-acct', person, 'PRIVATE-REASON', 'mod_ann']) expect(text, needle).not.toContain(needle);
  });

  it('is a pure read: it writes nothing and raises no event', async () => {
    const w = await roomsWorld();
    const { person } = await linked(w);
    const events: unknown[] = [];
    w.cw.on('*', (e) => void events.push(e));
    const audit = JSON.stringify(w.cw.audit.list({ limit: 50 }).items);
    w.cw.people.links(person);
    expect(JSON.stringify(w.cw.audit.list({ limit: 50 }).items)).toBe(audit);
    expect(events).toEqual([]);
  });
});

describe('the door follows a merge (pins existing behaviour)', () => {
  it('a new account merged into a banned person is refused with the ban\'s own refCode; an unrelated new account is allowed', async () => {
    const w = await roomsWorld();
    w.cw.rooms.seat('D1', 'p1', { clientKey: 'door-key-aaaaaaaaaaaaaaa', accountId: 'door-acct-1' }, 'One');
    const person = subjectOf(w, 'D1', 'p1');
    const ban = await w.cw.sanctions.apply({ kind: 'ban', subject: person, includeIp: false, durationMs: null, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 2 });
    // before the link, the new account alone is not known to be the banned person's
    expect(w.cw.doors.check('join', { accountId: 'door-acct-new' })).toBeNull();
    // the game seats the new account together with the banned person's key: they are linked
    w.cw.rooms.seat('D2', 'p1', { clientKey: 'door-key-aaaaaaaaaaaaaaa', accountId: 'door-acct-new' }, 'New');
    expect(w.cw.doors.check('join', { accountId: 'door-acct-new' })).toEqual({ kind: 'ban', until: null, refCode: ban.refCode });
    expect(w.cw.doors.check('join', { accountId: 'door-acct-unrelated' })).toBeNull();
  });
});
