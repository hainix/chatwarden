import { describe, expect, it } from 'vitest';
import type { AppealRow, SanctionRow, Store } from '@chatwarden/core';

// The contract of the optional appeal methods of the Store (appeals inbox, design 4.7): the appeal rows (insert, load, list, count, decide,
// moot), the counts by rule the false-positive rate reads, the sanction row an appeal is decided against, and the two purges. One suite,
// run against every Store that has the methods; a store without them (a custom one, or SqliteStore before migration 22) skips it, as
// an appeals-off kit never calls them. SqliteStore is the reference.

type Appeals = Required<
  Pick<
    Store,
    | 'insertAppeal'
    | 'loadAppeal'
    | 'listAppeals'
    | 'countAppealsBy'
    | 'countOpenAppeals'
    | 'decideAppeal'
    | 'closeAppealsForGroup'
    | 'appealCountsByRule'
    | 'countSanctionsByRule'
    | 'loadSanctionSubjectRow'
    | 'clearAppealStatements'
    | 'purgeAppeals'
    | 'closeOrphanAppeals'
    | 'listAppealsBy'
  >
>;
const METHODS: Array<keyof Appeals> = [
  'insertAppeal',
  'loadAppeal',
  'listAppeals',
  'countAppealsBy',
  'countOpenAppeals',
  'decideAppeal',
  'closeAppealsForGroup',
  'appealCountsByRule',
  'countSanctionsByRule',
  'loadSanctionSubjectRow',
  'clearAppealStatements',
  'purgeAppeals',
  'closeOrphanAppeals',
  'listAppealsBy',
];

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

let seq = 0;
const appeal = (over: Partial<AppealRow> = {}): AppealRow => {
  seq += 1;
  return {
    id: `ap${String(seq).padStart(3, '0')}`,
    subject: 's_a',
    groupId: `g${seq}`,
    noticeId: `n${seq}`,
    reportId: null,
    rule: '2',
    kind: 'chat',
    statement: `statement ${seq}`,
    status: 'open',
    createdAt: NOW + seq,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    replacementGroupId: null,
    ...over,
  };
};

const sanction = (over: Partial<SanctionRow> = {}): SanctionRow => {
  seq += 1;
  return {
    id: `sr${seq}`,
    groupId: `sg${seq}`,
    refCode: `M-${String(seq).padStart(5, '0')}`,
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
    actor: 'mod_ann',
    source: 'moderator',
    automated: false,
    pending: false,
    ...over,
  };
};

/** A group as the kit writes it: a subject row, plus an IP row. */
const subjectAndIp = (groupId: string, refCode: string, over: Partial<SanctionRow> = {}): SanctionRow[] => [
  sanction({ groupId, refCode, ...over }),
  sanction({ groupId, refCode, ...over, targetType: 'ip', value: `iphash-${groupId}` }),
];

const decide = (over: Partial<Parameters<Appeals['decideAppeal']>[1]> = {}): Parameters<Appeals['decideAppeal']>[1] => ({
  status: 'upheld',
  at: NOW + DAY,
  by: 'senior_bea',
  reason: 'the rule applied',
  replacementGroupId: null,
  ...over,
});

const ruleOrder = (a: { rule: string | null }, b: { rule: string | null }): number =>
  a.rule === null ? (b.rule === null ? 0 : 1) : b.rule === null ? -1 : a.rule.localeCompare(b.rule, 'en', { numeric: true });

