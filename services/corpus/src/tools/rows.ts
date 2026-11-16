import type { StatementSync } from 'node:sqlite';

// Whether a prepared node:sqlite statement returns rows. `StatementSync.columns()` says so exactly, but it is missing from Node 22.13 (the repo's
// minimum); without it the statement's own text decides: a query (SELECT, WITH, VALUES, PRAGMA, EXPLAIN) or anything with RETURNING returns rows.

const QUERY = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(?:select|with|values|pragma|explain)\b/i;
const RETURNING = /\breturning\b/i;

export function returnsRows(stmt: StatementSync, sql: string): boolean {
  const columns = (stmt as { columns?: () => unknown[] }).columns;
  if (typeof columns === 'function') return columns.call(stmt).length > 0;
  return QUERY.test(sql) || RETURNING.test(sql);
}
