/** One schema step. `sql` may hold several statements and runs in one transaction. */
export interface Migration {
  /** Positive integer, strictly increasing through the list. */
  version: number;
  sql: string;
}

/**
 * The kit's schema, in order. Append only: never edit or reorder a shipped
 * entry. Migration 1 is subjects, migration 2 is terms and the audit trail, migration 3 is sanctions, migration 4 is lasting mutes, migration 5 is slur strikes. All tables are prefixed `kit_`.
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
];
