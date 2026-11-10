import { describe, expect, it } from 'vitest';
import type { ReportSummary } from '@chatwarden/http/admin';
import { filterGroups, groupQueue, queueStats } from '../src/queue.js';

const T = 1_800_000_000_000;
const MIN = 60_000;

let seq = 0;
function report(over: Partial<ReportSummary> = {}): ReportSummary {
  seq += 1;
  return {
    id: over.id ?? `r${String(seq).padStart(4, '0')}`,
    createdAt: T,
    roomId: 'room-a',
    tags: {},
    category: 'harassment',
    status: 'open',
    badFaith: false,
    targetPerson: 'person-a',
    reporterPerson: 'rep-1',
    actionedAt: null,
    actionedBy: null,
    targetHandle: 'Mallory',
    claim: null,
    viewing: [],
    ...over,
  };
}

describe('groupQueue', () => {
  it('is empty for no reports', () => {
    expect(groupQueue([])).toEqual([]);
  });

  it('makes one group for one report', () => {
    const [g, ...rest] = groupQueue([report({ id: 'r1', createdAt: T })]);
    expect(rest).toEqual([]);
    expect(g).toEqual({
      person: 'person-a',
      handle: 'Mallory',
      handles: ['Mallory'],
      categories: ['harassment'],
      reports: 1,
      open: 1,
      actioned: 0,
      dismissed: 0,
      rooms: ['room-a'],
      reporters: 1,
      firstAt: T,
      latestAt: T,
      oldestOpenAt: T,
      reportIds: ['r1'],
      entries: [{ id: 'r1', category: 'harassment', createdAt: T }],
      claim: null,
      viewing: [],
    });
  });

  it('groups by the reported person, not by handle', () => {
    const groups = groupQueue([
      report({ id: 'a', targetPerson: 'p1', targetHandle: 'One' }),
      report({ id: 'b', targetPerson: 'p2', targetHandle: 'One' }),
      report({ id: 'c', targetPerson: 'p1', targetHandle: 'Uno' }),
    ]);
    expect(groups.map((g) => [g.person, g.reports])).toEqual(expect.arrayContaining([['p1', 2], ['p2', 1]]));
    expect(groups).toHaveLength(2);
  });

  it('counts distinct rooms, reporters and categories, ignoring a blank room', () => {
    const [g] = groupQueue([
      report({ id: '1', roomId: 'x', reporterPerson: 'a', category: 'hate', createdAt: T }),
      report({ id: '2', roomId: 'x', reporterPerson: 'b', category: 'hate', createdAt: T + 1 }),
      report({ id: '3', roomId: 'y', reporterPerson: 'a', category: 'spam', createdAt: T + 2 }),
      report({ id: '4', roomId: '', reporterPerson: 'c', category: 'other', createdAt: T + 3 }),
    ]);
    expect(g?.reports).toBe(4);
    expect(g?.rooms.sort()).toEqual(['x', 'y']);
    expect(g?.reporters).toBe(3);
    expect(g?.categories).toHaveLength(3);
    expect(g?.categories).toEqual(expect.arrayContaining(['hate', 'spam', 'other']));
  });

  it('lists report ids newest first, and tracks the first and latest time', () => {
    const [g] = groupQueue([
      report({ id: 'old', createdAt: T }),
      report({ id: 'new', createdAt: T + 10 * MIN }),
      report({ id: 'mid', createdAt: T + 5 * MIN }),
    ]);
    expect(g?.reportIds).toEqual(['new', 'mid', 'old']);
    expect(g?.firstAt).toBe(T);
    expect(g?.latestAt).toBe(T + 10 * MIN);
  });

  it('keeps each report with its category and time, newest first, beside the ids', () => {
    const [g] = groupQueue([
      report({ id: 'old', createdAt: T, category: 'hate' }),
      report({ id: 'new', createdAt: T + 10 * MIN, category: 'spam' }),
    ]);
    expect(g?.entries).toEqual([
      { id: 'new', category: 'spam', createdAt: T + 10 * MIN },
      { id: 'old', category: 'hate', createdAt: T },
    ]);
    expect(g?.entries.map((e) => e.id)).toEqual(g?.reportIds);
  });

  it('breaks a tie on time by id, so the order never depends on input order', () => {
    const a = groupQueue([report({ id: 'a', createdAt: T }), report({ id: 'b', createdAt: T })]);
    const b = groupQueue([report({ id: 'b', createdAt: T }), report({ id: 'a', createdAt: T })]);
    expect(a[0]?.reportIds).toEqual(b[0]?.reportIds);
  });

  it('uses the newest known handle, lists the others, and has none when no report recorded one', () => {
    const [g] = groupQueue([
      report({ id: '1', createdAt: T, targetHandle: 'Old' }),
      report({ id: '2', createdAt: T + 2, targetHandle: null }),
      report({ id: '3', createdAt: T + 1, targetHandle: 'New' }),
    ]);
    expect(g?.handle).toBe('New');
    expect(g?.handles).toEqual(['New', 'Old']);
    const [none] = groupQueue([report({ targetHandle: null })]);
    expect(none?.handle).toBeNull();
    expect(none?.handles).toEqual([]);
  });

  it('counts reports by status', () => {
    const [g] = groupQueue([
      report({ status: 'open' }),
      report({ status: 'open' }),
      report({ status: 'actioned' }),
      report({ status: 'dismissed' }),
      report({ status: 'dismissed' }),
      report({ status: 'dismissed' }),
    ]);
    expect([g?.open, g?.actioned, g?.dismissed]).toEqual([2, 1, 3]);
  });

  it('tracks the oldest OPEN report apart from the oldest report; null when none is open', () => {
    const [g] = groupQueue([
      report({ id: 'd', createdAt: T, status: 'dismissed' }),
      report({ id: 'o1', createdAt: T + 5 * MIN, status: 'open' }),
      report({ id: 'o2', createdAt: T + 9 * MIN, status: 'open' }),
    ]);
    expect(g?.firstAt).toBe(T);
    expect(g?.oldestOpenAt).toBe(T + 5 * MIN);
    const [none] = groupQueue([report({ status: 'actioned' })]);
    expect(none?.oldestOpenAt).toBeNull();
  });

  it('sorts groups by newest activity first by default, and a tie by person', () => {
    const groups = groupQueue([
      report({ targetPerson: 'p-old', createdAt: T }),
      report({ targetPerson: 'p-new', createdAt: T + 9 * MIN }),
      report({ targetPerson: 'p-mid', createdAt: T + 3 * MIN }),
      report({ targetPerson: 'p-tie', createdAt: T + 3 * MIN }),
    ]);
    expect(groups.map((g) => g.person)).toEqual(['p-new', 'p-mid', 'p-tie', 'p-old']);
  });

  it('sorts by longest wait or by report count on request', () => {
    const items = [
      report({ targetPerson: 'a', createdAt: T + 5 * MIN }),
      report({ targetPerson: 'b', createdAt: T }),
      report({ targetPerson: 'b', createdAt: T + 9 * MIN }),
      report({ targetPerson: 'c', createdAt: T + 2 * MIN }),
      report({ targetPerson: 'c', createdAt: T + 3 * MIN }),
      report({ targetPerson: 'c', createdAt: T + 4 * MIN }),
    ];
    expect(groupQueue(items, { sort: 'oldest' }).map((g) => g.person)).toEqual(['b', 'c', 'a']);
    expect(groupQueue(items, { sort: 'reports' }).map((g) => g.person)).toEqual(['c', 'b', 'a']);
  });

  it('counts a report once when the same page overlaps (same id twice)', () => {
    const r = report({ id: 'dup' });
    const [g] = groupQueue([r, r, { ...r }]);
    expect(g?.reports).toBe(1);
    expect(g?.reportIds).toEqual(['dup']);
  });

  it('does not change its input', () => {
    const items = [report({ createdAt: T + 1 }), report({ createdAt: T })];
    const copy = JSON.stringify(items);
    groupQueue(items);
    expect(JSON.stringify(items)).toBe(copy);
  });

  it('handles 60+ reports from many people', () => {
    const items: ReportSummary[] = [];
    for (let i = 0; i < 130; i += 1) {
      items.push(report({ targetPerson: `p${i % 13}`, reporterPerson: `r${i}`, createdAt: T + i * MIN, roomId: `room-${i % 4}` }));
    }
    const groups = groupQueue(items);
    expect(groups).toHaveLength(13);
    expect(groups.reduce((n, g) => n + g.reports, 0)).toBe(130);
    for (const g of groups) {
      expect(g.reports).toBe(10);
      expect(g.reporters).toBe(10);
      expect(g.reportIds).toHaveLength(10);
    }
    for (let i = 1; i < groups.length; i += 1) expect(groups[i - 1]!.latestAt).toBeGreaterThanOrEqual(groups[i]!.latestAt);
  });

  it('keeps a person id with odd characters as is, and never invents keys on the group', () => {
    const [g] = groupQueue([report({ targetPerson: '__proto__' })]);
    expect(g?.person).toBe('__proto__');
    expect(Object.keys(g ?? {}).sort()).toEqual(
      ['actioned', 'categories', 'claim', 'dismissed', 'entries', 'firstAt', 'handle', 'handles', 'latestAt', 'oldestOpenAt', 'open', 'person', 'reportIds', 'reporters', 'reports', 'rooms', 'viewing'].sort(),
    );
  });
});

