import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SanctionRow, StrikeRow } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';
import type { SqliteStore } from '../src/index.js';

// Migration 18: indexes for the hot read queries on sanctions (by start time) and strikes (by time). Every plan check runs the
// query exactly as the store issues it: the test records the SQL and arguments the store method prepares, then asks SQLite for the
// plan of that same text.

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
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
const filePath = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-idx-'));
  dirs.push(d);
  return join(d, 'kit.db');
};

const M18 = MIGRATIONS.find((m) => m.version === 18);
const NEW_INDEXES = ['kit_sanctions_by_start', 'kit_strikes_by_at'];

function sanction(i: number, over: Partial<SanctionRow> = {}): SanctionRow {
  return {
    id: `r${String(i).padStart(4, '0')}`,
    groupId: `g${i}`,
    refCode: `M-${String(i).padStart(5, '0')}`,
    kind: i % 3 === 0 ? 'chat' : i % 3 === 1 ? 'area' : 'ban',
    targetType: 'subject',
    value: `s_${i % 40}`,
    startsAt: NOW - i * H,
    endsAt: i % 4 === 0 ? null : NOW - i * H + DAY,
    reason: 'private',
    rule: null,
    gapNote: null,
    gapStatus: null,
    roomId: null,
    actor: 'mod',
    source: i % 2 === 0 ? 'auto_filter' : 'moderator',
    automated: i % 2 === 0,
    pending: false,
    ...over,
  };
}

function strike(i: number): StrikeRow {
  return { id: `k${String(i).padStart(4, '0')}`, at: NOW - i * H, subject: `s_${i % 25}`, roomId: 'room', termId: `t${i % 7}`, rawLine: 'synthetic line' };
}

/** Rows on the version 17 schema: a few hundred of each, a mix of kinds, sources, targets (subject and ip), times and revocations. */
function seed(store: SqliteStore): void {
  for (let i = 0; i < 300; i++) {
    store.insertSanctionGroup([sanction(i)]);
    if (i % 5 === 0) store.insertSanctionGroup([sanction(1000 + i, { groupId: `g${i}`, refCode: `M-${String(i).padStart(5, '0')}`, targetType: 'ip', value: `h_${i}` })]);
    store.insertStrike(strike(i));
  }
  store.revokeSanctionGroup('g3', 'mod', NOW, 'synthetic');
}

/** The statements the store prepares while `run` executes: SQL text plus the arguments it was run with. */
type Seen = { sql: string; args: SQLInputValue[] };
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

/** The plan lines SQLite gives the one statement that reads or deletes from `table`. */
function planOf(db: DatabaseSync, seen: Seen[], table: 'kit_sanctions' | 'kit_strikes'): string[] {
  const hits = seen.filter((s) => /^\s*(SELECT|DELETE)/i.test(s.sql) && s.sql.includes(table));
  expect(hits, `one ${table} statement was issued`).toHaveLength(1);
  const hit = hits[0] as Seen;
  return db.prepare(`EXPLAIN QUERY PLAN ${hit.sql}`).all(...hit.args).map((r) => String(r.detail));
}

function openAt17(db: DatabaseSync, seedRows = true): SqliteStore {
  const store = openStore({ db, migrations: MIGRATIONS.slice(0, 17) });
  expect(store.schemaVersion()).toBe(17);
  if (seedRows) seed(store);
  return store;
}

