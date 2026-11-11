import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import type { StoredReportRow } from '@chatwarden/store-memory';
import { REPORT_NOTE_MAX } from '../src/reports.js';
import type { Store } from '../src/types.js';
import { MIN, OWNER, world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';

// `cw.reports.addDetail(reportId, reporterSeat, { reason?, note? })`: the optional follow-up after a one-tap report. Only the
// reporter, once, within ten minutes, never touching the target or the excerpt.

const row = (w: World, id: string): StoredReportRow => {
  const r = (w.store as MemoryStore).rawReports().find((x) => x.id === id);
  if (r === undefined) throw new Error('no such report');
  return r;
};

async function oneTap(over: Parameters<typeof world>[0] = {}) {
  const w = await world(over);
  const t = w.table();
  w.cw.rooms.seat(t.room, 'p3', { clientKey: 'key-bystander' }, 'Bystander');
  w.cw.chat.accept(t.room, 'p2', 'a line the reporter saw');
  const res = await w.submit(t.room);
  if (!res.ok) throw new Error('refused');
  return { w, f: { ...t, id: res.reportId } };
}

describe('a follow-up that works', () => {
  it('adds a reason and a note to a report that had none', async () => {
    const { w, f } = await oneTap();
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'harassment', note: 'kept going after I muted' })).toEqual({ ok: true });
    const r = row(w, f.id);
    expect(r).toMatchObject({ reportedReason: 'harassment', note: 'kept going after I muted', category: 'harassment', detailAt: w.clock.t });
  });

  it('a reason alone, and a note alone, both work', async () => {
    const a = await oneTap();
    expect(await a.w.cw.reports.addDetail(a.f.id, 'p1', { reason: 'spam' })).toEqual({ ok: true });
    expect(row(a.w, a.f.id)).toMatchObject({ reportedReason: 'spam', note: null });
    const b = await oneTap();
    expect(await b.w.cw.reports.addDetail(b.f.id, 'p1', { note: 'only words' })).toEqual({ ok: true });
    expect(row(b.w, b.f.id)).toMatchObject({ reportedReason: null, note: 'only words' });
  });

  it('keeps what the report already had when the follow-up leaves it out; replaces what it gives', async () => {
    const w = await world();
    const f = await w.file({ reason: 'hate', note: 'first words' });
    expect(await w.cw.reports.addDetail(f.id, 'p1', { note: 'better words' })).toEqual({ ok: true });
    expect(row(w, f.id)).toMatchObject({ reportedReason: 'hate', note: 'better words' });
    const g = await w.file({ reason: 'hate', note: 'first words' });
    expect(await w.cw.reports.addDetail(g.id, 'p1', { reason: 'cheating' })).toEqual({ ok: true });
    expect(row(w, g.id)).toMatchObject({ reportedReason: 'cheating', note: 'first words', category: 'cheating' });
  });

  it('accepts the old alias and stores the new id', async () => {
    const { w, f } = await oneTap();
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'disruption' })).toEqual({ ok: true });
    expect(row(w, f.id)).toMatchObject({ reportedReason: 'griefing', category: 'disruption' });
  });

  it('trims the note and cuts it to 500 characters like a report note; a blank note is not given', async () => {
    const { w, f } = await oneTap();
    expect(await w.cw.reports.addDetail(f.id, 'p1', { note: `  ${'x'.repeat(600)}  ` })).toEqual({ ok: true });
    expect(row(w, f.id).note).toBe('x'.repeat(REPORT_NOTE_MAX));
    const g = await oneTap();
    expect(await g.w.cw.reports.addDetail(g.f.id, 'p1', { note: '   ' })).toEqual({ ok: true });
    expect(row(g.w, g.f.id).detailAt).toBeNull();
  });

  it('never changes the target, the excerpt, the line, the people, the room, the time or the status', async () => {
    const { w, f } = await oneTap();
    const before = structuredClone(row(w, f.id));
    await w.cw.reports.addDetail(f.id, 'p1', { reason: 'threat', note: 'n' });
    const after = row(w, f.id);
    for (const key of ['targetSubject', 'targetSeat', 'targetHandle', 'excerpt', 'lineId', 'people', 'roomId', 'createdAt', 'status', 'reporterSubject', 'reporterSeat', 'tags'] as const) {
      expect(after[key], key).toEqual(before[key]);
    }
    expect(after.excerpt.length).toBeGreaterThan(0);
  });

  it('does not announce again: no second report.created and no onReport call', async () => {
    const heard: unknown[] = [];
    const events: unknown[] = [];
    const w = await world({ onReport: (r) => void heard.push(r.id) });
    w.cw.on('*', (e) => void events.push(e));
    const f = await w.file({});
    await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' });
    expect(heard).toHaveLength(1);
    expect(events.filter((e) => (e as { type: string }).type === 'report.created')).toHaveLength(1);
  });

  it('shows on the staff record as reportedReason and detailAt', async () => {
    const { w, f } = await oneTap();
    w.clock.t += 2 * MIN;
    await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' });
    expect(w.cw.reports.get(f.id)).toMatchObject({ reportedReason: 'hate', detailAt: w.clock.t });
  });

  it('works in the reason_required flow too (the follow-up may change the reason, which must be valid)', async () => {
    const w = await world({ overrides: { reporting: { flow: 'reason_required' } } });
    const f = await w.file({ reason: 'hate' });
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'sexual' })).toEqual({ ok: true });
    expect(row(w, f.id).reportedReason).toBe('sexual');
  });
});

