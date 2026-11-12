import { describe, expect, it } from 'vitest';
import type { AppealRow, BlockedNameRow, SanctionRow } from '@chatwarden/core';
import { MemoryStore, createMemoryStore, withMemoryAppeals, withMemoryNames } from '../src/index.js';

// What is specific to MemoryStore in the appeal and blocked-name methods: they are opt-in (so a bundle that never turns appeals on does
// not carry them), the state lives per store, rows go in and come out as copies, and a sanction row keeps its report id. The behaviour
// it shares with SqliteStore is in the shared contract suite (test/contract/appeals.contract.ts and names.contract.ts, run by contract.test.ts).

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const APPEAL_METHODS = [
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
] as const;
const NAME_METHODS = ['insertBlockedName', 'listBlockedNames', 'purgeBlockedNames'] as const;

const appeal = (over: Partial<AppealRow> = {}): AppealRow => ({
  id: 'ap1',
  subject: 's_a',
  groupId: 'g1',
  noticeId: 'n1',
  reportId: null,
  rule: '2',
  kind: 'chat',
  statement: 'it was a joke about a zorbak',
  status: 'open',
  createdAt: NOW,
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  replacementGroupId: null,
  ...over,
});

const sanction = (over: Partial<SanctionRow> = {}): SanctionRow => ({
  id: 'r1',
  groupId: 'g1',
  refCode: 'M-AAAAA',
  kind: 'chat',
  targetType: 'subject',
  value: 's_a',
  startsAt: NOW,
  endsAt: NOW + DAY,
  reason: 'r',
  rule: '2',
  gapNote: null,
  gapStatus: null,
  roomId: null,
  actor: 'mod_ann',
  source: 'moderator',
  automated: false,
  pending: false,
  ...over,
});

const bare = (s: unknown): Record<string, unknown> => s as Record<string, unknown>;

describe('withMemoryAppeals: the appeal methods are opt-in', () => {
  it('a plain MemoryStore, and createMemoryStore(), have none of the twelve methods', () => {
    for (const s of [new MemoryStore(), createMemoryStore()]) for (const name of APPEAL_METHODS) expect(typeof bare(s)[name], name).toBe('undefined');
  });

  it('returns the same store, now with the methods, that work', () => {
    const plain = new MemoryStore();
    const s = withMemoryAppeals(plain);
    expect(s).toBe(plain);
    for (const name of APPEAL_METHODS) expect(typeof s[name], name).toBe('function');
    expect(s.insertAppeal(appeal())).toBe(true);
    expect(s.loadAppeal('ap1')?.statement).toBe('it was a joke about a zorbak');
  });

  it('it does not give the blocked-name methods, and withMemoryNames does not give the appeal ones', () => {
    const a = withMemoryAppeals(new MemoryStore());
    for (const name of NAME_METHODS) expect(typeof bare(a)[name], name).toBe('undefined');
    const n = withMemoryNames(new MemoryStore());
    for (const name of APPEAL_METHODS) expect(typeof bare(n)[name], name).toBe('undefined');
    for (const name of NAME_METHODS) expect(typeof n[name], name).toBe('function');
  });

  it('the methods are not enumerable, so they do not show as own state', () => {
    const s = withMemoryNames(withMemoryAppeals(new MemoryStore()));
    expect(Object.keys(s).filter((k) => /Appeal|BlockedName|SanctionsByRule|SanctionSubjectRow/.test(k))).toEqual([]);
  });

  it('is idempotent: a second call changes nothing, and rows already stored stay', () => {
    const s = withMemoryAppeals(new MemoryStore());
    s.insertAppeal(appeal());
    const insert = s.insertAppeal;
    withMemoryAppeals(s);
    expect(s.insertAppeal).toBe(insert);
    expect(s.loadAppeal('ap1')).not.toBeNull();
    const n = withMemoryNames(new MemoryStore());
    n.insertBlockedName({ id: 'b1', subject: null, name: 'quissel', termId: null, reason: 'name_not_allowed', at: NOW });
    withMemoryNames(n);
    expect(n.listBlockedNames(0, 5)).toHaveLength(1);
  });

  it('keeps a method the store already has (a subclass override)', () => {
    class Own extends MemoryStore {
      countOpenAppeals(): number {
        return 42;
      }
    }
    const s = withMemoryAppeals(new Own());
    expect(s.countOpenAppeals()).toBe(42);
    expect(typeof s.insertAppeal).toBe('function');
  });

  it('keeps the state apart per store', () => {
    const a = withMemoryAppeals(new MemoryStore());
    const b = withMemoryAppeals(new MemoryStore());
    a.insertAppeal(appeal());
    expect(b.loadAppeal('ap1')).toBeNull();
    expect(b.countOpenAppeals()).toBe(0);
    expect(b.insertAppeal(appeal())).toBe(true);
  });

  it('can be applied after the other optional wrappers, in any order', () => {
    const s = withMemoryAppeals(withMemoryNames(new MemoryStore()));
    expect(typeof s.insertAppeal).toBe('function');
    expect(typeof (s as unknown as { insertBlockedName: unknown }).insertBlockedName).toBe('function');
  });
});

