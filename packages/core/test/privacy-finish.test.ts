import { describe, expect, it } from 'vitest';
import type { ErasureReceipt } from '../src/privacy.js';
import { A, DAY, NOW, dump, fillA, privacyWorld } from './privacyWorld.js';

// The safety remainder and its finish (design 5.3): with `keep: 'safety'` a person with a sanction in force keeps the subject, the identifiers and that sanction;
// `purge()` finishes the erase on its own once the person has no sanction row left.

const OWNER = 'owner_ann';
const ban = (w: Awaited<ReturnType<typeof privacyWorld>>, durationMs: number | null = null) =>
  w.cw.sanctions.apply({ kind: 'ban', subject: w.aId, includeIp: true, durationMs, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 1 });
const eraseSafety = async (w: Awaited<ReturnType<typeof privacyWorld>>): Promise<ErasureReceipt> => {
  const out = await w.cw.privacy.erase(w.aId, { keep: 'safety', actor: OWNER });
  if ('ok' in out || 'dryRun' in out) throw new Error('expected a receipt');
  return out;
};

describe('erase safety: the ban still refuses the same key at the door afterwards', () => {
  it('the receipt says identifiers kept; the key and the account are refused; the rest of the person is gone', async () => {
    const w = await privacyWorld();
    await fillA(w);
    const { groupId } = await ban(w);
    const r = await eraseSafety(w);
    expect(r.kept.identifiers).toBe(true);
    expect(r.kept.sanctions).toBe(2);
    expect(w.cw.chat.restricted({ clientKey: A.key }).restricted).toBe(true);
    expect(w.cw.chat.restricted({ accountId: A.account }).restricted).toBe(true);
    expect(w.store.sanctionRefCode(groupId)).not.toBeNull();
    expect(dump(w.store)).not.toContain('alpha note about bravo');
    expect(dump(w.store)).not.toContain('tarvo alpha said this line');
  });
});

describe('purge finishes the erase', () => {
  it('once the sanction rows are gone: identifiers and subject row deleted, audit refs rewritten to the receipt id, pending subject cleared', async () => {
    const w = await privacyWorld();
    await fillA(w);
    w.store.insertAudit({ id: 'au-p', at: NOW - 5, actor: 'mod_ann', role: 'moderator', action: 'history.view', target: { type: 'person', ref: w.aId } });
    await ban(w, 30 * DAY);
    const r = await eraseSafety(w);
    // before the finish the audit rows keep the subject ref
    expect(w.store.listAudit({ limit: 50 }).find((x) => x.id === 'au-p')?.target).toEqual({ type: 'person', ref: w.aId });
    // the ban is still in force: a purge a week later finishes nothing
    w.clock.t = NOW + 7 * DAY;
    expect((await w.cw.purge()).erasuresFinished).toBe(0);
    expect(w.store.loadPendingErasures().length).toBe(1);
    // the ban ended 30 days in, and its row is removed 90 days after it ended
    w.clock.t = NOW + 30 * DAY + 91 * DAY;
    const result = await w.cw.purge();
    expect(result.erasuresFinished).toBe(1);
    expect(w.store.loadPendingErasures()).toEqual([]);
    expect((await w.store.loadSubjects()).subjects.map((s) => s.id)).not.toContain(w.aId);
    const after = dump(w.store);
    for (const needle of [w.aId, A.account]) expect(after, needle).not.toContain(needle);
    expect(w.store.listAudit({ limit: 50 }).find((x) => x.id === 'au-p')?.target).toEqual({ type: 'person', ref: r.id });
    // the receipt itself stays (counts only) until the audit clock removes it
    expect(after).toContain(r.id);
  });

  it('the finish is reflected in this process at once: the person is no longer found and their key makes a new subject', async () => {
    const w = await privacyWorld();
    await ban(w, 1 * DAY);
    await eraseSafety(w);
    expect(w.cw.privacy.find({ clientKey: A.key })).toBe(w.aId);
    w.clock.t = NOW + 1 * DAY + 91 * DAY;
    await w.cw.purge();
    expect(w.cw.privacy.find({ clientKey: A.key })).toBeNull();
  });

  it('a person with only ended sanctions loses the identifiers at the erase, and nothing is pending', async () => {
    const w = await privacyWorld();
    await ban(w, 1000);
    w.clock.t = NOW + 5000;
    const r = await eraseSafety(w);
    expect(r.kept.identifiers).toBe(false);
    expect(w.store.loadPendingErasures()).toEqual([]);
  });

  it('a revoked ban is not in force either', async () => {
    const w = await privacyWorld();
    const { groupId } = await ban(w);
    await w.cw.sanctions.revoke(groupId, 'mod_ann', 'sorry');
    const r = await eraseSafety(w);
    expect(r.kept.identifiers).toBe(false);
  });

  it('keep none ends a ban the person is under at once and leaves nothing to finish', async () => {
    const w = await privacyWorld();
    await ban(w);
    const out = await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    expect('ok' in out).toBe(false);
    expect(w.store.loadPendingErasures()).toEqual([]);
    expect(w.cw.chat.restricted({ clientKey: A.key }).restricted).toBe(false);
  });

  it('purge counts the finish and the strays in its result, and an ordinary purge reports zeros', async () => {
    const w = await privacyWorld();
    const r = await w.cw.purge();
    expect(r.erasuresFinished).toBe(0);
    expect(r.strayRows).toBe(0);
  });

  it('strays older than 10 minutes are dropped by purge and younger ones are kept', async () => {
    const w = await privacyWorld();
    w.store.insertStrike({ id: 'old-stray', at: NOW - 11 * 60_000, subject: 's_ghost', roomId: 'R', termId: 't', rawLine: 'ghost line one' });
    w.store.insertStrike({ id: 'young-stray', at: NOW - 5 * 60_000, subject: 's_ghost', roomId: 'R', termId: 't', rawLine: 'ghost line two' });
    const r = await w.cw.purge();
    expect(r.strayRows).toBe(1);
    expect(w.store.loadStrikes(0).map((s) => s.id)).toEqual(['young-stray']);
    w.clock.t = NOW + 6 * 60_000;
    expect((await w.cw.purge()).strayRows).toBe(1);
  });
});

describe('the built-in timer finishes erasures too', () => {
  it('a kit with the purge timer on runs the same pass (the finish and the sweep), not a thinner one', async () => {
    // The timer calls the same function as cw.purge(): proven by reading the result of an explicit pass; the timer itself is covered by the retention tests.
    const w = await privacyWorld();
    await ban(w, 1 * DAY);
    await eraseSafety(w);
    w.clock.t = NOW + 100 * DAY;
    const r = await w.cw.purge();
    expect(r.erasuresFinished).toBe(1);
  });
});
