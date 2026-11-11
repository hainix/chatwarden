import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, ROLES } from '@chatwarden/core';
import type {
  AuditDetail,
  AuditListQuery,
  AuditRow,
  AuditTargetType,
  ClaimAttempt,
  ClaimMode,
  ClaimRow,
  DecisionRow,
  MuteRow,
  NoticeKind,
  NoticeRow,
  OpenReportQuery,
  PolicyLayer,
  ReasonRow,
  ReportActivity,
  ReportCategory,
  ReportListQuery,
  ReportRecord,
  ReporterDecision,
  ReporterTally,
  SanctionKind,
  SanctionListQuery,
  SanctionRow,
  Source,
  Store,
  StoredReport,
  StrikeRow,
  WebhookKeyReservation,
  DiscordThreadRow,
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
    // Only a policy row has one; every other row (the legacy term-editor rows included) has NULL here.
    ...detailFromJson(r.detail_json),
  };
}

/** The detail of a policy audit row, or nothing when the column is empty or does not hold one: one damaged row never breaks a page. */
function detailFromJson(json: unknown): { detail?: AuditDetail } {
  if (json === null || json === undefined) return {};
  try {
    const d = JSON.parse(String(json)) as { sections?: unknown; reason?: unknown } | null;
    if (typeof d !== 'object' || d === null || !Array.isArray(d.sections)) return {};
    if (d.reason !== undefined && typeof d.reason !== 'string') return {};
    return { detail: d as AuditDetail };
  } catch {
    return {};
  }
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
    reportedReason: r.reported_reason === null || r.reported_reason === undefined ? null : String(r.reported_reason),
    detailAt: r.detail_at === null || r.detail_at === undefined ? null : Number(r.detail_at),
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

/** A subject-row listing row: `toSanctionRow` plus the three revoke columns, always present. */
function toListedSanctionRow(r: Record<string, unknown>): SanctionRow {
  return {
    ...toSanctionRow(r),
    revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
    revokedBy: r.revoked_by === null ? null : String(r.revoked_by),
    revokeReason: r.revoke_reason === null ? null : String(r.revoke_reason),
  };
}

function toClaimRow(r: Record<string, unknown>): ClaimRow {
  return { person: String(r.person), by: String(r.claimed_by), since: Number(r.since), until: Number(r.until) };
}

/** The kit_meta key of the change token's counter. */
const CHANGE_TOKEN_KEY = 'change_token';

/** How many people one `loadClaims` statement names at most (well under any SQLite parameter limit). */
const CLAIM_BATCH = 500;

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

  /**
   * Move the change token (one statement, atomic across processes on the same file). Always called inside the
   * transaction of the write it announces, so an undone write undoes the move.
   */
  private bump(): void {
    this.db
      .prepare(
        `INSERT INTO kit_meta (key, value) VALUES (?, '1')
         ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
      )
      .run(CHANGE_TOKEN_KEY);
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
      this.bump();
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
      if (Number(res.changes) > 0) this.bump();
      return Number(res.changes);
    });
  }

  sanctionRefCode(groupId: string): string | null {
    const row = this.transaction(() =>
      this.db.prepare('SELECT ref_code FROM kit_sanctions WHERE group_id = ? LIMIT 1').get(groupId),
    ) as { ref_code: string } | undefined;
    return row === undefined ? null : row.ref_code;
  }

  sanctionGroupTarget(groupId: string): { subject: SubjectId; rule: string | null } | null {
    const row = this.transaction(() =>
      this.db
        .prepare("SELECT target_value, rule FROM kit_sanctions WHERE group_id = ? AND target_type = 'subject' LIMIT 1")
        .get(groupId),
    ) as { target_value: string; rule: string | null } | undefined;
    return row === undefined ? null : { subject: row.target_value, rule: row.rule };
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

  listSubjectSanctions(q: SanctionListQuery): SanctionRow[] {
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit)));
    if (q.subjects !== undefined && q.subjects.length === 0) return [];
    const where: string[] = ["target_type = 'subject'"];
    const args: Array<string | number> = [];
    if (q.subjects !== undefined) {
      where.push(`target_value IN (${q.subjects.map(() => '?').join(', ')})`);
      args.push(...q.subjects);
    }
    if (q.source !== undefined) {
      where.push('source = ?');
      args.push(q.source);
    }
    if (q.activeAt !== undefined) {
      where.push('(revoked_at IS NULL AND (ends_at IS NULL OR ends_at > ?))');
      args.push(q.activeAt);
    }
    if (q.since !== undefined) {
      if (q.alsoPermanent === true) {
        where.push('(starts_at >= ? OR (ends_at IS NULL AND revoked_at IS NULL))');
      } else {
        where.push('starts_at >= ?');
      }
      args.push(q.since);
    }
    if (q.before !== undefined) {
      if (q.beforeId === undefined) {
        where.push('starts_at < ?');
        args.push(q.before);
      } else {
        where.push('(starts_at <= ? AND (starts_at < ? OR id < ?))');
        args.push(q.before, q.before, q.beforeId);
      }
    }
    const sql =
      `SELECT ${SANCTION_COLUMNS}, revoked_at, revoked_by, revoke_reason FROM kit_sanctions WHERE ${where.join(' AND ')} ` +
      'ORDER BY starts_at DESC, id DESC LIMIT ?';
    return this.transaction(() => this.db.prepare(sql).all(...args, limit).map(toListedSanctionRow));
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
      this.bump();
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

  // Team workbench. SYNCHRONOUS on purpose (see the Store interface); they run inside `transaction`.

  changeToken(): string {
    const r = this.transaction(() => this.db.prepare('SELECT value FROM kit_meta WHERE key = ?').get(CHANGE_TOKEN_KEY));
    return r === undefined ? '0' : String(r.value);
  }

  claimCase(person: SubjectId, by: string, now: number, until: number, mode: ClaimMode): ClaimAttempt {
    return this.transaction((): ClaimAttempt => {
      const prior = this.db.prepare('SELECT claimed_by, since, until FROM kit_claims WHERE person = ?').get(person);
      const live = prior !== undefined && Number(prior.until) > now ? prior : undefined;
      const mine = live !== undefined && String(live.claimed_by) === by;
      // The one conditional write: it takes the case only when it is free or expired, or the caller holds it (not for
      // 'free'), or the caller is taking over. Whoever runs this statement first wins; the other's WHERE is then false.
      const won = this.db
        .prepare(
          `INSERT INTO kit_claims (person, claimed_by, since, until) VALUES (?, ?, ?, ?)
           ON CONFLICT (person) DO UPDATE SET
             claimed_by = excluded.claimed_by,
             since = CASE WHEN kit_claims.claimed_by = excluded.claimed_by AND kit_claims.until > ? THEN kit_claims.since ELSE excluded.since END,
             until = excluded.until
           WHERE kit_claims.until <= ? OR (kit_claims.claimed_by = excluded.claimed_by AND ? = 1) OR ? = 1
           RETURNING person, claimed_by, since, until`,
        )
        .get(person, by, now, until, now, now, mode === 'free' ? 0 : 1, mode === 'takeover' ? 1 : 0);
      if (won === undefined) {
        const holder = this.db.prepare('SELECT person, claimed_by, since, until FROM kit_claims WHERE person = ?').get(person);
        if (holder === undefined) throw new Error('claimCase: the claim vanished');
        return { won: false, claim: toClaimRow(holder) };
      }
      // A heartbeat keeps the owner; everything else (fresh, expired, taken over) changes it.
      if (!mine) this.bump();
      return { won: true, claim: toClaimRow(won), from: live !== undefined && !mine ? String(live.claimed_by) : null };
    });
  }

  releaseClaim(person: SubjectId, by: string, now: number): boolean {
    return this.transaction(() => {
      const gone = this.db.prepare('DELETE FROM kit_claims WHERE person = ? AND claimed_by = ? RETURNING until').get(person, by);
      if (gone === undefined || Number(gone.until) <= now) return false;
      this.bump();
      return true;
    });
  }

  loadClaims(persons: readonly SubjectId[], now: number): ClaimRow[] {
    const unique = [...new Set(persons)];
    if (unique.length === 0) return [];
    return this.transaction(() => {
      const out: ClaimRow[] = [];
      for (let i = 0; i < unique.length; i += CLAIM_BATCH) {
        const batch = unique.slice(i, i + CLAIM_BATCH);
        const rows = this.db
          .prepare(
            `SELECT person, claimed_by, since, until FROM kit_claims
             WHERE until > ? AND person IN (${batch.map(() => '?').join(', ')})`,
          )
          .all(now, ...batch);
        out.push(...rows.map(toClaimRow));
      }
      return out.sort((a, b) => (a.person < b.person ? -1 : a.person > b.person ? 1 : 0));
    });
  }

  listReasons(): ReasonRow[] {
    return this.transaction(() =>
      this.db
        .prepare('SELECT id, label, text, active FROM kit_reasons ORDER BY rowid')
        .all()
        .map((r) => ({ id: String(r.id), label: String(r.label), text: String(r.text), active: Number(r.active) === 1 })),
    );
  }

  insertReason(row: ReasonRow): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO kit_reasons (id, label, text, active) VALUES (?, ?, ?, ?)')
        .run(row.id, row.label, row.text, row.active ? 1 : 0);
      this.bump();
    });
  }

  updateReason(id: string, patch: { label?: string; text?: string }): boolean {
    return this.transaction(() => {
      const r = this.db.prepare('SELECT label, text FROM kit_reasons WHERE id = ?').get(id);
      if (r === undefined) return false;
      const label = patch.label ?? String(r.label);
      const text = patch.text ?? String(r.text);
      if (label === String(r.label) && text === String(r.text)) return true;
      this.db.prepare('UPDATE kit_reasons SET label = ?, text = ? WHERE id = ?').run(label, text, id);
      this.bump();
      return true;
    });
  }

  setReasonActive(id: string, active: boolean): boolean {
    return this.transaction(() => {
      const r = this.db.prepare('SELECT active FROM kit_reasons WHERE id = ?').get(id);
      if (r === undefined) return false;
      if ((Number(r.active) === 1) === active) return true;
      this.db.prepare('UPDATE kit_reasons SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
      this.bump();
      return true;
    });
  }

  // The editable profile's stored layer (K4 Task 7f). SYNCHRONOUS on purpose. One row, `id = 1`; no row is version 0.

  loadPolicyLayer(): { layer: PolicyLayer; version: number } | null {
    return this.transaction(() => {
      const r = this.db.prepare('SELECT layer_json, version FROM kit_policy_layer WHERE id = 1').get();
      if (r === undefined) return null;
      // A row whose text is not JSON still has its version, so a save can replace it. Its layer is null: the kit reports that as
      // `layerError` and keeps the base profile, instead of failing to start.
      let layer: PolicyLayer | null;
      try {
        layer = JSON.parse(String(r.layer_json)) as PolicyLayer;
      } catch {
        layer = null;
      }
      return { layer: layer as PolicyLayer, version: Number(r.version) };
    });
  }

  savePolicyLayer(layer: PolicyLayer, expectedVersion: number): number | null {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return null;
    const json = JSON.stringify(layer);
    // ONE conditional write, and nothing is read first: the statement itself takes the write lock (so another process's lock is
    // waited out by the connection's busy timeout, never a read-then-write upgrade that fails at once), and its condition is the
    // version check. Of two callers with the same expected version, whoever runs it first wins and the other's condition is false.
    return this.transaction(() => {
      const won =
        expectedVersion === 0
          ? this.db
              .prepare('INSERT INTO kit_policy_layer (id, layer_json, version) VALUES (1, ?, 1) ON CONFLICT (id) DO NOTHING RETURNING version')
              .get(json)
          : this.db
              .prepare('UPDATE kit_policy_layer SET layer_json = ?, version = version + 1 WHERE id = 1 AND version = ? RETURNING version')
              .get(json, expectedVersion);
      return won === undefined ? null : Number(won.version);
    });
  }

  // Staff audit trail. SYNCHRONOUS on purpose. The json columns (before_json / after_json) are never selected: the
  // rows the term editor wrote may hold term text there.

  insertAudit(row: AuditRow): void {
    this.db
      .prepare(
        `INSERT INTO kit_audit (id, at, actor, role, action, subject_type, subject_ref, before_json, after_json, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        row.id,
        row.at,
        row.actor,
        row.role,
        row.action,
        row.target?.type ?? '',
        row.target?.ref ?? '',
        row.detail === undefined ? null : JSON.stringify(row.detail),
      );
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
      `SELECT id, at, actor, role, (${AUDIT_ACTION_SQL}) AS action, subject_type, subject_ref, detail_json FROM kit_audit` +
      `${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`} ORDER BY at DESC, id DESC LIMIT ?`;
    return this.transaction(() => this.db.prepare(sql).all(...args, limit).map(auditFromRow));
  }

  purgeAudit(before: number): number {
    return this.transaction(() => Number(this.db.prepare('DELETE FROM kit_audit WHERE at < ?').run(before).changes));
  }

  // Webhook keys. SYNCHRONOUS on purpose (see the Store interface); they run inside `transaction`.

  reserveWebhookKey(key: string, now: number, notBefore: number, fingerprint: string): WebhookKeyReservation {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM kit_webhook_keys WHERE key = ? AND created_at < ?').run(key, notBefore);
      const inserted = this.db
        .prepare("INSERT OR IGNORE INTO kit_webhook_keys (key, created_at, state, result_json, fingerprint) VALUES (?, ?, 'pending', NULL, ?)")
        .run(key, now, fingerprint);
      if (Number(inserted.changes) > 0) return { reserved: true } as const;
      const r = this.db.prepare('SELECT state, result_json, fingerprint FROM kit_webhook_keys WHERE key = ?').get(key);
      const stored = String(r?.fingerprint ?? '');
      if (r !== undefined && r.state === 'done' && typeof r.result_json === 'string') {
        return { reserved: false, state: 'done', resultJson: r.result_json, fingerprint: stored } as const;
      }
      return { reserved: false, state: 'pending', resultJson: null, fingerprint: stored } as const;
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

  // Discord threads. SYNCHRONOUS on purpose (see the Store interface); they run inside `transaction`.

  getDiscordThread(subject: string): DiscordThreadRow | null {
    return this.transaction(() => {
      const r = this.db.prepare('SELECT subject, thread_id, label, created_at FROM kit_discord_threads WHERE subject = ?').get(subject);
      return r === undefined
        ? null
        : { subject: String(r.subject), threadId: String(r.thread_id), label: String(r.label), createdAt: Number(r.created_at) };
    });
  }

  putDiscordThread(row: DiscordThreadRow): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO kit_discord_threads (subject, thread_id, label, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (subject) DO UPDATE SET thread_id = excluded.thread_id, label = excluded.label, created_at = excluded.created_at`,
        )
        .run(row.subject, row.threadId, row.label, row.createdAt);
    });
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

  listStrikes(since: number, limit: number): StrikeRow[] {
    const n = Math.min(500, Math.max(1, Math.floor(limit)));
    return this.transaction(() =>
      this.db
        .prepare(
          'SELECT id, at, subject_id, room_id, term_id, raw_line FROM kit_strikes WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?',
        )
        .all(since, n)
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

  countStrikesByTerm(since: number): Array<{ termId: string; count: number }> {
    return this.transaction(() =>
      this.db
        .prepare('SELECT term_id, COUNT(*) AS n FROM kit_strikes WHERE at >= ? GROUP BY term_id ORDER BY term_id')
        .all(since)
        .map((r) => ({ termId: String(r.term_id), count: Number(r.n) })),
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
              target_seat, target_handle, category, reported_reason, note, line_id, excerpt_json, people_json, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (reporter_subject, target_subject, room_id) DO NOTHING`,
        )
        .run(
          r.id, r.createdAt, r.roomId, JSON.stringify(r.tags), r.reporterSubject, r.reporterSeat, r.reporterHandle,
          r.targetSubject, r.targetSeat, r.targetHandle, r.category, r.reportedReason ?? null, r.note, r.lineId, JSON.stringify(r.excerpt),
          JSON.stringify(r.people), r.status,
        );
      if (Number(res.changes) === 0) return false;
      this.bump();
      return true;
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

  listOpenReports(q: OpenReportQuery): ReportRecord[] {
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit)));
    const where: string[] = ["status = 'open'"];
    const args: Array<string | number> = [];
    if (q.category !== undefined) {
      where.push('category = ?');
      args.push(q.category);
    }
    if (q.reason === null) where.push('reported_reason IS NULL');
    else if (q.reason !== undefined) {
      where.push('reported_reason = ?');
      args.push(q.reason);
    }
    if (q.after !== undefined) {
      if (q.afterId === undefined) {
        where.push('created_at > ?');
        args.push(q.after);
      } else {
        where.push('(created_at >= ? AND (created_at > ? OR id > ?))');
        args.push(q.after, q.after, q.afterId);
      }
    }
    const sql = `SELECT * FROM kit_reports WHERE ${where.join(' AND ')} ORDER BY created_at, id LIMIT ?`;
    return this.transaction(() => this.db.prepare(sql).all(...args, limit).map(reportFromRow));
  }

  listOpenReportsByPerson(subjects: readonly SubjectId[], limit: number): ReportRecord[] {
    if (subjects.length === 0) return [];
    const n = Math.min(200, Math.max(1, Math.floor(limit)));
    const marks = subjects.map(() => '?').join(', ');
    const sql = `SELECT * FROM kit_reports WHERE status = 'open' AND target_subject IN (${marks}) ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.transaction(() => this.db.prepare(sql).all(...subjects, n).map(reportFromRow));
  }

  reporterTally(reporters: readonly SubjectId[]): ReporterTally {
    const tally: ReporterTally = { open: 0, actioned: 0, dismissed: 0, badFaith: 0 };
    if (reporters.length === 0) return tally;
    const marks = reporters.map(() => '?').join(', ');
    const sql = `SELECT status, bad_faith, COUNT(*) AS n FROM kit_reports WHERE reporter_subject IN (${marks}) GROUP BY status, bad_faith`;
    for (const r of this.transaction(() => this.db.prepare(sql).all(...reporters))) {
      const n = Number(r.n);
      const status = String(r.status);
      if (status === 'open' || status === 'actioned' || status === 'dismissed') tally[status] += n;
      if (Number(r.bad_faith) === 1) tally.badFaith += n;
    }
    return tally;
  }

  listReports(q: ReportListQuery): ReportRecord[] {
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit)));
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.status !== undefined) {
      where.push('status = ?');
      args.push(q.status);
    }
    if (q.reason !== undefined) {
      if (q.reason === null) {
        where.push('reported_reason IS NULL');
      } else {
        where.push('reported_reason = ?');
        args.push(q.reason);
      }
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

  loadReporterDecisions(reporters: readonly SubjectId[]): ReporterDecision[] {
    if (reporters.length === 0) return [];
    // SQLite caps the variables of one statement, so a long list is asked for in chunks.
    const CHUNK = 500;
    return this.transaction(() => {
      // The newest 200 decided reports with a reason: a person's accuracy needs no more, and the work stays bounded.
      const reports: Array<Record<string, unknown>> = [];
      for (let i = 0; i < reporters.length; i += CHUNK) {
        const part = reporters.slice(i, i + CHUNK);
        const marks = part.map(() => '?').join(', ');
        reports.push(
          ...this.db
            .prepare(
              `SELECT id, status, reported_reason, target_subject, created_at FROM kit_reports
               WHERE reporter_subject IN (${marks}) AND status != 'open' AND reported_reason IS NOT NULL
               ORDER BY created_at DESC, id DESC LIMIT 200`,
            )
            .all(...part),
        );
      }
      reports.sort((x, y) => Number(y.created_at) - Number(x.created_at) || String(y.id).localeCompare(String(x.id)));
      reports.length = Math.min(reports.length, 200);
      if (reports.length === 0) return [];

      // One query for the decisions of those reports, one (per chunk) for the sanction rows of their groups.
      const decisions = this.db
        .prepare(`SELECT report_id, result_json FROM kit_decisions WHERE report_id IN (${reports.map(() => '?').join(', ')})`)
        .all(...reports.map((r) => String(r.id)));
      const groupsOf = new Map<string, string[]>();
      for (const d of decisions) {
        // A row that cannot be read is a decision with no known actions, never a failure of the call.
        let parsed: { groups?: unknown } | null;
        try {
          parsed = JSON.parse(String(d.result_json)) as { groups?: unknown } | null;
        } catch {
          parsed = null;
        }
        const list = groupsOf.get(String(d.report_id)) ?? [];
        if (parsed !== null && Array.isArray(parsed.groups)) {
          for (const g of parsed.groups as Array<{ groupId?: unknown } | null>) if (typeof g?.groupId === 'string') list.push(g.groupId);
        }
        groupsOf.set(String(d.report_id), list);
      }
      const allGroups = [...new Set([...groupsOf.values()].flat())];
      const rows = new Map<string, Array<{ subject: SubjectId; rule: ReporterDecision['actions'][number]['rule'] }>>();
      for (let i = 0; i < allGroups.length; i += CHUNK) {
        const part = allGroups.slice(i, i + CHUNK);
        const found = this.db
          .prepare(
            `SELECT group_id, target_value, rule FROM kit_sanctions
             WHERE target_type = 'subject' AND group_id IN (${part.map(() => '?').join(', ')}) ORDER BY rowid`,
          )
          .all(...part);
        for (const s of found) {
          const rule = s.rule === null ? null : String(s.rule);
          const list = rows.get(String(s.group_id)) ?? [];
          list.push({ subject: String(s.target_value), rule: rule !== null && /^[1-9][0-9]*$/.test(rule) ? Number(rule) : 'uncovered' });
          rows.set(String(s.group_id), list);
        }
      }
      return reports.map((r) => ({
        reportId: String(r.id),
        status: String(r.status) as 'actioned' | 'dismissed',
        reason: String(r.reported_reason),
        target: String(r.target_subject),
        actions: (groupsOf.get(String(r.id)) ?? []).flatMap((g) => rows.get(g) ?? []),
      }));
    });
  }

  addReportDetail(id: string, detail: { reportedReason: string | null; category: ReportCategory; note: string | null; at: number }): boolean {
    return this.transaction(() => {
      // One conditional statement: only an open report with no follow-up yet. The target, excerpt and line are not in it.
      const res = this.db
        .prepare(
          `UPDATE kit_reports SET reported_reason = ?, category = ?, note = ?, detail_at = ?
           WHERE id = ? AND status = 'open' AND detail_at IS NULL`,
        )
        .run(detail.reportedReason, detail.category, detail.note, detail.at, id);
      if (Number(res.changes) === 0) return false;
      this.bump();
      return true;
    });
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
      if (Number(res.changes) === 0) return false;
      this.bump();
      return true;
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
