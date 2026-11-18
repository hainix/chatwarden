import type {
  AiOutcomeRow,
  AiReadRow,
  AuditListQuery,
  AuditRow,
  ChatDayRow,
  ClaimAttempt,
  ClaimMode,
  ClaimRow,
  CommentRow,
  DecisionRow,
  FilterHitRow,
  MuteRow,
  NoticeRow,
  OpenReportQuery,
  PolicyLayer,
  ReasonRow,
  ReportActivity,
  ReportListQuery,
  ReportOrigin,
  ReportRecord,
  ReporterDecision,
  ReporterOutcomeRow,
  ReporterTally,
  SanctionListQuery,
  SanctionRow,
  Store,
  StoredReport,
  StrikeRow,
  SubjectIdRecord,
  SubjectId,
  SubjectRecord,
  WebhookKeyReservation,
  DiscordThreadRow,
  AppealRow,
  BlockedNameRow,
  HeldSet,
  HoldRow,
  InsightRow,
  ErasePlan,
  ErasureCounts,
  ErasureRemoved,
  ErasureRow,
  PrivacyCategory,
  ReportExcerptLine,
  SubjectExport,
} from '@chatwarden/core';

/** Local on purpose: core's randomId is internal, and this package must still link against core 0.1.0 (peer ^0.1.0).
 *  16 random bytes as unpadded base64url (22 characters), from Web Crypto: no `node:` module, so it runs in a browser. */
