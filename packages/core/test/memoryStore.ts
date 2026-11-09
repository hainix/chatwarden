import type {
  MuteRow,
  ReportActivity,
  SanctionRow,
  Store,
  StoredReport,
  StrikeRow,
  SubjectIdRecord,
  SubjectId,
  SubjectRecord,
} from '../src/types.js';

/** A report plus the moderation columns K2 will fill (modelled here so the intake rules can be tested). */
export interface StoredReportRow extends Omit<StoredReport, 'status'> {
  status: 'open' | 'actioned' | 'dismissed';
  badFaith: boolean;
  actionedAt: number | null;
}

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
  /** Mutes by `viewer, target`; `seq` stands in for SQLite's rowid (insertion order, kept on refresh). */
  protected mutes = new Map<string, { row: MuteRow; seq: number }>();
  private muteSeq = 0;
  protected strikes: StrikeRow[] = [];
  /** Reports in insertion order; `insertReport` enforces UNIQUE (reporter, target, room). */
  protected reports: StoredReportRow[] = [];
  /** Group id that owns each ref code: the O(1) collision check. */
  protected refOwners = new Map<string, string>();
  /** Undo steps of the innermost open transaction, or null outside one. */
  private journal: Array<() => void> | null = null;

  private undoWith(step: () => void): void {
    this.journal?.push(step);
  }

  schemaVersion(): number {
    return 0;
  }

  /**
   * Synchronous like the real thing. Writes inside are journaled as undo steps
   * (cost is O(writes), not O(store size)); if `fn` throws the steps run in
   * reverse and the error is rethrown. Calls nest: an inner failure the outer
   * `fn` catches undoes only the inner writes, and a successful inner call
   * hands its steps to the outer one so an outer failure still undoes them.
   */
  transaction<T>(fn: () => T): T {
    const outer = this.journal;
    const mine: Array<() => void> = [];
    this.journal = mine;
    try {
      const value = fn();
      this.journal = outer;
      if (outer !== null) outer.push(...mine);
      return value;
    } catch (err) {
      this.journal = outer; // undo steps must not journal themselves
      for (let i = mine.length - 1; i >= 0; i--) mine[i]?.();
      throw err;
    }
  }

  close(): void {}

  // Subjects

  saveSubject(subject: SubjectRecord): Promise<void> {
    if (!this.subjects.has(subject.id)) {
      this.subjects.set(subject.id, { ...subject });
      this.undoWith(() => this.subjects.delete(subject.id));
    }
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
      this.undoWith(() => this.subjectIds.delete(key));
    } else {
      const before = existing.lastSeen;
      existing.lastSeen = Math.max(before, record.lastSeen);
      this.undoWith(() => {
        existing.lastSeen = before;
      });
    }
    return Promise.resolve();
  }

  markMerged(id: SubjectId, into: SubjectId): Promise<void> {
    const subject = this.subjects.get(id);
    if (subject !== undefined) {
      const before = subject.mergedInto;
      subject.mergedInto = into;
      this.undoWith(() => {
        subject.mergedInto = before;
      });
    }
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
    const owner = this.refOwners.get(first.refCode);
    if (owner !== undefined && owner !== first.groupId) return false;
    const addedCode = owner === undefined;
    this.refOwners.set(first.refCode, first.groupId);
    for (const row of rows) {
      this.sanctions.push({ ...row, revokedBy: null, revokedAt: null, revokeReason: null });
    }
    this.undoWith(() => {
      this.sanctions.length -= rows.length;
      if (addedCode) this.refOwners.delete(first.refCode);
    });
    return true;
  }

  revokeSanctionGroup(groupId: string, actor: string, at: number, reason: string): number {
    const touched: StoredSanction[] = [];
    for (const r of this.sanctions) {
      if (r.groupId !== groupId || r.revokedAt !== null) continue;
      r.revokedBy = actor;
      r.revokedAt = at;
      r.revokeReason = reason;
      touched.push(r);
    }
    this.undoWith(() => {
      for (const r of touched) {
        r.revokedBy = null;
        r.revokedAt = null;
        r.revokeReason = null;
      }
    });
    return touched.length;
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

  // Mutes (synchronous, see the Store interface)

  upsertMute(row: MuteRow): void {
    const key = muteKey(row.viewer, row.target);
    const existing = this.mutes.get(key);
    if (existing === undefined) {
      this.mutes.set(key, { row: { ...row }, seq: ++this.muteSeq });
      this.undoWith(() => this.mutes.delete(key));
    } else {
      const before = existing.row.createdAt;
      existing.row.createdAt = row.createdAt;
      this.undoWith(() => {
        existing.row.createdAt = before;
      });
    }
  }

  deleteMute(viewer: SubjectId, target: SubjectId): boolean {
    const key = muteKey(viewer, target);
    const existing = this.mutes.get(key);
    if (existing === undefined) return false;
    this.mutes.delete(key);
    this.undoWith(() => this.mutes.set(key, existing));
    return true;
  }

  loadMutes(since: number): MuteRow[] {
    return [...this.mutes.values()].filter((m) => m.row.createdAt >= since).map((m) => ({ ...m.row }));
  }

  pruneMutes(viewer: SubjectId, keep: number): SubjectId[] {
    const mine = [...this.mutes.entries()]
      .filter(([, m]) => m.row.viewer === viewer)
      .sort(([, a], [, b]) => a.row.createdAt - b.row.createdAt || a.seq - b.seq);
    const drop = mine.slice(0, Math.max(0, mine.length - keep));
    for (const [key, m] of drop) {
      this.mutes.delete(key);
      this.undoWith(() => this.mutes.set(key, m));
    }
    return drop.map(([, m]) => m.row.target);
  }

  // Strikes (synchronous, see the Store interface)

  insertStrike(row: StrikeRow): void {
    this.strikes.push({ ...row });
    this.undoWith(() => {
      this.strikes.length -= 1;
    });
  }

  loadStrikes(since: number): StrikeRow[] {
    return this.strikes.filter((r) => r.at >= since).map((r) => ({ ...r }));
  }

  loadAutoChatStarts(): Array<{ subject: SubjectId; startsAt: number }> {
    const latest = new Map<SubjectId, number>();
    for (const r of this.sanctions) {
      if (r.kind !== 'chat' || r.source !== 'auto_filter' || r.targetType !== 'subject') continue;
      latest.set(r.value, Math.max(latest.get(r.value) ?? r.startsAt, r.startsAt));
    }
    return [...latest].map(([subject, startsAt]) => ({ subject, startsAt }));
  }

  // Reports (synchronous, see the Store interface)

  insertReport(row: StoredReport): boolean {
    const dup = this.reports.some(
      (r) => r.reporterSubject === row.reporterSubject && r.targetSubject === row.targetSubject && r.roomId === row.roomId,
    );
    if (dup) return false;
    this.reports.push({ ...structuredClone(row), badFaith: false, actionedAt: null });
    this.undoWith(() => {
      this.reports.length -= 1;
    });
    return true;
  }

  loadReportActivity(since: number): ReportActivity[] {
    return this.reports
      .filter((r) => r.createdAt >= since)
      .map((r) => ({ reporter: r.reporterSubject, target: r.targetSubject, roomId: r.roomId, createdAt: r.createdAt }));
  }

  loadRoomReportPairs(roomId: string): Array<{ reporter: SubjectId; target: SubjectId }> {
    return this.reports.filter((r) => r.roomId === roomId).map((r) => ({ reporter: r.reporterSubject, target: r.targetSubject }));
  }

  loadBadFaithMarks(since: number): Array<{ reporter: SubjectId; actionedAt: number }> {
    const out: Array<{ reporter: SubjectId; actionedAt: number }> = [];
    for (const r of this.reports) {
      if (r.badFaith && r.actionedAt !== null && r.actionedAt >= since) {
        out.push({ reporter: r.reporterSubject, actionedAt: r.actionedAt });
      }
    }
    return out;
  }

  loadAutoChatGroups(since: number): Array<{ subject: SubjectId; groupId: string }> {
    const seen = new Set<string>();
    const out: Array<{ subject: SubjectId; groupId: string }> = [];
    for (const r of this.sanctions) {
      if (r.kind !== 'chat' || r.source !== 'auto_filter' || r.targetType !== 'subject' || r.startsAt < since) continue;
      const key = `${r.value}\u0000${r.groupId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ subject: r.value, groupId: r.groupId });
    }
    return out;
  }

  /** Test helper (K2 adds dismissing): mark a report bad-faith, dismissed at `actionedAt` (null = never closed). */
  markReportBadFaith(id: string, actionedAt: number | null): void {
    const r = this.reports.find((x) => x.id === id);
    if (!r) throw new Error('unknown report');
    r.badFaith = true;
    r.actionedAt = actionedAt;
    r.status = 'dismissed';
  }

  /** Test helper: close a report without the bad-faith mark. */
  closeReport(id: string, status: 'actioned' | 'dismissed', actionedAt: number): void {
    const r = this.reports.find((x) => x.id === id);
    if (!r) throw new Error('unknown report');
    r.status = status;
    r.actionedAt = actionedAt;
  }

  /** Test helper: every stored report. */
  rawReports(): StoredReportRow[] {
    return this.reports.map((r) => structuredClone(r));
  }

  /** Test helper: every stored strike. */
  rawStrikes(): StrikeRow[] {
    return this.strikes.map((r) => ({ ...r }));
  }

  /** Test helper: every stored mute. */
  rawMutes(): MuteRow[] {
    return [...this.mutes.values()].map((m) => ({ ...m.row }));
  }

  /** Test helper: every stored row, revoked ones included. */
  rawSanctions(): StoredSanction[] {
    return this.sanctions.map((r) => ({ ...r }));
  }
}

const muteKey = (viewer: SubjectId, target: SubjectId): string => `${viewer}\u0000${target}`;

export function memoryStore(): MemoryStore {
  return new MemoryStore();
}
