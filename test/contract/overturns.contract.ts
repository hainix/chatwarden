import { describe, expect, it } from 'vitest';
import type { OverturnInput, SanctionRow, Store, StoredReport, StrikeRow } from '@chatwarden/core';

// The contract of the optional overturn methods of the Store (0.2.1, appeals landing): `recordOverturn`, `latestAutoChatStart`, `overturnedTermCounts`,
// `overturnedFilterCounts` and `purgeOverturns`, plus the three reads they change (`loadStrikes`, `loadAutoChatStarts`, `reporterOutcomes`). One suite, run
// against every Store that has the methods; a store without them (a custom one) skips it, as a kit without overturn recording never calls them.
// SqliteStore is the reference.

type Overturns = Required<Pick<Store, 'recordOverturn' | 'latestAutoChatStart' | 'overturnedTermCounts' | 'overturnedFilterCounts' | 'purgeOverturns'>>;
const METHODS: Array<keyof Overturns> = ['recordOverturn', 'latestAutoChatStart', 'overturnedTermCounts', 'overturnedFilterCounts', 'purgeOverturns'];

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

let seq = 0;
const sanction = (over: Partial<SanctionRow> = {}): SanctionRow => {
  seq += 1;
  return {
    id: `ov-sr${seq}`,
    groupId: `ov-g${seq}`,
    refCode: `M-OV${String(seq).padStart(3, '0')}`,
    kind: 'chat',
    targetType: 'subject',
    value: 's_a',
    startsAt: NOW,
    endsAt: NOW + H,
    reason: 'private reason',
    rule: '2',
    gapNote: null,
    gapStatus: null,
    roomId: null,
    actor: 'chat_filter',
    source: 'auto_filter',
    automated: true,
    pending: false,
    ...over,
  };
};
const strike = (id: string, at: number, subject = 's_a', termId = 'term1'): StrikeRow => ({ id, at, subject, roomId: 'ROOM1', termId, rawLine: 'a line the subject typed' });

const report = (id: string, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: NOW,
  roomId: `ROOM-${id}`,
  tags: {},
  reporterSubject: 's_rep',
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: 's_a',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  note: null,
  lineId: null,
  excerpt: [],
  people: ['s_a'],
  status: 'open',
  ...over,
});

const input = (over: Partial<OverturnInput> = {}): OverturnInput => ({
  groupId: 'g1',
  at: NOW + DAY,
  subject: 's_a',
  aliases: ['s_a'],
  source: 'auto_filter',
  termId: 'term1',
  filterKey: null,
  reportId: null,
  strikes: { from: NOW - DAY, to: NOW },
  ...over,
});

