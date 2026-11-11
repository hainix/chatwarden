import { describe, expect, it } from 'vitest';
import type { SanctionRow, Store, StoredReport } from '@chatwarden/core';

// The contract of the reporting-reason methods of the Store (K4 Task 7h): `reportedReason` on a report, the `reason` filter of
// `listReports`, the optional `addReportDetail` (the reporter's one follow-up) and the optional `loadReporterDecisions` (the
// reporter-accuracy read). One suite, run against every Store.

const H = 3_600_000;
const NOW = 1_800_000_000_000;

const report = (over: Partial<StoredReport> = {}): StoredReport => ({
  id: 'r1',
  createdAt: NOW,
  roomId: 'ROOM1',
  tags: { mode: 'ranked' },
  reporterSubject: 's_rep',
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: 's_tgt',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  reportedReason: 'harassment',
  note: 'rude',
  lineId: '3',
  excerpt: [{ lineId: '3', ts: NOW - 5, seatId: 'p2', handle: 'Tgt', raw: 'zorbak "you"', delivered: null, blocked: true, audience: ['p1'], p: 0 }],
  people: ['s_tgt'],
  status: 'open',
  ...over,
});

let seq = 0;
const sanction = (over: Partial<SanctionRow> = {}): SanctionRow => {
  seq += 1;
  return {
    id: `sr${seq}`, groupId: 'g1', refCode: 'M-AAAAA', kind: 'warning', targetType: 'subject', value: 's_tgt', startsAt: NOW, endsAt: null,
    reason: 'r', rule: '1', gapNote: null, gapStatus: null, roomId: null, actor: 'mod', source: 'moderator', automated: false, pending: false,
    ...over,
  };
};

/** The methods a first-party store has and a custom one may leave out. */
interface WithReasons {
  addReportDetail(id: string, d: { reportedReason: string | null; category: StoredReport['category']; note: string | null; at: number }): boolean;
  loadReporterDecisions(reporters: readonly string[]): Array<{
    reportId: string;
    status: 'actioned' | 'dismissed';
    reason: string;
    target: string;
    actions: Array<{ subject: string; rule: number | 'uncovered' }>;
  }>;
}
const reasons = (s: Store): WithReasons => {
  if (s.addReportDetail === undefined || s.loadReporterDecisions === undefined) throw new Error('this store has no reporting-reason methods');
  return s as unknown as WithReasons;
};

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
let n = 0;
/** A report in its own room, so the UNIQUE index never trips. */
const filed = (over: Partial<StoredReport> = {}): StoredReport => {
  n += 1;
  return report({ id: `f${n}`, roomId: `ROOM-${n}`, createdAt: NOW + n, ...over });
};

