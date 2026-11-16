import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { returnsRows } from './rows.js';
import type { D1Like, D1Result, D1Statement } from '../env.js';

// A D1-shaped, in-memory copy of the database for the maintainers' tools (the release builder reads a copy, never the live database): it opens a
// SQL dump (`wrangler d1 export --remote --output file.sql`) in `node:sqlite` and answers the small D1 interface the service code is written
// against. Read it as a read-only snapshot: nothing here writes back.

const meta = (changes: number, last: number | bigint): { changes: number; last_row_id: number } => ({ changes, last_row_id: Number(last) });

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
    return new Statement(this.db, this.sql, values);
  }
  private execute(): D1Result {
    const stmt = this.db.prepare(this.sql);
    const params = this.values as SQLInputValue[];
    if (returnsRows(stmt, this.sql)) return { results: stmt.all(...params).map((row) => ({ ...row })), success: true, meta: meta(0, 0) };
    const out = stmt.run(...params);
    return { results: [], success: true, meta: meta(Number(out.changes), out.lastInsertRowid) };
  }
  run(): Promise<D1Result> {
    return this.attempt(() => this.execute());
  }
  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.attempt(() => this.execute() as unknown as D1Result<T>);
  }
  first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    return this.attempt(() => {
      const row = this.execute().results[0];
      if (row === undefined) return null;
      return (column === undefined ? row : row[column]) as T;
    });
  }
  private attempt<T>(work: () => T): Promise<T> {
    try {
      return Promise.resolve(work());
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

/** Opens a SQL dump (the tables and rows as SQL text) as an in-memory database. */
export function openDump(sql: string): D1Like {
  const raw = new DatabaseSync(':memory:');
  raw.exec(sql);
  return {
    prepare: (text: string) => new Statement(raw, text, []),
    batch: <T>(statements: D1Statement[]): Promise<D1Result<T>[]> => Promise.all(statements.map((s) => s.run())) as Promise<D1Result<T>[]>,
  };
}