export function appealsContract(name: string, make: () => Store): void {
  // An optional method set: a store that does not have it has nothing to hold to.
  const has = make().insertAppeal !== undefined;
  const maybe = has ? describe : describe.skip;
  maybe(`appeals contract: ${name}${has ? '' : ' (no appeal methods)'}`, () => {
    const store = (): Appeals & Store => {
      const s = make();
      for (const m of METHODS) if (typeof s[m] !== 'function') throw new Error(`this store has no ${m}`);
      return s as Appeals & Store;
    };

    it('has the fourteen methods', () => {
      const s = make();
      for (const m of METHODS) expect(typeof s[m], m).toBe('function');
    });

    describe('insertAppeal and loadAppeal', () => {
      it('round-trips every field of a row exactly, as a copy', () => {
        const s = store();
        const row = appeal({ reportId: 'rep_1', rule: 'uncovered', kind: 'ban', statement: 'It was not me. 💬', replacementGroupId: null });
        expect(s.insertAppeal(row)).toBe(true);
        const got = s.loadAppeal(row.id);
        expect(got).toEqual(row);
        expect(got).not.toBe(row);
        (got as AppealRow).statement = 'changed';
        expect(s.loadAppeal(row.id)?.statement).toBe('It was not me. 💬');
      });

      it('a null statement, rule and report id round-trip as null', () => {
        const s = store();
        const row = appeal({ statement: null, rule: null, reportId: null });
        s.insertAppeal(row);
        expect(s.loadAppeal(row.id)).toEqual(row);
      });

      it('insertAppeal is exclusive per group and returns false for a second', () => {
        const s = store();
        const first = appeal({ groupId: 'g-same' });
        expect(s.insertAppeal(first)).toBe(true);
        expect(s.insertAppeal(appeal({ groupId: 'g-same' }))).toBe(false);
        // even once the first is decided or moot (one appeal per sanction for its lifetime)
        s.decideAppeal(first.id, decide());
        expect(s.insertAppeal(appeal({ groupId: 'g-same' }))).toBe(false);
        expect(s.closeAppealsForGroup('g-same', 'x', NOW)).toBe(0);
        expect(s.listAppeals({ status: 'all', limit: 50 })).toHaveLength(1);
        // a different group is a new appeal (control)
        expect(s.insertAppeal(appeal({ groupId: 'g-other' }))).toBe(true);
      });

      it('a second appeal under an id already in use writes nothing and does not throw', () => {
        const s = store();
        const first = appeal({ groupId: 'g1x' });
        s.insertAppeal(first);
        expect(s.insertAppeal({ ...appeal({ groupId: 'g2x' }), id: first.id })).toBe(false);
        expect(s.loadAppeal(first.id)?.groupId).toBe('g1x');
        expect(s.listAppeals({ status: 'all', limit: 50 })).toHaveLength(1);
      });

      it('loadAppeal is null for an unknown id', () => {
        const s = store();
        expect(s.loadAppeal('nope')).toBeNull();
        expect(s.loadAppeal('')).toBeNull();
      });
    });

    describe('listAppeals', () => {
      it('lists by status (open, decided, all), oldest first', () => {
        const s = store();
        const a = appeal({ createdAt: NOW + 30 });
        const b = appeal({ createdAt: NOW + 10 });
        const c = appeal({ createdAt: NOW + 20 });
        const d = appeal({ createdAt: NOW + 40 });
        for (const r of [a, b, c, d]) s.insertAppeal(r);
        s.decideAppeal(c.id, decide({ status: 'revoked' }));
        s.decideAppeal(d.id, decide({ status: 'reduced', replacementGroupId: 'g-new' }));
        expect(s.listAppeals({ status: 'open', limit: 10 }).map((r) => r.id)).toEqual([b.id, a.id]);
        expect(s.listAppeals({ status: 'decided', limit: 10 }).map((r) => r.id)).toEqual([c.id, d.id]);
        expect(s.listAppeals({ status: 'all', limit: 10 }).map((r) => r.id)).toEqual([b.id, c.id, a.id, d.id]);
        // no status means all
        expect(s.listAppeals({ limit: 10 }).map((r) => r.id)).toEqual([b.id, c.id, a.id, d.id]);
      });

      it('never lists a moot appeal (nobody ruled on it); loadAppeal still finds it', () => {
        const s = store();
        const a = appeal({ groupId: 'g-moot' });
        const b = appeal({ groupId: 'g-live' });
        s.insertAppeal(a);
        s.insertAppeal(b);
        expect(s.closeAppealsForGroup('g-moot', 'mod_ann', NOW + 5)).toBe(1);
        for (const status of ['open', 'decided', 'all'] as const) {
          expect(s.listAppeals({ status, limit: 10 }).map((r) => r.id), status).not.toContain(a.id);
        }
        expect(s.loadAppeal(a.id)?.status).toBe('moot');
      });

      it('a tie on createdAt is broken by id, and the cursor (createdAt, id) pages without a gap or a repeat', () => {
        const s = store();
        const rows = [appeal({ id: 'b', createdAt: NOW }), appeal({ id: 'a', createdAt: NOW }), appeal({ id: 'c', createdAt: NOW }), appeal({ id: 'd', createdAt: NOW + 1 }), appeal({ id: 'e', createdAt: NOW - 1 })];
        for (const r of rows) s.insertAppeal(r);
        const all = s.listAppeals({ status: 'all', limit: 10 }).map((r) => r.id);
        expect(all).toEqual(['e', 'a', 'b', 'c', 'd']);
        const seen: string[] = [];
        let after: { createdAt: number; id: string } | undefined;
        for (let i = 0; i < 10; i += 1) {
          const page = s.listAppeals({ status: 'all', limit: 2, ...(after === undefined ? {} : { after }) });
          if (page.length === 0) break;
          seen.push(...page.map((r) => r.id));
          const last = page[page.length - 1] as AppealRow;
          after = { createdAt: last.createdAt, id: last.id };
        }
        expect(seen).toEqual(all);
        // the cursor is exclusive: the row it names is not repeated
        expect(s.listAppeals({ status: 'all', limit: 10, after: { createdAt: NOW, id: 'a' } }).map((r) => r.id)).toEqual(['b', 'c', 'd']);
      });

      it('limit is honoured, floored, clamped to 1..200', () => {
        const s = store();
        for (let i = 0; i < 5; i += 1) s.insertAppeal(appeal());
        expect(s.listAppeals({ status: 'all', limit: 3 })).toHaveLength(3);
        expect(s.listAppeals({ status: 'all', limit: 2.9 })).toHaveLength(2);
        expect(s.listAppeals({ status: 'all', limit: 0 })).toHaveLength(1);
        expect(s.listAppeals({ status: 'all', limit: -5 })).toHaveLength(1);
        expect(s.listAppeals({ status: 'all', limit: 100000 })).toHaveLength(5);
      });

      it('an empty store lists nothing and returns copies', () => {
        const s = store();
        expect(s.listAppeals({ status: 'all', limit: 10 })).toEqual([]);
        const row = appeal();
        s.insertAppeal(row);
        const [got] = s.listAppeals({ status: 'all', limit: 10 });
        (got as AppealRow).statement = 'changed';
        expect(s.loadAppeal(row.id)?.statement).toBe(row.statement);
      });
    });

    describe('listAppealsBy', () => {
      it('lists these subjects\' appeals newest first (then by id descending), without moot ones, up to the limit', () => {
        const s = store();
        const a = appeal({ subject: 's_a', createdAt: NOW + 10 });
        const b = appeal({ subject: 's_alias', createdAt: NOW + 30 });
        const c = appeal({ subject: 's_a', createdAt: NOW + 20 });
        const other = appeal({ subject: 's_other', createdAt: NOW + 40 });
        const moot = appeal({ subject: 's_a', createdAt: NOW + 50, groupId: 'g-moot' });
        for (const r of [a, b, c, other, moot]) s.insertAppeal(r);
        s.closeAppealsForGroup('g-moot', 'x', NOW);
        s.decideAppeal(c.id, decide({ status: 'revoked' }));
        expect(s.listAppealsBy(['s_a', 's_alias'], 10).map((r) => r.id)).toEqual([b.id, c.id, a.id]);
        expect(s.listAppealsBy(['s_a', 's_alias', 's_a'], 2).map((r) => r.id)).toEqual([b.id, c.id]);
        expect(s.listAppealsBy(['s_other'], 10).map((r) => r.id)).toEqual([other.id]);
      });

      it('a tie on createdAt is broken by id, descending; limit is floored and clamped to 1..200; nothing for no subjects or an unknown one', () => {
        const s = store();
        const rows = ['a', 'c', 'b'].map((id) => appeal({ id, subject: 's_a', createdAt: NOW }));
        for (const r of rows) s.insertAppeal(r);
        expect(s.listAppealsBy(['s_a'], 10).map((r) => r.id)).toEqual(['c', 'b', 'a']);
        expect(s.listAppealsBy(['s_a'], 1.9)).toHaveLength(1);
        expect(s.listAppealsBy(['s_a'], 0)).toHaveLength(1);
        expect(s.listAppealsBy(['s_a'], 100000)).toHaveLength(3);
        expect(s.listAppealsBy([], 10)).toEqual([]);
        expect(s.listAppealsBy(['s_nobody'], 10)).toEqual([]);
      });

      it('answers across more subjects than one batch, newest first, and returns copies', () => {
        const s = store();
        const subjects = Array.from({ length: 1300 }, (_, i) => `s_${String(i).padStart(4, '0')}`);
        subjects.forEach((subject, i) => s.insertAppeal(appeal({ subject, createdAt: NOW + i })));
        const got = s.listAppealsBy(subjects, 3);
        expect(got.map((r) => r.subject)).toEqual(['s_1299', 's_1298', 's_1297']);
        (got[0] as AppealRow).statement = 'changed';
        expect(s.listAppealsBy(['s_1299'], 1)[0]?.statement).not.toBe('changed');
      });
    });

    describe('countAppealsBy and countOpenAppeals', () => {
      it('countAppealsBy counts across a person\'s aliases in the window and returns the oldest time', () => {
        const s = store();
        s.insertAppeal(appeal({ subject: 's_a', createdAt: NOW + 100 }));
        s.insertAppeal(appeal({ subject: 's_alias', createdAt: NOW + 50 }));
        s.insertAppeal(appeal({ subject: 's_other', createdAt: NOW + 10 }));
        s.insertAppeal(appeal({ subject: 's_a', createdAt: NOW - 8 * DAY }));
        expect(s.countAppealsBy(['s_a', 's_alias'], NOW)).toEqual({ count: 2, oldestAt: NOW + 50 });
        expect(s.countAppealsBy(['s_a'], NOW)).toEqual({ count: 1, oldestAt: NOW + 100 });
        expect(s.countAppealsBy(['s_a', 's_alias'], NOW - 9 * DAY).count).toBe(3);
      });

      it('none gives { count: 0, oldestAt: null }, for no subjects, an unknown one and a window past every row', () => {
        const s = store();
        s.insertAppeal(appeal({ subject: 's_a', createdAt: NOW }));
        expect(s.countAppealsBy([], 0)).toEqual({ count: 0, oldestAt: null });
        expect(s.countAppealsBy(['s_nobody'], 0)).toEqual({ count: 0, oldestAt: null });
        expect(s.countAppealsBy(['s_a'], NOW + 1)).toEqual({ count: 0, oldestAt: null });
      });

      it('since is inclusive, and a decided or moot appeal still counts against the cap', () => {
        const s = store();
        const a = appeal({ subject: 's_a', createdAt: NOW });
        const b = appeal({ subject: 's_a', createdAt: NOW + 1, groupId: 'g-b' });
        s.insertAppeal(a);
        s.insertAppeal(b);
        s.decideAppeal(a.id, decide({ status: 'revoked' }));
        s.closeAppealsForGroup('g-b', 'x', NOW + 5);
        expect(s.countAppealsBy(['s_a'], NOW)).toEqual({ count: 2, oldestAt: NOW });
        expect(s.countAppealsBy(['s_a'], NOW + 1)).toEqual({ count: 1, oldestAt: NOW + 1 });
      });

      it('countOpenAppeals counts only open ones, and moves with decide and moot', () => {
        const s = store();
        expect(s.countOpenAppeals()).toBe(0);
        const a = appeal({ groupId: 'g-a' });
        const b = appeal({ groupId: 'g-b' });
        const c = appeal({ groupId: 'g-c' });
        for (const r of [a, b, c]) s.insertAppeal(r);
        expect(s.countOpenAppeals()).toBe(3);
        s.decideAppeal(a.id, decide());
        expect(s.countOpenAppeals()).toBe(2);
        s.closeAppealsForGroup('g-b', 'x', NOW);
        expect(s.countOpenAppeals()).toBe(1);
      });
    });

    describe('decideAppeal', () => {
      it('from open succeeds once and sets the decision fields', () => {
        const s = store();
        const row = appeal();
        s.insertAppeal(row);
        expect(s.decideAppeal(row.id, decide({ status: 'reduced', replacementGroupId: 'g-new', reason: 'a day is enough' }))).toBe(true);
        expect(s.loadAppeal(row.id)).toEqual({ ...row, status: 'reduced', decidedAt: NOW + DAY, decidedBy: 'senior_bea', decisionReason: 'a day is enough', replacementGroupId: 'g-new' });
      });

      it('each of the three statuses is accepted from open', () => {
        for (const status of ['upheld', 'reduced', 'revoked'] as const) {
          const s = store();
          const row = appeal();
          s.insertAppeal(row);
          expect(s.decideAppeal(row.id, decide({ status })), status).toBe(true);
          expect(s.loadAppeal(row.id)?.status).toBe(status);
        }
      });

      it('from a decided or moot appeal returns false and changes nothing', () => {
        const s = store();
        const a = appeal({ groupId: 'g-a' });
        const b = appeal({ groupId: 'g-b' });
        s.insertAppeal(a);
        s.insertAppeal(b);
        expect(s.decideAppeal(a.id, decide({ status: 'upheld', reason: 'first' }))).toBe(true);
        const before = s.loadAppeal(a.id);
        expect(s.decideAppeal(a.id, decide({ status: 'revoked', reason: 'second', by: 'other', at: NOW + 9 * DAY }))).toBe(false);
        expect(s.loadAppeal(a.id)).toEqual(before);
        s.closeAppealsForGroup('g-b', 'mod_ann', NOW + 5);
        const moot = s.loadAppeal(b.id);
        expect(s.decideAppeal(b.id, decide({ status: 'revoked' }))).toBe(false);
        expect(s.loadAppeal(b.id)).toEqual(moot);
      });

      it('an unknown id returns false', () => {
        expect(store().decideAppeal('nope', decide())).toBe(false);
      });

      it('clearStatement nulls the text; without it the text stays', () => {
        const s = store();
        const keep = appeal();
        const clear = appeal();
        s.insertAppeal(keep);
        s.insertAppeal(clear);
        s.decideAppeal(keep.id, decide());
        s.decideAppeal(clear.id, decide({ clearStatement: true }));
        expect(s.loadAppeal(keep.id)?.statement).toBe(keep.statement);
        expect(s.loadAppeal(clear.id)?.statement).toBeNull();
        expect(s.loadAppeal(clear.id)?.status).toBe('upheld');
        // clearStatement: false is the same as leaving it out
        const off = appeal();
        s.insertAppeal(off);
        s.decideAppeal(off.id, decide({ clearStatement: false }));
        expect(s.loadAppeal(off.id)?.statement).toBe(off.statement);
      });
    });

    describe('closeAppealsForGroup', () => {
      it('moves open to moot and returns the count; decided appeals are untouched', () => {
        const s = store();
        const open = appeal({ groupId: 'g-open' });
        const done = appeal({ groupId: 'g-done' });
        s.insertAppeal(open);
        s.insertAppeal(done);
        s.decideAppeal(done.id, decide({ status: 'revoked' }));
        const decided = s.loadAppeal(done.id);
        expect(s.closeAppealsForGroup('g-open', 'mod_cy', NOW + 77)).toBe(1);
        expect(s.loadAppeal(open.id)).toEqual({ ...open, status: 'moot', decidedAt: NOW + 77, decidedBy: 'mod_cy' });
        expect(s.closeAppealsForGroup('g-done', 'mod_cy', NOW + 77)).toBe(0);
        expect(s.loadAppeal(done.id)).toEqual(decided);
      });

      it('clearStatement nulls the statement of the appeal it moots (retention at 0 clears at the close, like a decision); without it the text stays', () => {
        const s = store();
        const keep = appeal({ groupId: 'g-keep' });
        const clear = appeal({ groupId: 'g-clear' });
        s.insertAppeal(keep);
        s.insertAppeal(clear);
        expect(s.closeAppealsForGroup('g-keep', 'x', NOW)).toBe(1);
        expect(s.closeAppealsForGroup('g-clear', 'x', NOW, true)).toBe(1);
        expect(s.loadAppeal(keep.id)).toMatchObject({ status: 'moot', statement: keep.statement });
        expect(s.loadAppeal(clear.id)).toMatchObject({ status: 'moot', statement: null, decidedAt: NOW, decidedBy: 'x' });
        // a decided appeal is untouched even with the flag
        const done = appeal({ groupId: 'g-done' });
        s.insertAppeal(done);
        s.decideAppeal(done.id, decide());
        expect(s.closeAppealsForGroup('g-done', 'x', NOW, true)).toBe(0);
        expect(s.loadAppeal(done.id)?.statement).toBe(done.statement);
      });

      it('a second call, and a group with no appeal, return 0', () => {
        const s = store();
        s.insertAppeal(appeal({ groupId: 'g-open' }));
        expect(s.closeAppealsForGroup('g-open', 'x', NOW)).toBe(1);
        expect(s.closeAppealsForGroup('g-open', 'x', NOW + 1)).toBe(0);
        expect(s.closeAppealsForGroup('g-none', 'x', NOW)).toBe(0);
      });
    });

    describe('counts by rule', () => {
      it('countSanctionsByRule counts distinct subject sanction groups of kind warning, chat, area or ban, one per group', () => {
        const s = store();
        s.insertSanctionGroup(subjectAndIp('sg1', 'M-00001', { kind: 'chat', rule: '2' }));
        s.insertSanctionGroup(subjectAndIp('sg2', 'M-00002', { kind: 'ban', rule: '2', endsAt: null }));
        s.insertSanctionGroup(subjectAndIp('sg3', 'M-00003', { kind: 'warning', rule: '5', endsAt: null }));
        s.insertSanctionGroup([sanction({ groupId: 'sg4', refCode: 'M-00004', kind: 'area', rule: '5' })]);
        expect(s.countSanctionsByRule(0).sort(ruleOrder)).toEqual([
          { rule: '2', count: 2 },
          { rule: '5', count: 2 },
        ]);
      });

      it('notes and IP rows are not counted', () => {
        const s = store();
        s.insertSanctionGroup([sanction({ groupId: 'sg-note', refCode: 'M-10001', kind: 'note', rule: '1', endsAt: null })]);
        s.insertSanctionGroup([sanction({ groupId: 'sg-ip', refCode: 'M-10002', kind: 'chat', rule: '1', targetType: 'ip', value: 'iphash' })]);
        expect(s.countSanctionsByRule(0)).toEqual([]);
        s.insertSanctionGroup([sanction({ groupId: 'sg-real', refCode: 'M-10003', kind: 'chat', rule: '1' })]);
        expect(s.countSanctionsByRule(0)).toEqual([{ rule: '1', count: 1 }]);
      });

      it('a revoked group still counts (it was a decision), and a group with its IP row is one', () => {
        const s = store();
        s.insertSanctionGroup(subjectAndIp('sg-1', 'M-20001', { rule: '3' }));
        s.insertSanctionGroup([sanction({ groupId: 'sg-2', refCode: 'M-20002', rule: '3' })]);
        s.revokeSanctionGroup('sg-2', 'mod_ann', NOW, 'oops');
        expect(s.countSanctionsByRule(0)).toEqual([{ rule: '3', count: 2 }]);
      });

      it('replacement groups are not double counted: a reduction is one sanction, not two', () => {
        const s = store();
        s.insertSanctionGroup(subjectAndIp('sg-orig', 'M-30001', { kind: 'ban', rule: '4', endsAt: null }));
        s.insertSanctionGroup(subjectAndIp('sg-repl', 'M-30002', { kind: 'chat', rule: '4' }));
        s.insertSanctionGroup(subjectAndIp('sg-else', 'M-30003', { kind: 'chat', rule: '4' }));
        expect(s.countSanctionsByRule(0)).toEqual([{ rule: '4', count: 3 }]);
        const row = appeal({ groupId: 'sg-orig', rule: '4', kind: 'ban' });
        s.insertAppeal(row);
        s.decideAppeal(row.id, decide({ status: 'reduced', replacementGroupId: 'sg-repl' }));
        expect(s.countSanctionsByRule(0)).toEqual([{ rule: '4', count: 2 }]);
        // an appeal that names no replacement excludes nothing
        const other = appeal({ groupId: 'sg-else', rule: '4' });
        s.insertAppeal(other);
        s.decideAppeal(other.id, decide({ status: 'revoked', replacementGroupId: null }));
        expect(s.countSanctionsByRule(0)).toEqual([{ rule: '4', count: 2 }]);
      });

      it('uncovered and null rules group together, as a null rule', () => {
        const s = store();
        s.insertSanctionGroup([sanction({ groupId: 'sg-u', refCode: 'M-40001', rule: 'uncovered' })]);
        s.insertSanctionGroup([sanction({ groupId: 'sg-n', refCode: 'M-40002', rule: null })]);
        s.insertSanctionGroup([sanction({ groupId: 'sg-1', refCode: 'M-40003', rule: '1' })]);
        expect(s.countSanctionsByRule(0).sort(ruleOrder)).toEqual([
          { rule: '1', count: 1 },
          { rule: null, count: 2 },
        ]);
        s.insertAppeal(appeal({ rule: 'uncovered' }));
        s.insertAppeal(appeal({ rule: null }));
        expect(s.appealCountsByRule(0)).toEqual([{ rule: null, appealed: 2, granted: 0, lightened: 0 }]);
      });

      it('since is inclusive (a group starting exactly on the line counts, one before does not)', () => {
        const s = store();
        s.insertSanctionGroup([sanction({ groupId: 'sg-edge', refCode: 'M-50001', rule: '1', startsAt: NOW })]);
        s.insertSanctionGroup([sanction({ groupId: 'sg-old', refCode: 'M-50002', rule: '1', startsAt: NOW - 1 })]);
        expect(s.countSanctionsByRule(NOW)).toEqual([{ rule: '1', count: 1 }]);
        expect(s.countSanctionsByRule(NOW + 1)).toEqual([]);
        expect(s.countSanctionsByRule(NOW - 1)).toEqual([{ rule: '1', count: 2 }]);
        const a = appeal({ rule: '1', createdAt: NOW });
        const b = appeal({ rule: '1', createdAt: NOW - 1 });
        s.insertAppeal(a);
        s.insertAppeal(b);
        expect(s.appealCountsByRule(NOW)).toEqual([{ rule: '1', appealed: 1, granted: 0, lightened: 0 }]);
        expect(s.appealCountsByRule(NOW + 1)).toEqual([]);
        expect(s.appealCountsByRule(NOW - 1)).toEqual([{ rule: '1', appealed: 2, granted: 0, lightened: 0 }]);
      });

      it('appealCountsByRule counts appealed, granted (revoked only) and lightened (reduced): a reduction is not a false positive', () => {
        const s = store();
        const rows = [
          appeal({ rule: '2' }),
          appeal({ rule: '2' }),
          appeal({ rule: '2' }),
          appeal({ rule: '2' }),
          appeal({ rule: '2', groupId: 'g-moot' }),
          appeal({ rule: '7' }),
        ];
        for (const r of rows) s.insertAppeal(r);
        s.decideAppeal((rows[0] as AppealRow).id, decide({ status: 'revoked' }));
        s.decideAppeal((rows[1] as AppealRow).id, decide({ status: 'reduced', replacementGroupId: 'g-r' }));
        s.decideAppeal((rows[2] as AppealRow).id, decide({ status: 'upheld' }));
        // rows[3] stays open; rows[4] is closed as moot (nobody ruled)
        s.closeAppealsForGroup('g-moot', 'x', NOW);
        s.decideAppeal((rows[5] as AppealRow).id, decide({ status: 'revoked' }));
        expect(s.appealCountsByRule(0).sort(ruleOrder)).toEqual([
          { rule: '2', appealed: 5, granted: 1, lightened: 1 },
          { rule: '7', appealed: 1, granted: 1, lightened: 0 },
        ]);
      });

      it('both counts are empty for an empty store', () => {
        const s = store();
        expect(s.countSanctionsByRule(0)).toEqual([]);
        expect(s.appealCountsByRule(0)).toEqual([]);
      });
    });

    describe('closeOrphanAppeals', () => {
      it('moots an open appeal whose sanction rows are gone (retention removed them), counts it, and moves the open count', () => {
        const s = store();
        s.insertSanctionGroup(subjectAndIp('sg-live', 'M-90001'));
        const live = appeal({ groupId: 'sg-live' });
        const orphan = appeal({ groupId: 'sg-gone' });
        const decided = appeal({ groupId: 'sg-gone-decided' });
        for (const r of [live, orphan, decided]) s.insertAppeal(r);
        s.decideAppeal(decided.id, decide());
        expect(s.countOpenAppeals()).toBe(2);
        const token = s.changeToken();
        expect(s.closeOrphanAppeals('retention', NOW + 5)).toBe(1);
        expect(s.loadAppeal(orphan.id)).toMatchObject({ status: 'moot', decidedAt: NOW + 5, decidedBy: 'retention', statement: orphan.statement });
        expect(s.loadAppeal(live.id)?.status).toBe('open');
        expect(s.loadAppeal(decided.id)?.status).toBe('upheld');
        expect(s.countOpenAppeals()).toBe(1);
        expect(s.changeToken()).not.toBe(token);
        // nothing left to close: no write, no token move
        const after = s.changeToken();
        expect(s.closeOrphanAppeals('retention', NOW + 6)).toBe(0);
        expect(s.changeToken()).toBe(after);
      });

      it('an appeal whose sanction is only revoked is not an orphan (the row is still there); one whose group has only an IP row is', () => {
        const s = store();
        s.insertSanctionGroup(subjectAndIp('sg-rev', 'M-90002'));
        s.revokeSanctionGroup('sg-rev', 'mod_ann', NOW, 'lifted');
        s.insertSanctionGroup([sanction({ groupId: 'sg-ip', refCode: 'M-90003', targetType: 'ip', value: 'iphash' })]);
        const rev = appeal({ groupId: 'sg-rev' });
        const ip = appeal({ groupId: 'sg-ip' });
        s.insertAppeal(rev);
        s.insertAppeal(ip);
        expect(s.closeOrphanAppeals('retention', NOW)).toBe(1);
        expect(s.loadAppeal(rev.id)?.status).toBe('open');
        expect(s.loadAppeal(ip.id)?.status).toBe('moot');
      });

      it('clearStatement nulls the moot appeal\'s text (retention at 0)', () => {
        const s = store();
        const a = appeal({ groupId: 'sg-a' });
        const b = appeal({ groupId: 'sg-b' });
        s.insertAppeal(a);
        expect(s.closeOrphanAppeals('retention', NOW, true)).toBe(1);
        expect(s.loadAppeal(a.id)).toMatchObject({ status: 'moot', statement: null });
        s.insertAppeal(b);
        expect(s.closeOrphanAppeals('retention', NOW, false)).toBe(1);
        expect(s.loadAppeal(b.id)?.statement).toBe(b.statement);
      });

      it('a moot appeal is on the statement clock and the row goes with purgeAppeals, since its sanction is gone', () => {
        const s = store();
        const a = appeal({ groupId: 'sg-a' });
        s.insertAppeal(a);
        s.closeOrphanAppeals('retention', NOW - 100 * DAY);
        expect(s.clearAppealStatements(NOW - 90 * DAY)).toBe(1);
        expect(s.purgeAppeals(NOW - 90 * DAY)).toBe(1);
        expect(s.loadAppeal(a.id)).toBeNull();
      });

      it('is undone with its transaction', () => {
        const s = store();
        const a = appeal({ groupId: 'sg-a' });
        s.insertAppeal(a);
        expect(() =>
          s.transaction(() => {
            expect(s.closeOrphanAppeals('retention', NOW)).toBe(1);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadAppeal(a.id)?.status).toBe('open');
      });
    });

    describe('loadSanctionSubjectRow', () => {
      it('returns kind, actor, source, automated, start, end, rule, room and reportId of the subject row', () => {
        const s = store();
        s.insertSanctionGroup([
          sanction({ groupId: 'sg-x', refCode: 'M-60001', kind: 'ban', endsAt: null, startsAt: NOW - H, rule: '3', roomId: 'ROOM1', actor: 'mod_dee', source: 'moderator', automated: false, reportId: 'rep_9' }),
          sanction({ groupId: 'sg-x', refCode: 'M-60001', kind: 'ban', endsAt: null, targetType: 'ip', value: 'iphash-x' }),
        ]);
        expect(s.loadSanctionSubjectRow('sg-x')).toMatchObject({
          groupId: 'sg-x',
          kind: 'ban',
          actor: 'mod_dee',
          source: 'moderator',
          automated: false,
          startsAt: NOW - H,
          endsAt: null,
          rule: '3',
          roomId: 'ROOM1',
          reportId: 'rep_9',
          targetType: 'subject',
          value: 's_a',
        });
      });

      it('an automatic row says so, and a row with no report id reads null', () => {
        const s = store();
        s.insertSanctionGroup(subjectAndIp('sg-auto', 'M-60002', { source: 'auto_filter', automated: true, actor: 'chatwarden' }));
        const got = s.loadSanctionSubjectRow('sg-auto');
        expect(got).toMatchObject({ automated: true, source: 'auto_filter', actor: 'chatwarden' });
        expect(got?.reportId ?? null).toBeNull();
      });

      it('is null for an unknown group or an IP-only group', () => {
        const s = store();
        s.insertSanctionGroup([sanction({ groupId: 'sg-ip', refCode: 'M-60003', targetType: 'ip', value: 'iphash' })]);
        expect(s.loadSanctionSubjectRow('sg-ip')).toBeNull();
        expect(s.loadSanctionSubjectRow('sg-none')).toBeNull();
        expect(s.loadSanctionSubjectRow('')).toBeNull();
      });

      it('still answers for a revoked group (the appeal reads what was decided)', () => {
        const s = store();
        s.insertSanctionGroup(subjectAndIp('sg-rev', 'M-60004'));
        s.revokeSanctionGroup('sg-rev', 'mod_ann', NOW, 'oops');
        expect(s.loadSanctionSubjectRow('sg-rev')).toMatchObject({ groupId: 'sg-rev', kind: 'chat' });
      });

      it('returns a copy', () => {
        const s = store();
        s.insertSanctionGroup(subjectAndIp('sg-copy', 'M-60005'));
        const got = s.loadSanctionSubjectRow('sg-copy') as SanctionRow;
        got.reason = 'changed';
        expect(s.loadSanctionSubjectRow('sg-copy')?.reason).toBe('private reason');
      });
    });

    describe('clearAppealStatements and purgeAppeals', () => {
      it('clearAppealStatements nulls decided_at < before and keeps the row; an open appeal\'s statement survives', () => {
        const s = store();
        const open = appeal({ createdAt: NOW - 400 * DAY });
        const old = appeal();
        const recent = appeal();
        for (const r of [open, old, recent]) s.insertAppeal(r);
        s.decideAppeal(old.id, decide({ at: NOW - 100 * DAY }));
        s.decideAppeal(recent.id, decide({ at: NOW - 10 * DAY }));
        expect(s.clearAppealStatements(NOW - 90 * DAY)).toBe(1);
        expect(s.loadAppeal(old.id)).toMatchObject({ statement: null, status: 'upheld', decidedBy: 'senior_bea', decisionReason: 'the rule applied' });
        expect(s.loadAppeal(recent.id)?.statement).toBe(recent.statement);
        expect(s.loadAppeal(open.id)?.statement).toBe(open.statement);
        // everything cleared already: nothing more to clear
        expect(s.clearAppealStatements(NOW - 90 * DAY)).toBe(0);
        // any cutoff leaves an open appeal's text alone
        expect(s.clearAppealStatements(NOW + 1000 * DAY)).toBe(1);
        expect(s.loadAppeal(open.id)?.statement).toBe(open.statement);
      });

      it('clearAppealStatements is strict: a row decided exactly on the line keeps its statement', () => {
        const s = store();
        const row = appeal();
        s.insertAppeal(row);
        s.decideAppeal(row.id, decide({ at: NOW }));
        expect(s.clearAppealStatements(NOW)).toBe(0);
        expect(s.loadAppeal(row.id)?.statement).toBe(row.statement);
        expect(s.clearAppealStatements(NOW + 1)).toBe(1);
        expect(s.loadAppeal(row.id)?.statement).toBeNull();
      });

      it('a moot appeal\'s statement is cleared on the same clock as a decided one', () => {
        const s = store();
        const row = appeal({ groupId: 'g-moot' });
        s.insertAppeal(row);
        s.closeAppealsForGroup('g-moot', 'x', NOW - 100 * DAY);
        expect(s.clearAppealStatements(NOW - 90 * DAY)).toBe(1);
        expect(s.loadAppeal(row.id)).toMatchObject({ status: 'moot', statement: null });
      });

      it('purgeAppeals is strict: a decided row exactly on the line is kept; an open row is never deleted', () => {
        const s = store();
        const open = appeal({ createdAt: NOW - 900 * DAY });
        const edge = appeal();
        const old = appeal();
        const moot = appeal({ groupId: 'g-moot' });
        for (const r of [open, edge, old, moot]) s.insertAppeal(r);
        s.decideAppeal(edge.id, decide({ at: NOW }));
        s.decideAppeal(old.id, decide({ at: NOW - 1 }));
        s.closeAppealsForGroup('g-moot', 'x', NOW - 5);
        expect(s.purgeAppeals(NOW)).toBe(2);
        expect(s.loadAppeal(old.id)).toBeNull();
        expect(s.loadAppeal(moot.id)).toBeNull();
        expect(s.loadAppeal(edge.id)).not.toBeNull();
        expect(s.loadAppeal(open.id)).not.toBeNull();
        expect(s.purgeAppeals(NOW + 1)).toBe(1);
        expect(s.loadAppeal(open.id)).not.toBeNull();
        expect(s.purgeAppeals(NOW + 100 * DAY)).toBe(0);
      });

      it('a purged appeal frees its group: the unique group is a row constraint, not a memory', () => {
        const s = store();
        const row = appeal({ groupId: 'g-reuse' });
        s.insertAppeal(row);
        s.decideAppeal(row.id, decide({ at: NOW - 1 }));
        s.purgeAppeals(NOW);
        expect(s.insertAppeal(appeal({ groupId: 'g-reuse' }))).toBe(true);
      });

      it('purgeAppeals keeps a decided row for a permanent unrevoked sanction, deletes it once revoked', () => {
        const s = store();
        s.insertSanctionGroup(subjectAndIp('sg-perm', 'M-70001', { kind: 'ban', endsAt: null }));
        const row = appeal({ groupId: 'sg-perm', kind: 'ban' });
        s.insertAppeal(row);
        s.decideAppeal(row.id, decide({ status: 'upheld', at: NOW - 400 * DAY }));
        expect(s.purgeAppeals(NOW - 365 * DAY)).toBe(0);
        expect(s.loadAppeal(row.id)).not.toBeNull();
        // while it stands, even a purge of everything leaves the row (the player could appeal a live permanent ban a second time)
        expect(s.purgeAppeals(NOW + 1000 * DAY)).toBe(0);
        s.revokeSanctionGroup('sg-perm', 'mod_ann', NOW, 'lifted');
        expect(s.purgeAppeals(NOW - 365 * DAY)).toBe(1);
        expect(s.loadAppeal(row.id)).toBeNull();
      });

      it('purgeAppeals keeps a decided row while its timed sanction is still running (or ended after the cutoff), deletes it once it ended before', () => {
        const s = store();
        // a year-long ban, upheld on day 5, is still running when the cutoff passes the decision: the row stays so no second appeal can be filed
        s.insertSanctionGroup(subjectAndIp('sg-running', 'M-80001', { kind: 'ban', startsAt: NOW - 100 * DAY, endsAt: NOW + 265 * DAY }));
        s.insertSanctionGroup(subjectAndIp('sg-late', 'M-80002', { kind: 'chat', startsAt: NOW - 100 * DAY, endsAt: NOW - 50 * DAY }));
        s.insertSanctionGroup(subjectAndIp('sg-ended', 'M-80003', { kind: 'chat', startsAt: NOW - 200 * DAY, endsAt: NOW - 150 * DAY }));
        s.insertSanctionGroup(subjectAndIp('sg-revoked', 'M-80004', { kind: 'ban', startsAt: NOW - 100 * DAY, endsAt: NOW + 265 * DAY }));
        s.revokeSanctionGroup('sg-revoked', 'mod_ann', NOW - 60 * DAY, 'lifted');
        const rows = ['sg-running', 'sg-late', 'sg-ended', 'sg-revoked'].map((g) => appeal({ groupId: g }));
        for (const r of rows) {
          s.insertAppeal(r);
          s.decideAppeal(r.id, decide({ at: NOW - 95 * DAY }));
        }
        const cutoff = NOW - 90 * DAY;
        expect(s.purgeAppeals(cutoff)).toBe(2);
        expect(s.loadAppeal((rows[0] as AppealRow).id)).not.toBeNull();
        expect(s.loadAppeal((rows[1] as AppealRow).id)).not.toBeNull();
        expect(s.loadAppeal((rows[2] as AppealRow).id)).toBeNull();
        expect(s.loadAppeal((rows[3] as AppealRow).id)).toBeNull();
        // an end exactly on the cutoff has ended (the row applied strictly before it): the appeal row goes
        s.insertSanctionGroup(subjectAndIp('sg-edge', 'M-80005', { kind: 'chat', startsAt: NOW - 200 * DAY, endsAt: cutoff }));
        const edge = appeal({ groupId: 'sg-edge' });
        s.insertAppeal(edge);
        s.decideAppeal(edge.id, decide({ at: NOW - 95 * DAY }));
        expect(s.purgeAppeals(cutoff)).toBe(1);
        expect(s.loadAppeal(edge.id)).toBeNull();
      });

      it('purgeAppeals deletes a decided row for a timed sanction that has ended, a warning and a sanction that is gone, and keeps the row of a permanent one', () => {
        const s = store();
        s.insertSanctionGroup(subjectAndIp('sg-timed', 'M-70002', { kind: 'chat', startsAt: NOW - 500 * DAY, endsAt: NOW - 499 * DAY }));
        s.insertSanctionGroup(subjectAndIp('sg-warn', 'M-70003', { kind: 'warning', endsAt: null }));
        s.insertSanctionGroup(subjectAndIp('sg-perm', 'M-70004', { kind: 'chat', endsAt: null }));
        const timed = appeal({ groupId: 'sg-timed' });
        const warn = appeal({ groupId: 'sg-warn', kind: 'warning' });
        const perm = appeal({ groupId: 'sg-perm' });
        const gone = appeal({ groupId: 'sg-purged-away' });
        for (const r of [timed, warn, perm, gone]) {
          s.insertAppeal(r);
          s.decideAppeal(r.id, decide({ at: NOW - 400 * DAY }));
        }
        expect(s.purgeAppeals(NOW - 365 * DAY)).toBe(3);
        expect(s.loadAppeal(timed.id)).toBeNull();
        expect(s.loadAppeal(warn.id)).toBeNull();
        expect(s.loadAppeal(gone.id)).toBeNull();
        expect(s.loadAppeal(perm.id)).not.toBeNull();
        s.clearAppealStatements(NOW);
        expect(s.loadAppeal(perm.id)?.statement).toBeNull();
        expect(s.loadAppeal(perm.id)?.status).toBe('upheld');
      });
    });

    describe('the change token and transactions', () => {
      it('every write moves changeToken: insert, decide, moot', () => {
        const s = store();
        const a = appeal({ groupId: 'g-a' });
        const b = appeal({ groupId: 'g-b' });
        let token = s.changeToken();
        s.insertAppeal(a);
        expect(s.changeToken()).not.toBe(token);
        token = s.changeToken();
        s.insertAppeal(b);
        expect(s.changeToken()).not.toBe(token);
        token = s.changeToken();
        s.decideAppeal(a.id, decide());
        expect(s.changeToken()).not.toBe(token);
        token = s.changeToken();
        s.closeAppealsForGroup('g-b', 'x', NOW);
        expect(s.changeToken()).not.toBe(token);
      });

      it('a write that changes nothing leaves it alone: a refused insert, a decide from a decided appeal, a moot of nothing, a read', () => {
        const s = store();
        const a = appeal({ groupId: 'g-a' });
        s.insertAppeal(a);
        s.decideAppeal(a.id, decide());
        const token = s.changeToken();
        expect(s.insertAppeal(appeal({ groupId: 'g-a' }))).toBe(false);
        expect(s.decideAppeal(a.id, decide({ status: 'revoked' }))).toBe(false);
        expect(s.closeAppealsForGroup('g-a', 'x', NOW)).toBe(0);
        expect(s.closeAppealsForGroup('g-none', 'x', NOW)).toBe(0);
        s.loadAppeal(a.id);
        s.listAppeals({ limit: 5 });
        s.countOpenAppeals();
        s.countAppealsBy(['s_a'], 0);
        s.appealCountsByRule(0);
        s.countSanctionsByRule(0);
        expect(s.changeToken()).toBe(token);
      });

      it('a transaction that throws undoes an insert, a decide and a moot', () => {
        const s = store();
        const open = appeal({ groupId: 'g-open' });
        const toDecide = appeal({ groupId: 'g-decide' });
        const toClose = appeal({ groupId: 'g-close' });
        s.insertAppeal(toDecide);
        s.insertAppeal(toClose);
        const token = s.changeToken();
        expect(() =>
          s.transaction(() => {
            s.insertAppeal(open);
            s.decideAppeal(toDecide.id, decide({ status: 'revoked', clearStatement: true }));
            s.closeAppealsForGroup('g-close', 'x', NOW);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadAppeal(open.id)).toBeNull();
        expect(s.loadAppeal(toDecide.id)).toEqual(toDecide);
        expect(s.loadAppeal(toClose.id)).toEqual(toClose);
        expect(s.countOpenAppeals()).toBe(2);
        expect(s.changeToken()).toBe(token);
        // the group the undone insert held is free again
        expect(s.insertAppeal(appeal({ groupId: 'g-open' }))).toBe(true);
      });

      it('a transaction that throws undoes the two purges', () => {
        const s = store();
        const row = appeal();
        s.insertAppeal(row);
        s.decideAppeal(row.id, decide({ at: NOW - 400 * DAY }));
        expect(() =>
          s.transaction(() => {
            expect(s.clearAppealStatements(NOW)).toBe(1);
            expect(s.purgeAppeals(NOW)).toBe(1);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadAppeal(row.id)).toMatchObject({ id: row.id, statement: row.statement });
      });
    });
  });
}
