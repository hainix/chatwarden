import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredReport } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';
import type { SqliteStore } from '../src/index.js';

// Migration 20: the AI read rows and the casebook (AI levels 1 and 2). One-way: two new tables and their indexes, no change to any
// existing table or row.

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
  const d = mkdtempSync(join(tmpdir(), 'cw-ai-'));
  dirs.push(d);
  return join(d, 'kit.db');
};

const M20 = MIGRATIONS.find((m) => m.version === 20);
const NEW_TABLES = ['kit_ai_outcomes', 'kit_ai_reads'];
const NEW_INDEXES = ['kit_ai_outcomes_by_rule', 'kit_ai_reads_by_report', 'kit_ai_reads_by_time', 'kit_ai_reads_retry'];

const names = (db: DatabaseSync, type: 'table' | 'index'): string[] =>
  db
    .prepare(`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`)
    .all()
    .map((r) => String(r.name));
const dump = (db: DatabaseSync, table: string, order: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
const columns = (db: DatabaseSync, table: string): string[] =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => String(r.name));

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

/** A database at `version` with reports, a reason, a claim and an audit row in it. */
function openAt(db: DatabaseSync, version: number, reports = 25): SqliteStore {
  const store = openStore({ db, migrations: MIGRATIONS.slice(0, version) });
  expect(store.schemaVersion()).toBe(version);
  for (let i = 0; i < reports; i++) store.insertReport(report(i));
  store.closeReport('m0001', 'actioned', false, 'mod', NOW, 'n');
  store.insertReason({ id: 'rs1', label: 'L', text: 'T', active: true });
  store.claimCase('s_tgt1', 'mod', NOW, NOW + DAY, 'free');
  store.insertAudit({ id: 'a1', at: NOW, actor: 'mod', role: 'moderator', action: 'report.view', target: { type: 'report', ref: 'm0001' } });
  return store;
}
const OLD_TABLES = ['kit_audit', 'kit_claims', 'kit_reports', 'kit_reasons'];
const snapshot = (db: DatabaseSync): unknown => ({
  reports: dump(db, 'kit_reports', 'rowid'),
  audit: dump(db, 'kit_audit', 'rowid'),
  claims: dump(db, 'kit_claims', 'person'),
  reasons: dump(db, 'kit_reasons', 'rowid'),
  meta: db.prepare("SELECT key, value FROM kit_meta WHERE key <> 'schema_version' ORDER BY key").all(),
});