describe('queueStats', () => {
  it('is zero for an empty queue', () => {
    expect(queueStats([], T)).toEqual({ people: 0, reports: 0, longestWaitMs: null, oldestGroup: null });
  });
  it('counts people, reports and the longest wait of an open report', () => {
    const groups = groupQueue([
      report({ targetPerson: 'a', createdAt: T - 30 * MIN }),
      report({ targetPerson: 'a', createdAt: T - 5 * MIN }),
      report({ targetPerson: 'b', createdAt: T - 90 * MIN }),
    ]);
    const stats = queueStats(groups, T);
    expect([stats.people, stats.reports, stats.longestWaitMs, stats.oldestGroup?.person]).toEqual([2, 3, 90 * MIN, 'b']);
  });
  it('never reports a negative wait', () => {
    const groups = groupQueue([report({ createdAt: T + 5 * MIN })]);
    expect(queueStats(groups, T).longestWaitMs).toBe(0);
  });
});

describe('groupQueue: claims and viewing', () => {
  const claim = { by: 'maya@example.test', since: T - MIN, until: T + 9 * MIN };

  it('takes the claim and the viewers from the open reports of the person', () => {
    const [g] = groupQueue([
      report({ id: 'a', createdAt: T - 2 * MIN, claim, viewing: ['rin@example.test'] }),
      report({ id: 'b', createdAt: T - MIN, claim, viewing: ['rin@example.test', 'ana@example.test'] }),
    ]);
    expect(g?.claim).toEqual(claim);
    expect(g?.viewing).toEqual(['ana@example.test', 'rin@example.test']);
  });

  it('is unclaimed and unviewed when no report says otherwise', () => {
    const [g] = groupQueue([report({}), report({})]);
    expect([g?.claim, g?.viewing]).toEqual([null, []]);
  });

  it('copes with a server that sends neither field (an older server)', () => {
    const old = report({}) as Partial<ReportSummary>;
    delete old.claim;
    delete old.viewing;
    const [g] = groupQueue([old as ReportSummary]);
    expect([g?.claim, g?.viewing]).toEqual([null, []]);
  });

  it('ignores a claim on a report that is no longer open', () => {
    const [g] = groupQueue([report({ id: 'a', status: 'actioned', claim, viewing: ['x@example.test'] })]);
    expect([g?.claim, g?.viewing]).toEqual([null, []]);
  });

  it('keeps people apart: one person claimed does not claim the next', () => {
    const groups = groupQueue([report({ targetPerson: 'p1', claim }), report({ targetPerson: 'p2' })]);
    expect(groups.find((g) => g.person === 'p1')?.claim).toEqual(claim);
    expect(groups.find((g) => g.person === 'p2')?.claim).toBeNull();
  });

  it('copies the claim and the viewers, so a later change to the input does not leak in', () => {
    const input = report({ claim: { ...claim }, viewing: ['a@example.test'] });
    const [g] = groupQueue([input]);
    input.claim!.by = 'changed';
    input.viewing.push('b@example.test');
    expect(g?.claim?.by).toBe('maya@example.test');
    expect(g?.viewing).toEqual(['a@example.test']);
  });
});

