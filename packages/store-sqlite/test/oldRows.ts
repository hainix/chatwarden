import type { DatabaseSync } from 'node:sqlite';
import type { SanctionRow, StoredReport } from '@chatwarden/core';

/**
 * A report row written the way the kit wrote it before migration 17: none of the reporting-reason columns. For tests that open a
 * database at an old schema version and need rows in it, which the current `insertReport` (it writes `reported_reason`) cannot do.
 */
export function insertOldReport(db: DatabaseSync, r: StoredReport): void {
  db.prepare(
    `INSERT INTO kit_reports
       (id, created_at, room_id, tags_json, reporter_subject, reporter_seat, reporter_handle, target_subject, target_seat, target_handle,
        category, note, line_id, excerpt_json, people_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id, r.createdAt, r.roomId, JSON.stringify(r.tags), r.reporterSubject, r.reporterSeat, r.reporterHandle, r.targetSubject, r.targetSeat,
    r.targetHandle, r.category, r.note, r.lineId, JSON.stringify(r.excerpt), JSON.stringify(r.people), r.status,
  );
}

/**
 * A sanction row written the way the kit wrote it before migration 22: no `report_id` column. For tests that open a database at an old
 * schema version and need sanctions in it, which the current `insertSanctionGroup` (it writes `report_id`) cannot do.
 */
export function insertOldSanction(db: DatabaseSync, r: SanctionRow): void {
  db.prepare(
    `INSERT INTO kit_sanctions
       (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending,
        gap_note, gap_status, room_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id, r.groupId, r.refCode, r.kind, r.targetType, r.value, r.startsAt, r.endsAt, r.reason, r.rule, r.actor, r.source,
    r.automated ? 1 : 0, r.pending ? 1 : 0, r.gapNote, r.gapStatus, r.roomId,
  );
}
