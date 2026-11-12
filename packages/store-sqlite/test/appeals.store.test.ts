import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppealRow, BlockedNameRow, NoticeRow, SanctionRow } from '@chatwarden/core';
import { openStore } from '../src/index.js';
import type { SqliteStore } from '../src/index.js';

// What is specific to SQLite in the appeal and blocked-name methods: it HAS them (the shared contract areas skip a store without them, so this
// is the assertion that stops a silent skip), the plans the indexes of migration 22 give, the unique group and the conditional decide
// between two connections, the checks the tables make, and the purge of the four notice kinds. The behaviour both stores share is in the
// shared contract suite (test/contract/appeals.contract.ts, names.contract.ts, notices.contract.ts).

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const memDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return db;
};
const fileDb = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-app-'));
  dirs.push(d);
  return join(d, 'kit.db');
};
const open = (path: string): SqliteStore => {
  const s = openStore({ path });
  stores.push(s);
  return s;
};
const memStore = (db = memDb()): SqliteStore => {
  const s = openStore({ db });
  stores.push(s);
  return s;
};

let n = 0;
const appeal = (over: Partial<AppealRow> = {}): AppealRow => {
  n += 1;
  return {
    id: `ap${String(n).padStart(4, '0')}`,
    subject: `s_${n % 40}`,
    groupId: `g${n}`,
    noticeId: `n${n}`,
    reportId: null,
    rule: String((n % 5) + 1),
    kind: 'chat',
    statement: `statement ${n}`,
    status: 'open',
    createdAt: NOW - (n % 90) * DAY,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    replacementGroupId: null,
    ...over,
  };
};
const sanction = (over: Partial<SanctionRow> = {}): SanctionRow => {
  n += 1;
  return {
    id: `sr${n}`,
    groupId: `sg${n}`,
    refCode: `M-${String(n).padStart(5, '0')}`,
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
  };
};

type Seen = { sql: string; args: SQLInputValue[] };
/** The statements the store prepares while `run` executes: SQL text plus the arguments it was run with. */
function record(db: DatabaseSync, run: () => void): Seen[] {
  const seen: Seen[] = [];
  const orig = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = orig(sql);
    for (const m of ['all', 'get', 'run'] as const) {
      const f = stmt[m].bind(stmt) as (...a: SQLInputValue[]) => unknown;
      (stmt as unknown as Record<string, unknown>)[m] = (...args: SQLInputValue[]) => {
        seen.push({ sql, args });
        return f(...args);
      };
    }
    return stmt;
  };
  try {
    run();
  } finally {
    delete (db as { prepare?: unknown }).prepare;
  }
  return seen;
}
const planOf = (db: DatabaseSync, seen: Seen[], match: RegExp): string[] => {
  const hits = seen.filter((s) => match.test(s.sql));
  expect(hits, `one statement matching ${String(match)} was issued`).toHaveLength(1);
  const hit = hits[0] as Seen;
  return db.prepare(`EXPLAIN QUERY PLAN ${hit.sql}`).all(...hit.args).map((r) => String(r.detail));
};

/** A store with a few hundred appeals over many subjects, rules and statuses. */
function seeded(db: DatabaseSync): SqliteStore {
  const store = memStore(db);
  for (let i = 0; i < 400; i++) {
    const row = appeal({ subject: `s_${i % 40}`, rule: String((i % 7) + 1) });
    store.insertAppeal(row);
    if (i % 3 === 0) store.decideAppeal(row.id, { status: (['upheld', 'reduced', 'revoked'] as const)[i % 9 === 0 ? 0 : i % 2 === 0 ? 1 : 2], at: NOW - (i % 30) * DAY, by: 'bea', reason: 'r', replacementGroupId: null });
  }
  return store;
}

