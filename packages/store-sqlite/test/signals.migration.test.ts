import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiReadPending, StoredReport } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';
import type { SqliteStore } from '../src/index.js';

// Migration 21: signal rows (flood control and signals). One new table with three indexes, and one nullable column on kit_ai_reads. One-way,
// wrapped by the runner in one savepoint with the version bump.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

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
  const d = mkdtempSync(join(tmpdir(), 'cw-sigmig-'));
  dirs.push(d);
  return join(d, 'kit.db');
};

const UP_TO_21 = MIGRATIONS.slice(0, 21);
const M21 = MIGRATIONS.find((m) => m.version === 21);
const NEW_INDEXES = ['kit_signals_by_at', 'kit_signals_by_subject', 'kit_signals_cap'];
const AI_COLUMNS_20 = [
  'id', 'report_id', 'input_hash', 'status', 'attempts', 'retry_at', 'lease_until', 'error_kind', 'adapter', 'model', 'prompt_version',
  'severity', 'rule', 'summary', 'evidence_json', 'confidence', 'injection', 'rec_json', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'cost_micros', 'latency_ms', 'example_ids', 'created_at', 'retaken',
];

const names = (db: DatabaseSync, type: 'table' | 'index'): string[] =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`).all().map((r) => String(r.name));
const columns = (db: DatabaseSync, table: string): string[] =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
const dump = (db: DatabaseSync, table: string, order: string, cols = '*'): unknown[] => db.prepare(`SELECT ${cols} FROM ${table} ORDER BY ${order}`).all();

const report = (i: number): StoredReport => ({
  id: `m${String(i).padStart(4, '0')}`,
  createdAt: NOW - i * 1000,
  roomId: `ROOM-${i}`,
  tags: { mode: 'ranked' },
  reporterSubject: `s_rep${i % 9}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: `s_tgt${i % 5}`,
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  reportedReason: 'harassment',
  note: i % 2 === 0 ? 'rude' : null,
  lineId: null,
  excerpt: [],
  people: [`s_tgt${i % 5}`],
  status: 'open',
});
const pending = (i: number): AiReadPending => ({ reportId: `m${String(i).padStart(4, '0')}`, inputHash: `h${i}`, promptVersion: 1, adapter: 'fake:one' });

/** A database at version 20 with reports, AI reads (with spend), an outcome-free casebook, a reason, a claim and an audit row. */
function openAt20(db: DatabaseSync): SqliteStore {
  const store = openStore({ db, migrations: MIGRATIONS.slice(0, 20) });
  expect(store.schemaVersion()).toBe(20);
  for (let i = 0; i < 15; i++) {
    store.insertReport(report(i));
    store.reserveAiRead(pending(i), NOW + 60_000, NOW + i);
  }
  store.insertReason({ id: 'rs1', label: 'L', text: 'T', active: true });
  store.claimCase('s_tgt1', 'mod', NOW, NOW + DAY, 'free');
  store.insertAudit({ id: 'a1', at: NOW, actor: 'mod', role: 'moderator', action: 'report.view', target: { type: 'report', ref: 'm0001' } });
  return store;
}
const OLD_TABLES = ['kit_reports', 'kit_ai_spend', 'kit_ai_outcomes', 'kit_audit', 'kit_claims', 'kit_reasons'];
const snapshot = (db: DatabaseSync): unknown => ({
  reports: dump(db, 'kit_reports', 'rowid'),
  // Every kit_ai_reads column as it was at version 20: the new one is read on its own below.
  reads: dump(db, 'kit_ai_reads', 'rowid', AI_COLUMNS_20.join(', ')),
  spend: dump(db, 'kit_ai_spend', 'read_id, attempt'),
  audit: dump(db, 'kit_audit', 'rowid'),
  claims: dump(db, 'kit_claims', 'person'),
  reasons: dump(db, 'kit_reasons', 'rowid'),
  meta: db.prepare("SELECT key, value FROM kit_meta WHERE key <> 'schema_version' ORDER BY key").all(),
});

