import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { NO_PERSON_TABLES, PRIVACY_REGISTRY } from '@chatwarden/core';
import { openStore } from '../src/index.js';

// The completeness test of the privacy registry (design 5.4): every `kit_` table the migrations create must be claimed by a category of PRIVACY_REGISTRY or be
// in NO_PERSON_TABLES with a reason. A later theme (urgent desk, rooms, staff scope, languages) that adds a table fails THIS test until someone decides what an
// export and an erase do with it. The check is a function so a control can prove it fails.

const claimed = (): Set<string> => new Set([...PRIVACY_REGISTRY.flatMap((r) => r.tables), ...Object.keys(NO_PERSON_TABLES)]);

/** The `kit_` tables of the database that no category claims. */
const unclaimedTables = (db: DatabaseSync): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kit_%' ORDER BY name")
    .all()
    .map((r) => String(r.name))
    .filter((n) => !claimed().has(n));

describe('completeness (sqlite): every kit_ table in sqlite_master is in the registry map or in the "holds no person" list', () => {
  it('after every migration, no table is unclaimed', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    expect(unclaimedTables(db)).toEqual([]);
  });

  it('control: adding a table without an entry fails', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    db.exec('CREATE TABLE kit_urgent_desk_rows (id TEXT PRIMARY KEY, subject_id TEXT)');
    expect(unclaimedTables(db)).toEqual(['kit_urgent_desk_rows']);
  });

  it('every claimed table exists: nothing claimed is a table that never existed', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const real = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => String(r.name)),
    );
    for (const t of claimed()) expect(real.has(t), t).toBe(true);
  });

  it('names the tables and columns this release added: kit_filter_hits, kit_erasures, kit_reports.origin and origin_key and their indexes', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    expect(claimed().has('kit_filter_hits')).toBe(true);
    expect(claimed().has('kit_erasures')).toBe(true);
    const cols = db.prepare('PRAGMA table_info(kit_reports)').all().map((r) => String(r.name));
    expect(cols).toEqual(expect.arrayContaining(['origin', 'origin_key']));
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kit_reports'").all().map((r) => String(r.name));
    expect(idx).toEqual(expect.arrayContaining(['kit_reports_open_filter', 'kit_reports_by_origin']));
  });
});
