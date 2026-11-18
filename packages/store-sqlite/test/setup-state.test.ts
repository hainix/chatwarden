import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openStore } from '../src/index.js';
import { SETUP_LOAD_SQL, SETUP_SAVE_SQL, SETUP_STATE_KEY } from '../src/sqliteStore.js';

// The first-run setup flag (0.2.2) is one `kit_meta` row, key `setup_state`, holding JSON. No table and no migration.

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
const fileDb = (): { path: string; open: () => DatabaseSync } => {
  const d = mkdtempSync(join(tmpdir(), 'cw-setup-'));
  dirs.push(d);
  const path = join(d, 'kit.db');
  return {
    path,
    open: () => {
      const db = new DatabaseSync(path);
      dbs.push(db);
      return db;
    },
  };
};

const metaRows = (db: DatabaseSync): unknown[] => db.prepare("SELECT key, value FROM kit_meta WHERE key <> 'schema_version' ORDER BY key").all();
const tables = (db: DatabaseSync): string[] => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => String(r.name));

describe('the setup state in kit_meta', () => {
  it('exports its key and statements', () => {
    expect(SETUP_STATE_KEY).toBe('setup_state');
    expect(SETUP_LOAD_SQL).toBe('SELECT value FROM kit_meta WHERE key = ?');
    expect(SETUP_SAVE_SQL).toBe('INSERT OR REPLACE INTO kit_meta (key, value) VALUES (?, ?)');
  });

  it('persists across closing and reopening a file database', () => {
    const f = fileDb();
    const first = openStore({ db: f.open() });
    expect(first.getSetupState?.()).toBeNull();
    first.saveSetupState?.({ dismissedAt: 1_800_000_000_000 });
    dbs.pop()?.close();
    const second = openStore({ db: f.open() });
    expect(second.getSetupState?.()).toEqual({ dismissedAt: 1_800_000_000_000 });
  });

  it('is stored in kit_meta under setup_state and no table is added', () => {
    const db = memDb();
    const store = openStore({ db });
    const before = tables(db);
    store.saveSetupState?.({ dismissedAt: 42 });
    expect(tables(db)).toEqual(before);
    const row = db.prepare('SELECT value FROM kit_meta WHERE key = ?').get(SETUP_STATE_KEY);
    expect(JSON.parse(String(row?.value))).toEqual({ dismissedAt: 42 });
    expect(Object.keys(JSON.parse(String(row?.value)) as object)).toEqual(['dismissedAt']);
    // saving again replaces the row, never adds one
    store.saveSetupState?.({ dismissedAt: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM kit_meta WHERE key = ?').get(SETUP_STATE_KEY)?.n).toBe(1);
    expect(store.getSetupState?.()).toEqual({ dismissedAt: null });
  });

  it('MIGRATIONS ends at 27: no migration was added for it', () => {
    expect(MIGRATIONS.at(-1)?.version).toBe(27);
    expect(MIGRATIONS).toHaveLength(27);
  });

  it('the kit_meta rows other than schema_version are unchanged by a fresh store (control)', () => {
    const db = memDb();
    openStore({ db });
    const rows = metaRows(db) as Array<{ key: string }>;
    expect(rows.map((r) => r.key)).not.toContain(SETUP_STATE_KEY);
    const again = memDb();
    openStore({ db: again });
    expect(metaRows(again)).toEqual(rows);
  });

  it('a corrupt value reads as null and never throws', () => {
    const db = memDb();
    const store = openStore({ db });
    for (const value of ['x', '[]', '{"dismissedAt":"a"}', 'null', '5', '"s"', '{}', '{"dismissedAt":true}', '{"dismissedAt":1e999}', '{"dismissedAt":-1,"x":', '']) {
      db.prepare('INSERT OR REPLACE INTO kit_meta (key, value) VALUES (?, ?)').run(SETUP_STATE_KEY, value);
      expect(store.getSetupState?.(), JSON.stringify(value)).toBeNull();
    }
    // a good value after the bad ones reads again
    db.prepare('INSERT OR REPLACE INTO kit_meta (key, value) VALUES (?, ?)').run(SETUP_STATE_KEY, '{"dismissedAt":7}');
    expect(store.getSetupState?.()).toEqual({ dismissedAt: 7 });
    db.prepare('INSERT OR REPLACE INTO kit_meta (key, value) VALUES (?, ?)').run(SETUP_STATE_KEY, '{"dismissedAt":null}');
    expect(store.getSetupState?.()).toEqual({ dismissedAt: null });
  });

  it('a stored value with an extra key reads only the field it knows', () => {
    const db = memDb();
    const store = openStore({ db });
    db.prepare('INSERT OR REPLACE INTO kit_meta (key, value) VALUES (?, ?)').run(SETUP_STATE_KEY, '{"dismissedAt":3,"future":"x"}');
    expect(store.getSetupState?.()).toEqual({ dismissedAt: 3 });
  });

  it('a save inside a transaction that throws leaves no row', () => {
    const db = memDb();
    const store = openStore({ db });
    expect(() =>
      store.transaction(() => {
        store.saveSetupState?.({ dismissedAt: 5 });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.getSetupState?.()).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM kit_meta WHERE key = ?').get(SETUP_STATE_KEY)?.n).toBe(0);
  });
});
