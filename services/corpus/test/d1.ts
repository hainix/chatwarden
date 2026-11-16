import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { returnsRows } from '../src/tools/rows.js';
import type { D1Like, D1Result, D1Statement } from '../src/env.js';

// A D1-shaped adapter over node:sqlite, so every test runs the real SQL with no Cloudflare account. It follows D1 where D1 differs from
// node:sqlite: statements are prepared lazily (a bad statement fails when it runs, not when it is prepared), `undefined` cannot be bound,
// `first(column)` of a missing column rejects, rows are plain objects, and `batch` is one atomic transaction.

export interface TestD1 extends D1Like {
  /** The underlying database, for a test that wants to look at the tables directly. */
  readonly raw: DatabaseSync;
}

const meta = (changes: number, last: number | bigint): { changes: number; last_row_id: number } => ({ changes, last_row_id: Number(last) });

function execute(db: DatabaseSync, sql: string, values: readonly unknown[]): D1Result {
  const stmt: StatementSync = db.prepare(sql);
  const params = values as SQLInputValue[];
  if (returnsRows(stmt, sql)) {
    const results = stmt.all(...params).map((row) => ({ ...row }));
    return { results, success: true, meta: meta(0, 0) };
  }
  const out = stmt.run(...params);
  return { results: [], success: true, meta: meta(Number(out.changes), out.lastInsertRowid) };
}

class Statement implements D1Statement {
  readonly db: DatabaseSync;
  readonly sql: string;
  readonly values: readonly unknown[];
  constructor(db: DatabaseSync, sql: string, values: readonly unknown[]) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }
  bind(...values: unknown[]): D1Statement {
    for (const v of values) if (v === undefined) throw new TypeError('D1_TYPE_ERROR: type undefined is not supported');
    return new Statement(this.db, this.sql, values);
  }
  run(): Promise<D1Result> {
    return attempt(() => execute(this.db, this.sql, this.values));
  }
  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return attempt(() => execute(this.db, this.sql, this.values) as unknown as D1Result<T>);
  }
  first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    return attempt(() => {
      const row = execute(this.db, this.sql, this.values).results[0];
      if (row === undefined) return null;
      if (column === undefined) return row as T;
      if (!(column in row)) throw new Error(`D1_ERROR: no such column: ${column}`);
      return row[column] as T;
    });
  }
}

/** Runs `work` and returns its value as a promise, rejecting (never throwing) like a D1 call. */
function attempt<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

/** A fresh in-memory D1, or one over the database you pass. */
export function createD1(raw: DatabaseSync = new DatabaseSync(':memory:')): TestD1 {
  return {
    raw,
    prepare: (sql: string) => new Statement(raw, sql, []),
    batch: <T>(statements: D1Statement[]): Promise<D1Result<T>[]> =>
      attempt(() => {
        if (statements.length === 0) return [];
        raw.exec('BEGIN');
        try {
          const out = statements.map((s) => {
            if (!(s instanceof Statement)) throw new TypeError('D1_ERROR: batch takes statements from this database');
            return execute(raw, s.sql, s.values) as unknown as D1Result<T>;
          });
          raw.exec('COMMIT');
          return out;
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
      }),
  };
}

/** Applies services/corpus/schema.sql. It is idempotent, so a test may apply it more than once. */
export function applySchema(d1: TestD1): Promise<void> {
  return attempt(() => {
    d1.raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  });
}
