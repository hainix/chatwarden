import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { isSystemReport } from '../src/ai/actPlan.js';
import { OWNER, world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';

// F5: `cw.reports.fileSystem`, a report nobody filed. One open per person and room, a daily cap read from the store, no reporter anywhere.

const DAY = 86_400_000;
const ROOM = 'RF';

/** A room with a speaker (p1) who has said a line, and a second player (p2). */
function seat(w: World, room = ROOM, speaker = 'key-speaker') {
  w.cw.rooms.seat(room, 'p1', { clientKey: speaker }, 'Spk');
  w.cw.rooms.seat(room, 'p2', { clientKey: 'key-other' }, 'Oth');
  const r = w.cw.chat.accept(room, 'p1', 'see vlemmo.com now');
  if (!('deliver' in r)) throw new Error('expected a delivered line');
  return { room, subject: w.cw.rooms.subjectAt(room, 'p1') as string, lineId: r.deliver.lineId };
}

const input = (s: { room: string; subject: string; lineId: string | null }, over: Record<string, unknown> = {}) => ({
  origin: 'filter' as const,
  originKey: 'link.unlisted',
  roomId: s.room,
  target: s.subject,
  lineId: s.lineId,
  reportedReason: 'spam' as const,
  ...over,
});

describe('fileSystem: the report', () => {
  it('files one open report with origin filter, no note, the excerpt of the room, reason spam for link, phrase and ratio and personal_info for personal info', async () => {
    const w = await world();
    const s = seat(w);
    expect(await w.cw.reports.fileSystem(input(s))).toBe('filed');
    const [one] = w.cw.reports.list({ status: 'open' }).items;
    expect(one).toMatchObject({
      origin: 'filter',
      originKey: 'link.unlisted',
      status: 'open',
      roomId: ROOM,
      targetPerson: s.subject,
      reportedReason: 'spam',
      category: 'spam',
      note: null,
      lineId: s.lineId,
      reporterSeat: '',
      reporterHandle: '',
    });
    expect(one!.reporterSubject).toBe(`filter:${one!.id}`);
    expect(one!.excerpt.map((l) => l.raw)).toEqual(['see vlemmo.com now']);
    expect(one!.people).toEqual([s.subject]);
    // each key family keeps its own reason
    for (const [key, reason, expectedCategory] of [
      ['phrase.ads', 'spam', 'spam'],
      ['ratio.caps', 'spam', 'spam'],
      ['personal_info.phone', 'personal_info', 'other'],
    ] as const) {
      const t = seat(w, `R-${key}`, `k-${key}`);
      expect(await w.cw.reports.fileSystem(input(t, { originKey: key, reportedReason: reason }))).toBe('filed');
      expect(w.cw.reports.list({ person: t.subject }).items[0]).toMatchObject({ originKey: key, reportedReason: reason, category: expectedCategory });
    }
    await w.cw.close();
  });

  it('every filter report has its own never-repeating reporter value, never a subject id', async () => {
    const w = await world();
    const a = seat(w, 'RA', 'ka');
    const b = seat(w, 'RB', 'kb');
    await w.cw.reports.fileSystem(input(a));
    await w.cw.reports.fileSystem(input(b));
    const all = w.cw.reports.list({}).items;
    expect(new Set(all.map((r) => r.reporterSubject)).size).toBe(2);
    for (const r of all) expect(r.reporterSubject.startsWith('filter:')).toBe(true);
    await w.cw.close();
  });

  it('a line that is not in the buffer files with a null line id; a null lineId is accepted', async () => {
    const w = await world();
    const s = seat(w);
    expect(await w.cw.reports.fileSystem(input(s, { lineId: null }))).toBe('filed');
    expect(w.cw.reports.list({}).items[0]!.lineId).toBeNull();
    await w.cw.close();
  });

  it('malformed input files nothing and never rejects: an origin that is not filter, a bad key, no room, a blank target', async () => {
    const w = await world();
    const s = seat(w);
    for (const bad of [
      { origin: 'nope' },
      { originKey: 'Link Unlisted' },
      { originKey: '' },
      { originKey: 'a'.repeat(49) },
      { originKey: 5 },
      { target: '' },
      { roomId: '' },
      { reportedReason: 'harassment' },
    ]) {
      const res = await w.cw.reports.fileSystem(input(s, bad) as never);
      expect(['no_subject', 'off']).toContain(res);
    }
    expect(w.cw.reports.list({}).items).toEqual([]);
    expect(await w.cw.reports.fileSystem(null as never)).toBe('off');
    await w.cw.close();
  });

  it('a key of the closed shape (letters, digits and _ . : -, 1 to 48) is accepted', async () => {
    const w = await world();
    const s = seat(w);
    expect(await w.cw.reports.fileSystem(input(s, { originKey: `phrase.${'a'.repeat(41)}` }))).toBe('filed');
    await w.cw.close();
  });
});

describe('fileSystem: dedupe, cap, no subject, off', () => {
  it('a second flag for the same person and room while one is open answers open_exists and files nothing; after the first is decided a new one files', async () => {
    const w = await world();
    const s = seat(w);
    expect(await w.cw.reports.fileSystem(input(s))).toBe('filed');
    expect(await w.cw.reports.fileSystem(input(s, { originKey: 'phrase.ads' }))).toBe('open_exists');
    expect(w.cw.reports.list({}).items).toHaveLength(1);
    const id = w.cw.reports.list({}).items[0]!.id;
    expect(await w.cw.decide({ reportId: id, verdict: 'no_action', actions: [], actor: 'mod_ann' })).toMatchObject({ ok: true });
    expect(await w.cw.reports.fileSystem(input(s))).toBe('filed');
    expect(w.cw.reports.list({}).items).toHaveLength(2);
    await w.cw.close();
  });

  it('the same person in another room is a separate report; another person in the same room too', async () => {
    const w = await world();
    const a = seat(w, 'R1', 'k1');
    expect(await w.cw.reports.fileSystem(input(a))).toBe('filed');
    w.cw.rooms.seat('R2', 'p1', { clientKey: 'k1' }, 'Spk');
    expect(await w.cw.reports.fileSystem(input({ room: 'R2', subject: a.subject, lineId: null }))).toBe('filed');
    const other = w.cw.rooms.subjectAt('R1', 'p2') as string;
    expect(await w.cw.reports.fileSystem(input({ room: 'R1', subject: other, lineId: null }))).toBe('filed');
    await w.cw.close();
  });

  it('an ordinary player report and a filter report for the same pair do not clash', async () => {
    const w = await world();
    const s = seat(w);
    expect((await w.submit(ROOM, { reporterSeat: 'p2', targetSeat: 'p1' })).ok).toBe(true);
    expect(await w.cw.reports.fileSystem(input(s))).toBe('filed');
    await w.cw.close();
  });

  it('the daily cap: at flagCapPerDay the next answers capped; the count reads the store so a second cw on the same store shares it; the UTC day edge is exact', async () => {
    const store = new MemoryStore();
    const w = await world({ overrides: { filters: { flagCapPerDay: 2 } } }, store);
    // the clock sits mid-day; put it at the start of a UTC day plus a little
    w.clock.t = Math.floor(w.clock.t / DAY) * DAY + 5;
    const rooms = ['C1', 'C2', 'C3'].map((r, i) => seat(w, r, `kc${i}`));
    expect(await w.cw.reports.fileSystem(input(rooms[0]!))).toBe('filed');
    expect(await w.cw.reports.fileSystem(input(rooms[1]!))).toBe('filed');
    expect(await w.cw.reports.fileSystem(input(rooms[2]!))).toBe('capped');
    expect(w.cw.reports.list({}).items).toHaveLength(2);
    // a second kit on the same store shares the count
    const w2 = await world({ overrides: { filters: { flagCapPerDay: 2 } } }, store);
    w2.clock.t = w.clock.t;
    w2.cw.rooms.seat('C9', 'p1', { clientKey: 'kc9' }, 'Spk');
    expect(await w2.cw.reports.fileSystem(input({ room: 'C9', subject: w2.cw.rooms.subjectAt('C9', 'p1') as string, lineId: null }))).toBe('capped');
    // the day edge: the last millisecond of the UTC day still counts, the first of the next does not
    w.clock.t = Math.floor(w.clock.t / DAY) * DAY + DAY - 1;
    expect(await w.cw.reports.fileSystem(input(rooms[2]!))).toBe('capped');
    w.clock.t += 1;
    expect(await w.cw.reports.fileSystem(input(rooms[2]!))).toBe('filed');
    await w.cw.close();
    await w2.cw.close();
  });

  it('a capped flag counts only reports of origin filter: ordinary reports do not use the cap', async () => {
    const w = await world({ overrides: { filters: { flagCapPerDay: 1 } } });
    const a = seat(w, 'O1', 'ko1');
    expect((await w.submit('O1', { reporterSeat: 'p2', targetSeat: 'p1' })).ok).toBe(true);
    expect(await w.cw.reports.fileSystem(input(a))).toBe('filed');
    await w.cw.close();
  });

  it('a guest (no subject) answers no_subject and files nothing; moderation switched off answers off', async () => {
    const w = await world();
    const s = seat(w);
    expect(await w.cw.reports.fileSystem(input(s, { target: null }) as never)).toBe('no_subject');
    expect(w.cw.reports.list({}).items).toEqual([]);
    let on = true;
    const off = await world({ enabled: () => on });
    const t = seat(off);
    on = false;
    expect(await off.cw.reports.fileSystem(input(t))).toBe('off');
    on = true;
    expect(off.cw.reports.list({}).items).toEqual([]);
    await w.cw.close();
    await off.cw.close();
  });

  it('a store failure answers off and logs the class only', async () => {
    const w = await world();
    const s = seat(w);
    w.store.insertReport = () => {
      throw new TypeError('boom vlemmo.com');
    };
    expect(await w.cw.reports.fileSystem(input(s))).toBe('off');
    expect(JSON.stringify(w.logged)).not.toContain('vlemmo');
    await w.cw.close();
  });
});

describe('fileSystem: nothing about a reporter', () => {
  it('every reporter reader ignores origin reports: reporterAccuracy, reporterTally, reporterOutcomes, listOpenReportsByReporter, dismissMany by reporter, the suspension count, the decision\'s reporter notice, habitual-reporter ranking, the AI act check system_report; a distinctive filter: reporter value appears in none of their outputs', async () => {
    const w = await world();
    const s = seat(w);
    await w.cw.reports.fileSystem(input(s));
    const rec = w.store.loadReport(w.cw.reports.list({}).items[0]!.id)!;
    const value = rec.reporterSubject;
    expect(value).toMatch(/^filter:/);

    const outputs: unknown[] = [
      w.cw.reports.reporterAccuracy([value]),
      [...w.cw.reports.reporterAccuracy([value])],
      w.cw.reports.reporterRecord(value),
      w.store.listOpenReportsByReporter?.([value], 10),
      w.store.reporterTally([value]),
      w.store.reporterOutcomes?.([value], 0),
      w.store.loadReporterDecisions?.([value]),
      w.store.loadBadFaithMarks(0),
    ];
    expect(w.cw.reports.reporterRecord(value)).toMatchObject({ reports: 0, open: 0, actioned: 0, dismissed: 0, badFaith: 0, suspendedUntil: null });
    expect(w.store.listOpenReportsByReporter?.([value], 10)).toEqual([]);
    expect(w.store.reporterTally([value])).toEqual({ open: 0, actioned: 0, dismissed: 0, badFaith: 0 });
    expect(w.store.reporterOutcomes?.([value], 0)).toEqual([]);
    expect(w.store.loadBadFaithMarks(0)).toEqual([]);
    expect(w.cw.reports.reporterAccuracy([value]).size).toBe(0);
    expect(JSON.stringify(outputs)).not.toContain(value);

    // a bulk dismiss of "the reporter" finds nothing
    const bulk = await w.cw.reports.dismissMany({ scope: { reporter: value }, actor: OWNER.actor });
    expect(JSON.stringify(bulk)).not.toContain(value);
    expect(w.cw.reports.list({ status: 'open' }).items).toHaveLength(1);
    // while a bulk dismiss of the person's case closes it as any other
    const byPerson = await w.cw.reports.dismissMany({ scope: { person: s.subject }, actor: OWNER.actor });
    expect(byPerson).toMatchObject({ ok: true });
    expect(w.cw.reports.list({ status: 'dismissed' }).items).toHaveLength(1);
    await w.cw.close();
  });

  it('upholding a filter report tells the reporter nothing (no notice for filter:...), and still warns the person', async () => {
    const w = await world();
    const s = seat(w);
    await w.cw.reports.fileSystem(input(s));
    const id = w.cw.reports.list({}).items[0]!.id;
    const value = `filter:${id}`;
    const notices: unknown[] = [];
    const insert = w.store.insertNotice.bind(w.store);
    w.store.insertNotice = (row) => {
      notices.push(row);
      return insert(row);
    };
    const res = await w.cw.decide({
      reportId: id,
      verdict: 'upheld',
      actions: [{ kind: 'warning', subject: s.subject, durationMs: null, rule: 4 }],
      actor: 'mod_ann',
      reason: 'ads',
    });
    expect(res).toMatchObject({ ok: true });
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices)).not.toContain(value);
    await w.cw.close();
  });

  it('a decision cannot act on the reporter value and bad_faith is refused: there is no reporter to blame', async () => {
    const w = await world();
    const s = seat(w);
    await w.cw.reports.fileSystem(input(s));
    const id = w.cw.reports.list({}).items[0]!.id;
    expect(await w.cw.decide({ reportId: id, verdict: 'bad_faith', evidence: 'x', actions: [], actor: 'mod_ann' })).toEqual({ ok: false, error: 'invalid' });
    expect(
      await w.cw.decide({ reportId: id, verdict: 'no_action', actions: [{ kind: 'warning', subject: `filter:${id}`, durationMs: null, rule: 4 }], actor: 'mod_ann', reason: 'r' }),
    ).toEqual({ ok: false, error: 'invalid' });
    expect(w.cw.reports.get(id)!.status).toBe('open');
    expect(w.store.loadBadFaithMarks(0)).toEqual([]);
    await w.cw.close();
  });

  it('a dismissal records no mark against anyone and the case closes as any other', async () => {
    const w = await world();
    const s = seat(w);
    await w.cw.reports.fileSystem(input(s));
    const id = w.cw.reports.list({}).items[0]!.id;
    expect(await w.cw.decide({ reportId: id, verdict: 'no_action', actions: [], actor: 'mod_ann' })).toMatchObject({ ok: true });
    expect(w.cw.reports.get(id)).toMatchObject({ status: 'dismissed', badFaith: false });
    expect(w.store.reporterOutcomes?.([`filter:${id}`], 0)).toEqual([]);
    await w.cw.close();
  });

  it('a case with a filter report is served as any case: oldest first, even with rankDownHabitual', async () => {
    const w = await world();
    const s = seat(w);
    await w.cw.reports.fileSystem(input(s));
    w.clock.t += 1_000;
    await w.file();
    const next = w.cw.cases.next('mod_ann', { rankDownHabitual: true });
    expect(next).toMatchObject({ person: s.subject });
    await w.cw.close();
  });

  it('isSystemReport reads origin: a filter report is a system report even with a reporter value', () => {
    expect(isSystemReport({ reporterSubject: 'filter:abc', origin: 'filter' } as never)).toBe(true);
    expect(isSystemReport({ reporterSubject: 's_real', origin: null } as never)).toBe(false);
    expect(isSystemReport({ reporterSubject: 's_real' })).toBe(false);
    expect(isSystemReport({ reporterSubject: '' })).toBe(true);
    expect(isSystemReport({ reporterSubject: 's_real', origin: 'watch' } as never)).toBe(true);
  });
});

