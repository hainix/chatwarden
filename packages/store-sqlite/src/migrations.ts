/** One schema step. `sql` may hold several statements and runs in one transaction. */
export interface Migration {
  /** Positive integer, strictly increasing through the list. */
  version: number;
  sql: string;
}

/**
 * The kit's schema, in order. Append only: never edit or reorder a shipped
 * entry. Task 4 adds migration 1 (subjects); until then the list is empty and
 * the latest version is 0. All tables are prefixed `kit_`.
 */
export const MIGRATIONS: readonly Migration[] = [];
