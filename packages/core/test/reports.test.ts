import { describe, expect, it } from 'vitest';
import { EvidenceBuffer, RoomRoster } from '../src/evidence.js';
import { ReportService } from '../src/reports.js';
import type { StoredReport } from '../src/reports.js';
import { applySanction } from '../src/sanctions.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, Logger, SanctionKind, Source, SubjectId } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';
import type { StoredReportRow } from './memoryStore.js';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const ROOM = 'R1';

const who = (clientKey: string | null, accountId: string | null = null, ipHash: string | null = null): Identifiers => ({
  clientKey,
  accountId,
  ipHash,
});

type Logs = Array<{ event: string; detail?: Record<string, string | number | boolean> }>;
type Counts = { reports7d: number; rooms7d: number; auto7d: number };
type Submit = Parameters<ReportService['submit']>[0];

class ThrowingLoad extends MemoryStore {
  override loadReportActivity(): never {
    throw new Error('disk full');
  }
}
class ThrowingInsert extends MemoryStore {
  override insertReport(): never {
    throw new Error('disk full');
  }
}
class UniqueThrowing extends MemoryStore {
  override insertReport(): never {
    throw new Error('UNIQUE constraint failed: kit_reports.reporter_subject, kit_reports.target_subject, kit_reports.room_id');
  }
}
/** A store whose duplicate check (the pair listing) misses, so only the UNIQUE backstop can catch the repeat. */
class BlindPairs extends MemoryStore {
  override loadRoomReportPairs(): never[] {
    return [];
  }
}

