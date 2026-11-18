import type { DatabaseSync } from 'node:sqlite';
import { ERASED_LINE, EXPORT_SECTION_MAX, erasedReporter } from '@chatwarden/core';
import type { ErasePlan, ErasureCounts, ErasureRemoved, ErasureRow, PrivacyCategory, ReportExcerptLine, SubjectExport } from '@chatwarden/core';

// The privacy half of the SQLite store (0.2.0, design section 5): export, erase and the receipts. Every statement uses plain `?` placeholders and binds
// exactly as many values as it has (node:sqlite on Node 22.13 throws on a surplus); lists travel as ONE JSON array bound to `json_each(?)`, so each
// category is one prepared statement whatever the size of the alias set or the held set. `sql-placeholders.test.ts` counts every constant below.

export const EPOCH_KEY = 'erasure_epoch';

const IN_ARG = '(SELECT value FROM json_each(?))';

// Legal hold. A purge and the erase consult the table themselves, so no caller can forget a hold. The subselects have no placeholders.
/** The reports an open hold protects. */
export const HELD_REPORT_IDS = '(SELECT report_id FROM kit_legal_holds WHERE released_at IS NULL)';
/** The sanction groups decided from a held report: their rows, notices and appeals are protected with it. */
export const HELD_GROUP_IDS = `(SELECT group_id FROM kit_sanctions WHERE report_id IN ${HELD_REPORT_IDS})`;
/** Place a hold: a new one, or the replacement of a RELEASED one (an open hold is left alone and the statement changes nothing). Binds: report, code, by, at. */
export const HOLD_PLACE_SQL = `INSERT INTO kit_legal_holds (report_id, code, held_by, held_at, released_by, released_at) VALUES (?, ?, ?, ?, NULL, NULL)
  ON CONFLICT (report_id) DO UPDATE SET code = excluded.code, held_by = excluded.held_by, held_at = excluded.held_at, released_by = NULL, released_at = NULL
  WHERE kit_legal_holds.released_at IS NOT NULL`;
/** Release an open hold. Binds: by, at, report. */
export const HOLD_RELEASE_SQL = 'UPDATE kit_legal_holds SET released_by = ?, released_at = ? WHERE report_id = ? AND released_at IS NULL';
export const HOLD_LOAD_SQL = 'SELECT report_id, code, held_by, held_at, released_by, released_at FROM kit_legal_holds WHERE report_id = ?';
export const HOLD_LIST_SQL = 'SELECT report_id, code, held_by, held_at, released_by, released_at FROM kit_legal_holds WHERE released_at IS NULL ORDER BY held_at, report_id';
/** The groups a report's decision wrote, by the first row of each (a group's rows are written together). Binds: the report. */
export const SANCTION_GROUPS_OF_REPORT_SQL = 'SELECT group_id, MIN(rowid) AS first FROM kit_sanctions WHERE report_id = ? GROUP BY group_id ORDER BY first';
export const HELD_SET_REPORTS_SQL = 'SELECT report_id FROM kit_legal_holds WHERE released_at IS NULL ORDER BY report_id';
export const HELD_SET_GROUPS_SQL = `SELECT DISTINCT group_id FROM kit_sanctions WHERE report_id IN ${HELD_REPORT_IDS} ORDER BY group_id`;
/** How many held reports are about or by the set, for an export: only that something is held, never which report, why or since when. Binds: the set, the set. */
export const EXPORT_HOLDS_SQL = `SELECT COUNT(*) AS n FROM kit_legal_holds h JOIN kit_reports r ON r.id = h.report_id
  WHERE h.released_at IS NULL AND (r.target_subject IN (SELECT value FROM json_each(?)) OR r.reporter_subject IN (SELECT value FROM json_each(?)))`;

/** Every subject of the request and every subject merged into one of them (a recursive walk down `merged_into`). Binds: the request as a JSON array. */
export const ERASE_CLOSURE_SQL = `WITH RECURSIVE c(id) AS (
  SELECT id FROM kit_subjects WHERE id IN ${IN_ARG}
  UNION
  SELECT s.id FROM kit_subjects s JOIN c ON s.merged_into = c.id
) SELECT id FROM c ORDER BY id`;

/** The sanction groups with a subject row naming the person. Binds: the set. */
export const GROUPS_OF_SET_SQL = `SELECT DISTINCT group_id FROM kit_sanctions WHERE target_type = 'subject' AND target_value IN ${IN_ARG}`;
/** The groups that are in force now (a restricting kind, unrevoked, not ended). Binds: the set, the time. */
export const GROUPS_IN_FORCE_SQL = `SELECT DISTINCT group_id FROM kit_sanctions
  WHERE target_type = 'subject' AND target_value IN ${IN_ARG} AND revoked_at IS NULL AND (ends_at IS NULL OR ends_at > ?) AND kind IN ('chat', 'area', 'ban')`;
