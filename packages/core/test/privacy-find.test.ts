import { describe, expect, it } from 'vitest';
import { A, B, dump, fillA, mergeAlias, privacyWorld } from './privacyWorld.js';

// `cw.privacy.find`: the adopter verifies the requester by its own means, then asks the kit which person this is. It never creates a subject.

describe('find: by what the game knows', () => {
  it('by account id and by client key finds the person; the same person either way', async () => {
    const w = await privacyWorld();
    expect(w.cw.privacy.find({ accountId: A.account })).toBe(w.aId);
    expect(w.cw.privacy.find({ clientKey: A.key })).toBe(w.aId);
    expect(w.cw.privacy.find({ clientKey: A.key, accountId: A.account })).toBe(w.aId);
    expect(w.cw.privacy.find({ accountId: B.account })).toBe(w.bId);
  });

  it('an unknown caller is null and no subject is created', async () => {
    const w = await privacyWorld();
    const before = dump(w.store);
    const subjects = (await w.store.loadSubjects()).subjects.length;
    expect(w.cw.privacy.find({ clientKey: 'a-key-nobody-has', accountId: 'acct-nobody' })).toBeNull();
    expect(w.cw.privacy.find({ accountId: 'acct-nobody' })).toBeNull();
    expect(w.cw.privacy.find({})).toBeNull();
    await w.cw.flush();
    expect((await w.store.loadSubjects()).subjects.length).toBe(subjects);
    expect(dump(w.store)).toBe(before);
  });

  it('an IP alone finds nobody, even the exact address the person used', async () => {
    const w = await privacyWorld();
    expect(w.cw.privacy.find({ ip: A.ip })).toBeNull();
    expect(w.cw.privacy.find({ ip: A.ip, clientKey: '' })).toBeNull();
  });

  it('a key and an account of two different people give the one a merge would keep (the older), and merge nothing', async () => {
    const w = await privacyWorld();
    const before = w.cw.people.aliases(w.aId);
    const found = w.cw.privacy.find({ clientKey: A.key, accountId: B.account });
    expect([w.aId, w.bId]).toContain(found);
    await w.cw.flush();
    expect(w.cw.people.aliases(w.aId)).toEqual(before);
    expect(w.cw.people.aliases(w.bId).length).toBe(1);
  });

  it('a merged alias finds the surviving person', async () => {
    const w = await privacyWorld();
    const alias = await mergeAlias(w);
    expect(alias).not.toBe(w.cw.people.canonical(w.aId));
    expect(w.cw.privacy.find({ clientKey: 'key-a-second' })).toBe(w.cw.people.canonical(w.aId));
  });

  it('is synchronous, writes nothing (no audit row here: the route audits) and never throws on a bad value', async () => {
    const w = await privacyWorld();
    await fillA(w);
    const before = dump(w.store);
    for (const bad of [null, undefined, 7, 'str', { accountId: 7 }, { clientKey: {} }, { accountId: '' }]) {
      expect(() => w.cw.privacy.find(bad as never)).not.toThrow();
      expect(w.cw.privacy.find(bad as never)).toBeNull();
    }
    expect(dump(w.store)).toBe(before);
  });

  it('after an erase the person is not found any more', async () => {
    const w = await privacyWorld();
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: 'owner_ann' });
    expect(w.cw.privacy.find({ accountId: A.account })).toBeNull();
    expect(w.cw.privacy.find({ clientKey: A.key })).toBeNull();
  });
});
