import { describe, expect, expectTypeOf, it } from 'vitest';
import type { KitEvent } from '../src/events.js';
import { MIN, world } from './reportingWorld.js';

// U4: cw.cases.setUrgent and cw.cases.handoff, and cw.cases.urgentCount. A hand-off is a mark: it contacts no one and writes nothing to the person.

const MOD = 'mod_ann';
const MOD_B = 'mod_bea';

describe('cw.cases.setUrgent and urgentCount', () => {
  it('turns urgent on and off by a moderator, not_found for an unknown id, closed for a decided one; urgentCount follows', async () => {
    const w = await world();
    const f = await w.file({ reason: 'harassment' });
    const t = await w.file({ reason: 'threat' });
    expect(w.cw.cases.urgentCount()).toBe(1);
    expect(w.cw.cases.setUrgent(f.id, MOD, true)).toEqual({ ok: true });
    expect(w.cw.cases.urgentCount()).toBe(2);
    expect(w.store.loadReport(f.id)?.urgent).toBe(true);
    expect(w.cw.cases.setUrgent(f.id, MOD, true)).toEqual({ ok: true });
    expect(w.cw.cases.urgentCount()).toBe(2);
    expect(w.cw.cases.setUrgent(t.id, MOD, false)).toEqual({ ok: true });
    expect(w.cw.cases.urgentCount()).toBe(1);
    expect(w.cw.cases.setUrgent('nope', MOD, true)).toEqual({ ok: false, refused: 'not_found' });
    await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD });
    expect(w.cw.cases.setUrgent(f.id, MOD, false)).toEqual({ ok: false, refused: 'closed' });
    expect(w.store.loadReport(f.id)?.urgent).toBe(true);
    expect(w.cw.cases.urgentCount()).toBe(0);
  });

  it('a malformed actor or flag is a RangeError, nothing written', async () => {
    const w = await world();
    const f = await w.file({ reason: 'harassment' });
    expect(() => w.cw.cases.setUrgent(f.id, '', true)).toThrow(RangeError);
    expect(() => w.cw.cases.setUrgent(f.id, 'has space', true)).toThrow(RangeError);
    expect(() => w.cw.cases.setUrgent(f.id, MOD, 'yes' as never)).toThrow(RangeError);
    expect(w.store.loadReport(f.id)?.urgent).toBe(false);
  });

  it('it moves the change token, announces nothing and writes nothing to the person', async () => {
    const w = await world();
    const f = await w.file({ reason: 'harassment' });
    const events: KitEvent[] = [];
    w.cw.on('*', (e) => void events.push(e));
    const before = w.cw.changes.token();
    w.cw.cases.setUrgent(f.id, MOD, true);
    expect(w.cw.changes.token()).not.toBe(before);
    expect(events).toEqual([]);
    expect(w.cw.notices.pending({ clientKey: 'key-target-1' })).toEqual([]);
  });

  it('the result type is ok or one of two refusals', () => {
    type R = ReturnType<Awaited<ReturnType<typeof world>>['cw']['cases']['setUrgent']>;
    expectTypeOf<R>().toEqualTypeOf<{ ok: true } | { ok: false; refused: 'not_found' | 'closed' }>();
  });
});

describe('cw.cases.handoff', () => {
  it('first call records actor and time and emits report.handoff once; the second is ok and changes nothing and emits nothing', async () => {
    const w = await world();
    const f = await w.file({ reason: 'threat' });
    const events: KitEvent[] = [];
    w.cw.on('report.handoff', (e) => void events.push(e));
    w.clock.t += 5 * MIN;
    const at = w.clock.t;
    expect(w.cw.cases.handoff(f.id, MOD)).toEqual({ ok: true });
    expect(w.store.loadReport(f.id)).toMatchObject({ handoffBy: MOD, handoffAt: at });
    expect(events).toEqual([{ type: 'report.handoff', reportId: f.id, at }]);
    w.clock.t += 5 * MIN;
    expect(w.cw.cases.handoff(f.id, MOD_B)).toEqual({ ok: true });
    expect(w.store.loadReport(f.id)).toMatchObject({ handoffBy: MOD, handoffAt: at });
    expect(events).toHaveLength(1);
  });

  it('is allowed on an ordinary open report too, and works with the workflow off', async () => {
    const w = await world();
    const f = await w.file({ reason: 'harassment' });
    expect(w.cw.cases.handoff(f.id, MOD)).toEqual({ ok: true });
    expect(w.store.loadReport(f.id)?.handoffBy).toBe(MOD);
  });

  it('closed and not_found refusals, and a decided report keeps no new mark', async () => {
    const w = await world();
    const f = await w.file({ reason: 'threat' });
    expect(w.cw.cases.handoff('nope', MOD)).toEqual({ ok: false, refused: 'not_found' });
    await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD });
    expect(w.cw.cases.handoff(f.id, MOD)).toEqual({ ok: false, refused: 'closed' });
    expect(w.store.loadReport(f.id)?.handoffAt).toBeNull();
  });

  it('the event holds ids and a time only, and emits after the commit (the report reads back from inside the listener)', async () => {
    const w = await world();
    const f = await w.file({ reason: 'threat', note: 'quissel note' });
    const seen: Array<{ keys: string[]; handoffBy: string | null | undefined }> = [];
    w.cw.on('report.handoff', (e) => void seen.push({ keys: Object.keys(e).sort(), handoffBy: w.store.loadReport(e.reportId)?.handoffBy }));
    w.cw.cases.handoff(f.id, MOD);
    expect(seen).toEqual([{ keys: ['at', 'reportId', 'type'], handoffBy: MOD }]);
  });

  it('writes nothing to the person: no notice, no strike, no sanction, no restriction', async () => {
    const w = await world();
    const f = await w.file({ reason: 'threat' });
    w.cw.cases.handoff(f.id, MOD);
    const key = { clientKey: 'key-target-1' };
    expect(w.cw.notices.pending(key)).toEqual([]);
    expect(w.cw.sanctions.forPerson(f.target)).toEqual([]);
    expect(w.cw.chat.restricted(key, { roomId: f.room, seatId: 'p2' })).toMatchObject({ restricted: false });
    expect(w.cw.audit.list({ limit: 10 }).items).toEqual([]);
  });

  it('a listener that throws never changes the answer or the stored mark (fenced)', async () => {
    const w = await world();
    const f = await w.file({ reason: 'threat' });
    w.cw.on('report.handoff', () => {
      throw new Error('listener boom');
    });
    expect(w.cw.cases.handoff(f.id, MOD)).toEqual({ ok: true });
    expect(w.store.loadReport(f.id)?.handoffBy).toBe(MOD);
    expect(w.logged.some(([e]) => e === 'chatwarden.listener_failed')).toBe(true);
  });

  it('a store failure is thrown, nothing is announced', async () => {
    const w = await world();
    const f = await w.file({ reason: 'threat' });
    const events: KitEvent[] = [];
    w.cw.on('report.handoff', (e) => void events.push(e));
    w.store.setHandoff = () => {
      throw new Error('disk full');
    };
    expect(() => w.cw.cases.handoff(f.id, MOD)).toThrow('disk full');
    expect(events).toEqual([]);
  });

  it('a malformed actor is a RangeError and nothing is written', async () => {
    const w = await world();
    const f = await w.file({ reason: 'threat' });
    expect(() => w.cw.cases.handoff(f.id, '')).toThrow(RangeError);
    expect(w.store.loadReport(f.id)?.handoffAt).toBeNull();
  });
});
