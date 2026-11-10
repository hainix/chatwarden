import { describe, expect, it } from 'vitest';
import { ownLineIdsByPerson, ownLines } from '../src/notices.js';
import {
  decodeReportCursor,
  encodeReportCursor,
  listStaffReports,
  REPORT_PAGE_DEFAULT,
  REPORT_PAGE_MAX,
  ReportQueryError,
  staffReport,
} from '../src/staffReports.js';
import { SubjectIndex } from '../src/subjects.js';
import type { ReportExcerptLine, ReportRecord, SubjectId } from '../src/types.js';
import { MemoryStore } from '@chatwarden/store-memory';

const NOW = 1_800_000_000_000;

function env() {
  const store = new MemoryStore();
  const clock = { now: () => NOW };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const person = (key: string, account: string | null = null): SubjectId => {
    const s = subjects.resolve({ clientKey: key, accountId: account, ipHash: null });
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  return { store, subjects, person };
}

const line = (lineId: string, p: number | null): ReportExcerptLine => ({
  lineId,
  ts: NOW,
  seatId: 'seat',
  handle: 'H',
  raw: 'hi',
  delivered: 'hi',
  blocked: false,
  audience: null,
  p,
});

const record = (over: Partial<ReportRecord> = {}): ReportRecord => ({
  id: 'r1',
  createdAt: NOW,
  roomId: 'ROOM',
  tags: {},
  reporterSubject: 's_rep',
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: 's_tgt',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
  badFaith: false,
  actionedAt: null,
  actionedBy: null,
  modNote: null,
  badFaithEvidence: null,
  ...over,
});

describe('ownLineIdsByPerson', () => {
  it('maps every person to their own line ids in the report order, empty for a person with none', () => {
    const { subjects, person } = env();
    const a = person('ka');
    const b = person('kb');
    const c = person('kc');
    const r = record({
      people: [a, b, c],
      excerpt: [line('a1', 0), line('b1', 1), line('a2', 0), line('n1', null), line('x', 9), line('f', 0.5)],
    });
    expect(ownLineIdsByPerson(r, subjects)).toEqual({ [a]: ['a1', 'a2'], [b]: ['b1'], [c]: [] });
  });

  it('an empty report maps nobody; people with an empty excerpt map to empty arrays', () => {
    const { subjects, person } = env();
    const a = person('ka');
    expect(ownLineIdsByPerson(record(), subjects)).toEqual({});
    expect(ownLineIdsByPerson(record({ people: [a] }), subjects)).toEqual({ [a]: [] });
  });

  it('agrees with ownLines for every person, merged aliases included', () => {
    const { subjects, person } = env();
    const a = person('ka');
    const b = person('kb', 'acct-b');
    const c = person('kc');
    const r = record({
      people: [a, b, c],
      excerpt: [line('a1', 0), line('b1', 1), line('c1', 2), line('b2', 1), line('a2', 0)],
    });
    const before = ownLineIdsByPerson(r, subjects);
    expect(before[a]).toEqual(['a1', 'a2']);
    expect(before[b]).toEqual(['b1', 'b2']);
    const merged = person('ka', 'acct-b');
    const after = ownLineIdsByPerson(r, subjects);
    expect(Object.keys(after).sort()).toEqual([merged, c].sort());
    expect(after[merged]).toEqual(['a1', 'b1', 'b2', 'a2']);
    for (const [ref, ids] of Object.entries(after)) {
      expect(ownLines(r, ref, ids, subjects).map((l) => l.lineId)).toEqual(ids);
    }
    // Control: nothing leaks across people.
    expect(after[c]).toEqual(['c1']);
  });
});

describe('report cursor', () => {
  it('round-trips createdAt and id, including ids with colons and non-ASCII characters', () => {
    for (const id of ['r1', 'a:b:c', 'ünï-€-\u{1F600}', 'x'.repeat(200)]) {
      const c = encodeReportCursor(NOW, id);
      expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeReportCursor(c)).toEqual({ createdAt: NOW, id });
    }
  });

  it('refuses malformed cursors with ReportQueryError', () => {
    const b64 = (s: string): string => Buffer.from(s).toString('base64url');
    const bad = ['', '!!!', 'not a cursor', b64('nocolon'), b64('abc:id'), b64('12.5:id'), b64('-1:id'), b64('12:'), b64('99999999999999999999:id')];
    for (const c of bad) expect(() => decodeReportCursor(c), c).toThrow(ReportQueryError);
  });
});

