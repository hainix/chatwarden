import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/migrations.js';
import { openStore, type Migration } from '../src/index.js';

const M1: Migration = { version: 1, sql: 'CREATE TABLE kit_a (id INTEGER PRIMARY KEY, v TEXT)' };
const M2: Migration = {
  version: 2,
  sql: 'CREATE TABLE kit_b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES kit_a(id))',
};
const M3: Migration = { version: 3, sql: 'ALTER TABLE kit_a ADD COLUMN w TEXT' };
const TEST_MIGRATIONS: Migration[] = [M1, M2, M3];

const tmpDirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-store-'));
  tmpDirs.push(dir);
  return join(dir, 'kit.db');
}
function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return db;
}
function fileDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  dbs.push(db);
  return db;
}
function tables(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  return rows.map((r) => String(r.name));
}
/** `DatabaseSync#isTransaction` needs Node 22.16; a nested BEGIN fails exactly when one is open. */
function inTransaction(db: DatabaseSync): boolean {
  try {
    db.exec('BEGIN');
  } catch {
    return true;
  }
  db.exec('ROLLBACK');
  return false;
}
function kitVersion(db: DatabaseSync): string | undefined {
  const row = db.prepare("SELECT value FROM kit_meta WHERE key='schema_version'").get();
  return row === undefined ? undefined : String(row.value);
}

describe('openStore: migrations', () => {
  it('the shipped migration list is strictly ordered', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('fresh file migrates to latest', () => {
    const path = tmpPath();
    const store = openStore({ path, migrations: TEST_MIGRATIONS });
    expect(store.schemaVersion()).toBe(3);
    store.close();
    const db = fileDb(path);
    expect(kitVersion(db)).toBe('3');
    expect(tables(db)).toEqual(expect.arrayContaining(['kit_a', 'kit_b', 'kit_meta']));
  });

  it('with no migrations the version is 0 and kit_meta exists', () => {
    const db = memDb();
    const store = openStore({ db, migrations: [] });
    expect(store.schemaVersion()).toBe(0);
    expect(tables(db)).toContain('kit_meta');
  });

  it('defaults to the shipped migration list', () => {
    const store = openStore({ db: memDb() });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version ?? 0);
  });

  it('reopen is idempotent', () => {
    const path = tmpPath();
    openStore({ path, migrations: TEST_MIGRATIONS }).close();
    const second = openStore({ path, migrations: TEST_MIGRATIONS });
    expect(second.schemaVersion()).toBe(3);
    second.close();
  });

  it('reopen with newer migrations applies only the new ones', () => {
    const path = tmpPath();
    openStore({ path, migrations: [M1, M2] }).close();
    const store = openStore({ path, migrations: TEST_MIGRATIONS });
    expect(store.schemaVersion()).toBe(3);
    store.close();
  });

  it('a failing migration rolls back and leaves the version unchanged', () => {
    const db = memDb();
    openStore({ db, migrations: [M1] });
    const bad: Migration = {
      version: 2,
      sql: 'CREATE TABLE kit_half (id INTEGER); INSERT INTO kit_no_such_table VALUES (1)',
    };
    expect(() => openStore({ db, migrations: [M1, bad] })).toThrow();
    expect(kitVersion(db)).toBe('1');
    expect(tables(db)).not.toContain('kit_half');
    expect(inTransaction(db)).toBe(false);
  });

  it('a failing migration keeps earlier successful ones applied', () => {
    const db = memDb();
    expect(() => openStore({ db, migrations: [M1, M2, { version: 3, sql: 'THIS IS NOT SQL' }] })).toThrow();
    expect(kitVersion(db)).toBe('2');
    expect(tables(db)).toContain('kit_b');
  });

  it('a database newer than the known migrations is refused', () => {
    const db = memDb();
    openStore({ db, migrations: TEST_MIGRATIONS });
    expect(() => openStore({ db, migrations: [M1] })).toThrow(/newer/);
  });

  it('rejects unordered, duplicate or non-positive migration versions', () => {
    expect(() => openStore({ db: memDb(), migrations: [M2, M1] })).toThrow(/migration/);
    expect(() => openStore({ db: memDb(), migrations: [M1, M1] })).toThrow(/migration/);
    expect(() => openStore({ db: memDb(), migrations: [{ version: 0, sql: 'SELECT 1' }] })).toThrow(/migration/);
    expect(() => openStore({ db: memDb(), migrations: [{ version: 1.5, sql: 'SELECT 1' }] })).toThrow(/migration/);
  });
});

