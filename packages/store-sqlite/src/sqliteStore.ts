import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, CONDUCT_LEVELS, ROLES } from '@chatwarden/core';
import type {
  AppealRow,
  AppealStatus,
  BlockedNameRow,
  NameReason,
  AIExample,
  AIRead,
  AISignal,
  AiCallUsage,
  AiErrorKind,
  AiExampleRow,
  AiOutcomeInsert,
  AiOutcomeRow,
  AiReadDone,
  AiReadPending,
  AiReadRow,
  AiReadStatus,
  AiReserveResult,
  AiStatsRow,
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
  ReporterOutcomeRow,
  ReporterTally,
  SignalRow,
  SignalSourceRow,
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

const APPEAL_COLUMNS =
  'id, subject_id, group_id, notice_id, report_id, rule, kind, statement, status, created_at, decided_at, decided_by, decision_reason, replacement_group_id';

function toAppealRow(r: Record<string, unknown>): AppealRow {
  return {
    id: String(r.id),
    subject: String(r.subject_id),
    groupId: String(r.group_id),
    noticeId: String(r.notice_id),
    reportId: r.report_id === null ? null : String(r.report_id),
    rule: r.rule === null ? null : String(r.rule),
    kind: String(r.kind) as SanctionKind,
    statement: r.statement === null ? null : String(r.statement),
    status: String(r.status) as AppealStatus,
    createdAt: Number(r.created_at),
    decidedAt: r.decided_at === null ? null : Number(r.decided_at),
    decidedBy: r.decided_by === null ? null : String(r.decided_by),
    decisionReason: r.decision_reason === null ? null : String(r.decision_reason),
    replacementGroupId: r.replacement_group_id === null ? null : String(r.replacement_group_id),
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

// --- AI reads and the casebook (migration 20) ---

const AI_READ_STATUSES: readonly string[] = ['pending', 'ok', 'declined', 'invalid', 'failed', 'skipped'];
const AI_ERROR_KINDS: readonly string[] = ['retryable', 'fatal', 'declined', 'timeout', 'invalid', 'budget'];
const AI_VERDICTS: readonly string[] = ['upheld', 'noted', 'no_action', 'unclear'];

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const nullableText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nullableNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** A stored rule text back to a rule: `'3'` is 3, `'uncovered'` itself, NULL none; anything else is undefined (a damaged row). */
function ruleFromText(v: unknown): number | 'uncovered' | null | undefined {
  if (v === null || v === undefined) return null;
  const t = String(v);
  if (t === 'uncovered') return t;
  return /^\d+$/.test(t) ? Number(t) : undefined;
}

/** The validated read stored on an `ok` row, or null when any column of it cannot be read (one damaged row never breaks a page). */
function readFromRow(r: Record<string, unknown>): AIRead | null {
  try {
    const severity = String(r.severity);
    const confidence = String(r.confidence);
    const rule = ruleFromText(r.rule);
    const evidence: unknown = JSON.parse(String(r.evidence_json));
    const recJson: unknown = r.rec_json === null || r.rec_json === undefined ? null : JSON.parse(String(r.rec_json));
    if (!(CONDUCT_LEVELS as readonly string[]).includes(severity) || !['low', 'medium', 'high'].includes(confidence)) return null;
    if (rule === undefined || typeof r.summary !== 'string' || !isStrings(evidence)) return null;
    let recommendation: AIRead['recommendation'] = null;
    if (recJson !== null) {
      const rec = recJson as { verdict?: unknown; severity?: unknown; rule?: unknown; evidence?: unknown };
      const recRule = rec.rule === null ? null : rec.rule === 'uncovered' ? 'uncovered' : typeof rec.rule === 'number' ? rec.rule : undefined;
      if (
        typeof rec !== 'object' ||
        !AI_VERDICTS.includes(String(rec.verdict)) ||
        !(CONDUCT_LEVELS as readonly string[]).includes(String(rec.severity)) ||
        recRule === undefined ||
        !isStrings(rec.evidence)
      ) {
        return null;
      }
      recommendation = { verdict: rec.verdict as 'upheld', severity: rec.severity as AIRead['severity'], rule: recRule, evidence: rec.evidence };
    }
    return {
      severity: severity as AIRead['severity'],
      rule,
      summary: r.summary,
      evidence,
      confidence: confidence as AIRead['confidence'],
      injectionSuspected: Number(r.injection) === 1,
      recommendation,
    };
  } catch {
    return null;
  }
}

/** The ids stored with a read; none when the column is empty or damaged. */
function exampleIdsFromRow(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  try {
    const ids: unknown = JSON.parse(String(v));
    return isStrings(ids) ? ids : [];
  } catch {
    return [];
  }
}

/** The signal counts a read stores: only the four fields, and null for none. */
function signalsToText(v: readonly AISignal[] | undefined): string | null {
  const rows = (v ?? []).map((s) => ({
    label: String(s.label),
    polarity: s.polarity === 'positive' ? 'positive' : 'negative',
    distinct: Math.max(0, Math.floor(Number(s.distinct))),
    windowDays: Math.max(0, Math.floor(Number(s.windowDays))),
  }));
  return rows.length === 0 ? null : JSON.stringify(rows);
}

/** The counts stored with a read; null when the column is empty or damaged (a read made before signals existed has none). */
function signalsFromRow(v: unknown): AISignal[] | null {
  if (v === null || v === undefined) return null;
  try {
    const rows: unknown = JSON.parse(String(v));
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const out: AISignal[] = [];
    for (const r of rows as Array<Record<string, unknown>>) {
      if (typeof r?.label !== 'string' || (r.polarity !== 'negative' && r.polarity !== 'positive') || typeof r.distinct !== 'number' || typeof r.windowDays !== 'number') return null;
      out.push({ label: r.label, polarity: r.polarity, distinct: r.distinct, windowDays: r.windowDays });
    }
    return out;
  } catch {
    return null;
  }
}

/** A read row; null for an `ok` row whose answer cannot be read (with `lenient`, that row comes back with `read: null` instead). */
function aiReadFromRow(r: Record<string, unknown>, lenient = false): AiReadRow | null {
  const status = String(r.status);
  if (!AI_READ_STATUSES.includes(status)) return null;
  const read = status === 'ok' ? readFromRow(r) : null;
  if (status === 'ok' && read === null && !lenient) return null;
  const kind = nullableText(r.error_kind);
  return {
    id: String(r.id),
    reportId: String(r.report_id),
    inputHash: String(r.input_hash),
    status: status as AiReadStatus,
    attempts: Number(r.attempts),
    retryAt: nullableNumber(r.retry_at),
    leaseUntil: nullableNumber(r.lease_until),
    errorKind: kind !== null && AI_ERROR_KINDS.includes(kind) ? (kind as AiErrorKind) : null,
    adapter: nullableText(r.adapter) ?? '',
    model: nullableText(r.model),
    promptVersion: Number(r.prompt_version),
    read,
    exampleIds: status === 'ok' ? exampleIdsFromRow(r.example_ids) : [],
    signals: status === 'ok' ? signalsFromRow(r.signals_json) : null,
    inputTokens: nullableNumber(r.input_tokens),
    outputTokens: nullableNumber(r.output_tokens),
    cacheReadTokens: nullableNumber(r.cache_read_tokens),
    cacheWriteTokens: nullableNumber(r.cache_write_tokens),
    costMicros: Number(r.cost_micros),
    latencyMs: nullableNumber(r.latency_ms),
    createdAt: Number(r.created_at),
    retaken: Number(r.retaken) === 1,
  };
}

const parseExample = (json: unknown): AIExample | null => {
  if (json === null || json === undefined) return null;
  try {
    const e = JSON.parse(String(json)) as AIExample | null;
    return typeof e === 'object' && e !== null && Array.isArray(e.lines) ? e : null;
  } catch {
    return null;
  }
};

/** What an unreadable detail reads as: nothing matched, no step. */
const EMPTY_DETAIL: AiOutcomeRow['detail'] = { verdict: false, rule: false, lines: 0, outcome: 'none', oneClick: false };

function detailFromRow(json: unknown): AiOutcomeRow['detail'] {
  try {
    const d = JSON.parse(String(json)) as Partial<AiOutcomeRow['detail']> | null;
    if (
      typeof d === 'object' &&
      d !== null &&
      typeof d.verdict === 'boolean' &&
      typeof d.rule === 'boolean' &&
      typeof d.lines === 'number' &&
      typeof d.oneClick === 'boolean' &&
      (d.outcome === 'same' || d.outcome === 'milder' || d.outcome === 'harsher' || d.outcome === 'none')
    ) {
      return { verdict: d.verdict, rule: d.rule, lines: d.lines, outcome: d.outcome, oneClick: d.oneClick };
    }
  } catch {
    /* an unreadable detail reads as empty */
  }
  return { ...EMPTY_DETAIL };
}

/** The page sizes used when a limit is omitted, not finite or below 1 (the memory store keeps the same two numbers). */
const EXAMPLES_DEFAULT_LIMIT = 2;
const RETRIES_DEFAULT_LIMIT = 20;

/** Order two strings by code unit, the way the signal listing sorts (the memory store sorts the same way). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A page size: the limit floored and capped at 200, or `fallback` when it is omitted, not finite or below 1. */
const pageSize = (limit: number | undefined, fallback: number): number =>
  limit !== undefined && Number.isFinite(limit) && limit >= 1 ? Math.min(200, Math.floor(limit)) : fallback;

function aiOutcomeFromRow(r: Record<string, unknown>): AiOutcomeRow {
  const detail = detailFromRow(r.detail_json);
  return {
    reportId: String(r.report_id),
    readId: nullableText(r.read_id),
    decidedAt: Number(r.decided_at),
    level: Number(r.level),
    verdict: String(r.verdict) as AiOutcomeRow['verdict'],
    rule: nullableText(r.rule),
    severity: nullableText(r.severity) as AiOutcomeRow['severity'],
    aiVerdict: nullableText(r.ai_verdict) as AiOutcomeRow['aiVerdict'],
    agreement: String(r.agreement) as AiOutcomeRow['agreement'],
    detail,
    badFaith: Number(r.bad_faith) === 1,
    example: parseExample(r.example_json),
    reversed: Number(r.reversed) === 1,
    corrective: Number(r.corrective) === 1,
    dontTeach: Number(r.dont_teach) === 1,
  };
}

/** The order of `aiStats`: numbered rules by number, then `uncovered`, then any other text, then no rule. */
function ruleRank(rule: string | null): number {
  if (rule === null) return 3;
  if (/^\d+$/.test(rule)) return 0;
  return rule === 'uncovered' ? 1 : 2;
}
function compareRules(a: string | null, b: string | null): number {
  const rank = ruleRank(a) - ruleRank(b);
  if (rank !== 0 || a === null || b === null) return rank;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What makes an outcome a teachable example (everything but the rule, severity and time). One text, used by two queries. */
const AI_TEACHABLE_SQL = "example_json IS NOT NULL AND agreement <> 'none' AND reversed = 0 AND dont_teach = 0 AND bad_faith = 0";

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
            gap_note, gap_status, room_id, report_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        ins.run(
          r.id, r.groupId, r.refCode, r.kind, r.targetType, r.value, r.startsAt, r.endsAt, r.reason, r.rule,
          r.actor, r.source, r.automated ? 1 : 0, r.pending ? 1 : 0, r.gapNote, r.gapStatus, r.roomId, r.reportId ?? null,
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
    // A listing for named people seeks by person (`kit_sanctions_by_target`), then sorts the few rows it finds. Left to itself SQLite,
    // which has no table statistics here, prefers `kit_sanctions_by_start` for the `LIMIT` and would walk every sanction by time looking
    // for them; every other listing is the case that index is for.
    const via = q.subjects !== undefined ? ' INDEXED BY kit_sanctions_by_target' : '';
    const sql =
      `SELECT ${SANCTION_COLUMNS}, revoked_at, revoked_by, revoke_reason FROM kit_sanctions${via} WHERE ${where.join(' AND ')} ` +
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

  // AI reads and the casebook (AI levels 1 and 2, migration 20). SYNCHRONOUS on purpose (like claims); they run inside `transaction`.

  reserveAiRead(row: AiReadPending, leaseUntil: number, now: number, opts?: { retake?: boolean }): AiReserveResult {
    const retake = opts?.retake === true ? 1 : 0;
    return this.transaction((): AiReserveResult => {
      // The UNIQUE (report_id, input_hash) index decides who inserts: of two connections, one gets a row back, the other none.
      const fresh = this.db
        .prepare(
          `INSERT INTO kit_ai_reads (id, report_id, input_hash, status, attempts, lease_until, adapter, prompt_version, created_at)
           VALUES (?, ?, ?, 'pending', 1, ?, ?, ?, ?)
           ON CONFLICT (report_id, input_hash) DO NOTHING
           RETURNING id, attempts`,
        )
        .get(randomBytes(16).toString('base64url'), row.reportId, row.inputHash, leaseUntil, row.adapter, row.promptVersion, now);
      if (fresh !== undefined) return this.openAttempt(String(fresh.id), Number(fresh.attempts), now);
      // The row exists. Take it over only when its lease has lapsed or its retry time has come: one conditional write, so of two
      // callers racing for it exactly one changes it and the other's WHERE is false. `attempts` is the fence the winner holds.
      const taken = this.db
        .prepare(
          `UPDATE kit_ai_reads
           SET status = 'pending', attempts = attempts + 1, retry_at = NULL, lease_until = ?, error_kind = NULL,
               retaken = CASE WHEN ? = 1 AND retaken = 0 AND retry_at IS NULL AND status IN ('declined', 'invalid', 'failed') THEN 1 ELSE retaken END
           WHERE report_id = ? AND input_hash = ?
             AND ((status = 'pending' AND lease_until <= ?)
               OR (status IN ('failed', 'skipped') AND retry_at IS NOT NULL AND retry_at <= ?)
               OR (? = 1 AND ((retaken = 0 AND retry_at IS NULL AND status IN ('declined', 'invalid', 'failed')) OR status = 'skipped')))
           RETURNING id, attempts`,
        )
        .get(leaseUntil, retake, row.reportId, row.inputHash, now, now, retake);
      if (taken !== undefined) return this.openAttempt(String(taken.id), Number(taken.attempts), now);
      const existing = this.db.prepare('SELECT * FROM kit_ai_reads WHERE report_id = ? AND input_hash = ?').get(row.reportId, row.inputHash);
      const mapped = existing === undefined ? null : aiReadFromRow(existing, true);
      if (mapped === null) throw new Error('reserveAiRead: the stored read has an unknown status');
      // An `ok` row whose answer cannot be read (damaged by hand) is no read at all: take it over and read again rather than throw.
      if (mapped.status === 'ok' && mapped.read === null) {
        const retaken = this.db
          .prepare(
            `UPDATE kit_ai_reads
             SET status = 'pending', attempts = attempts + 1, retry_at = NULL, lease_until = ?, error_kind = NULL
             WHERE id = ? AND status = 'ok' RETURNING id, attempts`,
          )
          .get(leaseUntil, mapped.id);
        if (retaken !== undefined) return this.openAttempt(String(retaken.id), Number(retaken.attempts), now);
      }
      return { reserved: false, existing: mapped };
    });
  }

  /** One call started: a ledger entry for (read, attempt) at `now`; the fence token is the attempt number. */
  private openAttempt(readId: string, attempt: number, now: number): AiReserveResult {
    this.db.prepare('INSERT INTO kit_ai_spend (read_id, attempt, at, micros) VALUES (?, ?, ?, 0)').run(readId, attempt, now);
    return { reserved: true, id: readId, lease: attempt };
  }

  /**
   * A stale owner's call was still paid for: book its cost to its own attempt's ledger entry, once (only an entry still at 0 takes
   * it). The read row is not touched. Only an attempt that has been superseded (`lease` below the row's `attempts`) is booked.
   */
  private bookStale(id: string, lease: number, usage: AiCallUsage | undefined): void {
    if (usage === undefined) return;
    this.db
      .prepare(
        `UPDATE kit_ai_spend SET micros = ?
         WHERE read_id = ? AND attempt = ? AND micros = 0 AND attempt < (SELECT attempts FROM kit_ai_reads WHERE id = ?)`,
      )
      .run(usage.costMicros, id, lease, id);
  }

  /** Add what a call cost to its read row (cost and tokens summed over attempts) and to its ledger entry. */
  private addUsage(id: string, attempt: number, u: AiCallUsage): void {
    this.db
      .prepare(
        `UPDATE kit_ai_reads
         SET model = ?, input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ?,
             cache_read_tokens = COALESCE(cache_read_tokens, 0) + ?, cache_write_tokens = COALESCE(cache_write_tokens, 0) + ?,
             cost_micros = cost_micros + ?, latency_ms = ?
         WHERE id = ?`,
      )
      .run(u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.costMicros, u.latencyMs, id);
    this.db.prepare('UPDATE kit_ai_spend SET micros = micros + ? WHERE read_id = ? AND attempt = ?').run(u.costMicros, id, attempt);
  }

  completeAiRead(id: string, lease: number, result: AiReadDone): boolean {
    return this.transaction(() => {
      const read = result.read;
      // The fence: only the holder of the current attempt can finish the row.
      const changed = Number(
        this.db
          .prepare(
            `UPDATE kit_ai_reads
             SET status = 'ok', lease_until = NULL, retry_at = NULL, error_kind = NULL,
                 severity = ?, rule = ?, summary = ?, evidence_json = ?, confidence = ?, injection = ?, rec_json = ?, example_ids = ?, signals_json = ?
             WHERE id = ? AND status = 'pending' AND attempts = ?`,
          )
          .run(
            read.severity,
            read.rule === null ? null : String(read.rule),
            read.summary,
            JSON.stringify(read.evidence),
            read.confidence,
            read.injectionSuspected ? 1 : 0,
            read.recommendation === null ? null : JSON.stringify(read.recommendation),
            JSON.stringify(result.exampleIds ?? []),
            signalsToText(result.signals),
            id,
            lease,
          ).changes,
      );
      if (changed === 0) {
        this.bookStale(id, lease, result);
        return false;
      }
      this.addUsage(id, lease, result);
      this.bump();
      return true;
    });
  }

  failAiRead(
    id: string,
    lease: number,
    status: 'failed' | 'declined' | 'invalid' | 'skipped',
    errorKind: AiErrorKind,
    retryAt: number | null,
    usage?: AiCallUsage,
  ): boolean {
    return this.transaction(() => {
      const changed = Number(
        this.db
          .prepare(
            // A skipped read was never a call: the attempt is given back, so it does not use up the three-attempt budget.
            `UPDATE kit_ai_reads
             SET status = ?, error_kind = ?, retry_at = ?, lease_until = NULL,
                 attempts = CASE WHEN ? = 'skipped' THEN MAX(0, attempts - 1) ELSE attempts END
             WHERE id = ? AND status = 'pending' AND attempts = ?`,
          )
          .run(status, errorKind, retryAt, status, id, lease).changes,
      );
      if (changed === 0) {
        this.bookStale(id, lease, usage);
        return false;
      }
      if (usage !== undefined) this.addUsage(id, lease, usage);
      // A skipped read was never a call: its attempt leaves the ledger.
      if (status === 'skipped') this.db.prepare('DELETE FROM kit_ai_spend WHERE read_id = ? AND attempt = ?').run(id, lease);
      return true;
    });
  }

  loadAiRead(reportId: string): AiReadRow | null {
    return this.transaction(() => {
      // A few rows, newest first: an unreadable one is skipped in favour of the next. The index is named, because `status = 'ok'`
      // would otherwise draw the planner to kit_ai_reads_retry; any migration that drops or renames kit_ai_reads_by_report MUST change
      // this SQL and loadAiReads (a named index that is gone is a runtime error, not a slower plan).
      const rows = this.db
        .prepare(
          `SELECT * FROM kit_ai_reads INDEXED BY kit_ai_reads_by_report
           WHERE report_id = ? AND status = 'ok' ORDER BY created_at DESC, id DESC LIMIT 20`,
        )
        .all(reportId);
      for (const r of rows) {
        const mapped = aiReadFromRow(r);
        if (mapped !== null) return mapped;
      }
      return null;
    });
  }

  loadAiReadFor(reportId: string, inputHash: string): AiReadRow | null {
    return this.transaction(() => {
      const r = this.db.prepare('SELECT * FROM kit_ai_reads WHERE report_id = ? AND input_hash = ?').get(reportId, inputHash);
      return r === undefined ? null : aiReadFromRow(r, true);
    });
  }

  loadAiReadById(id: string): AiReadRow | null {
    return this.transaction(() => {
      const r = this.db.prepare('SELECT * FROM kit_ai_reads WHERE id = ?').get(id);
      return r === undefined ? null : aiReadFromRow(r);
    });
  }

  loadAiReads(reportIds: readonly string[]): AiReadRow[] {
    const wanted = [...new Set(reportIds)].slice(0, 200);
    if (wanted.length === 0) return [];
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM kit_ai_reads INDEXED BY kit_ai_reads_by_report
           WHERE status = 'ok' AND report_id IN (${wanted.map(() => '?').join(', ')})
           ORDER BY report_id, created_at DESC, id DESC`,
        )
        .all(...wanted);
      const newest = new Map<string, AiReadRow>();
      for (const r of rows) {
        if (newest.has(String(r.report_id))) continue;
        const mapped = aiReadFromRow(r);
        if (mapped !== null) newest.set(mapped.reportId, mapped);
      }
      return wanted.flatMap((id) => newest.get(id) ?? []);
    });
  }

  listAiRetries(now: number, limit: number | undefined): AiReadRow[] {
    const n = pageSize(limit, RETRIES_DEFAULT_LIMIT);
    return this.transaction(() =>
      this.db
        .prepare(
          `SELECT * FROM (
             SELECT * FROM kit_ai_reads WHERE status IN ('failed', 'skipped') AND retry_at <= ?
             UNION ALL
             SELECT * FROM kit_ai_reads WHERE status = 'pending' AND lease_until <= ?
           ) WHERE NOT EXISTS (SELECT 1 FROM kit_reports p WHERE p.id = report_id AND p.status <> 'open')
           ORDER BY created_at, id LIMIT ?`,
        )
        .all(now, now, n)
        .flatMap((r) => aiReadFromRow(r) ?? []),
    );
  }

  aiSpendSince(since: number): { micros: number; calls: number } {
    const r = this.transaction(() =>
      this.db.prepare('SELECT COALESCE(SUM(micros), 0) AS micros, COUNT(*) AS calls FROM kit_ai_spend WHERE at >= ?').get(since),
    );
    return { micros: Number(r?.micros ?? 0), calls: Number(r?.calls ?? 0) };
  }

  insertAiOutcome(row: AiOutcomeInsert): boolean {
    return this.transaction(
      () =>
        Number(
          this.db
            .prepare(
              `INSERT INTO kit_ai_outcomes
                 (report_id, read_id, decided_at, level, verdict, rule, severity, ai_verdict, agreement, detail_json, bad_faith, example_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (report_id) DO NOTHING`,
            )
            .run(
              row.reportId,
              row.readId,
              row.decidedAt,
              row.level,
              row.verdict,
              row.rule,
              row.severity,
              row.aiVerdict,
              row.agreement,
              JSON.stringify(row.detail),
              row.badFaith ? 1 : 0,
              // A bad-faith row can never teach, so its chat text is not kept.
              row.example === null || row.badFaith ? null : JSON.stringify(row.example),
            ).changes,
        ) > 0,
    );
  }

  loadAiOutcome(reportId: string): AiOutcomeRow | null {
    const r = this.transaction(() => this.db.prepare('SELECT * FROM kit_ai_outcomes WHERE report_id = ?').get(reportId));
    return r === undefined ? null : aiOutcomeFromRow(r);
  }

  markAiOutcome(reportId: string, patch: { reversed?: true; dontTeach?: true; corrective?: true }): boolean {
    return this.transaction(() => {
      const reversed = patch.reversed === true ? 1 : 0;
      const dontTeach = patch.dontTeach === true ? 1 : 0;
      const corrective = patch.corrective === true ? 1 : 0;
      const changed = Number(
        this.db
          .prepare(
            // The right-hand sides read the columns as they were, so each "now set" test is the patch OR the old column. A row that can no
            // longer teach loses its chat text; a corrective one (a revoked appeal) keeps it, unless it was marked "don't teach".
            `UPDATE kit_ai_outcomes
             SET reversed = CASE WHEN ? = 1 THEN 1 ELSE reversed END, dont_teach = CASE WHEN ? = 1 THEN 1 ELSE dont_teach END,
                 corrective = CASE WHEN ? = 1 THEN 1 ELSE corrective END,
                 example_json = CASE WHEN ? = 1 OR dont_teach = 1 OR ((? = 1 OR reversed = 1) AND NOT (? = 1 OR corrective = 1)) THEN NULL ELSE example_json END
             WHERE report_id = ?`,
          )
          .run(reversed, dontTeach, corrective, dontTeach, reversed, corrective, reportId).changes,
      );
      if (changed === 0) return false;
      this.bump();
      return true;
    });
  }

  aiExamples(rule: string, severity: string, limit: number | undefined, since: number): AiExampleRow[] {
    const n = pageSize(limit, EXAMPLES_DEFAULT_LIMIT);
    return this.transaction(() => {
      const rows = (sql: string, ...args: Array<string | number>): AiExampleRow[] =>
        this.db
          .prepare(sql)
          .all(...args)
          .flatMap((r): AiExampleRow[] => {
            const example = parseExample(r.example_json);
            return example === null
              ? []
              : [{ reportId: String(r.report_id), decidedAt: Number(r.decided_at), agreement: String(r.agreement) as 'agree' | 'override', example }];
          });
      const standard = rows(
        `SELECT report_id, decided_at, agreement, example_json FROM kit_ai_outcomes
         WHERE rule = ? AND severity = ? AND decided_at >= ? AND ${AI_TEACHABLE_SQL}
         ORDER BY decided_at DESC, report_id DESC LIMIT ?`,
        rule,
        severity,
        since,
        n,
      );
      // At most one corrective row (the newest) beside them; it is not counted by `aiTeachableCount`.
      const corrective = rows(
        `SELECT report_id, decided_at, agreement, example_json FROM kit_ai_outcomes
         WHERE rule = ? AND severity = ? AND decided_at >= ? AND corrective = 1 AND example_json IS NOT NULL AND agreement <> 'none'
           AND dont_teach = 0 AND bad_faith = 0
         ORDER BY decided_at DESC, report_id DESC LIMIT 1`,
        rule,
        severity,
        since,
      ).map((r): AiExampleRow => ({ kind: 'corrective', ...r }));
      return [...standard, ...corrective];
    });
  }

  aiTeachableCount(since: number): number {
    const r = this.transaction(() =>
      this.db.prepare(`SELECT COUNT(*) AS n FROM kit_ai_outcomes WHERE decided_at >= ? AND ${AI_TEACHABLE_SQL}`).get(since),
    );
    return Number(r?.n ?? 0);
  }

  aiStats(since: number): AiStatsRow[] {
    const rows = this.transaction(() =>
      this.db
        .prepare(
          `SELECT rule, COUNT(*) AS decided,
                  SUM(agreement = 'agree') AS agree, SUM(agreement = 'override') AS override, SUM(agreement = 'none') AS none,
                  SUM(ai_verdict IN ('upheld', 'noted') AND (verdict = 'no_action' OR corrective = 1)) AS false_positives,
                  SUM(CASE WHEN agreement = 'agree' AND json_valid(detail_json) THEN COALESCE(json_extract(detail_json, '$.oneClick'), 0) = 1 ELSE 0 END) AS one_click
           FROM kit_ai_outcomes WHERE decided_at >= ? GROUP BY rule`,
        )
        .all(since),
    );
    return rows
      .map((r) => ({
        rule: nullableText(r.rule),
        decided: Number(r.decided),
        agree: Number(r.agree),
        override: Number(r.override),
        none: Number(r.none),
        falsePositives: Number(r.false_positives),
        oneClick: Number(r.one_click),
      }))
      .sort((a, b) => compareRules(a.rule, b.rule));
  }

  purgeAi(readsBefore: number, outcomesBefore: number, examplesBefore: number): { reads: number; outcomes: number } {
    return this.transaction(() => {
      const reads = Number(this.db.prepare('DELETE FROM kit_ai_reads WHERE created_at < ?').run(readsBefore).changes);
      this.db.prepare('DELETE FROM kit_ai_spend WHERE at < ?').run(readsBefore);
      const outcomes = Number(this.db.prepare('DELETE FROM kit_ai_outcomes WHERE decided_at < ?').run(outcomesBefore).changes);
      // The only chat text that outlives a report goes on its own, shorter clock; the row keeps its counts.
      this.db.prepare('UPDATE kit_ai_outcomes SET example_json = NULL WHERE decided_at < ? AND example_json IS NOT NULL').run(examplesBefore);
      return { reads, outcomes };
    });
  }

  // Signals (flood control and signals, migration 21). SYNCHRONOUS on purpose (like claims); they run inside `transaction`. A signal is not
  // a queue change, so none of these moves the change token.

  insertSignal(row: SignalRow): boolean {
    // One statement: the UNIQUE index kit_signals_cap (and the primary key) decide, so of two connections writing the same
    // (kind, subject, source, bucket) exactly one gets a row back. A negative or NaN weight fails the table's CHECK and throws; a time, bucket or
    // weight that is not a finite number is refused here (as the memory store does), since SQLite would store an infinity or turn a NaN into NULL.
    if (!(Number.isFinite(row.weight) && row.weight >= 0)) throw new Error('insertSignal: weight must be a finite number, 0 or more');
    if (!Number.isFinite(row.at)) throw new Error('insertSignal: at must be a finite number');
    if (!Number.isSafeInteger(row.capBucket)) throw new Error('insertSignal: capBucket must be a whole number');
    const wrote = this.db
      .prepare(
        `INSERT INTO kit_signals (id, kind, subject_id, source_key, by_subject, room_id, at, weight, cap_bucket)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING
         RETURNING id`,
      )
      .get(row.id, row.kind, row.subject, row.sourceKey, row.bySubject, row.roomId, row.at, row.weight, row.capBucket);
    return wrote !== undefined;
  }

  listSignalSources(subjects: readonly SubjectId[], since: number): SignalSourceRow[] {
    const unique = [...new Set(subjects)];
    if (unique.length === 0) return [];
    return this.transaction(() => {
      const out: SignalSourceRow[] = [];
      for (let i = 0; i < unique.length; i += CLAIM_BATCH) {
        const batch = unique.slice(i, i + CLAIM_BATCH);
        // `by_subject` is the smallest one of the source's rows, so the answer does not depend on which row SQLite meets first.
        const rows = this.db
          .prepare(
            `SELECT subject_id, kind, source_key, MIN(by_subject) AS by_subject, MAX(weight) AS weight, MIN(at) AS first_at, MAX(at) AS last_at
             FROM kit_signals
             WHERE subject_id IN (${batch.map(() => '?').join(', ')}) AND at >= ?
             GROUP BY subject_id, kind, source_key`,
          )
          .all(...batch, since);
        for (const r of rows) {
          out.push({
            subject: String(r.subject_id),
            kind: String(r.kind),
            sourceKey: String(r.source_key),
            bySubject: r.by_subject === null ? null : String(r.by_subject),
            weight: Number(r.weight),
            firstAt: Number(r.first_at),
            lastAt: Number(r.last_at),
          });
        }
      }
      // Sorted by subject, kind and source, whatever order SQLite grouped in (and across batches).
      return out.sort((a, b) => cmp(a.subject, b.subject) || cmp(a.kind, b.kind) || cmp(a.sourceKey, b.sourceKey));
    });
  }

  purgeSignals(before: number): number {
    return Number(this.db.prepare('DELETE FROM kit_signals WHERE at < ?').run(before).changes);
  }

  // Appeals (migration 22). SYNCHRONOUS on purpose (like claims and notices); they run inside `transaction`. A write that changes
  // something moves the change token (the queue shows appeals), inside the same savepoint, so an undone write undoes the move.

  insertAppeal(row: AppealRow): boolean {
    return this.transaction(() => {
      // One statement: UNIQUE (group_id) and the primary key decide, so of two connections filing for one group exactly one gets a row back.
      const wrote = this.db
        .prepare(
          `INSERT INTO kit_appeals
             (id, subject_id, group_id, notice_id, report_id, rule, kind, statement, status, created_at, decided_at, decided_by,
              decision_reason, replacement_group_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING
           RETURNING id`,
        )
        .get(
          row.id, row.subject, row.groupId, row.noticeId, row.reportId, row.rule, row.kind, row.statement, row.status, row.createdAt,
          row.decidedAt, row.decidedBy, row.decisionReason, row.replacementGroupId,
        );
      if (wrote === undefined) return false;
      this.bump();
      return true;
    });
  }

  loadAppeal(id: string): AppealRow | null {
    const r = this.transaction(() => this.db.prepare(`SELECT ${APPEAL_COLUMNS} FROM kit_appeals WHERE id = ?`).get(id));
    return r === undefined ? null : toAppealRow(r);
  }

  listAppeals(q: { status?: 'open' | 'decided' | 'all'; limit: number; after?: { createdAt: number; id: string } }): AppealRow[] {
    const n = Math.floor(q.limit);
    const limit = Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 1;
    const status = q.status ?? 'all';
    // A moot appeal (nobody ruled on it) is never listed.
    const where =
      status === 'open' ? "status = 'open'" : status === 'decided' ? "status IN ('upheld', 'reduced', 'revoked')" : "status IN ('open', 'upheld', 'reduced', 'revoked')";
    const args: Array<string | number> = [];
    let cursor = '';
    if (q.after !== undefined) {
      cursor = ' AND (created_at > ? OR (created_at = ? AND id > ?))';
      args.push(q.after.createdAt, q.after.createdAt, q.after.id);
    }
    return this.transaction(() =>
      this.db
        .prepare(`SELECT ${APPEAL_COLUMNS} FROM kit_appeals WHERE ${where}${cursor} ORDER BY created_at, id LIMIT ?`)
        .all(...args, limit)
        .map(toAppealRow),
    );
  }

  listAppealsBy(subjects: readonly SubjectId[], limit: number): AppealRow[] {
    const unique = [...new Set(subjects)];
    const n = Math.floor(limit);
    const size = Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 1;
    const found: AppealRow[] = [];
    this.transaction(() => {
      for (let i = 0; i < unique.length; i += CLAIM_BATCH) {
        const batch = unique.slice(i, i + CLAIM_BATCH);
        // The newest `size` of each batch is enough: the merged newest `size` cannot need more from any one batch.
        for (const r of this.db
          .prepare(
            `SELECT ${APPEAL_COLUMNS} FROM kit_appeals
             WHERE subject_id IN (${batch.map(() => '?').join(', ')}) AND status <> 'moot'
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(...batch, size)) {
          found.push(toAppealRow(r));
        }
      }
    });
    return found.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, size);
  }

  countAppealsBy(subjects: readonly SubjectId[], since: number): { count: number; oldestAt: number | null } {
    const unique = [...new Set(subjects)];
    let count = 0;
    let oldestAt: number | null = null;
    this.transaction(() => {
      for (let i = 0; i < unique.length; i += CLAIM_BATCH) {
        const batch = unique.slice(i, i + CLAIM_BATCH);
        const r = this.db
          .prepare(
            `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM kit_appeals
             WHERE subject_id IN (${batch.map(() => '?').join(', ')}) AND created_at >= ?`,
          )
          .get(...batch, since);
        count += Number(r?.n ?? 0);
        if (r?.oldest !== null && r?.oldest !== undefined && (oldestAt === null || Number(r.oldest) < oldestAt)) oldestAt = Number(r.oldest);
      }
    });
    return { count, oldestAt };
  }

  countOpenAppeals(): number {
    return Number(this.transaction(() => this.db.prepare("SELECT COUNT(*) AS n FROM kit_appeals WHERE status = 'open'").get())?.n ?? 0);
  }

  decideAppeal(
    id: string,
    patch: { status: 'upheld' | 'reduced' | 'revoked'; at: number; by: string; reason: string; replacementGroupId: string | null; clearStatement?: boolean },
  ): boolean {
    return this.transaction(() => {
      // One conditional UPDATE: only an open appeal moves, so of two connections deciding one appeal exactly one changes a row.
      const res = this.db
        .prepare(
          `UPDATE kit_appeals
           SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ?, replacement_group_id = ?,
               statement = CASE WHEN ? = 1 THEN NULL ELSE statement END
           WHERE id = ? AND status = 'open'`,
        )
        .run(patch.status, patch.at, patch.by, patch.reason, patch.replacementGroupId, patch.clearStatement === true ? 1 : 0, id);
      if (Number(res.changes) === 0) return false;
      this.bump();
      return true;
    });
  }

  closeAppealsForGroup(groupId: string, by: string, at: number, clearStatement?: boolean): number {
    return this.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE kit_appeals SET status = 'moot', decided_at = ?, decided_by = ?, statement = CASE WHEN ? = 1 THEN NULL ELSE statement END
           WHERE group_id = ? AND status = 'open'`,
        )
        .run(at, by, clearStatement === true ? 1 : 0, groupId);
      if (Number(res.changes) > 0) this.bump();
      return Number(res.changes);
    });
  }

  closeOrphanAppeals(by: string, at: number, clearStatement?: boolean): number {
    return this.transaction(() => {
      // An open appeal with no SUBJECT row left for its group: retention removed it (a revoked group still has its row).
      const res = this.db
        .prepare(
          `UPDATE kit_appeals SET status = 'moot', decided_at = ?, decided_by = ?, statement = CASE WHEN ? = 1 THEN NULL ELSE statement END
           WHERE status = 'open'
             AND NOT EXISTS (SELECT 1 FROM kit_sanctions s WHERE s.group_id = kit_appeals.group_id AND s.target_type = 'subject')`,
        )
        .run(at, by, clearStatement === true ? 1 : 0);
      if (Number(res.changes) > 0) this.bump();
      return Number(res.changes);
    });
  }

  appealCountsByRule(since: number): Array<{ rule: string | null; appealed: number; granted: number; lightened: number }> {
    // Grouped by the raw rule (so the index kit_appeals_by_rule serves it); 'uncovered' and NULL are merged after.
    const rows = this.transaction(() =>
      this.db
        .prepare(
          `SELECT rule, COUNT(*) AS appealed, SUM(status = 'revoked') AS granted, SUM(status = 'reduced') AS lightened
           FROM kit_appeals WHERE created_at >= ? GROUP BY rule`,
        )
        .all(since),
    );
    const out = new Map<string | null, { rule: string | null; appealed: number; granted: number; lightened: number }>();
    for (const r of rows) {
      const rule = r.rule === null || r.rule === 'uncovered' ? null : String(r.rule);
      const c = out.get(rule) ?? { rule, appealed: 0, granted: 0, lightened: 0 };
      c.appealed += Number(r.appealed);
      c.granted += Number(r.granted);
      c.lightened += Number(r.lightened);
      out.set(rule, c);
    }
    return [...out.values()];
  }

  countSanctionsByRule(since: number): Array<{ rule: string | null; count: number }> {
    // Distinct subject GROUPS of a restriction or a warning, never a note or an IP row, revoked ones included, and never a group an appeal
    // wrote as the replacement of another (a reduction is one sanction, not two).
    const rows = this.transaction(() =>
      this.db
        .prepare(
          `SELECT rule, COUNT(DISTINCT group_id) AS n FROM kit_sanctions
           WHERE target_type = 'subject' AND starts_at >= ? AND kind IN ('warning', 'chat', 'area', 'ban')
             AND NOT EXISTS (SELECT 1 FROM kit_appeals a WHERE a.replacement_group_id = kit_sanctions.group_id)
           GROUP BY rule`,
        )
        .all(since),
    );
    const out = new Map<string | null, { rule: string | null; count: number }>();
    for (const r of rows) {
      const rule = r.rule === null || r.rule === 'uncovered' ? null : String(r.rule);
      const c = out.get(rule) ?? { rule, count: 0 };
      c.count += Number(r.n);
      out.set(rule, c);
    }
    return [...out.values()];
  }

  loadSanctionSubjectRow(groupId: string): SanctionRow | null {
    const r = this.transaction(() =>
      this.db
        .prepare(`SELECT ${SANCTION_COLUMNS}, report_id, revoked_at AS rv FROM kit_sanctions WHERE group_id = ? AND target_type = 'subject' ORDER BY rowid LIMIT 1`)
        .get(groupId),
    );
    if (r === undefined) return null;
    // The one read that carries the report id and the revocation time (each omitted when there is none, so every other load keeps the shape it had).
    return { ...toSanctionRow(r), ...(r.report_id === null ? {} : { reportId: String(r.report_id) }), ...(r.rv === null ? {} : { revokedAt: Number(r.rv) }) };
  }

  clearAppealStatements(before: number): number {
    return this.transaction(() =>
      Number(
        this.db
          .prepare("UPDATE kit_appeals SET statement = NULL WHERE status <> 'open' AND decided_at < ? AND statement IS NOT NULL")
          .run(before).changes,
      ),
    );
  }

  purgeAppeals(before: number): number {
    return this.transaction(() =>
      Number(
        this.db
          .prepare(
            // A decided appeal on a sanction still in force stays: no end, or an end after the cutoff, and not revoked. That row is what
            // stops a second appeal against it.
            `DELETE FROM kit_appeals
             WHERE status <> 'open' AND decided_at < ?
               AND NOT EXISTS (
                 SELECT 1 FROM kit_sanctions s
                 WHERE s.group_id = kit_appeals.group_id AND s.target_type = 'subject' AND s.revoked_at IS NULL
                   AND s.kind NOT IN ('warning', 'note') AND (s.ends_at IS NULL OR s.ends_at > ?))`,
          )
          .run(before, before).changes,
      ),
    );
  }

  // Blocked names (migration 22). A kept name is evidence, not a queue item: none of these moves the change token.

  insertBlockedName(row: BlockedNameRow): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO kit_blocked_names (id, subject_id, name, term_id, reason, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.id, row.subject, row.name, row.termId, row.reason, row.at);
    });
  }

  listBlockedNames(since: number, limit: number): BlockedNameRow[] {
    const n = Math.floor(limit);
    const size = Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 1;
    return this.transaction(() =>
      this.db
        .prepare('SELECT id, subject_id, name, term_id, reason, at FROM kit_blocked_names WHERE at >= ? ORDER BY at DESC, rowid DESC LIMIT ?')
        .all(since, size)
        .map((r) => ({
          id: String(r.id),
          subject: r.subject_id === null ? null : String(r.subject_id),
          name: String(r.name),
          termId: r.term_id === null ? null : String(r.term_id),
          reason: String(r.reason) as NameReason,
          at: Number(r.at),
        })),
    );
  }

  purgeBlockedNames(before: number): number {
    return this.transaction(() => Number(this.db.prepare('DELETE FROM kit_blocked_names WHERE at < ?').run(before).changes));
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
    const n = Math.min(201, Math.max(1, Math.floor(limit)));
    const marks = subjects.map(() => '?').join(', ');
    const sql = `SELECT * FROM kit_reports WHERE status = 'open' AND target_subject IN (${marks}) ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.transaction(() => this.db.prepare(sql).all(...subjects, n).map(reportFromRow));
  }

  listOpenReportsByReporter(reporters: readonly SubjectId[], limit: number): ReportRecord[] {
    if (reporters.length === 0) return [];
    const n = Math.min(201, Math.max(1, Math.floor(limit)));
    const unique = [...new Set(reporters)];
    const marks = unique.map(() => '?').join(', ');
    // Served by kit_reports_by_reporter_outcome (migration 19): the reporter, then the filing time, with `status` read from the index
    // before a row is fetched. Named, because without statistics the planner would walk the by-status index (every open report in the
    // store) and filter by reporter, which is the wrong end of a sweep of one reporter's reports. Any migration that drops or renames
    // this index MUST change this SQL: a named index that is gone is a runtime error ("no such index"), not a slower plan.
    const sql = `SELECT * FROM kit_reports INDEXED BY kit_reports_by_reporter_outcome WHERE reporter_subject IN (${marks}) AND status = 'open' ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.transaction(() => this.db.prepare(sql).all(...unique, n).map(reportFromRow));
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

  reporterOutcomes(reporters: readonly SubjectId[], since: number): ReporterOutcomeRow[] {
    // A repeated id would be counted once per chunk it lands in: ask for each reporter once.
    const unique = [...new Set(reporters)];
    if (unique.length === 0) return [];
    // SQLite caps the variables of one statement, so a long list is asked for in chunks. The columns after `reporter_subject` are
    // all in kit_reports_by_reporter_outcome (migration 19), so each chunk is answered from that index alone.
    const CHUNK = 500;
    return this.transaction(() => {
      const out: ReporterOutcomeRow[] = [];
      for (let i = 0; i < unique.length; i += CHUNK) {
        const part = unique.slice(i, i + CHUNK);
        const marks = part.map(() => '?').join(', ');
        const sql = `SELECT reporter_subject AS reporter,
                SUM(status = 'actioned') AS actioned,
                SUM(status = 'dismissed' AND bad_faith = 0) AS no_action,
                SUM(status = 'dismissed' AND bad_faith = 1) AS bad_faith
         FROM kit_reports
         WHERE reporter_subject IN (${marks}) AND created_at >= ? AND status != 'open'
         GROUP BY reporter_subject`;
        for (const r of this.db.prepare(sql).all(...part, since)) {
          out.push({ reporter: String(r.reporter), actioned: Number(r.actioned), noAction: Number(r.no_action), badFaith: Number(r.bad_faith) });
        }
      }
      return out;
    });
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
      // An AI read is a view of its report and goes with it, in the same transaction (its casebook outcome has its own clock).
      this.db
        .prepare(
          `DELETE FROM kit_ai_reads WHERE report_id IN (
             SELECT id FROM kit_reports
             WHERE created_at < ? AND NOT (bad_faith = 1 AND actioned_at IS NOT NULL AND actioned_at >= ?))`,
        )
        .run(before, keepBadFaithSince);
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

  purgeNotices(before: number, unseen?: { appealBefore: number; renameBefore: number }): number {
    // A seen message notice goes like a seen report outcome. An unseen one has a ceiling only when the caller gives one: an unseen appeal
    // outcome goes past `appealBefore`, an unseen required rename past `renameBefore` (NULL compares false, so no ceiling means no match).
    const appealBefore = unseen === undefined ? null : unseen.appealBefore;
    const renameBefore = unseen === undefined ? null : unseen.renameBefore;
    return this.transaction(() =>
      Number(
        this.db
          .prepare(
            `DELETE FROM kit_notices
             WHERE (withdrawn_at IS NOT NULL AND created_at < ?)
                OR (acked_at IS NOT NULL AND created_at < ?
                    AND kind IN ('warning', 'report_outcome', 'rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked'))
                OR (acked_at IS NULL AND kind IN ('appeal_upheld', 'appeal_reduced', 'appeal_revoked') AND created_at < ?)
                OR (acked_at IS NULL AND kind = 'rename_required' AND created_at < ?)
                OR (until IS NOT NULL AND until < ?)`,
          )
          .run(before, before, appealBefore, renameBefore, before).changes,
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
