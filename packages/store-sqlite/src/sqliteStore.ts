import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, ROLES } from '@chatwarden/core';
import type {
  AuditListQuery,
  AuditRow,
  AuditTargetType,
  DecisionRow,
  MuteRow,
  NoticeKind,
  NoticeRow,
  ReportActivity,
  ReportCategory,
  ReportListQuery,
  ReportRecord,
  SanctionKind,
  SanctionRow,
  Source,
  Store,
  StoredReport,
  StrikeRow,
  WebhookKeyReservation,
  SubjectId,
  SubjectIdKind,
  SubjectIdRecord,
  SubjectRecord,
} from '@chatwarden/core';
import type {
  AuditEntry,
  ExceptionPatch,
  ExceptionRecord,
  TermPatch,
  TermRecord,
  TermStore,
} from '@chatwarden/matcher';

/** A term-editor action name (`LiveTerms`) mapped to the audit union; the prefix is the row's subject type. */
const LEGACY_ACTIONS: ReadonlyArray<readonly [string, string]> = [
  ['add', 'add'],
  ['edit', 'update'],
  ['enable', 'toggle'],
  ['disable', 'toggle'],
];

const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

/**
 * SQL for the audit action a `kit_audit` row reads as: an action already in the union is itself; a term-editor row
 * (`add` / `edit` / `enable` / `disable` on a `term` or `exception`) maps by name; anything else reads as `term.update`.
 * Built from fixed strings only, never caller input.
 */
const AUDIT_ACTION_SQL = `CASE WHEN action IN (${sqlList(AUDIT_ACTIONS)}) THEN action ${(['term', 'exception'] as const)
  .flatMap((type) =>
    LEGACY_ACTIONS.map(([from, to]) => `WHEN subject_type = '${type}' AND action = '${from}' THEN '${type}.${to}' `),
  )
  .join('')}ELSE 'term.update' END`;

function auditFromRow(r: Record<string, unknown>): AuditRow {
  const type = String(r.subject_type);
  const ref = String(r.subject_ref);
  const role = r.role === null || r.role === undefined ? null : String(r.role);
  return {
    id: String(r.id),
    at: Number(r.at),
    actor: String(r.actor),
    role: ROLES.find((x) => x === role) ?? null,
    action: String(r.action) as AuditRow['action'],
    target: ref !== '' && (AUDIT_TARGET_TYPES as readonly string[]).includes(type) ? { type: type as AuditTargetType, ref } : null,
  };
}

/** The columns of a `SanctionRow`; `toSanctionRow` reads them by name. */
function reportFromRow(r: Record<string, unknown>): ReportRecord {
  return {
    id: String(r.id),
    createdAt: Number(r.created_at),
    roomId: String(r.room_id),
    tags: JSON.parse(String(r.tags_json)) as Record<string, string>,
    reporterSubject: String(r.reporter_subject),
    reporterSeat: String(r.reporter_seat),
    reporterHandle: String(r.reporter_handle),
    targetSubject: String(r.target_subject),
    targetSeat: String(r.target_seat),
    targetHandle: String(r.target_handle),
    category: String(r.category) as ReportCategory,
    note: r.note === null ? null : String(r.note),
    lineId: r.line_id === null ? null : String(r.line_id),
    excerpt: JSON.parse(String(r.excerpt_json)) as ReportRecord['excerpt'],
    people: JSON.parse(String(r.people_json)) as SubjectId[],
    status: String(r.status) as ReportRecord['status'],
    badFaith: Number(r.bad_faith) === 1,
    actionedAt: r.actioned_at === null ? null : Number(r.actioned_at),
    actionedBy: r.actioned_by === null ? null : String(r.actioned_by),
    modNote: r.mod_note === null ? null : String(r.mod_note),
    badFaithEvidence: r.bad_faith_evidence === null ? null : String(r.bad_faith_evidence),
  };
}

const SANCTION_COLUMNS =
  'id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, gap_note, gap_status, room_id, actor, source, automated, pending';