describe('SqliteStore has the appeal and blocked-name methods', () => {
  it('has all thirteen appeal methods and the three blocked-name methods (the contract areas skip a store without them, so this cannot)', () => {
    const s = memStore();
    for (const m of [
      'insertAppeal', 'loadAppeal', 'listAppeals', 'countAppealsBy', 'countOpenAppeals', 'decideAppeal', 'closeAppealsForGroup',
      'closeOrphanAppeals', 'appealCountsByRule', 'countSanctionsByRule', 'loadSanctionSubjectRow', 'clearAppealStatements', 'purgeAppeals',
      'insertBlockedName', 'listBlockedNames', 'purgeBlockedNames',
    ] as const) {
      expect(typeof s[m], m).toBe('function');
    }
  });
});

describe('the plans migration 22 gives', () => {
  it('the open count and the open list use kit_appeals_by_status', () => {
    const db = memDb();
    const store = seeded(db);
    const count = planOf(db, record(db, () => store.countOpenAppeals()), /COUNT\(\*\)[\s\S]*FROM kit_appeals/i);
    expect(count.join('\n')).toMatch(/USING (COVERING )?INDEX kit_appeals_by_status/);
    const list = planOf(db, record(db, () => store.listAppeals({ status: 'open', limit: 25 })), /FROM kit_appeals WHERE status = 'open'/i);
    expect(list.join('\n')).toMatch(/USING (COVERING )?INDEX kit_appeals_by_status/);
    expect(list.join('\n')).not.toMatch(/USE TEMP B-TREE/);
    const paged = planOf(db, record(db, () => store.listAppeals({ status: 'open', limit: 25, after: { createdAt: NOW - 5 * DAY, id: 'ap0100' } })), /FROM kit_appeals WHERE status = 'open'/i);
    expect(paged.join('\n')).toMatch(/USING (COVERING )?INDEX kit_appeals_by_status/);
    expect(paged.join('\n')).not.toMatch(/USE TEMP B-TREE/);
  });

  it('countAppealsBy uses kit_appeals_by_subject', () => {
    const db = memDb();
    const store = seeded(db);
    const plan = planOf(db, record(db, () => store.countAppealsBy(['s_1', 's_2'], NOW - 7 * DAY)), /FROM kit_appeals\s+WHERE subject_id IN/i);
    expect(plan.join('\n')).toMatch(/USING (COVERING )?INDEX kit_appeals_by_subject/);
  });

  it('appealCountsByRule uses kit_appeals_by_rule', () => {
    const db = memDb();
    const store = seeded(db);
    const plan = planOf(db, record(db, () => store.appealCountsByRule(NOW - 30 * DAY)), /GROUP BY rule/i);
    expect(plan.join('\n')).toMatch(/USING (COVERING )?INDEX kit_appeals_by_rule/);
  });

  it('insertAppeal is one statement (ON CONFLICT DO NOTHING) that says whether a row was written, with no existence read', () => {
    const db = memDb();
    const store = memStore(db);
    const seen = record(db, () => {
      store.insertAppeal(appeal({ groupId: 'g-same' }));
      store.insertAppeal(appeal({ groupId: 'g-same' }));
    });
    const inserts = seen.filter((s) => /INSERT INTO kit_appeals/i.test(s.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.sql).toMatch(/ON CONFLICT DO NOTHING/i);
    expect(seen.filter((s) => /SELECT/i.test(s.sql) && /kit_appeals/i.test(s.sql) && !/INSERT/i.test(s.sql))).toHaveLength(0);
  });

  it('decideAppeal is one conditional UPDATE ... WHERE status = open', () => {
    const db = memDb();
    const store = memStore(db);
    const row = appeal();
    store.insertAppeal(row);
    const seen = record(db, () => {
      store.decideAppeal(row.id, { status: 'upheld', at: NOW, by: 'bea', reason: 'r', replacementGroupId: null });
    });
    const updates = seen.filter((s) => /UPDATE kit_appeals/i.test(s.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toMatch(/WHERE id = \? AND status = 'open'/i);
  });

  it('purgeBlockedNames uses kit_blocked_names_by_at', () => {
    const db = memDb();
    const store = memStore(db);
    for (let i = 0; i < 300; i++) store.insertBlockedName({ id: `b${i}`, subject: null, name: `quissel${i}`, termId: null, reason: 'name_not_allowed', at: NOW - i * DAY });
    const plan = planOf(db, record(db, () => store.purgeBlockedNames(NOW - 20 * DAY)), /DELETE FROM kit_blocked_names/i);
    expect(plan.join('\n')).toMatch(/USING (COVERING )?INDEX kit_blocked_names_by_at/);
    const list = planOf(db, record(db, () => store.listBlockedNames(NOW - 20 * DAY, 10)), /FROM kit_blocked_names WHERE at >= \?/i);
    expect(list.join('\n')).toMatch(/USING (COVERING )?INDEX kit_blocked_names_by_at/);
  });

  it('the sanctions-by-rule count seeks kit_sanctions_by_start and the appeal-by-group lookups use the unique index', () => {
    const db = memDb();
    const store = seeded(db);
    for (let i = 0; i < 200; i++) store.insertSanctionGroup([sanction({ startsAt: NOW - i * DAY })]);
    const plan = planOf(db, record(db, () => store.countSanctionsByRule(NOW - 30 * DAY)), /COUNT\(DISTINCT group_id\)/i);
    expect(plan.join('\n')).toMatch(/USING (COVERING )?INDEX kit_sanctions_by_start/);
    // the replacement exclusion is an index probe per sanction group, not a scan of the appeals
    expect(plan.join('\n')).toMatch(/INDEX kit_appeals_by_replacement/);
    const moot = planOf(db, record(db, () => store.closeAppealsForGroup('g1', 'x', NOW)), /UPDATE kit_appeals SET status = 'moot'/i);
    expect(moot.join('\n')).toMatch(/INDEX kit_appeals_by_group/);
  });
});

describe('two connections', () => {
  it('insert an appeal for one group: exactly one wins', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    expect(a.insertAppeal(appeal({ groupId: 'g-race', id: 'from-a' }))).toBe(true);
    expect(b.insertAppeal(appeal({ groupId: 'g-race', id: 'from-b' }))).toBe(false);
    expect(b.insertAppeal(appeal({ groupId: 'g-other', id: 'from-b2' }))).toBe(true);
    expect(a.loadAppeal('from-a')).not.toBeNull();
    expect(a.loadAppeal('from-b')).toBeNull();
    expect(a.listAppeals({ limit: 10 })).toHaveLength(2);
  });

  it('decide one appeal: exactly one wins, and the loser changes nothing', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    const row = appeal({ id: 'one' });
    a.insertAppeal(row);
    expect(a.decideAppeal('one', { status: 'upheld', at: NOW, by: 'bea', reason: 'stands', replacementGroupId: null })).toBe(true);
    expect(b.decideAppeal('one', { status: 'revoked', at: NOW + 5, by: 'cy', reason: 'lifted', replacementGroupId: null })).toBe(false);
    expect(b.loadAppeal('one')).toMatchObject({ status: 'upheld', decidedBy: 'bea', decisionReason: 'stands', decidedAt: NOW });
    // a moot after a decide, from the other connection, finds nothing open
    expect(b.closeAppealsForGroup(row.groupId, 'cy', NOW + 6)).toBe(0);
  });

  it('a decide and a moot race: exactly one of them moves the appeal', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    const row = appeal({ id: 'race' });
    a.insertAppeal(row);
    const closed = b.closeAppealsForGroup(row.groupId, 'cy', NOW);
    const decided = a.decideAppeal('race', { status: 'revoked', at: NOW + 1, by: 'bea', reason: 'r', replacementGroupId: null });
    expect([closed, decided]).toEqual([1, false]);
    expect(a.loadAppeal('race')?.status).toBe('moot');
  });

  it('both see a blocked name at once', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    const row: BlockedNameRow = { id: 'b1', subject: 's_a', name: 'Quissel', termId: 'syn:quissel', reason: 'name_not_allowed', at: NOW };
    a.insertBlockedName(row);
    expect(b.listBlockedNames(0, 5)).toEqual([row]);
  });
});

