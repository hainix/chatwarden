import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openStore } from '../src/index.js';

// Migration 26, block 3 (legal hold): `kit_legal_holds` and its partial index. Shared migration: assertions are about the schema AFTER it ran, never about the number.

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
const names = (db: DatabaseSync, type: 'table' | 'index'): string[] => db.prepare(`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`).all().map((r) => String(r.name));

describe('migration 26 block 3 from an earlier database', () => {
  it('adds kit_legal_holds and its partial index and keeps every row', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_25 });
    db.prepare("INSERT INTO kit_subjects (id, created_at, merged_into) VALUES ('s_a', ?, NULL)").run(NOW);
    db.prepare(
      `INSERT INTO kit_reports (id, created_at, room_id, tags_json, reporter_subject, reporter_seat, reporter_handle, target_subject, target_seat, target_handle, category, note, line_id, excerpt_json, people_json)
       VALUES ('r1', ?, 'R', '{}', 's_r', 'p1', 'R', 's_a', 'p2', 'T', 'spam', NULL, NULL, '[]', '[]')`,
    ).run(NOW);
    expect(names(db, 'table')).not.toContain('kit_legal_holds');
    openStore({ db });
    expect(names(db, 'table')).toContain('kit_legal_holds');
    expect(names(db, 'index')).toContain('kit_legal_holds_open');
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM kit_reports').get()?.n)).toBe(1);
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM kit_subjects').get()?.n)).toBe(1);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_legal_holds_open'").get()?.sql)).toContain('WHERE released_at IS NULL');
  });

  it('the columns are the ones the plan names, the report id is the key, and only the five codes are accepted', () => {
    const db = memDb();
    openStore({ db });
    const cols = db.prepare('PRAGMA table_info(kit_legal_holds)').all();
    expect(cols.map((c) => String(c.name))).toEqual(['report_id', 'code', 'held_by', 'held_at', 'released_by', 'released_at']);
    expect(cols.filter((c) => Number(c.pk) === 1).map((c) => String(c.name))).toEqual(['report_id']);
    const ins = db.prepare("INSERT INTO kit_legal_holds (report_id, code, held_by, held_at) VALUES (?, ?, 's', 1)");
    ins.run('r1', 'other');
    expect(() => ins.run('r1', 'other')).toThrow();
    expect(() => ins.run('r2', 'free text')).toThrow();
  });

  it('a database migrated from 25 has the same hold schema as a fresh one, and a hold works on it', () => {
    const a = memDb();
    openStore({ db: a });
    const b = memDb();
    openStore({ db: b, migrations: UP_TO_25 });
    const store = openStore({ db: b });
    expect(names(b, 'index')).toEqual(names(a, 'index'));
    expect(store.placeHold({ reportId: 'r1', code: 'other', heldBy: 's', heldAt: 1, releasedBy: null, releasedAt: null })).toBe(true);
    expect(store.heldSet()).toEqual({ reportIds: ['r1'], groupIds: [] });
  });
});