describe('migration 21: signal rows', () => {
  it('is the 21st migration and the last one', () => {
    expect(M21).toBeDefined();
    expect(MIGRATIONS[20]?.version).toBe(21);
    expect(MIGRATIONS.map((m) => m.version).slice(0, 21)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
  });

  it('from an empty database creates kit_signals and its three indexes, and kit_ai_reads gains signals_json', () => {
    const db = memDb();
    const store = openStore({ db, migrations: UP_TO_21 });
    expect(store.schemaVersion()).toBe(21);
    expect(names(db, 'table')).toContain('kit_signals');
    for (const i of NEW_INDEXES) expect(names(db, 'index')).toContain(i);
    expect(columns(db, 'kit_signals')).toEqual(['id', 'kind', 'subject_id', 'source_key', 'by_subject', 'room_id', 'at', 'weight', 'cap_bucket']);
    expect(columns(db, 'kit_ai_reads')).toEqual([...AI_COLUMNS_20, 'signals_json']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM kit_signals').get()).toEqual({ n: 0 });
  });

  it('from a version 20 database with rows keeps every row, adds only the table, its indexes and the column', () => {
    const db = memDb();
    openAt20(db).close();
    const before = snapshot(db);
    const tables = names(db, 'table');
    const indexes = names(db, 'index');
    const cols = Object.fromEntries(OLD_TABLES.filter((t) => t !== 'kit_ai_reads').map((t) => [t, columns(db, t)]));

    const store = openStore({ db, migrations: UP_TO_21 });
    expect(store.schemaVersion()).toBe(21);
    expect(snapshot(db)).toEqual(before);
    expect(names(db, 'table').filter((x) => !tables.includes(x))).toEqual(['kit_signals']);
    expect(names(db, 'index').filter((x) => !indexes.includes(x) && !x.startsWith('sqlite_autoindex'))).toEqual(NEW_INDEXES);
    for (const t of Object.keys(cols)) expect(columns(db, t)).toEqual(cols[t]);
    store.close();

    // Reopening runs nothing again and changes nothing.
    const again = openStore({ db, migrations: UP_TO_21 });
    expect(again.schemaVersion()).toBe(21);
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('the ALTER leaves existing kit_ai_reads rows readable and signals_json null', () => {
    const db = memDb();
    const old = openAt20(db);
    const readsBefore = Array.from({ length: 15 }, (_, i) => old.loadAiRead(`m${String(i).padStart(4, '0')}`));
    expect(db.prepare('SELECT COUNT(*) AS n FROM kit_ai_reads').get()).toEqual({ n: 15 });
    old.close();
    const store = openStore({ db, migrations: UP_TO_21 });
    const readsAfter = Array.from({ length: 15 }, (_, i) => store.loadAiRead(`m${String(i).padStart(4, '0')}`));
    expect(readsAfter).toEqual(readsBefore);
    expect(db.prepare('SELECT COUNT(*) AS n, COUNT(signals_json) AS set_n FROM kit_ai_reads').get()).toEqual({ n: 15, set_n: 0 });
    // A new read after the upgrade works as before.
    expect(store.reserveAiRead(pending(99), NOW + 60_000, NOW)).toMatchObject({ reserved: true });
  });

  it('a version 18 database with rows upgrades through 19, 20 and 21 without changing data', () => {
    const db = memDb();
    const s = openStore({ db, migrations: MIGRATIONS.slice(0, 18) });
    for (let i = 0; i < 10; i++) s.insertReport(report(i));
    s.close();
    const before = dump(db, 'kit_reports', 'rowid');
    const store = openStore({ db, migrations: UP_TO_21 });
    expect(store.schemaVersion()).toBe(21);
    expect(dump(db, 'kit_reports', 'rowid')).toEqual(before);
  });

  it('a rerun of the migration is refused (it is one-way: the table and the column exist)', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_21 }).close();
    expect(() => db.exec(M21?.sql ?? '')).toThrow();
    expect(names(db, 'index').filter((x) => x === 'kit_signals_cap')).toHaveLength(1);
  });

  it('the weight CHECK refuses a negative weight', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_21 }).close();
    let bucket = 0;
    const put = (w: number) => db.prepare("INSERT INTO kit_signals (id, kind, subject_id, source_key, at, weight, cap_bucket) VALUES (?, 'k', 's', 'd:1', 1, ?, ?)").run(`id${w}`, w, (bucket += 1));
    expect(() => put(-0.01)).toThrow(/CHECK/);
    expect(() => put(0)).not.toThrow();
    expect(() => put(2.5)).not.toThrow();
  });

  it('is idempotent on a file: reopening twice leaves the same schema and rows', () => {
    const path = filePath();
    const seeded = new DatabaseSync(path);
    dbs.push(seeded);
    openAt20(seeded).close();
    openStore({ path, migrations: UP_TO_21 }).close();
    const shot = (): unknown => {
      const raw = new DatabaseSync(path);
      try {
        return { data: snapshot(raw), tables: names(raw, 'table'), indexes: names(raw, 'index') };
      } finally {
        raw.close();
      }
    };
    const once = shot();
    openStore({ path, migrations: UP_TO_21 }).close();
    openStore({ path, migrations: UP_TO_21 }).close();
    expect(shot()).toEqual(once);
  });

  it('a fresh database lands on the same tables, indexes and columns as an upgraded one', () => {
    const fresh = memDb();
    openStore({ db: fresh, migrations: UP_TO_21 });
    const upgraded = memDb();
    openAt20(upgraded).close();
    openStore({ db: upgraded, migrations: UP_TO_21 });
    expect(names(fresh, 'table')).toEqual(names(upgraded, 'table'));
    expect(names(fresh, 'index')).toEqual(names(upgraded, 'index'));
    for (const t of ['kit_signals', 'kit_ai_reads']) expect(columns(fresh, t)).toEqual(columns(upgraded, t));
  });

  it('a failing migration 21 rolls back whole: version 20, no table, no column, rows intact, and it still upgrades afterwards', () => {
    const db = memDb();
    openAt20(db).close();
    const before = snapshot(db);
    const broken = [...MIGRATIONS.slice(0, 20), { version: 21, sql: `${M21?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: MIGRATIONS.slice(0, 20) }).schemaVersion()).toBe(20);
    expect(names(db, 'table')).not.toContain('kit_signals');
    for (const i of NEW_INDEXES) expect(names(db, 'index')).not.toContain(i);
    expect(columns(db, 'kit_ai_reads')).toEqual(AI_COLUMNS_20);
    expect(snapshot(db)).toEqual(before);
    expect(openStore({ db, migrations: UP_TO_21 }).schemaVersion()).toBe(21);
    expect(names(db, 'table')).toContain('kit_signals');
  });

  it('an older kit refuses a database at version 21', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_21 }).close();
    expect(() => openStore({ db, migrations: MIGRATIONS.slice(0, 20) })).toThrow(/newer than this kit supports/);
  });

  it('the shared contract works on an upgraded database too', () => {
    const db = memDb();
    openAt20(db).close();
    const store = openStore({ db, migrations: UP_TO_21 });
    const row = { id: 's1', kind: 'muted_by_player', subject: 's_t', sourceKey: 'b:s_f', bySubject: 's_f', roomId: null, at: NOW, weight: 1, capBucket: 1 };
    expect(store.insertSignal(row)).toBe(true);
    expect(store.insertSignal({ ...row, id: 's2' })).toBe(false);
    expect(store.listSignalSources(['s_t'], 0)).toHaveLength(1);
    expect(store.purgeSignals(NOW + 1)).toBe(1);
  });
});