describe('the tables', () => {
  it('through the store, an unknown kind or status is refused by the CHECK and writes nothing', () => {
    const store = memStore();
    expect(() => store.insertAppeal(appeal({ kind: 'note' as never }))).toThrow(/CHECK/);
    expect(() => store.insertAppeal(appeal({ status: 'pending' as never }))).toThrow(/CHECK/);
    expect(() => store.insertBlockedName({ id: 'b', subject: null, name: 'x', termId: null, reason: 'rude' as never, at: NOW })).toThrow(/CHECK/);
    expect(store.listAppeals({ limit: 10 })).toEqual([]);
    expect(store.listBlockedNames(0, 10)).toEqual([]);
    expect(store.countOpenAppeals()).toBe(0);
  });

  it('a duplicate blocked-name id throws and leaves the first row', () => {
    const store = memStore();
    const row: BlockedNameRow = { id: 'b1', subject: null, name: 'first', termId: null, reason: 'name_profane', at: NOW };
    store.insertBlockedName(row);
    expect(() => store.insertBlockedName({ ...row, name: 'second' })).toThrow(/UNIQUE|PRIMARY/);
    expect(store.listBlockedNames(0, 5)).toEqual([row]);
  });

  it('a statement of 1000 emoji with a bidi mark round-trips byte for byte; a NUL or a lone surrogate never makes the write throw (the service normalizes them away first)', () => {
    const store = memStore();
    const plain = '\u{1F4AC}'.repeat(1000) + '‮x';
    const a = appeal({ statement: plain });
    store.insertAppeal(a);
    expect(store.loadAppeal(a.id)?.statement).toBe(plain);
    // The two a store cannot be trusted with (SQLite replaces a lone surrogate when it encodes UTF-8; a NUL is easy to truncate at): the
    // appeals service strips both before the store sees the text. Here the store must only not throw.
    const b = appeal({ statement: 'a\u0000b' });
    const c = appeal({ statement: 'a\uD800b' });
    expect(store.insertAppeal(b)).toBe(true);
    expect(store.insertAppeal(c)).toBe(true);
    expect(store.loadAppeal(b.id)?.statement).toMatch(/^a/);
    expect(store.loadAppeal(c.id)?.statement).toMatch(/^a.*b$/u);
  });

  it('the appeal write moves the change token; a blocked name does not', () => {
    const store = memStore();
    const t0 = store.changeToken();
    store.insertBlockedName({ id: 'b1', subject: null, name: 'x', termId: null, reason: 'name_profane', at: NOW });
    store.purgeBlockedNames(NOW + 1);
    expect(store.changeToken()).toBe(t0);
    const row = appeal();
    store.insertAppeal(row);
    expect(store.changeToken()).not.toBe(t0);
  });

  it('a subject list longer than one batch is counted whole', () => {
    const store = memStore();
    const subjects = Array.from({ length: 1300 }, (_, i) => `s_${String(i).padStart(4, '0')}`);
    for (const s of subjects) store.insertAppeal(appeal({ subject: s, createdAt: NOW }));
    expect(store.countAppealsBy([...subjects, ...subjects.slice(0, 5)], 0)).toEqual({ count: 1300, oldestAt: NOW });
  });
});