describe('MemoryStore appeals', () => {
  it('stores a copy: editing the row after the insert changes nothing', () => {
    const s = withMemoryAppeals(new MemoryStore());
    const r = appeal();
    s.insertAppeal(r);
    r.statement = 'changed';
    r.status = 'revoked';
    expect(s.loadAppeal('ap1')).toMatchObject({ statement: 'it was a joke about a zorbak', status: 'open' });
  });

  it('moves the change token on an insert, a decide and a moot, and a refused write does not', () => {
    const s = withMemoryAppeals(new MemoryStore());
    const t0 = s.changeToken();
    s.insertAppeal(appeal());
    const t1 = s.changeToken();
    expect(t1).not.toBe(t0);
    s.insertAppeal(appeal({ id: 'ap-dup' })); // same group: refused
    expect(s.changeToken()).toBe(t1);
    s.decideAppeal('ap1', { status: 'upheld', at: NOW, by: 'bea', reason: 'r', replacementGroupId: null });
    const t2 = s.changeToken();
    expect(t2).not.toBe(t1);
    s.insertAppeal(appeal({ id: 'ap2', groupId: 'g2' }));
    const t3 = s.changeToken();
    s.closeAppealsForGroup('g2', 'cy', NOW);
    expect(s.changeToken()).not.toBe(t3);
  });

  it('a sanction row keeps its report id through insertSanctionGroup and loadSanctionSubjectRow only: the generic loads keep their shape', () => {
    const s = withMemoryAppeals(new MemoryStore());
    s.insertSanctionGroup([sanction({ reportId: 'rep_7' }), sanction({ id: 'r2', targetType: 'ip', value: 'iphash' })]);
    expect(s.loadSanctionSubjectRow('g1')?.reportId).toBe('rep_7');
    for (const r of [...s.loadSanctions(NOW), ...s.loadSubjectActions(0), ...s.listSubjectSanctions({ limit: 10 }), ...s.listGaps()]) {
      expect(Object.keys(r), r.id).not.toContain('reportId');
    }
  });

  it('a sanction row written without a report id reads back without one, and loadSanctionSubjectRow says null', () => {
    const s = withMemoryAppeals(new MemoryStore());
    s.insertSanctionGroup([sanction()]);
    expect(Object.keys(s.loadSanctions(NOW)[0] ?? {})).not.toContain('reportId');
    expect(s.loadSanctionSubjectRow('g1')?.reportId ?? null).toBeNull();
  });

  it('loadSanctionSubjectRow carries no revocation or gap bookkeeping, just the row', () => {
    const s = withMemoryAppeals(new MemoryStore());
    s.insertSanctionGroup([sanction({ gapNote: 'n', gapStatus: 'open' })]);
    s.revokeSanctionGroup('g1', 'mod_ann', NOW, 'oops');
    const keys = Object.keys(s.loadSanctionSubjectRow('g1') ?? {});
    for (const k of ['gapRef', 'gapClosedBy', 'gapClosedAt', 'revokedBy', 'revokedAt', 'revokeReason']) expect(keys, k).not.toContain(k);
  });

  it('purges many appeals of many groups and keeps the by-group index in step', () => {
    const s = withMemoryAppeals(new MemoryStore());
    for (let i = 0; i < 300; i += 1) {
      s.insertAppeal(appeal({ id: `a${i}`, groupId: `g${i}`, createdAt: NOW + i }));
      s.decideAppeal(`a${i}`, { status: 'upheld', at: NOW + i, by: 'bea', reason: 'r', replacementGroupId: null });
    }
    expect(s.purgeAppeals(NOW + 150)).toBe(150);
    expect(s.listAppeals({ status: 'all', limit: 200 })).toHaveLength(150);
    expect(s.insertAppeal(appeal({ id: 'again', groupId: 'g0' }))).toBe(true);
    expect(s.insertAppeal(appeal({ id: 'again2', groupId: 'g299' }))).toBe(false);
  });

  it('an undone transaction undoes a purge and its index entries', () => {
    const s = withMemoryAppeals(new MemoryStore());
    s.insertAppeal(appeal());
    s.decideAppeal('ap1', { status: 'upheld', at: NOW - 1, by: 'bea', reason: 'r', replacementGroupId: null });
    expect(() =>
      s.transaction(() => {
        expect(s.purgeAppeals(NOW)).toBe(1);
        expect(s.insertAppeal(appeal({ id: 'ap9' }))).toBe(true); // the group is free inside the transaction
        throw new Error('undo');
      }),
    ).toThrow('undo');
    expect(s.loadAppeal('ap1')).not.toBeNull();
    expect(s.loadAppeal('ap9')).toBeNull();
    expect(s.insertAppeal(appeal({ id: 'ap9' }))).toBe(false); // and held again after it
  });
});

describe('MemoryStore blocked names', () => {
  const name = (over: Partial<BlockedNameRow> = {}): BlockedNameRow => ({ id: 'b1', subject: 's_a', name: 'Quissel', termId: 'syn:quissel', reason: 'name_not_allowed', at: NOW, ...over });

  it('stores a copy: editing the row after the insert changes nothing', () => {
    const s = withMemoryNames(new MemoryStore());
    const r = name();
    s.insertBlockedName(r);
    r.name = 'changed';
    expect(s.listBlockedNames(0, 5)[0]?.name).toBe('Quissel');
  });

  it('keeps the state apart per store', () => {
    const a = withMemoryNames(new MemoryStore());
    const b = withMemoryNames(new MemoryStore());
    a.insertBlockedName(name());
    expect(b.listBlockedNames(0, 5)).toEqual([]);
  });

  it('a blocked name is not a queue change: it does not move the change token', () => {
    const s = withMemoryNames(new MemoryStore());
    const before = s.changeToken();
    s.insertBlockedName(name());
    s.purgeBlockedNames(NOW + 1);
    expect(s.changeToken()).toBe(before);
  });
});