export function reportReasonsContract(name: string, make: () => Store): void {
  describe(`report reasons contract: ${name}`, () => {
    it('has both optional methods', () => {
      const s = make();
      expect(typeof s.addReportDetail).toBe('function');
      expect(typeof s.loadReporterDecisions).toBe('function');
    });

    describe('reportedReason and detailAt on insertReport / loadReport', () => {
      it('round-trips a reason id, and a new report has no follow-up', () => {
        const s = make();
        s.insertReport(report({ reportedReason: 'hate' }));
        expect(s.loadReport('r1')).toMatchObject({ reportedReason: 'hate', detailAt: null, category: 'harassment' });
      });
      it('a null reason reads as null, and so does a report given without the field', () => {
        const s = make();
        s.insertReport(report({ id: 'a', roomId: 'A', reportedReason: null }));
        const { reportedReason: _omitted, ...legacy } = report({ id: 'b', roomId: 'B' });
        void _omitted;
        s.insertReport(legacy);
        expect(s.loadReport('a')?.reportedReason).toBeNull();
        expect(s.loadReport('b')?.reportedReason).toBeNull();
      });
      it('every list returns it', () => {
        const s = make();
        s.insertReport(report({ reportedReason: 'spam' }));
        expect(s.listReports({ limit: 10 })[0]?.reportedReason).toBe('spam');
        expect(s.listReportsByPerson(['s_tgt'], 10)[0]?.reportedReason).toBe('spam');
        expect(s.listOpenReports({ limit: 10 })[0]?.reportedReason).toBe('spam');
        expect(s.listOpenReportsByPerson(['s_tgt'], 10)[0]?.reportedReason).toBe('spam');
      });
    });

    describe('listReports reason filter', () => {
      const seed = (s: Store) => {
        for (const reason of ['hate', 'spam', 'hate', null, 'other', null, 'hate'] as const) s.insertReport(filed({ reportedReason: reason }));
      };
      it('keeps only that reason, newest first', () => {
        const s = make();
        seed(s);
        expect(ids(s.listReports({ reason: 'hate', limit: 10 }))).toEqual(['f' + (n), 'f' + (n - 4), 'f' + (n - 6)]);
        expect(s.listReports({ reason: 'spam', limit: 10 })).toHaveLength(1);
      });
      it('null keeps only reports with none; undefined keeps all', () => {
        const s = make();
        seed(s);
        expect(s.listReports({ reason: null, limit: 10 })).toHaveLength(2);
        expect(s.listReports({ limit: 10 })).toHaveLength(7);
      });
      it('an id nobody used is empty, and the match is exact (no prefix, no case folding)', () => {
        const s = make();
        seed(s);
        for (const r of ['gone', 'hat', 'hate_', 'HATE', '']) expect(s.listReports({ reason: r, limit: 10 }), r).toEqual([]);
      });
      it('pages with a cursor and a status', () => {
        const s = make();
        seed(s);
        const first = s.listReports({ reason: 'hate', limit: 2 });
        expect(first).toHaveLength(2);
        const last = first[1]!;
        const second = s.listReports({ reason: 'hate', limit: 2, before: last.createdAt, beforeId: last.id });
        expect(second).toHaveLength(1);
        s.closeReport(first[0]!.id, 'dismissed', false, 'mod', NOW, 'ok');
        expect(ids(s.listReports({ reason: 'hate', status: 'open', limit: 10 }))).toEqual([first[1]!.id, second[0]!.id]);
        expect(ids(s.listReports({ reason: 'hate', status: 'dismissed', limit: 10 }))).toEqual([first[0]!.id]);
      });
    });

    describe('listOpenReports reason filter (take next)', () => {
      const seed = (s: Store) => {
        for (const reason of ['hate', 'spam', 'hate', null, 'other', null] as const) s.insertReport(filed({ reportedReason: reason }));
      };
      it('keeps only open reports with that reason, oldest first', () => {
        const s = make();
        seed(s);
        const hate = s.listOpenReports({ reason: 'hate', limit: 10 });
        expect(hate.map((r) => r.reportedReason)).toEqual(['hate', 'hate']);
        expect(hate[0]!.createdAt <= hate[1]!.createdAt).toBe(true);
        expect(s.listOpenReports({ reason: 'spam', limit: 10 })).toHaveLength(1);
      });
      it('null keeps only reports with none; undefined keeps all', () => {
        const s = make();
        seed(s);
        expect(s.listOpenReports({ reason: null, limit: 10 })).toHaveLength(2);
        expect(s.listOpenReports({ limit: 10 })).toHaveLength(6);
      });
      it('is exact (no prefix, no case folding) and an unused id is empty', () => {
        const s = make();
        seed(s);
        for (const r of ['gone', 'hat', 'HATE', '']) expect(s.listOpenReports({ reason: r, limit: 10 }), r).toEqual([]);
      });
      it('combines with the category and with the keyset cursor, and a closed report is never listed', () => {
        const s = make();
        for (const [reason, category] of [['hate', 'hate'], ['hate', 'harassment'], ['hate', 'hate']] as const) s.insertReport(filed({ reportedReason: reason, category }));
        expect(s.listOpenReports({ reason: 'hate', category: 'hate', limit: 10 })).toHaveLength(2);
        const first = s.listOpenReports({ reason: 'hate', limit: 2 });
        const rest = s.listOpenReports({ reason: 'hate', limit: 2, after: first[1]!.createdAt, afterId: first[1]!.id });
        expect(rest).toHaveLength(1);
        s.closeReport(first[0]!.id, 'dismissed', false, 'mod', NOW, 'ok');
        expect(ids(s.listOpenReports({ reason: 'hate', limit: 10 }))).toEqual([first[1]!.id, rest[0]!.id]);
      });
    });

    describe('addReportDetail', () => {
      it('sets the reason, the category, the note and detailAt, and answers true', () => {
        const s = make();
        s.insertReport(report({ reportedReason: null, category: 'other', note: null }));
        expect(reasons(s).addReportDetail('r1', { reportedReason: 'cheating', category: 'cheating', note: 'aimbot', at: NOW + 5 })).toBe(true);
        expect(s.loadReport('r1')).toMatchObject({ reportedReason: 'cheating', category: 'cheating', note: 'aimbot', detailAt: NOW + 5 });
      });
      it('can set the reason back to null and the note to null (the caller sends the final values)', () => {
        const s = make();
        s.insertReport(report());
        expect(reasons(s).addReportDetail('r1', { reportedReason: null, category: 'other', note: null, at: NOW + 1 })).toBe(true);
        expect(s.loadReport('r1')).toMatchObject({ reportedReason: null, category: 'other', note: null, detailAt: NOW + 1 });
      });
      it('works once: the second call is false and changes nothing', () => {
        const s = make();
        s.insertReport(report());
        expect(reasons(s).addReportDetail('r1', { reportedReason: 'hate', category: 'hate', note: 'one', at: NOW + 1 })).toBe(true);
        expect(reasons(s).addReportDetail('r1', { reportedReason: 'spam', category: 'spam', note: 'two', at: NOW + 2 })).toBe(false);
        expect(s.loadReport('r1')).toMatchObject({ reportedReason: 'hate', note: 'one', detailAt: NOW + 1 });
      });
      it('is false for an unknown report and for one that is no longer open', () => {
        const s = make();
        expect(reasons(s).addReportDetail('nope', { reportedReason: 'hate', category: 'hate', note: null, at: NOW })).toBe(false);
        s.insertReport(report());
        s.closeReport('r1', 'actioned', false, 'mod', NOW + 1, 'done');
        expect(reasons(s).addReportDetail('r1', { reportedReason: 'hate', category: 'hate', note: 'late', at: NOW + 2 })).toBe(false);
        expect(s.loadReport('r1')).toMatchObject({ reportedReason: 'harassment', note: 'rude', detailAt: null });
      });
      it('never touches the target, the excerpt, the line, the people, the room, the time or the decision columns', () => {
        const s = make();
        const r = report();
        s.insertReport(r);
        const before = s.loadReport('r1');
        reasons(s).addReportDetail('r1', { reportedReason: 'hate', category: 'hate', note: 'n', at: NOW + 1 });
        const after = s.loadReport('r1');
        const { reportedReason: _a, category: _b, note: _c, detailAt: _d, ...restBefore } = before!;
        const { reportedReason: _e, category: _f, note: _g, detailAt: _h, ...restAfter } = after!;
        void [_a, _b, _c, _d, _e, _f, _g, _h];
        expect(restAfter).toEqual(restBefore);
      });
      it('is undone with a rolled-back transaction', () => {
        const s = make();
        s.insertReport(report());
        expect(() =>
          s.transaction(() => {
            reasons(s).addReportDetail('r1', { reportedReason: 'hate', category: 'hate', note: 'x', at: NOW + 1 });
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadReport('r1')).toMatchObject({ reportedReason: 'harassment', note: 'rude', detailAt: null });
        expect(reasons(s).addReportDetail('r1', { reportedReason: 'hate', category: 'hate', note: 'x', at: NOW + 2 })).toBe(true);
      });
      it('the filter sees the new reason at once', () => {
        const s = make();
        s.insertReport(report({ reportedReason: null }));
        reasons(s).addReportDetail('r1', { reportedReason: 'threat', category: 'harassment', note: null, at: NOW + 1 });
        expect(ids(s.listReports({ reason: 'threat', limit: 5 }))).toEqual(['r1']);
        expect(s.listReports({ reason: null, limit: 5 })).toEqual([]);
      });
    });

    describe('loadReporterDecisions', () => {
      /** File, close and (when `rules` is given) record a decision whose groups hold one sanction group per rule. */
      const decide = (
        s: Store,
        over: Partial<StoredReport>,
        status: 'actioned' | 'dismissed',
        groups: Array<{ id: string; value?: string; rule: string | null; ip?: boolean }>,
      ): StoredReport => {
        const r = filed(over);
        s.insertReport(r);
        s.closeReport(r.id, status, false, 'mod', NOW + 100, 'done');
        if (groups.length > 0) {
          for (const g of groups) {
            const rows = [sanction({ groupId: g.id, refCode: `M-${g.id.padEnd(5, 'X').slice(0, 5)}`, value: g.value ?? 's_tgt', rule: g.rule })];
            if (g.ip === true) rows.push(sanction({ groupId: g.id, refCode: `M-${g.id.padEnd(5, 'X').slice(0, 5)}`, targetType: 'ip', value: 'iphash', rule: g.rule }));
            s.insertSanctionGroup(rows);
          }
          s.insertDecision(`key-${r.id}`, r.id, NOW + 100, JSON.stringify({ groups: groups.map((g) => ({ groupId: g.id })) }));
        }
        return r;
      };

      it('an actioned report with a decision lists the rule cited against the person, once per group', () => {
        const s = make();
        const r = decide(s, { reportedReason: 'hate', targetSubject: 's_t1' }, 'actioned', [{ id: 'ga', value: 's_t1', rule: '1', ip: true }]);
        expect(reasons(s).loadReporterDecisions(['s_rep'])).toEqual([
          { reportId: r.id, status: 'actioned', reason: 'hate', target: 's_t1', actions: [{ subject: 's_t1', rule: 1 }] },
        ]);
      });
      it('several groups and several rules; uncovered and a missing rule read as uncovered', () => {
        const s = make();
        const r = decide(s, { reportedReason: 'spam' }, 'actioned', [
          { id: 'gb1', rule: '4' },
          { id: 'gb2', value: 's_other', rule: '12' },
          { id: 'gb3', rule: 'uncovered' },
          { id: 'gb4', rule: null },
        ]);
        const got = reasons(s).loadReporterDecisions(['s_rep']);
        expect(got).toHaveLength(1);
        expect(got[0]!.reportId).toBe(r.id);
        expect([...got[0]!.actions].sort((a, b) => a.subject.localeCompare(b.subject) || String(a.rule).localeCompare(String(b.rule)))).toEqual([
          { subject: 's_other', rule: 12 },
          { subject: 's_tgt', rule: 4 },
          { subject: 's_tgt', rule: 'uncovered' },
          { subject: 's_tgt', rule: 'uncovered' },
        ]);
      });
      it('a dismissal with no sanctions lists with no actions', () => {
        const s = make();
        const r = decide(s, { reportedReason: 'afk' }, 'dismissed', []);
        expect(reasons(s).loadReporterDecisions(['s_rep'])).toEqual([{ reportId: r.id, status: 'dismissed', reason: 'afk', target: 's_tgt', actions: [] }]);
      });
      it('leaves out open reports and reports with no reason', () => {
        const s = make();
        s.insertReport(filed({ reportedReason: 'hate' }));
        decide(s, { reportedReason: null }, 'actioned', [{ id: 'gc', rule: '1' }]);
        expect(reasons(s).loadReporterDecisions(['s_rep'])).toEqual([]);
      });
      it('is for the given reporters only, and an empty list matches nothing', () => {
        const s = make();
        decide(s, { reportedReason: 'hate', reporterSubject: 's_one' }, 'dismissed', []);
        decide(s, { reportedReason: 'hate', reporterSubject: 's_two' }, 'dismissed', []);
        expect(reasons(s).loadReporterDecisions(['s_one']).map((d) => d.reportId)).toHaveLength(1);
        expect(reasons(s).loadReporterDecisions(['s_one', 's_two'])).toHaveLength(2);
        expect(reasons(s).loadReporterDecisions(['s_three'])).toEqual([]);
        expect(reasons(s).loadReporterDecisions([])).toEqual([]);
      });
      it('a decision of another report does not leak into this one', () => {
        const s = make();
        decide(s, { reportedReason: 'hate' }, 'actioned', [{ id: 'gd1', rule: '1' }]);
        const second = decide(s, { reportedReason: 'spam' }, 'actioned', [{ id: 'gd2', rule: '4' }]);
        const got = reasons(s).loadReporterDecisions(['s_rep']);
        expect(got.find((d) => d.reportId === second.id)?.actions).toEqual([{ subject: 's_tgt', rule: 4 }]);
      });
      it('a decision row that cannot be read never fails the call: that report lists with no actions, the others are whole', () => {
        const s = make();
        const bad = filed({ reportedReason: 'hate' });
        s.insertReport(bad);
        s.closeReport(bad.id, 'actioned', false, 'mod', NOW + 100, 'done');
        s.insertDecision('key-bad', bad.id, NOW + 100, '{not json');
        const good = decide(s, { reportedReason: 'spam' }, 'actioned', [{ id: 'ge1', rule: '4' }]);
        const odd = filed({ reportedReason: 'afk' });
        s.insertReport(odd);
        s.closeReport(odd.id, 'actioned', false, 'mod', NOW + 100, 'done');
        s.insertDecision('key-odd', odd.id, NOW + 100, JSON.stringify({ groups: 'nope' }));
        const got = reasons(s).loadReporterDecisions(['s_rep']);
        expect(got).toHaveLength(3);
        expect(got.find((d) => d.reportId === bad.id)?.actions).toEqual([]);
        expect(got.find((d) => d.reportId === odd.id)?.actions).toEqual([]);
        expect(got.find((d) => d.reportId === good.id)?.actions).toEqual([{ subject: 's_tgt', rule: 4 }]);
      });

      it('returns the newest 200 decided reports, newest first', () => {
        const s = make();
        for (let i = 0; i < 205; i++) {
          const r = filed({ reportedReason: 'hate', createdAt: NOW + 1000 + i });
          s.insertReport(r);
          s.closeReport(r.id, 'dismissed', false, 'mod', NOW + 5000, 'done');
        }
        const got = reasons(s).loadReporterDecisions(['s_rep']);
        expect(got).toHaveLength(200);
        const created = got.map((d) => Number(d.reportId.slice(1)));
        expect([...created].sort((a, b) => b - a)).toEqual(created);
        // The five oldest are the ones left out.
        expect(Math.min(...created)).toBe(Math.max(...created) - 199);
      });

      it('handles many reporters at once (more than any SQL variable limit would allow in one list)', () => {
        const s = make();
        decide(s, { reportedReason: 'hate', reporterSubject: 's_find' }, 'dismissed', []);
        const many = Array.from({ length: 2000 }, (_, i) => `s_x${i}`);
        expect(reasons(s).loadReporterDecisions([...many, 's_find'])).toHaveLength(1);
      });
    });
  });
}

void H;