describe('sanction rows and the report id', () => {
  it('insertSanctionGroup stores report_id on the subject row, and loadSanctionSubjectRow is the one read that carries it', () => {
    const db = memDb();
    const store = memStore(db);
    store.insertSanctionGroup([sanction({ groupId: 'g1', refCode: 'M-11111', reportId: 'rep_1' }), sanction({ groupId: 'g1', refCode: 'M-11111', targetType: 'ip', value: 'iphash' })]);
    store.insertSanctionGroup([sanction({ groupId: 'g2', refCode: 'M-22222' })]);
    expect(db.prepare('SELECT target_type, report_id FROM kit_sanctions WHERE group_id = ? ORDER BY rowid').all('g1')).toEqual([
      { target_type: 'subject', report_id: 'rep_1' },
      { target_type: 'ip', report_id: null },
    ]);
    expect(store.loadSanctionSubjectRow('g1')?.reportId).toBe('rep_1');
    expect(Object.keys(store.loadSanctionSubjectRow('g2') ?? {})).not.toContain('reportId');
    // no other read grows a key
    for (const r of [...store.loadSanctions(NOW), ...store.loadSubjectActions(0), ...store.listSubjectSanctions({ limit: 10 }), ...store.listGaps()]) {
      expect(Object.keys(r), r.id).not.toContain('reportId');
    }
  });

  it('loadSanctionSubjectRow carries no revoked key, like the shape of the generic loads', () => {
    const store = memStore();
    store.insertSanctionGroup([sanction({ groupId: 'g1', refCode: 'M-11111' })]);
    store.revokeSanctionGroup('g1', 'mod', NOW, 'x');
    expect(Object.keys(store.loadSanctionSubjectRow('g1') ?? {})).not.toContain('revokedAt');
  });
});

