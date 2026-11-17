import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { ErasureReceipt } from '../src/privacy.js';
import type { RawWho } from '../src/types.js';
import { A, B, DAY, NOW, dump, fillA, privacyWorld } from './privacyWorld.js';
import { fullStore } from './legalWorld.js';

// The fix round for the review of chunk 5 (privacy P1-P6): the facade-level behaviours of Important 3 and 4 and Minors 5 and 8.

const OWNER = 'owner_ann';
type World = Awaited<ReturnType<typeof privacyWorld>>;
const eraseSafety = async (w: World, person = w.aId): Promise<ErasureReceipt> => {
  const out = await w.cw.privacy.erase(person, { keep: 'safety', actor: OWNER });
  if ('ok' in out || 'dryRun' in out) throw new Error('expected a receipt');
  return out;
};
const second = (store: ReturnType<typeof fullStore>, clock: { t: number; now: () => number }) =>
  createChatwarden({ store, secret: 'reporting-secret', platform: { identify: (ctx) => ctx as RawWho }, clock, retention: false });

describe('Important 4: the finish and the sweep after an erase', () => {
  it('a safety erase finishes when the only sanction rows left are held ones; the held rows stay and the person is gone', async () => {
    const w = await privacyWorld();
    const { about } = await fillA(w);
    const res = await w.cw.decide({ reportId: about, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: w.aId, kind: 'ban', durationMs: DAY, rule: 2, lineIds: [], includeIp: false }] });
    if (!res.ok) throw new Error('decision refused');
    const groupId = res.groups[0]?.groupId as string;
    await w.cw.legal.hold(about, { code: 'legal_proceeding', actor: 'senior_gus' });
    const receipt = await eraseSafety(w);
    expect(receipt.kept.identifiers).toBe(true);
    expect(w.store.loadPendingErasures().length).toBe(1);
    // the ban is still running: nothing finishes
    w.clock.t = NOW + DAY / 2;
    expect((await w.cw.purge()).erasuresFinished).toBe(0);
    // the ban ended and its rows are held: retention cannot remove them, and the erase finishes anyway
    w.clock.t = NOW + 200 * DAY;
    const result = await w.cw.purge();
    expect(result.erasuresFinished).toBe(1);
    expect(w.store.loadPendingErasures()).toEqual([]);
    expect((await w.store.loadSubjects()).subjects.map((s) => s.id)).not.toContain(w.aId);
    expect(w.store.sanctionRefCode(groupId)).not.toBeNull();
    expect(w.store.loadReport(about)).not.toBeNull();
    expect(w.cw.privacy.find({ clientKey: A.key })).toBeNull();
  });

  it('control: without a hold the same ban blocks the finish until retention has removed its rows', async () => {
    const w = await privacyWorld();
    const { about } = await fillA(w);
    await w.cw.decide({ reportId: about, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: w.aId, kind: 'ban', durationMs: DAY, rule: 2, lineIds: [], includeIp: false }] });
    await eraseSafety(w);
    w.clock.t = NOW + 2 * DAY;
    expect((await w.cw.purge()).erasuresFinished).toBe(0);
    w.clock.t = NOW + 200 * DAY;
    expect((await w.cw.purge()).erasuresFinished).toBe(1);
  });

  it('the sweep after an erase covers the whole set the STORE erased, not just the aliases this process knows', async () => {
    const w = await privacyWorld();
    // another process merged an alias into the person: only the store knows it
    await w.store.saveSubject({ id: 's_alias_other', createdAt: NOW, mergedInto: null });
    await w.store.markMerged('s_alias_other', w.aId);
    expect(w.cw.people.aliases(w.aId)).toEqual([w.aId]);
    // a stale writer puts a row under that alias right after the erase commits
    const realErase = w.store.eraseSubjects.bind(w.store);
    w.store.eraseSubjects = (plan) => {
      const counts = realErase(plan);
      if (plan.dryRun !== true) w.store.insertStrike({ id: 'raced-alias', at: NOW, subject: 's_alias_other', roomId: 'R', termId: 't', rawLine: 'raced alias line' });
      return counts;
    };
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    expect(dump(w.store)).not.toContain('raced-alias');
    expect(dump(w.store)).not.toContain('s_alias_other');
  });
});

