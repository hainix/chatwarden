import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredReport } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

// Migration 26, blocks 1 and 2 (chat filters): two columns and two indexes on kit_reports, and kit_filter_hits. The migration is shared by the whole
// release, so every assertion is about the schema AFTER it ran (set membership), never about the number being the last.

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
const names = (db: DatabaseSync, type: 'table' | 'index'): string[] =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`).all().map((r) => String(r.name));
const columns = (db: DatabaseSync, table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
const dump = (db: DatabaseSync, table: string, order: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();

/** A report row as version 25 wrote it: no origin columns. */
function rawReport(db: DatabaseSync, i: number): void {
  db.prepare(
    `INSERT INTO kit_reports (id, created_at, room_id, tags_json, reporter_subject, reporter_seat, reporter_handle, target_subject, target_seat, target_handle,
       category, reported_reason, note, line_id, excerpt_json, people_json, status) VALUES (?, ?, ?, '{}', ?, 'p1', 'Rep', ?, 'p2', 'Tgt', 'spam', 'spam', NULL, NULL, '[]', '[]', 'open')`,
  ).run(`m${i}`, NOW - i, `ROOM-${i}`, `s_rep${i}`, `s_tgt${i}`);
}

const filterReport = (id: string, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: NOW,
  roomId: 'ROOM1',
  tags: {},
  reporterSubject: `filter:${id}`,
  reporterSeat: '',
  reporterHandle: '',
  targetSubject: 's_tgt',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'spam',
  reportedReason: 'spam',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
  origin: 'filter',
  originKey: 'link.unlisted',
  ...over,
});

describe('migration 26 (filters blocks)', () => {
  it('migration 26 exists, versions run 1..N without a gap, 27 (release 0.2.1) and 28 (release 0.2.2) exist and no version 29 was added', () => {
    expect(MIGRATIONS.find((m) => m.version === 26)).toBeDefined();
    expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1));
    expect(MIGRATIONS.find((m) => m.version === 27)).toBeDefined();
    expect(MIGRATIONS.find((m) => m.version === 28)).toBeDefined();
    expect(MIGRATIONS.find((m) => m.version === 29)).toBeUndefined();
  });

  it('from an empty database adds origin and origin_key to kit_reports, their two indexes, and kit_filter_hits', () => {
    const db = memDb();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(26);
    expect(columns(db, 'kit_reports')).toEqual(expect.arrayContaining(['origin', 'origin_key']));
    expect(names(db, 'index')).toEqual(expect.arrayContaining(['kit_reports_open_filter', 'kit_reports_by_origin']));
    expect(columns(db, 'kit_filter_hits')).toEqual(['day', 'key', 'action', 'hits']);
    expect(names(db, 'table')).toContain('kit_filter_hits');
    const hits = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_filter_hits'").get() as { sql: string };
    expect(hits.sql).toMatch(/WITHOUT ROWID/);
  });

  it('migration 26 blocks 1 and 2 from an earlier database keep every report row and add the columns, indexes and kit_filter_hits', () => {
    const db = memDb();
    const old = openStore({ db, migrations: UP_TO_25 });
    for (let i = 0; i < 12; i++) rawReport(db, i);
    old.close();
    const before = dump(db, 'kit_reports', 'rowid');
    const tables = names(db, 'table');
    const indexes = names(db, 'index');
    const columnsBefore = columns(db, 'kit_reports');

    const store = openStore({ db });
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(26);
    const after = dump(db, 'kit_reports', 'rowid') as Array<Record<string, unknown>>;
    expect(after).toHaveLength(12);
    // every old column of every old row is unchanged, and the new ones are NULL
    expect(after.map((r) => Object.fromEntries(columnsBefore.map((c) => [c, r[c]])))).toEqual(before);
    for (const r of after) expect([r.origin, r.origin_key]).toEqual([null, null]);
    expect(columns(db, 'kit_reports').slice(0, columnsBefore.length)).toEqual(columnsBefore);
    expect(names(db, 'table')).toEqual(expect.arrayContaining(['kit_filter_hits']));
    expect(names(db, 'table').filter((x) => !tables.includes(x))).toContain('kit_filter_hits');
    const added = names(db, 'index').filter((x) => !indexes.includes(x) && !x.startsWith('sqlite_autoindex'));
    expect(added).toEqual(expect.arrayContaining(['kit_reports_open_filter', 'kit_reports_by_origin']));
    // the old rows still read through the store, as ordinary reports
    expect(store.loadReport('m3')).toMatchObject({ origin: null, originKey: null, reporterSubject: 's_rep3' });
    store.close();
    // reopening runs nothing again and changes nothing
    const again = openStore({ db });
    expect(dump(db, 'kit_reports', 'rowid')).toEqual(after);
    again.close();
  });

  it('the check on origin refuses a word that is not filter or watch', () => {
    const db = memDb();
    openStore({ db });
    const bad = () =>
      db
        .prepare(
          `INSERT INTO kit_reports (id, created_at, room_id, tags_json, reporter_subject, reporter_seat, reporter_handle, target_subject, target_seat, target_handle,
             category, note, line_id, excerpt_json, people_json, status, origin) VALUES ('x', 1, 'r', '{}', 'a', '', '', 'b', '', '', 'spam', NULL, NULL, '[]', '[]', 'open', 'robot')`,
        )
        .run();
    expect(bad).toThrow(/CHECK/i);
  });

  it('kit_filter_hits refuses an unknown action word', () => {
    const db = memDb();
    openStore({ db });
    expect(() => db.prepare("INSERT INTO kit_filter_hits (day, key, action, hits) VALUES (1, 'k', 'hide', 1)").run()).toThrow(/CHECK/i);
    expect(() => db.prepare("INSERT INTO kit_filter_hits (day, key, action, hits) VALUES (1, 'k', 'flag_capped', 1)").run()).not.toThrow();
  });

  it('the partial unique index is a unique, partial index on (target_subject, room_id) for open filter reports', () => {
    const db = memDb();
    const store = openStore({ db });
    const list = db.prepare('PRAGMA index_list(kit_reports)').all() as Array<{ name: string; unique: number; partial: number }>;
    const idx = list.find((i) => i.name === 'kit_reports_open_filter');
    expect(idx).toMatchObject({ unique: 1, partial: 1 });
    expect(db.prepare('PRAGMA index_info(kit_reports_open_filter)').all().map((r) => String(r.name))).toEqual(['target_subject', 'room_id']);
    // the store's insert uses it: a second open filter report is refused (false) and a closed one frees the slot
    expect(store.insertReport(filterReport('f1'))).toBe(true);
    expect(store.insertReport(filterReport('f2'))).toBe(false);
    store.closeReport('f1', 'dismissed', false, 'mod', NOW + 1, 'n');
    expect(store.insertReport(filterReport('f3'))).toBe(true);
    const sql = "SELECT id FROM kit_reports WHERE origin = 'filter' AND status = 'open' AND target_subject = ? AND room_id = ?";
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('s_tgt', 'ROOM1').map((r) => String(r.detail));
    expect(plan.join('\n')).toContain('kit_reports_open_filter');
  });

  it('the by-origin index serves the daily cap count', () => {
    const db = memDb();
    openStore({ db });
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM kit_reports WHERE origin = ? AND created_at >= ?')
      .all('filter', NOW)
      .map((r) => String(r.detail));
    expect(plan.join('\n')).toContain('kit_reports_by_origin');
  });

  it('a failure inside the migration leaves the old version and the old rows', () => {
    const db = memDb();
    const old = openStore({ db, migrations: UP_TO_25 });
    rawReport(db, 1);
    old.close();
    const m26 = MIGRATIONS.find((m) => m.version === 26);
    const broken = [...UP_TO_25, { version: 26, sql: `${m26?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: UP_TO_25 }).schemaVersion()).toBe(25);
    expect(columns(db, 'kit_reports')).not.toContain('origin');
    expect(names(db, 'table')).not.toContain('kit_filter_hits');
    expect(dump(db, 'kit_reports', 'rowid')).toHaveLength(1);
  });
});