describe('once only', () => {
  it('a second follow-up is already_added and changes nothing', async () => {
    const { w, f } = await oneTap();
    await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate', note: 'first' });
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'spam', note: 'second' })).toEqual({ ok: false, refused: 'already_added' });
    expect(row(w, f.id)).toMatchObject({ reportedReason: 'hate', note: 'first' });
  });

  it('a refused follow-up does not use up the one allowed (unknown reason, an empty one)', async () => {
    const { w, f } = await oneTap();
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'bogus' })).toEqual({ ok: false, refused: 'reason_unknown' });
    expect(await w.cw.reports.addDetail(f.id, 'p1', {})).toEqual({ ok: true });
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: null, note: '' })).toEqual({ ok: true });
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: true });
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'spam' })).toEqual({ ok: false, refused: 'already_added' });
  });

  it('a store that says no (a concurrent first follow-up won) answers already_added', async () => {
    class Racing extends MemoryStore {
      override addReportDetail(): boolean {
        return false;
      }
    }
    const store = new Racing();
    const w = await world({}, store);
    const f = await w.file({});
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: false, refused: 'already_added' });
  });

  it('two concurrent follow-ups: exactly one wins', async () => {
    const { w, f } = await oneTap();
    const results = await Promise.all([
      w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' }),
      w.cw.reports.addDetail(f.id, 'p1', { reason: 'spam' }),
    ]);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok)).toEqual([{ ok: false, refused: 'already_added' }]);
  });
});

