import type { Store, SubjectIdRecord, SubjectId, SubjectRecord } from '../src/types.js';

/**
 * In-memory {@link Store} for core tests (and later tasks' core tests). It
 * implements the same async domain methods as the SQLite adapter with Maps.
 * Later tasks append their groups of methods here. Subclass it or overwrite a
 * method on an instance to inject failures.
 */
export class MemoryStore implements Store {
  protected subjects = new Map<SubjectId, SubjectRecord>();
  protected subjectIds = new Map<string, SubjectIdRecord>();

  schemaVersion(): number {
    return 0;
  }

  /** Synchronous like the real thing; restores the Maps if `fn` throws. */
  transaction<T>(fn: () => T): T {
    const subjects = new Map([...this.subjects].map(([k, v]) => [k, { ...v }]));
    const subjectIds = new Map([...this.subjectIds].map(([k, v]) => [k, { ...v }]));
    try {
      return fn();
    } catch (err) {
      this.subjects = subjects;
      this.subjectIds = subjectIds;
      throw err;
    }
  }

  close(): void {}

  // Subjects

  saveSubject(subject: SubjectRecord): Promise<void> {
    if (!this.subjects.has(subject.id)) this.subjects.set(subject.id, { ...subject });
    return Promise.resolve();
  }

  saveIdentifier(record: SubjectIdRecord): Promise<void> {
    if (!this.subjects.has(record.subjectId)) {
      return Promise.reject(new Error('unknown subject'));
    }
    const key = `${record.subjectId}\u0000${record.kind}\u0000${record.value}`;
    const existing = this.subjectIds.get(key);
    if (existing === undefined) {
      this.subjectIds.set(key, { ...record });
    } else {
      existing.lastSeen = Math.max(existing.lastSeen, record.lastSeen);
    }
    return Promise.resolve();
  }

  markMerged(id: SubjectId, into: SubjectId): Promise<void> {
    const subject = this.subjects.get(id);
    if (subject !== undefined) subject.mergedInto = into;
    return Promise.resolve();
  }

  loadSubjects(): Promise<{ subjects: SubjectRecord[]; ids: SubjectIdRecord[] }> {
    return Promise.resolve({
      subjects: [...this.subjects.values()].map((s) => ({ ...s })),
      ids: [...this.subjectIds.values()].map((r) => ({ ...r })),
    });
  }
}

export function memoryStore(): MemoryStore {
  return new MemoryStore();
}
