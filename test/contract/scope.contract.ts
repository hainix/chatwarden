import { describe, expect, it } from 'vitest';
import type { SanctionRow, Store, StoredReport } from '@chatwarden/core';

// The contract of staff scope in the Store (migration 26, the any-server block): a report carries the room's `scope` tag in its own column, and every read that takes a scope applies
// it in the query. A scope list is "any of these"; an empty list is nobody; a report with no scope is invisible to a scoped read. One suite, run against every Store.

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const A = 'creator:alice';
const B = 'creator:bob';
const C = 'creator:carol';

const report = (id: string, scope: string | null, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: NOW,
  roomId: `ROOM-${id}`,
  tags: scope === null ? {} : { scope },
  ...(scope === null ? {} : { scope }),
  reporterSubject: `s_rep_${id}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: 's_tgt',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  note: null,
  lineId: null,
  excerpt: [],
  people: ['s_tgt'],
  status: 'open',
  ...over,
});

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

/** Seven reports: three in A (one urgent, one decided), two in B (one against another person), one in C, one with no scope. Oldest first by id. */
function seed(s: Store): void {
  const rows: StoredReport[] = [
    report('a1', A, { createdAt: NOW + 1 * MIN }),
    report('b1', B, { createdAt: NOW + 2 * MIN }),
    report('a2', A, { createdAt: NOW + 3 * MIN, urgent: true }),
    report('n1', null, { createdAt: NOW + 4 * MIN }),
    report('c1', C, { createdAt: NOW + 5 * MIN, targetSubject: 's_other', people: ['s_other'] }),
    report('a3', A, { createdAt: NOW + 6 * MIN }),
    report('b2', B, { createdAt: NOW + 7 * MIN, urgent: true, targetSubject: 's_other', people: ['s_other'] }),
  ];
  for (const r of rows) expect(s.insertReport(r)).toBe(true);
  s.closeReport('a3', 'actioned', false, 'mod', NOW + 8 * MIN, 'done');
}

const sanction = (id: string, group: string, reportId: string | undefined, over: Partial<SanctionRow> = {}): SanctionRow => ({
  id,
  groupId: group,
  refCode: `M-${group.toUpperCase().padEnd(5, 'X').slice(0, 5)}`,
  kind: 'warning',
  targetType: 'subject',
  value: 's_tgt',
  startsAt: NOW + 10 * MIN,
  endsAt: NOW + 10 * MIN,
  reason: 'r',
  rule: '1',
  gapNote: null,
  gapStatus: null,
  roomId: null,
  actor: 'mod',
  source: 'moderator',
  automated: false,
  pending: false,
  ...(reportId === undefined ? {} : { reportId }),
  ...over,
});

/** The checks behind the contract, as one function so a deliberately broken store can be shown to fail them. */
export function scopeChecks(make: () => Store): void {
  // listReports
  {
    const s = make();
    seed(s);
    expect(ids(s.listReports({ limit: 50 }))).toEqual(['b2', 'a3', 'c1', 'n1', 'a2', 'b1', 'a1']);
    expect(ids(s.listReports({ limit: 50, scope: [A] }))).toEqual(['a3', 'a2', 'a1']);
    expect(ids(s.listReports({ limit: 50, scope: [B] }))).toEqual(['b2', 'b1']);
    expect(ids(s.listReports({ limit: 50, scope: [A, B] }))).toEqual(['b2', 'a3', 'a2', 'b1', 'a1']);
    expect(ids(s.listReports({ limit: 50, scope: [B, A] }))).toEqual(['b2', 'a3', 'a2', 'b1', 'a1']);
    expect(ids(s.listReports({ limit: 50, scope: [A, A] }))).toEqual(['a3', 'a2', 'a1']);
    expect(s.listReports({ limit: 50, scope: [] })).toEqual([]);
    expect(s.listReports({ limit: 50, scope: ['creator:nobody'] })).toEqual([]);
    expect(ids(s.listReports({ limit: 50, scope: [A, 'creator:nobody'] }))).toEqual(['a3', 'a2', 'a1']);
    // no scope key at all: everything, the unscoped report included
    expect(ids(s.listReports({ limit: 50 }))).toContain('n1');
    // filters and paging combine with the scope
    expect(ids(s.listReports({ limit: 50, scope: [A], status: 'open' }))).toEqual(['a2', 'a1']);
    expect(ids(s.listReports({ limit: 50, scope: [A], status: 'actioned' }))).toEqual(['a3']);
    expect(ids(s.listReports({ limit: 50, scope: [A, B], urgent: true }))).toEqual(['b2', 'a2']);
    expect(ids(s.listReports({ limit: 50, scope: [A, B], reason: null }))).toEqual(['b2', 'a3', 'a2', 'b1', 'a1']);
    const first = s.listReports({ limit: 2, scope: [A, B] });
    expect(ids(first)).toEqual(['b2', 'a3']);
    const last = first[1]!;
    expect(ids(s.listReports({ limit: 2, scope: [A, B], before: last.createdAt, beforeId: last.id }))).toEqual(['a2', 'b1']);
    // the scope text is data: a LIKE or SQL fragment matches nothing
    for (const odd of ['%', 'creator:%', "x' OR '1'='1", 'creator:alice ']) expect(s.listReports({ limit: 50, scope: [odd] }), odd).toEqual([]);
  }
  // listOpenReports
  {
    const s = make();
    seed(s);
    expect(ids(s.listOpenReports({ limit: 50 }))).toEqual(['a1', 'b1', 'a2', 'n1', 'c1', 'b2']);
    expect(ids(s.listOpenReports({ limit: 50, scope: [A] }))).toEqual(['a1', 'a2']);
    expect(ids(s.listOpenReports({ limit: 50, scope: [A, B] }))).toEqual(['a1', 'b1', 'a2', 'b2']);
    expect(s.listOpenReports({ limit: 50, scope: [] })).toEqual([]);
    expect(ids(s.listOpenReports({ limit: 50, scope: [A, B], urgent: true }))).toEqual(['a2', 'b2']);
    expect(ids(s.listOpenReports({ limit: 50, scope: [A, B, C], category: 'harassment' }))).toEqual(['a1', 'b1', 'a2', 'c1', 'b2']);
    const first = s.listOpenReports({ limit: 2, scope: [A, B] });
    expect(ids(first)).toEqual(['a1', 'b1']);
    const last = first[1]!;
    expect(ids(s.listOpenReports({ limit: 2, scope: [A, B], after: last.createdAt, afterId: last.id }))).toEqual(['a2', 'b2']);
    expect(ids(s.listOpenReports({ limit: 50, scope: ['%'] }))).toEqual([]);
  }
  // loadReportInScope
  {
    const s = make();
    seed(s);
    expect(s.loadReportInScope('a1', [A])).toMatchObject({ id: 'a1', scope: A });
    expect(s.loadReportInScope('a1', [B, A])).toMatchObject({ id: 'a1' });
    expect(s.loadReportInScope('a1', [B])).toBeNull();
    expect(s.loadReportInScope('a1', [])).toBeNull();
    expect(s.loadReportInScope('n1', [A, B, C])).toBeNull();
    expect(s.loadReportInScope('nope', [A])).toBeNull();
    expect(s.loadReportInScope('a3', [A])).toMatchObject({ id: 'a3', status: 'actioned' });
    // the same record loadReport gives
    expect(s.loadReportInScope('b2', [B])).toEqual(s.loadReport('b2'));
    expect(s.loadReport('n1')).toMatchObject({ scope: null });
    expect(s.loadReport('a1')).toMatchObject({ scope: A });
  }
  // the person reads
  {
    const s = make();
    seed(s);
    expect(ids(s.listReportsByPerson(['s_tgt'], 50))).toEqual(['a3', 'n1', 'a2', 'b1', 'a1']);
    expect(ids(s.listReportsByPerson(['s_tgt'], 50, [A]))).toEqual(['a3', 'a2', 'a1']);
    expect(ids(s.listReportsByPerson(['s_tgt'], 50, [B]))).toEqual(['b1']);
    expect(s.listReportsByPerson(['s_tgt'], 50, [])).toEqual([]);
    expect(s.listReportsByPerson(['s_tgt'], 50, [C])).toEqual([]);
    expect(ids(s.listReportsByPerson(['s_tgt', 's_other'], 50, [B, C]))).toEqual(['b2', 'c1', 'b1']);
    expect(ids(s.listOpenReportsByPerson(['s_tgt'], 50))).toEqual(['n1', 'a2', 'b1', 'a1']);
    expect(ids(s.listOpenReportsByPerson(['s_tgt'], 50, [A]))).toEqual(['a2', 'a1']);
    expect(s.listOpenReportsByPerson(['s_tgt'], 50, [C])).toEqual([]);
    expect(s.listOpenReportsByPerson(['s_tgt'], 50, [])).toEqual([]);
    expect(ids(s.listOpenReportsByPerson(['s_other'], 1, [B]))).toEqual(['b2']);
  }
  // the urgent count
  {
    const s = make();
    seed(s);
    expect(s.countOpenUrgent?.()).toBe(2);
    expect(s.countOpenUrgent?.([A])).toBe(1);
    expect(s.countOpenUrgent?.([B])).toBe(1);
    expect(s.countOpenUrgent?.([A, B])).toBe(2);
    expect(s.countOpenUrgent?.([C])).toBe(0);
    expect(s.countOpenUrgent?.([])).toBe(0);
    s.closeReport('a2', 'dismissed', false, 'mod', NOW + 9 * MIN, 'no');
    expect(s.countOpenUrgent?.([A])).toBe(0);
  }
  // sanctions by the scope of their report
  {
    const s = make();
    seed(s);
    expect(s.insertSanctionGroup([sanction('x1', 'g1', 'a1'), sanction('x2', 'g1', 'a1', { targetType: 'ip', value: 'iphash' })])).toBe(true);
    expect(s.insertSanctionGroup([sanction('y1', 'g2', 'b1', { startsAt: NOW + 11 * MIN })])).toBe(true);
    expect(s.insertSanctionGroup([sanction('z1', 'g3', undefined, { startsAt: NOW + 12 * MIN })])).toBe(true);
    expect(s.insertSanctionGroup([sanction('w1', 'g4', 'n1', { startsAt: NOW + 13 * MIN })])).toBe(true);
    const groups = (scope?: readonly string[]): string[] => s.listSubjectSanctions({ limit: 50, ...(scope === undefined ? {} : { scope }) }).map((r) => r.groupId);
    expect(groups()).toEqual(['g4', 'g3', 'g2', 'g1']);
    expect(groups([A])).toEqual(['g1']);
    expect(groups([B])).toEqual(['g2']);
    expect(groups([A, B])).toEqual(['g2', 'g1']);
    expect(groups([])).toEqual([]);
    expect(groups([C])).toEqual([]);
    expect(s.listSubjectSanctions({ limit: 50, scope: [A], subjects: ['s_tgt'] }).map((r) => r.groupId)).toEqual(['g1']);
    expect(s.listSubjectSanctions({ limit: 50, scope: [A], subjects: ['s_nobody'] })).toEqual([]);
    expect(s.listSubjectSanctions({ limit: 50, scope: [A], groupId: 'g2' })).toEqual([]);
    expect(s.listSubjectSanctions({ limit: 50, scope: [B], groupId: 'g2' }).map((r) => r.groupId)).toEqual(['g2']);
    const page = s.listSubjectSanctions({ limit: 1, scope: [A, B] });
    expect(page.map((r) => r.groupId)).toEqual(['g2']);
    expect(s.listSubjectSanctions({ limit: 1, scope: [A, B], before: page[0]!.startsAt, beforeId: page[0]!.id }).map((r) => r.groupId)).toEqual(['g1']);
  }
}

export function scopeContract(name: string, make: () => Store): void {
  describe(`scope contract: ${name}`, () => {
    it('a report carries the scope it was filed with, null when it had none, and nothing else changes in the record', () => {
      const s = make();
      expect(s.insertReport(report('r1', A))).toBe(true);
      expect(s.insertReport(report('r2', null))).toBe(true);
      expect(s.loadReport('r1')?.scope).toBe(A);
      expect(s.loadReport('r2')?.scope).toBeNull();
      expect(s.loadReport('r1')?.tags).toEqual({ scope: A });
    });

    it('a report whose row omits the scope reads as null, and the tag alone does not make a scope (the service stamps it)', () => {
      const s = make();
      s.insertReport(report('r1', null, { tags: { scope: A } }));
      expect(s.loadReport('r1')?.scope).toBeNull();
      expect(s.listReports({ limit: 10, scope: [A] })).toEqual([]);
    });

    it('listReports, listOpenReports, loadReportInScope, the person reads, countOpenUrgent and listSubjectSanctions apply the scope in the query, in the same order and cursor as unscoped', () => {
      scopeChecks(make);
    });

    it('a store that ignores scope fails the contract (a deliberately broken stub)', () => {
      const broken = (): Store =>
        new Proxy(make(), {
          get(target, prop, receiver) {
            const v = Reflect.get(target, prop, target) as unknown;
            if (prop === 'listReports' || prop === 'listOpenReports') {
              return (q: Record<string, unknown>) => (v as (q: unknown) => unknown).call(target, { ...q, scope: undefined });
            }
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, prop, receiver);
          },
        });
      expect(() => scopeChecks(broken)).toThrow();
    });

    it('a store that post-filters after the limit also fails: the filter must be in the query', () => {
      const lazy = (): Store =>
        new Proxy(make(), {
          get(target, prop, receiver) {
            const v = Reflect.get(target, prop, target) as unknown;
            if (prop === 'listReports') {
              return (q: { scope?: readonly string[]; limit: number }) => {
                const rows = (v as (q: unknown) => Array<{ scope: string | null }>).call(target, { ...q, scope: undefined, limit: q.limit });
                return q.scope === undefined ? rows : rows.filter((r) => r.scope !== null && q.scope!.includes(r.scope));
              };
            }
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, prop, receiver);
          },
        });
      const s = lazy();
      for (let i = 0; i < 6; i += 1) s.insertReport(report(`x${i}`, i === 0 ? A : B, { createdAt: NOW + i * MIN }));
      // the single in-scope report is the oldest: a limit of 2 on the unfiltered rows never reaches it
      expect(ids(s.listReports({ limit: 2, scope: [A] }))).not.toEqual(['x0']);
      const real = make();
      for (let i = 0; i < 6; i += 1) real.insertReport(report(`x${i}`, i === 0 ? A : B, { createdAt: NOW + i * MIN }));
      expect(ids(real.listReports({ limit: 2, scope: [A] }))).toEqual(['x0']);
    });
  });
}