describe('openStore: host DB', () => {
  it('an existing meta table and a schema_version row in it are untouched', () => {
    const db = memDb();
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version', '37')");
    const store = openStore({ db, migrations: TEST_MIGRATIONS });
    expect(store.schemaVersion()).toBe(3);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' });
    expect(kitVersion(db)).toBe('3');
  });

  it('only kit_ tables are created in a host DB', () => {
    const db = memDb();
    db.exec('CREATE TABLE host_things (id INTEGER)');
    openStore({ db, migrations: TEST_MIGRATIONS });
    const created = tables(db).filter((t) => t !== 'host_things');
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((t) => t.startsWith('kit_'))).toBe(true);
  });

  it('does not change the host journal mode', () => {
    const db = fileDb(tmpPath());
    db.exec('PRAGMA journal_mode=DELETE');
    openStore({ db, migrations: [] });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
  });

  it('close() leaves the host DB open', () => {
    const db = memDb();
    openStore({ db, migrations: [] }).close();
    expect(() => db.prepare('SELECT 1').get()).not.toThrow();
  });
});

describe('openStore: pragmas', () => {
  it('path variant uses WAL', () => {
    const path = tmpPath();
    openStore({ path, migrations: [] }).close();
    expect(fileDb(path).prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  });

  it('host variant turns foreign keys on and enforces them', () => {
    const db = memDb();
    openStore({ db, migrations: TEST_MIGRATIONS });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(() => db.exec('INSERT INTO kit_b (a_id) VALUES (999)')).toThrow(/FOREIGN KEY/);
  });

  it('path variant close() closes the database', () => {
    const store = openStore({ path: tmpPath(), migrations: [] });
    store.close();
    expect(() => store.schemaVersion()).toThrow();
  });
});

describe('Store.transaction', () => {
  function setup() {
    const db = memDb();
    const store = openStore({ db, migrations: TEST_MIGRATIONS });
    const count = () => Number(db.prepare('SELECT COUNT(*) AS n FROM kit_a').get()?.n);
    const add = (v: string) => db.prepare('INSERT INTO kit_a (v) VALUES (?)').run(v);
    return { db, store, count, add };
  }

  it('commits and returns the callback value', () => {
    const { store, count, add } = setup();
    const out = store.transaction(() => {
      add('x');
      return 42;
    });
    expect(out).toBe(42);
    expect(count()).toBe(1);
  });

  it('rolls back and rethrows when the callback throws', () => {
    const { db, store, count, add } = setup();
    expect(() =>
      store.transaction(() => {
        add('x');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(count()).toBe(0);
    expect(inTransaction(db)).toBe(false);
  });

  it('nested: an inner failure caught by the outer keeps the outer write only', () => {
    const { db, store, count, add } = setup();
    store.transaction(() => {
      add('outer');
      try {
        store.transaction(() => {
          add('inner');
          throw new Error('inner');
        });
      } catch {
        /* swallowed */
      }
    });
    expect(count()).toBe(1);
    expect(db.prepare('SELECT v FROM kit_a').get()).toEqual({ v: 'outer' });
  });

  it('nested: an outer failure rolls back an inner write that succeeded', () => {
    const { store, count, add } = setup();
    expect(() =>
      store.transaction(() => {
        store.transaction(() => add('inner'));
        throw new Error('outer');
      }),
    ).toThrow('outer');
    expect(count()).toBe(0);
  });

  it('nests inside a transaction the host already opened', () => {
    const { db, store, count, add } = setup();
    db.exec('BEGIN');
    store.transaction(() => add('x'));
    expect(inTransaction(db)).toBe(true);
    db.exec('ROLLBACK');
    expect(count()).toBe(0);
  });

  it('works repeatedly (savepoint names do not collide)', () => {
    const { store, count, add } = setup();
    for (let i = 0; i < 5; i++) store.transaction(() => add('x'));
    expect(count()).toBe(5);
  });
});

describe('SqliteStore.close (no reliance on DatabaseSync#isOpen, which needs Node 22.15)', () => {
  it('schemaVersion works while open and throws "store is closed" after close', () => {
    const store = openStore({ path: tmpPath() });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    store.close();
    expect(() => store.schemaVersion()).toThrow('store is closed');
  });

  it('close is idempotent on a store that owns its connection', () => {
    const store = openStore({ path: tmpPath() });
    store.close();
    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });

  it('close on a host-owned connection leaves the connection open and usable', () => {
    const db = memDb();
    const store = openStore({ db });
    store.close();
    expect(() => store.close()).not.toThrow();
    expect(() => db.prepare('SELECT 1 AS one').get()).not.toThrow();
    expect(() => store.schemaVersion()).toThrow('store is closed');
  });

  it('openStore closes a connection it owns when a migration fails, and rethrows', () => {
    const bad: Migration = { version: 1, sql: 'THIS IS NOT SQL' };
    expect(() => openStore({ path: tmpPath(), migrations: [bad] })).toThrow();
  });

  it('openStore leaves a host-owned connection open when a migration fails', () => {
    const db = memDb();
    const bad: Migration = { version: 1, sql: 'THIS IS NOT SQL' };
    expect(() => openStore({ db, migrations: [bad] })).toThrow();
    expect(() => db.prepare('SELECT 1 AS one').get()).not.toThrow();
  });
});
