import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openStore } from '../src/index.js';

// Migration 25 (AI levels 3 and 4, release 2, shadow mode): one column on the reads (`purpose`), the one-row acting state and the action rows. One-way,
// additive, wrapped by the runner in one savepoint with the version bump. Tested from a version-24 database that holds reads.

const NOW = 1_800_000_000_000;
const M25 = MIGRATIONS.find((m) => m.version === 25);
const UP_TO_24 = MIGRATIONS.slice(0, 24);

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});
const memDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return db;
};
const names = (db: DatabaseSync, type: 'table' | 'index'): string[] =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`).all().map((r) => String(r.name));
const info = (db: DatabaseSync, table: string): Array<Record<string, unknown>> => db.prepare(`PRAGMA table_info(${table})`).all();

function openAt24(db: DatabaseSync): void {
  const store = openStore({ db, migrations: UP_TO_24 });
  expect(store.schemaVersion()).toBe(24);
  for (const id of ['r1', 'r2']) {
    db.prepare(
      `INSERT INTO kit_ai_reads (id, report_id, input_hash, status, prompt_version, severity, rule, summary, evidence_json, confidence, injection, created_at)
       VALUES (?, ?, ?, 'ok', 4, 'hostile', '3', 's', '[]', 'high', 0, ?)`,
    ).run(`read-${id}`, id, `h-${id}`, NOW);
  }
  store.close();
}

describe('migration 25: shadow mode', () => {
  it('is the 25th migration, the list is contiguous and the previous release is still a prefix of it, byte for byte', () => {
    expect(M25).toBeDefined();
    expect(MIGRATIONS[24]?.version).toBe(25);
    expect(MIGRATIONS.map((m) => m.version).slice(0, 25)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(MIGRATIONS.slice(0, 24)).toEqual(UP_TO_24);
  });

  it('is append-only: it adds a column, two tables and indexes, and drops, renames, deletes and rebuilds nothing', () => {
    const sql = M25?.sql ?? '';
    expect(sql).not.toMatch(/\b(DROP|RENAME|DELETE|UPDATE)\b/i);
    expect([...sql.matchAll(/\bALTER TABLE\s+(kit_\w+)/gi)].map((m) => m[1])).toEqual(['kit_ai_reads']);
    expect([...sql.matchAll(/\bCREATE TABLE\s+(kit_\w+)/gi)].map((m) => m[1]).sort()).toEqual(['kit_ai_acting', 'kit_ai_actions']);
  });

  it('existing reads become purpose read; the new tables are empty; no other column of a read moves', () => {
    const db = memDb();
    openAt24(db);
    const before = db.prepare('SELECT id, report_id, input_hash, status, prompt_version, severity, rule, created_at FROM kit_ai_reads ORDER BY id').all();
    expect(names(db, 'table')).not.toContain('kit_ai_actions');
    openStore({ db }).close();
    expect(db.prepare('SELECT purpose FROM kit_ai_reads ORDER BY id').all()).toEqual([{ purpose: 'read' }, { purpose: 'read' }]);
    expect(db.prepare('SELECT id, report_id, input_hash, status, prompt_version, severity, rule, created_at FROM kit_ai_reads ORDER BY id').all()).toEqual(before);
    for (const t of ['kit_ai_acting', 'kit_ai_actions']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
  });

  it('purpose is a closed set with a default, and a confirming read is its own row beside the case read', () => {
    const db = memDb();
    openStore({ db }).close();
    const col = info(db, 'kit_ai_reads').find((c) => c.name === 'purpose');
    expect(col).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'read'" });
    const put = (id: string, hash: string, purpose?: string): void => {
      db.prepare(
        `INSERT INTO kit_ai_reads (id, report_id, input_hash, status, prompt_version, created_at${purpose === undefined ? '' : ', purpose'}) VALUES (?, 'r', ?, 'pending', 5, 1${purpose === undefined ? '' : ', ?'})`,
      ).run(...(purpose === undefined ? [id, hash] : [id, hash, purpose]));
    };
    put('a', 'h1');
    put('b', 'h2', 'confirm');
    expect(db.prepare('SELECT id, purpose FROM kit_ai_reads ORDER BY id').all()).toEqual([
      { id: 'a', purpose: 'read' },
      { id: 'b', purpose: 'confirm' },
    ]);
    for (const bad of ['Read', 'act', '', 'confirmed']) expect(() => put(`x${bad}`, `hx${bad}`, bad), bad).toThrow(/CHECK/);
  });

  it('kit_ai_acting is one row at most (id 1) with a closed set of modes', () => {
    const db = memDb();
    openStore({ db }).close();
    expect(info(db, 'kit_ai_acting').map((r) => [String(r.name), String(r.type), Number(r.notnull)])).toEqual([
      ['id', 'INTEGER', 0],
      ['mode', 'TEXT', 1],
      ['mode_since', 'INTEGER', 0],
      ['mode_by', 'TEXT', 0],
      ['paused', 'INTEGER', 1],
      ['paused_since', 'INTEGER', 0],
      ['paused_by', 'TEXT', 0],
    ]);
    db.prepare("INSERT INTO kit_ai_acting (id, mode) VALUES (1, 'off')").run();
    expect(() => db.prepare("INSERT INTO kit_ai_acting (id, mode) VALUES (2, 'off')").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO kit_ai_acting (id, mode) VALUES (1, 'off')").run()).toThrow(/UNIQUE|constraint/i);
    for (const bad of ['on ', 'ON', 'acting', '']) expect(() => db.prepare('UPDATE kit_ai_acting SET mode = ? WHERE id = 1').run(bad), bad).toThrow(/CHECK/);
    for (const ok of ['off', 'shadow', 'on']) expect(() => db.prepare('UPDATE kit_ai_acting SET mode = ? WHERE id = 1').run(ok)).not.toThrow();
  });

  it('kit_ai_actions is one row per report, with closed states and undo codes, and its four indexes', () => {
    const db = memDb();
    openStore({ db }).close();
    const put = (id: string, report: string, state: string, extra = ''): void =>
      void db
        .prepare(`INSERT INTO kit_ai_actions (id, report_id, read_id, rule, severity, state, not_before, created_at${extra === '' ? '' : ', undo_code'}) VALUES (?, ?, 'rd', '3', 'hostile', ?, 1, 1${extra === '' ? '' : ', ?'})`)
        .run(...(extra === '' ? [id, report, state] : [id, report, state, extra]));
    for (const [i, state] of ['queued', 'shadow', 'active', 'confirmed', 'undone', 'refused', 'held_back'].entries()) put(`a${i}`, `r${i}`, state);
    expect(() => put('dup', 'r0', 'queued')).toThrow(/UNIQUE|constraint/i);
    for (const bad of ['done', 'SHADOW', 'acted', '']) expect(() => put(`b${bad}`, `rb${bad}`, bad), bad).toThrow(/CHECK/);
    for (const ok of ['not_a_violation', 'wrong_rule', 'too_heavy', 'already_handled']) expect(() => put(`u${ok}`, `ru${ok}`, 'undone', ok)).not.toThrow();
    expect(() => put('ubad', 'rubad', 'undone', 'because')).toThrow(/CHECK/);
    expect(names(db, 'index').filter((n) => n.startsWith('kit_ai_actions_'))).toEqual([
      'kit_ai_actions_by_cell',
      'kit_ai_actions_by_group',
      'kit_ai_actions_by_review',
      'kit_ai_actions_by_state',
    ]);
  });

  it('is idempotent on reopen, and an older kit refuses a version-25 database', () => {
    const db = memDb();
    openAt24(db);
    openStore({ db }).close();
    expect(openStore({ db }).schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(() => openStore({ db, migrations: UP_TO_24 })).toThrow(/newer than this kit supports/);
  });

  it('a failing migration 25 rolls back whole: version 24, no column, no table, no index; it still upgrades afterwards', () => {
    const db = memDb();
    openAt24(db);
    const broken = [...UP_TO_24, { version: 25, sql: `${M25?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: UP_TO_24 }).schemaVersion()).toBe(24);
    expect(info(db, 'kit_ai_reads').map((r) => r.name)).not.toContain('purpose');
    expect(names(db, 'table')).not.toContain('kit_ai_actions');
    expect(names(db, 'table')).not.toContain('kit_ai_acting');
    expect(names(db, 'index')).not.toContain('kit_ai_actions_by_state');
    expect(openStore({ db }).schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(info(db, 'kit_ai_reads').map((r) => r.name)).toContain('purpose');
  });
});
