import { describe, expect, expectTypeOf, it } from 'vitest';
import type { KitEvent } from '../src/events.js';
import { MIN, world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';

// U6: ask for a second look and escalate to the owner (desk.workflow). A flag and a thread entry: it never touches the claim, never blocks a decision and never reorders the queue.

const MOD = 'mod_ann';
const MOD_B = 'mod_bea';
const SENIOR = 'sen_cy';
const SENIOR_B = 'sen_di';
const OWNER_ID = 'owner_ed';
const on = () => world({ overrides: { desk: { workflow: true } } });
const file = (w: World) => w.file({ reason: 'harassment' });

describe('cw.cases.escalate', () => {
  it('each allowed pair: a moderator asks a senior or the owner, a senior asks a senior or the owner', async () => {
    for (const [role, actor] of [['moderator', MOD], ['senior', SENIOR]] as const) {
      for (const to of ['senior', 'owner'] as const) {
        const w = await on();
        const f = await file(w);
        expect(w.cw.cases.escalate(f.id, actor, role, { to }), `${role} -> ${to}`).toEqual({ ok: true });
        expect(w.store.loadReport(f.id)).toMatchObject({ escalatedTo: to, escalatedBy: actor, escalatedAt: w.clock.t });
      }
    }
  });

  it('an owner escalating is not_allowed, an unknown role or target or a missing to is invalid, nothing written', async () => {
    const w = await on();
    const f = await file(w);
    expect(w.cw.cases.escalate(f.id, OWNER_ID, 'owner', { to: 'owner' })).toEqual({ ok: false, refused: 'not_allowed' });
    expect(w.cw.cases.escalate(f.id, OWNER_ID, 'owner', { to: 'senior' })).toEqual({ ok: false, refused: 'not_allowed' });
    for (const to of ['moderator', 'admin', '', null, undefined, 3]) {
      expect(w.cw.cases.escalate(f.id, MOD, 'moderator', { to } as never), String(to)).toEqual({ ok: false, refused: 'invalid' });
    }
    expect(w.cw.cases.escalate(f.id, MOD, 'moderator', {} as never)).toEqual({ ok: false, refused: 'invalid' });
    expect(w.cw.cases.escalate(f.id, MOD, 'moderator', null as never)).toEqual({ ok: false, refused: 'invalid' });
    expect(() => w.cw.cases.escalate(f.id, MOD, 'admin' as never, { to: 'senior' })).toThrow(RangeError);
    expect(() => w.cw.cases.escalate(f.id, '', 'moderator', { to: 'senior' })).toThrow(RangeError);
    expect(w.store.loadReport(f.id)).toMatchObject({ escalatedTo: null });
    expect(w.store.listComments?.(f.id)).toEqual([]);
  });

  it('a decided report is closed, an unknown one not_found', async () => {
    const w = await on();
    const f = await file(w);
    await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD });
    expect(w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior' })).toEqual({ ok: false, refused: 'closed' });
    expect(w.cw.cases.escalate('nope', MOD, 'moderator', { to: 'senior' })).toEqual({ ok: false, refused: 'not_found' });
  });

  it('the claim is untouched, and the report can still be decided by anyone', async () => {
    const w = await on();
    const f = await file(w);
    w.cw.cases.claim(f.target, MOD_B);
    const before = w.cw.cases.holder(f.target);
    expect(w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior' })).toEqual({ ok: true });
    expect(w.cw.cases.holder(f.target)).toEqual(before);
    expect(await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD_B })).toMatchObject({ ok: true });
  });

  it('a note becomes a thread entry (ask for a senior, escalate for the owner); with no note the entry has no text', async () => {
    const w = await on();
    const f = await file(w);
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior', note: 'please look at line 3' });
    w.clock.t += MIN;
    w.cw.cases.escalate(f.id, SENIOR, 'senior', { to: 'owner' });
    const thread = w.cw.comments.list(f.id);
    expect(thread.map((c) => [c.kind, c.author, c.role, c.text])).toEqual([
      ['ask', MOD, 'moderator', 'please look at line 3'],
      ['escalate', SENIOR, 'senior', null],
    ]);
    // the second ask replaced the first: the report now asks the owner
    expect(w.store.loadReport(f.id)).toMatchObject({ escalatedTo: 'owner', escalatedBy: SENIOR });
  });

  it('a note over 500 code points, or one that is only invisible characters, is refused whole; a blank note is no note', async () => {
    const w = await on();
    const f = await file(w);
    expect(w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior', note: 'n'.repeat(501) })).toEqual({ ok: false, refused: 'invalid' });
    expect(w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior', note: 5 as never })).toEqual({ ok: false, refused: 'invalid' });
    expect(w.store.loadReport(f.id)?.escalatedTo).toBeNull();
    expect(w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior', note: '  \u{200b} ' })).toEqual({ ok: true });
    expect(w.cw.comments.list(f.id)[0]).toMatchObject({ kind: 'ask', text: null });
  });

  it('a full thread does not stop the ask: the columns are set and no entry is added', async () => {
    const w = await on();
    const f = await file(w);
    for (let i = 0; i < 50; i++) w.cw.comments.add(f.id, MOD, 'moderator', `c${i}`);
    expect(w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior', note: 'late' })).toEqual({ ok: true });
    expect(w.store.loadReport(f.id)?.escalatedTo).toBe('senior');
    expect(w.store.countComments?.(f.id)).toBe(50);
  });

  it('case.escalated holds ids, the target role and a time, after the commit, once per ask', async () => {
    const w = await on();
    const f = await file(w);
    const events: Array<{ e: KitEvent; stored: string | null | undefined }> = [];
    w.cw.on('case.escalated', (e) => void events.push({ e, stored: w.store.loadReport(e.reportId)?.escalatedTo }));
    w.clock.t += 5 * MIN;
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior', note: 'quissel private note' });
    expect(events).toHaveLength(1);
    expect(events[0]?.e).toEqual({ type: 'case.escalated', reportId: f.id, to: 'senior', at: w.clock.t });
    expect(events[0]?.stored).toBe('senior');
    expect(JSON.stringify(events)).not.toMatch(/quissel|mod_ann/);
    // a refused ask announces nothing
    w.cw.cases.escalate(f.id, OWNER_ID, 'owner', { to: 'owner' });
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'nobody' as never });
    expect(events).toHaveLength(1);
  });

  it('a listener that throws never changes the answer (fenced)', async () => {
    const w = await on();
    const f = await file(w);
    w.cw.on('case.escalated', () => {
      throw new Error('boom');
    });
    expect(w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior' })).toEqual({ ok: true });
    expect(w.store.loadReport(f.id)?.escalatedTo).toBe('senior');
  });

  it('does not reorder take next, and the change token moves', async () => {
    const w = await on();
    const a = await file(w);
    w.clock.t += MIN;
    const b = await file(w);
    const before = w.cw.changes.token();
    w.cw.cases.escalate(b.id, MOD, 'moderator', { to: 'owner' });
    expect(w.cw.changes.token()).not.toBe(before);
    expect(w.cw.cases.next(MOD_B)?.reportId).toBe(a.id);
  });

  it('is off with the workflow off', async () => {
    const w = await world();
    const f = await file(w);
    expect(w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior' })).toEqual({ ok: false, refused: 'off' });
    expect(w.cw.cases.clearEscalation(f.id, MOD, 'moderator')).toEqual({ ok: false, refused: 'off' });
    expect(w.store.loadReport(f.id)?.escalatedTo).toBeNull();
  });

  it('result types', () => {
    type E = ReturnType<Awaited<ReturnType<typeof world>>['cw']['cases']['escalate']>;
    expectTypeOf<E>().toEqualTypeOf<{ ok: true } | { ok: false; refused: 'off' | 'not_found' | 'closed' | 'invalid' | 'not_allowed' }>();
  });
});

describe('deciding clears the escalation', () => {
  it('in the same transaction: a decided report has none, and the asked count follows', async () => {
    const w = await on();
    const f = await file(w);
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior' });
    expect(w.store.countOpenEscalated?.()).toEqual({ senior: 1, owner: 0 });
    await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD });
    expect(w.store.loadReport(f.id)).toMatchObject({ escalatedTo: null, escalatedBy: null, escalatedAt: null });
    expect(w.store.countOpenEscalated?.()).toEqual({ senior: 0, owner: 0 });
  });

  it('a decision that fails leaves the escalation as it was', async () => {
    const w = await on();
    const f = await file(w);
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior' });
    const real = w.store.insertDecision.bind(w.store);
    w.store.insertDecision = () => {
      throw new Error('disk full');
    };
    await expect(w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD })).rejects.toThrow('disk full');
    w.store.insertDecision = real;
    expect(w.store.loadReport(f.id)).toMatchObject({ status: 'open', escalatedTo: 'senior' });
  });

  it('a bulk dismissal clears it too', async () => {
    const w = await on();
    const f = await file(w);
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'owner' });
    await w.cw.reports.dismissMany({ scope: { person: f.target }, actor: MOD });
    expect(w.store.loadReport(f.id)?.escalatedTo).toBeNull();
  });
});

