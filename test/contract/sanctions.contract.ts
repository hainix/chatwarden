import { describe, expect, it } from 'vitest';
import type { SanctionRow, Store } from '@chatwarden/core';

// The contract of the sanction, rule-gap and sanction-derived history methods of the Store. One suite, run against
// every Store.

const H = 3_600_000;
const NOW = 1_800_000_000_000;

let seq = 0;
const row = (over: Partial<SanctionRow> = {}): SanctionRow => {
  seq += 1;
  return {
    id: `row${seq}`,
    groupId: 'g1',
    refCode: 'M-AAAAA',
    kind: 'chat',
    targetType: 'subject',
    value: 's_a',
    startsAt: NOW,
    endsAt: NOW + H,
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
/** A subject row plus an ip row of one group. */
const group = (groupId: string, refCode: string, over: Partial<SanctionRow> = {}): SanctionRow[] => [
  row({ groupId, refCode, ...over }),
  row({ groupId, refCode, ...over, targetType: 'ip', value: `iphash-${groupId}`, gapNote: null, gapStatus: null }),
];

export function sanctionsContract(name: string, make: () => Store): void {
  describe(`sanctions contract: ${name}`, () => {
    describe('insertSanctionGroup / loadSanctions', () => {
      it('an empty group is accepted and writes nothing', () => {
        const s = make();
        expect(s.insertSanctionGroup([])).toBe(true);
        expect(s.loadSanctions(NOW)).toEqual([]);
      });

      it('round-trips every field of a row, in write order', () => {
        const s = make();
        const a = row({ groupId: 'g1', refCode: 'M-AAAAA', kind: 'ban', endsAt: null, reason: 'private reason', rule: 'uncovered', roomId: 'ROOM1', automated: true, source: 'auto_filter', pending: true, gapNote: 'n', gapStatus: 'open' });
        const b = row({ groupId: 'g1', refCode: 'M-AAAAA', kind: 'ban', endsAt: null, targetType: 'ip', value: 'iphash' });
        expect(s.insertSanctionGroup([a, b])).toBe(true);
        expect(s.loadSanctions(NOW)).toEqual([a, b]);
      });

      it('a ref code already held by another group is refused and nothing of the new group is written', () => {
        const s = make();
        expect(s.insertSanctionGroup(group('g1', 'M-AAAAA'))).toBe(true);
        expect(s.insertSanctionGroup(group('g2', 'M-AAAAA'))).toBe(false);
        expect(s.loadSanctions(NOW).map((r) => r.groupId)).toEqual(['g1', 'g1']);
        expect(s.sanctionRefCode('g2')).toBeNull();
      });

      it('a different ref code is a new group (control)', () => {
        const s = make();
        expect(s.insertSanctionGroup(group('g1', 'M-AAAAA'))).toBe(true);
        expect(s.insertSanctionGroup(group('g2', 'M-BBBBB'))).toBe(true);
        expect(s.loadSanctions(NOW)).toHaveLength(4);
      });

      it('loadSanctions leaves out revoked rows and ended rows; a row applies strictly before endsAt', () => {
        const s = make();
        s.insertSanctionGroup([row({ groupId: 'live', refCode: 'M-LIVE1', endsAt: NOW + 10 })]);
        s.insertSanctionGroup([row({ groupId: 'perm', refCode: 'M-PERM1', endsAt: null })]);
        s.insertSanctionGroup([row({ groupId: 'edge', refCode: 'M-EDGE1', endsAt: NOW })]);
        s.insertSanctionGroup([row({ groupId: 'gone', refCode: 'M-GONE1', endsAt: NOW - 1 })]);
        s.insertSanctionGroup([row({ groupId: 'rev', refCode: 'M-REV01', endsAt: NOW + 10 })]);
        s.revokeSanctionGroup('rev', 'boss', NOW, 'oops');
        expect(s.loadSanctions(NOW).map((r) => r.groupId)).toEqual(['live', 'perm']);
      });

      it('loadSanctions rows carry no revokedAt property', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA'));
        for (const r of s.loadSanctions(NOW)) expect('revokedAt' in r).toBe(false);
      });

      it('the returned rows are copies', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA'));
        s.loadSanctions(NOW)[0]!.reason = 'tampered';
        expect(s.loadSanctions(NOW)[0]?.reason).toBe('r');
      });

      it('a rolled-back insert leaves nothing and frees its ref code', () => {
        const s = make();
        expect(() =>
          s.transaction(() => {
            expect(s.insertSanctionGroup(group('g1', 'M-AAAAA'))).toBe(true);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadSanctions(NOW)).toEqual([]);
        expect(s.sanctionRefCode('g1')).toBeNull();
        expect(s.insertSanctionGroup(group('g2', 'M-AAAAA'))).toBe(true);
      });
    });

    describe('revokeSanctionGroup', () => {
      it('revokes every unrevoked row of the group and counts them; a second call revokes none', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA'));
        s.insertSanctionGroup(group('g2', 'M-BBBBB'));
        expect(s.revokeSanctionGroup('g1', 'boss', NOW + 5, 'why')).toBe(2);
        expect(s.revokeSanctionGroup('g1', 'other', NOW + 9, 'again')).toBe(0);
        expect(s.loadSanctions(NOW).map((r) => r.groupId)).toEqual(['g2', 'g2']);
      });

      it('keeps the first revoker and time', () => {
        const s = make();
        s.insertSanctionGroup([row({ groupId: 'g1', refCode: 'M-AAAAA' })]);
        s.revokeSanctionGroup('g1', 'first', NOW + 5, 'one');
        s.revokeSanctionGroup('g1', 'second', NOW + 9, 'two');
        expect(s.loadSubjectActions(0)[0]?.revokedAt).toBe(NOW + 5);
      });

      it('an unknown group revokes nothing', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA'));
        expect(s.revokeSanctionGroup('nope', 'boss', NOW, 'x')).toBe(0);
        expect(s.loadSanctions(NOW)).toHaveLength(2);
      });

      it('is undone with its transaction', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA'));
        expect(() =>
          s.transaction(() => {
            expect(s.revokeSanctionGroup('g1', 'boss', NOW, 'x')).toBe(2);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadSanctions(NOW)).toHaveLength(2);
        expect(s.loadSubjectActions(0)[0]?.revokedAt).toBeNull();
      });
    });

    describe('sanctionRefCode / sanctionGroupTarget', () => {
      it('finds the ref code of a live, revoked or ended group; null for an unknown one', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA'));
        s.insertSanctionGroup([row({ groupId: 'g2', refCode: 'M-BBBBB', endsAt: NOW - 1 })]);
        s.revokeSanctionGroup('g1', 'boss', NOW, 'x');
        expect(s.sanctionRefCode('g1')).toBe('M-AAAAA');
        expect(s.sanctionRefCode('g2')).toBe('M-BBBBB');
        expect(s.sanctionRefCode('nope')).toBeNull();
      });

      it('the group target is the SUBJECT row (never the ip row) and its rule text', () => {
        const s = make();
        s.insertSanctionGroup([
          row({ groupId: 'g1', refCode: 'M-AAAAA', targetType: 'ip', value: 'iphash', rule: '9' }),
          row({ groupId: 'g1', refCode: 'M-AAAAA', value: 's_target', rule: '2' }),
        ]);
        expect(s.sanctionGroupTarget('g1')).toEqual({ subject: 's_target', rule: '2' });
        expect(s.sanctionGroupTarget('nope')).toBeNull();
      });

      it('a null rule reads as null; a group with only an ip row has no subject target', () => {
        const s = make();
        s.insertSanctionGroup([row({ groupId: 'g1', refCode: 'M-AAAAA', rule: null })]);
        s.insertSanctionGroup([row({ groupId: 'g2', refCode: 'M-BBBBB', targetType: 'ip', value: 'iphash' })]);
        expect(s.sanctionGroupTarget('g1')).toEqual({ subject: 's_a', rule: null });
        expect(s.sanctionGroupTarget('g2')).toBeNull();
      });

      it('revoked and ended groups are still found', () => {
        const s = make();
        s.insertSanctionGroup([row({ groupId: 'g1', refCode: 'M-AAAAA', endsAt: NOW - 1 })]);
        s.revokeSanctionGroup('g1', 'boss', NOW, 'x');
        expect(s.sanctionGroupTarget('g1')).toEqual({ subject: 's_a', rule: '1' });
      });
    });

    describe('loadSubjectActions', () => {
      it('returns subject rows only, at or after since, revoked and ended included, with revokedAt', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA', { startsAt: NOW }));
        s.insertSanctionGroup(group('g2', 'M-BBBBB', { startsAt: NOW + 10, endsAt: NOW + 11 }));
        s.insertSanctionGroup(group('g3', 'M-CCCCC', { startsAt: NOW - 100 }));
        s.revokeSanctionGroup('g2', 'boss', NOW + 20, 'x');
        const got = s.loadSubjectActions(NOW);
        expect(got.map((r) => r.groupId)).toEqual(['g1', 'g2']);
        expect(got.every((r) => r.targetType === 'subject')).toBe(true);
        expect(got.map((r) => r.revokedAt)).toEqual([null, NOW + 20]);
      });

      it('since is inclusive; oldest write first', () => {
        const s = make();
        s.insertSanctionGroup([row({ groupId: 'b', refCode: 'M-BBBBB', startsAt: NOW + 5 })]);
        s.insertSanctionGroup([row({ groupId: 'a', refCode: 'M-AAAAA', startsAt: NOW })]);
        expect(s.loadSubjectActions(NOW).map((r) => r.groupId)).toEqual(['b', 'a']);
        expect(s.loadSubjectActions(NOW + 1).map((r) => r.groupId)).toEqual(['b']);
        expect(s.loadSubjectActions(NOW + 6)).toEqual([]);
      });
    });

    describe('rule gaps: listGaps / closeGap', () => {
      const gapGroup = (groupId: string, refCode: string, startsAt: number, note = 'a gap note') => [
        row({ groupId, refCode, startsAt, gapNote: note, gapStatus: 'open', rule: 'uncovered' }),
        row({ groupId, refCode, startsAt, targetType: 'ip', value: `ip-${groupId}` }),
      ];

      it('lists only subject rows that carry a note, newest startsAt first', () => {
        const s = make();
        s.insertSanctionGroup(gapGroup('g1', 'M-AAAAA', NOW));
        s.insertSanctionGroup(group('plain', 'M-PLAIN'));
        s.insertSanctionGroup(gapGroup('g2', 'M-BBBBB', NOW + 10));
        expect(s.listGaps().map((r) => r.groupId)).toEqual(['g2', 'g1']);
        expect(s.listGaps().every((r) => r.targetType === 'subject' && r.gapNote !== null)).toBe(true);
      });

      it('a tie on startsAt is broken by write order, newest write first', () => {
        const s = make();
        s.insertSanctionGroup(gapGroup('first', 'M-AAAAA', NOW));
        s.insertSanctionGroup(gapGroup('second', 'M-BBBBB', NOW));
        expect(s.listGaps().map((r) => r.groupId)).toEqual(['second', 'first']);
      });

      it('a revoked group still lists', () => {
        const s = make();
        s.insertSanctionGroup(gapGroup('g1', 'M-AAAAA', NOW));
        s.revokeSanctionGroup('g1', 'boss', NOW, 'x');
        expect(s.listGaps().map((r) => r.groupId)).toEqual(['g1']);
      });

      it('closeGap closes an open gap once, as ruled or not_a_rule', () => {
        const s = make();
        s.insertSanctionGroup(gapGroup('g1', 'M-AAAAA', NOW));
        s.insertSanctionGroup(gapGroup('g2', 'M-BBBBB', NOW + 1));
        expect(s.closeGap('g1', 'ruled', '7', 'boss', NOW + 100)).toBe(true);
        expect(s.closeGap('g1', 'not_a_rule', null, 'boss', NOW + 101)).toBe(false);
        expect(s.closeGap('g2', 'not_a_rule', null, 'boss', NOW + 102)).toBe(true);
        const byGroup = new Map(s.listGaps().map((r) => [r.groupId, r.gapStatus]));
        expect(byGroup.get('g1')).toBe('ruled');
        expect(byGroup.get('g2')).toBe('not_a_rule');
      });

      it('closeGap is false for an unknown group and for a group with no note', () => {
        const s = make();
        s.insertSanctionGroup(group('plain', 'M-PLAIN'));
        expect(s.closeGap('nope', 'ruled', '1', 'boss', NOW)).toBe(false);
        expect(s.closeGap('plain', 'ruled', '1', 'boss', NOW)).toBe(false);
        expect(s.listAudit({ limit: 10 })).toEqual([]);
      });

      it('closeGap writes one gap.close audit entry, and a refused close writes none', () => {
        const s = make();
        s.insertSanctionGroup(gapGroup('g1', 'M-AAAAA', NOW));
        s.closeGap('g1', 'ruled', '7', 'boss', NOW + 100);
        s.closeGap('g1', 'ruled', '7', 'boss', NOW + 200);
        const entries = s.listAudit({ limit: 10 });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ at: NOW + 100, actor: 'boss', role: null, action: 'gap.close', target: { type: 'sanction', ref: 'g1' } });
      });

      it('a close is undone with its transaction, audit entry included', () => {
        const s = make();
        s.insertSanctionGroup(gapGroup('g1', 'M-AAAAA', NOW));
        expect(() =>
          s.transaction(() => {
            expect(s.closeGap('g1', 'ruled', '7', 'boss', NOW + 100)).toBe(true);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.listGaps()[0]?.gapStatus).toBe('open');
        expect(s.listAudit({ limit: 10 })).toEqual([]);
        expect(s.closeGap('g1', 'ruled', '7', 'boss', NOW + 100)).toBe(true);
      });
    });

    describe('automatic chat history', () => {
      const auto = (groupId: string, refCode: string, value: string, startsAt: number, over: Partial<SanctionRow> = {}) =>
        row({ groupId, refCode, value, startsAt, kind: 'chat', source: 'auto_filter', automated: true, ...over });

      it('loadAutoChatStarts: the latest start per subject, revoked and ended included; chat, auto_filter and subject rows only', () => {
        const s = make();
        s.insertSanctionGroup([auto('g1', 'M-AAAAA', 's_a', NOW)]);
        s.insertSanctionGroup([auto('g2', 'M-BBBBB', 's_a', NOW + 50, { endsAt: NOW + 51 })]);
        s.insertSanctionGroup([auto('g3', 'M-CCCCC', 's_a', NOW + 999, { source: 'moderator', automated: false })]);
        s.insertSanctionGroup([auto('g4', 'M-DDDDD', 's_a', NOW + 999, { kind: 'ban' })]);
        s.insertSanctionGroup([auto('g5', 'M-EEEEE', 'iphash', NOW + 999, { targetType: 'ip' })]);
        s.insertSanctionGroup([auto('g6', 'M-FFFFF', 's_b', NOW + 7)]);
        s.revokeSanctionGroup('g2', 'boss', NOW + 60, 'x');
        // In the order each subject was first written.
        expect(s.loadAutoChatStarts()).toEqual([
          { subject: 's_a', startsAt: NOW + 50 },
          { subject: 's_b', startsAt: NOW + 7 },
        ]);
      });

      it('loadAutoChatStarts is empty for an empty store', () => {
        expect(make().loadAutoChatStarts()).toEqual([]);
      });

      it('loadAutoChatGroups: each automatic chat group once, subject rows only, since inclusive', () => {
        const s = make();
        s.insertSanctionGroup([auto('g1', 'M-AAAAA', 's_a', NOW), auto('g1', 'M-AAAAA', 'iphash', NOW, { targetType: 'ip' })]);
        s.insertSanctionGroup([auto('g2', 'M-BBBBB', 's_a', NOW - 10)]);
        s.insertSanctionGroup([auto('g3', 'M-CCCCC', 's_a', NOW - 11)]);
        s.insertSanctionGroup([auto('g4', 'M-DDDDD', 's_b', NOW + 5)]);
        s.insertSanctionGroup([auto('g5', 'M-EEEEE', 's_b', NOW + 5, { source: 'api', automated: false })]);
        s.revokeSanctionGroup('g4', 'boss', NOW + 6, 'x');
        const got = s.loadAutoChatGroups(NOW - 10);
        expect(got).toHaveLength(3);
        expect(got).toEqual(
          expect.arrayContaining([
            { subject: 's_a', groupId: 'g1' },
            { subject: 's_a', groupId: 'g2' },
            { subject: 's_b', groupId: 'g4' },
          ]),
        );
      });
    });
  });
}