/** The groups a held report protects. Binds: the held ids. */
export const GROUPS_OF_HELD_SQL = `SELECT DISTINCT group_id FROM kit_sanctions WHERE report_id IN ${IN_ARG}`;
/** How many rows of the given groups exist. Binds: the groups. */
export const COUNT_GROUP_ROWS_SQL = `SELECT COUNT(*) AS n FROM kit_sanctions WHERE group_id IN ${IN_ARG}`;
/** The held reports that name the set (as target, reporter or a writer of a line). Binds: the held ids, the set, the set. */
export const HELD_NAMING_SQL = `SELECT COUNT(*) AS n FROM kit_reports WHERE id IN ${IN_ARG}
  AND (target_subject IN ${IN_ARG} OR reporter_subject IN ${IN_ARG}
       OR EXISTS (SELECT 1 FROM json_each(kit_reports.people_json) p WHERE p.value IN ${IN_ARG}))`;

/** Reports about the set that are not held. Binds: the set, the held ids. */
export const REPORTS_ABOUT_IDS_SQL = `SELECT id FROM kit_reports WHERE target_subject IN ${IN_ARG} AND id NOT IN ${IN_ARG}`;
/** The other reports that name the set (as reporter or as a writer of a line), not held, for the line scrub. Binds: the held ids, the set, the set. */
export const REPORTS_NAMING_SQL = `SELECT id, reporter_subject, reporter_seat, reporter_handle, excerpt_json, people_json FROM kit_reports
  WHERE id NOT IN ${IN_ARG}
    AND (reporter_subject IN ${IN_ARG} OR EXISTS (SELECT 1 FROM json_each(kit_reports.people_json) p WHERE p.value IN ${IN_ARG}))`;
/** Delete the reports of a list. Binds: the ids. */
export const REPORTS_DELETE_SQL = `DELETE FROM kit_reports WHERE id IN ${IN_ARG}`;
/** The staff thread entries of a list of reports (they go with the reports). Binds: the ids. */
export const COMMENTS_DELETE_SQL = `DELETE FROM kit_report_comments WHERE report_id IN ${IN_ARG}`;
/**
 * The free text of the staff comments on reports that STAY and name the set (the person reported, or wrote a line) is replaced by a marker. Binds: the marker, the ids, the marker (a text already
 * the marker is not counted as a change).
 */
export const COMMENTS_SCRUB_SQL = `UPDATE kit_report_comments SET text = ? WHERE report_id IN ${IN_ARG} AND text IS NOT NULL AND text <> ?`;
/** The decisions of a list of reports. Binds: the ids. */
export const DECISIONS_DELETE_SQL = `DELETE FROM kit_decisions WHERE report_id IN ${IN_ARG}`;
export const AI_READS_DELETE_SQL = `DELETE FROM kit_ai_reads WHERE report_id IN ${IN_ARG}`;
export const AI_OUTCOMES_DELETE_SQL = `DELETE FROM kit_ai_outcomes WHERE report_id IN ${IN_ARG}`;
export const AI_ACTIONS_DELETE_SQL = `DELETE FROM kit_ai_actions WHERE report_id IN ${IN_ARG}`;
export const AI_OUTCOME_EXAMPLES_CLEAR_SQL = `UPDATE kit_ai_outcomes SET example_json = NULL WHERE report_id IN ${IN_ARG} AND example_json IS NOT NULL`;
/** A coop link names a report by id. Binds: the ids. */
export const LINKS_DELETE_SQL = `DELETE FROM kit_links WHERE system = 'coop-report' AND ref IN ${IN_ARG}`;
/** An EOS sanction link is keyed `<group id>#<hash of the product user id>`: it goes with the group. Binds: the deleted groups. */
export const EOS_LINKS_DELETE_SQL = `DELETE FROM kit_links WHERE system = 'eos-sanction' AND substr(ref, 1, instr(ref, '#') - 1) IN ${IN_ARG}`;
/** The decisions of reports that stay and still name someone of the set in their stored answer. Binds: the held ids, the set. */
export const DECISIONS_NAMING_SQL = `SELECT key, result_json FROM kit_decisions WHERE report_id NOT IN ${IN_ARG}
  AND EXISTS (SELECT 1 FROM json_each(?) s WHERE instr(kit_decisions.result_json, s.value) > 0)`;
/** Rewrite the stored answer of one decision. Binds: the answer, the key. */
export const DECISION_RESULT_SET_SQL = 'UPDATE kit_decisions SET result_json = ? WHERE key = ?';
/** The replay answer of a webhook sanction names its group (and reference code): blank the ones of deleted groups. Binds: the deleted groups. */
export const WEBHOOK_KEYS_BLANK_SQL = `UPDATE kit_webhook_keys SET result_json = '{"erased":true}'
  WHERE state = 'done' AND CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.groupId') END IN ${IN_ARG}`;
/** A sanction or an appeal that cited a deleted report no longer does. Binds: the ids. */
export const SANCTIONS_UNLINK_SQL = `UPDATE kit_sanctions SET report_id = NULL WHERE report_id IN ${IN_ARG}`;
export const APPEALS_UNLINK_SQL = `UPDATE kit_appeals SET report_id = NULL WHERE report_id IN ${IN_ARG}`;
/** One report whose reporter and lines are rewritten. Binds: the reporter value, the reporter seat, the handle, the note flag, the excerpt, the people, the id. */
export const REPORT_SCRUB_SQL = `UPDATE kit_reports SET reporter_subject = ?, reporter_seat = ?, reporter_handle = ?, note = CASE WHEN ? = 1 THEN NULL ELSE note END,
  excerpt_json = ?, people_json = ? WHERE id = ?`;

