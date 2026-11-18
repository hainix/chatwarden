import { describe, expect, it } from 'vitest';
import type { KitEvent } from '../src/events.js';
import type { StoredReport } from '../src/types.js';
import { MIN, roomsWorld } from './roomsWorld.js';
import type { RoomsWorld } from './roomsWorld.js';

// R2: the report-surge chip. A hint on a case when enough reports reached one person inside a window: computed on read from rows the kit already holds (capped at 200 reports and 100
// reporters), shown only when enabled and over the threshold, and it changes no order, no decision input, no event and no refusal. A report from a new account is as valid as any.

const ON = { overrides: { desk: { surge: { enabled: true } } } } as const;

let n = 0;
/** Seat a reporter with an account of `ageDays` days (omit for an unknown age) in their own room and return their subject. */
function reporter(w: RoomsWorld, ageDays?: number): string {
  n += 1;
  const seat = w.player(`surge-room-${n}`, { seat: 'p1', ...(ageDays === undefined ? {} : { ageDays }) });
  return w.cw.rooms.subjectAt(`surge-room-${n}`, seat) as string;
}

function report(w: RoomsWorld, target: string, by: string, ago: number, over: Partial<StoredReport> = {}): string {
  n += 1;
  const id = `surge-r-${n}`;
  const row: StoredReport = {
    id,
    createdAt: w.clock.t - ago,
    roomId: `surge-room-x-${n}`,
    tags: {},
    reporterSubject: by,
    reporterSeat: 'p1',
    reporterHandle: 'Rep',
    targetSubject: target,
    targetSeat: 'p2',
    targetHandle: 'Tgt',
    category: 'harassment',
    reportedReason: 'harassment',
    note: null,
    lineId: null,
    excerpt: [],
    people: [],
    status: 'open',
    ...over,
  };
  if (!w.store.insertReport(row)) throw new Error('not stored');
  return id;
}

async function target(w: RoomsWorld): Promise<string> {
  n += 1;
  w.cw.rooms.seat(`surge-t-${n}`, 'p1', { clientKey: `surge-target-${n}-cccccccccc` }, 'Tgt');
  return w.cw.rooms.subjectAt(`surge-t-${n}`, 'p1') as string;
}

const surgeOf = (w: RoomsWorld, id: string) => (w.cw.reports.get(id) as { surge?: unknown } | null)?.surge;

describe('when the chip appears', () => {
  it('below the threshold nothing; at 5 reports in 10 minutes it appears with reports, distinct reporters, window and newAccounts', async () => {
    const w = await roomsWorld(ON);
    const t = await target(w);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(report(w, t, reporter(w, i === 0 ? 0 : 400), i * MIN));
    expect(surgeOf(w, ids[0]!)).toBeUndefined();
    ids.push(report(w, t, reporter(w, 1), 5 * MIN));
    expect(surgeOf(w, ids[0]!)).toEqual({ reports: 5, reporters: 5, windowMinutes: 10, newAccounts: 2, newAccountDays: 2 });
  });

  it('the window edge is inclusive: a report exactly 10 minutes old counts, one millisecond older does not', async () => {
    const w = await roomsWorld(ON);
    const t = await target(w);
    for (let i = 0; i < 4; i += 1) report(w, t, reporter(w, 400), i);
    const first = report(w, t, reporter(w, 400), 10 * MIN);
    expect(surgeOf(w, first)).toMatchObject({ reports: 5 });
    const w2 = await roomsWorld(ON);
    const t2 = await target(w2);
    for (let i = 0; i < 4; i += 1) report(w2, t2, reporter(w2, 400), i);
    const late = report(w2, t2, reporter(w2, 400), 10 * MIN + 1);
    expect(surgeOf(w2, late)).toBeUndefined();
  });

  it('desk.surge.reports and windowMinutes are taken from the settings', async () => {
    const w = await roomsWorld({ overrides: { desk: { surge: { enabled: true, reports: 3, windowMinutes: 2, newAccountDays: 5 } } } });
    const t = await target(w);
    const ids = [0, 1, 2].map((i) => report(w, t, reporter(w, 4), i * 30_000));
    expect(surgeOf(w, ids[0]!)).toEqual({ reports: 3, reporters: 3, windowMinutes: 2, newAccounts: 3, newAccountDays: 5 });
  });

  it('disabled gives no key at all, even over the threshold', async () => {
    const w = await roomsWorld();
    const t = await target(w);
    const ids = Array.from({ length: 8 }, () => report(w, t, reporter(w, 0), MIN));
    const got = w.cw.reports.get(ids[0]!) as unknown as Record<string, unknown>;
    expect('surge' in got).toBe(false);
  });

  it('the queue listing never carries it', async () => {
    const w = await roomsWorld(ON);
    const t = await target(w);
    for (let i = 0; i < 6; i += 1) report(w, t, reporter(w, 0), MIN);
    const page = w.cw.reports.list({ status: 'open' });
    expect(page.items.length).toBe(6);
    for (const item of page.items) expect('surge' in item).toBe(false);
  });

  it('reports a chat filter filed (no reporter) do not count; a decided report in the window does', async () => {
    const w = await roomsWorld(ON);
    const t = await target(w);
    for (let i = 0; i < 4; i += 1) report(w, t, `filter:f${i}`, MIN, { origin: 'filter', originKey: 'link.unlisted', reporterSeat: '', reporterHandle: '' });
    const id = report(w, t, reporter(w, 400), MIN);
    expect(surgeOf(w, id)).toBeUndefined();
    for (let i = 0; i < 4; i += 1) report(w, t, reporter(w, 400), MIN);
    expect(surgeOf(w, id)).toMatchObject({ reports: 5 });
  });
});