export function newId(): string {
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

/** The most entries one report's thread holds (core's `COMMENTS_PER_REPORT_MAX`; local because this package imports types only from core). */
const COMMENTS_MAX = 50;
const COMMENT_KINDS: readonly string[] = ['comment', 'ask', 'escalate', 'clear'];

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
  /** The chat-filter hit counters by (day, key, action). */
  protected filterHits = new Map<string, FilterHitRow>();
  /** The staff thread entries of every report, in insertion order. */
  protected comments: CommentRow[] = [];
  /** The daily line counts by UTC day (`desk.insights`). */
  protected chatDays = new Map<string, ChatDayRow>();
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
  /** Soft claims by person (one row each; an expired one is replaced or ignored, never swept). */
  protected claims = new Map<SubjectId, ClaimRow>();
  /** Saved reasons in the order they were added. */
  protected reasons: ReasonRow[] = [];
  /** The stored policy layer and its version, or null when none was ever saved. */
  protected policy: { layer: PolicyLayer; version: number } | null = null;
  /** AI reads in insertion order (one row per report and input hash). */
  protected aiReads: AiReadRow[] = [];
  /** The AI spend ledger: one entry per attempt (a call started), booked at the time it was reserved. */
  protected aiSpend: Array<{ readId: string; attempt: number; at: number; micros: number }> = [];
  /** AI casebook outcomes by report. */
  protected aiOutcomes = new Map<string, AiOutcomeRow>();
  /** Legal holds by report id (open and released). */
  protected holds = new Map<string, HoldRow>();
  /** Erasure receipts in insertion order. */
  protected erasures: ErasureRow[] = [];
  /** The erasure epoch (see `erasureEpoch`). */
  private epoch = 0;
  /** The change token's counter (see `changeToken`). */
  private changes = 0;
  /** Undo steps of the innermost open transaction, or null outside one. */
  private journal: Array<() => void> | null = null;

  protected undoWith(step: () => void): void {
    this.journal?.push(step);
  }

  /** Move the change token; an undone transaction moves it back. */
  protected bump(): void {
    this.changes += 1;
    this.undoWith(() => {
      this.changes -= 1;
    });
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
    // A subject that does not exist (erased, perhaps by another process) writes nothing: a stale writer can never recreate an identifier.
    if (!this.subjects.has(record.subjectId)) return Promise.resolve();
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
    this.bump();
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
    if (touched.length > 0) this.bump();
    return touched.length;
  }

  sanctionGroupByRef(refCode: string): string | null {
    return this.refOwners.get(refCode) ?? null;
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

  protected sanctionRow(r: StoredSanction): SanctionRow {
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

  listSubjectSanctions(q: SanctionListQuery): SanctionRow[] {
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit)));
    const wanted = q.subjects === undefined ? null : new Set(q.subjects);
    // A scope keeps only the rows made from a report whose own scope is one of these (a row with no report, or a report with no scope, never matches).
    const scoped = q.scope === undefined ? null : new Set(this.reports.filter((x) => inScope(x, q.scope)).map((x) => x.id));
    return this.sanctions
      .filter((r) => {
        if (r.targetType !== 'subject') return false;
        if (scoped !== null && !(r.reportId !== undefined && r.reportId !== null && scoped.has(r.reportId))) return false;
        if (wanted !== null && !wanted.has(r.value)) return false;
        if (q.groupId !== undefined && r.groupId !== q.groupId) return false;
        if (q.source !== undefined && r.source !== q.source) return false;
        if (q.activeAt !== undefined && !(r.revokedAt === null && (r.endsAt === null || r.endsAt > q.activeAt))) return false;
        if (q.since !== undefined && r.startsAt < q.since && !(q.alsoPermanent === true && r.endsAt === null && r.revokedAt === null)) {
          return false;
        }
        if (q.before === undefined) return true;
        if (r.startsAt !== q.before) return r.startsAt < q.before;
        return q.beforeId !== undefined && compare(r.id, q.beforeId) < 0;
      })
      .sort((a, b) => b.startsAt - a.startsAt || compare(b.id, a.id))
      .slice(0, limit)
      .map((r) => ({ ...this.sanctionRow(r), revokedAt: r.revokedAt, revokedBy: r.revokedBy, revokeReason: r.revokeReason }));
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
    this.bump();
    return true;
  }

  // Team workbench (synchronous, see the Store interface). Single-threaded, so each check-and-set below is atomic.

  changeToken(): string {
    return String(this.changes);
  }

  claimCase(person: SubjectId, by: string, now: number, until: number, mode: ClaimMode): ClaimAttempt {
    const prior = this.claims.get(person);
    const live = prior !== undefined && prior.until > now ? prior : undefined;
    const mine = live !== undefined && live.by === by;
    const wins = live === undefined || (mode === 'takeover') || (mine && mode === 'claim');
    if (!wins) return { won: false, claim: { ...live! } };
    const claim: ClaimRow = { person, by, since: mine ? live.since : now, until };
    this.claims.set(person, claim);
    this.undoWith(() => {
      if (prior === undefined) this.claims.delete(person);
      else this.claims.set(person, prior);
    });
    // A heartbeat keeps the owner; everything else (fresh, expired, taken over) changes it.
    if (!mine) this.bump();
    return { won: true, claim: { ...claim }, from: live !== undefined && !mine ? live.by : null };
  }

  releaseClaim(person: SubjectId, by: string, now: number): boolean {
    const prior = this.claims.get(person);
    if (prior === undefined || prior.by !== by) return false;
    this.claims.delete(person);
    this.undoWith(() => this.claims.set(person, prior));
    if (prior.until <= now) return false;
    this.bump();
    return true;
  }

  loadClaims(persons: readonly SubjectId[], now: number): ClaimRow[] {
    const out: ClaimRow[] = [];
    for (const person of new Set(persons)) {
      const c = this.claims.get(person);
      if (c !== undefined && c.until > now) out.push({ ...c });
    }
    return out.sort((a, b) => compare(a.person, b.person));
  }

  listReasons(): ReasonRow[] {
    return this.reasons.map((r) => ({ ...r }));
  }

  insertReason(row: ReasonRow): void {
    if (this.reasons.some((r) => r.id === row.id)) throw new Error('UNIQUE constraint failed: kit_reasons.id');
    this.reasons.push({ id: row.id, label: row.label, text: row.text, active: row.active });
    this.undoWith(() => {
      this.reasons.length -= 1;
    });
    this.bump();
  }

  updateReason(id: string, patch: { label?: string; text?: string }): boolean {
    const r = this.reasons.find((x) => x.id === id);
    if (r === undefined) return false;
    const before = { label: r.label, text: r.text };
    const label = patch.label ?? r.label;
    const text = patch.text ?? r.text;
    if (label === before.label && text === before.text) return true;
    r.label = label;
    r.text = text;
    this.undoWith(() => Object.assign(r, before));
    this.bump();
    return true;
  }

  setReasonActive(id: string, active: boolean): boolean {
    const r = this.reasons.find((x) => x.id === id);
    if (r === undefined) return false;
    if (r.active === active) return true;
    r.active = active;
    this.undoWith(() => {
      r.active = !active;
    });
    this.bump();
    return true;
  }

  // The editable profile's stored layer (synchronous, see the Store interface). Not a queue change: it does not move the token.

  loadPolicyLayer(): { layer: PolicyLayer; version: number } | null {
    return this.policy === null ? null : { layer: structuredClone(this.policy.layer), version: this.policy.version };
  }

  savePolicyLayer(layer: PolicyLayer, expectedVersion: number): number | null {
    const current = this.policy?.version ?? 0;
    if (expectedVersion !== current) return null;
    const prior = this.policy;
    this.policy = { layer: structuredClone(layer), version: current + 1 };
    this.undoWith(() => {
      this.policy = prior;
    });
    return current + 1;
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
        if (q.targets !== undefined && !q.targets.slice(0, 20).some((t) => r.target !== null && r.target.type === t.type && r.target.ref === t.ref)) return false;
        if (q.before === undefined) return true;
        if (r.at !== q.before) return r.at < q.before;
        return q.beforeId !== undefined && compare(r.id, q.beforeId) < 0;
      })
      .sort((a, b) => b.at - a.at || compare(b.id, a.id))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  purgeAudit(before: number): number {
    // An erasure receipt lives as long as an audit row; one that still keeps a subject (a pending remainder) is never dropped.
    const receipts = this.erasures;
    if (receipts.some((r) => r.at < before && r.pendingSubject === null)) {
      this.erasures = receipts.filter((r) => !(r.at < before && r.pendingSubject === null));
      this.undoWith(() => {
        this.erasures = receipts;
      });
    }
    const snapshot = [...this.auditRows];
    // The audit rows that name a held report or one of its sanction groups stay with them.
    const heldReports = this.heldReportIds();
    const heldGroups = this.heldGroupIds();
    const kept = snapshot.filter(
      (r) => r.at >= before || (r.target !== null && ((r.target.type === 'report' && heldReports.has(r.target.ref)) || (r.target.type === 'sanction' && heldGroups.has(r.target.ref)))),
    );
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
      this.mutes.set(key, { row: { ...row, block: row.block === true }, seq: ++this.muteSeq });
      this.undoWith(() => this.mutes.delete(key));
    } else {
      const before = { at: existing.row.createdAt, block: existing.row.block };
      existing.row.createdAt = row.createdAt;
      // A mute never downgrades a block.
      existing.row.block = existing.row.block || row.block === true;
      this.undoWith(() => {
        existing.row.createdAt = before.at;
        existing.row.block = before.block;
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
      .filter((m) => m.row.block || m.row.createdAt >= since)
      .sort((a, b) => a.seq - b.seq)
      .map((m) => ({ ...m.row }));
  }

  pruneMutes(viewer: SubjectId, keep: number): SubjectId[] {
    const mine = [...this.mutes.entries()].filter(([, m]) => m.row.viewer === viewer);
    // Only mutes go, oldest first, until the list is down to `keep`; a block is never dropped (so blocks alone can leave more than `keep`).
    const mutesOnly = mine.filter(([, m]) => !m.row.block).sort(([, a], [, b]) => a.row.createdAt - b.row.createdAt || a.seq - b.seq);
    const drop = mutesOnly.slice(0, Math.max(0, Math.min(mutesOnly.length, mine.length - Math.max(0, keep))));
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

  listStrikes(since: number, limit: number): StrikeRow[] {
    const n = Math.min(500, Math.max(1, Math.floor(limit)));
    return this.strikes
      .filter((r) => r.at >= since)
      .sort((a, b) => b.at - a.at || compare(b.id, a.id))
      .slice(0, n)
      .map((r) => ({ ...r }));
  }

  countStrikesByTerm(since: number): Array<{ termId: string; count: number }> {
    const counts = new Map<string, number>();
    for (const r of this.strikes) if (r.at >= since) counts.set(r.termId, (counts.get(r.termId) ?? 0) + 1);
    return [...counts].sort((a, b) => compare(a[0], b[0])).map(([termId, count]) => ({ termId, count }));
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
    const origin = row.origin ?? null;
    const dup = this.reports.some(
      (r) => r.reporterSubject === row.reporterSubject && r.targetSubject === row.targetSubject && r.roomId === row.roomId,
    );
    if (dup) return false;
    // One OPEN filter report for a person in a room (the partial unique index of the SQLite store).
    if (origin === 'filter' && this.reports.some((r) => r.origin === 'filter' && r.status === 'open' && r.targetSubject === row.targetSubject && r.roomId === row.roomId)) return false;
    // Only the (reporter, target, room) clash is swallowed; a clashing id still throws, like a primary key.
    if (this.reports.some((r) => r.id === row.id)) throw new Error('UNIQUE constraint failed: kit_reports.id');
    this.reports.push({
      ...structuredClone(row),
      origin,
      originKey: row.originKey ?? null,
      reportedReason: row.reportedReason ?? null,
      detailAt: null,
      urgent: row.urgent === true,
      evidenceRef: row.evidenceRef ?? null,
      scope: row.scope ?? null,
      entity: row.entity ?? null,
      handoffAt: null,
      handoffBy: null,
      escalatedTo: null,
      escalatedBy: null,
      escalatedAt: null,
      badFaith: false,
      actionedAt: null,
      actionedBy: null,
      modNote: null,
      badFaithEvidence: null,
    });
    this.undoWith(() => {
      this.reports.length -= 1;
    });
    this.bump();
    return true;
  }

  loadReport(id: string): ReportRecord | null {
    const r = this.reports.find((x) => x.id === id);
    return r === undefined ? null : structuredClone(r);
  }

  loadReportInScope(id: string, scope: readonly string[]): ReportRecord | null {
    const r = this.reports.find((x) => x.id === id);
    return r === undefined || !inScope(r, scope) ? null : structuredClone(r);
  }

  countOriginReports(origin: ReportOrigin, since: number): number {
    return this.reports.filter((r) => r.origin === origin && r.createdAt >= since).length;
  }

  addFilterHits(rows: readonly FilterHitRow[]): void {
    for (const r of rows) {
      const k = `${r.day} ${r.key} ${r.action}`;
      const held = this.filterHits.get(k);
      if (held === undefined) {
        this.filterHits.set(k, { ...r });
        this.undoWith(() => this.filterHits.delete(k));
      } else {
        const before = held.hits;
        held.hits += r.hits;
        this.undoWith(() => {
          held.hits = before;
        });
      }
    }
  }

  listFilterHits(sinceDay: number, untilDay: number): FilterHitRow[] {
    const less = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return [...this.filterHits.values()]
      .filter((r) => r.day >= sinceDay && r.day <= untilDay)
      .sort((a, b) => a.day - b.day || less(a.key, b.key) || less(a.action, b.action))
      .map((r) => ({ ...r }));
  }

  purgeFilterHits(beforeDay: number): number {
    const gone = [...this.filterHits].filter(([, r]) => r.day < beforeDay);
    for (const [k] of gone) this.filterHits.delete(k);
    if (gone.length > 0) this.undoWith(() => gone.forEach(([k, r]) => this.filterHits.set(k, r)));
    return gone.length;
  }

  listReportsByPerson(subjects: readonly SubjectId[], limit: number, scope?: readonly string[]): ReportRecord[] {
    const n = Math.min(200, Math.max(1, Math.floor(limit)));
    const wanted = new Set(subjects);
    return this.reports
      .filter((r) => wanted.has(r.targetSubject) && inScope(r, scope))
      .sort((a, b) => b.createdAt - a.createdAt || compare(b.id, a.id))
      .slice(0, n)
      .map((r) => structuredClone(r));
  }

  listOpenReports(q: OpenReportQuery): ReportRecord[] {
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit)));
    return this.reports
      .filter((r) => {
        if (r.status !== 'open') return false;
        if (q.category !== undefined && r.category !== q.category) return false;
        if (q.reason !== undefined && (r.reportedReason ?? null) !== q.reason) return false;
        if (q.urgent === true && !r.urgent) return false;
        if (!inScope(r, q.scope)) return false;
        if (q.after === undefined) return true;
        if (r.createdAt !== q.after) return r.createdAt > q.after;
        return q.afterId !== undefined && compare(r.id, q.afterId) > 0;
      })
      .sort((a, b) => a.createdAt - b.createdAt || compare(a.id, b.id))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  listOpenReportsByPerson(subjects: readonly SubjectId[], limit: number, scope?: readonly string[]): ReportRecord[] {
    const n = Math.min(201, Math.max(1, Math.floor(limit)));
    const wanted = new Set(subjects);
    return this.reports
      .filter((r) => r.status === 'open' && wanted.has(r.targetSubject) && inScope(r, scope))
      .sort((a, b) => b.createdAt - a.createdAt || compare(b.id, a.id))
      .slice(0, n)
      .map((r) => structuredClone(r));
  }

  listOpenReportsByReporter(reporters: readonly SubjectId[], limit: number): ReportRecord[] {
    const n = Math.min(201, Math.max(1, Math.floor(limit)));
    const wanted = new Set(reporters);
    return this.reports
      .filter((r) => r.status === 'open' && r.origin === null && wanted.has(r.reporterSubject))
      .sort((a, b) => b.createdAt - a.createdAt || compare(b.id, a.id))
      .slice(0, n)
      .map((r) => structuredClone(r));
  }

  reporterTally(reporters: readonly SubjectId[]): ReporterTally {
    const tally: ReporterTally = { open: 0, actioned: 0, dismissed: 0, badFaith: 0 };
    const wanted = new Set(reporters);
    for (const r of this.reports) {
      if (r.origin !== null || !wanted.has(r.reporterSubject)) continue;
      tally[r.status] += 1;
      if (r.badFaith) tally.badFaith += 1;
    }
    return tally;
  }

  reporterOutcomes(reporters: readonly SubjectId[], since: number): ReporterOutcomeRow[] {
    const wanted = new Set(reporters);
    const by = new Map<SubjectId, ReporterOutcomeRow>();
    for (const r of this.reports) {
      if (r.origin !== null || !wanted.has(r.reporterSubject) || r.status === 'open' || r.createdAt < since) continue;
      // A report about someone who may be at risk is never a reporter's false report: it is left out of the numbers.
      if (r.reportedReason === 'welfare') continue;
      const row = by.get(r.reporterSubject) ?? { reporter: r.reporterSubject, actioned: 0, noAction: 0, badFaith: 0 };
      if (r.status === 'actioned') row.actioned += 1;
      else if (r.badFaith) row.badFaith += 1;
      else row.noAction += 1;
      by.set(r.reporterSubject, row);
    }
    return [...by.values()];
  }

  listReports(q: ReportListQuery): ReportRecord[] {
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit)));
    return this.reports
      .filter((r) => {
        if (q.status !== undefined && r.status !== q.status) return false;
        if (q.reason !== undefined && r.reportedReason !== q.reason) return false;
        if (q.urgent === true && !r.urgent) return false;
        if (!inScope(r, q.scope)) return false;
        if (q.before === undefined) return true;
        if (r.createdAt !== q.before) return r.createdAt < q.before;
        return q.beforeId !== undefined && compare(r.id, q.beforeId) < 0;
      })
      .sort((a, b) => b.createdAt - a.createdAt || compare(b.id, a.id))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  loadReporterDecisions(reporters: readonly SubjectId[]): ReporterDecision[] {
    const wanted = new Set(reporters);
    const out: ReporterDecision[] = [];
    // The newest 200 decided reports with a reason, newest first.
    const decided = this.reports
      .filter((r) => r.origin === null && wanted.has(r.reporterSubject) && r.status !== 'open' && (r.reportedReason ?? null) !== null)
      .sort((a, b) => b.createdAt - a.createdAt || compare(b.id, a.id))
      .slice(0, 200);
    for (const r of decided) {
      if (r.reportedReason == null || r.status === 'open') continue;
      const groups = new Set<string>();
      for (const d of this.decisions.values()) {
        if (d.reportId !== r.id) continue;
        // A row that cannot be read is a decision with no known actions, never a failure of the call.
        let parsed: { groups?: unknown } | null;
        try {
          parsed = JSON.parse(d.resultJson) as { groups?: unknown } | null;
        } catch {
          parsed = null;
        }
        if (parsed !== null && Array.isArray(parsed.groups)) {
          for (const g of parsed.groups as Array<{ groupId?: unknown } | null>) if (typeof g?.groupId === 'string') groups.add(g.groupId);
        }
      }
      const actions: ReporterDecision['actions'] = [];
      for (const s of this.sanctions) {
        if (!groups.has(s.groupId) || s.targetType !== 'subject') continue;
        actions.push({ subject: s.value, rule: s.rule !== null && /^[1-9][0-9]*$/.test(s.rule) ? Number(s.rule) : 'uncovered' });
      }
      out.push({ reportId: r.id, status: r.status, reason: r.reportedReason, target: r.targetSubject, actions });
    }
    return out;
  }

  addReportDetail(id: string, detail: { reportedReason: string | null; category: ReportRecord['category']; note: string | null; at: number }): boolean {
    const r = this.reports.find((x) => x.id === id);
    if (r === undefined || r.status !== 'open' || r.detailAt !== null) return false;
    const before = { reportedReason: r.reportedReason, category: r.category, note: r.note, detailAt: r.detailAt };
    r.reportedReason = detail.reportedReason;
    r.category = detail.category;
    r.note = detail.note;
    r.detailAt = detail.at;
    this.undoWith(() => Object.assign(r, before));
    this.bump();
    return true;
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
    this.bump();
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
      .filter((r) => r.createdAt >= since && (r.origin ?? null) === null)
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
    const held = this.heldReportIds();
    return this.dropReports(
      (r) => r.createdAt >= before || (r.badFaith && r.actionedAt !== null && r.actionedAt >= keepBadFaithSince) || held.has(r.id),
    );
  }

  /**
   * Delete the reports `keep` says to drop (it returns true for a report that STAYS), with everything that goes with a report: its recorded decisions, its AI reads and its
   * staff comments, all journaled. Returns how many reports it deleted.
   */
  private dropReports(keep: (r: StoredReportRow) => boolean): number {
    const snapshot = [...this.reports];
    const kept = snapshot.filter(keep);
    const n = snapshot.length - kept.length;
    if (n > 0) {
      this.reports = kept;
      // A decision outlives only its report.
      const alive = new Set(kept.map((r) => r.id));
      const dropped = [...this.decisions.values()].filter((d) => !alive.has(d.reportId));
      for (const d of dropped) this.decisions.delete(d.key);
      // An AI read is a view of its report and goes with it. The casebook outcome has its own clock (`purgeAi`).
      const reads = this.aiReads;
      const gone = new Set(snapshot.filter((r) => !alive.has(r.id)).map((r) => r.id));
      this.aiReads = reads.filter((r) => !gone.has(r.reportId));
      // So does the staff thread.
      const comments = this.comments;
      this.comments = comments.filter((c) => !gone.has(c.reportId));
      this.undoWith(() => {
        this.reports = snapshot;
        this.aiReads = reads;
        this.comments = comments;
        for (const d of dropped) this.decisions.set(d.key, d);
      });
    }
    return n;
  }

  purgeReportsByReason(reason: string, before: number): number {
    const held = this.heldReportIds();
    return this.dropReports((r) => r.reportedReason !== reason || r.createdAt >= before || held.has(r.id));
  }

  // The urgent lane, the staff workflow and Insights (synchronous, see the Store interface).

  setReportUrgent(id: string, on: boolean): boolean {
    const r = this.reports.find((x) => x.id === id);
    if (r === undefined || r.status !== 'open' || r.urgent === on) return false;
    const before = r.urgent;
    r.urgent = on;
    this.undoWith(() => {
      r.urgent = before;
    });
    this.bump();
    return true;
  }

  setHandoff(id: string, by: string, at: number): boolean {
    const r = this.reports.find((x) => x.id === id);
    if (r === undefined || r.handoffAt !== null) return false;
    const before = { handoffAt: r.handoffAt, handoffBy: r.handoffBy };
    r.handoffAt = at;
    r.handoffBy = by;
    this.undoWith(() => Object.assign(r, before));
    this.bump();
    return true;
  }

  setEscalation(id: string, patch: { to: 'senior' | 'owner'; by: string; at: number } | null): boolean {
    if (patch !== null && patch.to !== 'senior' && patch.to !== 'owner') throw new Error('setEscalation: to must be senior or owner');
    const r = this.reports.find((x) => x.id === id);
    if (r === undefined || r.status !== 'open') return false;
    const next = patch === null ? { escalatedTo: null, escalatedBy: null, escalatedAt: null } : { escalatedTo: patch.to, escalatedBy: patch.by, escalatedAt: patch.at };
    if (r.escalatedTo === next.escalatedTo && r.escalatedBy === next.escalatedBy && r.escalatedAt === next.escalatedAt) return false;
    const before = { escalatedTo: r.escalatedTo, escalatedBy: r.escalatedBy, escalatedAt: r.escalatedAt };
    Object.assign(r, next);
    this.undoWith(() => Object.assign(r, before));
    this.bump();
    return true;
  }

  countOpenUrgent(scope?: readonly string[]): number {
    return this.reports.filter((r) => r.status === 'open' && r.urgent && inScope(r, scope)).length;
  }

  countOpenEscalated(): Record<'senior' | 'owner', number> {
    const out = { senior: 0, owner: 0 };
    for (const r of this.reports) if (r.status === 'open' && r.escalatedTo !== null) out[r.escalatedTo] += 1;
    return out;
  }

  insertComment(row: CommentRow): boolean {
    if (!this.reports.some((r) => r.id === row.reportId)) return false;
    if (this.comments.filter((c) => c.reportId === row.reportId).length >= COMMENTS_MAX) return false;
    // After the two refusals above, like the SQLite statement order: a bad kind or a clashing id throws, as a CHECK and a primary key do.
    if (!COMMENT_KINDS.includes(row.kind)) throw new Error('CHECK constraint failed: kit_report_comments.kind');
    if (this.comments.some((c) => c.id === row.id)) throw new Error('UNIQUE constraint failed: kit_report_comments.id');
    this.comments.push({ ...row });
    this.undoWith(() => {
      this.comments.length -= 1;
    });
    this.bump();
    return true;
  }

  listComments(reportId: string): CommentRow[] {
    return this.comments
      .filter((c) => c.reportId === reportId)
      .sort((a, b) => a.at - b.at || compare(a.id, b.id))
      .map((c) => ({ ...c }));
  }

  deleteComment(id: string): boolean {
    const at = this.comments.findIndex((c) => c.id === id);
    if (at < 0) return false;
    const [gone] = this.comments.splice(at, 1);
    this.undoWith(() => {
      this.comments.splice(at, 0, gone as CommentRow);
    });
    this.bump();
    return true;
  }

  countComments(reportId: string): number {
    return this.comments.filter((c) => c.reportId === reportId).length;
  }

  addChatCounts(day: string, delivered: number, refused: number): void {
    const held = this.chatDays.get(day);
    if (held === undefined) {
      this.chatDays.set(day, { day, delivered, refused });
      this.undoWith(() => this.chatDays.delete(day));
    } else {
      const before = { delivered: held.delivered, refused: held.refused };
      held.delivered += delivered;
      held.refused += refused;
      this.undoWith(() => Object.assign(held, before));
    }
  }

  chatCounts(fromDay: string, toDay: string): ChatDayRow[] {
    return [...this.chatDays.values()]
      .filter((r) => r.day >= fromDay && r.day <= toDay)
      .sort((a, b) => compare(a.day, b.day))
      .map((r) => ({ ...r }));
  }

  purgeChatCounts(beforeDay: string): number {
    const gone = [...this.chatDays].filter(([day]) => day < beforeDay);
    for (const [day] of gone) this.chatDays.delete(day);
    if (gone.length > 0) this.undoWith(() => gone.forEach(([day, r]) => this.chatDays.set(day, r)));
    return gone.length;
  }

  insightRows(since: number, limit: number): InsightRow[] {
    const n = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
    return this.reports
      .filter((r) => r.createdAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt || compare(b.id, a.id))
      .slice(0, n)
      .map((r) => ({ createdAt: r.createdAt, actionedAt: r.actionedAt, status: r.status, reportedReason: r.reportedReason, urgent: r.urgent, badFaith: r.badFaith }));
  }

  purgeSanctions(before: number): number {
    const snapshot = [...this.sanctions];
    const owners = new Map(this.refOwners);
    const heldGroups = this.heldGroupIds();
    const kept = snapshot.filter(
      (r) =>
        r.gapStatus === 'open' || heldGroups.has(r.groupId) || !((r.endsAt !== null && r.endsAt < before) || (r.revokedAt !== null && r.revokedAt < before)),
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
      // A block is never purged by age.
      if (m.row.block || m.row.createdAt >= before) continue;
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

  withdrawNotice(id: string, at: number): boolean {
    const n = this.notices.find((x) => x.id === id);
    if (n === undefined || n.withdrawnAt !== null) return false;
    n.withdrawnAt = at;
    this.undoWith(() => {
      n.withdrawnAt = null;
    });
    return true;
  }

  purgeNotices(before: number, unseen?: { appealBefore: number; renameBefore: number }): number {
    const snapshot = [...this.notices];
    // A seen notice of these kinds goes after the cutoff; the rest of the kinds follow their end time. An unseen message notice (an
    // appeal outcome, a required rename) stays until it is seen or withdrawn. Spelled out here, not imported: this package links to old cores.
    const seenGoes = ['warning', 'report_outcome', 'rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked'];
    // An unseen message notice has a ceiling, given by the caller (an older caller gives none: it is kept).
    const appealKinds = ['appeal_upheld', 'appeal_reduced', 'appeal_revoked'];
    const pastCeiling = (n: NoticeRow): boolean =>
      unseen !== undefined &&
      n.ackedAt === null &&
      ((appealKinds.includes(n.kind) && n.createdAt < unseen.appealBefore) || (n.kind === 'rename_required' && n.createdAt < unseen.renameBefore));
    const heldGroups = this.heldGroupIds();
    const kept = snapshot.filter(
      (n) =>
        (n.groupId !== null && heldGroups.has(n.groupId)) ||
        !(
          (n.withdrawnAt !== null && n.createdAt < before) ||
          (n.ackedAt !== null && seenGoes.includes(n.kind) && n.createdAt < before) ||
          pastCeiling(n) ||
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

  // Privacy requests (0.2.0, design section 5). The same rules, in the same order, as the SQLite store (privacy.ts there), with the same counts. Every collection
  // the erase changes is REPLACED, and an undo step puts the old one back, so a failing transaction (or a dry run) leaves the store as it was.

  /** Replace a collection and journal the way back. */
  private swap<T>(current: T, next: T, assign: (v: T) => void): void {
    assign(next);
    this.undoWith(() => assign(current));
  }

  /** The subjects of the request that exist, and every subject merged into one of them. */
  private closure(subjects: readonly SubjectId[]): Set<SubjectId> {
    const out = new Set<SubjectId>();
    for (const id of subjects) if (this.subjects.has(id)) out.add(id);
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of this.subjects.values()) {
        if (!out.has(s.id) && s.mergedInto !== null && out.has(s.mergedInto)) {
          out.add(s.id);
          grew = true;
        }
      }
    }
    return out;
  }

  eraseSubjects(plan: ErasePlan): ErasureCounts {
    const set = this.closure(plan.subjects);
    if (set.size === 0) return { found: false, removed: {}, kept: { identifiers: false, sanctions: 0, heldReports: 0 }, pending: null, closure: [] };
    if (plan.dryRun !== true) return this.transaction(() => this.eraseNow(plan, set));
    let counts: ErasureCounts | null = null;
    try {
      this.transaction(() => {
        counts = this.eraseNow(plan, set);
        throw new DryRunRollback();
      });
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    }
    if (counts === null) throw new Error('eraseSubjects: dry run produced no counts');
    return counts;
  }

  private eraseNow(plan: ErasePlan, set: ReadonlySet<SubjectId>): ErasureCounts {
    const hooks = this as unknown as Partial<PrivacyHooks>;
    const removed: ErasureRemoved = {};
    const add = (category: PrivacyCategory, n: number): void => {
      if (n > 0) removed[category] = (removed[category] ?? 0) + n;
    };
    // The store consults its own holds, whatever the caller passed: an erase can never reach a held report.
    const held = new Set([...plan.heldReportIds, ...this.heldReportIds()]);

    // Which sanction groups stay: a held report's groups always; in `safety`, the groups in force on the person.
    const personGroups = new Set(this.sanctions.filter((r) => r.targetType === 'subject' && set.has(r.value)).map((r) => r.groupId));
    const heldGroups = new Set(this.sanctions.filter((r) => r.reportId != null && held.has(r.reportId)).map((r) => r.groupId));
    const inForce = new Set(
      plan.mode === 'safety'
        ? this.sanctions
            .filter(
              (r) =>
                r.targetType === 'subject' &&
                set.has(r.value) &&
                r.revokedAt === null &&
                (r.endsAt === null || r.endsAt > plan.at) &&
                (r.kind === 'chat' || r.kind === 'area' || r.kind === 'ban'),
            )
            .map((r) => r.groupId)
        : [],
    );
    const keepIdentifiers = inForce.size > 0;
    const keepGroups = new Set([...personGroups].filter((g) => inForce.has(g) || heldGroups.has(g)));
    const goneGroups = new Set([...personGroups].filter((g) => !keepGroups.has(g)));
    const clearGroups = new Set([...keepGroups].filter((g) => inForce.has(g) && !heldGroups.has(g)));
    const keptSanctionRows = this.sanctions.filter((r) => keepGroups.has(r.groupId)).length;
    const heldNaming = this.reports.filter((r) => held.has(r.id) && (set.has(r.targetSubject) || set.has(r.reporterSubject) || r.people.some((p) => set.has(p)))).length;

    // Reports about the person go, with everything that hangs on them.
    const about = new Set(this.reports.filter((r) => set.has(r.targetSubject) && !held.has(r.id)).map((r) => r.id));
    if (about.size > 0) {
      const decisions = new Map(this.decisions);
      for (const d of decisions.values()) if (about.has(d.reportId)) this.decisions.delete(d.key);
      this.undoWith(() => {
        this.decisions = decisions;
      });
      const reads = this.aiReads;
      const keptReads = reads.filter((r) => !about.has(r.reportId));
      add('ai', reads.length - keptReads.length);
      this.swap(reads, keptReads, (v) => (this.aiReads = v));
      const outcomes = this.aiOutcomes;
      const keptOutcomes = new Map([...outcomes].filter(([id]) => !about.has(id)));
      add('ai', outcomes.size - keptOutcomes.size);
      this.swap(outcomes, keptOutcomes, (v) => (this.aiOutcomes = v));
      add('ai', hooks.privacyEraseAiActions?.(about) ?? 0);
      for (const r of this.sanctions) {
        if (r.reportId == null || !about.has(r.reportId)) continue;
        const before = r.reportId;
        r.reportId = null;
        this.undoWith(() => {
          r.reportId = before;
        });
      }
      hooks.privacyUnlinkAppealReports?.(about);
      // The staff thread of a deleted report goes with it (staff workflow rows).
      const comments = this.comments;
      const keptComments = comments.filter((c) => !about.has(c.reportId));
      add('workflow', comments.length - keptComments.length);
      this.swap(comments, keptComments, (v) => (this.comments = v));
      const kept = this.reports.filter((r) => !about.has(r.id));
      add('reports_about', this.reports.length - kept.length);
      this.swap(this.reports, kept, (v) => (this.reports = v));
    }

    // The person's name inside the decisions of the reports that stay (a decision can sanction anyone in its report: a speaker, the reporter): the entries for the set
    // go, unless their sanction group stays. A held report's decision is never touched. An answer that cannot be read and names the person is blanked.
    const redacted = new Map<string, DecisionRow>();
    for (const d of this.decisions.values()) {
      if (held.has(d.reportId)) continue;
      const next = redactDecision(d.resultJson, set, keepGroups);
      if (next !== null) redacted.set(d.key, { ...d, resultJson: next });
    }
    if (redacted.size > 0) this.swap(this.decisions, new Map([...this.decisions].map(([k, d]) => [k, redacted.get(k) ?? d] as [string, DecisionRow])), (v) => (this.decisions = v));

    // The person's name inside the other reports that stay: a reporter becomes `erased:<id>`, a line becomes a marker.
    const scrubbed = new Set<string>();
    const readsGone = new Set<string>();
    const reports = this.reports.map((r) => {
      if (held.has(r.id)) return r;
      const asReporter = set.has(r.reporterSubject);
      const lines = scrubExcerpt(r.people, r.excerpt, set);
      if (!asReporter && lines === null) return r;
      if (asReporter) add('reports_filed', 1);
      else add('report_lines', 1);
      if (lines !== null) scrubbed.add(r.id);
      // The AI's summary of a report can quote a line or the reporter's note (cleared below): the read goes with either.
      if (lines !== null || asReporter) readsGone.add(r.id);
      return {
        ...r,
        ...(asReporter ? { reporterSubject: `erased:${r.id}`, reporterSeat: '', reporterHandle: '', note: null, entity: null } : {}),
        ...(lines === null ? {} : { people: lines.people, excerpt: lines.excerpt }),
      };
    });
    if (reports.some((r, i) => r !== this.reports[i])) this.swap(this.reports, reports, (v) => (this.reports = v));
    if (readsGone.size > 0) {
      // A staff comment on a report that stays can quote the person: its text goes too (who wrote it and when stay: staff rows). Counted under `workflow`.
      const comments = this.comments;
      const scrubbedComments = comments.map((c) => (readsGone.has(c.reportId) && c.text !== null && c.text !== ERASED_LINE ? { ...c, text: ERASED_LINE } : c));
      add('workflow', scrubbedComments.filter((c, i) => c !== comments[i]).length);
      this.swap(comments, scrubbedComments, (v) => (this.comments = v));
      const reads = this.aiReads;
      const keptReads = reads.filter((r) => !readsGone.has(r.reportId));
      add('ai', reads.length - keptReads.length);
      this.swap(reads, keptReads, (v) => (this.aiReads = v));
    }
    if (scrubbed.size > 0) {
      // A stored example holds the lines: it goes with a line of the person.
      const outcomes = this.aiOutcomes;
      const next = new Map(outcomes);
      for (const [id, o] of outcomes) {
        if (!scrubbed.has(id) || o.example === null) continue;
        next.set(id, { ...o, example: null });
        add('ai', 1);
      }
      this.swap(outcomes, next, (v) => (this.aiOutcomes = v));
    }

    if (goneGroups.size > 0) {
      const rows = this.sanctions;
      const kept = rows.filter((r) => !goneGroups.has(r.groupId));
      add('sanctions', rows.length - kept.length);
      const owners = this.refOwners;
      const holders = new Set(kept.map((r) => r.refCode));
      this.swap(rows, kept, (v) => (this.sanctions = v));
      this.swap(owners, new Map([...owners].filter(([code]) => holders.has(code))), (v) => (this.refOwners = v));
      // What names a deleted group: the replay answer of a webhook that applied it (blanked), and the EOS link that pushed it.
      const keys = this.webhookKeys;
      const blanked = new Map(keys);
      for (const [k, v] of keys) {
        if (v.state === 'done' && v.resultJson !== null && goneGroups.has(groupIdOf(v.resultJson))) blanked.set(k, { ...v, resultJson: '{"erased":true}' });
      }
      if ([...blanked].some(([k, v]) => v !== keys.get(k))) this.swap(keys, blanked, (v) => (this.webhookKeys = v));
    }
    // The links: Coop links of the deleted reports, and EOS links of the deleted sanction groups.
    add('workflow', hooks.privacyEraseLinks?.(about, goneGroups) ?? 0);

    const notices = this.notices;
    let cleared = 0;
    const nextNotices: NoticeRow[] = [];
    for (const n of notices) {
      if (!set.has(n.subject)) nextNotices.push(n);
      else if (n.groupId !== null && keepGroups.has(n.groupId)) {
        if (clearGroups.has(n.groupId) && n.excerpt.length > 0) {
          cleared++;
          nextNotices.push({ ...n, excerpt: [] });
        } else nextNotices.push(n);
      }
    }
    add('notices', notices.length - nextNotices.length + cleared);
    if (nextNotices.length !== notices.length || cleared > 0) this.swap(notices, nextNotices, (v) => (this.notices = v));

    const strikes = this.strikes;
    const keptStrikes = strikes.filter((r) => !set.has(r.subject));
    add('strikes', strikes.length - keptStrikes.length);
    if (keptStrikes.length !== strikes.length) this.swap(strikes, keptStrikes, (v) => (this.strikes = v));

    const mutes = this.mutes;
    const keptMutes = new Map([...mutes].filter(([, m]) => !set.has(m.row.viewer) && !set.has(m.row.target)));
    add('mutes', mutes.size - keptMutes.size);
    if (keptMutes.size !== mutes.size) this.swap(mutes, keptMutes, (v) => (this.mutes = v));

    add('blocked_names', hooks.privacyEraseBlockedNames?.(set) ?? 0);
    add('appeals', hooks.privacyEraseAppeals?.(set, heldGroups) ?? 0);
    add('signals', hooks.privacyEraseSignals?.(set) ?? 0);
    add('ai', hooks.privacyEraseNoAutomation?.(set) ?? 0);

    const claims = this.claims;
    const keptClaims = new Map([...claims].filter(([person]) => !set.has(person)));
    add('workflow', claims.size - keptClaims.size);
    if (keptClaims.size !== claims.size) this.swap(claims, keptClaims, (v) => (this.claims = v));
    const threads = this.discordThreads;
    const keptThreads = new Map([...threads].filter(([subject]) => !set.has(subject)));
    add('workflow', threads.size - keptThreads.size);
    if (keptThreads.size !== threads.size) this.swap(threads, keptThreads, (v) => (this.discordThreads = v));

    let pending: SubjectId | null = null;
    if (keepIdentifiers) {
      pending = plan.subjects.find((s) => set.has(s)) ?? [...set][0] ?? null;
    } else {
      add('audit', this.rewriteAudit(set, plan.receiptId));
      const subjectRows = this.subjects.size;
      const identifierRows = this.dropSubjects(set);
      add('identifiers', identifierRows);
      add('subjects', subjectRows - this.subjects.size);
    }
    this.bumpEpoch();
    // The queue shows fewer reports and appeals: the change token moves with the erase (a dry run is undone with everything else).
    this.bump();
    return { found: true, removed, kept: { identifiers: keepIdentifiers, sanctions: keptSanctionRows, heldReports: heldNaming }, pending, closure: [...set].sort(compare) };
  }

  /** Point the audit rows that name the set at the receipt. Returns how many rows changed. */
  private rewriteAudit(set: ReadonlySet<SubjectId>, receiptId: string): number {
    let n = 0;
    const next = this.auditRows.map((r) => {
      if (r.target === null || r.target.type !== 'person' || !set.has(r.target.ref)) return r;
      n++;
      return { ...r, target: { type: r.target.type, ref: receiptId } };
    });
    if (n > 0) this.swap(this.auditRows, next, (v) => (this.auditRows = v));
    return n;
  }

  /** Delete the subject and identifier rows of the set. Returns how many identifier rows went. */
  private dropSubjects(set: ReadonlySet<SubjectId>): number {
    const ids = this.subjectIds;
    const keptIds = new Map([...ids].filter(([, r]) => !set.has(r.subjectId)));
    this.swap(ids, keptIds, (v) => (this.subjectIds = v));
    const subjects = this.subjects;
    this.swap(subjects, new Map([...subjects].filter(([id]) => !set.has(id))), (v) => (this.subjects = v));
    return ids.size - keptIds.size;
  }

  private bumpEpoch(): void {
    this.epoch += 1;
    this.undoWith(() => {
      this.epoch -= 1;
    });
  }

  purgeStrayRows(before: number, only?: readonly SubjectId[]): number {
    const exists = (id: string): boolean => this.subjects.has(id);
    const onlySet = only === undefined ? null : new Set(only);
    // With `only`: exactly those subjects, at any age. Otherwise: rows older than `before`. Either way a subject that exists is never touched.
    const matches = (subject: string, at: number): boolean => !exists(subject) && (onlySet === null ? at < before : onlySet.has(subject));
    if (onlySet !== null && onlySet.size === 0) return 0;
    const hooks = this as unknown as Partial<PrivacyHooks>;
    let n = 0;
    const strikes = this.strikes;
    const keptStrikes = strikes.filter((r) => !matches(r.subject, r.at));
    n += strikes.length - keptStrikes.length;
    if (keptStrikes.length !== strikes.length) this.swap(strikes, keptStrikes, (v) => (this.strikes = v));
    const heldGroups = this.heldGroupIds();
    const notices = this.notices;
    const keptNotices = notices.filter((r) => !(matches(r.subject, r.createdAt) && (r.groupId === null || !heldGroups.has(r.groupId))));
    n += notices.length - keptNotices.length;
    if (keptNotices.length !== notices.length) this.swap(notices, keptNotices, (v) => (this.notices = v));
    n += hooks.privacyPurgeStraySignals?.(exists, matches) ?? 0;
    n += hooks.privacyPurgeStrayNames?.(exists, matches) ?? 0;
    return n;
  }

  insertErasure(row: ErasureRow): void {
    if (this.erasures.some((r) => r.id === row.id)) throw new Error('UNIQUE constraint failed: kit_erasures.id');
    this.erasures.push(structuredClone(row));
    this.undoWith(() => {
      this.erasures.length -= 1;
    });
  }

  loadPendingErasures(): ErasureRow[] {
    return this.erasures
      .filter((r) => r.pendingSubject !== null)
      .sort((a, b) => a.at - b.at || compare(a.id, b.id))
      .map((r) => structuredClone(r));
  }

  finishErasure(id: string, at: number): boolean {
    const row = this.erasures.find((r) => r.id === id);
    if (row === undefined || row.pendingSubject === null) return false;
    const set = this.closure([row.pendingSubject]);
    // A sanction row keeps the erase pending, except a row a hold keeps that is not in force now (ended, revoked, or a kind that restricts nothing).
    const heldGroups = this.heldGroupIds();
    const inForce = (r: StoredSanction): boolean => r.revokedAt === null && (r.endsAt === null || r.endsAt > at) && (r.kind === 'chat' || r.kind === 'area' || r.kind === 'ban');
    if (set.size > 0 && this.sanctions.some((r) => r.targetType === 'subject' && set.has(r.value) && (!heldGroups.has(r.groupId) || inForce(r)))) return false;
    this.transaction(() => {
      // The remainder ends the way a `none` erase does: whatever still names the person (a kept notice, a row written since) goes with the subject, and the audit
      // refs read the receipt. That erase moves the epoch; with nothing left to erase the finish moves it itself.
      if (set.size > 0) this.eraseNow({ subjects: [row.pendingSubject!], mode: 'none', heldReportIds: new Set(), receiptId: id, at: 0 }, set);
      else this.bumpEpoch();
      const before = row.pendingSubject;
      row.pendingSubject = null;
      this.undoWith(() => {
        row.pendingSubject = before;
      });
    });
    return true;
  }

  erasureEpoch(): number {
    return this.epoch;
  }

  // Legal hold (0.2.0). A hold is a row; every purge and the erase read it themselves.

  placeHold(row: HoldRow): boolean {
    const prior = this.holds.get(row.reportId);
    if (prior !== undefined && prior.releasedAt === null) return false;
    this.holds.set(row.reportId, { ...row, releasedBy: null, releasedAt: null });
    this.undoWith(() => {
      if (prior === undefined) this.holds.delete(row.reportId);
      else this.holds.set(row.reportId, prior);
    });
    return true;
  }

  releaseHold(reportId: string, by: string, at: number): boolean {
    const prior = this.holds.get(reportId);
    if (prior === undefined || prior.releasedAt !== null) return false;
    this.holds.set(reportId, { ...prior, releasedBy: by, releasedAt: at });
    this.undoWith(() => this.holds.set(reportId, prior));
    return true;
  }

  loadHold(reportId: string): HoldRow | null {
    const row = this.holds.get(reportId);
    return row === undefined ? null : { ...row };
  }

  listHolds(): HoldRow[] {
    return [...this.holds.values()]
      .filter((h) => h.releasedAt === null)
      .sort((a, b) => a.heldAt - b.heldAt || compare(a.reportId, b.reportId))
      .map((h) => ({ ...h }));
  }

  sanctionGroupsOfReport(reportId: string): string[] {
    const out: string[] = [];
    for (const r of this.sanctions) if (r.reportId === reportId && !out.includes(r.groupId)) out.push(r.groupId);
    return out;
  }

  heldSet(): HeldSet {
    const reportIds = [...this.heldReportIds()].sort(compare);
    return { reportIds, groupIds: [...this.heldGroupIds()].sort(compare) };
  }

  /** The reports an open hold protects. */
  protected heldReportIds(): Set<string> {
    return new Set([...this.holds.values()].filter((h) => h.releasedAt === null).map((h) => h.reportId));
  }

  /** The sanction groups decided from a held report: their rows, notices and appeals are protected with it. */
  protected heldGroupIds(): Set<string> {
    const held = this.heldReportIds();
    if (held.size === 0) return new Set();
    return new Set(this.sanctions.filter((r) => r.reportId != null && held.has(r.reportId)).map((r) => r.groupId));
  }

  exportSubjects(subjects: readonly SubjectId[]): SubjectExport {
    const set = this.closure(subjects);
    const hooks = this as unknown as Partial<PrivacyHooks>;
    const truncated: string[] = [];
    const cap = <T>(name: string, rows: T[]): T[] => {
      if (rows.length > EXPORT_CAP) truncated.push(name);
      return rows.slice(0, EXPORT_CAP);
    };
    if (set.size === 0) {
      return {
        found: false,
        createdAt: null,
        aliases: 0,
        accounts: [],
        identifiers: { keys: 0, addresses: 0, firstSeen: null, lastSeen: null },
        sanctions: [],
        notices: [],
        reportsFiled: [],
        reportsAbout: [],
        strikes: [],
        blockedNames: [],
        appeals: [],
        signals: [],
        mutes: { placed: 0, received: 0 },
        ai: { noAutomation: null, reads: 0, outcomes: [] },
        audit: [],
        holds: { reports: 0 },
        workflow: { comments: 0 },
        truncated,
      };
    }
    const ids = [...this.subjectIds.values()].filter((r) => set.has(r.subjectId));
    const desc = <T>(rows: T[], at: (r: T) => number, tie: (r: T) => string): T[] => rows.sort((a, b) => at(b) - at(a) || compare(tie(b), tie(a)));
    const about = this.reports.filter((r) => set.has(r.targetSubject));
    const aboutIds = new Set(about.map((r) => r.id));
    const outcomes = [...this.aiOutcomes.values()].filter((o) => aboutIds.has(o.reportId)).sort((a, b) => a.decidedAt - b.decidedAt || compare(a.reportId, b.reportId));
    const mutes = [...this.mutes.values()];
    return {
      found: true,
      createdAt: Math.min(...[...set].map((id) => this.subjects.get(id)!.createdAt)),
      aliases: set.size,
      accounts: [...new Set(ids.filter((r) => r.kind === 'account').map((r) => r.value))].sort(compare),
      identifiers: {
        keys: ids.filter((r) => r.kind === 'key').length,
        addresses: ids.filter((r) => r.kind === 'ip').length,
        firstSeen: ids.length === 0 ? null : Math.min(...ids.map((r) => r.firstSeen)),
        lastSeen: ids.length === 0 ? null : Math.max(...ids.map((r) => r.lastSeen)),
      },
      sanctions: cap(
        'sanctions',
        this.sanctions
          .map((r, i) => ({ r, i }))
          .filter(({ r }) => r.targetType === 'subject' && set.has(r.value))
          .sort((a, b) => b.r.startsAt - a.r.startsAt || b.i - a.i)
          .map(({ r }) => ({
            kind: r.kind,
            rule: r.rule,
            reason: r.reason,
            startsAt: r.startsAt,
            endsAt: r.endsAt,
            refCode: r.refCode,
            source: r.source,
            revoked: r.revokedAt !== null,
            byStaff: true as const,
          })),
      ),
      notices: cap(
        'notices',
        this.notices
          .map((n, i) => ({ n, i }))
          .filter(({ n }) => set.has(n.subject))
          .sort((a, b) => a.n.createdAt - b.n.createdAt || a.i - b.i)
          .map(({ n }) => ({ kind: n.kind, rule: n.rule, until: n.until, createdAt: n.createdAt, excerpt: structuredClone(n.excerpt) })),
      ),
      reportsFiled: cap(
        'reportsFiled',
        desc(
          this.reports.filter((r) => set.has(r.reporterSubject)),
          (r) => r.createdAt,
          (r) => r.id,
        ).map((r) => ({ createdAt: r.createdAt, reason: r.reportedReason ?? null, category: r.category, note: r.note, tags: { ...r.tags } })),
      ),
      reportsAbout: cap(
        'reportsAbout',
        desc(
          about,
          (r) => r.createdAt,
          (r) => r.id,
        ).map((r) => ({
          createdAt: r.createdAt,
          category: r.category,
          reason: r.reportedReason ?? null,
          status: r.status,
          outcome: r.status === 'open' ? null : r.status,
          origin: r.origin,
          lines: r.excerpt.filter((l) => l.p !== null && set.has(r.people[l.p] ?? '')).map((l) => ({ ts: l.ts, text: l.raw })),
        })),
      ),
      strikes: cap(
        'strikes',
        desc(
          this.strikes.filter((r) => set.has(r.subject)),
          (r) => r.at,
          (r) => r.id,
        ).map((r) => ({ at: r.at, roomId: r.roomId, line: r.rawLine })),
      ),
      blockedNames: cap('blockedNames', (hooks.privacyExportBlockedNames?.(set) ?? []).map((r) => ({ at: r.at, name: r.name, reason: r.reason }))),
      appeals: cap(
        'appeals',
        (hooks.privacyExportAppeals?.(set) ?? []).map((r) => ({ createdAt: r.createdAt, kind: r.kind, rule: r.rule, status: r.status, statement: r.statement, decidedAt: r.decidedAt })),
      ),
      signals: cap('signals', hooks.privacyExportSignals?.(set) ?? []),
      // `received` leaves blocks out: a person is never told they were blocked.
      mutes: { placed: mutes.filter((m) => set.has(m.row.viewer)).length, received: mutes.filter((m) => set.has(m.row.target) && !m.row.block).length },
      ai: {
        noAutomation: hooks.privacyExportNoAutomation?.(set) ?? null,
        reads: this.aiReads.filter((r) => aboutIds.has(r.reportId)).length,
        outcomes: cap(
          'ai',
          outcomes.map((o) => ({ verdict: o.verdict, agreement: o.agreement })),
        ),
      },
      audit: cap(
        'audit',
        this.auditRows
          .filter((r) => r.target !== null && r.target.type === 'person' && set.has(r.target.ref))
          .sort((a, b) => a.at - b.at || compare(a.id, b.id))
          .map((r) => ({ at: r.at, action: r.action })),
      ),
      // Free-text staff comments on the reports that name the person: a count, never the text or who wrote it.
      workflow: {
        comments: (() => {
          const naming = new Set(this.reports.filter((r) => set.has(r.targetSubject) || set.has(r.reporterSubject) || r.people.some((p) => set.has(p))).map((r) => r.id));
          return this.comments.filter((c) => c.text !== null && naming.has(c.reportId)).length;
        })(),
      },
      // Only that something is held: a count, never which report, why or since when.
      holds: { reports: this.listHolds().filter((h) => this.reports.some((r) => r.id === h.reportId && (set.has(r.targetSubject) || set.has(r.reporterSubject)))).length },
      truncated,
    };
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

/** What a store wrapper (signals, appeals, names, links, AI) adds so the erase and the export reach the state it keeps. Not part of the Store interface. */
interface PrivacyHooks {
  privacyEraseSignals(set: ReadonlySet<string>): number;
  privacyExportSignals(set: ReadonlySet<string>): Array<{ at: number; kind: string }>;
  privacyEraseAppeals(set: ReadonlySet<string>, keepGroups: ReadonlySet<string>): number;
  privacyUnlinkAppealReports(reportIds: ReadonlySet<string>): void;
  privacyExportAppeals(set: ReadonlySet<string>): AppealRow[];
  privacyEraseBlockedNames(set: ReadonlySet<string>): number;
  privacyExportBlockedNames(set: ReadonlySet<string>): BlockedNameRow[];
  privacyEraseLinks(reportIds: ReadonlySet<string>, goneGroups: ReadonlySet<string>): number;
  privacyEraseNoAutomation(set: ReadonlySet<string>): number;
  privacyEraseAiActions(reportIds: ReadonlySet<string>): number;
  privacyExportNoAutomation(set: ReadonlySet<string>): string | null;
  privacyPurgeStraySignals(exists: (id: string) => boolean, matches: (subject: string, at: number) => boolean): number;
  privacyPurgeStrayNames(exists: (id: string) => boolean, matches: (subject: string, at: number) => boolean): number;
}

/** Thrown inside a dry run to undo it. */
class DryRunRollback extends Error {}

/** An export section holds at most this many rows (core's `EXPORT_SECTION_MAX`, spelled out here: this package links no runtime core code). */
const EXPORT_CAP = 5000;
/** What stands in for an erased person's line in another player's report (core's `ERASED_LINE`). */
const ERASED_LINE = '[erased]';

/** The group id a webhook key's stored answer names (`{ groupId, refCode }`), or '' when it cannot be read. */
function groupIdOf(resultJson: string): string {
  try {
    const g = (JSON.parse(resultJson) as { groupId?: unknown } | null)?.groupId;
    return typeof g === 'string' ? g : '';
  } catch {
    return '';
  }
}

/**
 * The stored answer of a decision with the entries for the erased set removed (`{ groups: [{ subject, groupId, ... }] }`), or null when nothing changes. An entry
 * whose sanction group stays (a ban in force the erase keeps) stays too. An answer that is not JSON but names someone of the set is blanked. The SQLite store has the
 * same function.
 */
function redactDecision(text: string, set: ReadonlySet<string>, keepGroups: ReadonlySet<string>): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    for (const id of set) if (text.includes(id)) return JSON.stringify({ groups: [] });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { groups?: unknown }).groups)) return null;
  const groups = (parsed as { groups: unknown[] }).groups;
  const kept = groups.filter((g) => {
    const entry = g as { subject?: unknown; groupId?: unknown } | null;
    return !(typeof entry?.subject === 'string' && set.has(entry.subject) && !(typeof entry.groupId === 'string' && keepGroups.has(entry.groupId)));
  });
  return kept.length === groups.length ? null : JSON.stringify({ ...(parsed as object), groups: kept });
}

