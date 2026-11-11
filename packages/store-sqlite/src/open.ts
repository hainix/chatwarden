import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, type Migration } from './migrations.js';
import { inSavepoint, SqliteStore } from './sqliteStore.js';

/**
 * Where the kit's tables live: a file the kit owns (`path`), or a connection
 * the host app owns (`db`). `migrations` overrides the shipped list (tests).
 */
export type OpenOptions = ({ path: string } | { db: DatabaseSync }) & {
  migrations?: readonly Migration[];
};

const VERSION_KEY = 'schema_version';

/**
 * How long a statement waits for another connection's lock before SQLite gives up with "database is locked": 5 seconds. Set
 * only when the connection has no timeout of its own (a host that chose one keeps it), so two server processes on one file
 * queue behind each other's short writes instead of failing at once.
 */
const BUSY_TIMEOUT_MS = 5000;

function checkMigrations(migrations: readonly Migration[]): void {
  let prev = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= prev) {
      throw new Error(
        `invalid migration list: version ${m.version} must be a positive integer greater than ${prev} (strict ascending order)`,
      );
    }
    prev = m.version;
  }
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT value FROM kit_meta WHERE key = ?').get(VERSION_KEY);
  return row === undefined ? 0 : Number(row.value);
}

/**
 * Open the store, bringing the schema up to the latest migration. Each
 * migration and its version bump commit together; a failing one rolls back
 * and the error is thrown, leaving earlier migrations applied. The kit only
 * touches `kit_`-prefixed tables, so it can share a host application's DB.
 */
export function openStore(opts: OpenOptions): SqliteStore {
  const migrations = opts.migrations ?? MIGRATIONS;
  checkMigrations(migrations);

  const ownsDb = 'path' in opts;
  const db = 'path' in opts ? new DatabaseSync(opts.path) : opts.db;
  try {
    db.exec('PRAGMA foreign_keys = ON');
    if (ownsDb) db.exec('PRAGMA journal_mode = WAL');
    if (Number(db.prepare('PRAGMA busy_timeout').get()?.timeout ?? 0) === 0) db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

    db.exec('CREATE TABLE IF NOT EXISTS kit_meta (key TEXT PRIMARY KEY, value TEXT)');
    const latest = migrations.at(-1)?.version ?? 0;
    let version = currentVersion(db);
    if (version > latest) {
      throw new Error(`database schema version ${version} is newer than this kit supports (${latest})`);
    }
    const setVersion = db.prepare('INSERT OR REPLACE INTO kit_meta (key, value) VALUES (?, ?)');
    for (const m of migrations) {
      if (m.version <= version) continue;
      inSavepoint(db, () => {
        db.exec(m.sql);
        setVersion.run(VERSION_KEY, String(m.version));
      });
      version = m.version;
    }
    return new SqliteStore(db, version, ownsDb);
  } catch (err) {
    if (ownsDb) {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
    throw err;
  }
}
