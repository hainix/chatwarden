import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SignalRow } from '@chatwarden/core';
import { openStore } from '../src/index.js';
import type { SqliteStore } from '../src/index.js';

// What is specific to SQLite in the signal methods: the plans the indexes of migration 21 give, the unique index that is the per-source
// cap (also between two connections), and the checks the table makes. The behaviour both stores share is in the shared contract suite
// (test/contract/signals.contract.ts).

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const memDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return db;
};
const fileDb = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-sig-'));
  dirs.push(d);
  return join(d, 'kit.db');
};
const open = (path: string): SqliteStore => {
  const s = openStore({ path });
  stores.push(s);
  return s;
};

let n = 0;
const row = (over: Partial<SignalRow> = {}): SignalRow => {
  n += 1;
  return {
    id: `sig-${n}`,
    kind: 'muted_by_player',
    subject: 's_target',
    sourceKey: 'b:s_from_1',
    bySubject: 's_from_1',
    roomId: null,
    at: NOW,
    weight: 1,
    capBucket: Math.floor(NOW / DAY),
    ...over,
  };
};

type Seen = { sql: string; args: SQLInputValue[] };
/** The statements the store prepares while `run` executes: SQL text plus the arguments it was run with. */
function record(db: DatabaseSync, run: () => void): Seen[] {
  const seen: Seen[] = [];
  const orig = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = orig(sql);
    for (const m of ['all', 'get', 'run'] as const) {
      const f = stmt[m].bind(stmt) as (...a: SQLInputValue[]) => unknown;
      (stmt as unknown as Record<string, unknown>)[m] = (...args: SQLInputValue[]) => {
        seen.push({ sql, args });
        return f(...args);
      };
    }
    return stmt;
  };
  try {
    run();
  } finally {
    delete (db as { prepare?: unknown }).prepare;
  }
  return seen;
}
const planOf = (db: DatabaseSync, seen: Seen[], match: RegExp): string[] => {
  const hits = seen.filter((s) => match.test(s.sql));
  expect(hits, `one statement matching ${String(match)} was issued`).toHaveLength(1);
  const hit = hits[0] as Seen;
  return db.prepare(`EXPLAIN QUERY PLAN ${hit.sql}`).all(...hit.args).map((r) => String(r.detail));
};

/** A store with a few hundred rows over many subjects and sources. */
function seeded(db: DatabaseSync): SqliteStore {
  const store = openStore({ db });
  stores.push(store);
  for (let i = 0; i < 400; i++) {
    store.insertSignal(row({ subject: `s_${i % 40}`, sourceKey: `b:s_from_${i % 9}`, bySubject: `s_from_${i % 9}`, at: NOW - (i % 30) * DAY, capBucket: Math.floor(NOW / DAY) - (i % 30), weight: 1 + (i % 3) }));
  }
  return store;
}