describe('listStaffReports', () => {
  function seed(n: number, over: (i: number) => Partial<ReportRecord> = () => ({})) {
    const e = env();
    for (let i = 0; i < n; i++) {
      e.store.insertReport({
        ...record({ id: `r${String(i).padStart(3, '0')}`, createdAt: NOW + i, reporterSubject: `s_rep${i}`, ...over(i) }),
        status: 'open',
      });
    }
    return e;
  }

  it('limits: default 50, max 200, clamped (never thrown) for zero, negative, fractional, NaN and huge', () => {
    expect(REPORT_PAGE_DEFAULT).toBe(50);
    expect(REPORT_PAGE_MAX).toBe(200);
    const { store, subjects } = seed(230);
    const n = (limit?: unknown) => listStaffReports(store, subjects, limit === undefined ? {} : { limit: limit as number }).items.length;
    expect(n()).toBe(50);
    expect(n(10)).toBe(10);
    expect(n(200)).toBe(200);
    expect(n(201)).toBe(200);
    expect(n(1_000_000)).toBe(200);
    expect(n(Infinity)).toBe(200);
    expect(n(0)).toBe(1);
    expect(n(-5)).toBe(1);
    expect(n(2.9)).toBe(2);
    expect(n(Number.NaN)).toBe(50);
    expect(n('7')).toBe(50);
    expect(n(null)).toBe(50);
  });

  it('walks every report exactly once, newest first, with ties on createdAt broken by id descending', () => {
    const { store, subjects } = seed(23, (i) => ({ createdAt: NOW + Math.floor(i / 5) }));
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const page: { items: Array<{ id: string }>; next: string | null } = listStaffReports(store, subjects, {
        limit: 4,
        ...(before === null ? {} : { before }),
      });
      seen.push(...page.items.map((r) => r.id));
      before = page.next;
      pages += 1;
    } while (before !== null && pages < 20);
    const expected = Array.from({ length: 23 }, (_, i) => `r${String(i).padStart(3, '0')}`).sort((a, b) => {
      const ta = Math.floor(Number(a.slice(1)) / 5);
      const tb = Math.floor(Number(b.slice(1)) / 5);
      return tb - ta || (a < b ? 1 : -1);
    });
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(23);
    expect(before).toBeNull();
  });

  it('next is null when the page is not full and a cursor otherwise (the last item)', () => {
    const { store, subjects } = seed(5);
    expect(listStaffReports(store, subjects, { limit: 10 }).next).toBeNull();
    const full = listStaffReports(store, subjects, { limit: 5 });
    expect(full.next).toBe(encodeReportCursor(NOW, 'r000'));
    const part = listStaffReports(store, subjects, { limit: 2 });
    expect(part.items.map((r) => r.id)).toEqual(['r004', 'r003']);
    expect(part.next).toBe(encodeReportCursor(NOW + 3, 'r003'));
    // An exactly-full last page still says "may exist"; the next page is empty with next null.
    const after = listStaffReports(store, subjects, { limit: 5, before: full.next ?? '' });
    expect(after).toEqual({ items: [], next: null });
  });

  it('a report filed after the first page does not shift the next page', () => {
    const { store, subjects } = seed(6);
    const p1 = listStaffReports(store, subjects, { limit: 3 });
    store.insertReport({ ...record({ id: 'new', createdAt: NOW + 100, reporterSubject: 's_new' }), status: 'open' });
    const p2 = listStaffReports(store, subjects, { limit: 3, before: p1.next ?? '' });
    expect(p2.items.map((r) => r.id)).toEqual(['r002', 'r001', 'r000']);
  });

  it('filters by status, with the cursor and the filter together', () => {
    const { store, subjects } = seed(9);
    for (const id of ['r001', 'r004', 'r007']) store.closeReport(id, 'actioned', false, 'mod', NOW, 'n');
    for (const id of ['r002', 'r005']) store.closeReport(id, 'dismissed', true, 'mod', NOW, 'n', 'ev');
    const page = (status?: 'open' | 'actioned' | 'dismissed', before?: string) =>
      listStaffReports(store, subjects, { limit: 2, ...(status ? { status } : {}), ...(before ? { before } : {}) });
    expect(page('actioned').items.map((r) => r.id)).toEqual(['r007', 'r004']);
    expect(page('dismissed').items.map((r) => r.id)).toEqual(['r005', 'r002']);
    const open = page('open');
    expect(open.items.map((r) => r.id)).toEqual(['r008', 'r006']);
    expect(page('open', open.next ?? '').items.map((r) => r.id)).toEqual(['r003', 'r000']);
    expect(page(undefined).items.map((r) => r.id)).toEqual(['r008', 'r007']);
    expect(page('actioned').items.every((r) => r.status === 'actioned')).toBe(true);
  });

  it('an unknown status or a malformed cursor throws ReportQueryError', () => {
    const { store, subjects } = seed(1);
    expect(() => listStaffReports(store, subjects, { status: 'weird' as never })).toThrow(ReportQueryError);
    expect(() => listStaffReports(store, subjects, { before: 'garbage!' })).toThrow(ReportQueryError);
    expect(() => listStaffReports(store, subjects, { before: 12 as never })).toThrow(ReportQueryError);
  });

  it('an empty store lists nothing', () => {
    const { store, subjects } = env();
    expect(listStaffReports(store, subjects, {})).toEqual({ items: [], next: null });
  });
});