function setup(opts: { store?: MemoryStore; enabled?: () => boolean; onReport?: (r: StoredReport, c: Counts) => void } = {}) {
  const store = opts.store ?? new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const logs: Logs = [];
  const logger: Logger = { warn: (event, detail) => void logs.push({ event, detail }) };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const roster = new RoomRoster();
  const buffer = new EvidenceBuffer({ clock });
  const calls: Array<{ report: StoredReport; counts: Counts }> = [];
  const onReport = opts.onReport ?? ((report: StoredReport, counts: Counts) => void calls.push({ report, counts }));
  const reports = new ReportService({
    roster,
    buffer,
    subjects,
    store,
    clock,
    ...(opts.enabled ? { enabled: opts.enabled } : {}),
    onReport,
    logger,
  });
  const person = (ids: Identifiers): SubjectId => {
    const s = subjects.resolve(ids);
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  /** Seat `person` (by identifiers) in `seat`; null identifiers seats an unknown speaker (AI / host seat). */
  const sit = (seat: string, ids: Identifiers | null, handle = `h-${seat}`, room = ROOM): SubjectId | null => {
    const s = ids === null ? null : person(ids);
    roster.seat(room, seat, s, handle);
    return s;
  };
  /** One chat line from whoever holds `seat` now. */
  const say = (seat: string, raw = `line from ${seat}`, over: { room?: string; blocked?: boolean; ts?: number; audience?: string[] } = {}): string => {
    const room = over.room ?? ROOM;
    const occ = roster.occupant(room, seat);
    return buffer.append(room, {
      ts: over.ts ?? clock.t,
      seatId: seat,
      handle: occ?.handle ?? seat,
      subject: occ?.subject ?? null,
      raw,
      delivered: over.blocked ? null : raw,
      blocked: over.blocked ?? false,
      audience: over.audience ?? null,
    });
  };
  const input = (over: Partial<Submit> = {}): Submit => ({
    roomId: ROOM,
    reporterSeat: 'p1',
    targetSeat: 'p2',
    category: 'harassment',
    ...over,
  });
  const submit = (over: Partial<Submit> = {}) => reports.submit(input(over));
  /** Two seated humans: p1 (reporter) and p2 (target). */
  const table = () => {
    const a = sit('p1', who('k1'));
    const b = sit('p2', who('k2'));
    return { a: a as SubjectId, b: b as SubjectId };
  };
  /** Writes a stored report directly, as a past one. Rooms differ by default so the UNIQUE index never trips. */
  let seq = 0;
  const seed = (over: Partial<StoredReport> & { badFaithAt?: number | null } = {}): StoredReport => {
    const { badFaithAt, ...rest } = over;
    const n = ++seq;
    const row: StoredReport = {
      id: `seed-${n}`,
      createdAt: NOW - 40 * DAY,
      roomId: `seed-room-${n}`,
      tags: {},
      reporterSubject: 's_seedrep',
      reporterSeat: 'x',
      reporterHandle: 'x',
      targetSubject: `s_seedtarget${n}`,
      targetSeat: 'y',
      targetHandle: 'y',
      category: 'other',
      note: null,
      lineId: null,
      excerpt: [],
      people: [],
      status: 'open',
      ...rest,
    };
    store.insertReport(row);
    if (badFaithAt !== undefined && badFaithAt !== null) store.markReportBadFaith(row.id, badFaithAt);
    return row;
  };
  return { store, clock, logs, subjects, roster, buffer, reports, calls, person, sit, say, input, submit, table, seed };
}

const stored = (store: MemoryStore, i = 0): StoredReportRow => {
  const row = store.rawReports()[i];
  if (!row) throw new Error('no stored report');
  return row;
};

// ---------------------------------------------------------------------------

describe('report: stored row', () => {
  it('stores a report by seat with no line: the current occupant, reporter details, canonical subjects', async () => {
    const t = setup();
    t.roster.seat(ROOM, 'p1', t.person(who('k1')), 'Reporter', { mode: 'ranked' });
    const target = t.sit('p2', who('k2'), 'Target');
    const reporter = t.subjects.resolve(who('k1'));
    const res = await t.submit({ note: 'rude' });
    expect(res).toMatchObject({ ok: true });
    const row = stored(t.store);
    expect(row).toMatchObject({
      roomId: ROOM,
      tags: { mode: 'ranked' },
      reporterSubject: reporter,
      reporterSeat: 'p1',
      reporterHandle: 'Reporter',
      targetSubject: target,
      targetSeat: 'p2',
      targetHandle: 'Target',
      category: 'harassment',
      note: 'rude',
      lineId: null,
      status: 'open',
      createdAt: NOW,
    });
    expect(row.id).toBe((res as { reportId: string }).reportId);
  });

  it('every category is stored as sent; an unknown or non-string one is stored as other', async () => {
    const t = setup();
    t.table();
    for (const [i, c] of (['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'] as const).entries()) {
      t.sit('p2', who(`target-${i}`));
      await t.submit({ category: c });
    }
    expect(t.store.rawReports().map((r) => r.category)).toEqual(['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other']);

    const u = setup();
    u.table();
    const bad: unknown[] = ['bogus', 7, undefined, null, 'HATE'];
    for (const [i, c] of bad.entries()) {
      u.sit('p2', who(`target-${i}`));
      await u.submit({ category: c as never });
    }
    expect(u.store.rawReports().map((r) => r.category)).toEqual(['other', 'other', 'other', 'other', 'other']);
  });

  it('a missing, blank or non-string note is stored as null; a note is trimmed', async () => {
    const t = setup();
    t.table();
    const notes: Array<unknown> = [undefined, '   \n\t ', '  needs trimming  ', 42];
    for (const [i, note] of notes.entries()) {
      t.sit('p2', who(`target-${i}`));
      await t.submit({ note: note as never });
    }
    expect(t.store.rawReports().map((r) => r.note)).toEqual([null, null, 'needs trimming', null]);
  });

  it('a note is capped at 500 characters; exactly 500 and 500 plus padding that trims away are kept whole', async () => {
    const t = setup();
    t.table();
    const notes = ['x'.repeat(600), 'y'.repeat(500), `  ${'z'.repeat(500)}  `];
    for (const [i, note] of notes.entries()) {
      t.sit('p2', who(`target-${i}`));
      await t.submit({ note });
    }
    expect(t.store.rawReports().map((r) => r.note)).toEqual(['x'.repeat(500), 'y'.repeat(500), 'z'.repeat(500)]);
  });

  it('truncation never leaves half of a surrogate pair', async () => {
    const t = setup();
    t.table();
    await t.submit({ note: `${'a'.repeat(499)}\u{1F600}tail` });
    expect(stored(t.store).note).toBe('a'.repeat(499));
  });

  it('records the line id and, from a line, the author seat and handle', async () => {
    const t = setup();
    t.table();
    const id = t.say('p2', 'hello');
    await t.submit({ lineId: id });
    expect(stored(t.store)).toMatchObject({ lineId: id, targetSeat: 'p2', targetHandle: 'h-p2' });
  });

  it('the result carries the report id and remaining only, never an identifier', async () => {
    const t = setup();
    const { a, b } = t.table();
    const ok = await t.submit();
    expect(Object.keys(ok).sort()).toEqual(['ok', 'remaining', 'reportId']);
    const refused = await t.submit({ targetSeat: 'p1' });
    expect(Object.keys(refused).sort()).toEqual(['ok', 'refused']);
    for (const v of [ok, refused]) {
      const json = JSON.stringify(v);
      expect(json).not.toContain(a);
      expect(json).not.toContain(b);
    }
  });
});

describe('report: who is the target', () => {
  it("a line whose seat has since changed hands: the target is the line's original author", async () => {
    const t = setup();
    t.table();
    const first = t.sit('p2', who('k2'), 'Old');
    const id = t.say('p2', 'bad words');
    const second = t.sit('p2', who('k3'), 'New'); // the seat changed hands
    await t.submit({ lineId: id });
    const row = stored(t.store);
    expect(row.targetSubject).toBe(first);
    expect(row.targetSubject).not.toBe(second);
    expect(row.targetHandle).toBe('Old');
  });

  it('the line wins even when targetSeat names a different seat', async () => {
    const t = setup();
    t.table();
    const third = t.sit('p3', who('k3'), 'Bystander');
    const id = t.say('p2');
    await t.submit({ lineId: id, targetSeat: 'p3' });
    const row = stored(t.store);
    expect(row.targetSeat).toBe('p2');
    expect(row.targetSubject).not.toBe(third);
  });

  it('the same seat after a handover, reported by seat with no line: the current occupant', async () => {
    const t = setup();
    t.table();
    const now = t.sit('p2', who('k3'), 'New');
    t.say('p2');
    await t.submit();
    expect(stored(t.store)).toMatchObject({ targetSubject: now, targetHandle: 'New' });
  });

  it("a line id that no longer resolves falls back to the seat's current occupant", async () => {
    const t = setup();
    const { b } = t.table();
    await t.submit({ lineId: 'does-not-exist' });
    expect(stored(t.store)).toMatchObject({ targetSubject: b, lineId: null });
  });

  it('a line aged out of the buffer no longer resolves', async () => {
    const t = setup();
    const { b } = t.table();
    t.sit('p2', who('k3'));
    const id = t.say('p2', 'old', { ts: NOW - 15 * MIN - 1 });
    await t.submit({ lineId: id });
    expect(stored(t.store).targetSubject).not.toBe(b);
    expect(stored(t.store).lineId).toBeNull();
  });

  it('a line id from another room does not resolve', async () => {
    const t = setup();
    t.table();
    t.sit('p9', who('k9'), 'Elsewhere', 'OTHER');
    const id = t.say('p9', 'x', { room: 'OTHER' });
    const { b } = { b: t.roster.occupant(ROOM, 'p2')?.subject };
    await t.submit({ lineId: id });
    expect(stored(t.store)).toMatchObject({ targetSubject: b, lineId: null });
  });
});

describe('report: a reporter cannot cite a line they never saw', () => {
  it("a whisper that did not include the reporter's seat is ignored: the target is the targetSeat occupant", async () => {
    const t = setup();
    const { b } = t.table(); // p1 reporter, p2 target
    const c = t.sit('p3', who('k3'), 'Whisperer');
    t.sit('p4', who('k4'), 'Listener');
    const id = t.say('p3', 'secret whisper', { audience: ['p3', 'p4'] });
    expect(await t.submit({ lineId: id, targetSeat: 'p2' })).toMatchObject({ ok: true });
    const row = stored(t.store);
    expect(row.targetSubject).toBe(b);
    expect(row.targetSubject).not.toBe(c);
    expect(row.lineId).toBeNull();
  });

  it('with no usable targetSeat the ignored line is simply not_player (it does not reveal the line exists)', async () => {
    const t = setup();
    t.table();
    t.sit('p3', who('k3'));
    t.sit('p4', who('k4'));
    const id = t.say('p3', 'secret whisper', { audience: ['p3', 'p4'] });
    expect(await t.submit({ lineId: id, targetSeat: 'p9' })).toEqual({ ok: false, refused: 'not_player' });
  });

  it('an empty audience includes nobody: ignored', async () => {
    const t = setup();
    const { b } = t.table();
    t.sit('p3', who('k3'));
    const id = t.say('p3', 'to nobody', { audience: [] });
    await t.submit({ lineId: id });
    expect(stored(t.store)).toMatchObject({ targetSubject: b, lineId: null });
  });

  it("a whisper that included the reporter's seat is a valid citation (control)", async () => {
    const t = setup();
    t.table();
    const c = t.sit('p3', who('k3'), 'Whisperer');
    const id = t.say('p3', 'psst', { audience: ['p1', 'p3'] });
    await t.submit({ lineId: id, targetSeat: 'p2' });
    expect(stored(t.store)).toMatchObject({ targetSubject: c, lineId: id, targetSeat: 'p3' });
  });

  it('a line to the whole room (audience null) is a valid citation (control)', async () => {
    const t = setup();
    t.table();
    const c = t.sit('p3', who('k3'));
    const id = t.say('p3', 'hello all');
    await t.submit({ lineId: id, targetSeat: 'p2' });
    expect(stored(t.store)).toMatchObject({ targetSubject: c, lineId: id });
  });
});

describe('report: refusals', () => {
  it('not_player: an empty seat', async () => {
    const t = setup();
    t.table();
    expect(await t.submit({ targetSeat: 'nobody' })).toEqual({ ok: false, refused: 'not_player' });
  });

  it('not_player: an AI or host seat (no subject)', async () => {
    const t = setup();
    t.table();
    t.sit('bot', null);
    expect(await t.submit({ targetSeat: 'bot' })).toEqual({ ok: false, refused: 'not_player' });
  });

  it('not_player: a seat known only by an IP (an IP alone resolves to no subject)', async () => {
    const t = setup();
    t.table();
    t.roster.seat(ROOM, 'p5', t.subjects.resolve(who(null, null, 'ip-only')), 'IpOnly');
    expect(await t.submit({ targetSeat: 'p5' })).toEqual({ ok: false, refused: 'not_player' });
  });

  it('not_player: a buffered line authored by an unknown speaker', async () => {
    const t = setup();
    t.table();
    t.sit('bot', null);
    const id = t.say('bot');
    expect(await t.submit({ lineId: id })).toEqual({ ok: false, refused: 'not_player' });
  });

  it('self: reporting your own seat', async () => {
    const t = setup();
    t.table();
    expect(await t.submit({ targetSeat: 'p1' })).toEqual({ ok: false, refused: 'self' });
  });

  it('self: another seat held by the same person (same account)', async () => {
    const t = setup();
    t.sit('p1', who('k1', 'acct-1'));
    t.sit('p2', who('k2', 'acct-1')); // signing in linked the two browsers: one subject
    expect(await t.submit()).toEqual({ ok: false, refused: 'self' });
  });

  it('self: your own earlier line, even from a seat you no longer hold', async () => {
    const t = setup();
    t.table();
    t.sit('p3', who('k1'), 'Me');
    const id = t.say('p3', 'mine');
    t.roster.unseat(ROOM, 'p3');
    expect(await t.submit({ lineId: id, targetSeat: 'p2' })).toEqual({ ok: false, refused: 'self' });
  });

  it('self: two subjects merged after they were seated are the same person', async () => {
    const t = setup();
    t.sit('p1', who('k1'));
    t.sit('p2', who('k2'));
    t.person(who('k1', 'acct-x'));
    t.person(who('k2', 'acct-x')); // links the two subjects
    expect(await t.submit()).toEqual({ ok: false, refused: 'self' });
  });

  it('self wins over rate: a self report at the limit is self', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 10; i++) t.seed({ reporterSubject: a, createdAt: NOW - H });
    expect(await t.submit({ targetSeat: 'p1' })).toMatchObject({ refused: 'self' });
  });

  it('not_player comes before self and before suspended', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 3; i++) t.seed({ reporterSubject: a, badFaithAt: NOW - DAY });
    expect(await t.submit({ targetSeat: 'nobody' })).toMatchObject({ refused: 'not_player' });
  });

  it('duplicate: the same pair in the same room twice', async () => {
    const t = setup();
    t.table();
    expect(await t.submit()).toMatchObject({ ok: true });
    expect(await t.submit()).toEqual({ ok: false, refused: 'duplicate' });
    expect(t.store.rawReports()).toHaveLength(1);
  });

  it('duplicate: a second report on the same person through a different line or category', async () => {
    const t = setup();
    t.table();
    const id = t.say('p2');
    await t.submit({ category: 'spam' });
    expect(await t.submit({ lineId: id, category: 'hate' })).toMatchObject({ refused: 'duplicate' });
  });

  it('controls for duplicate: another target, another reporter and another room are all accepted', async () => {
    const t = setup();
    t.table();
    t.sit('p3', who('k3'));
    await t.submit();
    expect(await t.submit({ targetSeat: 'p3' })).toMatchObject({ ok: true });
    expect(await t.submit({ reporterSeat: 'p3' })).toMatchObject({ ok: true });
    t.sit('p1', who('k1'), 'h', 'R2');
    t.sit('p2', who('k2'), 'h', 'R2');
    expect(await t.submit({ roomId: 'R2' })).toMatchObject({ ok: true });
  });

  it('duplicate across aliases: the reporter, then the target, merged after the first report', async () => {
    const t = setup();
    t.table();
    await t.submit();
    // The reporter signs in on a second browser and takes another seat; the same person reports the same target again.
    t.sit('p4', who('k4', 'acct-r'));
    t.person(who('k1', 'acct-r'));
    expect(await t.submit({ reporterSeat: 'p4' })).toEqual({ ok: false, refused: 'duplicate' });
    // The target now answers to a second seat held under another key linked to the same account.
    t.sit('p5', who('k5', 'acct-t'));
    t.person(who('k2', 'acct-t'));
    expect(await t.submit({ targetSeat: 'p5' })).toEqual({ ok: false, refused: 'duplicate' });
    expect(t.store.rawReports()).toHaveLength(1);
  });

  it('duplicate when the stored ids are the merged-away aliases: only the in-code alias check can see it', async () => {
    const t = setup();
    t.table();
    t.sit('p7', who('k7')); // the older subject survives a merge
    t.clock.t = NOW + 1000;
    t.sit('p8', who('k8'));
    t.sit('p9', who('k9'));
    await t.submit({ reporterSeat: 'p8' }); // stored under the younger ids
    expect(stored(t.store).reporterSubject).not.toBe(t.roster.occupant(ROOM, 'p7')?.subject);
    t.person(who('k7', 'acct-z'));
    t.person(who('k8', 'acct-z'));
    expect(await t.submit({ reporterSeat: 'p7' })).toEqual({ ok: false, refused: 'duplicate' });

    await t.submit({ reporterSeat: 'p1', targetSeat: 'p9' });
    t.person(who('k9', 'acct-w'));
    t.person(who('k2', 'acct-w')); // p2 and p9 are now one person (p2's subject is older)
    expect(await t.submit({ reporterSeat: 'p1', targetSeat: 'p2' })).toEqual({ ok: false, refused: 'duplicate' });
    expect(t.store.rawReports()).toHaveLength(2);
  });

  it('the UNIQUE index is a backstop: a repeat the pair check missed is still duplicate', async () => {
    const t = setup({ store: new BlindPairs() });
    t.table();
    expect(await t.submit()).toMatchObject({ ok: true });
    expect(await t.submit()).toEqual({ ok: false, refused: 'duplicate' });
    expect(t.store.rawReports()).toHaveLength(1);
  });

  it('a store that throws a UNIQUE error maps to duplicate, not off', async () => {
    const t = setup({ store: new UniqueThrowing() });
    t.table();
    expect(await t.submit()).toEqual({ ok: false, refused: 'duplicate' });
  });

  it('rate: the 11th report from one reporter inside 24 h', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 10; i++) t.seed({ reporterSubject: a, createdAt: NOW - H });
    expect(await t.submit()).toEqual({ ok: false, refused: 'rate', remaining: 0 });
    expect(t.store.rawReports()).toHaveLength(10);
  });

  it('rate: reports older than 24 h do not count, and a report exactly 24 h old is already outside', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 9; i++) t.seed({ reporterSubject: a, createdAt: NOW - DAY - 1 });
    t.seed({ reporterSubject: a, createdAt: NOW - DAY });
    expect(await t.submit()).toMatchObject({ ok: true, remaining: 9 });
  });

  it('rate: a report 24 h minus 1 ms old still counts', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 10; i++) t.seed({ reporterSubject: a, createdAt: NOW - DAY + 1 });
    expect(await t.submit()).toMatchObject({ refused: 'rate' });
  });

  it('rate: another reporter is not affected', async () => {
    const t = setup();
    const { a } = t.table();
    t.sit('p3', who('k3'));
    for (let i = 0; i < 10; i++) t.seed({ reporterSubject: a, createdAt: NOW - H });
    expect(await t.submit({ reporterSeat: 'p3' })).toMatchObject({ ok: true });
  });

  it('rate counts the person across merged aliases', async () => {
    const t = setup();
    const { a } = t.table();
    const other = t.person(who('k-other'));
    for (let i = 0; i < 5; i++) t.seed({ reporterSubject: a, createdAt: NOW - H });
    for (let i = 0; i < 5; i++) t.seed({ reporterSubject: other, createdAt: NOW - H });
    expect(await t.submit()).toMatchObject({ ok: true }); // two people so far: 5 each
    t.person(who('k-other', 'acct-m'));
    t.person(who('k1', 'acct-m')); // now one person with 10 (+1) reports
    t.sit('p6', who('k6'));
    expect(await t.submit({ targetSeat: 'p6' })).toEqual({ ok: false, refused: 'rate', remaining: 0 });
  });

  it('rate comes before duplicate: a repeat at the limit is rate', async () => {
    const t = setup();
    const { a } = t.table();
    await t.submit();
    for (let i = 0; i < 9; i++) t.seed({ reporterSubject: a, createdAt: NOW - H });
    expect(await t.submit()).toMatchObject({ refused: 'rate' });
  });

  it('remaining counts down from 9 and rate refuses at 0', async () => {
    const t = setup();
    t.table();
    const seen: number[] = [];
    for (let i = 0; i < 10; i++) {
      t.sit('p2', who(`target-${i}`));
      const res = await t.submit();
      expect(res.ok).toBe(true);
      seen.push((res as { remaining: number }).remaining);
    }
    expect(seen).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    t.sit('p2', who('target-11'));
    expect(await t.submit()).toEqual({ ok: false, refused: 'rate', remaining: 0 });
    expect(t.store.rawReports()).toHaveLength(10);
  });

  it('remaining refills as old reports age out', async () => {
    const t = setup();
    t.table();
    for (let i = 0; i < 10; i++) {
      t.sit('p2', who(`target-${i}`));
      await t.submit();
    }
    t.clock.t = NOW + DAY; // exactly 24 h later: the first ten are out of the window
    t.sit('p2', who('fresh'));
    expect(await t.submit()).toMatchObject({ ok: true, remaining: 9 });
  });

  it('refusals leave no row and call onReport never', async () => {
    const t = setup();
    t.table();
    await t.submit({ targetSeat: 'p1' });
    await t.submit({ targetSeat: 'nobody' });
    expect(t.store.rawReports()).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });
});