describe('purgeNotices and the four message kinds', () => {
  const message = (id: string, kind: NoticeRow['kind'], over: Partial<NoticeRow> = {}): NoticeRow => ({
    id, subject: 's_a', groupId: null, kind, rule: null, until: null, refCode: null, excerpt: [], createdAt: NOW, ackedAt: null, withdrawnAt: null, ...over,
  });

  it('loads and writes each of the four kinds, in order', () => {
    const store = memStore();
    const kinds = ['rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked'] as const;
    kinds.forEach((k, i) => store.insertNotice(message(`n${i}`, k, { createdAt: NOW + i, rule: '2', refCode: 'M-AAAAA' })));
    expect(store.loadNotices(['s_a']).map((r) => r.kind)).toEqual([...kinds]);
  });

  it('seen message kinds go with the seen cutoff; unseen ones go only past the ceilings, and the statement spells the kinds out', () => {
    const db = memDb();
    const store = memStore(db);
    store.insertNotice(message('seen', 'appeal_reduced', { createdAt: NOW - 100 * DAY, ackedAt: NOW }));
    store.insertNotice(message('unseen-appeal', 'appeal_upheld', { createdAt: NOW - 400 * DAY }));
    store.insertNotice(message('unseen-rename', 'rename_required', { createdAt: NOW - 400 * DAY }));
    store.insertNotice(message('unseen-warning', 'warning', { createdAt: NOW - 400 * DAY, groupId: 'g' }));
    expect(store.purgeNotices(NOW - 90 * DAY)).toBe(1);
    expect(store.purgeNotices(NOW - 90 * DAY, { appealBefore: NOW - 365 * DAY, renameBefore: NOW - 500 * DAY })).toBe(1);
    expect(store.loadNotices(['s_a']).map((r) => r.id).sort()).toEqual(['unseen-rename', 'unseen-warning']);
    expect(store.purgeNotices(NOW - 90 * DAY, { appealBefore: NOW, renameBefore: NOW - 365 * DAY })).toBe(1);
    expect(store.loadNotices(['s_a']).map((r) => r.id)).toEqual(['unseen-warning']);
  });
});

describe('retention in one transaction', () => {
  it('an undone transaction undoes a purge of appeals, statements and the orphan close', () => {
    const store = memStore();
    const a = appeal({ groupId: 'g-a' });
    const b = appeal({ groupId: 'g-b' });
    store.insertAppeal(a);
    store.insertAppeal(b);
    store.decideAppeal(a.id, { status: 'upheld', at: NOW - 500 * DAY, by: 'bea', reason: 'r', replacementGroupId: null });
    expect(() =>
      store.transaction(() => {
        expect(store.closeOrphanAppeals('retention', NOW)).toBe(1);
        expect(store.clearAppealStatements(NOW)).toBe(1);
        expect(store.purgeAppeals(NOW)).toBe(1);
        throw new Error('undo');
      }),
    ).toThrow('undo');
    expect(store.loadAppeal(a.id)).toMatchObject({ status: 'upheld', statement: a.statement });
    expect(store.loadAppeal(b.id)?.status).toBe('open');
  });
});
