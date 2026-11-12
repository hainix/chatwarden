/** One schema step. `sql` may hold several statements and runs in one transaction. */
export interface Migration {
  /** Positive integer, strictly increasing through the list. */
  version: number;
  sql: string;
}

/**
 * The kit's schema, in order. Append only: never edit or reorder a shipped
 * entry. Migration 1 is subjects, migration 2 is terms and the audit trail, migration 3 is sanctions, migration 4 is lasting mutes, migration 5 is slur strikes, migration 6 is reports, migration 7 widens the sanction kinds (Warning) and adds the rule-gap columns, migration 8 is player notices, migration 9 is recorded decisions, migration 10 adds the bad-faith evidence column, migration 11 widens the sanction kinds again (Note) and adds the room column, migration 12 gives the audit trail a role column and an index on time, migration 13 is the incoming-webhook idempotency keys, migration 14 is the Discord feed's thread map, migration 15 is soft claims on a person's case and saved decision reasons, migration 16 is the editable profile's stored layer and the audit trail's detail column, migration 17 is the reason a reporter gave and the time of their one follow-up, migration 18 is the indexes for reading sanctions by start time and strikes by time. All tables are prefixed `kit_`.
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
  {
    version: 16,
    // The editable moderation profile (K4 Task 7f). `kit_policy_layer` holds at most one row: the owner's stored edits as JSON
    // (`layer_json`, a validated PolicyLayer: durations, ladder, first offences, repeat rule, rule lists, guideline outcome
    // texts; never chat text) and its `version`, which the conditional write in `savePolicyLayer` compares and bumps. No row means
    // version 0 and no layer. `kit_audit` gains `detail_json`: NULL on every existing row and on every row but a policy.update /
    // policy.reset one, where it holds the sections changed and the owner's reason. Existing rows and tables are untouched.
    sql: `
CREATE TABLE kit_policy_layer (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  layer_json TEXT NOT NULL,
  version    INTEGER NOT NULL CHECK (version >= 1)
);
ALTER TABLE kit_audit ADD COLUMN detail_json TEXT;
`,
  },
  {
    version: 17,
    // The reporting settings (K4 Task 7h). `reported_reason` is the reason id the reporter gave (a hint: the case is settled by the
    // decision), NULL when they gave none; `detail_at` is when the reporter added their one follow-up, NULL until then. Both are
    // nullable columns added in place (no table rebuild), and `category` (NOT NULL) is kept and still written, so every reader of it keeps working.
    // The backfill is one UPDATE inside the same savepoint, so it touches every existing row once (fine at kit scale). Rows filed before this migration carry their old category as their reason: the six 0.1.1 categories are reason ids, with
    // `disruption` read as `griefing`; a category that is none of the six (a hand edit) stays NULL rather than being guessed. The
    // runner wraps this in one savepoint with the version bump, so a failure leaves version 16 and no column.
    sql: `
ALTER TABLE kit_reports ADD COLUMN reported_reason TEXT;
ALTER TABLE kit_reports ADD COLUMN detail_at INTEGER;
UPDATE kit_reports
  SET reported_reason = CASE category WHEN 'disruption' THEN 'griefing' ELSE category END
  WHERE category IN ('harassment', 'hate', 'cheating', 'spam', 'disruption', 'other');
CREATE INDEX kit_reports_by_reason ON kit_reports (reported_reason, created_at);
`,
  },
  {
    version: 18,
    // Indexes only (0.1.3): no table, column or row changes. Until now every read of "sanctions since a time" or "strikes since a time"
    // scanned the table (sanctions: the whole target_type slice, then a sort). Both indexes are plain, so a rerun on a database that
    // already has them is prevented by the version bump alone; the runner wraps this in one savepoint with that bump.
    //   kit_sanctions_by_start (target_type, starts_at, id) serves loadSubjectActions and loadAutoChatGroups (`target_type = 'subject'
    //     AND starts_at >= ?`) and listSubjectSanctions (`target_type = 'subject'`, optional `starts_at` range or keyset cursor, then
    //     `ORDER BY starts_at DESC, id DESC`): the equality column first, the range and the sort next, and `id` last so the
    //     descending walk needs no sort step.
    //   kit_strikes_by_at (at) serves loadStrikes (`at >= ? ORDER BY at, rowid`; the rowid is the index's own tie-break, so no sort),
    //     listStrikes, countStrikesByTerm and the retention purge (`at < ?`).
    sql: `
CREATE INDEX kit_sanctions_by_start ON kit_sanctions (target_type, starts_at, id);
CREATE INDEX kit_strikes_by_at ON kit_strikes (at);
`,
  },
  {
    version: 19,
    // One index, no table, column or row change (0.1.5), like 17 and 18. Reporter accuracy asks, for a page of reporters, how their
    // recent reports turned out: `WHERE reporter_subject IN (...) AND created_at >= ? AND status != 'open' GROUP BY reporter_subject`.
    // The older `kit_reports_by_reporter (reporter_subject, created_at)` finds the rows, but every row then needs a table read for
    // `status` and `bad_faith`; a queue page asks for up to 200 reporters x up to ~300 rows each. With the two extra columns the
    // grouped query is answered from the index alone (a covering index), and "open reports by reporter" reads `status` from the index
    // before it touches the table. The older index is now a prefix of the new one; it is kept in this patch (dropping is parked). A
    // plain index, so a rerun is prevented by the version bump alone; the runner wraps this in one savepoint with that bump.
    sql: `
CREATE INDEX kit_reports_by_reporter_outcome ON kit_reports (reporter_subject, created_at, status, bad_faith);
`,
  },
  {
    version: 20,
    // AI levels 1 and 2 (0.1.7). Three new tables and their indexes; no existing table, column or row is touched, and the runner wraps
    // this in one savepoint with the version bump, so a failure leaves version 19 and no new table.
    //   kit_ai_reads holds one row per (report, input hash): the model's validated read, the usage and cost of the call, and the state
    //     of the call while it runs. `lease_until` makes "I am about to call the model" visible to every process on the database
    //     (a pending row is owned until then); UNIQUE (report_id, input_hash) is the guard that lets exactly one process win.
    //     `retry_at` is when the sweeper may take a failed (or budget-skipped) row again. It holds no chat text but the one-line
    //     `summary` and no identity (no subject, handle, seat or hash of a person). It goes with its report (purgeReports) and is
    //     swept by age as a backstop (purgeAi).
    //       kit_ai_reads_by_report (report_id, created_at): the newest read of a report, and a queue page's reads (loadAiReads).
    //       kit_ai_reads_by_time (created_at): today's spend and the retention sweep.
    //       kit_ai_reads_retry (status, retry_at): the sweeper's "failed and due" and "pending and lapsed" scans.
    //     `attempts` is also the fence of a lease: a take-over adds one, and only the holder of the current number may finish or fail
    //     the row. `example_ids` is a JSON array of the casebook example ids the read saw (they are not part of the input hash).
    //     `retaken` is 1 once a moderator's explicit "read again" has retaken a final row: the one explicit retake is a fact of the row,
    //     so a restart or a second process cannot allow another.
    //   kit_ai_spend is the spend ledger the daily cap reads: one row per (read, attempt) written when the call is reserved, so a retry
    //     that crosses UTC midnight books each attempt to its own day and a later attempt never overwrites an earlier one's cost. Counts
    //     and micro-dollars only; swept with the reads (purgeAi).
    //       kit_ai_spend_by_time (at): today's spend and calls.
    //   kit_ai_outcomes is the casebook: one row per decided report that had an AI read, written in the transaction of the decision.
    //     Ids, counts and the human's final choices, so it keeps for `retention.aiOutcomesMs` (365 days) after the report is gone.
    //     `example_json` (up to 6 pseudonymised lines, aliases only) is the only chat text that outlives a report; it is set to
    //     NULL on its own shorter clock (`retention.aiExamplesMs`, 180 days) and the row stays with its counts.
    //       kit_ai_outcomes_by_rule (rule, decided_at): the examples query and the per-rule stats.
    sql: `
CREATE TABLE kit_ai_reads (
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL,
  input_hash     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'declined', 'invalid', 'failed', 'skipped')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  retry_at       INTEGER,
  lease_until    INTEGER,
  error_kind     TEXT,
  adapter        TEXT,
  model          TEXT,
  prompt_version INTEGER NOT NULL,
  severity       TEXT,
  rule           TEXT,
  summary        TEXT,
  evidence_json  TEXT,
  confidence     TEXT,
  injection      INTEGER NOT NULL DEFAULT 0,
  rec_json       TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_micros    INTEGER NOT NULL DEFAULT 0,
  latency_ms     INTEGER,
  example_ids    TEXT,
  created_at     INTEGER NOT NULL,
  retaken        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (report_id, input_hash)
);
CREATE INDEX kit_ai_reads_by_report ON kit_ai_reads (report_id, created_at);
CREATE INDEX kit_ai_reads_by_time ON kit_ai_reads (created_at);
CREATE INDEX kit_ai_reads_retry ON kit_ai_reads (status, retry_at);

CREATE TABLE kit_ai_spend (
  read_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  micros  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (read_id, attempt)
);
CREATE INDEX kit_ai_spend_by_time ON kit_ai_spend (at);

CREATE TABLE kit_ai_outcomes (
  report_id   TEXT PRIMARY KEY,
  read_id     TEXT,
  decided_at  INTEGER NOT NULL,
  level       INTEGER NOT NULL,
  verdict     TEXT NOT NULL,
  rule        TEXT,
  severity    TEXT,
  ai_verdict  TEXT,
  agreement   TEXT NOT NULL CHECK (agreement IN ('agree', 'override', 'none')),
  detail_json TEXT NOT NULL,
  reversed    INTEGER NOT NULL DEFAULT 0,
  dont_teach  INTEGER NOT NULL DEFAULT 0,
  bad_faith   INTEGER NOT NULL DEFAULT 0,
  example_json TEXT
);
CREATE INDEX kit_ai_outcomes_by_rule ON kit_ai_outcomes (rule, decided_at);
`,
  },
  {
    version: 21,
    // Flood control and signals (0.1.8). One new table with three indexes, and one nullable column on a table migration 20 made; no
    // existing row is touched, and the runner wraps this in one savepoint with the version bump, so a failure leaves version 20, no
    // table and no column.
    //   kit_signals holds one row per signal a game recorded about a player: ids and numbers only, no text, handle or seat.
    //     `source_key` is `b:<canonical by>` (the player who produced it), `r:<roomId>` or `d:<UTC day>` (a source-less signal is
    //     counted per room, or per day without one). `cap_bucket` is floor(at / perByWindowMs) and the UNIQUE index on
    //     (kind, subject_id, source_key, cap_bucket) is the per-source cap: of two processes writing the second row of a bucket exactly
    //     one succeeds, and a script cannot grow the table. `weight` is the effective weight stored at record time (0 or more).
    //       kit_signals_cap (kind, subject_id, source_key, cap_bucket): UNIQUE; the arbiter of `INSERT ... ON CONFLICT DO NOTHING`.
    //       kit_signals_by_subject (subject_id, at): the grouped read for a person and their aliases in a window (listSignalSources).
    //       kit_signals_by_at (at): the retention sweep (`at < ?`).
    //   kit_ai_reads.signals_json is the counts the AI read was shown (label, polarity, distinct and window only), or NULL for a read made
    //     without the signals feed, and for every read that exists now. It needs migration 20; if release order ever changes so that 20 is
    //     not present, this one line moves to a later migration and nothing else here depends on the AI tables.
    sql: `
CREATE TABLE kit_signals (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  source_key  TEXT NOT NULL,
  by_subject  TEXT,
  room_id     TEXT,
  at          INTEGER NOT NULL,
  weight      REAL NOT NULL CHECK (weight >= 0),
  cap_bucket  INTEGER NOT NULL
);
CREATE UNIQUE INDEX kit_signals_cap        ON kit_signals (kind, subject_id, source_key, cap_bucket);
CREATE INDEX        kit_signals_by_subject ON kit_signals (subject_id, at);
CREATE INDEX        kit_signals_by_at      ON kit_signals (at);
ALTER TABLE kit_ai_reads ADD COLUMN signals_json TEXT;
`,
  },
  {
    version: 22,
    // Appeals and offensive names (0.1.9). Two new tables with their indexes, a rebuilt kit_notices, and two nullable or defaulted columns on
    // tables that already exist. The runner wraps this in one savepoint with the version bump, so a failure leaves version 21, the old
    // notices table with its rows and indexes, and no new table or column. It is ONE-WAY: the notices table is rebuilt (SQLite cannot widen
    // a CHECK in place), so a database that has run 22 cannot be opened by 0.1.7 or 0.1.8; the release notes say so, as 0.1.5's did for 19.
    //   kit_appeals holds one row per appeal. `statement` is the one new free text a player writes (at most 1000 characters, enforced
    //     by the service): it is set to NULL on its own shorter clock (`retention.appealStatementsMs`, 90 days after the decision) and the
    //     row stays with its counts for `retention.appealsMs` (365 days). `rule` is the sanction's rule as text, copied at filing so the
    //     per-rule counts need no join. UNIQUE (group_id) is the guard that lets exactly one filing win, for the life of the row: one appeal per sanction.
    //     `status` moves from 'open' only (one conditional UPDATE decides it); 'moot' means the sanction was revoked by someone else, or
    //     retention removed its rows, while the appeal was open.
    //       kit_appeals_by_group (group_id): UNIQUE; the arbiter of `INSERT ... ON CONFLICT DO NOTHING`, and the moot lookup.
    //       kit_appeals_by_subject (subject_id, created_at): the weekly cap (countAppealsBy) for a person and their aliases.
    //       kit_appeals_by_status (status, created_at, id): the open count and the inbox, oldest first, with the keyset cursor.
    //       kit_appeals_by_rule (rule, created_at): the per-rule counts the false-positive rate reads.
    //   kit_sanctions.report_id is the report whose decision made a sanction, so a granted appeal can mark that decision reversed. Set by
    //     `decide` from 0.1.9. The backfill links a moderator sanction row to the decision that holds its group id in `result_json`.
    //     Group ids are random and long, so a false match is not a concern, and at kit scale one UPDATE is the same trade migration 17
    //     made. Rows it cannot link (a direct apply, an automatic timeout, an IP row) keep NULL: an appeal against one still works and
    //     still counts in the rate, and simply cannot mark a casebook row. The UPDATE only touches rows still NULL, so it is idempotent.
    //   kit_notices is rebuilt (as migrations 7 and 11 rebuilt kit_sanctions) to add four kinds to the CHECK: 'rename_required',
    //     'appeal_upheld', 'appeal_reduced', 'appeal_revoked'. The columns and the three indexes are the live ones (migration 8 made them
    //     and no later migration touched them), copied in the same order with ORDER BY rowid, so every id, row and the order of rows
    //     survives. Nothing references kit_notices.
    //   kit_blocked_names keeps a blocked name as evidence, only for a kit with `names.keepBlocked`, on a 30 day clock (`retention.blockedNamesMs`).
    //       kit_blocked_names_by_at (at): the retention sweep and the newest-first list.
    //   kit_ai_outcomes.corrective is 1 for the casebook row of a decision a granted appeal reversed: a corrective example for that
    //     rule. It needs migration 20 (which is always earlier in this list); existing rows read 0.
    sql: `
CREATE TABLE kit_appeals (
  id                   TEXT PRIMARY KEY,
  subject_id           TEXT NOT NULL,
  group_id             TEXT NOT NULL,
  notice_id            TEXT NOT NULL,
  report_id            TEXT,
  rule                 TEXT,
  kind                 TEXT NOT NULL CHECK (kind IN ('warning', 'chat', 'area', 'ban')),
  statement            TEXT,
  status               TEXT NOT NULL CHECK (status IN ('open', 'upheld', 'reduced', 'revoked', 'moot')),
  created_at           INTEGER NOT NULL,
  decided_at           INTEGER,
  decided_by           TEXT,
  decision_reason      TEXT,
  replacement_group_id TEXT
);
CREATE UNIQUE INDEX kit_appeals_by_group   ON kit_appeals (group_id);
CREATE INDEX        kit_appeals_by_subject ON kit_appeals (subject_id, created_at);
CREATE INDEX        kit_appeals_by_status  ON kit_appeals (status, created_at, id);
CREATE INDEX        kit_appeals_by_rule    ON kit_appeals (rule, created_at);

ALTER TABLE kit_sanctions ADD COLUMN report_id TEXT;
UPDATE kit_sanctions SET report_id = (
  SELECT d.report_id FROM kit_decisions d WHERE instr(d.result_json, kit_sanctions.group_id) > 0 LIMIT 1
) WHERE target_type = 'subject' AND source = 'moderator' AND report_id IS NULL;

CREATE TABLE kit_notices_v22 (
  id           TEXT PRIMARY KEY,
  subject_id   TEXT NOT NULL,
  group_id     TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('warning', 'chat', 'area', 'ban', 'report_outcome',
                                             'rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked')),
  rule         TEXT,
  until        INTEGER,
  ref_code     TEXT,
  excerpt_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  acked_at     INTEGER,
  withdrawn_at INTEGER
);
INSERT INTO kit_notices_v22 (id, subject_id, group_id, kind, rule, until, ref_code, excerpt_json, created_at, acked_at, withdrawn_at)
  SELECT id, subject_id, group_id, kind, rule, until, ref_code, excerpt_json, created_at, acked_at, withdrawn_at FROM kit_notices ORDER BY rowid;
DROP TABLE kit_notices;
ALTER TABLE kit_notices_v22 RENAME TO kit_notices;
CREATE INDEX kit_notices_by_subject ON kit_notices (subject_id, acked_at, withdrawn_at);
CREATE INDEX kit_notices_by_group ON kit_notices (group_id);
CREATE INDEX kit_notices_by_created ON kit_notices (created_at);

CREATE TABLE kit_blocked_names (
  id         TEXT PRIMARY KEY,
  subject_id TEXT,
  name       TEXT NOT NULL,
  term_id    TEXT,
  reason     TEXT NOT NULL CHECK (reason IN ('name_not_allowed', 'name_profane')),
  at         INTEGER NOT NULL
);
CREATE INDEX kit_blocked_names_by_at ON kit_blocked_names (at);

ALTER TABLE kit_ai_outcomes ADD COLUMN corrective INTEGER NOT NULL DEFAULT 0;
`,
  },
];