/** Delete whole sanction groups (every row, address rows included). Binds: the groups. */
export const SANCTIONS_DELETE_SQL = `DELETE FROM kit_sanctions WHERE group_id IN ${IN_ARG}`;
/** The notices of the set that go: every one that is not of a kept group. Binds: the set, the kept groups. */
export const NOTICES_DELETE_SQL = `DELETE FROM kit_notices WHERE subject_id IN ${IN_ARG} AND (group_id IS NULL OR group_id NOT IN ${IN_ARG})`;
/** The notices of in-force groups that stay with their quoted lines cleared. Binds: the set, the groups. */
export const NOTICES_CLEAR_SQL = `UPDATE kit_notices SET excerpt_json = '[]' WHERE subject_id IN ${IN_ARG} AND group_id IN ${IN_ARG} AND excerpt_json <> '[]'`;
export const STRIKES_DELETE_SQL = `DELETE FROM kit_strikes WHERE subject_id IN ${IN_ARG}`;
export const MUTES_DELETE_SQL = `DELETE FROM kit_mutes WHERE viewer_id IN ${IN_ARG} OR target_id IN ${IN_ARG}`;
export const BLOCKED_NAMES_DELETE_SQL = `DELETE FROM kit_blocked_names WHERE subject_id IN ${IN_ARG}`;
/** Appeals of the set, except those on a sanction group a hold protects. Binds: the set, the protected groups. */
export const APPEALS_DELETE_SQL = `DELETE FROM kit_appeals WHERE subject_id IN ${IN_ARG} AND group_id NOT IN ${IN_ARG}`;
export const SIGNALS_DELETE_SQL = `DELETE FROM kit_signals WHERE subject_id IN ${IN_ARG} OR by_subject IN ${IN_ARG}`;
export const NOAUTO_DELETE_SQL = `DELETE FROM kit_ai_noauto WHERE subject_id IN ${IN_ARG}`;
export const CLAIMS_DELETE_SQL = `DELETE FROM kit_claims WHERE person IN ${IN_ARG}`;
export const THREADS_DELETE_SQL = `DELETE FROM kit_discord_threads WHERE subject IN ${IN_ARG}`;
/** Rewrite the audit refs that name the set. Binds: the receipt id, the set. */
export const AUDIT_REWRITE_SQL = `UPDATE kit_audit SET subject_ref = ? WHERE subject_type = 'person' AND subject_ref IN ${IN_ARG}`;
export const IDENTIFIERS_DELETE_SQL = `DELETE FROM kit_subject_ids WHERE subject_id IN ${IN_ARG}`;
export const SUBJECTS_DELETE_SQL = `DELETE FROM kit_subjects WHERE id IN ${IN_ARG}`;
/** Move the erasure epoch (the row exists from migration 26 and is created when it does not). */
export const EPOCH_BUMP_SQL = `INSERT INTO kit_meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`;
export const EPOCH_READ_SQL = 'SELECT value FROM kit_meta WHERE key = ?';

// Stray rows: strikes, signals, notices and kept names whose subject has no subject row. The time variant binds the cut; the `only` variant binds a JSON list of ids.
// A notice of a sanction group a hold protects stays. Each table has both, so the time variant can use the time index of the table.
const NO_SUBJECT = 'NOT IN (SELECT id FROM kit_subjects)';
const STRAY_TABLES: ReadonlyArray<readonly [string, string, string, string]> = [
  ['STRIKES', 'kit_strikes', 'subject_id', 'at'],
  ['SIGNALS', 'kit_signals', 'subject_id', 'at'],
  ['NOTICES', 'kit_notices', 'subject_id', 'created_at'],
  ['NAMES', 'kit_blocked_names', 'subject_id', 'at'],
];
const strayWhere = (table: string, col: string): string =>
  `${col} ${NO_SUBJECT}${table === 'kit_notices' ? ` AND (group_id IS NULL OR group_id NOT IN ${HELD_GROUP_IDS})` : ''}`;
export const STRAY_BEFORE_SQL: Readonly<Record<string, string>> = Object.fromEntries(
  STRAY_TABLES.map(([k, table, col, time]) => [k, `DELETE FROM ${table} WHERE ${time} < ? AND ${strayWhere(table, col)}`]),
);
export const STRAY_ONLY_SQL: Readonly<Record<string, string>> = Object.fromEntries(
  STRAY_TABLES.map(([k, table, col]) => [k, `DELETE FROM ${table} WHERE ${col} IN ${IN_ARG} AND ${strayWhere(table, col)}`]),
);