describe('filterGroups', () => {
  const ann = 'ann@example.test';
  const live = (by: string) => ({ by, since: T - MIN, until: T + MIN });
  const groups = groupQueue([
    report({ targetPerson: 'p1', category: 'harassment', claim: live(ann) }),
    report({ targetPerson: 'p2', category: 'hate', claim: live('maya@example.test') }),
    report({ targetPerson: 'p3', category: 'harassment' }),
    report({ targetPerson: 'p3', category: 'spam' }),
    report({ targetPerson: 'p4', category: 'spam', claim: { by: 'maya@example.test', since: T - 20 * MIN, until: T - 10 * MIN } }),
  ]);
  const people = (list: typeof groups): string[] => list.map((g) => g.person).sort();

  it('all and all keeps everything', () => {
    expect(people(filterGroups(groups, { claim: 'all', category: 'all' }, ann, T))).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('unclaimed keeps cases nobody holds, a lapsed claim counting as nobody', () => {
    expect(people(filterGroups(groups, { claim: 'unclaimed', category: 'all' }, ann, T))).toEqual(['p3', 'p4']);
  });

  it('mine keeps only your live claims', () => {
    expect(people(filterGroups(groups, { claim: 'mine', category: 'all' }, ann, T))).toEqual(['p1']);
    expect(people(filterGroups(groups, { claim: 'mine', category: 'all' }, 'maya@example.test', T))).toEqual(['p2']);
  });

  it('a category keeps a person who has any report in it', () => {
    expect(people(filterGroups(groups, { claim: 'all', category: 'spam' }, ann, T))).toEqual(['p3', 'p4']);
    expect(people(filterGroups(groups, { claim: 'all', category: 'cheating' }, ann, T))).toEqual([]);
  });

  it('the two filters combine, and the order of the input is kept', () => {
    expect(people(filterGroups(groups, { claim: 'unclaimed', category: 'harassment' }, ann, T))).toEqual(['p3']);
    const ordered = filterGroups([...groups].reverse(), { claim: 'all', category: 'all' }, ann, T);
    expect(ordered.map((g) => g.person)).toEqual([...groups].reverse().map((g) => g.person));
  });

  it('does not change its input', () => {
    const before = groups.map((g) => g.person);
    filterGroups(groups, { claim: 'mine', category: 'hate' }, ann, T);
    expect(groups.map((g) => g.person)).toEqual(before);
  });
});
