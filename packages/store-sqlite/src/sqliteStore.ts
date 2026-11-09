import type { DatabaseSync } from 'node:sqlite';
import type { Store } from '@chatwarden/core';

let savepointSeq = 0;

/** Runs `fn` in a SAVEPOINT: it nests inside any open transaction and also works outside one. */
export function inSavepoint<T>(db: DatabaseSync, fn: () => T): T {
  const name = `kit_sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  let value: T;
  try {
    value = fn();
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  }
  db.exec(`RELEASE ${name}`);
  return value;
}

/**
 * SQLite-backed {@link Store}. `node:sqlite` is synchronous; the domain
 * methods later tasks add here are `async` only to satisfy the interface.
 * Use `openStore` to get one: it runs the migrations first.
 */
export class SqliteStore implements Store {
  /** The underlying connection, for the domain methods later tasks add in this class. */
  protected readonly db: DatabaseSync;
  private readonly version: number;
  private readonly ownsDb: boolean;

  constructor(db: DatabaseSync, version: number, ownsDb: boolean) {
    this.db = db;
    this.version = version;
    this.ownsDb = ownsDb;
  }

  schemaVersion(): number {
    if (!this.db.isOpen) throw new Error('store is closed');
    return this.version;
  }

  transaction<T>(fn: () => T): T {
    return inSavepoint(this.db, fn);
  }

  close(): void {
    if (this.ownsDb && this.db.isOpen) this.db.close();
  }

  // --- Domain methods (async) are added below by later tasks. ---
}
