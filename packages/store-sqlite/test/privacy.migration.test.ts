import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openStore } from '../src/index.js';

// Migration 26, blocks 4 and 5 (privacy requests): `kit_erasures`, the `erasure_epoch` row and four lookup indexes. The migration is shared by the whole release, so
// every assertion is about the schema AFTER it ran (set membership), never about the number being the last. Rows written at version 25 must all survive.

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
const count = (db: DatabaseSync, table: string): number => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
const TABLES = ['kit_subjects', 'kit_mutes', 'kit_strikes', 'kit_blocked_names', 'kit_signals', 'kit_sanctions'];

function seed25(db: DatabaseSync): void {
  db.prepare("INSERT INTO kit_subjects (id, created_at, merged_into) VALUES ('s_a', ?, NULL), ('s_b', ?, NULL)").run(NOW, NOW);
  db.prepare("INSERT INTO kit_mutes (viewer_id, target_id, created_at) VALUES ('s_a', 's_b', ?)").run(NOW);
  db.prepare("INSERT INTO kit_strikes (id, at, subject_id, room_id, term_id, raw_line) VALUES ('k1', ?, 's_a', 'R', 't', 'line')").run(NOW);
  db.prepare("INSERT INTO kit_blocked_names (id, subject_id, name, term_id, reason, at) VALUES ('b1', 's_a', 'n', NULL, 'name_profane', ?)").run(NOW);
  db.prepare("INSERT INTO kit_signals (id, kind, subject_id, source_key, by_subject, room_id, at, weight, cap_bucket) VALUES ('g1', 'k', 's_b', 'b:s_a', 's_a', NULL, ?, 1, 1)").run(NOW);
  db.prepare(
    `INSERT INTO kit_sanctions (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending, report_id)
     VALUES ('z1', 'g1', 'M-AAAAA', 'chat', 'subject', 's_a', ?, NULL, 'r', '1', 'mod', 'moderator', 0, 0, 'rep1')`,
  ).run(NOW);
}

describe('migration 26 blocks 4 and 5 from an earlier database', () => {
  it('adds kit_erasures, the epoch row and the four lookup indexes and keeps every row', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_25 });
    seed25(db);
    expect(names(db, 'table')).not.toContain('kit_erasures');
    const before = TABLES.map((t) => count(db, t));
    openStore({ db });
    expect(TABLES.map((t) => count(db, t))).toEqual(before);
    expect(names(db, 'table')).toContain('kit_erasures');
    expect(names(db, 'index')).toEqual(
      expect.arrayContaining(['kit_erasures_pending', 'kit_mutes_by_target', 'kit_blocked_names_by_subject', 'kit_signals_by_source', 'kit_sanctions_by_report']),
    );
    expect(db.prepare("SELECT value FROM kit_meta WHERE key = 'erasure_epoch'").get()?.value).toBe('0');
  });

  it('a fresh database has the same schema as one migrated from 25 (the same tables and indexes)', () => {
    const a = memDb();
    openStore({ db: a });
    const b = memDb();
    openStore({ db: b, migrations: UP_TO_25 });
    openStore({ db: b });
    expect(names(b, 'table')).toEqual(names(a, 'table'));
    expect(names(b, 'index')).toEqual(names(a, 'index'));
  });

  it('migration 26 is the only migration of its release: the versions are 1..N, 27 is release 0.2.1 and there is no 28', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
    expect(versions).toContain(26);
    expect(versions).toContain(27);
    expect(versions).not.toContain(28);
  });

  it('kit_erasures takes the two modes only and the pending index is partial', () => {
    const db = memDb();
    openStore({ db });
    const ok = db.prepare("INSERT INTO kit_erasures (id, at, mode, actor, counts_json, pending_subject) VALUES (?, ?, ?, 'o', '{}', NULL)");
    ok.run('e1', NOW, 'safety');
    ok.run('e2', NOW, 'none');
    expect(() => ok.run('e3', NOW, 'other')).toThrow();
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_erasures_pending'").get()?.sql);
    expect(sql).toContain('WHERE pending_subject IS NOT NULL');
  });

  it('opening twice changes nothing (idempotent)', () => {
    const db = memDb();
    openStore({ db });
    const first = names(db, 'index');
    openStore({ db });
    expect(names(db, 'index')).toEqual(first);
  });

  it('an old database erases and exports through the new store: the rows written at 25 are found', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_25 });
    seed25(db);
    const store = openStore({ db });
    expect(store.exportSubjects(['s_a']).strikes.map((s) => s.line)).toEqual(['line']);
    const counts = store.eraseSubjects({ subjects: ['s_a'], mode: 'none', heldReportIds: new Set(), receiptId: 'e_x', at: NOW });
    expect(counts.removed).toMatchObject({ subjects: 1, strikes: 1, mutes: 1, blocked_names: 1, signals: 1, sanctions: 1 });
    expect(count(db, 'kit_sanctions')).toBe(0);
    expect(store.erasureEpoch()).toBe(1);
  });
});