export function overturnsContract(name: string, make: () => Store): void {
  // An optional method set: a store that does not have it has nothing to hold to.
  const has = make().recordOverturn !== undefined;
  const maybe = has ? describe : describe.skip;
  maybe(`overturns contract: ${name}${has ? '' : ' (no overturn methods)'}`, () => {
    const store = (): Overturns & Store => {
      const s = make();
      for (const m of METHODS) if (typeof s[m] !== 'function') throw new Error(`this store has no ${m}`);
      return s as Overturns & Store;
    };
    const subjectRow = (s: Store, groupId: string): SanctionRow | null => s.loadSanctionSubjectRow?.(groupId) ?? null;
    /** A decided report of one reporter, in its own room; returns the id. */
    const decided = (s: Store, id: string, how: 'actioned' | 'dismissed' = 'actioned', over: Partial<StoredReport> = {}): string => {
      s.insertReport(report(id, over));
      s.closeReport(id, how, false, 'mod', NOW + 1, 'n');
      return id;
    };
    const outcome = (s: Store, reporter = 's_rep') => s.reporterOutcomes?.([reporter], 0)[0];

    it('has the five methods', () => {
      const s = make();
      for (const m of METHODS) expect(typeof s[m], m).toBe('function');
    });

    describe('recordOverturn', () => {
      it('writes the overturn row, marks the group, the report and the strikes in the window, and returns true', () => {
        const s = store();
        s.insertSanctionGroup([sanction({ groupId: 'g1', refCode: 'M-AAAAA' }), sanction({ groupId: 'g1', refCode: 'M-AAAAA', targetType: 'ip', value: 'iphash-1' })]);
        decided(s, 'r1', 'actioned');
        s.insertStrike(strike('k1', NOW - 10));
        expect(subjectRow(s, 'g1')?.overturnedAt).toBeUndefined();
        expect(s.recordOverturn(input({ reportId: 'r1' }))).toBe(true);
        expect(subjectRow(s, 'g1')?.overturnedAt).toBe(NOW + DAY);
        expect(s.loadStrikes(0)).toEqual([]);
        expect(outcome(s)).toEqual({ reporter: 's_rep', actioned: 0, noAction: 0, badFaith: 0, overturned: 1 });
        expect(s.overturnedTermCounts(0)).toEqual([{ termId: 'term1', overturned: 1, lastAt: NOW + DAY }]);
      });

      it('a second recordOverturn for the same group returns false and changes nothing (the report keeps its first overturn)', () => {
        const s = store();
        s.insertSanctionGroup([sanction({ groupId: 'g1', refCode: 'M-AAAAA' })]);
        decided(s, 'r1');
        s.insertStrike(strike('k1', NOW - 10));
        expect(s.recordOverturn(input({ reportId: 'r1', termId: 'term1', strikes: null }))).toBe(true);
        const token = s.changeToken();
        // Different values on the second call: none of them may land.
        expect(s.recordOverturn(input({ at: NOW + 2 * DAY, termId: 'term2', filterKey: 'fk', reportId: 'r1' }))).toBe(false);
        expect(s.changeToken()).toBe(token);
        expect(subjectRow(s, 'g1')?.overturnedAt).toBe(NOW + DAY);
        expect(s.overturnedTermCounts(0)).toEqual([{ termId: 'term1', overturned: 1, lastAt: NOW + DAY }]);
        expect(s.overturnedFilterCounts(0)).toEqual([]);
        // The second call asked for the strikes window and none was marked by it: the strike is still there.
        expect(s.loadStrikes(0).map((r) => r.id)).toEqual(['k1']);
        expect(outcome(s)).toEqual({ reporter: 's_rep', actioned: 0, noAction: 0, badFaith: 0, overturned: 1 });
      });

      it('only strikes of the given aliases inside [from, to] are marked; a strike a ms outside either end and a strike of another person are not', () => {
        const s = store();
        s.insertStrike(strike('below', NOW - DAY - 1));
        s.insertStrike(strike('from', NOW - DAY));
        s.insertStrike(strike('mid', NOW - 5));
        s.insertStrike(strike('alias', NOW - 4, 's_a2'));
        s.insertStrike(strike('to', NOW));
        s.insertStrike(strike('above', NOW + 1));
        s.insertStrike(strike('other', NOW - 3, 's_other'));
        expect(s.recordOverturn(input({ aliases: ['s_a', 's_a2'] }))).toBe(true);
        expect(s.loadStrikes(0).map((r) => r.id)).toEqual(['below', 'other', 'above']);
      });

      it('strikes: null marks no strike; reportId: null marks no report', () => {
        const s = store();
        s.insertStrike(strike('k1', NOW - 10));
        decided(s, 'r1');
        expect(s.recordOverturn(input({ strikes: null, reportId: null }))).toBe(true);
        expect(s.loadStrikes(0).map((r) => r.id)).toEqual(['k1']);
        expect(outcome(s)).toEqual({ reporter: 's_rep', actioned: 1, noAction: 0, badFaith: 0, overturned: 0 });
      });

      it('a report already marked keeps its first overturn when another group names it', () => {
        const s = store();
        decided(s, 'r1');
        expect(s.recordOverturn(input({ groupId: 'g1', reportId: 'r1', strikes: null }))).toBe(true);
        expect(s.recordOverturn(input({ groupId: 'g2', at: NOW + 2 * DAY, reportId: 'r1', strikes: null }))).toBe(true);
        expect(outcome(s)).toEqual({ reporter: 's_rep', actioned: 0, noAction: 0, badFaith: 0, overturned: 1 });
      });

      it('an unknown group or report is not an error: the row is written, nothing else changes', () => {
        const s = store();
        expect(s.recordOverturn(input({ groupId: 'nowhere', reportId: 'no-such-report' }))).toBe(true);
        expect(s.overturnedTermCounts(0)).toHaveLength(1);
      });

      it('moves the change token, and an undone transaction moves it back and records nothing', () => {
        const s = store();
        const before = s.changeToken();
        expect(s.recordOverturn(input())).toBe(true);
        expect(s.changeToken()).not.toBe(before);
        const s2 = store();
        const t2 = s2.changeToken();
        expect(() =>
          s2.transaction(() => {
            expect(s2.recordOverturn(input())).toBe(true);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s2.changeToken()).toBe(t2);
        expect(s2.overturnedTermCounts(0)).toEqual([]);
        // and the group can be overturned again afterwards
        expect(s2.recordOverturn(input())).toBe(true);
      });
    });

    describe('the reads it changes', () => {
      it('loadStrikes leaves out overturned strikes; listStrikes and countStrikesByTerm still show them', () => {
        const s = store();
        s.insertStrike(strike('k1', NOW - 10, 's_a', 'termA'));
        s.insertStrike(strike('k2', NOW - 9, 's_a', 'termA'));
        s.insertStrike(strike('k3', NOW + 5, 's_a', 'termB'));
        s.recordOverturn(input());
        expect(s.loadStrikes(0).map((r) => r.id)).toEqual(['k3']);
        expect(s.listStrikes(0, 10).map((r) => r.id).sort()).toEqual(['k1', 'k2', 'k3']);
        expect(s.countStrikesByTerm(0)).toEqual([
          { termId: 'termA', count: 2 },
          { termId: 'termB', count: 1 },
        ]);
      });

      it('loadAutoChatStarts leaves out an overturned group; latestAutoChatStart returns the latest start that is not overturned, over the aliases given, and null for none or for an empty list', () => {
        const s = store();
        s.insertSanctionGroup([sanction({ groupId: 'g1', refCode: 'M-AAAAA', startsAt: NOW })]);
        s.insertSanctionGroup([sanction({ groupId: 'g2', refCode: 'M-BBBBB', startsAt: NOW + 10 * DAY })]);
        s.insertSanctionGroup([sanction({ groupId: 'g3', refCode: 'M-CCCCC', startsAt: NOW + 5 * DAY, value: 's_a2' })]);
        s.insertSanctionGroup([sanction({ groupId: 'g4', refCode: 'M-DDDDD', startsAt: NOW + 20 * DAY, value: 's_other' })]);
        expect(s.latestAutoChatStart(['s_a', 's_a2'])).toBe(NOW + 10 * DAY);
        expect(s.latestAutoChatStart(['s_a'])).toBe(NOW + 10 * DAY);
        expect(s.latestAutoChatStart(['s_a2'])).toBe(NOW + 5 * DAY);
        s.recordOverturn(input({ groupId: 'g2', strikes: null }));
        expect(s.latestAutoChatStart(['s_a', 's_a2'])).toBe(NOW + 5 * DAY);
        expect(s.latestAutoChatStart(['s_a'])).toBe(NOW);
        expect(s.loadAutoChatStarts().find((r) => r.subject === 's_a')).toEqual({ subject: 's_a', startsAt: NOW });
        s.recordOverturn(input({ groupId: 'g1', strikes: null }));
        expect(s.latestAutoChatStart(['s_a'])).toBeNull();
        expect(s.loadAutoChatStarts().map((r) => r.subject).sort()).toEqual(['s_a2', 's_other']);
        expect(s.latestAutoChatStart([])).toBeNull();
        expect(s.latestAutoChatStart(['s_nobody'])).toBeNull();
      });

      it('latestAutoChatStart counts revoked and ended rows, and ignores other kinds, sources and the address rows', () => {
        const s = store();
        s.insertSanctionGroup([sanction({ groupId: 'g1', refCode: 'M-AAAAA', startsAt: NOW, endsAt: NOW + 1 })]);
        s.insertSanctionGroup([sanction({ groupId: 'g2', refCode: 'M-BBBBB', startsAt: NOW + 3 * DAY })]);
        s.revokeSanctionGroup('g2', 'mod', NOW + 4 * DAY, 'undo');
        s.insertSanctionGroup([sanction({ groupId: 'g3', refCode: 'M-CCCCC', startsAt: NOW + 9 * DAY, source: 'moderator' })]);
        s.insertSanctionGroup([sanction({ groupId: 'g4', refCode: 'M-DDDDD', startsAt: NOW + 9 * DAY, kind: 'ban', endsAt: null })]);
        s.insertSanctionGroup([sanction({ groupId: 'g5', refCode: 'M-EEEEE', startsAt: NOW + 9 * DAY, targetType: 'ip', value: 's_a' })]);
        expect(s.latestAutoChatStart(['s_a'])).toBe(NOW + 3 * DAY);
      });

      it('latestAutoChatStart reads a long list of subjects and agrees with a short one', () => {
        const s = store();
        s.insertSanctionGroup([sanction({ groupId: 'g1', refCode: 'M-AAAAA', startsAt: NOW })]);
        const many = Array.from({ length: 1200 }, (_, i) => `s_none${i}`);
        expect(s.latestAutoChatStart([...many, 's_a'])).toBe(NOW);
        expect(s.latestAutoChatStart(many)).toBeNull();
      });
    });

    describe('the counts', () => {
      it('overturnedTermCounts groups by term, counts groups not strikes, honours since (a row at exactly since counts), ignores rows with no term', () => {
        const s = store();
        s.recordOverturn(input({ groupId: 'a1', at: NOW, termId: 'tB', strikes: null }));
        s.recordOverturn(input({ groupId: 'a2', at: NOW + 10, termId: 'tB', strikes: null }));
        s.recordOverturn(input({ groupId: 'a3', at: NOW + 5, termId: 'tA', strikes: null }));
        s.recordOverturn(input({ groupId: 'a4', at: NOW + 6, termId: null, filterKey: 'fk', strikes: null }));
        s.recordOverturn(input({ groupId: 'a5', at: NOW - 1, termId: 'tC', strikes: null }));
        // Three strikes on one group count once.
        s.insertStrike(strike('k1', NOW - 3, 's_a', 'tB'));
        s.insertStrike(strike('k2', NOW - 2, 's_a', 'tB'));
        expect(s.overturnedTermCounts(NOW)).toEqual([
          { termId: 'tA', overturned: 1, lastAt: NOW + 5 },
          { termId: 'tB', overturned: 2, lastAt: NOW + 10 },
        ]);
        expect(s.overturnedTermCounts(NOW + 1).map((r) => r.termId)).toEqual(['tA', 'tB']);
        expect(s.overturnedTermCounts(NOW + 6)).toEqual([{ termId: 'tB', overturned: 1, lastAt: NOW + 10 }]);
        expect(s.overturnedTermCounts(NOW + 11)).toEqual([]);
        expect(s.overturnedTermCounts(NOW - 1).map((r) => r.termId)).toEqual(['tA', 'tB', 'tC']);
      });

      it('overturnedFilterCounts groups by filter key the same way', () => {
        const s = store();
        s.recordOverturn(input({ groupId: 'a1', at: NOW, termId: null, filterKey: 'link.unlisted', source: 'moderator', strikes: null }));
        s.recordOverturn(input({ groupId: 'a2', at: NOW + 10, termId: null, filterKey: 'link.unlisted', source: 'moderator', strikes: null }));
        s.recordOverturn(input({ groupId: 'a3', at: NOW + 5, termId: null, filterKey: 'caps.shout', source: 'moderator', strikes: null }));
        s.recordOverturn(input({ groupId: 'a4', at: NOW + 6, termId: 'tX', filterKey: null, strikes: null }));
        s.recordOverturn(input({ groupId: 'a5', at: NOW - 1, termId: null, filterKey: 'old.key', source: 'moderator', strikes: null }));
        expect(s.overturnedFilterCounts(NOW)).toEqual([
          { filterKey: 'caps.shout', overturned: 1 },
          { filterKey: 'link.unlisted', overturned: 2 },
        ]);
        expect(s.overturnedFilterCounts(NOW + 1)).toEqual([
          { filterKey: 'caps.shout', overturned: 1 },
          { filterKey: 'link.unlisted', overturned: 1 },
        ]);
        expect(s.overturnedFilterCounts(NOW + 11)).toEqual([]);
        expect(s.overturnedFilterCounts(0).map((r) => r.filterKey)).toEqual(['caps.shout', 'link.unlisted', 'old.key']);
      });

      it('an empty store counts nothing', () => {
        const s = store();
        expect(s.overturnedTermCounts(0)).toEqual([]);
        expect(s.overturnedFilterCounts(0)).toEqual([]);
      });
    });

    describe('purgeOverturns', () => {
      it('deletes rows with at < before (strict) and returns the count', () => {
        const s = store();
        s.recordOverturn(input({ groupId: 'p1', at: NOW - 1, strikes: null }));
        s.recordOverturn(input({ groupId: 'p2', at: NOW, strikes: null }));
        s.recordOverturn(input({ groupId: 'p3', at: NOW + 1, strikes: null }));
        expect(s.purgeOverturns(NOW)).toBe(1);
        expect(s.overturnedTermCounts(0)).toEqual([{ termId: 'term1', overturned: 2, lastAt: NOW + 1 }]);
        expect(s.purgeOverturns(NOW)).toBe(0);
        expect(s.purgeOverturns(NOW + 100)).toBe(2);
        expect(s.overturnedTermCounts(0)).toEqual([]);
      });

      it('moves the change token only when it deleted something', () => {
        const s = store();
        s.recordOverturn(input({ groupId: 'p1', at: NOW, strikes: null }));
        const t = s.changeToken();
        expect(s.purgeOverturns(NOW)).toBe(0);
        expect(s.changeToken()).toBe(t);
        expect(s.purgeOverturns(NOW + 1)).toBe(1);
        expect(s.changeToken()).not.toBe(t);
      });

      it('a purged group can be overturned again (the row is gone)', () => {
        const s = store();
        s.recordOverturn(input({ groupId: 'p1', at: NOW, strikes: null }));
        s.purgeOverturns(NOW + 1);
        expect(s.recordOverturn(input({ groupId: 'p1', at: NOW + 5, strikes: null }))).toBe(true);
      });
    });

    describe('reporterOutcomes with overturned reports', () => {
      it('an actioned report with an overturn counts in overturned and not in actioned; dismissed is unaffected; a welfare report is still left out', () => {
        const s = store();
        decided(s, 'ro1', 'actioned');
        decided(s, 'ro2', 'actioned');
        decided(s, 'ro3', 'dismissed');
        decided(s, 'ro4', 'actioned', { reportedReason: 'welfare' });
        s.recordOverturn(input({ groupId: 'gx1', reportId: 'ro1', strikes: null }));
        s.recordOverturn(input({ groupId: 'gx4', reportId: 'ro4', strikes: null }));
        expect(outcome(s)).toEqual({ reporter: 's_rep', actioned: 1, noAction: 1, badFaith: 0, overturned: 1 });
      });

      it('a reporter with no overturned report reads overturned 0 (control)', () => {
        const s = store();
        decided(s, 'ro1', 'actioned');
        expect(outcome(s)).toEqual({ reporter: 's_rep', actioned: 1, noAction: 0, badFaith: 0, overturned: 0 });
      });
    });
  });
}