describe('report: moderation off', () => {
  it('enabled() false is off, and nothing is stored', async () => {
    const t = setup({ enabled: () => false });
    t.table();
    expect(await t.submit()).toEqual({ ok: false, refused: 'off' });
    expect(t.store.rawReports()).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it('enabled() is read per call: a kill switch works live', async () => {
    const flags = { on: false };
    const t = setup({ enabled: () => flags.on });
    t.table();
    expect(await t.submit()).toMatchObject({ refused: 'off' });
    flags.on = true;
    expect(await t.submit()).toMatchObject({ ok: true });
  });

  it('the reporter seat has no occupant: off', async () => {
    const t = setup();
    t.table();
    expect(await t.submit({ reporterSeat: 'ghost' })).toEqual({ ok: false, refused: 'off' });
  });

  it('the reporter has no subject (no key behind the seat): off', async () => {
    const t = setup();
    t.table();
    t.sit('p3', null);
    expect(await t.submit({ reporterSeat: 'p3' })).toEqual({ ok: false, refused: 'off' });
  });

  it('off wins over not_player and self', async () => {
    const t = setup({ enabled: () => false });
    t.table();
    expect(await t.submit({ targetSeat: 'nobody' })).toMatchObject({ refused: 'off' });
    expect(await t.submit({ targetSeat: 'p1' })).toMatchObject({ refused: 'off' });
  });

  it('control: the same call with moderation on is accepted', async () => {
    const t = setup({ enabled: () => true });
    t.table();
    expect(await t.submit()).toMatchObject({ ok: true });
  });

  it('a store read that throws is off, logged by event and error class only, and never rejects', async () => {
    const t = setup({ store: new ThrowingLoad() });
    t.table();
    const res = await t.submit();
    expect(res).toEqual({ ok: false, refused: 'off' });
    expect(t.logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(t.logs);
    expect(text).toContain('Error');
    expect(text).not.toContain('disk full');
    expect(text).not.toMatch(/s_[A-Za-z0-9_-]{10,}/);
  });

  it('a store write that throws is off and leaves no row', async () => {
    const t = setup({ store: new ThrowingInsert() });
    t.table();
    expect(await t.submit()).toEqual({ ok: false, refused: 'off' });
    expect(t.store.rawReports()).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it('an unexpected failure (a throwing roster) is off, not a rejection', async () => {
    const t = setup();
    t.table();
    t.roster.occupant = () => {
      throw new Error('boom');
    };
    await expect(t.submit()).resolves.toEqual({ ok: false, refused: 'off' });
  });

  it('a throwing logger does not turn a refusal into a rejection', async () => {
    const store = new ThrowingLoad();
    const clock = { now: () => NOW };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const roster = new RoomRoster();
    roster.seat(ROOM, 'p1', subjects.resolve(who('k1')), 'a');
    roster.seat(ROOM, 'p2', subjects.resolve(who('k2')), 'b');
    const svc = new ReportService({
      roster,
      buffer: new EvidenceBuffer({ clock }),
      subjects,
      store,
      clock,
      logger: {
        warn() {
          throw new Error('logger down');
        },
      },
    });
    await expect(svc.submit({ roomId: ROOM, reporterSeat: 'p1', targetSeat: 'p2', category: 'spam' })).resolves.toEqual({
      ok: false,
      refused: 'off',
    });
  });
});

describe('report: excerpt', () => {
  it("holds the whole buffer, the reporter's own lines and bystanders included, as p-indexed lines", async () => {
    const t = setup();
    t.table();
    t.sit('p3', who('k3'));
    t.say('p2', 'first');
    t.say('p1', 'second');
    t.say('p3', 'third');
    await t.submit();
    const row = stored(t.store);
    expect(row.excerpt.map((l) => l.raw)).toEqual(['first', 'second', 'third']);
    expect(row.excerpt.map((l) => l.seatId)).toEqual(['p2', 'p1', 'p3']);
    expect(row.excerpt.map((l) => l.lineId)).toEqual(['1', '2', '3']);
  });

  it('keeps blocked lines with what was typed, and the audience', async () => {
    const t = setup();
    t.table();
    t.say('p2', 'zorbak you', { blocked: true });
    await t.submit();
    expect(stored(t.store).excerpt[0]).toMatchObject({ raw: 'zorbak you', delivered: null, blocked: true, audience: null });
  });

  it('p indexes map lines to people, in first-seen order; no identifiers inside excerpt lines', async () => {
    const t = setup();
    const { a, b } = t.table();
    const c = t.sit('p3', who('k3')) as SubjectId;
    t.say('p2');
    t.say('p3');
    t.say('p2');
    t.say('p1');
    await t.submit();
    const row = stored(t.store);
    expect(row.people).toEqual([b, c, a]);
    expect(row.excerpt.map((l) => l.p)).toEqual([0, 1, 0, 2]);
    for (const line of row.excerpt) {
      expect(Object.keys(line).sort()).toEqual(['audience', 'blocked', 'delivered', 'handle', 'lineId', 'p', 'raw', 'seatId', 'ts']);
    }
    const lines = JSON.stringify(row.excerpt);
    for (const id of [a, b, c]) expect(lines).not.toContain(id);
  });

  it('a speaker with no subject has p null and is not in people', async () => {
    const t = setup();
    const { b } = t.table();
    t.sit('bot', null, 'Bot');
    t.say('bot', 'beep');
    t.say('p2');
    await t.submit();
    const row = stored(t.store);
    expect(row.excerpt.map((l) => l.p)).toEqual([null, 0]);
    expect(row.people).toEqual([b]);
  });

  it('aliases of one person share one p, and people holds the canonical id', async () => {
    const t = setup();
    t.table();
    const early = t.sit('p3', who('k3')) as SubjectId;
    t.say('p3', 'before');
    const merged = t.person(who('k3', 'acct-3'));
    t.sit('p4', who('k4', 'acct-3')); // the same person on a second browser: merges into one
    t.say('p4', 'after');
    await t.submit();
    const row = stored(t.store);
    const canon = t.subjects.canonical(early);
    expect(t.subjects.canonical(merged)).toBe(canon);
    expect(row.people).toEqual([canon]);
    expect(row.excerpt.map((l) => l.p)).toEqual([0, 0]);
  });

  it('a seat with no chat line: an empty excerpt and empty people, target from the seat', async () => {
    const t = setup();
    const { b } = t.table();
    const res = await t.submit();
    expect(res.ok).toBe(true);
    const row = stored(t.store);
    expect(row.excerpt).toEqual([]);
    expect(row.people).toEqual([]);
    expect(row.targetSubject).toBe(b);
  });

  it('a seat that has chatted nothing while others have: the excerpt is still the whole buffer', async () => {
    const t = setup();
    t.table();
    t.sit('p3', who('k3'));
    t.say('p3');
    await t.submit();
    expect(stored(t.store).excerpt).toHaveLength(1);
  });

  it('is frozen at report time: later chat does not change a stored excerpt', async () => {
    const t = setup();
    t.table();
    t.say('p2', 'before');
    await t.submit();
    t.say('p2', 'after');
    expect(stored(t.store).excerpt.map((l) => l.raw)).toEqual(['before']);
  });

  it('does not mutate the live buffer', async () => {
    const t = setup();
    t.table();
    t.say('p2');
    const before = t.buffer.snapshot(ROOM);
    await t.submit();
    expect(t.buffer.snapshot(ROOM)).toEqual(before);
  });

  it('only the room reported is snapshotted', async () => {
    const t = setup();
    t.table();
    t.sit('p9', who('k9'), 'x', 'OTHER');
    t.say('p9', 'elsewhere', { room: 'OTHER' });
    t.say('p2', 'here');
    await t.submit();
    expect(stored(t.store).excerpt.map((l) => l.raw)).toEqual(['here']);
  });

  it('the stored report is detached from what onReport receives', async () => {
    const t = setup({
      onReport: (r) => {
        r.excerpt.length = 0;
        r.people.length = 0;
      },
    });
    t.table();
    t.say('p2');
    await t.submit();
    expect(stored(t.store).excerpt).toHaveLength(1);
    expect(stored(t.store).people).toHaveLength(1);
  });
});

describe('report: counts for onReport', () => {
  it('a first report counts itself', async () => {
    const t = setup();
    t.table();
    await t.submit();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.counts).toEqual({ reports7d: 1, rooms7d: 1, auto7d: 0 });
    expect(stored(t.store)).toMatchObject(t.calls[0]?.report ?? {});
    expect(t.calls[0]?.report.status).toBe('open');
  });

  it('counts reports against the same person across rooms in 7 days, and distinct rooms', async () => {
    const t = setup();
    const { b } = t.table();
    t.seed({ targetSubject: b, roomId: 'A', createdAt: NOW - 2 * DAY });
    t.seed({ targetSubject: b, roomId: 'A', reporterSubject: 's_other', createdAt: NOW - DAY });
    t.seed({ targetSubject: b, roomId: 'B', createdAt: NOW - DAY });
    t.seed({ targetSubject: b, roomId: 'C', createdAt: NOW - 8 * DAY }); // too old
    t.seed({ targetSubject: 's_elsewhere', roomId: 'D', createdAt: NOW - DAY }); // someone else
    await t.submit();
    expect(t.calls[0]?.counts).toMatchObject({ reports7d: 4, rooms7d: 3 });
  });

  it('the 7 day boundary: exactly 7 days old counts, a millisecond older does not', async () => {
    const t = setup();
    const { b } = t.table();
    t.seed({ targetSubject: b, roomId: 'A', createdAt: NOW - 7 * DAY });
    t.seed({ targetSubject: b, roomId: 'B', createdAt: NOW - 7 * DAY - 1 });
    await t.submit();
    expect(t.calls[0]?.counts).toMatchObject({ reports7d: 2, rooms7d: 2 });
  });

  it('matches the reported person across merged aliases', async () => {
    const t = setup();
    const { b } = t.table();
    const alias = t.person(who('k-alias'));
    t.seed({ targetSubject: alias, roomId: 'A', createdAt: NOW - DAY });
    t.person(who('k-alias', 'acct-b'));
    t.person(who('k2', 'acct-b'));
    expect(t.subjects.canonical(alias)).toBe(t.subjects.canonical(b));
    await t.submit();
    expect(t.calls[0]?.counts).toMatchObject({ reports7d: 2, rooms7d: 2 });
  });

  const autoOn = (
    t: ReturnType<typeof setup>,
    subject: SubjectId,
    at: number,
    over: { kind?: SanctionKind; source?: Source; automated?: boolean; includeIp?: boolean } = {},
  ) =>
    applySanction(
      t.store,
      t.subjects,
      {
        kind: over.kind ?? 'chat',
        subject,
        includeIp: over.includeIp ?? false,
        durationMs: H,
        reason: 'r',
        actor: 'auto',
        source: over.source ?? 'auto_filter',
        automated: over.automated ?? true,
      },
      at,
    );

  it('counts the automatic chat restrictions of the last 7 days by group, for the person across aliases', async () => {
    const t = setup();
    t.sit('p1', who('k1'));
    const b = t.sit('p2', who('k2', null, 'ip-b')) as SubjectId;
    const alias = t.person(who('k-alias'));
    t.person(who('k-alias', 'acct-b'));
    t.person(who('k2', 'acct-b'));
    const other = t.person(who('k-other'));
    const rows = [
      { subject: b, at: NOW - DAY, includeIp: true }, // one group of two rows (subject + ip) counts once
      { subject: alias, at: NOW - 2 * DAY },
      { subject: b, at: NOW - 8 * DAY }, // too old
      { subject: b, at: NOW - DAY, source: 'moderator' as Source, automated: false }, // a moderator's
      { subject: b, at: NOW - DAY, kind: 'ban' as SanctionKind }, // not a chat restriction
      { subject: other, at: NOW - DAY }, // someone else
    ];
    for (const r of rows) await autoOn(t, r.subject, r.at, r);
    expect(t.store.rawSanctions().filter((r) => r.targetType === 'ip')).toHaveLength(1);
    await t.submit();
    expect(t.calls[0]?.counts.auto7d).toBe(2);
  });

  it('a throwing onReport is swallowed: the report is stored and the result is ok', async () => {
    const t = setup({
      onReport: () => {
        throw new Error('discord down');
      },
    });
    t.table();
    await expect(t.submit()).resolves.toMatchObject({ ok: true });
    expect(t.store.rawReports()).toHaveLength(1);
    expect(t.logs.map((l) => l.event)).toContain('reports.on_report_failed');
    expect(JSON.stringify(t.logs)).not.toContain('discord');
  });

  it('a rejecting async onReport is swallowed and logged, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (e: unknown) => void unhandled.push(e);
    process.on('unhandledRejection', listener);
    try {
      const t = setup({ onReport: (() => Promise.reject(new Error('discord down'))) as never });
      t.table();
      await expect(t.submit()).resolves.toMatchObject({ ok: true });
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
      expect(t.logs.map((l) => l.event)).toContain('reports.on_report_failed');
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('onReport runs once per stored report and is not retried after a throw', async () => {
    let n = 0;
    const t = setup({
      onReport: () => {
        n++;
        throw new Error('x');
      },
    });
    t.table();
    await t.submit();
    expect(n).toBe(1);
  });

  it('no onReport hook at all is fine', async () => {
    const store = new MemoryStore();
    const clock = { now: () => NOW };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const roster = new RoomRoster();
    roster.seat(ROOM, 'p1', subjects.resolve(who('k1')), 'a');
    roster.seat(ROOM, 'p2', subjects.resolve(who('k2')), 'b');
    const svc = new ReportService({ roster, buffer: new EvidenceBuffer({ clock }), subjects, store, clock });
    await expect(svc.submit({ roomId: ROOM, reporterSeat: 'p1', targetSeat: 'p2', category: 'spam' })).resolves.toMatchObject({ ok: true });
  });
});

describe('report: suspension after three bad-faith dismissals in 30 days', () => {
  it('three bad-faith reports actioned in the last 30 days: suspended, no row, no onReport', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 3; i++) t.seed({ reporterSubject: a, badFaithAt: NOW - (i + 1) * DAY });
    expect(await t.submit()).toEqual({ ok: false, refused: 'suspended' });
    expect(t.store.rawReports()).toHaveLength(3);
    expect(t.calls).toHaveLength(0);
  });

  it('control: two bad-faith marks do not suspend', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 2; i++) t.seed({ reporterSubject: a, badFaithAt: NOW - DAY });
    expect(await t.submit()).toMatchObject({ ok: true });
  });

  it('a mark actioned 31 days ago does not count: two recent plus one old is not enough', async () => {
    const t = setup();
    const { a } = t.table();
    t.seed({ reporterSubject: a, badFaithAt: NOW - 31 * DAY });
    t.seed({ reporterSubject: a, badFaithAt: NOW - DAY });
    t.seed({ reporterSubject: a, badFaithAt: NOW - 2 * DAY });
    expect(await t.submit()).toMatchObject({ ok: true });
  });

  it('the window is by actioned_at, not by when the report was filed', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 3; i++) t.seed({ reporterSubject: a, createdAt: NOW - 40 * DAY, badFaithAt: NOW - DAY });
    expect(await t.submit()).toMatchObject({ refused: 'suspended' });
  });

  it('a mark exactly 30 days old still counts; one a millisecond older does not', async () => {
    const t = setup();
    const { a } = t.table();
    t.seed({ reporterSubject: a, badFaithAt: NOW - 30 * DAY });
    t.seed({ reporterSubject: a, badFaithAt: NOW - 5 * DAY });
    t.seed({ reporterSubject: a, badFaithAt: NOW - 6 * DAY });
    expect(await t.submit()).toMatchObject({ refused: 'suspended' });

    const u = setup();
    const { a: ua } = u.table();
    u.seed({ reporterSubject: ua, badFaithAt: NOW - 30 * DAY - 1 });
    u.seed({ reporterSubject: ua, badFaithAt: NOW - 5 * DAY });
    u.seed({ reporterSubject: ua, badFaithAt: NOW - 6 * DAY });
    expect(await u.submit()).toMatchObject({ ok: true });
  });

  it('only bad_faith = 1 counts: plain dismissals and actioned reports do not', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 5; i++) {
      const row = t.seed({ reporterSubject: a });
      t.store.closeReport(row.id, 'dismissed', NOW - DAY);
    }
    expect(await t.submit()).toMatchObject({ ok: true });
  });

  it('a bad-faith row with no actioned_at (never closed) does not count', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 3; i++) t.store.markReportBadFaith(t.seed({ reporterSubject: a }).id, null);
    expect(await t.submit()).toMatchObject({ ok: true });
  });

  it('matches across aliases: marks filed under another subject of the same person count', async () => {
    const t = setup();
    const { a } = t.table();
    const old = t.person(who('old-key'));
    for (let i = 0; i < 3; i++) t.seed({ reporterSubject: old, badFaithAt: NOW - DAY });
    expect(await t.submit()).toMatchObject({ ok: true }); // two different people so far
    t.person(who('old-key', 'acct-rep'));
    t.person(who('k1', 'acct-rep'));
    expect(t.subjects.canonical(old)).toBe(t.subjects.canonical(a));
    t.sit('p6', who('k6'));
    expect(await t.submit({ targetSeat: 'p6' })).toMatchObject({ refused: 'suspended' });
  });

  it('marks split between the canonical id and an alias add up', async () => {
    const t = setup();
    const { a } = t.table();
    const old = t.person(who('old-key'));
    t.person(who('old-key', 'acct-rep'));
    t.person(who('k1', 'acct-rep'));
    t.seed({ reporterSubject: a, badFaithAt: NOW - DAY });
    t.seed({ reporterSubject: old, badFaithAt: NOW - DAY });
    t.seed({ reporterSubject: t.subjects.canonical(a), badFaithAt: NOW - 2 * DAY });
    expect(await t.submit()).toMatchObject({ refused: 'suspended' });
  });

  it('another reporter is not suspended by someone else\'s marks', async () => {
    const t = setup();
    const { a } = t.table();
    t.sit('p3', who('k3'));
    for (let i = 0; i < 3; i++) t.seed({ reporterSubject: a, badFaithAt: NOW - DAY });
    expect(await t.submit()).toMatchObject({ refused: 'suspended' });
    expect(await t.submit({ reporterSeat: 'p3' })).toMatchObject({ ok: true });
  });

  it('suspended comes before the rate check: a suspended reporter at the rate limit is suspended', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 3; i++) t.seed({ reporterSubject: a, badFaithAt: NOW - DAY });
    for (let i = 0; i < 10; i++) t.seed({ reporterSubject: a, createdAt: NOW - H });
    expect(await t.submit()).toEqual({ ok: false, refused: 'suspended' });
  });

  it('self still wins over suspended', async () => {
    const t = setup();
    const { a } = t.table();
    for (let i = 0; i < 3; i++) t.seed({ reporterSubject: a, badFaithAt: NOW - DAY });
    expect(await t.submit({ targetSeat: 'p1' })).toMatchObject({ refused: 'self' });
  });

  it('the suspension lifts on its own once the third-newest mark ages out', async () => {
    const t = setup();
    const { a } = t.table();
    for (const d of [1, 10, 20]) t.seed({ reporterSubject: a, badFaithAt: NOW - d * DAY });
    expect(await t.submit()).toMatchObject({ refused: 'suspended' });
    t.clock.t = NOW + 11 * DAY; // the 20-day-old mark is now 31 days old
    expect(await t.submit()).toMatchObject({ ok: true });
  });
});
