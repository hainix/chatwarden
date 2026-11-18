import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaceStateRow } from '@chatwarden/core';
import { openStore } from '../src/index.js';
import * as sqliteStoreModule from '../src/sqliteStore.js';

// S3: the SQLite pace methods beyond the shared contract: how a row is stored, the query plans, the transaction and a busy database.

const T = 1_800_000_000_000;
const row = (over: Partial<PaceStateRow> = {}): PaceStateRow => ({ roomId: 'r', who: 'w', lastAt: T, stamps: [T - 1, T], recent: [{ h: '0123456789abcdef', at: T }], floodSignalAt: null, touchedAt: T, ...over });

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      c();
    } catch {
      /* already gone */
    }
  }
});
function fileDb(): { path: string; open: () => DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), 'cw-pace-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'pace.db');
  return {
    path,
    open: () => {
      const db = new DatabaseSync(path);
      cleanups.push(() => db.close());
      return db;
    },
  };
}
const plan = (db: DatabaseSync, sql: string, ...args: Array<string | number>): string => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => String(r.detail)).join(' | ');

describe('SqliteStore pace', () => {
  it('stores times as numbers and digests as JSON text: the row holds no line text', () => {
    const db = new DatabaseSync(':memory:');
    const s = openStore({ db });
    s.paceUpdate?.('r', 'w', () => row({ floodSignalAt: T + 3 }));
    const stored = db.prepare('SELECT * FROM kit_pace').get() as Record<string, unknown>;
    expect(stored).toMatchObject({ room_id: 'r', who: 'w', last_at: T, flood_signal_at: T + 3, touched_at: T });
    expect(JSON.parse(String(stored.stamps_json))).toEqual([T - 1, T]);
    expect(JSON.parse(String(stored.recent_json))).toEqual([{ h: '0123456789abcdef', at: T }]);
    expect(Object.keys(stored).sort()).toEqual(['flood_signal_at', 'last_at', 'recent_json', 'room_id', 'stamps_json', 'touched_at', 'who']);
  });

  it('a row survives a restart: the next process reads what the last wrote', () => {
    const f = fileDb();
    const a = new DatabaseSync(f.path);
    openStore({ db: a }).paceUpdate?.('r', 'w', () => row());
    a.close();
    const b = new DatabaseSync(f.path);
    cleanups.push(() => b.close());
    expect(openStore({ db: b }).paceLoad?.('r', 'w')).toEqual(row());
  });

  it('EXPLAIN QUERY PLAN: paceLoad uses the primary key; paceSweep uses kit_pace_by_touched; dropRoom uses the primary key prefix', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    expect(plan(db, sqliteStoreModule.PACE_LOAD_SQL, 'r', 'w')).toMatch(/PRIMARY KEY/i);
    expect(plan(db, sqliteStoreModule.PACE_LOAD_SQL, 'r', 'w')).not.toMatch(/SCAN/);
    expect(plan(db, sqliteStoreModule.PACE_SWEEP_SQL, 1)).toMatch(/kit_pace_by_touched/);
    expect(plan(db, sqliteStoreModule.PACE_DROP_ROOM_SQL, 'r')).toMatch(/PRIMARY KEY/i);
    expect(plan(db, sqliteStoreModule.PACE_DROP_ROOM_SQL, 'r')).not.toMatch(/SCAN/);
  });

  it('paceUpdate is one BEGIN IMMEDIATE transaction around the load, fn and the upsert: a second connection cannot write while fn runs', () => {
    const f = fileDb();
    const a = f.open();
    const store = openStore({ db: a });
    const b = f.open();
    b.exec('PRAGMA busy_timeout = 30');
    store.paceUpdate?.('r', 'w', () => row());
    let sawLocked = false;
    store.paceUpdate?.('r', 'w', (prev) => {
      try {
        b.prepare('INSERT INTO kit_meta (key, value) VALUES (?, ?)').run('during', 'x');
      } catch (err) {
        sawLocked = /locked|busy/i.test(String((err as Error).message));
      }
      return { ...(prev as PaceStateRow), lastAt: T + 1 };
    });
    expect(sawLocked).toBe(true);
    // and once it is done the other connection may write again
    b.prepare('INSERT INTO kit_meta (key, value) VALUES (?, ?)').run('after', 'y');
    expect(store.paceLoad?.('r', 'w')?.lastAt).toBe(T + 1);
  });

  it('inside an open transaction of the caller paceUpdate still works (it nests as a savepoint) and rolls back with it', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(() =>
      store.transaction(() => {
        store.paceUpdate?.('r', 'w', () => row());
        throw new Error('undo');
      }),
    ).toThrow('undo');
    expect(store.paceLoad?.('r', 'w')).toBeNull();
    store.transaction(() => {
      store.paceUpdate?.('r', 'w', () => row());
    });
    expect(store.paceLoad?.('r', 'w')).not.toBeNull();
  });

  it('a throwing fn rolls the transaction back and releases the lock (another connection can write at once)', () => {
    const f = fileDb();
    const a = f.open();
    const store = openStore({ db: a });
    const b = f.open();
    b.exec('PRAGMA busy_timeout = 30');
    expect(() =>
      store.paceUpdate?.('r', 'w', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    b.prepare('INSERT INTO kit_meta (key, value) VALUES (?, ?)').run('free', 'z');
    expect(store.paceLoad?.('r', 'w')).toBeNull();
  });

  it('a busy database past busy_timeout throws a classified error, not a hang', () => {
    const f = fileDb();
    const a = f.open();
    const store = openStore({ db: a });
    const b = f.open();
    b.exec('BEGIN IMMEDIATE');
    a.exec('PRAGMA busy_timeout = 40');
    const started = Date.now();
    let caught: unknown;
    try {
      store.paceUpdate?.('r', 'w', () => row());
    } catch (err) {
      caught = err;
    }
    expect(Date.now() - started).toBeLessThan(3000);
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/locked|busy/i);
    expect(typeof (caught as Error).name).toBe('string');
    // a read (WAL or not) of an unlocked table is not the pacer's concern, but a load after the lock goes works
    b.exec('ROLLBACK');
    expect(store.paceLoad?.('r', 'w')).toBeNull();
  });

  it('a corrupt stored row (bad JSON) reads as a failure the pacer can catch, not a crash of the process', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    db.prepare('INSERT INTO kit_pace (room_id, who, last_at, stamps_json, recent_json, flood_signal_at, touched_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('r', 'w', 1, '{not json', '[]', null, 1);
    expect(() => store.paceLoad?.('r', 'w')).toThrow();
    // the update path stores a good row over it only if fn does not need the broken one
    expect(() => store.paceUpdate?.('r', 'w', () => row())).toThrow();
  });

  it('a COMMIT that throws rolls back and leaves no transaction open: the next update writes and persists (review m7)', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    const realExec = db.exec.bind(db);
    let failNext = true;
    db.exec = ((sql: string) => {
      if (sql === 'COMMIT' && failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      return realExec(sql);
    }) as typeof db.exec;
    expect(() => store.paceUpdate?.('r', 'w', () => row())).toThrow(/disk full/);
    // the failed update left nothing behind and no open transaction: a BEGIN works and the write lands
    expect(store.paceLoad?.('r', 'w')).toBeNull();
    const written = store.paceUpdate?.('r', 'w', () => row({ lastAt: T + 5 }));
    expect(written?.lastAt).toBe(T + 5);
    expect(store.paceLoad?.('r', 'w')?.lastAt).toBe(T + 5);
    // and a third and a fourth keep working
    store.paceUpdate?.('r', 'w2', () => row({ who: 'w2' }));
    expect(store.paceLoad?.('r', 'w2')).not.toBeNull();
  });

  it('a COMMIT that throws is rethrown as the same error, and a failed ROLLBACK does not hide it', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    const realExec = db.exec.bind(db);
    db.exec = ((sql: string) => {
      if (sql === 'COMMIT') throw new Error('commit failed');
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return realExec(sql);
    }) as typeof db.exec;
    expect(() => store.paceUpdate?.('r', 'w', () => row())).toThrow(/commit failed/);
  });
});