describe('migration 20: AI reads and outcomes', () => {
  it('is the 20th migration and the last one', () => {
    expect(M20).toBeDefined();
    expect(MIGRATIONS[19]?.version).toBe(20);
    expect(MIGRATIONS.at(-1)?.version).toBe(20);
    expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('migration 20 on a fresh database creates both tables and the indexes', () => {
    const db = memDb();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(20);
    for (const t of NEW_TABLES) expect(names(db, 'table')).toContain(t);
    for (const i of NEW_INDEXES) expect(names(db, 'index')).toContain(i);
    expect(columns(db, 'kit_ai_reads')).toEqual([
      'id', 'report_id', 'input_hash', 'status', 'attempts', 'retry_at', 'lease_until', 'error_kind', 'adapter', 'model', 'prompt_version',
      'severity', 'rule', 'summary', 'evidence_json', 'confidence', 'injection', 'rec_json', 'input_tokens', 'output_tokens',
      'cache_read_tokens', 'cache_write_tokens', 'cost_micros', 'latency_ms', 'created_at',
    ]);
    expect(columns(db, 'kit_ai_outcomes')).toEqual([
      'report_id', 'read_id', 'decided_at', 'level', 'verdict', 'rule', 'severity', 'ai_verdict', 'agreement', 'detail_json', 'reversed',
      'dont_teach', 'bad_faith', 'example_json',
    ]);
  });

  it('migration 20 from a version 19 database with rows is idempotent and changes no data', () => {
    const db = memDb();
    openAt(db, 19).close();
    const before = snapshot(db);
    const tables = names(db, 'table');
    const indexes = names(db, 'index');
    const cols = Object.fromEntries(OLD_TABLES.map((t) => [t, columns(db, t)]));

    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(20);
    expect(snapshot(db)).toEqual(before);
    expect(names(db, 'table').filter((n) => !tables.includes(n))).toEqual(NEW_TABLES);
    expect(names(db, 'index').filter((n) => !indexes.includes(n) && !n.startsWith('sqlite_autoindex'))).toEqual(NEW_INDEXES);
    for (const t of OLD_TABLES) expect(columns(db, t)).toEqual(cols[t]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM kit_ai_reads').get()).toEqual({ n: 0 });
    store.close();

    // Reopening runs nothing again and changes nothing.
    const again = openStore({ db });
    expect(again.schemaVersion()).toBe(20);
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('migration 20 from a version 18 database with rows is idempotent and changes no data', () => {
    const db = memDb();
    openAt(db, 18).close();
    const before = snapshot(db);
    const store = openStore({ db }); // runs 19 and 20
    expect(store.schemaVersion()).toBe(20);
    expect(snapshot(db)).toEqual(before);
    store.close();
    expect(openStore({ db }).schemaVersion()).toBe(20);
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('the older reads answer the same after the upgrade', () => {
    const db = memDb();
    const old = openAt(db, 19, 40);
    const reads = (s: SqliteStore) => ({ list: s.listReports({ limit: 50 }), tally: s.reporterTally(['s_rep1', 's_rep2']), token: s.changeToken() });
    const expected = reads(old);
    old.close();
    expect(reads(openStore({ db }))).toEqual(expected);
  });

  it('is idempotent on a file: reopening twice leaves the same schema and rows', () => {
    const path = filePath();
    const seeded = new DatabaseSync(path);
    dbs.push(seeded);
    openAt(seeded, 19).close();
    openStore({ path }).close();
    const shot = (): unknown => {
      const raw = new DatabaseSync(path);
      try {
        return { data: snapshot(raw), tables: names(raw, 'table'), indexes: names(raw, 'index') };
      } finally {
        raw.close();
      }
    };
    const once = shot();
    openStore({ path }).close();
    openStore({ path }).close();
    expect(shot()).toEqual(once);
    const idx = (once as { indexes: string[] }).indexes;
    for (const i of NEW_INDEXES) expect(idx.filter((n) => n === i)).toHaveLength(1);
  });

  it('a fresh database lands on the same tables and indexes as an upgraded one', () => {
    const fresh = memDb();
    openStore({ db: fresh });
    const upgraded = memDb();
    openAt(upgraded, 19, 3).close();
    openStore({ db: upgraded });
    expect(names(fresh, 'table')).toEqual(names(upgraded, 'table'));
    expect(names(fresh, 'index')).toEqual(names(upgraded, 'index'));
  });

  it('a failing migration 20 rolls back whole: version 19, neither table, rows intact, and it still upgrades afterwards', () => {
    const db = memDb();
    openAt(db, 19, 10).close();
    const before = snapshot(db);
    const broken = [...MIGRATIONS.slice(0, 19), { version: 20, sql: `${M20?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: MIGRATIONS.slice(0, 19) }).schemaVersion()).toBe(19);
    for (const t of NEW_TABLES) expect(names(db, 'table')).not.toContain(t);
    for (const i of NEW_INDEXES) expect(names(db, 'index')).not.toContain(i);
    expect(snapshot(db)).toEqual(before);
    expect(openStore({ db }).schemaVersion()).toBe(20);
    for (const t of NEW_TABLES) expect(names(db, 'table')).toContain(t);
  });

  it('an older kit refuses a database at version 20', () => {
    const db = memDb();
    openStore({ db }).close();
    expect(() => openStore({ db, migrations: MIGRATIONS.slice(0, 19) })).toThrow(/newer than this kit supports/);
  });
});

describe('the schema guards what the store relies on', () => {
  const insertRead = (db: DatabaseSync, id: string, over: Record<string, string | number | null> = {}): void => {
    const row = { id, report_id: 'r1', input_hash: 'h1', status: 'pending', prompt_version: 1, created_at: NOW, ...over };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO kit_ai_reads (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...Object.values(row));
  };
  const insertOutcome = (db: DatabaseSync, reportId: string, over: Record<string, string | number | null> = {}): void => {
    const row = { report_id: reportId, decided_at: NOW, level: 2, verdict: 'upheld', agreement: 'agree', detail_json: '{}', ...over };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO kit_ai_outcomes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...Object.values(row));
  };

  it('UNIQUE (report_id, input_hash) refuses a duplicate; another hash or report is fine', () => {
    const db = memDb();
    openStore({ db });
    insertRead(db, 'a');
    expect(() => insertRead(db, 'b')).toThrow(/UNIQUE/);
    expect(() => insertRead(db, 'c', { input_hash: 'h2' })).not.toThrow();
    expect(() => insertRead(db, 'd', { report_id: 'r2' })).not.toThrow();
  });

  it('the status column accepts exactly the six statuses', () => {
    const db = memDb();
    openStore({ db });
    let n = 0;
    for (const status of ['pending', 'ok', 'declined', 'invalid', 'failed', 'skipped']) {
      expect(() => insertRead(db, `s${n}`, { status, input_hash: `h${n++}` })).not.toThrow();
    }
    expect(() => insertRead(db, 'bad', { status: 'done', input_hash: 'hx' })).toThrow(/CHECK/);
  });

  it('the agreement column accepts exactly agree, override and none; one outcome per report', () => {
    const db = memDb();
    openStore({ db });
    for (const a of ['agree', 'override', 'none']) expect(() => insertOutcome(db, `o-${a}`, { agreement: a })).not.toThrow();
    expect(() => insertOutcome(db, 'o-bad', { agreement: 'maybe' })).toThrow(/CHECK/);
    expect(() => insertOutcome(db, 'o-agree')).toThrow(/UNIQUE|PRIMARY/);
  });

  it('the defaults: attempts, injection and cost start at 0; reversed, the marks and the example start empty', () => {
    const db = memDb();
    openStore({ db });
    insertRead(db, 'a');
    insertOutcome(db, 'o');
    expect(db.prepare('SELECT attempts, injection, cost_micros FROM kit_ai_reads').get()).toEqual({ attempts: 0, injection: 0, cost_micros: 0 });
    expect(db.prepare('SELECT reversed, dont_teach, bad_faith, example_json FROM kit_ai_outcomes').get()).toEqual({
      reversed: 0,
      dont_teach: 0,
      bad_faith: 0,
      example_json: null,
    });
  });
});
