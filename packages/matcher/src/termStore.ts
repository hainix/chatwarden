import type { ExceptionRow, TermRow } from './matcher.js';

/** A stored term: the matcher's row plus who added or last changed it, and when. */
export interface TermRecord extends TermRow {
  note: string | null;
  addedBy: string;
  addedAt: number;
  updatedBy: string | null;
  updatedAt: number | null;
}

/** A stored exception: the matcher's row plus who added or last changed it, and when. */
export interface ExceptionRecord extends ExceptionRow {
  note: string | null;
  addedBy: string;
  addedAt: number;
  updatedBy: string | null;
  updatedAt: number | null;
}

/** The fields an edit may change; `updatedBy` and `updatedAt` are always stamped. */
export interface TermPatch {
  term?: string;
  language?: string;
  note?: string | null;
  updatedBy: string;
  updatedAt: number;
}

/** The fields an edit may change; `updatedBy` and `updatedAt` are always stamped. */
export interface ExceptionPatch {
  phrase?: string;
  language?: string;
  note?: string | null;
  updatedBy: string;
  updatedAt: number;
}

/** One line of the audit trail. `subjectRef` is the id of the term or exception row. */
export interface AuditEntry {
  at: number;
  actor: string;
  action: 'add' | 'edit' | 'enable' | 'disable';
  subjectType: 'term' | 'exception';
  subjectRef: string;
  /** JSON of the row before the change; null for an add. */
  beforeJson: string | null;
  /** JSON of the row after the change. */
  afterJson: string;
}

/**
 * The storage a {@link LiveTerms} needs. Every method is SYNCHRONOUS, because they run inside
 * `transaction`, which must never be given an async function (the savepoint would be released before
 * the promise settled). `@chatwarden/store-sqlite` implements it; tests may use an in-memory one.
 * Lists come back in insertion order, inactive rows included.
 */
export interface TermStore {
  listTerms(): TermRecord[];
  listExceptions(): ExceptionRecord[];
  /** Throws if the id is taken. */
  insertTerm(record: TermRecord): void;
  /** Throws if the id is unknown. */
  updateTerm(id: string, patch: TermPatch): void;
  /** Throws if the id is unknown. */
  setTermActive(id: string, active: boolean, by: string, at: number): void;
  insertException(record: ExceptionRecord): void;
  updateException(id: string, patch: ExceptionPatch): void;
  setExceptionActive(id: string, active: boolean, by: string, at: number): void;
  writeAudit(entry: AuditEntry): void;
  /** Whether the pack with this id has already been copied into the store. */
  isSeeded(packId: string): boolean;
  markSeeded(packId: string, at: number): void;
  /** Runs `fn` atomically: a throw undoes every write made inside. Nests. */
  transaction<T>(fn: () => T): T;
}