describe('the caps and the people', () => {
  it('200 reports and 100 reporters are the most read', async () => {
    const w = await roomsWorld({ overrides: { desk: { surge: { enabled: true, reports: 100, windowMinutes: 120, newAccountDays: 30 } } } });
    const t = await target(w);
    const people = Array.from({ length: 120 }, () => reporter(w, 1));
    let last = '';
    for (let i = 0; i < 250; i += 1) last = report(w, t, people[i % 120]!, 60_000 + i);
    const surge = surgeOf(w, last) as { reports: number; reporters: number; newAccounts: number };
    expect(surge.reports).toBe(200);
    expect(surge.reporters).toBe(100);
    expect(surge.newAccounts).toBeLessThanOrEqual(100);
  });

  it('a merged alias counts as one person, and reports against a merged alias of the target count', async () => {
    const w = await roomsWorld(ON);
    const t = await target(w);
    // two stored subjects that become one person: a key on one, an account on the other, then both presented together
    w.cw.rooms.seat('surge-ma', 'p1', { clientKey: 'surge-merge-key-aaaaaaaaaa' }, 'A');
    w.cw.rooms.seat('surge-mb', 'p1', { accountId: 'surge-merge-acct' }, 'B');
    const a = w.cw.rooms.subjectAt('surge-ma', 'p1') as string;
    const b = w.cw.rooms.subjectAt('surge-mb', 'p1') as string;
    expect(a).not.toBe(b);
    w.cw.rooms.seat('surge-mc', 'p1', { clientKey: 'surge-merge-key-aaaaaaaaaa', accountId: 'surge-merge-acct' }, 'C');
    expect(w.cw.rooms.subjectAt('surge-ma', 'p1')).toBe(w.cw.rooms.subjectAt('surge-mb', 'p1'));
    const ids = [report(w, t, a, MIN), report(w, t, b, MIN), report(w, t, a, 2 * MIN), report(w, t, b, 2 * MIN), report(w, t, reporter(w, 400), 3 * MIN)];
    expect(surgeOf(w, ids[0]!)).toMatchObject({ reports: 5, reporters: 2 });
  });
});

describe('newAccounts', () => {
  it('is null when no age hook is wired, a number otherwise; unknown ages are not counted as new', async () => {
    const none = await roomsWorld({ ...ON, signals: {} });
    const t = await target(none);
    const ids = Array.from({ length: 5 }, () => report(none, t, reporter(none, 0), MIN));
    expect(surgeOf(none, ids[0]!)).toMatchObject({ newAccounts: null });
    const w = await roomsWorld(ON);
    const t2 = await target(w);
    const ids2 = [reporter(w, 0), reporter(w), reporter(w, 3), reporter(w, 1.9), reporter(w, 2)].map((r) => report(w, t2, r, MIN));
    expect(surgeOf(w, ids2[0]!)).toMatchObject({ reports: 5, newAccounts: 2 });
  });

  it('a throwing hook counts nobody as new and never throws', async () => {
    const w = await roomsWorld({
      ...ON,
      signals: {
        accountAgeDays: () => {
          throw new Error('hook down');
        },
      },
    });
    const t = await target(w);
    const ids = Array.from({ length: 5 }, () => report(w, t, reporter(w), MIN));
    expect(surgeOf(w, ids[0]!)).toMatchObject({ reports: 5, newAccounts: 0 });
  });
});

describe('a hint and nothing more', () => {
  it('never changes an order, a decision input, an event or a refusal; a report from a new account is stored exactly like any other', async () => {
    const run = async (surge: boolean) => {
      const w = await roomsWorld({ overrides: { desk: { surge: { enabled: surge } } } });
      const events: KitEvent[] = [];
      w.cw.on('*', (e) => void events.push(e));
      const seen: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        w.cw.rooms.seat('R1', `rep${i}`, { clientKey: `surge-rep-${i}-aaaaaaaaaaaa`, accountId: `acct-rep-${i}` }, `Rep${i}`);
        w.ages.set(`acct-rep-${i}`, 0);
      }
      w.cw.rooms.seat('R1', 'tgt', { clientKey: 'surge-tgt-aaaaaaaaaaaaaa' }, 'Tgt');
      w.cw.chat.accept('R1', 'tgt', 'a line');
      for (let i = 0; i < 6; i += 1) {
        w.clock.t += 1000;
        const res = await w.cw.reports.submit({ roomId: 'R1', reporterSeat: `rep${i}`, targetSeat: 'tgt', reason: 'harassment' });
        if (!res.ok) throw new Error(res.refused);
        seen.push(res.reportId);
      }
      // subject ids are random per kit: compare the shapes with each id standing for itself
      const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(/s_[A-Za-z0-9_-]{22}/g, 'S'));
      const stored = seen.map((id) => {
        return plain({ ...w.store.loadReport(id)!, id: 'ID' });
      });
      const next = w.cw.cases.next('mod_ann');
      const order = w.cw.reports.list({ status: 'open' }).items.map((r) => r.reporterHandle);
      return { stored, events: plain(events.map((e) => ({ ...e, reportId: undefined }))), order, next: next === null ? null : 'ok' };
    };
    const off = await run(false);
    const on = await run(true);
    expect(on).toEqual(off);
  });

  it('reading a case with a surge writes nothing and raises no event', async () => {
    const w = await roomsWorld(ON);
    const events: KitEvent[] = [];
    w.cw.on('*', (e) => void events.push(e));
    const t = await target(w);
    const ids = Array.from({ length: 5 }, () => report(w, t, reporter(w, 0), MIN));
    const before = JSON.stringify(w.store.listReports({ limit: 50 }));
    w.cw.reports.get(ids[0]!);
    expect(JSON.stringify(w.store.listReports({ limit: 50 }))).toBe(before);
    expect(events).toEqual([]);
  });
});
