import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SanctionKind, SanctionRow, Source, Store, SubjectId, SubjectIdKind, SubjectIdRecord, SubjectRecord } from '@chatwarden/core';
import type {
  AuditEntry,
  ExceptionPatch,
  ExceptionRecord,
  TermPatch,
  TermRecord,
  TermStore,
} from '@chatwarden/matcher';

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
export class SqliteStore implements Store, TermStore {
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

  // Sanctions. SYNCHRONOUS on purpose (see the Store interface): `applySanction` updates the in-memory index
  // in the same tick as the write. They run inside `transaction`, which must never be given an async function.

  insertSanctionGroup(rows: readonly SanctionRow[]): boolean {
    return this.transaction(() => {
      const first = rows[0];
      if (first === undefined) return true;
      const taken = this.db
        .prepare('SELECT 1 AS one FROM kit_sanctions WHERE ref_code = ? AND group_id <> ? LIMIT 1')
        .get(first.refCode, first.groupId);
      if (taken !== undefined) return false;
      const ins = this.db.prepare(
        `INSERT INTO kit_sanctions
           (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        ins.run(
          r.id, r.groupId, r.refCode, r.kind, r.targetType, r.value, r.startsAt, r.endsAt, r.reason, r.rule,
          r.actor, r.source, r.automated ? 1 : 0, r.pending ? 1 : 0,
        );
      }
      return true;
    });
  }

  revokeSanctionGroup(groupId: string, actor: string, at: number, reason: string): number {
    return this.transaction(() => {
      const res = this.db
        .prepare(
          'UPDATE kit_sanctions SET revoked_by = ?, revoked_at = ?, revoke_reason = ? WHERE group_id = ? AND revoked_at IS NULL',
        )
        .run(actor, at, reason, groupId);
      return Number(res.changes);
    });
  }

  loadSanctions(now: number): SanctionRow[] {
    return this.transaction(() =>
      this.db
        .prepare(
          `SELECT id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending
           FROM kit_sanctions WHERE revoked_at IS NULL AND (ends_at IS NULL OR ends_at > ?) ORDER BY rowid`,
        )
        .all(now)
        .map((r) => ({
          id: String(r.id),
          groupId: String(r.group_id),
          refCode: String(r.ref_code),
          kind: String(r.kind) as SanctionKind,
          targetType: r.target_type === 'ip' ? ('ip' as const) : ('subject' as const),
          value: String(r.target_value),
          startsAt: Number(r.starts_at),
          endsAt: r.ends_at === null ? null : Number(r.ends_at),
          reason: String(r.reason),
          rule: r.rule === null ? null : String(r.rule),
          actor: String(r.actor),
          source: String(r.source) as Source,
          automated: r.automated === 1,
          pending: r.pending === 1,
        })),
    );
  }

  // Terms, exceptions and the audit trail. These are SYNCHRONOUS on purpose (the TermStore contract): they
  // run inside `transaction`, which must never be given an async function.

  listTerms(): TermRecord[] {
    return this.db
      .prepare(
        'SELECT id, term, language, active, note, added_by, added_at, updated_by, updated_at FROM kit_terms ORDER BY rowid',
      )
      .all()
      .map((r) => ({ id: String(r.id), term: String(r.term), language: String(r.language), ...common(r) }));
  }

  listExceptions(): ExceptionRecord[] {
    return this.db
      .prepare(
        'SELECT id, phrase, language, active, note, added_by, added_at, updated_by, updated_at FROM kit_term_exceptions ORDER BY rowid',
      )
      .all()
      .map((r) => ({ id: String(r.id), phrase: String(r.phrase), language: String(r.language), ...common(r) }));
  }

  insertTerm(r: TermRecord): void {
    this.db
      .prepare(
        `INSERT INTO kit_terms (id, term, language, active, note, added_by, added_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.term, r.language, r.active ? 1 : 0, r.note, r.addedBy, r.addedAt, r.updatedBy, r.updatedAt);
  }

  updateTerm(id: string, patch: TermPatch): void {
    this.patchRow('kit_terms', 'term', 'term', id, patch.term, patch);
  }

  setTermActive(id: string, active: boolean, by: string, at: number): void {
    this.setActive('kit_terms', 'term', id, active, by, at);
  }

  insertException(r: ExceptionRecord): void {
    this.db
      .prepare(
        `INSERT INTO kit_term_exceptions (id, phrase, language, active, note, added_by, added_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.phrase, r.language, r.active ? 1 : 0, r.note, r.addedBy, r.addedAt, r.updatedBy, r.updatedAt);
  }

  updateException(id: string, patch: ExceptionPatch): void {
    this.patchRow('kit_term_exceptions', 'phrase', 'exception', id, patch.phrase, patch);
  }

  setExceptionActive(id: string, active: boolean, by: string, at: number): void {
    this.setActive('kit_term_exceptions', 'exception', id, active, by, at);
  }

  writeAudit(e: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO kit_audit (id, at, actor, action, subject_type, subject_ref, before_json, after_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomBytes(16).toString('base64url'), e.at, e.actor, e.action, e.subjectType, e.subjectRef, e.beforeJson, e.afterJson);
  }

  isSeeded(packId: string): boolean {
    return this.db.prepare('SELECT 1 AS one FROM kit_meta WHERE key = ?').get(seedKey(packId)) !== undefined;
  }

  markSeeded(packId: string, at: number): void {
    this.db.prepare('INSERT OR REPLACE INTO kit_meta (key, value) VALUES (?, ?)').run(seedKey(packId), String(at));
  }

  /** `table` and `column` are fixed strings from the methods above, never caller input. */
  private patchRow(
    table: 'kit_terms' | 'kit_term_exceptions',
    column: 'term' | 'phrase',
    subject: string,
    id: string,
    word: string | undefined,
    patch: { language?: string; note?: string | null; updatedBy: string; updatedAt: number },
  ): void {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (word !== undefined) {
      sets.push(`${column} = ?`);
      args.push(word);
    }
    if (patch.language !== undefined) {
      sets.push('language = ?');
      args.push(patch.language);
    }
    if (patch.note !== undefined) {
      sets.push('note = ?');
      args.push(patch.note);
    }
    sets.push('updated_by = ?', 'updated_at = ?');
    args.push(patch.updatedBy, patch.updatedAt, id);
    const res = this.db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    if (Number(res.changes) === 0) throw new Error(`${subject} not found: ${id}`);
  }

  private setActive(table: 'kit_terms' | 'kit_term_exceptions', subject: string, id: string, active: boolean, by: string, at: number): void {
    const res = this.db
      .prepare(`UPDATE ${table} SET active = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .run(active ? 1 : 0, by, at, id);
    if (Number(res.changes) === 0) throw new Error(`${subject} not found: ${id}`);
  }
}

const seedKey = (packId: string) => `terms_seeded:${packId}`;

type Row = Record<string, unknown>;
/** The columns terms and exceptions share, mapped to the record shape. */
function common(r: Row) {
  return {
    active: r.active === 1,
    note: r.note === null ? null : String(r.note),
    addedBy: String(r.added_by),
    addedAt: Number(r.added_at),
    updatedBy: r.updated_by === null ? null : String(r.updated_by),
    updatedAt: r.updated_at === null ? null : Number(r.updated_at),
  };
}
