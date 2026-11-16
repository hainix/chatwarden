import { DatabaseSync, StatementSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDump } from '../src/tools/localD1.js';
import { returnsRows } from '../src/tools/rows.js';
import { createD1 } from './d1.js';

// Node 22.13 has no StatementSync.columns(): the D1 fakes must work without it (the statement text decides).

const proto = StatementSync.prototype as unknown as { columns?: unknown };
const original = proto.columns;
beforeEach(() => {
  Object.defineProperty(proto, 'columns', { value: undefined, configurable: true, writable: true });
});
afterEach(() => {
  Object.defineProperty(proto, 'columns', { value: original, configurable: true, writable: true });
});

describe('returnsRows without columns()', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (a INTEGER)');
  it.each([
    ['SELECT a FROM t', true],
    ['  select 1', true],
    ['WITH x AS (SELECT 1) SELECT * FROM x', true],
    ['PRAGMA table_info(t)', true],
    ['-- note\nSELECT 1', true],
    ['/* c */ SELECT 1', true],
    ['INSERT INTO t (a) VALUES (1) RETURNING a', true],
    ['INSERT INTO t (a) VALUES (1)', false],
    ['UPDATE t SET a = 2', false],
    ['DELETE FROM t', false],
    ['CREATE TABLE u (a)', false],
  ])('%s -> %s', (sql, rows) => {
    expect(returnsRows(db.prepare(sql), sql)).toBe(rows);
  });
});

describe('the D1 fakes with columns() gone', () => {
  it('the test adapter selects, inserts and reports changes', async () => {
    const d1 = createD1();
    await d1.prepare('CREATE TABLE t (a INTEGER, b TEXT)').run();
    const ins = await d1.prepare('INSERT INTO t (a, b) VALUES (?, ?)').bind(1, 'x').run();
    expect(ins.meta.changes).toBe(1);
    expect((await d1.prepare('SELECT a, b FROM t').all()).results).toEqual([{ a: 1, b: 'x' }]);
    expect(await d1.prepare('SELECT b FROM t WHERE a = ?').bind(1).first('b')).toBe('x');
    expect((await d1.prepare('UPDATE t SET a = 5').run()).meta.changes).toBe(1);
  });

  it('the dump reader selects and writes', async () => {
    const d1 = openDump('CREATE TABLE t (a INTEGER); INSERT INTO t (a) VALUES (7);');
    expect((await d1.prepare('SELECT a FROM t').all()).results).toEqual([{ a: 7 }]);
    expect((await d1.prepare('DELETE FROM t').run()).meta.changes).toBe(1);
  });
});