describe('cw.cases.clearEscalation', () => {
  it('by the asker, and by anyone at or above the target: a senior for a senior ask, the owner for any; refused for an unrelated moderator', async () => {
    const w = await on();
    const f = await file(w);
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior' });
    expect(w.cw.cases.clearEscalation(f.id, MOD_B, 'moderator')).toEqual({ ok: false, refused: 'not_allowed' });
    expect(w.store.loadReport(f.id)?.escalatedTo).toBe('senior');
    expect(w.cw.cases.clearEscalation(f.id, SENIOR, 'senior')).toEqual({ ok: true });
    expect(w.store.loadReport(f.id)?.escalatedTo).toBeNull();
    // the asker clears their own
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'owner' });
    expect(w.cw.cases.clearEscalation(f.id, MOD, 'moderator')).toEqual({ ok: true });
    // a senior cannot clear an ask of the owner by someone else; the owner can
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'owner' });
    expect(w.cw.cases.clearEscalation(f.id, SENIOR_B, 'senior')).toEqual({ ok: false, refused: 'not_allowed' });
    expect(w.cw.cases.clearEscalation(f.id, OWNER_ID, 'owner')).toEqual({ ok: true });
  });

  it('a second clear is a no-op: ok, no write, no entry', async () => {
    const w = await on();
    const f = await file(w);
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior' });
    expect(w.cw.cases.clearEscalation(f.id, MOD, 'moderator')).toEqual({ ok: true });
    const token = w.cw.changes.token();
    const entries = w.store.countComments?.(f.id);
    expect(w.cw.cases.clearEscalation(f.id, MOD_B, 'moderator')).toEqual({ ok: true });
    expect(w.cw.changes.token()).toBe(token);
    expect(w.store.countComments?.(f.id)).toBe(entries);
  });

  it('writes a clear entry to the thread; unknown and decided reports are refused', async () => {
    const w = await on();
    const f = await file(w);
    w.cw.cases.escalate(f.id, MOD, 'moderator', { to: 'senior' });
    w.clock.t += 1000;
    w.cw.cases.clearEscalation(f.id, SENIOR, 'senior');
    expect(w.cw.comments.list(f.id).map((c) => [c.kind, c.author])).toEqual([['ask', MOD], ['clear', SENIOR]]);
    expect(w.cw.cases.clearEscalation('nope', MOD, 'moderator')).toEqual({ ok: false, refused: 'not_found' });
    await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD });
    expect(w.cw.cases.clearEscalation(f.id, MOD, 'moderator')).toEqual({ ok: false, refused: 'closed' });
  });
});

describe('cw.desk.workflowEnabled', () => {
  it('reads the profile in force', async () => {
    expect((await world()).cw.desk.workflowEnabled()).toBe(false);
    expect((await on()).cw.desk.workflowEnabled()).toBe(true);
  });
});
