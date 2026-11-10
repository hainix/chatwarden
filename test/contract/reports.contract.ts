import { describe, expect, it } from 'vitest';
import type { Store, StoredReport } from '@chatwarden/core';

// The contract of the report, decision and report-query methods of the Store. One suite, run against every Store.

const H = 3_600_000;
const DAY = 24 * H;
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
  note: 'rude',
  lineId: '3',
  excerpt: [
    { lineId: '3', ts: NOW - 5, seatId: 'p2', handle: 'Tgt', raw: 'zorbak "you"', delivered: null, blocked: true, audience: ['p1'], p: 0 },
    { lineId: '4', ts: NOW - 4, seatId: 'bot', handle: 'Bot', raw: 'beep', delivered: 'beep', blocked: false, audience: null, p: null },
  ],
  people: ['s_tgt'],
  status: 'open',
  ...over,
});

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

export function reportsContract(name: string, make: () => Store): void {
  describe(`reports contract: ${name}`, () => {
    describe('insertReport / loadReport', () => {
      it('stores every field and reads it back with status open and null decision columns', () => {
        const s = make();
        const r = report();
        expect(s.insertReport(r)).toBe(true);
        expect(s.loadReport('r1')).toEqual({
          ...r,
          status: 'open',
          badFaith: false,
          actionedAt: null,
          actionedBy: null,
          modNote: null,
          badFaithEvidence: null,
        });
      });

      it('a null note, a null line id, an empty excerpt, people and tags round-trip', () => {
        const s = make();
        s.insertReport(report({ note: null, lineId: null, excerpt: [], people: [], tags: {} }));
        expect(s.loadReport('r1')).toMatchObject({ note: null, lineId: null, excerpt: [], people: [], tags: {} });
      });

      it('loadReport is null for an unknown id', () => {
        const s = make();
        s.insertReport(report());
        expect(s.loadReport('nope')).toBeNull();
        expect(s.loadReport('R1')).toBeNull();
      });

      it('returns false and writes nothing for the same reporter, target and room', () => {
        const s = make();
        expect(s.insertReport(report())).toBe(true);
        expect(s.insertReport(report({ id: 'r2', category: 'spam', createdAt: NOW + 1 }))).toBe(false);
        expect(s.loadReport('r2')).toBeNull();
        expect(s.listReports({ limit: 10 })).toHaveLength(1);
      });

      it('controls: another room, target or reporter is a new row', () => {
        const s = make();
        expect(s.insertReport(report())).toBe(true);
        expect(s.insertReport(report({ id: 'r2', roomId: 'ROOM2' }))).toBe(true);
        expect(s.insertReport(report({ id: 'r3', targetSubject: 's_other' }))).toBe(true);
        expect(s.insertReport(report({ id: 'r4', reporterSubject: 's_other' }))).toBe(true);
      });

      it('a duplicate report id throws rather than returning false', () => {
        const s = make();
        s.insertReport(report());
        expect(() => s.insertReport(report({ roomId: 'ROOM9' }))).toThrow();
        expect(s.listReports({ limit: 10 })).toHaveLength(1);
      });

      it('is rolled back with the enclosing transaction', () => {
        const s = make();
        expect(() =>
          s.transaction(() => {
            s.insertReport(report());
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadReportActivity(0)).toEqual([]);
        expect(s.loadReport('r1')).toBeNull();
      });

      it('the stored record is a copy: editing what was inserted or what was read changes nothing', () => {
        const s = make();
        const r = report();
        s.insertReport(r);
        r.excerpt[0]!.raw = 'tampered';
        r.people.push('s_x');
        const read = s.loadReport('r1');
        read!.excerpt[0]!.raw = 'tampered again';
        expect(s.loadReport('r1')?.excerpt[0]?.raw).toBe('zorbak "you"');
        expect(s.loadReport('r1')?.people).toEqual(['s_tgt']);
      });
    });

    describe('closeReport', () => {
      it('closes an open report once: status, bad-faith mark, time, actor and note', () => {
        const s = make();
        s.insertReport(report());
        expect(s.closeReport('r1', 'actioned', false, 'mod', NOW + 50, 'done')).toBe(true);
        expect(s.loadReport('r1')).toMatchObject({
          status: 'actioned',
          badFaith: false,
          actionedAt: NOW + 50,
          actionedBy: 'mod',
          modNote: 'done',
          badFaithEvidence: null,
        });
      });

      it('stores the bad-faith evidence; omitted evidence reads back null', () => {
        const s = make();
        s.insertReport(report());
        s.insertReport(report({ id: 'r2', roomId: 'R2' }));
        s.closeReport('r1', 'dismissed', true, 'mod', NOW + 1, 'n', 'it was a joke');
        s.closeReport('r2', 'dismissed', false, 'mod', NOW + 1, 'n');
        expect(s.loadReport('r1')).toMatchObject({ status: 'dismissed', badFaith: true, badFaithEvidence: 'it was a joke' });
        expect(s.loadReport('r2')?.badFaithEvidence).toBeNull();
      });

      it('a second close changes nothing and returns false (the first closer wins, evidence included)', () => {
        const s = make();
        s.insertReport(report());
        expect(s.closeReport('r1', 'dismissed', true, 'first', NOW + 1, 'one', 'ev1')).toBe(true);
        expect(s.closeReport('r1', 'actioned', false, 'second', NOW + 2, 'two', 'ev2')).toBe(false);
        expect(s.loadReport('r1')).toMatchObject({
          status: 'dismissed',
          badFaith: true,
          actionedBy: 'first',
          actionedAt: NOW + 1,
          modNote: 'one',
          badFaithEvidence: 'ev1',
        });
      });

      it('an unknown id is false', () => {
        expect(make().closeReport('nope', 'actioned', false, 'mod', NOW, 'n')).toBe(false);
      });

      it('rejects an invalid status and writes nothing', () => {
        const s = make();
        s.insertReport(report());
        expect(() => s.closeReport('r1', 'open' as never, false, 'mod', NOW, 'n')).toThrow();
        expect(s.loadReport('r1')?.status).toBe('open');
      });

      it('rolls back with the surrounding transaction', () => {
        const s = make();
        s.insertReport(report());
        expect(() =>
          s.transaction(() => {
            s.closeReport('r1', 'dismissed', true, 'mod', NOW + 5, 'n', 'ev');
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadReport('r1')).toMatchObject({
          status: 'open',
          badFaith: false,
          actionedAt: null,
          actionedBy: null,
          modNote: null,
          badFaithEvidence: null,
        });
      });
    });

    describe('insertDecision / findDecision', () => {
      it('stores and finds a decision; an unknown key is null', () => {
        const s = make();
        s.insertDecision('k1', 'r1', NOW, '{"ok":true}');
        expect(s.findDecision('k1')).toEqual({ key: 'k1', reportId: 'r1', at: NOW, resultJson: '{"ok":true}' });
        expect(s.findDecision('k2')).toBeNull();
        expect(s.findDecision('K1')).toBeNull();
      });

      it('a duplicate key throws and leaves the first row alone', () => {
        const s = make();
        s.insertDecision('k1', 'r1', NOW, '{"first":true}');
        expect(() => s.insertDecision('k1', 'r2', NOW + 1, '{"second":true}')).toThrow();
        expect(s.findDecision('k1')).toEqual({ key: 'k1', reportId: 'r1', at: NOW, resultJson: '{"first":true}' });
      });

      it('rolls back with the surrounding transaction', () => {
        const s = make();
        expect(() =>
          s.transaction(() => {
            s.insertDecision('k1', 'r1', NOW, '{}');
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.findDecision('k1')).toBeNull();
      });

      it('the returned decision is a copy', () => {
        const s = make();
        s.insertDecision('k1', 'r1', NOW, '{}');
        const d = s.findDecision('k1');
        d!.resultJson = 'tampered';
        expect(s.findDecision('k1')?.resultJson).toBe('{}');
      });
    });

    describe('loadReportActivity / loadRoomReportPairs', () => {
      it('returns light rows at or after since, oldest first', () => {
        const s = make();
        s.insertReport(report({ id: 'c', roomId: 'C', createdAt: NOW + 20 }));
        s.insertReport(report({ id: 'a', roomId: 'A', createdAt: NOW }));
        s.insertReport(report({ id: 'b', roomId: 'B', createdAt: NOW + 10 }));
        expect(s.loadReportActivity(NOW + 10)).toEqual([
          { reporter: 's_rep', target: 's_tgt', roomId: 'B', createdAt: NOW + 10 },
          { reporter: 's_rep', target: 's_tgt', roomId: 'C', createdAt: NOW + 20 },
        ]);
        expect(s.loadReportActivity(0).map((r) => r.roomId)).toEqual(['A', 'B', 'C']);
        expect(s.loadReportActivity(NOW + 21)).toEqual([]);
      });

      it('lists the pairs of one room only', () => {
        const s = make();
        s.insertReport(report({ id: 'a', roomId: 'A' }));
        s.insertReport(report({ id: 'b', roomId: 'B', reporterSubject: 's_x' }));
        expect(s.loadRoomReportPairs('A')).toEqual([{ reporter: 's_rep', target: 's_tgt' }]);
        expect(s.loadRoomReportPairs('B')).toEqual([{ reporter: 's_x', target: 's_tgt' }]);
        expect(s.loadRoomReportPairs('none')).toEqual([]);
      });
    });

    describe('loadBadFaithMarks', () => {
      it('returns bad-faith dismissals actioned at or after since, and nothing else', () => {
        const s = make();
        const mark = (id: string, room: string, badFaith: boolean, at: number | null) => {
          s.insertReport(report({ id, roomId: room }));
          if (at !== null) s.closeReport(id, 'dismissed', badFaith, 'mod', at, 'n');
        };
        mark('a', 'A', true, NOW - DAY);
        mark('b', 'B', true, NOW - 30 * DAY); // exactly since
        mark('c', 'C', true, NOW - 30 * DAY - 1); // too old
        mark('d', 'D', false, NOW - DAY); // not bad faith
        mark('e', 'E', true, null); // never closed
        // Most recently actioned first.
        expect(s.loadBadFaithMarks(NOW - 30 * DAY)).toEqual([
          { reporter: 's_rep', actionedAt: NOW - DAY },
          { reporter: 's_rep', actionedAt: NOW - 30 * DAY },
        ]);
      });

      it('orders by actionedAt descending, ties in write order', () => {
        const s = make();
        for (const [id, at] of [['a', NOW + 1], ['b', NOW + 3], ['c', NOW + 3], ['d', NOW + 2]] as const) {
          s.insertReport(report({ id, roomId: id, reporterSubject: `s_${id}` }));
          s.closeReport(id, 'dismissed', true, 'mod', at, 'n');
        }
        expect(s.loadBadFaithMarks(0).map((m) => m.reporter)).toEqual(['s_b', 's_c', 's_d', 's_a']);
      });
    });

    describe('listReports', () => {
      const seeded = (s: Store) => {
        // r1..r6 with three at the same instant, so the id tie-break shows.
        const times = [NOW, NOW + 10, NOW + 10, NOW + 10, NOW + 20, NOW + 30];
        times.forEach((createdAt, i) => {
          s.insertReport(report({ id: `r${i + 1}`, createdAt, reporterSubject: `s_rep${i}` }));
        });
        s.closeReport('r2', 'actioned', false, 'mod', NOW + 100, 'n');
        s.closeReport('r3', 'dismissed', true, 'mod', NOW + 100, 'n', 'ev');
        s.closeReport('r5', 'actioned', false, 'mod', NOW + 100, 'n');
      };

      it('newest first, ties on createdAt broken by id descending', () => {
        const s = make();
        seeded(s);
        expect(ids(s.listReports({ limit: 10 }))).toEqual(['r6', 'r5', 'r4', 'r3', 'r2', 'r1']);
      });

      it('returns whole records with the decision columns', () => {
        const s = make();
        seeded(s);
        const [row] = s.listReports({ status: 'dismissed', limit: 5 });
        expect(row).toEqual(s.loadReport('r3'));
        expect(row).toMatchObject({ status: 'dismissed', badFaith: true, actionedBy: 'mod', badFaithEvidence: 'ev' });
        expect(row?.excerpt).toEqual(report().excerpt);
      });

      it('filters by status', () => {
        const s = make();
        seeded(s);
        expect(ids(s.listReports({ status: 'open', limit: 10 }))).toEqual(['r6', 'r4', 'r1']);
        expect(ids(s.listReports({ status: 'actioned', limit: 10 }))).toEqual(['r5', 'r2']);
        expect(ids(s.listReports({ status: 'dismissed', limit: 10 }))).toEqual(['r3']);
      });

      it('walking the list two at a time by the cursor shows every row once, when several tie on createdAt', () => {
        const s = make();
        for (let i = 1; i <= 9; i++) s.insertReport(report({ id: `t${i}`, createdAt: NOW + (i <= 5 ? 5 : 6), reporterSubject: `s_t${i}` }));
        const all: string[] = [];
        let cursor: { before: number; beforeId: string } | undefined;
        for (;;) {
          const page = s.listReports({ limit: 2, ...(cursor ?? {}) });
          if (page.length === 0) break;
          all.push(...ids(page));
          const last = page[page.length - 1];
          if (last === undefined) break;
          cursor = { before: last.createdAt, beforeId: last.id };
        }
        expect(all).toEqual(['t9', 't8', 't7', 't6', 't5', 't4', 't3', 't2', 't1']);
      });

      it('before (exclusive) pages by time; with beforeId it splits an exact tie', () => {
        const s = make();
        seeded(s);
        expect(ids(s.listReports({ before: NOW + 10, limit: 10 }))).toEqual(['r1']);
        expect(ids(s.listReports({ before: NOW + 10, beforeId: 'r3', limit: 10 }))).toEqual(['r2', 'r1']);
        expect(ids(s.listReports({ before: NOW + 10, beforeId: 'r4', limit: 2 }))).toEqual(['r3', 'r2']);
        expect(ids(s.listReports({ before: NOW + 10, beforeId: 'r1', limit: 10 }))).toEqual(['r1']);
        expect(ids(s.listReports({ before: NOW, limit: 10 }))).toEqual([]);
        expect(ids(s.listReports({ status: 'open', before: NOW + 10, beforeId: 'r4', limit: 10 }))).toEqual(['r1']);
        expect(ids(s.listReports({ beforeId: 'r3', limit: 10 }))).toHaveLength(6);
      });

      it('limit is clamped to 1..200 and a fraction is floored', () => {
        const s = make();
        for (let i = 0; i < 210; i++) s.insertReport(report({ id: `q${i}`, createdAt: NOW + i, reporterSubject: `s${i}` }));
        expect(s.listReports({ limit: 500 })).toHaveLength(200);
        expect(s.listReports({ limit: 200 })).toHaveLength(200);
        expect(s.listReports({ limit: 0 })).toHaveLength(1);
        expect(s.listReports({ limit: -4 })).toHaveLength(1);
        expect(s.listReports({ limit: 3.8 })).toHaveLength(3);
        expect(s.listReports({ limit: 5 })).toHaveLength(5);
      });

      it('an empty store lists nothing', () => {
        expect(make().listReports({ limit: 10 })).toEqual([]);
      });
    });

    describe('listReportsByPerson', () => {
      const seeded = (s: Store) => {
        // Reports against s_a (two aliases: s_a and s_a2), s_b, and one filed BY s_a against s_b.
        const rows: Array<[string, number, string, string]> = [
          ['p1', NOW, 's_a', 's_x1'],
          ['p2', NOW + 10, 's_a2', 's_x2'],
          ['p3', NOW + 10, 's_a', 's_x3'],
          ['p4', NOW + 20, 's_b', 's_x4'],
          ['p5', NOW + 30, 's_b', 's_a'],
          ['p6', NOW + 40, 's_a', 's_x5'],
        ];
        for (const [id, createdAt, targetSubject, reporterSubject] of rows) {
          s.insertReport(report({ id, createdAt, targetSubject, reporterSubject, people: [targetSubject] }));
        }
        s.closeReport('p3', 'actioned', false, 'mod', NOW + 100, 'n');
      };

      it('lists reports AGAINST the person only, newest first, ties by id descending', () => {
        const s = make();
        seeded(s);
        expect(ids(s.listReportsByPerson(['s_a'], 10))).toEqual(['p6', 'p3', 'p1']);
        expect(ids(s.listReportsByPerson(['s_b'], 10))).toEqual(['p5', 'p4']);
      });

      it('reads every alias given, and returns whole records with the decision columns', () => {
        const s = make();
        seeded(s);
        const rows = s.listReportsByPerson(['s_a', 's_a2'], 10);
        expect(ids(rows)).toEqual(['p6', 'p3', 'p2', 'p1']);
        expect(rows.find((r) => r.id === 'p3')).toMatchObject({ status: 'actioned', actionedBy: 'mod', modNote: 'n' });
        expect(rows[0]?.excerpt.length).toBeGreaterThan(0);
      });

      it('limit is clamped to 1..200 and a fraction is floored', () => {
        const s = make();
        seeded(s);
        expect(ids(s.listReportsByPerson(['s_a'], 2))).toEqual(['p6', 'p3']);
        expect(s.listReportsByPerson(['s_a'], 0)).toHaveLength(1);
        expect(s.listReportsByPerson(['s_a'], -4)).toHaveLength(1);
        expect(s.listReportsByPerson(['s_a'], 2.9)).toHaveLength(2);
        expect(s.listReportsByPerson(['s_a'], 9999)).toHaveLength(3);
      });

      it('controls: an unknown person, an empty list, or a similar id matches nothing', () => {
        const s = make();
        seeded(s);
        expect(s.listReportsByPerson(['s_zzz'], 10)).toEqual([]);
        expect(s.listReportsByPerson([], 10)).toEqual([]);
        expect(s.listReportsByPerson(['s_'], 10)).toEqual([]);
        expect(s.listReportsByPerson(["s_a' OR 1=1 --"], 10)).toEqual([]);
      });
    });
  });
}