describe('who may add it', () => {
  it('not_found: an unknown id, an empty one, a non-text one', async () => {
    const { w } = await oneTap();
    for (const id of ['nope', '', 5, null, undefined, {}]) {
      expect(await w.cw.reports.addDetail(id as never, 'p1', { reason: 'hate' }), String(id)).toEqual({ ok: false, refused: 'not_found' });
    }
  });

  it('not_reporter: the target, a bystander, a seat that is not the reporter seat, an empty or non-text seat', async () => {
    const { w, f } = await oneTap();
    for (const seat of ['p2', 'p3', 'p9', '', 7, null, undefined]) {
      expect(await w.cw.reports.addDetail(f.id, seat as never, { reason: 'hate' }), String(seat)).toEqual({ ok: false, refused: 'not_reporter' });
    }
    expect(row(w, f.id).detailAt).toBeNull();
  });

  it('not_reporter: the reporter has left the seat, or someone else has taken it', async () => {
    const { w, f } = await oneTap();
    w.cw.rooms.unseat(f.room, 'p1');
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: false, refused: 'not_reporter' });
    w.cw.rooms.seat(f.room, 'p1', { clientKey: 'key-newcomer' }, 'New');
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: false, refused: 'not_reporter' });
    expect(row(w, f.id).detailAt).toBeNull();
  });

  it('the same person back in the same seat is the reporter again', async () => {
    const { w, f } = await oneTap();
    w.cw.rooms.unseat(f.room, 'p1');
    w.cw.rooms.seat(f.room, 'p1', { clientKey: 'key-reporter' }, 'Rep again');
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: true });
  });

  it('the seat must be the one the report was filed from, even for the same person in another seat', async () => {
    const { w, f } = await oneTap();
    w.cw.rooms.seat(f.room, 'p4', { clientKey: 'key-reporter' }, 'Rep on another seat');
    expect(await w.cw.reports.addDetail(f.id, 'p4', { reason: 'hate' })).toEqual({ ok: false, refused: 'not_reporter' });
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: true });
  });

  it('the seat is looked up in the report room: the same seat name in another room is somebody else', async () => {
    const w = await world();
    const a = await w.file({}, { reporter: 'key-a' });
    const b = await w.table({ reporter: 'key-b' });
    expect(b.room).not.toBe(a.room);
    // key-b sits in p1 of its own room; the report is in a's room, where p1 is key-a: the lookup never leaves the report's room.
    w.cw.rooms.unseat(a.room, 'p1');
    expect(await w.cw.reports.addDetail(a.id, 'p1', { reason: 'hate' })).toEqual({ ok: false, refused: 'not_reporter' });
  });

  it('an alias (merged identity) of the reporter is still the reporter', async () => {
    const w = await world();
    const f = await w.file({}, { reporter: 'key-one' });
    // Same person, second device: keyed by the account both times.
    w.cw.rooms.seat(f.room, 'p1', { clientKey: 'key-one', accountId: 'acct-1' }, 'Rep');
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: true });
  });
});

describe('the window: ten minutes', () => {
  it('is open at the moment of the report and at exactly ten minutes', async () => {
    const a = await oneTap();
    expect(await a.w.cw.reports.addDetail(a.f.id, 'p1', { reason: 'hate' })).toEqual({ ok: true });
    const b = await oneTap();
    b.w.clock.t += 10 * MIN;
    expect(await b.w.cw.reports.addDetail(b.f.id, 'p1', { reason: 'hate' })).toEqual({ ok: true });
  });

  it('is closed one millisecond later: too_late, and nothing changes', async () => {
    const { w, f } = await oneTap();
    w.clock.t += 10 * MIN + 1;
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: false, refused: 'too_late' });
    expect(row(w, f.id)).toMatchObject({ reportedReason: null, detailAt: null });
  });

  it('is measured from the report, not from a first refused try', async () => {
    const { w, f } = await oneTap();
    w.clock.t += 6 * MIN;
    await w.cw.reports.addDetail(f.id, 'p1', { reason: 'bogus' });
    w.clock.t += 5 * MIN;
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: false, refused: 'too_late' });
  });

  it('a report already decided is too_late whatever the time (the hint never changes a decision)', async () => {
    const { w, f } = await oneTap();
    const res = await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: 'mod_1', reason: 'fine' });
    expect(res).toMatchObject({ ok: true });
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: false, refused: 'too_late' });
    expect(row(w, f.id).reportedReason).toBeNull();
  });

  it('the order is not_found, not_reporter, too_late, already_added, reason_unknown', async () => {
    const { w, f } = await oneTap();
    await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' });
    w.clock.t += 11 * MIN;
    // Added AND late AND a bad reason: the earlier check in the order wins.
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'bogus' })).toEqual({ ok: false, refused: 'too_late' });
    expect(await w.cw.reports.addDetail(f.id, 'p2', { reason: 'bogus' })).toEqual({ ok: false, refused: 'not_reporter' });
    expect(await w.cw.reports.addDetail('nope', 'p2', { reason: 'bogus' })).toEqual({ ok: false, refused: 'not_found' });
    const g = await oneTap();
    await g.w.cw.reports.addDetail(g.f.id, 'p1', { reason: 'hate' });
    expect(await g.w.cw.reports.addDetail(g.f.id, 'p1', { reason: 'bogus' })).toEqual({ ok: false, refused: 'already_added' });
  });
});

