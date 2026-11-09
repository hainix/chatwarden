/** One schema step. `sql` may hold several statements and runs in one transaction. */
export interface Migration {
  /** Positive integer, strictly increasing through the list. */
  version: number;
  sql: string;
}

/**
 * The kit's schema, in order. Append only: never edit or reorder a shipped
 * entry. Migration 1 is subjects. All tables are prefixed `kit_`.
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
];