describe('the plans migration 21 gives', () => {
  it('listSignalSources uses kit_signals_by_subject', () => {
    const db = memDb();
    const store = seeded(db);
    const seen = record(db, () => store.listSignalSources(['s_1', 's_2', 's_3'], NOW - 14 * DAY));
    const plan = planOf(db, seen, /FROM kit_signals/i);
    expect(plan.join('\n')).toMatch(/USING (COVERING )?INDEX kit_signals_by_subject/);
    expect(plan.join('\n')).not.toMatch(/SCAN kit_signals(?! USING)/);
  });

  it('purgeSignals uses kit_signals_by_at', () => {
    const db = memDb();
    const store = seeded(db);
    const seen = record(db, () => store.purgeSignals(NOW - 20 * DAY));
    const plan = planOf(db, seen, /DELETE FROM kit_signals/i);
    expect(plan.join('\n')).toMatch(/USING (COVERING )?INDEX kit_signals_by_at/);
  });

  it('the cap is the unique index kit_signals_cap on (kind, subject_id, source_key, cap_bucket)', () => {
    const db = memDb();
    const store = openStore({ db });
    stores.push(store);
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'kit_signals_cap'").get();
    expect(String(idx?.sql)).toMatch(/UNIQUE INDEX kit_signals_cap\s+ON kit_signals \(kind, subject_id, source_key, cap_bucket\)/);
    store.insertSignal(row());
    // A plain INSERT of the same tuple (another id) names that index's columns in the constraint error.
    expect(() =>
      db
        .prepare('INSERT INTO kit_signals (id, kind, subject_id, source_key, by_subject, room_id, at, weight, cap_bucket) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('other-id', 'muted_by_player', 's_target', 'b:s_from_1', 's_from_1', null, NOW, 1, Math.floor(NOW / DAY)),
    ).toThrow(/UNIQUE constraint failed: kit_signals\.kind, kit_signals\.subject_id, kit_signals\.source_key, kit_signals\.cap_bucket/);
  });

  it('insertSignal is one statement that returns whether a row was written', () => {
    const db = memDb();
    const store = openStore({ db });
    stores.push(store);
    const seen = record(db, () => {
      store.insertSignal(row());
      store.insertSignal(row());
    });
    const inserts = seen.filter((s) => /INSERT INTO kit_signals/i.test(s.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.sql).toMatch(/ON CONFLICT DO NOTHING/i);
    // No separate existence read: one statement each.
    expect(seen.filter((s) => /SELECT/i.test(s.sql) && /kit_signals/i.test(s.sql))).toHaveLength(0);
  });
});

describe('the table', () => {
  it('weight CHECK refuses a negative weight, through the store and by hand', () => {
    const db = memDb();
    const store = openStore({ db });
    stores.push(store);
    expect(() => store.insertSignal(row({ weight: -0.5 }))).toThrow();
    expect(() => store.insertSignal(row({ weight: Number.NaN }))).toThrow();
    expect(store.listSignalSources(['s_target'], 0)).toEqual([]);
    expect(() => db.exec("INSERT INTO kit_signals (id, kind, subject_id, source_key, at, weight, cap_bucket) VALUES ('x', 'k', 's', 'd:1', 1, -1, 0)")).toThrow(/CHECK/);
    expect(store.insertSignal(row({ weight: 0 }))).toBe(true);
  });

  it('a row holds ids and numbers only: the columns are the spec\'s', () => {
    const db = memDb();
    stores.push(openStore({ db }));
    expect(db.prepare('PRAGMA table_info(kit_signals)').all().map((r) => String(r.name))).toEqual([
      'id', 'kind', 'subject_id', 'source_key', 'by_subject', 'room_id', 'at', 'weight', 'cap_bucket',
    ]);
  });

  it('does not move the change token', () => {
    const store = openStore({ db: memDb() });
    stores.push(store);
    const before = store.changeToken();
    store.insertSignal(row());
    store.purgeSignals(NOW + 1);
    expect(store.changeToken()).toBe(before);
  });

  it('a subject list longer than one batch is answered whole and sorted', () => {
    const store = openStore({ db: memDb() });
    stores.push(store);
    const ids = Array.from({ length: 1300 }, (_, i) => `s_${String(i).padStart(4, '0')}`);
    for (const id of ids) store.insertSignal(row({ subject: id, sourceKey: 'd:x', bySubject: null }));
    const out = store.listSignalSources([...ids, ...ids.slice(0, 10)], 0);
    expect(out.map((r) => r.subject)).toEqual(ids);
  });
});

describe('two connections', () => {
  it('insert the same cap tuple: exactly one wins', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    expect(a.insertSignal(row({ id: 'from-a' }))).toBe(true);
    expect(b.insertSignal(row({ id: 'from-b' }))).toBe(false);
    expect(b.insertSignal(row({ id: 'from-b2', sourceKey: 'b:s_from_2', bySubject: 's_from_2' }))).toBe(true);
    expect(a.listSignalSources(['s_target'], 0)).toHaveLength(2);
    // Whichever connection looks sees the same rows.
    expect(b.listSignalSources(['s_target'], 0)).toEqual(a.listSignalSources(['s_target'], 0));
  });

  it('a purge by one frees the cap slot for the other', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    a.insertSignal(row({ at: NOW - 5 }));
    expect(b.insertSignal(row({ at: NOW - 5 }))).toBe(false);
    expect(b.purgeSignals(NOW)).toBe(1);
    expect(a.insertSignal(row({ at: NOW - 5 }))).toBe(true);
  });

  it('many tries on one tuple from both connections leave exactly one row', () => {
    const path = fileDb();
    const stores2 = [open(path), open(path)];
    let wins = 0;
    for (let i = 0; i < 40; i += 1) if (stores2[i % 2]!.insertSignal(row({ id: `try-${i}` }))) wins += 1;
    expect(wins).toBe(1);
    expect(stores2[0]!.listSignalSources(['s_target'], 0)).toHaveLength(1);
  });
});