describe('the reason of a follow-up', () => {
  it('must be an enabled reason: unknown, switched off, wrong case and non-text are reason_unknown', async () => {
    const w = await world({ overrides: { reporting: { reasons: [{ id: 'lag', label: 'Lag', enabled: false }, { id: 'rude', label: 'Rude' }, { id: 'other', label: 'Else' }] } } });
    const f = await w.file({});
    for (const reason of ['lag', 'harassment', 'RUDE', 7, {}, true]) {
      expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: reason as never }), String(reason)).toEqual({ ok: false, refused: 'reason_unknown' });
    }
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'rude' })).toEqual({ ok: true });
  });

  it('a missing, null or blank reason means "no change", in every flow', async () => {
    for (const flow of ['one_tap', 'reason_first', 'reason_required'] as const) {
      const w = await world({ overrides: { reporting: { flow } } });
      const f = await w.file({ reason: 'hate' });
      expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: '  ', note: 'words' })).toEqual({ ok: true });
      expect(row(w, f.id)).toMatchObject({ reportedReason: 'hate', note: 'words' });
    }
  });

  it('is checked against the profile at that moment (live)', async () => {
    const { w, f } = await oneTap();
    const reasons = w.cw.profile.reporting.reasons.map((r) => (r.id === 'hate' ? { ...r, enabled: false } : { ...r }));
    const saved = w.cw.policy.save({ reporting: { reasons } }, { version: 0, ...OWNER });
    expect(saved.ok).toBe(true);
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: false, refused: 'reason_unknown' });
  });
});

describe('when the kit cannot take it: off', () => {
  it('the kill switch answers off', async () => {
    let on = true;
    const w = await world({ enabled: () => on });
    const f = await w.file({});
    on = false;
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: false, refused: 'off' });
  });

  it('a store without addReportDetail answers off', async () => {
    const inner = new MemoryStore();
    const store = new Proxy(inner, {
      get(target, key) {
        if (key === 'addReportDetail') return undefined;
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as Store;
    const w = await world({}, store);
    const f = await w.file({});
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: false, refused: 'off' });
  });

  it('a store that throws answers off and logs the class only', async () => {
    class Broken extends MemoryStore {
      override addReportDetail(): never {
        throw new RangeError('disk full: planted-secret-9931');
      }
    }
    const w = await world({}, new Broken());
    const f = await w.file({});
    expect(await w.cw.reports.addDetail(f.id, 'p1', { reason: 'hate' })).toEqual({ ok: false, refused: 'off' });
    expect(JSON.stringify(w.logged)).toContain('RangeError');
    expect(JSON.stringify(w.logged)).not.toContain('planted-secret-9931');
  });

  it('never rejects, whatever it is given', async () => {
    const { w, f } = await oneTap();
    await expect(w.cw.reports.addDetail(f.id, 'p1', null as never)).resolves.toBeDefined();
    await expect(w.cw.reports.addDetail(f.id, 'p1', undefined as never)).resolves.toBeDefined();
    await expect(w.cw.reports.addDetail(f.id, 'p1', 'text' as never)).resolves.toBeDefined();
  });
});