export const ERASURE_INSERT_SQL = 'INSERT INTO kit_erasures (id, at, mode, actor, counts_json, pending_subject) VALUES (?, ?, ?, ?, ?, ?)';
export const ERASURES_PENDING_SQL = 'SELECT id, at, mode, actor, counts_json, pending_subject FROM kit_erasures WHERE pending_subject IS NOT NULL ORDER BY at, id';
export const ERASURE_ONE_SQL = 'SELECT pending_subject FROM kit_erasures WHERE id = ?';
export const ERASURE_CLEAR_SQL = 'UPDATE kit_erasures SET pending_subject = NULL WHERE id = ?';
export const ERASURES_PURGE_SQL = 'DELETE FROM kit_erasures WHERE at < ? AND pending_subject IS NULL';
/**
 * A sanction row of the set that keeps the erase pending: any row, except a row a legal hold keeps that is not in force now (ended or revoked, or a kind that restricts
 * nothing). Binds: the set, the time.
 */
export const SANCTION_ROWS_LEFT_SQL = `SELECT 1 AS x FROM kit_sanctions WHERE target_type = 'subject' AND target_value IN ${IN_ARG}
  AND (group_id NOT IN ${HELD_GROUP_IDS} OR (revoked_at IS NULL AND (ends_at IS NULL OR ends_at > ?) AND kind IN ('chat', 'area', 'ban'))) LIMIT 1`;

// Export reads. Each takes the set as a JSON array (and a limit of one more than the cap, so a cut section can be told from a full one).
export const EXPORT_SUBJECTS_SQL = `SELECT MIN(created_at) AS created, COUNT(*) AS n FROM kit_subjects WHERE id IN ${IN_ARG}`;
// `+kind` (a unary plus) keeps the planner on the subject index: the kind index would walk every account of every person.
export const EXPORT_ACCOUNTS_SQL = `SELECT DISTINCT value FROM kit_subject_ids WHERE subject_id IN ${IN_ARG} AND +kind = 'account' ORDER BY value`;
export const EXPORT_IDENTIFIERS_SQL = `SELECT SUM(kind = 'key') AS keys, SUM(kind = 'ip') AS addresses, MIN(first_seen) AS first, MAX(last_seen) AS last
  FROM kit_subject_ids WHERE subject_id IN ${IN_ARG}`;
// `starts_at + 0` keeps the ordering from pulling the planner onto the by-start index (a walk of every subject sanction) instead of the person's own rows.
export const EXPORT_SANCTIONS_SQL = `SELECT kind, rule, reason, starts_at, ends_at, ref_code, source, revoked_at FROM kit_sanctions
  WHERE target_type = 'subject' AND target_value IN ${IN_ARG} ORDER BY starts_at + 0 DESC, rowid DESC LIMIT ?`;
export const EXPORT_NOTICES_SQL = `SELECT kind, rule, until, created_at, excerpt_json FROM kit_notices WHERE subject_id IN ${IN_ARG} ORDER BY created_at, rowid LIMIT ?`;
export const EXPORT_FILED_SQL = `SELECT created_at, reported_reason, category, note, tags_json FROM kit_reports WHERE reporter_subject IN ${IN_ARG} ORDER BY created_at DESC, id DESC LIMIT ?`;
export const EXPORT_ABOUT_SQL = `SELECT created_at, category, reported_reason, status, origin, excerpt_json, people_json FROM kit_reports WHERE target_subject IN ${IN_ARG}
  ORDER BY created_at DESC, id DESC LIMIT ?`;
export const EXPORT_STRIKES_SQL = `SELECT at, room_id, raw_line FROM kit_strikes WHERE subject_id IN ${IN_ARG} ORDER BY at DESC, id DESC LIMIT ?`;
export const EXPORT_NAMES_SQL = `SELECT at, name, reason FROM kit_blocked_names WHERE subject_id IN ${IN_ARG} ORDER BY at DESC, id DESC LIMIT ?`;
export const EXPORT_APPEALS_SQL = `SELECT created_at, kind, rule, status, statement, decided_at FROM kit_appeals WHERE subject_id IN ${IN_ARG} ORDER BY created_at DESC, id DESC LIMIT ?`;
export const EXPORT_SIGNALS_SQL = `SELECT at, kind FROM kit_signals WHERE subject_id IN ${IN_ARG} ORDER BY at DESC, id DESC LIMIT ?`;
export const EXPORT_MUTES_SQL = `SELECT SUM(viewer_id IN ${IN_ARG}) AS placed, SUM(target_id IN ${IN_ARG} AND block = 0) AS received FROM kit_mutes WHERE viewer_id IN ${IN_ARG} OR target_id IN ${IN_ARG}`;
export const EXPORT_NOAUTO_SQL = `SELECT code FROM kit_ai_noauto WHERE subject_id IN ${IN_ARG} ORDER BY set_at DESC LIMIT 1`;
export const EXPORT_AI_READS_SQL = `SELECT COUNT(*) AS n FROM kit_ai_reads WHERE report_id IN (SELECT id FROM kit_reports WHERE target_subject IN ${IN_ARG})`;
export const EXPORT_AI_OUTCOMES_SQL = `SELECT verdict, agreement FROM kit_ai_outcomes WHERE report_id IN (SELECT id FROM kit_reports WHERE target_subject IN ${IN_ARG})
  ORDER BY decided_at, report_id LIMIT ?`;
