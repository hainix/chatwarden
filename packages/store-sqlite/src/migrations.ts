/** One schema step. `sql` may hold several statements and runs in one transaction. */
export interface Migration {
  /** Positive integer, strictly increasing through the list. */
  version: number;
  sql: string;
}

/**
 * The kit's schema, in order. Append only: never edit or reorder a shipped
 * entry. Migration 1 is subjects, migration 2 is terms and the audit trail, migration 3 is sanctions, migration 4 is lasting mutes, migration 5 is slur strikes, migration 6 is reports, migration 7 widens the sanction kinds (Warning) and adds the rule-gap columns, migration 8 is player notices, migration 9 is recorded decisions, migration 10 adds the bad-faith evidence column, migration 11 widens the sanction kinds again (Note) and adds the room column, migration 12 gives the audit trail a role column and an index on time, migration 13 is the incoming-webhook idempotency keys, migration 14 is the Discord feed's thread map, migration 15 is soft claims on a person's case and saved decision reasons. All tables are prefixed `kit_`.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE kit_subjects (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  merged_into TEXT REFERENCES kit_subjects(id)
);
CREATE TABLE kit_subject_ids (
  subject_id TEXT NOT NULL REFERENCES kit_subjects(id),
  kind       TEXT NOT NULL CHECK (kind IN ('account', 'key', 'ip')),
  value      TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (subject_id, kind, value)
);
CREATE INDEX kit_subject_ids_by_value ON kit_subject_ids (kind, value);
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE kit_terms (
  id         TEXT PRIMARY KEY,
  term       TEXT NOT NULL,
  language   TEXT NOT NULL,
  active     INTEGER NOT NULL CHECK (active IN (0, 1)),
  note       TEXT,
  added_by   TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER
);
CREATE TABLE kit_term_exceptions (
  id         TEXT PRIMARY KEY,
  phrase     TEXT NOT NULL,
  language   TEXT NOT NULL,
  active     INTEGER NOT NULL CHECK (active IN (0, 1)),
  note       TEXT,
  added_by   TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER
);
CREATE TABLE kit_audit (
  id           TEXT PRIMARY KEY,
  at           INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_ref  TEXT NOT NULL,
  before_json  TEXT,
  after_json   TEXT
);
CREATE INDEX kit_audit_by_subject ON kit_audit (subject_type, subject_ref, at);
`,
  },
  {
    version: 3,
    // One sanction is a GROUP of rows (a subject row, plus at most one IP row) sharing group_id and
    // ref_code. `kind` is checked in ONE place, the CHECK below: a later migration that adds a kind
    // (K2's 'warning') rebuilds the table with the wider list. The unique index is partial so the
    // group's subject row alone must be unique; the IP row repeats its group's code.
    sql: `
CREATE TABLE kit_sanctions (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL,
  ref_code      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('chat', 'area', 'ban')),
  target_type   TEXT NOT NULL CHECK (target_type IN ('subject', 'ip')),
  target_value  TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,
  ends_at       INTEGER,
  reason        TEXT NOT NULL,
  rule          TEXT,
  actor         TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('moderator', 'auto_filter', 'coop', 'api', 'ai')),
  automated     INTEGER NOT NULL CHECK (automated IN (0, 1)),
  pending       INTEGER NOT NULL CHECK (pending IN (0, 1)),
  revoked_by    TEXT,
  revoked_at    INTEGER,
  revoke_reason TEXT
);
CREATE UNIQUE INDEX kit_sanctions_ref_code ON kit_sanctions (ref_code) WHERE target_type = 'subject';
CREATE INDEX kit_sanctions_by_group ON kit_sanctions (group_id);
CREATE INDEX kit_sanctions_by_target ON kit_sanctions (target_type, target_value);
`,
  },
  {
    version: 4,
    // A mute is (viewer, target) subject ids exactly as the caller gave them; the service compares through
    // the canonical subject, so there is no foreign key (a merge must not orphan a mute, and subject rows are
    // written in the background). The primary key makes a repeat mute an upsert. It keeps the implicit rowid,
    // which breaks created_at ties when the cap drops the oldest.
    sql: `
CREATE TABLE kit_mutes (
  viewer_id  TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (viewer_id, target_id)
);
CREATE INDEX kit_mutes_by_created ON kit_mutes (created_at);
`,
  },
  {
    version: 5,
    // One row per blocked slur attempt, filed under the canonical subject at write time (a later merge is
    // resolved by the service, so there is no foreign key). There is no IP, key or account column on purpose:
    // a strike is never keyed or counted by IP. raw_line is the line the subject typed themselves, kept for
    // K2's automatic-timeout notice; Task 13's retention purge deletes rows after 30 days.
    sql: `
CREATE TABLE kit_strikes (
  id         TEXT PRIMARY KEY,
  at         INTEGER NOT NULL,
  subject_id TEXT NOT NULL,
  room_id    TEXT NOT NULL,
  term_id    TEXT NOT NULL,
  raw_line   TEXT NOT NULL
);
CREATE INDEX kit_strikes_by_subject ON kit_strikes (subject_id, at);
`,
  },
  {
    version: 6,
    // One row per report. reporter_subject and target_subject are the CANONICAL subject ids at submit time (a
    // later merge is resolved in code, so there is no foreign key); the UNIQUE constraint is the backstop for
    // "one report per reporter, target and room", while the service checks across merged aliases. excerpt_json
    // holds the evidence lines with no identity in them; people_json lists the canonical subjects who wrote
    // them (the lines point into it by index). status, bad_faith and the actioned_* / mod_note columns are
    // written by K2's moderator tools; intake only reads bad_faith + actioned_at to suspend a reporter.
    sql: `
CREATE TABLE kit_reports (
  id               TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,
  room_id          TEXT NOT NULL,
  tags_json        TEXT NOT NULL,
  reporter_subject TEXT NOT NULL,
  reporter_seat    TEXT NOT NULL,
  reporter_handle  TEXT NOT NULL,
  target_subject   TEXT NOT NULL,
  target_seat      TEXT NOT NULL,
  target_handle    TEXT NOT NULL,
  category         TEXT NOT NULL,
  note             TEXT,
  line_id          TEXT,
  excerpt_json     TEXT NOT NULL,
  people_json      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  bad_faith        INTEGER NOT NULL DEFAULT 0 CHECK (bad_faith IN (0, 1)),
  actioned_at      INTEGER,
  actioned_by      TEXT,
  mod_note         TEXT,
  UNIQUE (reporter_subject, target_subject, room_id)
);
CREATE INDEX kit_reports_by_target ON kit_reports (target_subject, created_at);
CREATE INDEX kit_reports_by_reporter ON kit_reports (reporter_subject, created_at);
CREATE INDEX kit_reports_by_status ON kit_reports (status, created_at);
CREATE INDEX kit_reports_by_room ON kit_reports (room_id);
CREATE INDEX kit_reports_by_created ON kit_reports (created_at);
CREATE INDEX kit_reports_bad_faith ON kit_reports (actioned_at)
  WHERE bad_faith = 1;
`,
  },
  {
    version: 7,
    // SQLite cannot ALTER a CHECK, so the Warning kind needs the table rebuilt: create the new shape, copy every
    // row in rowid order (loadSanctions orders by rowid), drop the old table (which drops its indexes), rename, and
    // recreate every index, the partial unique ref_code one included. Nothing references kit_sanctions, so no
    // foreign key is in play. The runner wraps this in one savepoint with the version bump: a failure anywhere
    // leaves the old table, its rows and version 6 untouched. The kind list below and SANCTION_KINDS in core must
    // match (a test compares them). gap_note / gap_status / gap_ref belong to the subject row of a group: a moderator
    // sanction under 'uncovered' carries a note, and a later decision closes the gap as 'ruled' (gap_ref is the new
    // rule number) or 'not_a_rule'. Rows written before this migration keep a NULL rule and no gap.
    sql: `
CREATE TABLE kit_sanctions_v7 (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL,
  ref_code      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('chat', 'area', 'ban', 'warning')),
  target_type   TEXT NOT NULL CHECK (target_type IN ('subject', 'ip')),
  target_value  TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,
  ends_at       INTEGER,
  reason        TEXT NOT NULL,
  rule          TEXT,
  actor         TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('moderator', 'auto_filter', 'coop', 'api', 'ai')),
  automated     INTEGER NOT NULL CHECK (automated IN (0, 1)),
  pending       INTEGER NOT NULL CHECK (pending IN (0, 1)),
  revoked_by    TEXT,
  revoked_at    INTEGER,
  revoke_reason TEXT,
  gap_note      TEXT,
  gap_status    TEXT CHECK (gap_status IN ('open', 'ruled', 'not_a_rule')),
  gap_ref       TEXT
);
INSERT INTO kit_sanctions_v7
  (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source,
   automated, pending, revoked_by, revoked_at, revoke_reason)
  SELECT id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source,
         automated, pending, revoked_by, revoked_at, revoke_reason
  FROM kit_sanctions ORDER BY rowid;
DROP TABLE kit_sanctions;
ALTER TABLE kit_sanctions_v7 RENAME TO kit_sanctions;
CREATE UNIQUE INDEX kit_sanctions_ref_code ON kit_sanctions (ref_code) WHERE target_type = 'subject';
CREATE INDEX kit_sanctions_by_group ON kit_sanctions (group_id);
CREATE INDEX kit_sanctions_by_target ON kit_sanctions (target_type, target_value);
`,
  },
  {
    version: 8,
    // A player notice: what one person is shown about a sanction taken against them (group_id), or about a report
    // they filed (report_outcome, no group). subject_id is the canonical subject at write time and is resolved
    // through merges by the service, so there is no foreign key. excerpt_json holds the player-safe lines only
    // ({text, day}, own lines, blocked terms already masked): never the raw line. Ids are random. acked_at is
    // when the player saw it; withdrawn_at when its sanction was revoked.
    sql: `
CREATE TABLE kit_notices (
  id           TEXT PRIMARY KEY,
  subject_id   TEXT NOT NULL,
  group_id     TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('warning', 'chat', 'area', 'ban', 'report_outcome')),
  rule         TEXT,
  until        INTEGER,
  ref_code     TEXT,
  excerpt_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  acked_at     INTEGER,
  withdrawn_at INTEGER
);
CREATE INDEX kit_notices_by_subject ON kit_notices (subject_id, acked_at, withdrawn_at);
CREATE INDEX kit_notices_by_group ON kit_notices (group_id);
CREATE INDEX kit_notices_by_created ON kit_notices (created_at);
`,
  },
  {
    version: 9,
    // One row per recorded moderator decision. key is a SHA-256 over the report id, the verdict and the sorted
    // actions (canonical subjects), so the same decision sent again is found here and replayed instead of applied
    // twice. result_json is what the first call answered (group ids, ref codes, notice ids). report_id has no
    // foreign key: the retention purge deletes the decisions of the reports it deletes.
    sql: `
CREATE TABLE kit_decisions (
  key         TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL,
  at          INTEGER NOT NULL,
  result_json TEXT NOT NULL
);
CREATE INDEX kit_decisions_by_report ON kit_decisions (report_id);
`,
  },
  {
    version: 10,
    // The moderator's written evidence for a bad_faith dismissal (1..500 characters, checked by the decision
    // service). Staff only: nothing player-facing reads it. NULL on every other report, including every report
    // written before this migration. Adding a nullable column keeps every row.
    sql: `
ALTER TABLE kit_reports ADD COLUMN bad_faith_evidence TEXT;
`,
  },
  {
    version: 11,
    // Two changes to kit_sanctions in ONE rebuild, because SQLite cannot ALTER a CHECK: the kind list gains 'note' (the
    // Note outcome, stored like a warning) and a nullable room_id TEXT is added (the room the decided report came from;
    // NULL on every row written before this migration, on automatic timeouts and on a direct sanction that names none).
    // It follows migration 7's pattern exactly: create the new shape, copy EVERY column of every row in rowid order
    // (gap_ref and the revoke columns included), drop the old table (which drops its indexes), rename, and recreate
    // every index, the partial unique ref_code one included. Nothing references kit_sanctions. The runner wraps this in
    // one savepoint with the version bump: a failure anywhere leaves the old table, its rows and version 10 untouched.
    // The kind list below and SANCTION_KINDS in core must match (a test compares them).
    sql: `
CREATE TABLE kit_sanctions_v11 (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL,
  ref_code      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('chat', 'area', 'ban', 'warning', 'note')),
  target_type   TEXT NOT NULL CHECK (target_type IN ('subject', 'ip')),
  target_value  TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,
  ends_at       INTEGER,
  reason        TEXT NOT NULL,
  rule          TEXT,
  actor         TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('moderator', 'auto_filter', 'coop', 'api', 'ai')),
  automated     INTEGER NOT NULL CHECK (automated IN (0, 1)),
  pending       INTEGER NOT NULL CHECK (pending IN (0, 1)),
  revoked_by    TEXT,
  revoked_at    INTEGER,
  revoke_reason TEXT,
  gap_note      TEXT,
  gap_status    TEXT CHECK (gap_status IN ('open', 'ruled', 'not_a_rule')),
  gap_ref       TEXT,
  room_id       TEXT
);
INSERT INTO kit_sanctions_v11
  (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source,
   automated, pending, revoked_by, revoked_at, revoke_reason, gap_note, gap_status, gap_ref)
  SELECT id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source,
         automated, pending, revoked_by, revoked_at, revoke_reason, gap_note, gap_status, gap_ref
  FROM kit_sanctions ORDER BY rowid;
DROP TABLE kit_sanctions;
ALTER TABLE kit_sanctions_v11 RENAME TO kit_sanctions;
CREATE UNIQUE INDEX kit_sanctions_ref_code ON kit_sanctions (ref_code) WHERE target_type = 'subject';
CREATE INDEX kit_sanctions_by_group ON kit_sanctions (group_id);
CREATE INDEX kit_sanctions_by_target ON kit_sanctions (target_type, target_value);
`,
  },
  {
    version: 12,
    // The staff audit trail (K3b): `kit_audit` gains the actor's role (NULL on every row written before roles existed)
    // and an index on (at, id) for newest-first paging. Existing rows, and their json columns, are untouched. A new
    // entry writes NULL to both json columns and '' to subject_type / subject_ref when it has no target.
    sql: `
ALTER TABLE kit_audit ADD COLUMN role TEXT CHECK (role IN ('moderator', 'senior', 'owner'));
CREATE INDEX kit_audit_by_at ON kit_audit (at, id);
`,
  },
  {
    version: 13,
    // Incoming-webhook idempotency keys (K3b): `key` is the sender's idempotencyKey, `state` is `pending` while the
    // action is being applied and `done` once it has answered, and `result_json` holds the response body only (ids and
    // ref codes, never chat text). A `pending` row has no result and a `done` row always has one. `fingerprint` is the SHA-256 of
    // the canonical validated request, so a key reused for a different request is refused. Purged after 24 h.
    sql: `
CREATE TABLE kit_webhook_keys (
  key         TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  result_json TEXT,
  fingerprint TEXT NOT NULL,
  CHECK ((state = 'pending' AND result_json IS NULL) OR (state = 'done' AND result_json IS NOT NULL))
);
CREATE INDEX kit_webhook_keys_by_created ON kit_webhook_keys (created_at);
`,
  },
  {
    version: 14,
    // The Discord review feed's thread map (K3b): one forum thread per person. `subject` is a canonical subject id (or a
    // reserved shared-thread key), `label` the random neutral name the thread was created with. No chat text, no handle.
    // Rows hold subject ids (staff-only) and are not removed by `purge()`: a future subject purge must clear this table too.
    sql: `
CREATE TABLE kit_discord_threads (
  subject    TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  },
  {
    version: 15,
    // The team workbench (K4): a soft claim per person (`person` is the canonical subject id the staff refs show, so a
    // merge is resolved in code and there is no foreign key) and the saved decision reasons. A claim is live while
    // `until` is in the future; an expired row is replaced by the next claim, never swept or purged by retention: like
    // kit_discord_threads, a future subject erasure must clear it. `claimed_by` is a staff actor.
    // Nothing here holds chat text, and it is staff-only. The change token needs no table: it is a counter in kit_meta
    // that the write methods move.
    sql: `
CREATE TABLE kit_claims (
  person     TEXT PRIMARY KEY,
  claimed_by TEXT NOT NULL,
  since      INTEGER NOT NULL,
  until      INTEGER NOT NULL
);
CREATE TABLE kit_reasons (
  id     TEXT PRIMARY KEY,
  label  TEXT NOT NULL,
  text   TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1))
);
`,
  },
];