function toSanctionRow(r: Record<string, unknown>): SanctionRow {
  return {
    id: String(r.id),
    groupId: String(r.group_id),
    refCode: String(r.ref_code),
    kind: String(r.kind) as SanctionKind,
    targetType: r.target_type === 'ip' ? 'ip' : 'subject',
    value: String(r.target_value),
    startsAt: Number(r.starts_at),
    endsAt: r.ends_at === null ? null : Number(r.ends_at),
    reason: String(r.reason),
    rule: r.rule === null ? null : String(r.rule),
    gapNote: r.gap_note === null ? null : String(r.gap_note),
    gapStatus: r.gap_status === null ? null : (String(r.gap_status) as 'open' | 'ruled' | 'not_a_rule'),
    roomId: r.room_id === null ? null : String(r.room_id),
    actor: String(r.actor),
    source: String(r.source) as Source,
    automated: r.automated === 1,
    pending: r.pending === 1,
    // Only a query that selects revoked_at gets the property; the other loads keep the plain row shape.
    ...(r.revoked_at === undefined ? {} : { revokedAt: r.revoked_at === null ? null : Number(r.revoked_at) }),
  };
}

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
  private closed = false;

  constructor(db: DatabaseSync, version: number, ownsDb: boolean) {
    this.db = db;
    this.version = version;
    this.ownsDb = ownsDb;
  }

  schemaVersion(): number {
    if (this.closed) throw new Error('store is closed');
    return this.version;
  }

  transaction<T>(fn: () => T): T {
    return inSavepoint(this.db, fn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDb) this.db.close();
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
           (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending,
            gap_note, gap_status, room_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        ins.run(
          r.id, r.groupId, r.refCode, r.kind, r.targetType, r.value, r.startsAt, r.endsAt, r.reason, r.rule,
          r.actor, r.source, r.automated ? 1 : 0, r.pending ? 1 : 0, r.gapNote, r.gapStatus, r.roomId,
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

  sanctionRefCode(groupId: string): string | null {
    const row = this.transaction(() =>
      this.db.prepare('SELECT ref_code FROM kit_sanctions WHERE group_id = ? LIMIT 1').get(groupId),
    ) as { ref_code: string } | undefined;
    return row === undefined ? null : row.ref_code;
  }

  loadSanctions(now: number): SanctionRow[] {
    return this.transaction(() =>
      this.db
        .prepare(
          `SELECT ${SANCTION_COLUMNS}
           FROM kit_sanctions WHERE revoked_at IS NULL AND (ends_at IS NULL OR ends_at > ?) ORDER BY rowid`,
        )
        .all(now)
        .map(toSanctionRow),
    );
  }

  loadSubjectActions(since: number): SanctionRow[] {
    return this.transaction(() =>
      this.db
        .prepare(
          `SELECT ${SANCTION_COLUMNS}, revoked_at
           FROM kit_sanctions WHERE target_type = 'subject' AND starts_at >= ? ORDER BY rowid`,
        )
        .all(since)
        .map(toSanctionRow),
    );
  }

  listGaps(): SanctionRow[] {
    return this.transaction(() =>
      this.db
        .prepare(
          `SELECT ${SANCTION_COLUMNS}
           FROM kit_sanctions WHERE target_type = 'subject' AND gap_note IS NOT NULL ORDER BY starts_at DESC, rowid DESC`,
        )
        .all()
        .map(toSanctionRow),
    );
  }

  closeGap(groupId: string, status: 'ruled' | 'not_a_rule', ref: string | null, actor: string, at: number): boolean {
    return this.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE kit_sanctions SET gap_status = ?, gap_ref = ?
           WHERE group_id = ? AND target_type = 'subject' AND gap_note IS NOT NULL AND gap_status = 'open'`,
        )
        .run(status, ref, groupId);
      if (Number(res.changes) === 0) return false;
      // Who closed it and when go to the audit trail, in the same transaction. The sanction group id names no person.
      this.db
        .prepare(
          `INSERT INTO kit_audit (id, at, actor, action, subject_type, subject_ref, before_json, after_json)
           VALUES (?, ?, ?, 'gap.close', 'sanction', ?, ?, ?)`,
        )
        .run(
          randomBytes(16).toString('base64url'), at, actor, groupId,
          JSON.stringify({ gapStatus: 'open' }), JSON.stringify({ gapStatus: status, gapRef: ref }),
        );
      return true;
    });
  }

  // Staff audit trail. SYNCHRONOUS on purpose. The json columns (before_json / after_json) are never selected: the
  // rows the term editor wrote may hold term text there.

  insertAudit(row: AuditRow): void {
    this.db
      .prepare(
        `INSERT INTO kit_audit (id, at, actor, role, action, subject_type, subject_ref, before_json, after_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(row.id, row.at, row.actor, row.role, row.action, row.target?.type ?? '', row.target?.ref ?? '');
  }

  listAudit(q: AuditListQuery): AuditRow[] {
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit)));
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.actor !== undefined) {
      where.push('actor = ?');
      args.push(q.actor);
    }
    if (q.action !== undefined) {
      where.push(`(${AUDIT_ACTION_SQL}) = ?`);
      args.push(q.action);
    }
    if (q.before !== undefined) {
      if (q.beforeId === undefined) {
        where.push('at < ?');
        args.push(q.before);
      } else {
        // `at <= ?` is redundant with the pair below it, but it is a plain range on the indexed column, so SQLite
        // seeks to the cursor instead of scanning the table.
        where.push('(at <= ? AND (at < ? OR id < ?))');
        args.push(q.before, q.before, q.beforeId);
      }
    }
    const sql =
      `SELECT id, at, actor, role, (${AUDIT_ACTION_SQL}) AS action, subject_type, subject_ref FROM kit_audit` +
      `${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`} ORDER BY at DESC, id DESC LIMIT ?`;
    return this.transaction(() => this.db.prepare(sql).all(...args, limit).map(auditFromRow));
  }

  purgeAudit(before: number): number {
    return this.transaction(() => Number(this.db.prepare('DELETE FROM kit_audit WHERE at < ?').run(before).changes));
  }

  // Webhook keys. SYNCHRONOUS on purpose (see the Store interface); they run inside `transaction`.

  reserveWebhookKey(key: string, now: number, notBefore: number): WebhookKeyReservation {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM kit_webhook_keys WHERE key = ? AND created_at < ?').run(key, notBefore);
      const inserted = this.db
        .prepare("INSERT OR IGNORE INTO kit_webhook_keys (key, created_at, state, result_json) VALUES (?, ?, 'pending', NULL)")
        .run(key, now);
      if (Number(inserted.changes) > 0) return { reserved: true } as const;
      const r = this.db.prepare('SELECT state, result_json FROM kit_webhook_keys WHERE key = ?').get(key);
      if (r !== undefined && r.state === 'done' && typeof r.result_json === 'string') {
        return { reserved: false, state: 'done', resultJson: r.result_json } as const;
      }
      return { reserved: false, state: 'pending', resultJson: null } as const;
    });
  }

  completeWebhookKey(key: string, resultJson: string): boolean {
    return this.transaction(
      () =>
        Number(
          this.db
            .prepare("UPDATE kit_webhook_keys SET state = 'done', result_json = ? WHERE key = ? AND state = 'pending'")
            .run(resultJson, key).changes,
        ) > 0,
    );
  }

  releaseWebhookKey(key: string): boolean {
    return this.transaction(
      () => Number(this.db.prepare("DELETE FROM kit_webhook_keys WHERE key = ? AND state = 'pending'").run(key).changes) > 0,
    );
  }

  purgeWebhookKeys(before: number): number {
    return this.transaction(() => Number(this.db.prepare('DELETE FROM kit_webhook_keys WHERE created_at < ?').run(before).changes));
  }

  // Mutes. SYNCHRONOUS on purpose (see the Store interface); they run inside `transaction`, which must never
  // be given an async function.

  upsertMute(row: MuteRow): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO kit_mutes (viewer_id, target_id, created_at) VALUES (?, ?, ?)
           ON CONFLICT (viewer_id, target_id) DO UPDATE SET created_at = excluded.created_at`,
        )
        .run(row.viewer, row.target, row.createdAt);
    });
  }

  deleteMute(viewer: SubjectId, target: SubjectId): boolean {
    return this.transaction(
      () => Number(this.db.prepare('DELETE FROM kit_mutes WHERE viewer_id = ? AND target_id = ?').run(viewer, target).changes) > 0,
    );
  }

  loadMutes(since: number): MuteRow[] {
    return this.transaction(() =>
      this.db
        .prepare('SELECT viewer_id, target_id, created_at FROM kit_mutes WHERE created_at >= ? ORDER BY rowid')
        .all(since)
        .map((r) => ({ viewer: String(r.viewer_id), target: String(r.target_id), createdAt: Number(r.created_at) })),
    );
  }

  pruneMutes(viewer: SubjectId, keep: number): SubjectId[] {
    return this.transaction(() => {
      const total = Number(
        (this.db.prepare('SELECT COUNT(*) AS n FROM kit_mutes WHERE viewer_id = ?').get(viewer) as { n: number }).n,
      );
      const extra = total - Math.max(0, keep);
      if (extra <= 0) return [];
      const doomed = this.db
        .prepare('SELECT target_id FROM kit_mutes WHERE viewer_id = ? ORDER BY created_at, rowid LIMIT ?')
        .all(viewer, extra)
        .map((r) => String(r.target_id));
      const del = this.db.prepare('DELETE FROM kit_mutes WHERE viewer_id = ? AND target_id = ?');
      for (const target of doomed) del.run(viewer, target);
      return doomed;
    });
  }

  // Strikes. SYNCHRONOUS on purpose (see the Store interface); they run inside `transaction`, which must never
  // be given an async function.

  insertStrike(row: StrikeRow): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO kit_strikes (id, at, subject_id, room_id, term_id, raw_line) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.id, row.at, row.subject, row.roomId, row.termId, row.rawLine);
    });
  }

  loadStrikes(since: number): StrikeRow[] {
    return this.transaction(() =>
      this.db
        .prepare(
          'SELECT id, at, subject_id, room_id, term_id, raw_line FROM kit_strikes WHERE at >= ? ORDER BY at, rowid',
        )
        .all(since)
        .map((r) => ({
          id: String(r.id),
          at: Number(r.at),
          subject: String(r.subject_id),
          roomId: String(r.room_id),
          termId: String(r.term_id),
          rawLine: String(r.raw_line),
        })),
    );
  }

  loadAutoChatStarts(): Array<{ subject: SubjectId; startsAt: number }> {
    return this.transaction(() =>
      this.db
        .prepare(
          `SELECT target_value, MAX(starts_at) AS latest FROM kit_sanctions
           WHERE kind = 'chat' AND source = 'auto_filter' AND target_type = 'subject'
           GROUP BY target_value ORDER BY MIN(rowid)`,
        )
        .all()
        .map((r) => ({ subject: String(r.target_value), startsAt: Number(r.latest) })),
    );
  }

  // Reports. SYNCHRONOUS on purpose (see the Store interface); they run inside `transaction`, which must never
  // be given an async function.

  insertReport(r: StoredReport): boolean {
    return this.transaction(() => {
      // Only the (reporter, target, room) conflict is swallowed; a clashing primary key still throws.
      const res = this.db
        .prepare(
          `INSERT INTO kit_reports
             (id, created_at, room_id, tags_json, reporter_subject, reporter_seat, reporter_handle, target_subject,
              target_seat, target_handle, category, note, line_id, excerpt_json, people_json, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (reporter_subject, target_subject, room_id) DO NOTHING`,
        )
        .run(
          r.id, r.createdAt, r.roomId, JSON.stringify(r.tags), r.reporterSubject, r.reporterSeat, r.reporterHandle,
          r.targetSubject, r.targetSeat, r.targetHandle, r.category, r.note, r.lineId, JSON.stringify(r.excerpt),
          JSON.stringify(r.people), r.status,
        );
      return Number(res.changes) > 0;
    });
  }

  loadReport(id: string): ReportRecord | null {
    return this.transaction(() => {
      const r = this.db.prepare('SELECT * FROM kit_reports WHERE id = ?').get(id);
      return r === undefined ? null : reportFromRow(r);
    });
  }

  listReportsByPerson(subjects: readonly SubjectId[], limit: number): ReportRecord[] {
    if (subjects.length === 0) return [];
    const n = Math.min(200, Math.max(1, Math.floor(limit)));
    const marks = subjects.map(() => '?').join(', ');
    const sql = `SELECT * FROM kit_reports WHERE target_subject IN (${marks}) ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.transaction(() => this.db.prepare(sql).all(...subjects, n).map(reportFromRow));
  }

  listReports(q: ReportListQuery): ReportRecord[] {
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit)));
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.status !== undefined) {
      where.push('status = ?');
      args.push(q.status);
    }
    if (q.before !== undefined) {
      if (q.beforeId === undefined) {
        where.push('created_at < ?');
        args.push(q.before);
      } else {
        // `created_at <= ?` is redundant with the pair below it, but it is a plain range on the indexed column, so
        // SQLite seeks to the cursor instead of scanning the table.
        where.push('(created_at <= ? AND (created_at < ? OR id < ?))');
        args.push(q.before, q.before, q.beforeId);
      }
    }
    const sql = `SELECT * FROM kit_reports${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`} ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.transaction(() => this.db.prepare(sql).all(...args, limit).map(reportFromRow));
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
    return this.transaction(() => {
      if (status !== 'actioned' && status !== 'dismissed') throw new Error('closeReport: invalid status');
      const res = this.db
        .prepare(
          `UPDATE kit_reports SET status = ?, bad_faith = ?, actioned_at = ?, actioned_by = ?, mod_note = ?,
             bad_faith_evidence = ?
           WHERE id = ? AND status = 'open'`,
        )
        .run(status, badFaith ? 1 : 0, at, actor, note, evidence, id);
      return Number(res.changes) > 0;
    });
  }

  insertDecision(key: string, reportId: string, at: number, resultJson: string): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO kit_decisions (key, report_id, at, result_json) VALUES (?, ?, ?, ?)')
        .run(key, reportId, at, resultJson);
    });
  }

  findDecision(key: string): DecisionRow | null {
    return this.transaction(() => {
      const r = this.db.prepare('SELECT key, report_id, at, result_json FROM kit_decisions WHERE key = ?').get(key);
      return r === undefined
        ? null
        : { key: String(r.key), reportId: String(r.report_id), at: Number(r.at), resultJson: String(r.result_json) };
    });
  }

  loadReportActivity(since: number): ReportActivity[] {
    return this.transaction(() =>
      this.db
        .prepare(
          `SELECT reporter_subject, target_subject, room_id, created_at FROM kit_reports
           WHERE created_at >= ? ORDER BY created_at, rowid`,
        )
        .all(since)
        .map((r) => ({
          reporter: String(r.reporter_subject),
          target: String(r.target_subject),
          roomId: String(r.room_id),
          createdAt: Number(r.created_at),
        })),
    );
  }

  loadRoomReportPairs(roomId: string): Array<{ reporter: SubjectId; target: SubjectId }> {
    return this.transaction(() =>
      this.db
        .prepare('SELECT reporter_subject, target_subject FROM kit_reports WHERE room_id = ? ORDER BY rowid')
        .all(roomId)
        .map((r) => ({ reporter: String(r.reporter_subject), target: String(r.target_subject) })),
    );
  }

  loadBadFaithMarks(since: number): Array<{ reporter: SubjectId; actionedAt: number }> {
    return this.transaction(() =>
      this.db
        .prepare(
          `SELECT reporter_subject, actioned_at FROM kit_reports
           WHERE bad_faith = 1 AND actioned_at >= ? ORDER BY actioned_at DESC, rowid`,
        )
        .all(since)
        .map((r) => ({ reporter: String(r.reporter_subject), actionedAt: Number(r.actioned_at) })),
    );
  }

  loadAutoChatGroups(since: number): Array<{ subject: SubjectId; groupId: string }> {
    return this.transaction(() =>
      this.db
        .prepare(
          `SELECT DISTINCT target_value, group_id FROM kit_sanctions
           WHERE kind = 'chat' AND source = 'auto_filter' AND target_type = 'subject' AND starts_at >= ?`,
        )
        .all(since)
        .map((r) => ({ subject: String(r.target_value), groupId: String(r.group_id) })),
    );
  }

  // Retention. SYNCHRONOUS on purpose (see the Store interface); they run inside `transaction`, which must
  // never be given an async function.

  purgeReports(before: number, keepBadFaithSince: number): number {
    return this.transaction(() => {
      const n = Number(
        this.db
          .prepare(
            `DELETE FROM kit_reports
             WHERE created_at < ? AND NOT (bad_faith = 1 AND actioned_at IS NOT NULL AND actioned_at >= ?)`,
          )
          .run(before, keepBadFaithSince).changes,
      );
      // A recorded decision outlives only its report.
      if (n > 0) this.db.prepare('DELETE FROM kit_decisions WHERE report_id NOT IN (SELECT id FROM kit_reports)').run();
      return n;
    });
  }

  purgeSanctions(before: number): number {
    return this.transaction(() =>
      Number(
        this.db
          .prepare(
            `DELETE FROM kit_sanctions
             WHERE ((ends_at IS NOT NULL AND ends_at < ?) OR (revoked_at IS NOT NULL AND revoked_at < ?))
               AND (gap_status IS NULL OR gap_status <> 'open')`
          )
          .run(before, before).changes,
      ),
    );
  }

  purgeStrikes(before: number): number {
    return this.transaction(() => Number(this.db.prepare('DELETE FROM kit_strikes WHERE at < ?').run(before).changes));
  }

  purgeMutes(before: number): number {
    return this.transaction(() => Number(this.db.prepare('DELETE FROM kit_mutes WHERE created_at < ?').run(before).changes));
  }

  purgeNotices(before: number): number {
    return this.transaction(() =>
      Number(
        this.db
          .prepare(
            `DELETE FROM kit_notices
             WHERE (withdrawn_at IS NOT NULL AND created_at < ?)
                OR (acked_at IS NOT NULL AND kind IN ('warning', 'report_outcome') AND created_at < ?)
                OR (until IS NOT NULL AND until < ?)`,
          )
          .run(before, before, before).changes,
      ),
    );
  }

  // Notices. SYNCHRONOUS on purpose (see the Store interface); they run inside `transaction`, which must never be
  // given an async function.

  insertNotice(row: NoticeRow): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO kit_notices (id, subject_id, group_id, kind, rule, until, ref_code, excerpt_json, created_at, acked_at, withdrawn_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.subject,
          row.groupId,
          row.kind,
          row.rule,
          row.until,
          row.refCode,
          JSON.stringify(row.excerpt),
          row.createdAt,
          row.ackedAt,
          row.withdrawnAt,
        );
    });
  }

  loadNotices(subjects: readonly SubjectId[]): NoticeRow[] {
    if (subjects.length === 0) return [];
    return this.transaction(() =>
      this.db
        .prepare(
          `SELECT id, subject_id, group_id, kind, rule, until, ref_code, excerpt_json, created_at, acked_at, withdrawn_at
           FROM kit_notices WHERE subject_id IN (${subjects.map(() => '?').join(', ')}) ORDER BY created_at, rowid`,
        )
        .all(...subjects)
        .map((r) => ({
          id: String(r.id),
          subject: String(r.subject_id),
          groupId: r.group_id === null ? null : String(r.group_id),
          kind: String(r.kind) as NoticeKind,
          rule: r.rule === null ? null : String(r.rule),
          until: r.until === null ? null : Number(r.until),
          refCode: r.ref_code === null ? null : String(r.ref_code),
          excerpt: JSON.parse(String(r.excerpt_json)) as Array<{ text: string; day: string }>,
          createdAt: Number(r.created_at),
          ackedAt: r.acked_at === null ? null : Number(r.acked_at),
          withdrawnAt: r.withdrawn_at === null ? null : Number(r.withdrawn_at),
        })),
    );
  }

  ackNotice(id: string, at: number): boolean {
    return this.transaction(
      () =>
        Number(
          this.db.prepare('UPDATE kit_notices SET acked_at = ? WHERE id = ? AND acked_at IS NULL AND withdrawn_at IS NULL').run(at, id)
            .changes,
        ) > 0,
    );
  }

  findNoticeForGroup(
    groupId: string,
  ): { id: string; subject: SubjectId; ackedAt: number | null; withdrawnAt: number | null } | null {
    return this.transaction(() => {
      const r = this.db
        .prepare(
          'SELECT id, subject_id, acked_at, withdrawn_at FROM kit_notices WHERE group_id = ? AND withdrawn_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1',
        )
        .get(groupId);
      if (r === undefined) return null;
      return {
        id: String(r.id),
        subject: String(r.subject_id),
        ackedAt: r.acked_at === null ? null : Number(r.acked_at),
        withdrawnAt: r.withdrawn_at === null ? null : Number(r.withdrawn_at),
      };
    });
  }

  withdrawNoticeGroup(groupId: string, at: number): number {
    return this.transaction(() =>
      Number(this.db.prepare('UPDATE kit_notices SET withdrawn_at = ? WHERE group_id = ? AND withdrawn_at IS NULL').run(at, groupId).changes),
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
