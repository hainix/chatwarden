import { describe, expect, it } from 'vitest';
import type { SanctionRow, Store, StoredReport } from '@chatwarden/core';

// The contract of the retention methods (purgeReports, purgeSanctions) and of the shared `purge` over the Store. The
// smaller purge methods are covered with their own area (mutes, strikes, notices, audit, webhook keys). One suite, run
// against every Store.

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

const report = (id: string, createdAt: number): StoredReport => ({
  id,
  createdAt,
  roomId: `ROOM-${id}`,
  tags: {},
  reporterSubject: `s_rep_${id}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: `s_tgt_${id}`,
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
});

let seq = 0;
const sanction = (groupId: string, over: Partial<SanctionRow> = {}): SanctionRow => {
  seq += 1;
  return {
    id: `row${seq}`,
    groupId,
    refCode: `M-${groupId.toUpperCase().padEnd(5, 'X').slice(0, 5)}`,
    kind: 'chat',
    targetType: 'subject',
    value: 's_a',
    startsAt: NOW - 10 * DAY,
    endsAt: NOW - 9 * DAY,
    reason: 'r',
    rule: '1',
    gapNote: null,
    gapStatus: null,
    roomId: null,
    actor: 'mod',
    source: 'moderator',
    automated: false,
    pending: false,
    ...over,
  };
};

export function retentionContract(name: string, make: () => Store): void {
  describe(`retention contract: ${name}`, () => {
    describe('purgeReports', () => {
      it('deletes reports strictly older than the cutoff and counts them', () => {
        const s = make();
        s.insertReport(report('below', NOW - 1));
        s.insertReport(report('at', NOW));
        s.insertReport(report('above', NOW + 1));
        expect(s.purgeReports(NOW, 0)).toBe(1);
        expect(s.listReports({ limit: 10 }).map((r) => r.id)).toEqual(['above', 'at']);
        expect(s.purgeReports(NOW, 0)).toBe(0);
      });

      it('spares a bad-faith dismissal still inside its window; a plain dismissal and an expired mark go', () => {
        const s = make();
        for (const id of ['live', 'expired', 'plain', 'open-bad']) s.insertReport(report(id, NOW - 100 * DAY));
        const since = NOW - 90 * DAY;
        s.closeReport('live', 'dismissed', true, 'mod', since + 1, 'n');
        s.closeReport('expired', 'dismissed', true, 'mod', since - 1, 'n');
        s.closeReport('plain', 'dismissed', false, 'mod', NOW, 'n');
        expect(s.purgeReports(NOW - 30 * DAY, since)).toBe(3);
        expect(s.listReports({ limit: 10 }).map((r) => r.id)).toEqual(['live']);
      });

      it('a bad-faith mark exactly on the window edge is spared', () => {
        const s = make();
        s.insertReport(report('edge', NOW - 100 * DAY));
        s.closeReport('edge', 'dismissed', true, 'mod', NOW - 90 * DAY, 'n');
        expect(s.purgeReports(NOW - 30 * DAY, NOW - 90 * DAY)).toBe(0);
      });

      it('deletes the decisions of purged reports and keeps those of kept ones', () => {
        const s = make();
        s.insertReport(report('old', NOW - 100 * DAY));
        s.insertReport(report('new', NOW));
        s.insertDecision('k-old', 'old', NOW, '{}');
        s.insertDecision('k-new', 'new', NOW, '{}');
        expect(s.purgeReports(NOW - 30 * DAY, 0)).toBe(1);
        expect(s.findDecision('k-old')).toBeNull();
        expect(s.findDecision('k-new')).not.toBeNull();
      });

      it('a purge that deletes no report leaves every decision, even one whose report is unknown', () => {
        const s = make();
        s.insertReport(report('new', NOW));
        s.insertDecision('k-new', 'new', NOW, '{}');
        s.insertDecision('k-orphan', 'never-stored', NOW, '{}');
        expect(s.purgeReports(NOW - 30 * DAY, 0)).toBe(0);
        expect(s.findDecision('k-new')).not.toBeNull();
        expect(s.findDecision('k-orphan')).not.toBeNull();
      });

      it('is undone with its transaction, decisions included', () => {
        const s = make();
        s.insertReport(report('old', NOW - 100 * DAY));
        s.insertDecision('k-old', 'old', NOW, '{}');
        expect(() =>
          s.transaction(() => {
            expect(s.purgeReports(NOW, 0)).toBe(1);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadReport('old')).not.toBeNull();
        expect(s.findDecision('k-old')).not.toBeNull();
      });
    });

    describe('purgeSanctions', () => {
      it('deletes ended rows (endsAt strictly before the cutoff) and revoked rows (revokedAt strictly before it)', () => {
        const s = make();
        s.insertSanctionGroup([sanction('ended', { endsAt: NOW - 1 })]);
        s.insertSanctionGroup([sanction('edge', { endsAt: NOW })]);
        s.insertSanctionGroup([sanction('revoked', { endsAt: null })]);
        s.insertSanctionGroup([sanction('live', { endsAt: NOW + DAY })]);
        s.revokeSanctionGroup('revoked', 'boss', NOW - 5, 'x');
        expect(s.purgeSanctions(NOW)).toBe(2);
        expect(s.loadSubjectActions(0).map((r) => r.groupId).sort()).toEqual(['edge', 'live']);
      });

      it('a permanent, unrevoked row is never deleted', () => {
        const s = make();
        s.insertSanctionGroup([sanction('perm', { endsAt: null, startsAt: 0 })]);
        expect(s.purgeSanctions(NOW + 1000 * DAY)).toBe(0);
        expect(s.loadSanctions(NOW)).toHaveLength(1);
      });

      it('counts rows, not groups', () => {
        const s = make();
        s.insertSanctionGroup([sanction('g1', { endsAt: NOW - 1 }), sanction('g1', { endsAt: NOW - 1, targetType: 'ip', value: 'iphash' })]);
        expect(s.purgeSanctions(NOW)).toBe(2);
      });

      it('spares an ended row with an open rule gap, and purges it once the gap is closed', () => {
        const s = make();
        s.insertSanctionGroup([sanction('gap', { endsAt: NOW - 1, rule: 'uncovered', gapNote: 'a note', gapStatus: 'open' })]);
        expect(s.purgeSanctions(NOW)).toBe(0);
        expect(s.listGaps()).toHaveLength(1);
        expect(s.closeGap('gap', 'not_a_rule', null, 'boss', NOW)).toBe(true);
        expect(s.purgeSanctions(NOW)).toBe(1);
        expect(s.listGaps()).toEqual([]);
      });

      it('frees the ref code of a purged group for reuse', () => {
        const s = make();
        s.insertSanctionGroup([sanction('g1', { endsAt: NOW - 1, refCode: 'M-REUSE' })]);
        expect(s.insertSanctionGroup([sanction('g2', { refCode: 'M-REUSE' })])).toBe(false);
        expect(s.purgeSanctions(NOW)).toBe(1);
        expect(s.insertSanctionGroup([sanction('g2', { refCode: 'M-REUSE' })])).toBe(true);
      });

      it('is undone with its transaction', () => {
        const s = make();
        s.insertSanctionGroup([sanction('g1', { endsAt: NOW - 1, refCode: 'M-KEEP1' })]);
        expect(() =>
          s.transaction(() => {
            expect(s.purgeSanctions(NOW)).toBe(1);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadSubjectActions(0)).toHaveLength(1);
        expect(s.insertSanctionGroup([sanction('g2', { refCode: 'M-KEEP1' })])).toBe(false);
      });
    });
  });
}
