/** One schema step. `sql` may hold several statements and runs in one transaction. */
export interface Migration {
  /** Positive integer, strictly increasing through the list. */
  version: number;
  sql: string;
}

/**
 * The kit's schema, in order. Append only: never edit or reorder a shipped
 * entry. Migration 1 is subjects, migration 2 is terms and the audit trail. All tables are prefixed `kit_`.
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
];
