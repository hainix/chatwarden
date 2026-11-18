import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openStore } from '../src/index.js';

// Migration 26, the shared-pacing block (spec 3.7 and section 7, block 1): `kit_pace` and `kit_pace_by_touched`. Shared migration: the assertions are about this block's names only.

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

describe('migration 26, the pace block', () => {
  it('kit_pace exists with its primary key (room, who), its columns and the touched index', () => {
    const db = memDb();
    openStore({ db });
    expect(columns(db, 'kit_pace')).toEqual(['room_id', 'who', 'last_at', 'stamps_json', 'recent_json', 'flood_signal_at', 'touched_at']);
    const info = db.prepare('PRAGMA table_info(kit_pace)').all();
    const pk = info.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));
    expect(pk).toEqual(['room_id', 'who']);
    expect(info.find((c) => c.name === 'flood_signal_at')?.notnull).toBe(0);
    for (const name of ['room_id', 'who', 'last_at', 'stamps_json', 'recent_json', 'touched_at']) expect(info.find((c) => c.name === name)?.notnull, name).toBe(1);
    expect(indexes(db)).toContain('kit_pace_by_touched');
    // the export and the erase of a person look rows up by person: the primary key leads with the room, so that needs its own index
    expect(indexes(db)).toContain('kit_pace_by_who');
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_pace_by_who'").get()?.sql)).toMatch(/\(who\)/);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_pace_by_touched'").get()?.sql)).toMatch(/touched_at/);
  });

  it('the table is WITHOUT ROWID', () => {
    const db = memDb();
    openStore({ db });
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_pace'").get()?.sql)).toMatch(/WITHOUT ROWID/i);
    expect(() => db.prepare('SELECT rowid FROM kit_pace').all()).toThrow();
  });

  it('a version 25 database upgrades: the table appears, existing rows are untouched', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_25 });
    expect(columns(db, 'kit_pace')).toEqual([]);
    db.prepare("INSERT INTO kit_meta (key, value) VALUES ('probe', 'kept')").run();
    openStore({ db });
    expect(columns(db, 'kit_pace')).toContain('who');
    expect(db.prepare("SELECT value FROM kit_meta WHERE key = 'probe'").get()?.value).toBe('kept');
  });

  it('a rerun is refused: running the block again on a database that has it fails, and opening twice is fine', () => {
    const db = memDb();
    openStore({ db });
    expect(() => db.exec(MIGRATIONS.at(-1)!.sql)).toThrow();
    expect(() => openStore({ db })).not.toThrow();
  });

  it('the check constraints the block is expected to hold: a row needs every NOT NULL column', () => {
    const db = memDb();
    openStore({ db });
    const insert = db.prepare('INSERT INTO kit_pace (room_id, who, last_at, stamps_json, recent_json, flood_signal_at, touched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('r', 'w', 1, '[]', '[]', null, 1);
    expect(() => insert.run('r', 'w', 1, '[]', '[]', null, 1)).toThrow();
    expect(() => insert.run('r', 'w2', null as never, '[]', '[]', null, 1)).toThrow();
  });
});
