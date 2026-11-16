import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createD1 } from './d1.js';

function fresh() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, n INTEGER)');
  return { raw, d1: createD1(raw) };
}

describe('the D1 adapter returns what node:sqlite returns for first, all, run and batch', () => {
  it('run reports success, the changes and the last row id, like D1', async () => {
    const { d1 } = fresh();
    const res = await d1.prepare('INSERT INTO t (name, n) VALUES (?, ?)').bind('a', 1).run();
    expect(res.success).toBe(true);
    expect(res.meta.changes).toBe(1);
    expect(res.meta.last_row_id).toBe(1);
    const upd = await d1.prepare('UPDATE t SET n = ? WHERE name = ?').bind(5, 'zzz').run();
    expect(upd.meta.changes).toBe(0);
  });

  it('first returns the first row, null for none, and one column when asked', async () => {
    const { raw, d1 } = fresh();
    raw.exec("INSERT INTO t (name, n) VALUES ('a', 1), ('b', 2)");
    expect(await d1.prepare('SELECT * FROM t ORDER BY id').first()).toEqual({ id: 1, name: 'a', n: 1 });
    expect(await d1.prepare('SELECT * FROM t WHERE name = ?').bind('nope').first()).toBeNull();
    expect(await d1.prepare('SELECT * FROM t WHERE name = ?').bind('b').first('n')).toBe(2);
  });

  it('first(column) on a missing column rejects, as D1 does, and on no row is null', async () => {
    const { raw, d1 } = fresh();
    raw.exec("INSERT INTO t (name, n) VALUES ('a', 1)");
    await expect(d1.prepare('SELECT * FROM t').first('missing')).rejects.toThrow();
    expect(await d1.prepare('SELECT * FROM t WHERE id = 99').first('n')).toBeNull();
  });

  it('all returns { results, success, meta } with plain objects, and an empty array for none', async () => {
    const { raw, d1 } = fresh();
    raw.exec("INSERT INTO t (name, n) VALUES ('a', 1), ('b', NULL)");
    const res = await d1.prepare('SELECT name, n FROM t ORDER BY id').all<{ name: string; n: number | null }>();
    expect(res.success).toBe(true);
    expect(res.results).toEqual([
      { name: 'a', n: 1 },
      { name: 'b', n: null },
    ]);
    expect(Object.getPrototypeOf(res.results[0])).toBe(Object.prototype);
    expect((await d1.prepare('SELECT * FROM t WHERE id = ?').bind(77).all()).results).toEqual([]);
  });

  it('bind values are positional, a statement can be bound again, and undefined is refused like D1', async () => {
    const { d1 } = fresh();
    const stmt = d1.prepare('INSERT INTO t (name, n) VALUES (?1, ?2)');
    await stmt.bind('a', 1).run();
    await stmt.bind('b', 2).run();
    expect((await d1.prepare('SELECT COUNT(*) AS c FROM t').first<{ c: number }>())?.c).toBe(2);
    expect(() => d1.prepare('SELECT ?').bind(undefined)).toThrow();
  });

  it('a constraint failure rejects with the database error and changes nothing', async () => {
    const { d1 } = fresh();
    await d1.prepare('INSERT INTO t (name) VALUES (?)').bind('a').run();
    await expect(d1.prepare('INSERT INTO t (name) VALUES (?)').bind('a').run()).rejects.toThrow(/UNIQUE/);
    expect((await d1.prepare('SELECT COUNT(*) AS c FROM t').first<{ c: number }>())?.c).toBe(1);
  });

  it('batch runs the statements in order, returns one result each, and is atomic', async () => {
    const { d1 } = fresh();
    const ok = await d1.batch([
      d1.prepare('INSERT INTO t (name, n) VALUES (?, ?)').bind('a', 1),
      d1.prepare('SELECT name FROM t'),
      d1.prepare('UPDATE t SET n = n + 1'),
    ]);
    expect(ok).toHaveLength(3);
    expect(ok[0]?.meta.changes).toBe(1);
    expect(ok[1]?.results).toEqual([{ name: 'a' }]);
    expect(ok[2]?.meta.changes).toBe(1);

    await expect(
      d1.batch([d1.prepare('INSERT INTO t (name) VALUES (?)').bind('b'), d1.prepare('INSERT INTO t (name) VALUES (?)').bind('a')]),
    ).rejects.toThrow();
    // the first insert of the failed batch was rolled back
    expect((await d1.prepare('SELECT name FROM t ORDER BY id').all()).results).toEqual([{ name: 'a' }]);
  });

  it('an empty batch is an empty result, and the adapter stays usable after a failed batch', async () => {
    const { d1 } = fresh();
    expect(await d1.batch([])).toEqual([]);
    await expect(d1.batch([d1.prepare('INSERT INTO nope VALUES (1)')])).rejects.toThrow();
    await d1.prepare('INSERT INTO t (name) VALUES (?)').bind('x').run();
    expect((await d1.prepare('SELECT COUNT(*) AS c FROM t').first<{ c: number }>())?.c).toBe(1);
  });
});