describe('staffReport', () => {
  it('keeps every record field and adds the staff refs and the own line ids', () => {
    const { subjects, person } = env();
    const t = person('kt');
    const rep = person('kr');
    const r = record({
      reporterSubject: rep,
      targetSubject: t,
      people: [t],
      excerpt: [line('t1', 0)],
      status: 'actioned',
      badFaith: true,
      actionedAt: NOW,
      actionedBy: 'mod',
      modNote: 'n',
      badFaithEvidence: 'ev',
    });
    expect(staffReport(r, subjects)).toEqual({
      ...r,
      targetPerson: t,
      reporterPerson: rep,
      people: [t],
      ownLineIds: { [t]: ['t1'] },
    });
  });

  it('shows the canonical person after a merge, keeping people aligned with the excerpt p indexes', () => {
    const { subjects, person } = env();
    const a = person('ka');
    const b = person('kb', 'acct-b');
    const rep = person('kr', 'acct-r');
    const r = record({ reporterSubject: rep, targetSubject: b, people: [a, b], excerpt: [line('a1', 0), line('b1', 1)] });
    const merged = person('ka', 'acct-b');
    const s = staffReport(r, subjects);
    expect(s.targetPerson).toBe(merged);
    expect(s.reporterPerson).toBe(rep);
    expect(s.people).toEqual([merged, merged]);
    expect(s.people).toHaveLength(r.people.length);
    expect(s.ownLineIds).toEqual({ [merged]: ['a1', 'b1'] });
    // The stored ids are left as filed.
    expect(s.targetSubject).toBe(b);
  });

  it('does not alias the record it was given', () => {
    const { subjects, person } = env();
    const a = person('ka');
    const r = record({ people: [a], excerpt: [line('a1', 0)] });
    const s = staffReport(r, subjects);
    s.people.push('x');
    s.excerpt.push(line('z', 0));
    expect(r.people).toHaveLength(1);
    expect(r.excerpt).toHaveLength(1);
  });
});

describe('listStaffReports with a person filter', () => {
  function seed() {
    const e = env();
    const a = e.person('ka');
    const b = e.person('kb');
    const add = (id: string, createdAt: number, target: SubjectId, over: Partial<ReportRecord> = {}) =>
      e.store.insertReport({
        ...record({ id, createdAt, targetSubject: target, reporterSubject: `s_rep_${id}`, people: [target], ...over }),
        status: 'open',
      });
    add('a1', NOW + 1, a);
    add('b1', NOW + 2, b);
    add('a2', NOW + 3, a);
    add('b2', NOW + 4, b);
    return { ...e, a, b, add };
  }

  it('lists only reports against the person, newest first', () => {
    const { store, subjects, a, b } = seed();
    expect(listStaffReports(store, subjects, { person: a }).items.map((r) => r.id)).toEqual(['a2', 'a1']);
    expect(listStaffReports(store, subjects, { person: b }).items.map((r) => r.id)).toEqual(['b2', 'b1']);
  });

  it('honours limit (clamped like the queue) and returns no cursor', () => {
    const { store, subjects, a } = seed();
    const page = listStaffReports(store, subjects, { person: a, limit: 1 });
    expect(page.items.map((r) => r.id)).toEqual(['a2']);
    expect(page.next).toBeNull();
    expect(listStaffReports(store, subjects, { person: a, limit: 0 }).items).toHaveLength(1);
    expect(listStaffReports(store, subjects, { person: a, limit: Number.NaN }).items).toHaveLength(2);
  });

  it('includes reports filed against a merged alias, and finds them by either id', () => {
    const { store, subjects, a, add } = seed();
    const alias = subjects.resolve({ clientKey: 'alias-key', accountId: null, ipHash: null }) as SubjectId;
    add('al1', NOW + 9, alias);
    subjects.resolve({ clientKey: 'alias-key', accountId: 'acct-merge', ipHash: null });
    subjects.resolve({ clientKey: 'ka', accountId: 'acct-merge', ipHash: null });
    const root = subjects.canonical(a);
    expect(subjects.canonical(alias)).toBe(root);
    const viaRoot = listStaffReports(store, subjects, { person: root }).items.map((r) => r.id);
    const viaAlias = listStaffReports(store, subjects, { person: alias }).items.map((r) => r.id);
    expect(viaRoot).toEqual(['al1', 'a2', 'a1']);
    expect(viaAlias).toEqual(viaRoot);
  });

  it('an unknown person lists nothing', () => {
    const { store, subjects } = seed();
    expect(listStaffReports(store, subjects, { person: 's_nobody' })).toEqual({ items: [], next: null });
  });

  it('refuses a person with a status or a cursor, and a person that is not a string (ReportQueryError)', () => {
    const { store, subjects, a } = seed();
    expect(() => listStaffReports(store, subjects, { person: a, status: 'open' })).toThrow(ReportQueryError);
    expect(() => listStaffReports(store, subjects, { person: a, before: encodeReportCursor(NOW, 'x') })).toThrow(ReportQueryError);
    expect(() => listStaffReports(store, subjects, { person: 5 as never })).toThrow(ReportQueryError);
    expect(() => listStaffReports(store, subjects, { person: '' })).toThrow(ReportQueryError);
  });

  it('controls: no person still lists everyone', () => {
    const { store, subjects } = seed();
    expect(listStaffReports(store, subjects, {}).items).toHaveLength(4);
  });
});