describe('Important 3: an erase here must not swallow another process\'s earlier erase', () => {
  const people = async () => {
    const store = fullStore();
    const w = await privacyWorld({}, store);
    const other = await second(store, w.clock);
    other.rooms.seat('R7', 'p1', { clientKey: A.key, accountId: A.account }, 'Alpha');
    other.rooms.seat('R7', 'p2', { clientKey: B.key, accountId: B.account }, 'Bravo');
    await other.flush();
    expect(other.rooms.subjectAt('R7', 'p1')).toBe(w.aId);
    return { store, w, other };
  };

  it('process 1 erases X, process 2 then erases Y: process 2 still reconciles X, drops its seat and no longer finds it', async () => {
    const { store, w, other } = await people();
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    await other.privacy.erase(w.bId, { keep: 'none', actor: OWNER });
    await other.flush();
    expect((await store.loadSubjects()).subjects).toEqual([]);
    expect(other.privacy.find({ clientKey: A.key })).toBeNull();
    expect(other.people.accountIds(w.aId)).toEqual([]);
    // the seat of X in process 2 became a guest at once: no line of X is ever written under the dead id
    expect(other.rooms.subjectAt('R7', 'p1')).toBeNull();
    other.chat.accept('R7', 'p1', 'zorbak after the erase');
    await other.flush();
    expect(dump(store)).not.toContain(w.aId);
    await other.close();
  });

  it('the erased person is not forgotten twice: process 2 does not reload for its own erase when nobody else erased', async () => {
    const { store, w, other } = await people();
    let loads = 0;
    const real = store.loadSubjects.bind(store);
    store.loadSubjects = () => {
      loads += 1;
      return real();
    };
    await other.privacy.erase(w.bId, { keep: 'none', actor: OWNER });
    await other.flush();
    w.clock.t = NOW + 120_000;
    other.rooms.seat('R8', 'p2', { clientKey: 'key-new-person' }, 'New');
    await other.flush();
    expect(loads).toBe(0);
    // the person nobody erased is still known here
    expect(other.people.accountIds(w.aId)).not.toEqual([]);
    await other.close();
  });

  it('two foreign erases and one of its own: every dead person goes', async () => {
    const store = fullStore();
    const w = await privacyWorld({}, store);
    w.seat('R5', 'p1', { key: 'key-c', account: 'acct-c', ip: '10.0.0.77', handle: 'Charlie' });
    await w.cw.flush();
    const cId = w.cw.rooms.subjectAt('R5', 'p1') as string;
    const other = await second(store, w.clock);
    other.rooms.seat('R7', 'p1', { clientKey: A.key, accountId: A.account }, 'Alpha');
    other.rooms.seat('R7', 'p2', { clientKey: B.key, accountId: B.account }, 'Bravo');
    other.rooms.seat('R7', 'p3', { clientKey: 'key-c', accountId: 'acct-c' }, 'Charlie');
    await other.flush();
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    await w.cw.privacy.erase(cId, { keep: 'none', actor: OWNER });
    await other.privacy.erase(w.bId, { keep: 'none', actor: OWNER });
    await other.flush();
    for (const id of [w.aId, w.bId, cId]) expect(other.people.accountIds(id), id).toEqual([]);
    await other.close();
  });

  it('a reconcile that failed to read the store is tried again at the next check, not forgotten', async () => {
    const { store, w, other } = await people();
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    // the reconcile of the foreign erase (queued when process 2 erases) fails once
    const real = store.loadSubjects.bind(store);
    let failed = false;
    store.loadSubjects = () => {
      if (!failed) {
        failed = true;
        return Promise.reject(new TypeError('busy'));
      }
      return real();
    };
    await other.privacy.erase(w.bId, { keep: 'none', actor: OWNER });
    await other.flush();
    expect(failed).toBe(true);
    expect(other.people.accountIds(w.aId)).not.toEqual([]);
    w.clock.t = NOW + 31_000;
    other.privacy.find({ clientKey: 'anyone' });
    await other.flush();
    expect(other.people.accountIds(w.aId)).toEqual([]);
    await other.close();
  });
});

describe('Minor 5: a report whose reporter was erased tells nobody', () => {
  it('upheld: the target gets its notice and no notice is written for `erased:<id>`', async () => {
    const w = await privacyWorld();
    const { filed } = await fillA(w);
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    expect(w.store.loadReport(filed)?.reporterSubject).toBe(`erased:${filed}`);
    const res = await w.cw.decide({ reportId: filed, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: w.bId, kind: 'chat', durationMs: DAY, rule: 2, lineIds: [] }] });
    expect(res.ok).toBe(true);
    expect(w.store.loadNotices([`erased:${filed}`])).toEqual([]);
    expect(dump(w.store)).not.toContain(`"subject":"erased:`);
    expect(w.store.loadNotices([w.bId]).some((n) => n.kind === 'chat')).toBe(true);
  });

  it('control: a reporter who is still a person is told, as before', async () => {
    const w = await privacyWorld();
    const { about } = await fillA(w);
    const res = await w.cw.decide({ reportId: about, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: w.aId, kind: 'chat', durationMs: DAY, rule: 2, lineIds: [] }] });
    expect(res.ok).toBe(true);
    expect(w.store.loadNotices([w.bId]).some((n) => n.kind === 'report_outcome')).toBe(true);
  });

  it('a decision cannot act on the erased reporter value as if it were a person', async () => {
    const w = await privacyWorld();
    const { filed } = await fillA(w);
    await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    const res = await w.cw.decide({ reportId: filed, verdict: 'bad_faith', actor: 'mod_ann', reason: 'r', evidence: 'x'.repeat(10), actions: [{ subject: `erased:${filed}`, kind: 'warning', durationMs: null, rule: 2, lineIds: [] }] });
    expect(res.ok).toBe(false);
    expect(dump(w.store)).not.toMatch(/"subject":"erased:/);
  });
});

describe('Minor 8: an export and a receipt say only that something is held, never why', () => {
  it('the export holds a count; neither it nor the receipt carries the code, the report id or the time of a hold', async () => {
    const w = await privacyWorld();
    const { about } = await fillA(w);
    await w.cw.legal.hold(about, { code: 'law_enforcement_request', actor: 'senior_gus' });
    const exported = await w.cw.privacy.export(w.aId);
    if ('ok' in exported) throw new Error('expected an export');
    expect(exported.sections.holds).toEqual({ reports: 1 });
    expect(JSON.stringify(exported)).not.toContain('law_enforcement');
    expect(JSON.stringify(exported)).not.toContain(about);
    const receipt = await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    expect(JSON.stringify(receipt)).not.toContain('law_enforcement');
    expect(JSON.stringify(receipt)).not.toContain(about);
    expect((receipt as ErasureReceipt).kept.heldReports).toBe(1);
  });

  it('with no hold the export says zero', async () => {
    const w = await privacyWorld();
    const exported = await w.cw.privacy.export(w.aId);
    if ('ok' in exported) throw new Error('expected an export');
    expect(exported.sections.holds).toEqual({ reports: 0 });
  });
});
