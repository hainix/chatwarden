import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { prepareCase } from '../src/ai/case.js';
import { EvidenceBuffer, RoomRoster } from '../src/evidence.js';
import { PRESETS } from '../src/profile.js';
import { defineRules, starterRules } from '../src/rules.js';
import { ReportService } from '../src/reports.js';
import { defaultReporting } from '../src/reporting.js';
import { SubjectIndex } from '../src/subjects.js';
import type { KitEvent } from '../src/events.js';
import { OWNER, world } from './reportingWorld.js';
import { mkReport } from './ai/reportFixtures.js';

// U4: a report is urgent when its reason is flagged urgent at the moment it is filed (a snapshot), never because a player's body says so.

const welfareOn = () => ({ reporting: { reasons: defaultReporting().reasons.map((r) => (r.id === 'welfare' ? { ...r, enabled: true } : r)) } });
const SECRET = 'quissel-note-text';

describe('the urgent snapshot at filing', () => {
  it('a report under threat is stored urgent; under welfare (enabled) urgent; under harassment not; under a reason the owner flagged urgent', async () => {
    const w = await world({ overrides: welfareOn() });
    const stored = async (reason: string) => w.store.loadReport((await w.file({ reason })).id);
    expect((await stored('threat'))?.urgent).toBe(true);
    expect((await stored('welfare'))?.urgent).toBe(true);
    expect((await stored('harassment'))?.urgent).toBe(false);
    expect((await stored('spam'))?.urgent).toBe(false);
    // no reason at all: not urgent
    expect(w.store.loadReport((await w.file({})).id)?.urgent).toBe(false);
    // the owner flags another reason urgent
    const reasons = defaultReporting().reasons.map((r) => (r.id === 'hate' ? { ...r, urgent: true } : r));
    expect(w.cw.policy.save({ reporting: { reasons } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect((await stored('hate'))?.urgent).toBe(true);
    expect((await stored('harassment'))?.urgent).toBe(false);
  });

  it('the legacy category alias reads through the same flag: category threat-less ids do not become urgent', async () => {
    const w = await world();
    const f = await w.file({ category: 'harassment' });
    expect(w.store.loadReport(f.id)?.urgent).toBe(false);
    const g = await w.file({ category: 'bogus' as never });
    expect(w.store.loadReport(g.id)?.urgent).toBe(false);
  });

  it('the flag turned off later does not change reports already filed; a report filed after is not urgent', async () => {
    const w = await world();
    const early = await w.file({ reason: 'threat' });
    const off = defaultReporting().reasons.map((r) => (r.id === 'threat' ? { ...r, urgent: false } : r));
    expect(w.cw.policy.save({ reporting: { reasons: off } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    const late = await w.file({ reason: 'threat' });
    expect(w.store.loadReport(early.id)?.urgent).toBe(true);
    expect(w.store.loadReport(late.id)?.urgent).toBe(false);
  });

  it('a report under a reason that is switched off later keeps its snapshot', async () => {
    const w = await world({ overrides: welfareOn() });
    const f = await w.file({ reason: 'welfare' });
    const off = defaultReporting().reasons;
    expect(w.cw.policy.save({ reporting: { reasons: off } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect(w.store.loadReport(f.id)?.urgent).toBe(true);
  });
});

describe('report.created and what is logged', () => {
  it('carries urgent and the reason id and no note, handle or text', async () => {
    const w = await world({ overrides: welfareOn() });
    const events: KitEvent[] = [];
    w.cw.on('report.created', (e) => void events.push(e));
    const f = await w.file({ reason: 'welfare', note: SECRET });
    const g = await w.file({ reason: 'harassment' });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'report.created', reportId: f.id, reportedReason: 'welfare', urgent: true });
    expect(events[1]).toMatchObject({ reportId: g.id, reportedReason: 'harassment', urgent: false });
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(['category', 'createdAt', 'reportId', 'reportedReason', 'roomTags', 'type', 'urgent']);
      expect(JSON.stringify(e)).not.toContain(SECRET);
      expect(JSON.stringify(e)).not.toMatch(/Rep|Tgt/);
    }
  });

  it('a spy logger sees event names and error classes only, for an urgent welfare report and a failing store alike', async () => {
    const w = await world({ overrides: welfareOn() });
    await w.file({ reason: 'welfare', note: SECRET });
    class Failing extends MemoryStore {
      override insertReport(): never {
        throw new Error(`disk full ${SECRET}`);
      }
    }
    const bad = await world({ overrides: welfareOn() }, new Failing());
    bad.cw.rooms.seat('rr', 'p1', { clientKey: 'a' }, 'Rep');
    bad.cw.rooms.seat('rr', 'p2', { clientKey: 'b' }, 'Tgt');
    await bad.cw.reports.submit({ roomId: 'rr', reporterSeat: 'p1', targetSeat: 'p2', reason: 'welfare', note: SECRET });
    for (const logged of [w.logged, bad.logged]) {
      expect(JSON.stringify(logged)).not.toContain(SECRET);
      for (const [event, detail] of logged) {
        expect(event).toMatch(/^[a-z_.]+$/);
        for (const v of Object.values(detail ?? {})) expect(typeof v === 'number' || typeof v === 'boolean' || /^[A-Za-z]{1,40}$/.test(String(v))).toBe(true);
      }
    }
    expect(bad.logged.some(([e, d]) => e === 'reports.store_failed' && d?.error === 'Error')).toBe(true);
  });
});

describe('urgent only from the internal caller', () => {
  it('a public submit with an urgent field is ignored; an evidence ref is for the game server to give, so it is taken', async () => {
    const w = await world();
    w.cw.rooms.seat('pub', 'p1', { clientKey: 'a' }, 'Rep');
    w.cw.rooms.seat('pub', 'p2', { clientKey: 'b' }, 'Tgt');
    const res = await w.cw.reports.submit({ roomId: 'pub', reporterSeat: 'p1', targetSeat: 'p2', reason: 'harassment', urgent: true, evidenceRef: 'x1' } as never);
    if (!res.ok) throw new Error('refused');
    expect(w.store.loadReport(res.reportId)).toMatchObject({ urgent: false, evidenceRef: 'x1' });
  });

  const service = () => {
    const store = new MemoryStore();
    const clock = { now: () => 1_800_000_000_000 };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const roster = new RoomRoster();
    const buffer = new EvidenceBuffer({ clock });
    const reports = new ReportService({ roster, buffer, subjects, store, clock });
    const seat = (key: string, id: string) => {
      const s = subjects.resolve({ clientKey: key, accountId: null, ipHash: null });
      if (s === null) throw new Error('subject');
      roster.seat('R1', id, s, key);
    };
    seat('rep', 'p1');
    seat('tgt', 'p2');
    return { store, reports };
  };

  it('the internal option sets urgent and an evidence ref; the ref must be in its alphabet (no dot or slash), else it is dropped', async () => {
    const a = service();
    const ok = await a.reports.submit({ roomId: 'R1', reporterSeat: 'p1', targetSeat: 'p2', reason: 'harassment' }, { urgent: true, evidenceRef: 'match_42:t-9' });
    if (!ok.ok) throw new Error('refused');
    expect(a.store.loadReport(ok.reportId)).toMatchObject({ urgent: true, evidenceRef: 'match_42:t-9' });
    for (const ref of ['has.dot', 'has/slash', 'has space', '', 'x'.repeat(129)]) {
      const b = service();
      const res = await b.reports.submit({ roomId: 'R1', reporterSeat: 'p1', targetSeat: 'p2' }, { evidenceRef: ref });
      if (!res.ok) throw new Error('refused');
      expect(b.store.loadReport(res.reportId)?.evidenceRef, JSON.stringify(ref)).toBeNull();
    }
    const c = service();
    const plain = await c.reports.submit({ roomId: 'R1', reporterSeat: 'p1', targetSeat: 'p2' });
    if (!plain.ok) throw new Error('refused');
    expect(c.store.loadReport(plain.reportId)).toMatchObject({ urgent: false, evidenceRef: null });
  });

  it('the internal option cannot lower an urgent reason: urgent false in the option does not clear the reason flag', async () => {
    const reasonUrgent = defaultReporting();
    const store = new MemoryStore();
    const clock = { now: () => 1_800_000_000_000 };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const roster = new RoomRoster();
    const reports = new ReportService({ roster, buffer: new EvidenceBuffer({ clock }), subjects, store, clock, reporting: () => reasonUrgent });
    for (const [key, id] of [['rep', 'p1'], ['tgt', 'p2']] as const) {
      const s = subjects.resolve({ clientKey: key, accountId: null, ipHash: null });
      if (s === null) throw new Error('subject');
      roster.seat('R1', id, s, key);
    }
    const res = await reports.submit({ roomId: 'R1', reporterSeat: 'p1', targetSeat: 'p2', reason: 'threat' }, { urgent: false });
    if (!res.ok) throw new Error('refused');
    expect(store.loadReport(res.reportId)?.urgent).toBe(true);
  });

  it('a system report is urgent only when its caller says so (a boolean true)', async () => {
    const file = async (extra: Record<string, unknown>, room: string): Promise<boolean | undefined> => {
      const w = await world();
      const target = w.table().target;
      expect(await w.cw.reports.fileSystem({ origin: 'filter', originKey: 'link.unlisted', roomId: room, target, lineId: null, reportedReason: 'spam', ...extra } as never)).toBe('filed');
      return w.store.listOpenReports({ limit: 5 }).find((r) => r.roomId === room)?.urgent;
    };
    expect(await file({}, 'sys1')).toBe(false);
    expect(await file({ urgent: true }, 'sys2')).toBe(true);
    expect(await file({ urgent: false }, 'sys3')).toBe(false);
    expect(await file({ urgent: 'yes' }, 'sys4')).toBe(false);
    expect(await file({ urgent: 1 }, 'sys5')).toBe(false);
  });
});

describe('the AI and urgent', () => {
  it('never reads or writes urgent: the AI brief and the AI input hash are unchanged by it (the rendered prompt is scanned)', () => {
    const base = mkReport([
      { who: 'target', text: 'you are a zorbak' },
      { who: 'reporter', text: 'stop it' },
    ], { reason: 'threat', note: 'a note' });
    const policy = { profile: PRESETS.standard, rules: defineRules(starterRules('standard')) };
    const reasons = defaultReporting().reasons;
    const args = (report: typeof base) => ({ report, policy, reasons, adapterId: 'fake:one', mask: false });
    const plain = prepareCase(args(base));
    const marked = prepareCase(args({ ...base, urgent: true, handoffAt: 5, handoffBy: 'mod_ann', escalatedTo: 'owner', escalatedBy: 'mod_ann', escalatedAt: 6, evidenceRef: 'match_1' }));
    expect(marked.hash).toBe(plain.hash);
    expect(marked.input.prompt).toEqual(plain.input.prompt);
    expect(marked.build([], [], undefined).prompt).toEqual(plain.build([], [], undefined).prompt);
    const rendered = JSON.stringify(marked.input) + JSON.stringify(marked.confirm('fake:one').input);
    expect(rendered).not.toMatch(/urgent|handoff|escalat|match_1/i);
  });
});