/** The lines the set wrote in a report's excerpt, by the report's `people` list; null when nobody of the set is in it. The SQLite store has the same function. */
function scrubExcerpt(
  people: readonly string[],
  excerpt: readonly ReportExcerptLine[],
  set: ReadonlySet<string>,
): { people: string[]; excerpt: ReportExcerptLine[] } | null {
  const gone = new Set<number>();
  people.forEach((p, i) => {
    if (set.has(p)) gone.add(i);
  });
  if (gone.size === 0) return null;
  const remap = new Map<number, number>();
  const kept: string[] = [];
  people.forEach((p, i) => {
    if (!gone.has(i)) {
      remap.set(i, kept.length);
      kept.push(p);
    }
  });
  return {
    people: kept,
    excerpt: excerpt.map((l) =>
      l.p !== null && gone.has(l.p)
        ? { ...l, seatId: '', handle: '', raw: ERASED_LINE, delivered: l.delivered === null ? null : ERASED_LINE, p: null }
        : l.p === null
          ? { ...l }
          : { ...l, p: remap.get(l.p) ?? null },
    ),
  };
}

const muteKey = (viewer: SubjectId, target: SubjectId): string => `${viewer}\u0000${target}`;

/**
 * String order by code point, which is the order of SQLite's default (BINARY) collation on UTF-8 text. JavaScript's `<`
 * compares UTF-16 code units and puts a character outside the BMP before U+E000..U+FFFF; this does not.
 */
export function compare(a: string, b: string): number {
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

/** Is this report in one of these staff scopes? No scope given is every report; an empty list is none; a report with no scope is never in one. */
function inScope(report: { scope?: string | null }, scope: readonly string[] | undefined): boolean {
  if (scope === undefined) return true;
  return typeof report.scope === 'string' && scope.includes(report.scope);
}
