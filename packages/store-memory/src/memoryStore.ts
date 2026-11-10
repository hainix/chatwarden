import type {
  AuditListQuery,
  AuditRow,
  DecisionRow,
  MuteRow,
  NoticeRow,
  ReportActivity,
  ReportListQuery,
  ReportRecord,
  SanctionRow,
  Store,
  StoredReport,
  StrikeRow,
  SubjectIdRecord,
  SubjectId,
  SubjectRecord,
  WebhookKeyReservation,
  DiscordThreadRow,
} from '@chatwarden/core';

/** 16 random bytes as unpadded base64url (22 characters), from Web Crypto: no `node:` module, so it runs in a browser. */
function newId(): string {
  const web = (globalThis as { crypto?: { getRandomValues(a: Uint8Array): unknown } }).crypto;
  if (!web || typeof web.getRandomValues !== 'function') throw new Error('chatwarden: no secure random source (globalThis.crypto)');
  const raw = new Uint8Array(16);
  web.getRandomValues(raw);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  let i = 0;
  for (; i + 2 < raw.length; i += 3) {
    const n = (raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!;
    out += chars[n >> 18]! + chars[(n >> 12) & 63]! + chars[(n >> 6) & 63]! + chars[n & 63]!;
  }
  const n = raw[i]! << 16; // 16 bytes leave one byte over
  return out + chars[n >> 18]! + chars[(n >> 12) & 63]!;
}

/** A report plus the moderation columns a decision fills. */
export type StoredReportRow = ReportRecord;

/** A stored sanction row plus its revocation, as the SQL table keeps it. */
export interface StoredSanction extends SanctionRow {
  /** The new rule a closed gap became (`ruled`), as text; null otherwise. */
  gapRef: string | null;
  /** Who closed the gap, and when; null while it is open. */
  gapClosedBy: string | null;
  gapClosedAt: number | null;
  revokedBy: string | null;
  revokedAt: number | null;
  revokeReason: string | null;
}

/**
 * In-memory {@link Store}: everything lives in this object and is lost when it is garbage collected or the process ends.
 * For tests, demos and single-process prototypes; use `@chatwarden/store-sqlite` for anything that must survive a
 * restart. It keeps the same rows in the same order as the SQLite adapter (both run one shared contract suite), and
 * `transaction` is real: writes are journaled and a throwing function undoes them, nested calls included.
 *
 * It imports no `node:` module, so it bundles for a browser. Subclass it or overwrite a method on an instance to inject
 * failures in a test.
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
  /** Recorded decisions by key. */
  protected decisions = new Map<string, DecisionRow>();
  /** Notices in insertion order (stands in for SQLite's rowid). */
  protected notices: NoticeRow[] = [];
  /** Staff audit entries in insertion order. */
  protected auditRows: AuditRow[] = [];
  /** Incoming-webhook idempotency keys. */
  protected webhookKeys = new Map<string, { createdAt: number; state: 'pending' | 'done'; resultJson: string | null; fingerprint: string }>();
  /** The Discord feed's thread map by subject. */
  protected discordThreads = new Map<string, DiscordThreadRow>();
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
      if (outer !== null) for (const step of mine) outer.push(step); // not push(...mine): a big array overflows the stack
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
    // Oldest subject first, then by id; identifiers by subject, kind, value: the SQLite adapter's order.
    return Promise.resolve({
      subjects: [...this.subjects.values()]
        .sort((a, b) => a.createdAt - b.createdAt || compare(a.id, b.id))
        .map((s) => ({ ...s })),
      ids: [...this.subjectIds.values()]
        .sort((a, b) => compare(a.subjectId, b.subjectId) || compare(a.kind, b.kind) || compare(a.value, b.value))
        .map((r) => ({ ...r })),
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
      this.sanctions.push({ ...row, gapRef: null, gapClosedBy: null, gapClosedAt: null, revokedBy: null, revokedAt: null, revokeReason: null });
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

  sanctionRefCode(groupId: string): string | null {
    return this.sanctions.find((r) => r.groupId === groupId)?.refCode ?? null;
  }

  sanctionGroupTarget(groupId: string): { subject: SubjectId; rule: string | null } | null {
    const row = this.sanctions.find((r) => r.groupId === groupId && r.targetType === 'subject');
    return row === undefined ? null : { subject: row.value, rule: row.rule };
  }

  loadSanctions(now: number): SanctionRow[] {
    return this.sanctions
      .filter((r) => r.revokedAt === null && (r.endsAt === null || r.endsAt > now))
      .map((r) => this.sanctionRow(r));
  }

  loadSubjectActions(since: number): SanctionRow[] {
    return this.sanctions
      .filter((r) => r.targetType === 'subject' && r.startsAt >= since)
      .map((r) => ({ ...this.sanctionRow(r), revokedAt: r.revokedAt }));
  }

  private sanctionRow(r: StoredSanction): SanctionRow {
    return {
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
      gapNote: r.gapNote,
      gapStatus: r.gapStatus,
      roomId: r.roomId,
      actor: r.actor,
      source: r.source,
      automated: r.automated,
      pending: r.pending,
    };
  }

  listGaps(): SanctionRow[] {
    // Newest first; insertion order breaks a tie, like SQLite's rowid.
    return this.sanctions
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.targetType === 'subject' && r.gapNote !== null)
      .sort((a, b) => b.r.startsAt - a.r.startsAt || b.i - a.i)
      .map(({ r }) => this.sanctionRow(r));
  }

  closeGap(groupId: string, status: 'ruled' | 'not_a_rule', ref: string | null, actor: string, at: number): boolean {
    if (status !== 'ruled' && status !== 'not_a_rule') throw new Error('closeGap: invalid status');
    const row = this.sanctions.find((r) => r.groupId === groupId && r.targetType === 'subject');
    if (row === undefined || row.gapNote === null || row.gapStatus !== 'open') return false;
    // Like SqliteStore: who closed it and when go to the audit trail (no role, the group id as the target). The entry is
    // built first, so a failure drawing its random id leaves the gap open instead of half closed.
    const entry: AuditRow = {
      id: newId(),
      at,
      actor,
      role: null,
      action: 'gap.close',
      target: { type: 'sanction', ref: groupId },
    };
    row.gapStatus = status;
    row.gapRef = ref;
    row.gapClosedBy = actor;
    row.gapClosedAt = at;
    this.auditRows.push(entry);
    this.undoWith(() => {
      row.gapStatus = 'open';
      row.gapRef = null;
      row.gapClosedBy = null;
      row.gapClosedAt = null;
      this.auditRows.splice(this.auditRows.indexOf(entry), 1);
    });
    return true;
  }

  // Staff audit trail (synchronous, see the Store interface).

  insertAudit(row: AuditRow): void {
    if (this.auditRows.some((r) => r.id === row.id)) throw new Error('insertAudit: duplicate id');
    const copy = structuredClone(row);
    this.auditRows.push(copy);
    this.undoWith(() => this.auditRows.splice(this.auditRows.indexOf(copy), 1));
  }

  listAudit(q: AuditListQuery): AuditRow[] {
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit)));
    return this.auditRows
      .filter((r) => {
        if (q.actor !== undefined && r.actor !== q.actor) return false;
        if (q.action !== undefined && r.action !== q.action) return false;
        if (q.before === undefined) return true;
        if (r.at !== q.before) return r.at < q.before;
        return q.beforeId !== undefined && compare(r.id, q.beforeId) < 0;
      })
      .sort((a, b) => b.at - a.at || compare(b.id, a.id))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  purgeAudit(before: number): number {
    const snapshot = [...this.auditRows];
    const kept = snapshot.filter((r) => r.at >= before);
    const n = snapshot.length - kept.length;
    if (n > 0) {
      this.auditRows = kept;
      this.undoWith(() => {
        this.auditRows = snapshot;
      });
    }
    return n;
  }

  // Webhook keys (synchronous, see the Store interface)

  reserveWebhookKey(key: string, now: number, notBefore: number, fingerprint: string): WebhookKeyReservation {
    const existing = this.webhookKeys.get(key);
    if (existing !== undefined && existing.createdAt >= notBefore) {
      return existing.state === 'done' && existing.resultJson !== null
        ? { reserved: false, state: 'done', resultJson: existing.resultJson, fingerprint: existing.fingerprint }
        : { reserved: false, state: 'pending', resultJson: null, fingerprint: existing.fingerprint };
    }
    const prior = existing === undefined ? undefined : { ...existing };
    this.webhookKeys.set(key, { createdAt: now, state: 'pending', resultJson: null, fingerprint });
    this.undoWith(() => {
      if (prior === undefined) this.webhookKeys.delete(key);
      else this.webhookKeys.set(key, prior);
    });
    return { reserved: true };
  }

  completeWebhookKey(key: string, resultJson: string): boolean {
    const row = this.webhookKeys.get(key);
    if (row === undefined || row.state !== 'pending') return false;
    row.state = 'done';
    row.resultJson = resultJson;
    this.undoWith(() => {
      row.state = 'pending';
      row.resultJson = null;
    });
    return true;
  }

  releaseWebhookKey(key: string): boolean {
    const row = this.webhookKeys.get(key);
    if (row === undefined || row.state !== 'pending') return false;
    this.webhookKeys.delete(key);
    this.undoWith(() => this.webhookKeys.set(key, row));
    return true;
  }

  purgeWebhookKeys(before: number): number {
    const gone = [...this.webhookKeys].filter(([, r]) => r.createdAt < before);
    for (const [key] of gone) this.webhookKeys.delete(key);
    if (gone.length > 0) this.undoWith(() => gone.forEach(([key, row]) => this.webhookKeys.set(key, row)));
    return gone.length;
  }

  // Discord threads (synchronous, see the Store interface)

  getDiscordThread(subject: string): DiscordThreadRow | null {
    const row = this.discordThreads.get(subject);
    return row === undefined ? null : { ...row };
  }

  putDiscordThread(row: DiscordThreadRow): void {
    const prior = this.discordThreads.get(row.subject);
    this.discordThreads.set(row.subject, { ...row });
    this.undoWith(() => {
      if (prior === undefined) this.discordThreads.delete(row.subject);
      else this.discordThreads.set(row.subject, prior);
    });
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
    // In write order (a refresh keeps its place, and so does a row an undo puts back), like SQLite's rowid.
    return [...this.mutes.values()]
      .filter((m) => m.row.createdAt >= since)
      .sort((a, b) => a.seq - b.seq)
      .map((m) => ({ ...m.row }));
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
    // Oldest first; the sort is stable, so strikes at the same instant keep their write order.
    return this.strikes
      .filter((r) => r.at >= since)
      .sort((a, b) => a.at - b.at)
      .map((r) => ({ ...r }));
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
    // Only the (reporter, target, room) clash is swallowed; a clashing id still throws, like a primary key.
    if (this.reports.some((r) => r.id === row.id)) throw new Error('UNIQUE constraint failed: kit_reports.id');
    this.reports.push({
      ...structuredClone(row),
      badFaith: false,
      actionedAt: null,
      actionedBy: null,
      modNote: null,
      badFaithEvidence: null,
    });
    this.undoWith(() => {
      this.reports.length -= 1;
    });
    return true;
  }

  loadReport(id: string): ReportRecord | null {
    const r = this.reports.find((x) => x.id === id);
    return r === undefined ? null : structuredClone(r);
  }

  listReportsByPerson(subjects: readonly SubjectId[], limit: number): ReportRecord[] {
    const n = Math.min(200, Math.max(1, Math.floor(limit)));
    const wanted = new Set(subjects);
    return this.reports
      .filter((r) => wanted.has(r.targetSubject))
      .sort((a, b) => b.createdAt - a.createdAt || compare(b.id, a.id))
      .slice(0, n)
      .map((r) => structuredClone(r));
  }

  listReports(q: ReportListQuery): ReportRecord[] {
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit)));
    return this.reports
      .filter((r) => {
        if (q.status !== undefined && r.status !== q.status) return false;
        if (q.before === undefined) return true;
        if (r.createdAt !== q.before) return r.createdAt < q.before;
        return q.beforeId !== undefined && compare(r.id, q.beforeId) < 0;
      })
      .sort((a, b) => b.createdAt - a.createdAt || compare(b.id, a.id))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  closeReport(
    id: string,
    status: 'actioned' | 'dismissed',
    badFaith: boolean,
    actor: string,
    at: number,
    note: string,
    evidence: string | null = null,
  ): boolean {
    const r = this.reports.find((x) => x.id === id);
    if (r === undefined || r.status !== 'open') return false;
    if (status !== 'actioned' && status !== 'dismissed') throw new Error('closeReport: invalid status');
    const before = {
      status: r.status,
      badFaith: r.badFaith,
      actionedAt: r.actionedAt,
      actionedBy: r.actionedBy,
      modNote: r.modNote,
      badFaithEvidence: r.badFaithEvidence,
    };
    r.status = status;
    r.badFaith = badFaith;
    r.actionedAt = at;
    r.actionedBy = actor;
    r.modNote = note;
    r.badFaithEvidence = evidence;
    this.undoWith(() => Object.assign(r, before));
    return true;
  }

  insertDecision(key: string, reportId: string, at: number, resultJson: string): void {
    if (this.decisions.has(key)) throw new Error('UNIQUE constraint failed: kit_decisions.key');
    this.decisions.set(key, { key, reportId, at, resultJson });
    this.undoWith(() => this.decisions.delete(key));
  }

  findDecision(key: string): DecisionRow | null {
    const d = this.decisions.get(key);
    return d === undefined ? null : { ...d };
  }

  loadReportActivity(since: number): ReportActivity[] {
    // Oldest first, ties in write order (the sort is stable).
    return this.reports
      .filter((r) => r.createdAt >= since)
      .sort((a, b) => a.createdAt - b.createdAt)
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
    // Most recently actioned first, ties in write order (the sort is stable).
    return out.sort((a, b) => b.actionedAt - a.actionedAt);
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

  // Retention (synchronous, see the Store interface). Each removes rows in place and journals an undo that
  // restores the previous contents.

  purgeReports(before: number, keepBadFaithSince: number): number {
    const snapshot = [...this.reports];
    const kept = snapshot.filter(
      (r) => r.createdAt >= before || (r.badFaith && r.actionedAt !== null && r.actionedAt >= keepBadFaithSince),
    );
    const n = snapshot.length - kept.length;
    if (n > 0) {
      this.reports = kept;
      // A decision outlives only its report.
      const alive = new Set(kept.map((r) => r.id));
      const dropped = [...this.decisions.values()].filter((d) => !alive.has(d.reportId));
      for (const d of dropped) this.decisions.delete(d.key);
      this.undoWith(() => {
        this.reports = snapshot;
        for (const d of dropped) this.decisions.set(d.key, d);
      });
    }
    return n;
  }

  purgeSanctions(before: number): number {
    const snapshot = [...this.sanctions];
    const owners = new Map(this.refOwners);
    const kept = snapshot.filter(
      (r) =>
        r.gapStatus === 'open' || !((r.endsAt !== null && r.endsAt < before) || (r.revokedAt !== null && r.revokedAt < before)),
    );
    const n = snapshot.length - kept.length;
    if (n > 0) {
      this.sanctions = kept;
      // A ref code is held by the rows that remain; free the codes nothing holds any more.
      const held = new Set(kept.map((r) => r.refCode));
      for (const code of [...this.refOwners.keys()]) if (!held.has(code)) this.refOwners.delete(code);
      this.undoWith(() => {
        this.sanctions = snapshot;
        this.refOwners = owners;
      });
    }
    return n;
  }

  purgeStrikes(before: number): number {
    const snapshot = [...this.strikes];
    const kept = snapshot.filter((r) => r.at >= before);
    const n = snapshot.length - kept.length;
    if (n > 0) {
      this.strikes = kept;
      this.undoWith(() => {
        this.strikes = snapshot;
      });
    }
    return n;
  }

  purgeMutes(before: number): number {
    let n = 0;
    for (const [key, m] of [...this.mutes]) {
      if (m.row.createdAt >= before) continue;
      this.mutes.delete(key);
      this.undoWith(() => this.mutes.set(key, m));
      n++;
    }
    return n;
  }

  // Notices (synchronous, see the Store interface)

  insertNotice(row: NoticeRow): void {
    if (this.notices.some((n) => n.id === row.id)) throw new Error('UNIQUE constraint failed: kit_notices.id');
    this.notices.push(structuredClone(row));
    this.undoWith(() => {
      this.notices.length -= 1;
    });
  }

  loadNotices(subjects: readonly SubjectId[]): NoticeRow[] {
    const want = new Set(subjects);
    return this.notices
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => want.has(n.subject))
      .sort((a, b) => a.n.createdAt - b.n.createdAt || a.i - b.i)
      .map(({ n }) => structuredClone(n));
  }

  ackNotice(id: string, at: number): boolean {
    const n = this.notices.find((x) => x.id === id);
    if (n === undefined || n.ackedAt !== null || n.withdrawnAt !== null) return false;
    n.ackedAt = at;
    this.undoWith(() => {
      n.ackedAt = null;
    });
    return true;
  }

  findNoticeForGroup(
    groupId: string,
  ): { id: string; subject: SubjectId; ackedAt: number | null; withdrawnAt: number | null } | null {
    let best: NoticeRow | null = null;
    for (const n of this.notices) {
      if (n.groupId !== groupId || n.withdrawnAt !== null) continue;
      if (best === null || n.createdAt >= best.createdAt) best = n;
    }
    return best === null ? null : { id: best.id, subject: best.subject, ackedAt: best.ackedAt, withdrawnAt: best.withdrawnAt };
  }

  withdrawNoticeGroup(groupId: string, at: number): number {
    const touched = this.notices.filter((n) => n.groupId === groupId && n.withdrawnAt === null);
    for (const n of touched) n.withdrawnAt = at;
    if (touched.length > 0) {
      this.undoWith(() => {
        for (const n of touched) n.withdrawnAt = null;
      });
    }
    return touched.length;
  }

  purgeNotices(before: number): number {
    const snapshot = [...this.notices];
    const kept = snapshot.filter(
      (n) =>
        !(
          (n.withdrawnAt !== null && n.createdAt < before) ||
          (n.ackedAt !== null && (n.kind === 'warning' || n.kind === 'report_outcome') && n.createdAt < before) ||
          (n.until !== null && n.until < before)
        ),
    );
    const n = snapshot.length - kept.length;
    if (n > 0) {
      this.notices = kept;
      this.undoWith(() => {
        this.notices = snapshot;
      });
    }
    return n;
  }

  /** Inspection helper: every stored notice. */
  rawNotices(): NoticeRow[] {
    return this.notices.map((n) => structuredClone(n));
  }

  /** Inspection helper: every recorded decision. */
  rawDecisions(): DecisionRow[] {
    return [...this.decisions.values()].map((d) => ({ ...d }));
  }

  /** Inspection helper: every stored report. */
  rawReports(): StoredReportRow[] {
    return this.reports.map((r) => structuredClone(r));
  }

  /** Inspection helper: every stored strike. */
  rawStrikes(): StrikeRow[] {
    return this.strikes.map((r) => ({ ...r }));
  }

  /** Inspection helper: every stored mute. */
  rawMutes(): MuteRow[] {
    return [...this.mutes.values()].map((m) => ({ ...m.row }));
  }

  /** Inspection helper: every stored row, revoked ones included. */
  rawSanctions(): StoredSanction[] {
    return this.sanctions.map((r) => ({ ...r }));
  }
}

const muteKey = (viewer: SubjectId, target: SubjectId): string => `${viewer}\u0000${target}`;

/**
 * String order by code point, which is the order of SQLite's default (BINARY) collation on UTF-8 text. JavaScript's `<`
 * compares UTF-16 code units and puts a character outside the BMP before U+E000..U+FFFF; this does not.
 */
function compare(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

/** A new, empty {@link MemoryStore}. */
export function createMemoryStore(): MemoryStore {
  return new MemoryStore();
}
