import type {
  AuditEntry,
  ExceptionPatch,
  ExceptionRecord,
  TermPatch,
  TermRecord,
  TermStore,
} from '../../src/index.js';

interface State {
  terms: TermRecord[];
  exceptions: ExceptionRecord[];
  audit: AuditEntry[];
  seeded: string[];
}

/** In-memory TermStore whose `transaction` really rolls back (a snapshot restored on throw, nesting included).
 *  `fail` is called with the method name first thing in every method, so a test can make any of them throw. */
export class MemoryTermStore implements TermStore {
  state: State = { terms: [], exceptions: [], audit: [], seeded: [] };
  fail: (method: string) => void = () => {};

  listTerms(): TermRecord[] {
    this.fail('listTerms');
    return structuredClone(this.state.terms);
  }
  listExceptions(): ExceptionRecord[] {
    this.fail('listExceptions');
    return structuredClone(this.state.exceptions);
  }
  insertTerm(record: TermRecord): void {
    this.fail('insertTerm');
    if (this.state.terms.some((t) => t.id === record.id)) throw new Error('UNIQUE constraint failed: terms.id');
    this.state.terms.push(structuredClone(record));
  }
  updateTerm(id: string, patch: TermPatch): void {
    this.fail('updateTerm');
    const row = this.state.terms.find((t) => t.id === id);
    if (!row) throw new Error(`term not found: ${id}`);
    if (patch.term !== undefined) row.term = patch.term;
    if (patch.language !== undefined) row.language = patch.language;
    if (patch.note !== undefined) row.note = patch.note;
    row.updatedBy = patch.updatedBy;
    row.updatedAt = patch.updatedAt;
  }
  setTermActive(id: string, active: boolean, by: string, at: number): void {
    this.fail('setTermActive');
    const row = this.state.terms.find((t) => t.id === id);
    if (!row) throw new Error(`term not found: ${id}`);
    row.active = active;
    row.updatedBy = by;
    row.updatedAt = at;
  }
  insertException(record: ExceptionRecord): void {
    this.fail('insertException');
    if (this.state.exceptions.some((e) => e.id === record.id)) throw new Error('UNIQUE constraint failed: exceptions.id');
    this.state.exceptions.push(structuredClone(record));
  }
  updateException(id: string, patch: ExceptionPatch): void {
    this.fail('updateException');
    const row = this.state.exceptions.find((e) => e.id === id);
    if (!row) throw new Error(`exception not found: ${id}`);
    if (patch.phrase !== undefined) row.phrase = patch.phrase;
    if (patch.language !== undefined) row.language = patch.language;
    if (patch.note !== undefined) row.note = patch.note;
    row.updatedBy = patch.updatedBy;
    row.updatedAt = patch.updatedAt;
  }
  setExceptionActive(id: string, active: boolean, by: string, at: number): void {
    this.fail('setExceptionActive');
    const row = this.state.exceptions.find((e) => e.id === id);
    if (!row) throw new Error(`exception not found: ${id}`);
    row.active = active;
    row.updatedBy = by;
    row.updatedAt = at;
  }
  writeAudit(entry: AuditEntry): void {
    this.fail('writeAudit');
    this.state.audit.push(structuredClone(entry));
  }
  isSeeded(packId: string): boolean {
    this.fail('isSeeded');
    return this.state.seeded.includes(packId);
  }
  markSeeded(packId: string): void {
    this.fail('markSeeded');
    if (!this.state.seeded.includes(packId)) this.state.seeded.push(packId);
  }
  transaction<T>(fn: () => T): T {
    this.fail('transaction');
    const snapshot = structuredClone(this.state);
    try {
      return fn();
    } catch (err) {
      this.state = snapshot;
      throw err;
    }
  }
}