/** How many free-text staff comments sit on reports that name the set (as target, reporter or a writer of a line). Binds: the set, the set, the set. */
export const EXPORT_COMMENTS_SQL = `SELECT COUNT(*) AS n FROM kit_report_comments WHERE text IS NOT NULL AND report_id IN (SELECT id FROM kit_reports WHERE target_subject IN ${IN_ARG}
  OR reporter_subject IN ${IN_ARG} OR EXISTS (SELECT 1 FROM json_each(kit_reports.people_json) p WHERE p.value IN ${IN_ARG}))`;
export const EXPORT_AUDIT_SQL = `SELECT at, action FROM kit_audit WHERE subject_type = 'person' AND subject_ref IN ${IN_ARG} ORDER BY at, id LIMIT ?`;

const j = (values: Iterable<string>): string => JSON.stringify([...values]);
const num = (v: unknown): number => Number(v ?? 0);

/** Thrown inside a dry run to undo it; caught in `eraseSubjectsDry`. */
class DryRunRollback extends Error {
  readonly counts: ErasureCounts;
  constructor(counts: ErasureCounts) {
    super('dry run');
    this.counts = counts;
  }
}

function column(db: DatabaseSync, sql: string, ...args: Array<string | number>): string[] {
  return db.prepare(sql).all(...args).map((r) => String(Object.values(r)[0]));
}

function addCount(removed: ErasureRemoved, category: PrivacyCategory, n: number): void {
  if (n > 0) removed[category] = (removed[category] ?? 0) + n;
}

/** The lines the set wrote in a report's excerpt, by the report's `people` list. Returns the new people and excerpt, or null when nobody of the set is in it. */
export function scrubExcerpt(
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
          ? l
          : { ...l, p: remap.get(l.p) ?? null },
    ),
  };
}

function parseJson<T>(text: unknown, fallback: T): T {
  try {
    return JSON.parse(String(text)) as T;
  } catch {
    return fallback;
  }
}

/**
 * The stored answer of a decision with the entries for the erased set removed (`{ groups: [{ subject, groupId, refCode, kind, noticeId }] }`), or null when nothing
 * changes. An entry whose sanction group stays (a ban in force the erase keeps) stays too. An answer that is not JSON but names someone of the set is blanked.
 */
