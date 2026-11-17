import { describe, expect, it } from 'vitest';
import type { FilterHitRow, Store, StoredReport } from '@chatwarden/core';

// The contract of the chat-filter methods of the Store: the daily hit counters (`addFilterHits`, `listFilterHits`, `purgeFilterHits`) and the
// reports a filter files on its own (`countOriginReports`, and `insertReport` refusing a second OPEN filter report for one person and room).
// One suite, run against every Store. SqliteStore is the reference.

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const TODAY = Math.floor(NOW / DAY_MS);

const row = (over: Partial<FilterHitRow> = {}): FilterHitRow => ({ day: TODAY, key: 'link.unlisted', action: 'count', hits: 1, ...over });

const report = (id: string, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: NOW,
  roomId: 'ROOM1',
  tags: {},
  reporterSubject: `filter:${id}`,
  reporterSeat: '',
  reporterHandle: '',
  targetSubject: 's_tgt',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'spam',
  reportedReason: 'spam',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
  origin: 'filter',
  originKey: 'link.unlisted',
  ...over,
});

const ordinary = (id: string, over: Partial<StoredReport> = {}): StoredReport => ({
  ...report(id),
  reporterSubject: `s_rep_${id}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  origin: null,
  originKey: null,
  ...over,
});

export function filtersContract(name: string, make: () => Store): void {
  describe(`filters contract: ${name}`, () => {
    describe('the hit counters', () => {
      it('addFilterHits adds to an existing (day, key, action) and keeps other rows apart', () => {
        const s = make();
        s.addFilterHits([row({ hits: 2 }), row({ action: 'refuse', hits: 1 }), row({ key: 'phrase.ads', hits: 5 })]);
        s.addFilterHits([row({ hits: 3 }), row({ day: TODAY - 1, hits: 7 })]);
        expect(s.listFilterHits(TODAY - 1, TODAY)).toEqual([
          row({ day: TODAY - 1, hits: 7 }),
          row({ hits: 5 }),
          row({ action: 'refuse', hits: 1 }),
          row({ key: 'phrase.ads', hits: 5 }),
        ]);
      });

      it('one call may hold the same row twice: they add', () => {
        const s = make();
        s.addFilterHits([row({ hits: 2 }), row({ hits: 3 })]);
        expect(s.listFilterHits(TODAY, TODAY)).toEqual([row({ hits: 5 })]);
      });

      it('an empty list writes nothing', () => {
        const s = make();
        s.addFilterHits([]);
        expect(s.listFilterHits(0, TODAY + 10)).toEqual([]);
      });

      it('every action word is kept, flag_capped included', () => {
        const s = make();
        const actions = ['count', 'flag', 'mask', 'refuse', 'flag_capped'] as const;
        s.addFilterHits(actions.map((action, i) => row({ action, hits: i + 1 })));
        expect(s.listFilterHits(TODAY, TODAY).map((r) => [r.action, r.hits])).toEqual([
          ['count', 1],
          ['flag', 2],
          ['flag_capped', 5],
          ['mask', 3],
          ['refuse', 4],
        ]);
      });

      it('listFilterHits takes the day range inclusive on both ends, ordered by day, key, action; an empty range is empty', () => {
        const s = make();
        s.addFilterHits([row({ day: 10, key: 'b' }), row({ day: 11, key: 'a' }), row({ day: 12, key: 'a' }), row({ day: 12, key: 'a', action: 'flag' }), row({ day: 13 })]);
        expect(s.listFilterHits(11, 12).map((r) => [r.day, r.key, r.action])).toEqual([
          [11, 'a', 'count'],
          [12, 'a', 'count'],
          [12, 'a', 'flag'],
        ]);
        expect(s.listFilterHits(10, 10).map((r) => r.key)).toEqual(['b']);
        expect(s.listFilterHits(14, 20)).toEqual([]);
        expect(s.listFilterHits(12, 11)).toEqual([]);
      });

      it('listFilterHits returns copies', () => {
        const s = make();
        s.addFilterHits([row()]);
        s.listFilterHits(TODAY, TODAY)[0]!.hits = 99;
        expect(s.listFilterHits(TODAY, TODAY)[0]!.hits).toBe(1);
      });

      it('purgeFilterHits deletes day rows strictly older and says how many; the edge day stays', () => {
        const s = make();
        s.addFilterHits([row({ day: 9 }), row({ day: 10 }), row({ day: 10, key: 'x' }), row({ day: 11 })]);
        expect(s.purgeFilterHits(10)).toBe(1);
        expect(s.listFilterHits(0, 99).map((r) => r.day)).toEqual([10, 10, 11]);
        expect(s.purgeFilterHits(10)).toBe(0);
        expect(s.purgeFilterHits(12)).toBe(3);
        expect(s.listFilterHits(0, 99)).toEqual([]);
      });

      it('a rolled back transaction leaves no counts', () => {
        const s = make();
        expect(() =>
          s.transaction(() => {
            s.addFilterHits([row()]);
            throw new Error('undo');
          }),
        ).toThrow('undo');
        expect(s.listFilterHits(0, TODAY + 1)).toEqual([]);
      });
    });

    describe('origin reports', () => {
      it('a report with no origin reads back origin null and originKey null; one with an origin reads it back', () => {
        const s = make();
        const legacy: Partial<StoredReport> = ordinary('o1');
        delete legacy.origin;
        delete legacy.originKey;
        expect(s.insertReport(legacy as StoredReport)).toBe(true);
        expect(s.loadReport('o1')).toMatchObject({ origin: null, originKey: null });
        expect(s.insertReport(report('f1'))).toBe(true);
        expect(s.loadReport('f1')).toMatchObject({ origin: 'filter', originKey: 'link.unlisted', reporterSubject: 'filter:f1', reporterSeat: '', reporterHandle: '' });
      });

      it('countOriginReports counts by origin since a time (inclusive), whatever their status', () => {
        const s = make();
        s.insertReport(report('f1', { createdAt: NOW - 10, targetSubject: 's_a' }));
        s.insertReport(report('f2', { createdAt: NOW, targetSubject: 's_b' }));
        s.insertReport(report('f3', { createdAt: NOW + 5, targetSubject: 's_c' }));
        s.insertReport(ordinary('o1', { createdAt: NOW }));
        s.closeReport('f2', 'dismissed', false, 'mod', NOW + 6, 'n');
        expect(s.countOriginReports('filter', NOW)).toBe(2);
        expect(s.countOriginReports('filter', NOW - 10)).toBe(3);
        expect(s.countOriginReports('filter', NOW + 6)).toBe(0);
        expect(s.countOriginReports('watch', 0)).toBe(0);
      });

      it('insertReport refuses a second open filter report for one (target, room) and accepts it once the first is closed; an ordinary report is unaffected', () => {
        const s = make();
        expect(s.insertReport(report('f1'))).toBe(true);
        expect(s.insertReport(report('f2'))).toBe(false);
        expect(s.loadReport('f2')).toBeNull();
        // another room, another person
        expect(s.insertReport(report('f3', { roomId: 'ROOM2' }))).toBe(true);
        expect(s.insertReport(report('f4', { targetSubject: 's_other' }))).toBe(true);
        // an ordinary report for the same pair is not refused, and neither does it block a filter one
        expect(s.insertReport(ordinary('o1'))).toBe(true);
        expect(s.insertReport(ordinary('o2', { reporterSubject: 's_rep_2' }))).toBe(true);
        // once the first is decided, a new one files
        expect(s.closeReport('f1', 'dismissed', false, 'mod', NOW + 1, 'n')).toBe(true);
        expect(s.insertReport(report('f5'))).toBe(true);
        expect(s.insertReport(report('f6'))).toBe(false);
      });

      it('a refused insert writes nothing and does not move the change token', () => {
        const s = make();
        s.insertReport(report('f1'));
        const token = s.changeToken();
        expect(s.insertReport(report('f2'))).toBe(false);
        expect(s.changeToken()).toBe(token);
      });

      it('a clashing id still throws, as for any report', () => {
        const s = make();
        s.insertReport(report('f1'));
        expect(() => s.insertReport(report('f1', { roomId: 'ROOM9' }))).toThrow();
      });

      it('the reporter readers leave an origin report out, even when asked for its reporter value', () => {
        const s = make();
        s.insertReport(report('f1'));
        expect(s.reporterTally(['filter:f1'])).toEqual({ open: 0, actioned: 0, dismissed: 0, badFaith: 0 });
        expect(s.listOpenReportsByReporter?.(['filter:f1'], 10) ?? []).toEqual([]);
        expect(s.reporterOutcomes?.(['filter:f1'], 0) ?? []).toEqual([]);
        s.closeReport('f1', 'dismissed', false, 'mod', NOW + 1, 'n');
        expect(s.reporterTally(['filter:f1'])).toEqual({ open: 0, actioned: 0, dismissed: 0, badFaith: 0 });
        expect(s.reporterOutcomes?.(['filter:f1'], 0) ?? []).toEqual([]);
        expect(s.loadReporterDecisions?.(['filter:f1']) ?? []).toEqual([]);
      });

      it('the same holds for any origin, by the reporter value `<origin>:<id>` (a watch report)', () => {
        const s = make();
        s.insertReport(report('w1', { origin: 'watch', originKey: 'ai.watch', reporterSubject: 'watch:w1' }));
        expect(s.reporterTally(['watch:w1'])).toEqual({ open: 0, actioned: 0, dismissed: 0, badFaith: 0 });
        expect(s.listOpenReportsByReporter?.(['watch:w1'], 10) ?? []).toEqual([]);
        s.closeReport('w1', 'dismissed', false, 'mod', NOW + 1, 'n');
        expect(s.reporterTally(['watch:w1'])).toEqual({ open: 0, actioned: 0, dismissed: 0, badFaith: 0 });
        expect(s.reporterOutcomes?.(['watch:w1'], 0) ?? []).toEqual([]);
        expect(s.loadReporterDecisions?.(['watch:w1']) ?? []).toEqual([]);
      });

      it('loadReportActivity (the reports a person filed or was reported in) leaves every origin report out, in every store', () => {
        const s = make();
        s.insertReport(ordinary('o1', { createdAt: NOW }));
        s.insertReport(report('f1', { createdAt: NOW + 1 }));
        s.insertReport(report('w1', { createdAt: NOW + 2, origin: 'watch', originKey: 'ai.watch', reporterSubject: 'watch:w1' }));
        s.insertReport(ordinary('o2', { createdAt: NOW + 3 }));
        expect(s.loadReportActivity(0).map((a) => [a.reporter, a.createdAt])).toEqual([
          ['s_rep_o1', NOW],
          ['s_rep_o2', NOW + 3],
        ]);
      });
    });
  });
}
