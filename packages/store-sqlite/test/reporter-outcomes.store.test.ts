import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredReport } from '@chatwarden/core';
import { MemoryStore } from '@chatwarden/store-memory';
import { MIGRATIONS, openStore } from '../src/index.js';
import type { SqliteStore } from '../src/index.js';

// Migration 19 and the grouped reporter-outcomes read behind reporter accuracy (D3). The plan check runs the query exactly as the
// store issues it: the test records the SQL and arguments the store prepares, then asks SQLite for the plan of that same text.

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const INDEX = 'kit_reports_by_reporter_outcome';

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
  const d = mkdtempSync(join(tmpdir(), 'cw-ro-'));
  dirs.push(d);
  return join(d, 'kit.db');
};

const M19 = MIGRATIONS.find((m) => m.version === 19);
const indexNames = (db: DatabaseSync): string[] =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all().map((r) => String(r.name));
const dump = (db: DatabaseSync, table: string, order: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();

type How = 'open' | 'upheld' | 'dismissed' | 'bad_faith';
let seq = 0;
/** One report in its own room (the UNIQUE index never trips), closed as given. */
function fileOn(store: SqliteStore | MemoryStore, reporter: string, how: How, createdAt: number): string {
  const id = `ro${String(++seq).padStart(5, '0')}`;
  const r: StoredReport = {
    id,
    createdAt,
    roomId: `ROOM-${id}`,
    tags: {},
    reporterSubject: reporter,
    reporterSeat: 'p1',
    reporterHandle: 'Rep',
    targetSubject: `s_t${seq % 17}`,
    targetSeat: 'p2',
    targetHandle: 'Tgt',
    category: 'harassment',
    note: null,
    lineId: null,
    excerpt: [],
    people: [],
    status: 'open',
  };
  store.insertReport(r);
  if (how === 'upheld') store.closeReport(id, 'actioned', false, 'mod', createdAt + 1, 'n');
  if (how === 'dismissed') store.closeReport(id, 'dismissed', false, 'mod', createdAt + 1, 'n');
  if (how === 'bad_faith') store.closeReport(id, 'dismissed', true, 'mod', createdAt + 1, 'n', 'evidence');
  return id;
}

/** A spread of reporters, outcomes and filing times, identical for any store handed to it. */
function seed(store: SqliteStore | MemoryStore, reporters: number): void {
  const hows: How[] = ['open', 'upheld', 'dismissed', 'bad_faith', 'dismissed', 'upheld'];
  for (let i = 0; i < reporters; i++) {
    const per = 1 + (i % 7);
    for (let j = 0; j < per; j++) fileOn(store, `s_rep${i}`, hows[(i + j) % hows.length] as How, NOW - ((i * 7 + j) % 40) * DAY);
  }
}

const sorted = <T extends { reporter: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.reporter.localeCompare(b.reporter));

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
const planOf = (db: DatabaseSync, hit: Seen): string[] => db.prepare(`EXPLAIN QUERY PLAN ${hit.sql}`).all(...hit.args).map((r) => String(r.detail));

function openAt18(db: DatabaseSync, reporters = 0): SqliteStore {
  const store = openStore({ db, migrations: MIGRATIONS.slice(0, 18) });
  expect(store.schemaVersion()).toBe(18);
  seed(store, reporters);
  return store;
}

describe('migration 19: the covering index for reporter outcomes', () => {
  it('is the 19th migration and creates exactly one index, no table or column', () => {
    expect(M19).toBeDefined();
    expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(19);
    expect(M19?.sql).toMatch(/CREATE INDEX kit_reports_by_reporter_outcome ON kit_reports \(reporter_subject, created_at, status, bad_faith\)/);
    const db = memDb();
    openAt18(db).close();
    const had = indexNames(db);
    const columns = db.prepare('PRAGMA table_info(kit_reports)').all();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const store = openStore({ db, migrations: MIGRATIONS.slice(0, 19) });
    expect(store.schemaVersion()).toBe(19);
    expect(indexNames(db).filter((n) => !had.includes(n))).toEqual([INDEX]);
    for (const old of had) expect(indexNames(db)).toContain(old);
    expect(db.prepare('PRAGMA table_info(kit_reports)').all()).toEqual(columns);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual(tables);
  });

  it('upgrading a database at version 18 with rows keeps every row, and the older reads answer the same', () => {
    const db = memDb();
    const old = openAt18(db, 80);
    const before = dump(db, 'kit_reports', 'rowid');
    const readsBefore = { tally: old.reporterTally(['s_rep3', 's_rep4']), list: old.listReports({ limit: 50 }) };
    expect(before.length).toBeGreaterThan(200);
    old.close();

    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(dump(db, 'kit_reports', 'rowid')).toEqual(before);
    expect({ tally: store.reporterTally(['s_rep3', 's_rep4']), list: store.listReports({ limit: 50 }) }).toEqual(readsBefore);
    expect(indexNames(db)).toContain(INDEX);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('is idempotent: reopening the file runs nothing again and changes nothing', () => {
    const path = filePath();
    const seeded = new DatabaseSync(path);
    dbs.push(seeded);
    openAt18(seeded, 30).close();
    openStore({ path }).close();
    const snapshot = (): unknown => {
      const raw = new DatabaseSync(path);
      try {
        return { reports: dump(raw, 'kit_reports', 'rowid'), indexes: indexNames(raw) };
      } finally {
        raw.close();
      }
    };
    const once = snapshot();
    const b = openStore({ path });
    expect(b.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    b.close();
    openStore({ path }).close();
    expect(snapshot()).toEqual(once);
    expect((once as { indexes: string[] }).indexes.filter((n) => n === INDEX)).toHaveLength(1);
  });

  it('a fresh database lands on the same indexes as an upgraded one', () => {
    const fresh = memDb();
    openStore({ db: fresh });
    const upgraded = memDb();
    openAt18(upgraded).close();
    openStore({ db: upgraded });
    expect(indexNames(fresh)).toEqual(indexNames(upgraded));
  });

  it('a failing migration 19 rolls back whole: version 18, no index, rows intact, and it still upgrades afterwards', () => {
    const db = memDb();
    openAt18(db, 20).close();
    const rows = dump(db, 'kit_reports', 'rowid');
    const broken = [...MIGRATIONS.slice(0, 18), { version: 19, sql: `${M19?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: MIGRATIONS.slice(0, 18) }).schemaVersion()).toBe(18);
    expect(indexNames(db)).not.toContain(INDEX);
    expect(dump(db, 'kit_reports', 'rowid')).toEqual(rows);
    expect(openStore({ db }).schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(indexNames(db)).toContain(INDEX);
  });
});

describe('reporterOutcomes on SQLite', () => {
  it('the real SQL is answered from the covering index: no table read, no SCAN of kit_reports', () => {
    const db = memDb();
    const store = openStore({ db });
    seed(store, 60);
    const seen = record(db, () => void store.reporterOutcomes(['s_rep1', 's_rep2', 's_rep3'], NOW - 30 * DAY));
    const hits = seen.filter((s) => /^\s*SELECT/i.test(s.sql) && s.sql.includes('kit_reports'));
    expect(hits).toHaveLength(1);
    const plan = planOf(db, hits[0] as Seen);
    const line = plan.find((l) => l.includes('kit_reports'));
    expect(line, plan.join(' | ')).toMatch(/^SEARCH kit_reports USING COVERING INDEX kit_reports_by_reporter_outcome/);
    expect(plan.join(' | ')).not.toMatch(/SCAN kit_reports/);
  });

  it('a 501-reporter call is chunked and the totals match the memory store (differential)', () => {
    const db = memDb();
    const sql = openStore({ db });
    const mem = new MemoryStore();
    seed(sql, 520);
    seq = 0;
    // The same sequence of ids and times, so both stores hold the same reports.
    seed(mem, 520);
    const reporters = Array.from({ length: 520 }, (_, i) => `s_rep${i}`);
    const since = NOW - 20 * DAY;
    const seen = record(db, () => void sql.reporterOutcomes(reporters, since));
    // 520 variables + since cannot be one statement under a 500 cap: at least two statements were issued.
    expect(seen.filter((s) => s.sql.includes('kit_reports')).length).toBeGreaterThanOrEqual(2);
    for (const s of seen) expect(s.args.length).toBeLessThanOrEqual(501);
    const a = sorted(sql.reporterOutcomes(reporters, since));
    const b = sorted(mem.reporterOutcomes(reporters, since));
    expect(a.length).toBeGreaterThan(100);
    expect(a).toEqual(b);
    // A tight window and the whole history agree too.
    expect(sorted(sql.reporterOutcomes(reporters, NOW - 5 * DAY))).toEqual(sorted(mem.reporterOutcomes(reporters, NOW - 5 * DAY)));
    expect(sorted(sql.reporterOutcomes(reporters, 0))).toEqual(sorted(mem.reporterOutcomes(reporters, 0)));
  });

  it('a reporter listed twice is counted once per stored row, not twice', () => {
    const db = memDb();
    const store = openStore({ db });
    fileOn(store, 's_dup', 'dismissed', NOW);
    expect(store.reporterOutcomes(['s_dup', 's_dup'], 0)).toEqual([{ reporter: 's_dup', actioned: 0, noAction: 1, badFaith: 0 }]);
    // Even when the two copies land in different chunks of a long list.
    const filler = Array.from({ length: 600 }, (_, i) => `s_none${i}`);
    expect(store.reporterOutcomes(['s_dup', ...filler, 's_dup'], 0)).toEqual([{ reporter: 's_dup', actioned: 0, noAction: 1, badFaith: 0 }]);
  });
});