export function redactDecision(text: string, set: ReadonlySet<string>, keepGroups: ReadonlySet<string>): string | null {
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

/** The subjects of the request and everything merged into them, that exist. */
export function closure(db: DatabaseSync, subjects: readonly string[]): string[] {
  if (subjects.length === 0) return [];
  return column(db, ERASE_CLOSURE_SQL, j(subjects));
}

/**
 * One erase, inside the caller's transaction. Reads, then deletes; counts rows removed or changed per category. The caller wraps it so a dry run can roll back.
 */
function eraseInTransaction(db: DatabaseSync, plan: ErasePlan, set: string[], bump: () => void): ErasureCounts {
  const removed: ErasureRemoved = {};
  const setJ = j(set);
  // The store consults its own holds, whatever the caller passed: an erase can never reach a held report.
  const heldIds = new Set([...plan.heldReportIds, ...column(db, HELD_SET_REPORTS_SQL)]);
  const held = j(heldIds);
  const setSet = new Set(set);

  // Which groups stay: a held report's groups always; in `safety`, the groups in force on the person.
  const personGroups = column(db, GROUPS_OF_SET_SQL, setJ);
  const heldGroups = new Set(heldIds.size === 0 ? [] : column(db, GROUPS_OF_HELD_SQL, held));
  const inForce = new Set(plan.mode === 'safety' ? column(db, GROUPS_IN_FORCE_SQL, setJ, plan.at) : []);
  const keepIdentifiers = inForce.size > 0;
  const keepGroups = new Set(personGroups.filter((g) => inForce.has(g) || heldGroups.has(g)));
  const goneGroups = personGroups.filter((g) => !keepGroups.has(g));
  const clearGroups = [...keepGroups].filter((g) => inForce.has(g) && !heldGroups.has(g));
  const keptSanctionRows = keepGroups.size === 0 ? 0 : num(db.prepare(COUNT_GROUP_ROWS_SQL).get(j(keepGroups))?.n);
  const heldNaming = heldIds.size === 0 ? 0 : num(db.prepare(HELD_NAMING_SQL).get(held, setJ, setJ, setJ)?.n);

  // Reports about the person go, with everything that hangs on them.
  const aboutIds = column(db, REPORTS_ABOUT_IDS_SQL, setJ, held);
  if (aboutIds.length > 0) {
    const ids = j(aboutIds);
    db.prepare(DECISIONS_DELETE_SQL).run(ids);
    addCount(removed, 'workflow', num(db.prepare(COMMENTS_DELETE_SQL).run(ids).changes));
    addCount(removed, 'ai', num(db.prepare(AI_READS_DELETE_SQL).run(ids).changes));
    addCount(removed, 'ai', num(db.prepare(AI_OUTCOMES_DELETE_SQL).run(ids).changes));
    addCount(removed, 'ai', num(db.prepare(AI_ACTIONS_DELETE_SQL).run(ids).changes));
    addCount(removed, 'workflow', num(db.prepare(LINKS_DELETE_SQL).run(ids).changes));
    db.prepare(SANCTIONS_UNLINK_SQL).run(ids);
    db.prepare(APPEALS_UNLINK_SQL).run(ids);
    addCount(removed, 'reports_about', num(db.prepare(REPORTS_DELETE_SQL).run(ids).changes));
  }

  // The person's name inside the decisions of the reports that stay (a decision can sanction anyone in its report: a speaker, the reporter): the entries for the set go,
  // unless their sanction group stays. A held report's decision is never touched. An answer that cannot be read and names the person is blanked.
  for (const d of db.prepare(DECISIONS_NAMING_SQL).all(held, setJ)) {
    const next = redactDecision(String(d.result_json), setSet, keepGroups);
    if (next !== null) db.prepare(DECISION_RESULT_SET_SQL).run(next, String(d.key));
  }

  // The person's name inside the other reports that stay: a reporter becomes `erased:<id>`, a line becomes a marker.
  const scrubbed: string[] = [];
  const readsGone: string[] = [];
  for (const r of db.prepare(REPORTS_NAMING_SQL).all(held, setJ, setJ)) {
    const id = String(r.id);
    const asReporter = setSet.has(String(r.reporter_subject));
    const people = parseJson<string[]>(r.people_json, []);
    const lines = scrubExcerpt(people, parseJson<ReportExcerptLine[]>(r.excerpt_json, []), setSet);
    db.prepare(REPORT_SCRUB_SQL).run(
      asReporter ? erasedReporter(id) : String(r.reporter_subject),
      asReporter ? '' : String(r.reporter_seat ?? ''),
      asReporter ? '' : String(r.reporter_handle ?? ''),
      asReporter ? 1 : 0,
      JSON.stringify(lines?.excerpt ?? parseJson<unknown[]>(r.excerpt_json, [])),
      JSON.stringify(lines?.people ?? people),
      id,
    );
    if (asReporter) addCount(removed, 'reports_filed', 1);
    else addCount(removed, 'report_lines', 1);
    if (lines !== null) scrubbed.push(id);
    // The AI's summary of a report can quote a line or the reporter's note (cleared above): the read goes with either.
    if (lines !== null || asReporter) readsGone.push(id);
  }
  // A staff comment on a report that stays can quote the person: its text goes too (who wrote it and when stay: staff rows). The report itself is only scrubbed, so this counts under `workflow`.
  if (readsGone.length > 0) addCount(removed, 'workflow', num(db.prepare(COMMENTS_SCRUB_SQL).run(ERASED_LINE, j(readsGone), ERASED_LINE).changes));
  if (readsGone.length > 0) addCount(removed, 'ai', num(db.prepare(AI_READS_DELETE_SQL).run(j(readsGone)).changes));
  // A stored example holds the lines: it goes with a line of the person.
  if (scrubbed.length > 0) addCount(removed, 'ai', num(db.prepare(AI_OUTCOME_EXAMPLES_CLEAR_SQL).run(j(scrubbed)).changes));

  if (goneGroups.length > 0) {
    const gone = j(goneGroups);
    addCount(removed, 'sanctions', num(db.prepare(SANCTIONS_DELETE_SQL).run(gone).changes));
    // What names a deleted group: the replay answer of a webhook that applied it, and the EOS link that pushed it.
    db.prepare(WEBHOOK_KEYS_BLANK_SQL).run(gone);
    addCount(removed, 'workflow', num(db.prepare(EOS_LINKS_DELETE_SQL).run(gone).changes));
  }
  addCount(removed, 'notices', num(db.prepare(NOTICES_DELETE_SQL).run(setJ, j(keepGroups)).changes));
  if (clearGroups.length > 0) addCount(removed, 'notices', num(db.prepare(NOTICES_CLEAR_SQL).run(setJ, j(clearGroups)).changes));
  addCount(removed, 'strikes', num(db.prepare(STRIKES_DELETE_SQL).run(setJ).changes));
  addCount(removed, 'mutes', num(db.prepare(MUTES_DELETE_SQL).run(setJ, setJ).changes));
  addCount(removed, 'blocked_names', num(db.prepare(BLOCKED_NAMES_DELETE_SQL).run(setJ).changes));
  addCount(removed, 'appeals', num(db.prepare(APPEALS_DELETE_SQL).run(setJ, j(heldGroups)).changes));
  addCount(removed, 'signals', num(db.prepare(SIGNALS_DELETE_SQL).run(setJ, setJ).changes));
  addCount(removed, 'ai', num(db.prepare(NOAUTO_DELETE_SQL).run(setJ).changes));
  addCount(removed, 'workflow', num(db.prepare(CLAIMS_DELETE_SQL).run(setJ).changes));
  addCount(removed, 'workflow', num(db.prepare(THREADS_DELETE_SQL).run(setJ).changes));

  let pending: string | null = null;
  if (keepIdentifiers) {
    pending = plan.subjects.find((s) => setSet.has(s)) ?? set[0] ?? null;
  } else {
    addCount(removed, 'audit', num(db.prepare(AUDIT_REWRITE_SQL).run(plan.receiptId, setJ).changes));
    addCount(removed, 'identifiers', num(db.prepare(IDENTIFIERS_DELETE_SQL).run(setJ).changes));
    addCount(removed, 'subjects', num(db.prepare(SUBJECTS_DELETE_SQL).run(setJ).changes));
  }
  db.prepare(EPOCH_BUMP_SQL).run(EPOCH_KEY);
  // The queue shows fewer reports and appeals: the change token moves with the erase (a dry run is rolled back with everything else).
  bump();
  return { found: true, removed, kept: { identifiers: keepIdentifiers, sanctions: keptSanctionRows, heldReports: heldNaming }, pending, closure: set };
}

/** `eraseSubjects` for the SQLite store: `transaction` is the store's own (a savepoint), so everything here commits together or not at all. */
export function eraseSubjects(db: DatabaseSync, transaction: <T>(fn: () => T) => T, plan: ErasePlan, bump: () => void): ErasureCounts {
  const set = transaction(() => closure(db, plan.subjects));
  if (set.length === 0) return { found: false, removed: {}, kept: { identifiers: false, sanctions: 0, heldReports: 0 }, pending: null, closure: [] };
  if (plan.dryRun !== true) return transaction(() => eraseInTransaction(db, plan, set, bump));
  try {
    transaction(() => {
      throw new DryRunRollback(eraseInTransaction(db, plan, set, bump));
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.counts;
    throw err;
  }
  throw new Error('unreachable');
}

export function insertErasure(db: DatabaseSync, row: ErasureRow): void {
  db.prepare(ERASURE_INSERT_SQL).run(row.id, row.at, row.mode, row.actor, JSON.stringify({ removed: row.removed, kept: row.kept }), row.pendingSubject);
}

export function loadPendingErasures(db: DatabaseSync): ErasureRow[] {
  return db.prepare(ERASURES_PENDING_SQL).all().map((r) => {
    const counts = parseJson<{ removed?: ErasureRemoved; kept?: ErasureRow['kept'] }>(r.counts_json, {});
    return {
      id: String(r.id),
      at: num(r.at),
      mode: String(r.mode) as ErasureRow['mode'],
      actor: String(r.actor),
      removed: counts.removed ?? {},
      kept: counts.kept ?? { identifiers: false, sanctions: 0, heldReports: 0 },
      pendingSubject: r.pending_subject === null ? null : String(r.pending_subject),
    };
  });
}

export function finishErasure(db: DatabaseSync, transaction: <T>(fn: () => T) => T, id: string, at: number, bump: () => void): boolean {
  return transaction(() => {
    const row = db.prepare(ERASURE_ONE_SQL).get(id);
    if (row === undefined || row.pending_subject === null) return false;
    const pending = String(row.pending_subject);
    const set = closure(db, [pending]);
    if (set.length > 0 && db.prepare(SANCTION_ROWS_LEFT_SQL).get(j(set), at) !== undefined) return false;
    // The remainder ends the way a `none` erase does: whatever still names the person (a kept notice, a row written since) goes with the subject, and the audit
    // refs read the receipt. That erase moves the epoch; with nothing left to erase the finish moves it itself.
    if (set.length > 0) eraseInTransaction(db, { subjects: [pending], mode: 'none', heldReportIds: new Set(), receiptId: id, at: 0 }, set, bump);
    else db.prepare(EPOCH_BUMP_SQL).run(EPOCH_KEY);
    db.prepare(ERASURE_CLEAR_SQL).run(id);
    return true;
  });
}

/** Delete the stray rows (see the statements above). With `only`, exactly those subjects at any age; otherwise rows before `before`. Returns how many. */
export function purgeStrayRows(db: DatabaseSync, transaction: <T>(fn: () => T) => T, before: number, only: readonly string[] | undefined): number {
  return transaction(() => {
    let n = 0;
    if (only !== undefined) {
      if (only.length === 0) return 0;
      for (const sql of Object.values(STRAY_ONLY_SQL)) n += Number(db.prepare(sql).run(j(only)).changes);
    } else {
      for (const sql of Object.values(STRAY_BEFORE_SQL)) n += Number(db.prepare(sql).run(before).changes);
    }
    return n;
  });
}

export function erasureEpoch(db: DatabaseSync): number {
  const r = db.prepare(EPOCH_READ_SQL).get(EPOCH_KEY);
  return r === undefined ? 0 : num(r.value);
}

export function exportSubjects(db: DatabaseSync, transaction: <T>(fn: () => T) => T, subjects: readonly string[]): SubjectExport {
  return transaction(() => {
    const set = closure(db, subjects);
    const empty: SubjectExport = {
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
      truncated: [],
    };
    if (set.length === 0) return empty;
    const setJ = j(set);
    const setSet = new Set(set);
    const cap = EXPORT_SECTION_MAX + 1;
    const truncated: string[] = [];
    const section = <T>(name: string, sql: string, map: (r: Record<string, unknown>) => T): T[] => {
      const rows = db.prepare(sql).all(setJ, cap);
      if (rows.length > EXPORT_SECTION_MAX) truncated.push(name);
      return rows.slice(0, EXPORT_SECTION_MAX).map(map);
    };
    const holds = num(db.prepare(EXPORT_HOLDS_SQL).get(setJ, setJ)?.n);
    const head = db.prepare(EXPORT_SUBJECTS_SQL).get(setJ);
    const ids = db.prepare(EXPORT_IDENTIFIERS_SQL).get(setJ);
    const mutes = db.prepare(EXPORT_MUTES_SQL).get(setJ, setJ, setJ, setJ);
    const noauto = db.prepare(EXPORT_NOAUTO_SQL).get(setJ);
    const outcomes = db.prepare(EXPORT_AI_OUTCOMES_SQL).all(setJ, cap);
    if (outcomes.length > EXPORT_SECTION_MAX) truncated.push('ai');
    return {
      found: true,
      createdAt: head?.created === null || head?.created === undefined ? null : num(head.created),
      aliases: num(head?.n),
      accounts: column(db, EXPORT_ACCOUNTS_SQL, setJ),
      identifiers: {
        keys: num(ids?.keys),
        addresses: num(ids?.addresses),
        firstSeen: ids?.first === null || ids?.first === undefined ? null : num(ids.first),
        lastSeen: ids?.last === null || ids?.last === undefined ? null : num(ids.last),
      },
      sanctions: section('sanctions', EXPORT_SANCTIONS_SQL, (r) => ({
        kind: String(r.kind),
        rule: r.rule === null ? null : String(r.rule),
        reason: String(r.reason),
        startsAt: num(r.starts_at),
        endsAt: r.ends_at === null ? null : num(r.ends_at),
        refCode: String(r.ref_code),
        source: String(r.source),
        revoked: r.revoked_at !== null,
        byStaff: true as const,
      })),
      notices: section('notices', EXPORT_NOTICES_SQL, (r) => ({
        kind: String(r.kind),
        rule: r.rule === null ? null : String(r.rule),
        until: r.until === null ? null : num(r.until),
        createdAt: num(r.created_at),
        excerpt: parseJson<Array<{ text: string; day: string }>>(r.excerpt_json, []),
      })),
      reportsFiled: section('reportsFiled', EXPORT_FILED_SQL, (r) => ({
        createdAt: num(r.created_at),
        reason: r.reported_reason === null ? null : String(r.reported_reason),
        category: String(r.category),
        note: r.note === null ? null : String(r.note),
        tags: parseJson<Record<string, string>>(r.tags_json, {}),
      })),
      reportsAbout: section('reportsAbout', EXPORT_ABOUT_SQL, (r) => {
        const people = parseJson<string[]>(r.people_json, []);
        const lines = parseJson<ReportExcerptLine[]>(r.excerpt_json, []);
        return {
          createdAt: num(r.created_at),
          category: String(r.category),
          reason: r.reported_reason === null ? null : String(r.reported_reason),
          status: String(r.status),
          outcome: String(r.status) === 'open' ? null : String(r.status),
          origin: r.origin === null ? null : String(r.origin),
          lines: lines.filter((l) => l.p !== null && setSet.has(people[l.p] ?? '')).map((l) => ({ ts: l.ts, text: l.raw })),
        };
      }),
      strikes: section('strikes', EXPORT_STRIKES_SQL, (r) => ({ at: num(r.at), roomId: String(r.room_id), line: String(r.raw_line) })),
      blockedNames: section('blockedNames', EXPORT_NAMES_SQL, (r) => ({ at: num(r.at), name: String(r.name), reason: String(r.reason) })),
      appeals: section('appeals', EXPORT_APPEALS_SQL, (r) => ({
        createdAt: num(r.created_at),
        kind: String(r.kind),
        rule: r.rule === null ? null : String(r.rule),
        status: String(r.status),
        statement: r.statement === null ? null : String(r.statement),
        decidedAt: r.decided_at === null ? null : num(r.decided_at),
      })),
      signals: section('signals', EXPORT_SIGNALS_SQL, (r) => ({ at: num(r.at), kind: String(r.kind) })),
      mutes: { placed: num(mutes?.placed), received: num(mutes?.received) },
      ai: {
        noAutomation: noauto === undefined ? null : String(noauto.code),
        reads: num(db.prepare(EXPORT_AI_READS_SQL).get(setJ)?.n),
        outcomes: outcomes.slice(0, EXPORT_SECTION_MAX).map((r) => ({ verdict: String(r.verdict), agreement: String(r.agreement) })),
      },
      audit: section('audit', EXPORT_AUDIT_SQL, (r) => ({ at: num(r.at), action: String(r.action) })),
      holds: { reports: holds },
      workflow: { comments: num(db.prepare(EXPORT_COMMENTS_SQL).get(setJ, setJ, setJ)?.n) },
      truncated,
    };
  });
}
