import type { SanctionRow, Store, SubjectIdRecord, SubjectId, SubjectRecord } from '../src/types.js';

/** A stored sanction row plus its revocation, as the SQL table keeps it. */
export interface StoredSanction extends SanctionRow {
  revokedBy: string | null;
  revokedAt: number | null;
  revokeReason: string | null;
}

/**
 * In-memory {@link Store} for core tests (and later tasks' core tests). It
 * implements the same async domain methods as the SQLite adapter with Maps.
 * Later tasks append their groups of methods here. Subclass it or overwrite a
 * method on an instance to inject failures.
 */
export class MemoryStore implements Store {
  protected subjects = new Map<SubjectId, SubjectRecord>();
  protected subjectIds = new Map<string, SubjectIdRecord>();
  protected sanctions: StoredSanction[] = [];

  schemaVersion(): number {
    return 0;
  }

  /** Synchronous like the real thing; restores the Maps if `fn` throws. */
  transaction<T>(fn: () => T): T {
    const subjects = new Map([...this.subjects].map(([k, v]) => [k, { ...v }]));
    const subjectIds = new Map([...this.subjectIds].map(([k, v]) => [k, { ...v }]));
    const sanctions = this.sanctions.map((r) => ({ ...r }));
    try {
      return fn();
    } catch (err) {
      this.subjects = subjects;
      this.subjectIds = subjectIds;
      this.sanctions = sanctions;
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

  // Sanctions (synchronous, see the Store interface)

  insertSanctionGroup(rows: readonly SanctionRow[]): boolean {
    const first = rows[0];
    if (first === undefined) return true;
    if (this.sanctions.some((r) => r.refCode === first.refCode && r.groupId !== first.groupId)) return false;
    for (const row of rows) {
      this.sanctions.push({ ...row, revokedBy: null, revokedAt: null, revokeReason: null });
    }
    return true;
  }

  revokeSanctionGroup(groupId: string, actor: string, at: number, reason: string): number {
    let n = 0;
    for (const r of this.sanctions) {
      if (r.groupId !== groupId || r.revokedAt !== null) continue;
      r.revokedBy = actor;
      r.revokedAt = at;
      r.revokeReason = reason;
      n++;
    }
    return n;
  }

  loadSanctions(now: number): SanctionRow[] {
    return this.sanctions
      .filter((r) => r.revokedAt === null && (r.endsAt === null || r.endsAt > now))
      .map((r) => ({
        id: r.id,
        groupId: r.groupId,
        refCode: r.refCode,
        kind: r.kind,
        targetType: r.targetType,
        value: r.value,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        reason: r.reason,
        rule: r.rule,
        actor: r.actor,
        source: r.source,
        automated: r.automated,
        pending: r.pending,
      }));
  }

  /** Test helper: every stored row, revoked ones included. */
  rawSanctions(): StoredSanction[] {
    return this.sanctions.map((r) => ({ ...r }));
  }
}

export function memoryStore(): MemoryStore {
  return new MemoryStore();
}
