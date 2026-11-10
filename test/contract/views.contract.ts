import { describe, expect, it } from 'vitest';
import type { SanctionRow, Store, StoredReport, StrikeRow } from '@chatwarden/core';

// The contract of the methods behind the staff read views (K4): listSubjectSanctions, listStrikes, countStrikesByTerm and
// reporterTally. One suite, run against every Store.

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const T0 = NOW;

let seq = 0;
const row = (over: Partial<SanctionRow> = {}): SanctionRow => {
  seq += 1;
  return {
    id: `row${String(seq).padStart(4, '0')}`,
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
/** A subject row plus an ip row of one group; `code` doubles as the ref code. */
const group = (groupId: string, code: string, over: Partial<SanctionRow> = {}): SanctionRow[] => [
  row({ groupId, refCode: code, ...over }),
  row({ groupId, refCode: code, ...over, targetType: 'ip', value: `iphash-${groupId}`, gapNote: null, gapStatus: null }),
];
const groups = (rows: SanctionRow[]): string[] => rows.map((r) => r.groupId);

const strike = (id: string, at: number, over: Partial<StrikeRow> = {}): StrikeRow => ({
  id,
  at,
  subject: 's_a',
  roomId: 'ROOM1',
  termId: 'term1',
  rawLine: 'a line the subject typed',
  ...over,
});

let rseq = 0;
const report = (over: Partial<StoredReport> = {}): StoredReport => {
  rseq += 1;
  return {
    id: `rep${rseq}`,
    createdAt: NOW + rseq,
    roomId: `ROOM${rseq}`,
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
    ...over,
  };
};

export function viewsContract(name: string, make: () => Store): void {
  describe(`staff views contract: ${name}`, () => {
    describe('listSubjectSanctions', () => {
      it('returns subject rows only, never an ip row, each with the revoke columns null while unrevoked', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA'));
        const got = s.listSubjectSanctions({ limit: 50 });
        expect(groups(got)).toEqual(['g1']);
        expect(got[0]).toMatchObject({ targetType: 'subject', value: 's_a', revokedAt: null, revokedBy: null, revokeReason: null });
        expect(got.some((r) => r.targetType === 'ip')).toBe(false);
      });

      it('round-trips every stored field of the subject row', () => {
        const s = make();
        const a = row({ groupId: 'g1', refCode: 'M-AAAAA', kind: 'ban', endsAt: null, rule: 'uncovered', roomId: 'ROOM1', automated: true, source: 'auto_filter', pending: true, gapNote: 'n', gapStatus: 'open', reason: 'private' });
        s.insertSanctionGroup([a]);
        expect(s.listSubjectSanctions({ limit: 5 })).toEqual([{ ...a, revokedAt: null, revokedBy: null, revokeReason: null }]);
      });

      it('lists newest first by startsAt, a tie by id descending', () => {
        const s = make();
        s.insertSanctionGroup([row({ id: 'a', groupId: 'g1', refCode: 'M-AAAAA', startsAt: NOW })]);
        s.insertSanctionGroup([row({ id: 'b', groupId: 'g2', refCode: 'M-BBBBB', startsAt: NOW + 10 })]);
        s.insertSanctionGroup([row({ id: 'c', groupId: 'g3', refCode: 'M-CCCCC', startsAt: NOW })]);
        s.insertSanctionGroup([row({ id: 'd', groupId: 'g4', refCode: 'M-DDDDD', startsAt: NOW - 10 })]);
        expect(groups(s.listSubjectSanctions({ limit: 10 }))).toEqual(['g2', 'g3', 'g1', 'g4']);
      });

      it('carries who revoked a group, when and why; the first revoker is kept', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA'));
        s.insertSanctionGroup(group('g2', 'M-BBBBB', { startsAt: NOW - 5 }));
        s.revokeSanctionGroup('g1', 'first', NOW + 5, 'one');
        s.revokeSanctionGroup('g1', 'second', NOW + 9, 'two');
        const got = s.listSubjectSanctions({ limit: 10 });
        expect(got.map((r) => [r.groupId, r.revokedAt, r.revokedBy, r.revokeReason])).toEqual([
          ['g1', NOW + 5, 'first', 'one'],
          ['g2', null, null, null],
        ]);
      });

      it('subjects filters by the stored target; an empty list matches nobody; absent matches everybody', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA', { value: 's_a' }));
        s.insertSanctionGroup(group('g2', 'M-BBBBB', { value: 's_b', startsAt: NOW - 1 }));
        s.insertSanctionGroup(group('g3', 'M-CCCCC', { value: 's_c', startsAt: NOW - 2 }));
        expect(groups(s.listSubjectSanctions({ subjects: ['s_b', 's_c'], limit: 10 }))).toEqual(['g2', 'g3']);
        expect(groups(s.listSubjectSanctions({ subjects: ['s_a'], limit: 10 }))).toEqual(['g1']);
        expect(s.listSubjectSanctions({ subjects: [], limit: 10 })).toEqual([]);
        expect(s.listSubjectSanctions({ subjects: ['nobody'], limit: 10 })).toEqual([]);
        expect(groups(s.listSubjectSanctions({ limit: 10 }))).toEqual(['g1', 'g2', 'g3']);
      });

      it('an ip row whose hash equals a subject filter value is still not returned', () => {
        const s = make();
        s.insertSanctionGroup([row({ groupId: 'g1', refCode: 'M-AAAAA', targetType: 'ip', value: 's_a' })]);
        expect(s.listSubjectSanctions({ subjects: ['s_a'], limit: 10 })).toEqual([]);
        expect(s.listSubjectSanctions({ limit: 10 })).toEqual([]);
      });

      it('source filters; every source can be asked for', () => {
        const s = make();
        s.insertSanctionGroup([row({ groupId: 'g1', refCode: 'M-AAAAA', source: 'moderator', startsAt: NOW })]);
        s.insertSanctionGroup([row({ groupId: 'g2', refCode: 'M-BBBBB', source: 'auto_filter', startsAt: NOW - 1 })]);
        s.insertSanctionGroup([row({ groupId: 'g3', refCode: 'M-CCCCC', source: 'ai', startsAt: NOW - 2 })]);
        expect(groups(s.listSubjectSanctions({ source: 'auto_filter', limit: 10 }))).toEqual(['g2']);
        expect(groups(s.listSubjectSanctions({ source: 'ai', limit: 10 }))).toEqual(['g3']);
        expect(s.listSubjectSanctions({ source: 'coop', limit: 10 })).toEqual([]);
      });

      it('since is inclusive; revoked and ended rows are included', () => {
        const s = make();
        s.insertSanctionGroup([row({ groupId: 'old', refCode: 'M-OLD01', startsAt: NOW - 100 })]);
        s.insertSanctionGroup([row({ groupId: 'edge', refCode: 'M-EDGE1', startsAt: NOW - 50, endsAt: NOW - 49 })]);
        s.insertSanctionGroup([row({ groupId: 'rev', refCode: 'M-REV01', startsAt: NOW })]);
        s.revokeSanctionGroup('rev', 'boss', NOW + 1, 'x');
        expect(groups(s.listSubjectSanctions({ since: NOW - 50, limit: 10 }))).toEqual(['rev', 'edge']);
      });

      it('alsoPermanent adds older permanent rows that are not revoked, and nothing else old', () => {
        const s = make();
        s.insertSanctionGroup([row({ groupId: 'recent', refCode: 'M-RECNT', startsAt: NOW })]);
        s.insertSanctionGroup([row({ groupId: 'oldperm', refCode: 'M-OLDPM', startsAt: NOW - 200 * DAY, endsAt: null, kind: 'ban' })]);
        s.insertSanctionGroup([row({ groupId: 'oldrev', refCode: 'M-OLDRV', startsAt: NOW - 201 * DAY, endsAt: null, kind: 'ban' })]);
        s.insertSanctionGroup([row({ groupId: 'oldtimed', refCode: 'M-OLDTM', startsAt: NOW - 202 * DAY, endsAt: NOW - 201 * DAY })]);
        s.revokeSanctionGroup('oldrev', 'boss', NOW, 'x');
        const since = NOW - 90 * DAY;
        expect(groups(s.listSubjectSanctions({ since, alsoPermanent: true, limit: 10 }))).toEqual(['recent', 'oldperm']);
        // Without the flag the old permanent one is left out; the flag alone (no since) changes nothing.
        expect(groups(s.listSubjectSanctions({ since, limit: 10 }))).toEqual(['recent']);
        expect(s.listSubjectSanctions({ alsoPermanent: true, limit: 10 })).toHaveLength(4);
      });

      it('activeAt keeps only unrevoked rows in force at that instant (no end, or ending strictly after it), of any age', () => {
        const s = make();
        s.insertSanctionGroup([row({ groupId: 'live', refCode: 'M-LIVE1', startsAt: NOW - 300 * DAY, endsAt: NOW + 10 })]);
        s.insertSanctionGroup([row({ groupId: 'perm', refCode: 'M-PERM1', startsAt: NOW - 400 * DAY, endsAt: null, kind: 'ban' })]);
        s.insertSanctionGroup([row({ groupId: 'edge', refCode: 'M-EDGE1', startsAt: NOW - 5, endsAt: NOW })]);
        s.insertSanctionGroup([row({ groupId: 'gone', refCode: 'M-GONE1', startsAt: NOW - 5, endsAt: NOW - 1 })]);
        s.insertSanctionGroup([row({ groupId: 'rev', refCode: 'M-REV01', startsAt: NOW - 5, endsAt: null })]);
        s.revokeSanctionGroup('rev', 'boss', NOW, 'x');
        s.insertSanctionGroup(group('withip', 'M-WIP01', { startsAt: NOW - 2, endsAt: NOW + 100 }));
        expect(groups(s.listSubjectSanctions({ activeAt: NOW, limit: 10 }))).toEqual(['withip', 'live', 'perm']);
        expect(groups(s.listSubjectSanctions({ activeAt: NOW + 20, limit: 10 }))).toEqual(['withip', 'perm']);
        expect(s.listSubjectSanctions({ activeAt: NOW, subjects: [], limit: 10 })).toEqual([]);
        expect(groups(s.listSubjectSanctions({ activeAt: NOW, subjects: ['s_a'], source: 'moderator', limit: 10 }))).toEqual(['withip', 'live', 'perm']);
      });

      it('pages with a keyset cursor: exactly one page, the page after it empty, and a cursor past the end', () => {
        const s = make();
        for (let i = 0; i < 5; i += 1) s.insertSanctionGroup([row({ id: `p${i}`, groupId: `g${i}`, refCode: `M-PAGE${i}`, startsAt: NOW + i })]);
        const first = s.listSubjectSanctions({ limit: 2 });
        expect(groups(first)).toEqual(['g4', 'g3']);
        const last1 = first[1]!;
        const second = s.listSubjectSanctions({ limit: 2, before: last1.startsAt, beforeId: last1.id });
        expect(groups(second)).toEqual(['g2', 'g1']);
        const last2 = second[1]!;
        const third = s.listSubjectSanctions({ limit: 2, before: last2.startsAt, beforeId: last2.id });
        expect(groups(third)).toEqual(['g0']);
        const past = third[0]!;
        expect(s.listSubjectSanctions({ limit: 2, before: past.startsAt, beforeId: past.id })).toEqual([]);
        // Exactly one page of everything.
        expect(s.listSubjectSanctions({ limit: 5 })).toHaveLength(5);
      });

      it('a cursor on a tie of startsAt keeps the rows after the cursor id and drops the ones at or above it', () => {
        const s = make();
        for (const id of ['a', 'b', 'c']) s.insertSanctionGroup([row({ id, groupId: `g-${id}`, refCode: `M-TIE0${id}`, startsAt: NOW })]);
        expect(groups(s.listSubjectSanctions({ limit: 10, before: NOW, beforeId: 'c' }))).toEqual(['g-b', 'g-a']);
        expect(groups(s.listSubjectSanctions({ limit: 10, before: NOW, beforeId: 'a' }))).toEqual([]);
        // before alone is exclusive; beforeId without before is ignored.
        expect(s.listSubjectSanctions({ limit: 10, before: NOW })).toEqual([]);
        expect(s.listSubjectSanctions({ limit: 10, beforeId: 'a' })).toHaveLength(3);
      });

      it('limit is clamped to 1..200 and a fraction is floored', () => {
        const s = make();
        for (let i = 0; i < 205; i += 1) s.insertSanctionGroup([row({ groupId: `g${i}`, refCode: `M-C${String(i).padStart(4, '0')}`, startsAt: NOW + i })]);
        expect(s.listSubjectSanctions({ limit: 0 })).toHaveLength(1);
        expect(s.listSubjectSanctions({ limit: -4 })).toHaveLength(1);
        expect(s.listSubjectSanctions({ limit: 2.9 })).toHaveLength(2);
        expect(s.listSubjectSanctions({ limit: 1000 })).toHaveLength(200);
      });

      it('returns copies', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA'));
        s.listSubjectSanctions({ limit: 5 })[0]!.reason = 'tampered';
        expect(s.listSubjectSanctions({ limit: 5 })[0]?.reason).toBe('r');
      });

      it('sees a revoke and an insert made in a transaction that is rolled back as if neither happened', () => {
        const s = make();
        s.insertSanctionGroup(group('g1', 'M-AAAAA'));
        expect(() =>
          s.transaction(() => {
            s.revokeSanctionGroup('g1', 'boss', NOW, 'x');
            s.insertSanctionGroup(group('g2', 'M-BBBBB'));
            expect(groups(s.listSubjectSanctions({ limit: 10 })).sort()).toEqual(['g1', 'g2']);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        const got = s.listSubjectSanctions({ limit: 10 });
        expect(groups(got)).toEqual(['g1']);
        expect(got[0]).toMatchObject({ revokedAt: null, revokedBy: null, revokeReason: null });
      });
    });

    describe('listStrikes', () => {
      it('round-trips every field, newest first, a tie by id descending', () => {
        const s = make();
        s.insertStrike(strike('a', T0));
        s.insertStrike(strike('b', T0 + 10));
        s.insertStrike(strike('c', T0 + 10));
        s.insertStrike(strike('z', T0 - 10, { subject: 's_b', roomId: 'ROOM9', termId: 'term9', rawLine: 'other' }));
        const got = s.listStrikes(0, 10);
        expect(got.map((r) => r.id)).toEqual(['c', 'b', 'a', 'z']);
        expect(got[3]).toEqual(strike('z', T0 - 10, { subject: 's_b', roomId: 'ROOM9', termId: 'term9', rawLine: 'other' }));
      });

      it('since is inclusive', () => {
        const s = make();
        s.insertStrike(strike('below', T0 - 1));
        s.insertStrike(strike('at', T0));
        s.insertStrike(strike('above', T0 + 1));
        expect(s.listStrikes(T0, 10).map((r) => r.id)).toEqual(['above', 'at']);
        expect(s.listStrikes(T0 + 2, 10)).toEqual([]);
      });

      it('limit caps the page (keeping the newest) and is clamped to 1..500', () => {
        const s = make();
        for (let i = 0; i < 505; i += 1) s.insertStrike(strike(`k${String(i).padStart(4, '0')}`, T0 + i));
        expect(s.listStrikes(0, 3).map((r) => r.id)).toEqual(['k0504', 'k0503', 'k0502']);
        expect(s.listStrikes(0, 0)).toHaveLength(1);
        expect(s.listStrikes(0, 2.9)).toHaveLength(2);
        expect(s.listStrikes(0, 9999)).toHaveLength(500);
      });

      it('returns copies, and nothing when there are no strikes', () => {
        const s = make();
        expect(s.listStrikes(0, 10)).toEqual([]);
        s.insertStrike(strike('k1', T0));
        s.listStrikes(0, 10)[0]!.rawLine = 'tampered';
        expect(s.listStrikes(0, 10)[0]?.rawLine).toBe('a line the subject typed');
      });
    });

    describe('countStrikesByTerm', () => {
      const byTerm = (s: Store, since: number) =>
        Object.fromEntries(s.countStrikesByTerm(since).map((r) => [r.termId, r.count]));

      it('counts strikes per term at or after since; a term with none is absent', () => {
        const s = make();
        s.insertStrike(strike('1', T0, { termId: 'tA' }));
        s.insertStrike(strike('2', T0 + 1, { termId: 'tA', subject: 's_b' }));
        s.insertStrike(strike('3', T0 + 2, { termId: 'tB' }));
        s.insertStrike(strike('4', T0 - 1, { termId: 'tC' }));
        expect(byTerm(s, T0)).toEqual({ tA: 2, tB: 1 });
        expect(byTerm(s, 0)).toEqual({ tA: 2, tB: 1, tC: 1 });
        expect(byTerm(s, T0 + 3)).toEqual({});
      });

      it('is empty for an empty store, and each row is { termId, count } only', () => {
        const s = make();
        expect(s.countStrikesByTerm(0)).toEqual([]);
        s.insertStrike(strike('1', T0, { termId: 'tA' }));
        expect(s.countStrikesByTerm(0)).toEqual([{ termId: 'tA', count: 1 }]);
      });
    });

    describe('reporterTally', () => {
      const close = (s: Store, id: string, status: 'actioned' | 'dismissed', badFaith: boolean) => {
        expect(s.closeReport(id, status, badFaith, 'mod', NOW + 100, 'note')).toBe(true);
      };

      it('counts by status and bad faith, only for the listed reporters', () => {
        const s = make();
        s.insertReport(report({ id: 'a', reporterSubject: 's_one' }));
        s.insertReport(report({ id: 'b', reporterSubject: 's_one' }));
        s.insertReport(report({ id: 'c', reporterSubject: 's_one' }));
        s.insertReport(report({ id: 'd', reporterSubject: 's_one' }));
        s.insertReport(report({ id: 'e', reporterSubject: 's_two' }));
        close(s, 'b', 'actioned', false);
        close(s, 'c', 'dismissed', false);
        close(s, 'd', 'dismissed', true);
        expect(s.reporterTally(['s_one'])).toEqual({ open: 1, actioned: 1, dismissed: 2, badFaith: 1 });
        expect(s.reporterTally(['s_two'])).toEqual({ open: 1, actioned: 0, dismissed: 0, badFaith: 0 });
      });

      it('sums over several stored ids (a person and their aliases)', () => {
        const s = make();
        s.insertReport(report({ id: 'a', reporterSubject: 's_one' }));
        s.insertReport(report({ id: 'b', reporterSubject: 's_alias' }));
        s.insertReport(report({ id: 'c', reporterSubject: 's_other' }));
        close(s, 'b', 'dismissed', true);
        expect(s.reporterTally(['s_one', 's_alias'])).toEqual({ open: 1, actioned: 0, dismissed: 1, badFaith: 1 });
      });

      it('an empty list, an unknown person and an empty store are all zeros', () => {
        const s = make();
        const zero = { open: 0, actioned: 0, dismissed: 0, badFaith: 0 };
        expect(s.reporterTally([])).toEqual(zero);
        expect(s.reporterTally(['nobody'])).toEqual(zero);
        s.insertReport(report({ id: 'a', reporterSubject: 's_one' }));
        expect(s.reporterTally([])).toEqual(zero);
        expect(s.reporterTally(['nobody'])).toEqual(zero);
      });

      it('counts reports filed AGAINST a person as nothing for that person (control)', () => {
        const s = make();
        s.insertReport(report({ id: 'a', reporterSubject: 's_one', targetSubject: 's_victim' }));
        expect(s.reporterTally(['s_victim'])).toEqual({ open: 0, actioned: 0, dismissed: 0, badFaith: 0 });
      });
    });
  });
}