// loadAutoChatGroups has no ORDER BY (its one caller folds the rows into a Set), so SQLite may return the rows in a different order
// once an index is in play; the contents must match, the order is not part of the contract.
const byGroup = <T extends { groupId: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.groupId.localeCompare(b.groupId));
const dump = (db: DatabaseSync, table: string, order: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
const indexNames = (db: DatabaseSync): string[] =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all().map((r) => String(r.name));

describe('migration 18: indexes for sanctions by start time and strikes by time', () => {
  it('is the latest migration and creates only the two new indexes', () => {
    expect(M18).toBeDefined();
    expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(18);
    const db = memDb();
    const before = openAt17(db, false);
    const had = indexNames(db);
    before.close();
    // Pinned at 18: later migrations add their own indexes, which have their own tests.
    const store = openStore({ db, migrations: MIGRATIONS.slice(0, 18) });
    expect(store.schemaVersion()).toBe(18);
    expect(indexNames(db).filter((n) => !had.includes(n))).toEqual([...NEW_INDEXES].sort());
    // Only indexes: no table, column or row was added or removed.
    for (const old of had) expect(indexNames(db)).toContain(old);
  });

  it('upgrades a version 17 database that already has rows: every row is unchanged and the data reads the same', () => {
    const db = memDb();
    const old = openAt17(db);
    const tables = ['kit_sanctions', 'kit_strikes'];
    const order = { kit_sanctions: 'rowid', kit_strikes: 'rowid' } as const;
    const before = tables.map((t) => dump(db, t, order[t as keyof typeof order]));
    const readsBefore = {
      actions: old.loadSubjectActions(NOW - 10 * DAY),
      strikes: old.loadStrikes(NOW - 10 * DAY),
      listed: old.listSubjectSanctions({ limit: 50 }),
      list: old.listStrikes(0, 50),
      counts: old.countStrikesByTerm(0),
      chat: byGroup(old.loadAutoChatGroups(0)),
    };
    expect(before[0]?.length).toBeGreaterThan(300);
    expect(before[1]).toHaveLength(300);
    old.close();

    const store = openStore({ db, migrations: MIGRATIONS.slice(0, 18) });
    expect(store.schemaVersion()).toBe(18);
    expect(tables.map((t) => dump(db, t, order[t as keyof typeof order]))).toEqual(before);
    expect({
      actions: store.loadSubjectActions(NOW - 10 * DAY),
      strikes: store.loadStrikes(NOW - 10 * DAY),
      listed: store.listSubjectSanctions({ limit: 50 }),
      list: store.listStrikes(0, 50),
      counts: store.countStrikesByTerm(0),
      chat: byGroup(store.loadAutoChatGroups(0)),
    }).toEqual(readsBefore);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('is idempotent: reopening the file runs nothing again and changes nothing', () => {
    const path = filePath();
    const seeded = new DatabaseSync(path);
    dbs.push(seeded);
    openAt17(seeded).close();
    openStore({ path, migrations: MIGRATIONS.slice(0, 18) }).close();
    const snapshot = (): unknown => {
      const raw = new DatabaseSync(path);
      try {
        return { strikes: dump(raw, 'kit_strikes', 'rowid'), sanctions: dump(raw, 'kit_sanctions', 'rowid'), indexes: indexNames(raw) };
      } finally {
        raw.close();
      }
    };
    const once = snapshot();
    const b = openStore({ path, migrations: MIGRATIONS.slice(0, 18) });
    expect(b.schemaVersion()).toBe(18);
    b.close();
    const c = openStore({ path, migrations: MIGRATIONS.slice(0, 18) });
    expect(c.schemaVersion()).toBe(18);
    c.close();
    expect(snapshot()).toEqual(once);
    expect((once as { indexes: string[] }).indexes.filter((n) => NEW_INDEXES.includes(n))).toHaveLength(2);
  });

  it('a fresh database lands on the same indexes as an upgraded one', () => {
    const fresh = memDb();
    openStore({ db: fresh });
    const upgraded = memDb();
    openAt17(upgraded).close();
    openStore({ db: upgraded });
    expect(indexNames(fresh)).toEqual(indexNames(upgraded));
  });

  it('a failing migration 18 rolls back whole: version 17, neither index, rows intact, and it still upgrades afterwards', () => {
    const db = memDb();
    openAt17(db).close();
    const rows = dump(db, 'kit_sanctions', 'rowid');
    const broken = [...MIGRATIONS.slice(0, 17), { version: 18, sql: `${M18?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: MIGRATIONS.slice(0, 17) }).schemaVersion()).toBe(17);
    expect(indexNames(db).filter((n) => NEW_INDEXES.includes(n))).toHaveLength(0);
    expect(dump(db, 'kit_sanctions', 'rowid')).toEqual(rows);
    expect(openStore({ db }).schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(indexNames(db).filter((n) => NEW_INDEXES.includes(n))).toHaveLength(2);
  });
});

describe('the hot read queries use the new indexes (EXPLAIN QUERY PLAN, as issued)', () => {
  function upgraded(): { db: DatabaseSync; store: SqliteStore } {
    const db = memDb();
    openAt17(db).close();
    return { db, store: openStore({ db }) };
  }
  const uses = (plan: string[], index: string): void => {
    const line = plan.find((l) => l.includes(index));
    expect(line, `${index} in: ${plan.join(' | ')}`).toBeDefined();
    expect(line).toMatch(/^SEARCH kit_\w+ USING (COVERING )?INDEX /);
  };

  it('loadSubjectActions (sanctions since a time) searches kit_sanctions_by_start', () => {
    const { db, store } = upgraded();
    uses(planOf(db, record(db, () => store.loadSubjectActions(NOW - 30 * DAY)), 'kit_sanctions'), 'kit_sanctions_by_start');
  });

  it('loadAutoChatGroups (auto chat sanctions since a time) searches kit_sanctions_by_start', () => {
    const { db, store } = upgraded();
    uses(planOf(db, record(db, () => store.loadAutoChatGroups(NOW - 30 * DAY)), 'kit_sanctions'), 'kit_sanctions_by_start');
  });

  it('listSubjectSanctions: the first page, a since window, a keyset cursor and a source filter all search kit_sanctions_by_start, with no sort of the whole set', () => {
    const { db, store } = upgraded();
    const queries = [
      { limit: 50 },
      { limit: 50, since: NOW - 30 * DAY },
      { limit: 50, before: NOW - 20 * H, beforeId: 'r0050' },
      { limit: 50, before: NOW - 20 * H },
      { limit: 50, source: 'moderator' as const },
      { limit: 50, since: NOW - 30 * DAY, alsoPermanent: true },
      { limit: 50, activeAt: NOW },
    ];
    for (const q of queries) {
      const plan = planOf(db, record(db, () => store.listSubjectSanctions(q)), 'kit_sanctions');
      uses(plan, 'kit_sanctions_by_start');
      expect(plan.join(' | '), JSON.stringify(q)).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    }
  });

  it('listSubjectSanctions for one person (subjects given) keeps seeking by the person, not walking every sanction by time', () => {
    const { db, store } = upgraded();
    for (const subjects of [['s_3'], ['s_3', 's_4'], ['s_3', 's_4', 's_5', 's_6']]) {
      for (const extra of [{}, { since: NOW - 30 * DAY }, { before: NOW - 20 * H, beforeId: 'r0050' }, { source: 'moderator' as const }]) {
        const plan = planOf(db, record(db, () => store.listSubjectSanctions({ limit: 50, subjects, ...extra })), 'kit_sanctions');
        expect(plan.join(' | '), JSON.stringify({ subjects, extra })).toMatch(
          /SEARCH kit_sanctions USING INDEX kit_sanctions_by_target \(target_type=\? AND target_value=\?\)/,
        );
      }
    }
  });

  it('loadStrikes (the strike window) searches kit_strikes_by_at and needs no sort', () => {
    const { db, store } = upgraded();
    const plan = planOf(db, record(db, () => store.loadStrikes(NOW - 30 * DAY)), 'kit_strikes');
    uses(plan, 'kit_strikes_by_at');
    expect(plan.join(' | ')).not.toMatch(/TEMP B-TREE/);
  });

  it('listStrikes searches kit_strikes_by_at', () => {
    const { db, store } = upgraded();
    uses(planOf(db, record(db, () => store.listStrikes(NOW - 30 * DAY, 100)), 'kit_strikes'), 'kit_strikes_by_at');
  });

  it('countStrikesByTerm searches kit_strikes_by_at', () => {
    const { db, store } = upgraded();
    uses(planOf(db, record(db, () => store.countStrikesByTerm(NOW - 30 * DAY)), 'kit_strikes'), 'kit_strikes_by_at');
  });

  it('purgeStrikes (retention delete by time) searches kit_strikes_by_at', () => {
    const { db, store } = upgraded();
    uses(planOf(db, record(db, () => store.purgeStrikes(NOW - 30 * DAY)), 'kit_strikes'), 'kit_strikes_by_at');
  });

  it('the same queries on the version 17 schema do not (the control: the test sees the difference)', () => {
    const db = memDb();
    const store = openAt17(db);
    const plan = planOf(db, record(db, () => store.loadStrikes(NOW - 30 * DAY)), 'kit_strikes');
    expect(plan.join(' | ')).toMatch(/SCAN kit_strikes/);
    const sPlan = planOf(db, record(db, () => store.loadSubjectActions(NOW - 30 * DAY)), 'kit_sanctions');
    expect(sPlan.join(' | ')).not.toContain('kit_sanctions_by_start');
  });
});
