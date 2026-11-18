import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredReport } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';
import { insertOldReport } from './oldRows.js';

// Migration 26, the staff-scope block (spec 4.2 and section 7): `kit_reports.scope`, the index `kit_reports_by_scope` and the one-statement backfill from the room tags. Shared
// migration: the assertions are about this block's names only, never about the number of migrations or other themes' columns.

const NOW = 1_800_000_000_000;
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});
const memDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return db;
};
const UP_TO_25 = MIGRATIONS.slice(0, 25);
const columns = (db: DatabaseSync, table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
const indexes = (db: DatabaseSync): string[] => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all().map((r) => String(r.name));

const old = (id: string, tags: Record<string, string>, i: number): StoredReport => ({
  id,
  createdAt: NOW + i,
  roomId: `R${i}`,
  tags,
  reporterSubject: `s_r${i}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: 's_t',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'spam',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
});

describe('migration 26, the scope block, from a version-25 database', () => {
  it('a 25 database upgrades: kit_reports.scope exists with kit_reports_by_scope; the backfill copies tags.scope and leaves rooms with none NULL', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_25 });
    expect(columns(db, 'kit_reports')).not.toContain('scope');
    expect(indexes(db)).not.toContain('kit_reports_by_scope');
    insertOldReport(db, old('r_alice', { scope: 'creator:alice', mode: 'ranked' }, 1));
    insertOldReport(db, old('r_bob', { scope: 'creator:bob' }, 2));
    insertOldReport(db, old('r_none', { mode: 'ranked' }, 3));
    insertOldReport(db, old('r_empty', {}, 4));
    insertOldReport(db, old('r_num', { scopes: 'creator:alice' }, 5));

    const store = openStore({ db });
    expect(columns(db, 'kit_reports')).toContain('scope');
    expect(indexes(db)).toContain('kit_reports_by_scope');
    const scopes = Object.fromEntries(db.prepare('SELECT id, scope FROM kit_reports').all().map((r) => [String(r.id), r.scope]));
    expect(scopes).toEqual({ r_alice: 'creator:alice', r_bob: 'creator:bob', r_none: null, r_empty: null, r_num: null });
    expect(store.loadReport('r_alice')?.scope).toBe('creator:alice');
    expect(store.loadReport('r_none')?.scope).toBeNull();
    expect(store.listReports({ limit: 10, scope: ['creator:alice'] }).map((r) => r.id)).toEqual(['r_alice']);
    expect(store.listReports({ limit: 10 })).toHaveLength(5);
  });

  it('the backfill leaves every other column of an old report alone', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_25 });
    insertOldReport(db, old('r1', { scope: 'creator:alice' }, 1));
    const before = db.prepare('SELECT id, created_at, room_id, tags_json, target_subject, status, note FROM kit_reports').all();
    openStore({ db });
    expect(db.prepare('SELECT id, created_at, room_id, tags_json, target_subject, status, note FROM kit_reports').all()).toEqual(before);
  });

  it('the column is plain nullable TEXT with no default, and the index is (scope, status, created_at)', () => {
    const db = memDb();
    openStore({ db });
    const info = db.prepare('PRAGMA table_info(kit_reports)').all().find((c) => c.name === 'scope');
    expect(info).toBeDefined();
    expect(String(info?.type)).toBe('TEXT');
    expect(Number(info?.notnull)).toBe(0);
    expect(info?.dflt_value).toBeNull();
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_reports_by_scope'").get()?.sql)).toMatch(/\(scope, status, created_at\)/);
  });

  it('a database migrated from 25 has the same scope schema as a fresh one', () => {
    const a = memDb();
    openStore({ db: a });
    const b = memDb();
    openStore({ db: b, migrations: UP_TO_25 });
    openStore({ db: b });
    expect(indexes(b)).toEqual(indexes(a));
    expect(columns(b, 'kit_reports').sort()).toEqual(columns(a, 'kit_reports').sort());
  });

  it('a rerun of the block is refused: its statements fail on a database that already has them', () => {
    const db = memDb();
    openStore({ db });
    const sql = MIGRATIONS.find((m) => m.version === 26)?.sql ?? '';
    expect(sql).toContain('kit_reports_by_scope');
    expect(() => db.exec(sql)).toThrow();
    expect(() => openStore({ db })).not.toThrow();
  });

  it('insertReport writes the scope column; a report without one writes NULL', () => {
    const db = memDb();
    const store = openStore({ db });
    store.insertReport({ ...old('a', { scope: 'creator:alice' }, 1), scope: 'creator:alice' });
    store.insertReport(old('b', { scope: 'creator:alice' }, 2));
    expect(db.prepare('SELECT id, scope FROM kit_reports ORDER BY id').all().map((r) => ({ ...r }))).toEqual([
      { id: 'a', scope: 'creator:alice' },
      { id: 'b', scope: null },
    ]);
  });
});

describe('the scope reads use kit_reports_by_scope (EXPLAIN QUERY PLAN)', () => {
  /** Run `fn` and answer the plan of the last SELECT the store prepared, exactly as issued. */
  function planOf(db: DatabaseSync, fn: () => unknown): string {
    const seen: Array<{ sql: string; args: unknown[] }> = [];
    const real = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const st = real(sql);
      return new Proxy(st, {
        get(target, prop) {
          const v = (target as unknown as Record<string | symbol, unknown>)[prop];
          if (typeof v !== 'function') return v;
          if (prop === 'all' || prop === 'get' || prop === 'run') {
            return (...args: unknown[]) => {
              seen.push({ sql, args });
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return v.bind(target);
        },
      });
    }) as typeof db.prepare;
    fn();
    db.prepare = real as typeof db.prepare;
    const last = seen.filter((x) => /^\s*SELECT/i.test(x.sql) && !/kit_meta/.test(x.sql)).at(-1);
    expect(last, 'the read prepared a SELECT').toBeDefined();
    return real(`EXPLAIN QUERY PLAN ${last?.sql ?? ''}`)
      .all(...((last?.args ?? []) as Array<string | number | null>))
      .map((r) => String(r.detail))
      .join(' | ');
  }

  it('listReports and listOpenReports with a scope search kit_reports_by_scope; the unscoped read does not', () => {
    const db = memDb();
    const store = openStore({ db });
    for (let i = 0; i < 5; i += 1) store.insertReport({ ...old(`r${i}`, {}, i), scope: i % 2 === 0 ? 'creator:alice' : 'creator:bob' });
    expect(planOf(db, () => store.listReports({ limit: 10, scope: ['creator:alice'] }))).toMatch(/kit_reports_by_scope/);
    expect(planOf(db, () => store.listReports({ limit: 10, scope: ['creator:alice', 'creator:bob'], status: 'open' }))).toMatch(/kit_reports_by_scope/);
    expect(planOf(db, () => store.listOpenReports({ limit: 10, scope: ['creator:alice'] }))).toMatch(/kit_reports_by_scope/);
    expect(planOf(db, () => store.listOpenReports({ limit: 10, scope: ['creator:alice', 'creator:bob'] }))).toMatch(/kit_reports_by_scope/);
    expect(planOf(db, () => store.listReports({ limit: 10 }))).not.toMatch(/kit_reports_by_scope/);
  });

  it('the scope text is bound, never put in the statement', () => {
    const db = memDb();
    const store = openStore({ db });
    store.insertReport({ ...old('r1', {}, 1), scope: 'creator:alice' });
    const attack = "creator:alice') OR 1=1 --";
    expect(store.listReports({ limit: 10, scope: [attack] })).toEqual([]);
    expect(store.listOpenReports({ limit: 10, scope: [attack] })).toEqual([]);
    expect(store.loadReportInScope('r1', [attack])).toBeNull();
    expect(store.countOpenUrgent?.([attack])).toBe(0);
  });
});
