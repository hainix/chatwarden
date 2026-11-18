import { describe, expect, it } from 'vitest';
import type { CommentRow, Store, StoredReport } from '@chatwarden/core';

// The contract of the urgent lane, the staff workflow and Insights on the Store (0.2.0): the report columns `urgent`, `evidenceRef`, hand-off and escalation, the
// urgent queries, the comment thread, the daily line counts, the welfare purge, and the Insights read. One suite, run against every Store. SqliteStore is the reference.

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const report = (id: string, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: NOW,
  roomId: `ROOM-${id}`,
  tags: {},
  reporterSubject: `s_rep_${id}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: `s_tgt_${id}`,
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  reportedReason: 'harassment',
  note: 'a note about zorbak',
  lineId: '1',
  excerpt: [{ lineId: '1', ts: NOW, seatId: 'p2', handle: 'Tgt', raw: 'vlemmo line', delivered: 'x', blocked: false, audience: null, p: 0 }],
  people: [`s_tgt_${id}`],
  status: 'open',
  ...over,
});

const comment = (id: string, reportId: string, over: Partial<CommentRow> = {}): CommentRow => ({
  id,
  reportId,
  at: NOW,
  actor: 'mod_ann',
  role: 'moderator',
  kind: 'comment',
  text: 'seen it, waiting for the owner',
  ...over,
});

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

/** The optional methods this suite needs; a store without them is not a store of this release. */
function desk(s: Store) {
  const need = <K extends keyof Store>(k: K): NonNullable<Store[K]> => {
    const m = s[k];
    if (typeof m !== 'function') throw new Error(`the store has no ${String(k)}`);
    return (m as (...a: never[]) => unknown).bind(s) as NonNullable<Store[K]>;
  };
  return {
    setReportUrgent: need('setReportUrgent'),
    setHandoff: need('setHandoff'),
    setEscalation: need('setEscalation'),
    countOpenUrgent: need('countOpenUrgent'),
    countOpenEscalated: need('countOpenEscalated'),
    insertComment: need('insertComment'),
    listComments: need('listComments'),
    deleteComment: need('deleteComment'),
    countComments: need('countComments'),
    purgeReportsByReason: need('purgeReportsByReason'),
    addChatCounts: need('addChatCounts'),
    chatCounts: need('chatCounts'),
    purgeChatCounts: need('purgeChatCounts'),
    insightRows: need('insightRows'),
  };
}

export function deskContract(name: string, make: () => Store): void {
  describe(`desk contract: ${name}`, () => {
    describe('the report columns', () => {
      it('insertReport round-trips urgent and evidenceRef; a report with neither reads urgent false and evidenceRef null', () => {
        const s = make();
        expect(s.insertReport(report('r1', { urgent: true, evidenceRef: 'match_42:t9' }))).toBe(true);
        expect(s.insertReport(report('r2'))).toBe(true);
        expect(s.loadReport('r1')).toMatchObject({ urgent: true, evidenceRef: 'match_42:t9' });
        expect(s.loadReport('r2')).toMatchObject({ urgent: false, evidenceRef: null });
        expect(s.listReports({ limit: 10 }).every((r) => typeof r.urgent === 'boolean')).toBe(true);
      });

      it('a new report has no hand-off and no escalation', () => {
        const s = make();
        s.insertReport(report('r1'));
        expect(s.loadReport('r1')).toMatchObject({ handoffAt: null, handoffBy: null, escalatedTo: null, escalatedBy: null, escalatedAt: null });
      });

      it('a stored evidenceRef is an opaque string: it is never altered or trimmed by the store', () => {
        const s = make();
        s.insertReport(report('r1', { evidenceRef: 'A_b-9:7' }));
        expect(s.loadReport('r1')?.evidenceRef).toBe('A_b-9:7');
      });
    });

    describe('urgent queries', () => {
      const seed = (s: Store): void => {
        s.insertReport(report('r1', { createdAt: NOW, urgent: true }));
        s.insertReport(report('r2', { createdAt: NOW + 1 }));
        s.insertReport(report('r3', { createdAt: NOW + 2, urgent: true }));
        s.insertReport(report('r4', { createdAt: NOW + 2, urgent: true }));
        s.insertReport(report('r5', { createdAt: NOW + 3, urgent: true }));
        s.closeReport('r5', 'actioned', false, 'mod', NOW + 10, 'n');
      };

      it('listOpenReports with urgent true returns only open urgent reports, oldest first, with the keyset cursor', () => {
        const s = make();
        seed(s);
        expect(ids(s.listOpenReports({ urgent: true, limit: 10 }))).toEqual(['r1', 'r3', 'r4']);
        expect(ids(s.listOpenReports({ urgent: true, limit: 2 }))).toEqual(['r1', 'r3']);
        expect(ids(s.listOpenReports({ urgent: true, after: NOW + 2, afterId: 'r3', limit: 10 }))).toEqual(['r4']);
        expect(ids(s.listOpenReports({ urgent: true, after: NOW, limit: 10 }))).toEqual(['r3', 'r4']);
        expect(ids(s.listOpenReports({ limit: 10 }))).toEqual(['r1', 'r2', 'r3', 'r4']);
        expect(ids(s.listOpenReports({ urgent: false, limit: 10 }))).toEqual(['r1', 'r2', 'r3', 'r4']);
      });

      it('urgent combines with the category and the reason filters', () => {
        const s = make();
        seed(s);
        s.insertReport(report('r6', { createdAt: NOW + 4, urgent: true, category: 'hate', reportedReason: 'hate' }));
        expect(ids(s.listOpenReports({ urgent: true, category: 'hate', limit: 10 }))).toEqual(['r6']);
        expect(ids(s.listOpenReports({ urgent: true, reason: 'harassment', limit: 10 }))).toEqual(['r1', 'r3', 'r4']);
        expect(ids(s.listOpenReports({ urgent: true, reason: 'spam', limit: 10 }))).toEqual([]);
      });

      it('listReports with urgent true filters newest first, decided ones included, and still pages', () => {
        const s = make();
        seed(s);
        expect(ids(s.listReports({ urgent: true, limit: 10 }))).toEqual(['r5', 'r4', 'r3', 'r1']);
        expect(ids(s.listReports({ urgent: true, status: 'open', limit: 10 }))).toEqual(['r4', 'r3', 'r1']);
        expect(ids(s.listReports({ urgent: true, before: NOW + 2, beforeId: 'r4', limit: 10 }))).toEqual(['r3', 'r1']);
        expect(ids(s.listReports({ limit: 10 }))).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
      });

      it('countOpenUrgent tracks insert, decide and setReportUrgent', () => {
        const s = make();
        const d = desk(s);
        expect(d.countOpenUrgent()).toBe(0);
        s.insertReport(report('r1', { urgent: true }));
        s.insertReport(report('r2'));
        expect(d.countOpenUrgent()).toBe(1);
        expect(d.setReportUrgent('r2', true)).toBe(true);
        expect(d.countOpenUrgent()).toBe(2);
        expect(d.setReportUrgent('r1', false)).toBe(true);
        expect(d.countOpenUrgent()).toBe(1);
        s.closeReport('r2', 'dismissed', false, 'mod', NOW + 1, 'n');
        expect(d.countOpenUrgent()).toBe(0);
      });

      it('a report decided is no longer in the urgent open scan', () => {
        const s = make();
        seed(s);
        s.closeReport('r1', 'dismissed', false, 'mod', NOW + 20, 'n');
        expect(ids(s.listOpenReports({ urgent: true, limit: 10 }))).toEqual(['r3', 'r4']);
      });
    });

    describe('setReportUrgent, setHandoff, setEscalation', () => {
      it('setReportUrgent turns it on and off on an open report, true only when this call changed it', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1'));
        expect(d.setReportUrgent('r1', true)).toBe(true);
        expect(s.loadReport('r1')?.urgent).toBe(true);
        expect(d.setReportUrgent('r1', true)).toBe(false);
        expect(d.setReportUrgent('r1', false)).toBe(true);
        expect(s.loadReport('r1')?.urgent).toBe(false);
        expect(d.setReportUrgent('nope', true)).toBe(false);
      });

      it('setReportUrgent and setEscalation on a decided report return false and change nothing', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1', { urgent: true }));
        s.closeReport('r1', 'actioned', false, 'mod', NOW + 1, 'n');
        const before = s.loadReport('r1');
        expect(d.setReportUrgent('r1', false)).toBe(false);
        expect(d.setEscalation('r1', { to: 'senior', by: 'mod_ann', at: NOW + 2 })).toBe(false);
        expect(s.loadReport('r1')).toEqual(before);
      });

      it('setHandoff first wins and returns false afterwards; the first actor and time stay', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1'));
        expect(d.setHandoff('r1', 'mod_ann', NOW + 5)).toBe(true);
        expect(d.setHandoff('r1', 'mod_bea', NOW + 9)).toBe(false);
        expect(s.loadReport('r1')).toMatchObject({ handoffBy: 'mod_ann', handoffAt: NOW + 5 });
        expect(d.setHandoff('nope', 'mod_ann', NOW)).toBe(false);
      });

      it('setEscalation sets the three columns, a second call replaces them, null clears all three', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1'));
        expect(d.setEscalation('r1', { to: 'senior', by: 'mod_ann', at: NOW + 1 })).toBe(true);
        expect(s.loadReport('r1')).toMatchObject({ escalatedTo: 'senior', escalatedBy: 'mod_ann', escalatedAt: NOW + 1 });
        expect(d.setEscalation('r1', { to: 'owner', by: 'sen_bo', at: NOW + 2 })).toBe(true);
        expect(s.loadReport('r1')).toMatchObject({ escalatedTo: 'owner', escalatedBy: 'sen_bo', escalatedAt: NOW + 2 });
        expect(d.setEscalation('r1', null)).toBe(true);
        expect(s.loadReport('r1')).toMatchObject({ escalatedTo: null, escalatedBy: null, escalatedAt: null });
        expect(d.setEscalation('r1', null)).toBe(false);
        expect(d.setEscalation('nope', null)).toBe(false);
      });

      it('an escalation to anything but senior or owner is refused (the CHECK, and the same in memory)', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1'));
        for (const to of ['moderator', 'junior', '', 'SENIOR']) {
          expect(() => d.setEscalation('r1', { to: to as never, by: 'mod_ann', at: NOW }), to).toThrow();
        }
        expect(s.loadReport('r1')?.escalatedTo).toBeNull();
      });

      it('countOpenEscalated counts open reports per target role and ignores decided ones', () => {
        const s = make();
        const d = desk(s);
        expect(d.countOpenEscalated()).toEqual({ senior: 0, owner: 0 });
        for (const id of ['r1', 'r2', 'r3', 'r4']) s.insertReport(report(id));
        d.setEscalation('r1', { to: 'senior', by: 'a', at: NOW });
        d.setEscalation('r2', { to: 'senior', by: 'a', at: NOW });
        d.setEscalation('r3', { to: 'owner', by: 'a', at: NOW });
        expect(d.countOpenEscalated()).toEqual({ senior: 2, owner: 1 });
        s.closeReport('r1', 'dismissed', false, 'mod', NOW + 1, 'n');
        // a decided report no longer counts, however it was left (the service clears the escalation when it decides)
        expect(d.countOpenEscalated()).toEqual({ senior: 1, owner: 1 });
        d.setEscalation('r3', null);
        expect(d.countOpenEscalated()).toEqual({ senior: 1, owner: 0 });
      });
    });

    describe('comments', () => {
      it('insert, list oldest first (ties by id), delete one, and count', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1'));
        s.insertReport(report('r2'));
        expect(d.insertComment(comment('c3', 'r1', { at: NOW + 2 }))).toBe(true);
        expect(d.insertComment(comment('c2', 'r1', { at: NOW + 1, kind: 'ask', text: null }))).toBe(true);
        expect(d.insertComment(comment('c1', 'r1', { at: NOW + 1, role: 'senior', actor: 'sen_bo' }))).toBe(true);
        expect(d.insertComment(comment('c9', 'r2'))).toBe(true);
        expect(ids(d.listComments('r1'))).toEqual(['c1', 'c2', 'c3']);
        expect(d.listComments('r1')[1]).toEqual(comment('c2', 'r1', { at: NOW + 1, kind: 'ask', text: null }));
        expect(d.countComments('r1')).toBe(3);
        expect(d.deleteComment('c2')).toBe(true);
        expect(d.deleteComment('c2')).toBe(false);
        expect(ids(d.listComments('r1'))).toEqual(['c1', 'c3']);
        expect(d.countComments('r1')).toBe(2);
        expect(ids(d.listComments('r2'))).toEqual(['c9']);
        expect(d.listComments('nope')).toEqual([]);
        expect(d.countComments('nope')).toBe(0);
      });

      it('the 51st comment of a report is refused, and one report full does not stop another', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1'));
        s.insertReport(report('r2'));
        for (let i = 0; i < 50; i++) expect(d.insertComment(comment(`c${String(i).padStart(3, '0')}`, 'r1', { at: NOW + i })), String(i)).toBe(true);
        expect(d.insertComment(comment('c_over', 'r1'))).toBe(false);
        expect(d.countComments('r1')).toBe(50);
        expect(d.insertComment(comment('c_other', 'r2'))).toBe(true);
        expect(d.deleteComment('c000')).toBe(true);
        expect(d.insertComment(comment('c_again', 'r1'))).toBe(true);
      });

      it('a comment of an unknown report is refused; a duplicate id throws like a primary key', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1'));
        expect(d.insertComment(comment('c1', 'nope'))).toBe(false);
        expect(d.listComments('nope')).toEqual([]);
        expect(d.insertComment(comment('c1', 'r1'))).toBe(true);
        expect(() => d.insertComment(comment('c1', 'r1', { at: NOW + 1 }))).toThrow();
        expect(d.countComments('r1')).toBe(1);
      });

      it('an unknown kind is refused (the CHECK, and the same in memory)', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1'));
        expect(() => d.insertComment(comment('c1', 'r1', { kind: 'note' as never }))).toThrow();
        expect(d.countComments('r1')).toBe(0);
      });

      it('a comment can be written on a decided report (the thread outlives the decision)', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1'));
        s.closeReport('r1', 'actioned', false, 'mod', NOW + 1, 'n');
        expect(d.insertComment(comment('c1', 'r1'))).toBe(true);
      });
    });

    describe('purges', () => {
      it('purgeReports deletes the comments of the reports it deletes and of none other', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('old', { createdAt: NOW - 100 * DAY }));
        s.insertReport(report('new', { createdAt: NOW - DAY }));
        d.insertComment(comment('c_old', 'old'));
        d.insertComment(comment('c_new', 'new'));
        expect(s.purgeReports(NOW - 90 * DAY, 0)).toBe(1);
        expect(d.listComments('old')).toEqual([]);
        expect(ids(d.listComments('new'))).toEqual(['c_new']);
      });

      it('purgeReportsByReason deletes a welfare report and its comments, with strict cutoffs: a row exactly on the line is kept', () => {
        const s = make();
        const d = desk(s);
        const cutoff = NOW - 30 * DAY;
        s.insertReport(report('w_old', { createdAt: cutoff - 1, reportedReason: 'welfare', category: 'other' }));
        s.insertReport(report('w_line', { createdAt: cutoff, reportedReason: 'welfare', category: 'other' }));
        s.insertReport(report('w_new', { createdAt: cutoff + 1, reportedReason: 'welfare', category: 'other' }));
        for (const id of ['w_old', 'w_line', 'w_new']) d.insertComment(comment(`c_${id}`, id));
        s.insertDecision('k_old', 'w_old', NOW, '{"groups":[]}');
        expect(d.purgeReportsByReason('welfare', cutoff)).toBe(1);
        expect(s.loadReport('w_old')).toBeNull();
        expect(s.loadReport('w_line')).not.toBeNull();
        expect(s.loadReport('w_new')).not.toBeNull();
        expect(d.listComments('w_old')).toEqual([]);
        expect(ids(d.listComments('w_line'))).toEqual(['c_w_line']);
        expect(s.findDecision('k_old')).toBeNull();
        expect(d.purgeReportsByReason('welfare', cutoff)).toBe(0);
      });

      it('a welfare purge leaves a non-welfare report of the same age, and a report with no reason', () => {
        const s = make();
        const d = desk(s);
        const old = NOW - 60 * DAY;
        s.insertReport(report('w', { createdAt: old, reportedReason: 'welfare', category: 'other' }));
        s.insertReport(report('h', { createdAt: old, reportedReason: 'harassment' }));
        s.insertReport(report('n', { createdAt: old, reportedReason: null, category: 'other' }));
        expect(d.purgeReportsByReason('welfare', NOW - 30 * DAY)).toBe(1);
        expect(s.loadReport('h')).not.toBeNull();
        expect(s.loadReport('n')).not.toBeNull();
        expect(d.purgeReportsByReason('other', NOW)).toBe(0);
      });

      it('a report held for legal reasons survives the welfare purge, with its comments', () => {
        const s = make();
        const d = desk(s);
        const old = NOW - 60 * DAY;
        s.insertReport(report('held', { createdAt: old, reportedReason: 'welfare', category: 'other' }));
        s.insertReport(report('free', { createdAt: old, reportedReason: 'welfare', category: 'other' }));
        d.insertComment(comment('c_held', 'held'));
        expect(s.placeHold({ reportId: 'held', code: 'other', heldBy: 'sen', heldAt: NOW, releasedBy: null, releasedAt: null })).toBe(true);
        expect(d.purgeReportsByReason('welfare', NOW - 30 * DAY)).toBe(1);
        expect(s.loadReport('held')).not.toBeNull();
        expect(ids(d.listComments('held'))).toEqual(['c_held']);
        expect(s.loadReport('free')).toBeNull();
      });
    });

    describe('the daily line counts', () => {
      it('addChatCounts adds, never replaces', () => {
        const s = make();
        const d = desk(s);
        d.addChatCounts('2026-11-17', 10, 1);
        d.addChatCounts('2026-11-17', 5, 0);
        d.addChatCounts('2026-11-17', 0, 4);
        expect(d.chatCounts('2026-11-17', '2026-11-17')).toEqual([{ day: '2026-11-17', delivered: 15, refused: 5 }]);
      });

      it('chatCounts is inclusive of both days, ordered by day, and an empty range is empty', () => {
        const s = make();
        const d = desk(s);
        for (const [day, n] of [['2026-11-15', 1], ['2026-11-16', 2], ['2026-11-17', 3], ['2026-11-18', 4]] as const) d.addChatCounts(day, n, n * 10);
        expect(d.chatCounts('2026-11-16', '2026-11-17').map((r) => r.day)).toEqual(['2026-11-16', '2026-11-17']);
        expect(d.chatCounts('2026-11-01', '2026-11-30').map((r) => r.delivered)).toEqual([1, 2, 3, 4]);
        expect(d.chatCounts('2026-11-18', '2026-11-15')).toEqual([]);
        expect(d.chatCounts('2027-01-01', '2027-01-02')).toEqual([]);
      });

      it('purgeChatCounts deletes days strictly before the cutoff and returns how many', () => {
        const s = make();
        const d = desk(s);
        for (const day of ['2026-11-15', '2026-11-16', '2026-11-17']) d.addChatCounts(day, 1, 1);
        expect(d.purgeChatCounts('2026-11-16')).toBe(1);
        expect(d.chatCounts('2026-01-01', '2026-12-31').map((r) => r.day)).toEqual(['2026-11-16', '2026-11-17']);
        expect(d.purgeChatCounts('2026-11-16')).toBe(0);
      });

      it('a count of zero is stored (the day counted, with nothing)', () => {
        const s = make();
        const d = desk(s);
        d.addChatCounts('2026-11-17', 0, 0);
        expect(d.chatCounts('2026-11-17', '2026-11-17')).toEqual([{ day: '2026-11-17', delivered: 0, refused: 0 }]);
      });
    });

    describe('insightRows', () => {
      it('respects since and limit, newest first, and carries no text, subject, handle or actor', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1', { createdAt: NOW, urgent: true, reportedReason: 'threat' }));
        s.insertReport(report('r2', { createdAt: NOW + MIN, reportedReason: null, category: 'other' }));
        s.insertReport(report('r3', { createdAt: NOW + 2 * MIN }));
        s.insertReport(report('r0', { createdAt: NOW - MIN }));
        s.closeReport('r1', 'actioned', false, 'mod_ann', NOW + 5 * MIN, 'private note');
        s.closeReport('r2', 'dismissed', true, 'mod_bea', NOW + 6 * MIN, 'private note', 'evidence text');
        const all = d.insightRows(NOW, 10);
        expect(all.map((r) => r.createdAt)).toEqual([NOW + 2 * MIN, NOW + MIN, NOW]);
        expect(all[2]).toEqual({ createdAt: NOW, actionedAt: NOW + 5 * MIN, status: 'actioned', reportedReason: 'threat', urgent: true, badFaith: false });
        expect(all[1]).toEqual({ createdAt: NOW + MIN, actionedAt: NOW + 6 * MIN, status: 'dismissed', reportedReason: null, urgent: false, badFaith: true });
        expect(all[0]).toEqual({ createdAt: NOW + 2 * MIN, actionedAt: null, status: 'open', reportedReason: 'harassment', urgent: false, badFaith: false });
        expect(d.insightRows(NOW, 2).map((r) => r.createdAt)).toEqual([NOW + 2 * MIN, NOW + MIN]);
        expect(d.insightRows(NOW + MIN, 10)).toHaveLength(2);
        expect(d.insightRows(NOW + 3 * MIN, 10)).toEqual([]);
        const text = JSON.stringify(all);
        for (const secret of ['zorbak', 'vlemmo', 'private note', 'evidence text', 'mod_ann', 'mod_bea', 's_rep', 's_tgt', 'Rep', 'Tgt', 'ROOM']) expect(text, secret).not.toContain(secret);
        for (const row of all) expect(Object.keys(row).sort()).toEqual(['actionedAt', 'badFaith', 'createdAt', 'reportedReason', 'status', 'urgent']);
      });

      it('the limit is clamped to at least 1', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1'));
        s.insertReport(report('r2', { createdAt: NOW + 1 }));
        expect(d.insightRows(0, 0)).toHaveLength(1);
        expect(d.insightRows(0, -5)).toHaveLength(1);
      });
    });

    describe('the change token', () => {
      it('every report and comment write that a moderator sees moves it; a no-op, a failed write and a read do not', () => {
        const s = make();
        const d = desk(s);
        const t = (): string => s.changeToken();
        const moved = (label: string, fn: () => unknown): void => {
          const before = t();
          fn();
          expect(t(), label).not.toBe(before);
        };
        const same = (label: string, fn: () => unknown): void => {
          const before = t();
          fn();
          expect(t(), label).toBe(before);
        };
        moved('insertReport urgent', () => s.insertReport(report('r1', { urgent: true })));
        s.insertReport(report('r2'));
        moved('setReportUrgent on', () => d.setReportUrgent('r2', true));
        same('setReportUrgent no change', () => d.setReportUrgent('r2', true));
        moved('setReportUrgent off', () => d.setReportUrgent('r2', false));
        moved('setHandoff', () => d.setHandoff('r1', 'mod_ann', NOW));
        same('setHandoff second', () => d.setHandoff('r1', 'mod_bea', NOW));
        moved('setEscalation', () => d.setEscalation('r1', { to: 'senior', by: 'a', at: NOW }));
        moved('setEscalation clear', () => d.setEscalation('r1', null));
        same('setEscalation clear again', () => d.setEscalation('r1', null));
        moved('insertComment', () => d.insertComment(comment('c1', 'r1')));
        same('insertComment refused', () => d.insertComment(comment('c2', 'nope')));
        moved('deleteComment', () => d.deleteComment('c1'));
        same('deleteComment again', () => d.deleteComment('c1'));
        same('reads', () => {
          d.countOpenUrgent();
          d.countOpenEscalated();
          d.listComments('r1');
          d.insightRows(0, 10);
          s.listOpenReports({ urgent: true, limit: 5 });
        });
        same('addChatCounts', () => d.addChatCounts('2026-11-17', 1, 1));
      });

      it('a transaction that is rolled back leaves the urgent count, the comments and the token as they were', () => {
        const s = make();
        const d = desk(s);
        s.insertReport(report('r1'));
        const token = s.changeToken();
        expect(() =>
          s.transaction(() => {
            d.setReportUrgent('r1', true);
            d.setHandoff('r1', 'mod_ann', NOW);
            d.setEscalation('r1', { to: 'owner', by: 'a', at: NOW });
            d.insertComment(comment('c1', 'r1'));
            d.addChatCounts('2026-11-17', 3, 3);
            throw new Error('undo');
          }),
        ).toThrow('undo');
        expect(d.countOpenUrgent()).toBe(0);
        expect(s.loadReport('r1')).toMatchObject({ urgent: false, handoffAt: null, escalatedTo: null });
        expect(d.listComments('r1')).toEqual([]);
        expect(d.chatCounts('2026-11-17', '2026-11-17')).toEqual([]);
        expect(s.changeToken()).toBe(token);
      });
    });

    describe('reporter outcomes', () => {
      it('a decided welfare report is left out of the numbers; every other report counts as before', () => {
        const s = make();
        for (const [id, reason, status] of [['a', 'welfare', 'dismissed'], ['b', 'welfare', 'dismissed'], ['c', 'harassment', 'dismissed'], ['d', null, 'actioned']] as const) {
          s.insertReport(report(id, { reporterSubject: 's_same', reportedReason: reason, category: reason === null ? 'other' : 'harassment', targetSubject: `s_t_${id}` }));
          s.closeReport(id, status, false, 'mod', NOW + 1, 'n');
        }
        s.insertReport(report('e', { reporterSubject: 's_same', reportedReason: 'welfare', targetSubject: 's_t_e' }));
        expect(s.reporterOutcomes?.(['s_same'], 0)).toEqual([{ reporter: 's_same', actioned: 1, noAction: 1, badFaith: 0, overturned: 0 }]);
      });

      it('a reporter with only welfare reports has no row at all', () => {
        const s = make();
        s.insertReport(report('a', { reporterSubject: 's_w', reportedReason: 'welfare' }));
        s.closeReport('a', 'dismissed', false, 'mod', NOW + 1, 'n');
        expect(s.reporterOutcomes?.(['s_w'], 0)).toEqual([]);
      });
    });

    describe('an erase of the person the report is about', () => {
      it('deletes the reports about them with their comments, and keeps the comments of other reports', async () => {
        const s = make();
        const d = desk(s);
        await s.saveSubject({ id: 's_tgt_r1', createdAt: NOW, mergedInto: null });
        s.insertReport(report('r1'));
        s.insertReport(report('r2'));
        d.insertComment(comment('c1', 'r1'));
        d.insertComment(comment('c2', 'r2'));
        s.eraseSubjects({ subjects: ['s_tgt_r1'], mode: 'none', heldReportIds: new Set(), receiptId: 'e_1', at: NOW });
        expect(s.loadReport('r1')).toBeNull();
        expect(d.listComments('r1')).toEqual([]);
        expect(ids(d.listComments('r2'))).toEqual(['c2']);
      });
    });
  });
}
