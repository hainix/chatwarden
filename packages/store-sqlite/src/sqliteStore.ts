import type { DatabaseSync } from 'node:sqlite';
import type { Store, SubjectId, SubjectIdKind, SubjectIdRecord, SubjectRecord } from '@chatwarden/core';

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

  // Subjects

  async saveSubject(subject: SubjectRecord): Promise<void> {
    this.transaction(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO kit_subjects (id, created_at, merged_into) VALUES (?, ?, ?)')
        .run(subject.id, subject.createdAt, subject.mergedInto);
    });
  }

  async saveIdentifier(record: SubjectIdRecord): Promise<void> {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO kit_subject_ids (subject_id, kind, value, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (subject_id, kind, value) DO UPDATE SET last_seen = max(last_seen, excluded.last_seen)`,
        )
        .run(record.subjectId, record.kind, record.value, record.firstSeen, record.lastSeen);
    });
  }

  async markMerged(id: SubjectId, into: SubjectId): Promise<void> {
    this.transaction(() => {
      this.db.prepare('UPDATE kit_subjects SET merged_into = ? WHERE id = ?').run(into, id);
    });
  }

  async loadSubjects(): Promise<{ subjects: SubjectRecord[]; ids: SubjectIdRecord[] }> {
    return this.transaction(() => {
      const subjects = this.db
        .prepare('SELECT id, created_at, merged_into FROM kit_subjects ORDER BY created_at, id')
        .all()
        .map((r) => ({
          id: String(r.id),
          createdAt: Number(r.created_at),
          mergedInto: r.merged_into === null ? null : String(r.merged_into),
        }));
      const ids = this.db
        .prepare(
          'SELECT subject_id, kind, value, first_seen, last_seen FROM kit_subject_ids ORDER BY subject_id, kind, value',
        )
        .all()
        .map((r) => ({
          subjectId: String(r.subject_id),
          kind: String(r.kind) as SubjectIdKind,
          value: String(r.value),
          firstSeen: Number(r.first_seen),
          lastSeen: Number(r.last_seen),
        }));
      return { subjects, ids };
    });
  }
}