describe('what staff and the event see', () => {
  it('StaffReport for a filter report has reporter null, origin and originKey; the player-facing bodies carry nothing new (no-leak)', async () => {
    const w = await world();
    const s = seat(w);
    await w.cw.reports.fileSystem(input(s, { originKey: 'phrase.ads' }));
    const staff = w.cw.reports.list({}).items[0]!;
    expect(staff.reporterPerson).toBeNull();
    expect(staff).toMatchObject({ origin: 'filter', originKey: 'phrase.ads' });
    expect(w.cw.reports.get(staff.id)).toMatchObject({ reporterPerson: null, origin: 'filter' });
    // an ordinary report keeps a reporter person and no origin
    const ord = await w.file();
    const ordinary = w.cw.reports.get(ord.id)!;
    expect(ordinary.reporterPerson).toBe(ord.reporter);
    expect(ordinary.origin).toBeNull();
    expect(ordinary.originKey).toBeNull();
    // the player side: the pending notices and the record of the target carry nothing about a report
    expect(JSON.stringify(w.cw.notices.pending({ clientKey: 'key-speaker' }))).toBe('[]');
    await w.cw.close();
  });

  it('report.created carries origin filter and no text; an ordinary report carries none', async () => {
    const w = await world();
    const seen: Array<Record<string, unknown>> = [];
    w.cw.on('report.created', (e) => void seen.push({ ...e }));
    const s = seat(w);
    await w.cw.reports.fileSystem(input(s, { originKey: 'personal_info.phone', reportedReason: 'personal_info' }));
    await w.file();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ type: 'report.created', origin: 'filter', reportedReason: 'personal_info' });
    expect(JSON.stringify(seen[0])).not.toContain('vlemmo');
    expect(JSON.stringify(seen[0])).not.toContain('personal_info.phone');
    expect(Object.hasOwn(seen[1]!, 'origin')).toBe(false);
    await w.cw.close();
  });

  it('onReport is told of a filter report, once, with the origin', async () => {
    const told: Array<{ origin: unknown; reporter: string }> = [];
    const w = await world({ onReport: (r) => void told.push({ origin: r.origin, reporter: r.reporterSubject }) });
    const s = seat(w);
    await w.cw.reports.fileSystem(input(s));
    expect(told).toHaveLength(1);
    expect(told[0]!.origin).toBe('filter');
    await w.cw.close();
  });
});
