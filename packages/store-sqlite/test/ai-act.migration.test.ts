import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openStore } from '../src/index.js';
import { AI_GATE_ROWS_SQL } from '../src/sqliteStore.js';

// Migration 24 (AI levels 3 and 4, release 1): the casebook rows gain the AI's own rule, conduct level and confidence, the deciding moderator's ref
// and where the decision came from, plus the index the gate query reads. One-way, additive, wrapped by the runner in one savepoint with the
// version bump. Tested from a version-23 database with data: rows whose read is still there are backfilled; older rows stay NULL.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const M24 = MIGRATIONS.find((m) => m.version === 24);
const UP_TO_23 = MIGRATIONS.slice(0, 23);

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

/** One read row the way the kit wrote it (version 20 onwards): the AI's read of a report with a recommendation. */
function insertRead(db: DatabaseSync, o: { id: string; report: string; rule?: string | null; confidence?: string; injection?: number; rec?: unknown | null; severity?: string }): void {
  db.prepare(
    `INSERT INTO kit_ai_reads (id, report_id, input_hash, status, prompt_version, severity, rule, summary, evidence_json, confidence, injection, rec_json, created_at)
     VALUES (?, ?, ?, 'ok', 2, ?, ?, 's', '[]', ?, ?, ?, ?)`,
  ).run(o.id, o.report, `h-${o.id}`, o.severity ?? 'hostile', o.rule === undefined ? '3' : o.rule, o.confidence ?? 'high', o.injection ?? 0, o.rec === null ? null : JSON.stringify(o.rec ?? { verdict: 'upheld', severity: 'hostile', rule: 3, evidence: [] }), NOW - DAY);
}
function insertReport(db: DatabaseSync, id: string, by: string | null): void {
  db.prepare(
    `INSERT INTO kit_reports (id, created_at, room_id, tags_json, reporter_subject, reporter_seat, reporter_handle, target_subject, target_seat, target_handle,
                              category, excerpt_json, people_json, status, actioned_at, actioned_by)
     VALUES (?, ?, ?, '{}', ?, 'p1', 'R', 's_t', 'p2', 'T', 'harassment', '[]', '[]', 'actioned', ?, ?)`,
  ).run(id, NOW - 2 * DAY, `room-${id}`, `s_rep_${id}`, NOW - DAY, by);
}
function insertOutcome(db: DatabaseSync, report: string, readId: string | null, over: { agreement?: string; rule?: string; aiVerdict?: string } = {}): void {
  db.prepare(
    `INSERT INTO kit_ai_outcomes (report_id, read_id, decided_at, level, verdict, rule, severity, ai_verdict, agreement, detail_json)
     VALUES (?, ?, ?, 2, 'upheld', ?, 'hostile', ?, ?, '{}')`,
  ).run(report, readId, NOW - DAY, over.rule ?? '3', over.aiVerdict ?? 'upheld', over.agreement ?? 'agree');
}

/** A version-23 database with outcomes of every kind of history. */
function openAt23(db: DatabaseSync): void {
  const store = openStore({ db, migrations: UP_TO_23 });
  expect(store.schemaVersion()).toBe(23);
  insertReport(db, 'r1', 'mod_ann');
  insertReport(db, 'r2', 'mod_bea');
  insertReport(db, 'r3', 'mod_cy');
  insertReport(db, 'r4', 'mod_di');
  insertReport(db, 'r5', null);
  insertRead(db, { id: 'read1', report: 'r1' }); // a recommendation: rule 3, hostile
  insertRead(db, { id: 'read2', report: 'r2', rule: '5', severity: 'rude', rec: { verdict: 'upheld', severity: 'severe', rule: 7, evidence: [] }, confidence: 'medium' }); // read and recommendation differ
  insertRead(db, { id: 'read3', report: 'r3', rule: 'uncovered', rec: { verdict: 'no_action', severity: 'banter', rule: 'uncovered', evidence: [] } });
  insertRead(db, { id: 'read4', report: 'r4', injection: 1 }); // a suspected injection
  insertRead(db, { id: 'read5', report: 'r5', rec: null, rule: '4', severity: 'rude' }); // level 1: no recommendation
  insertOutcome(db, 'r1', 'read1');
  insertOutcome(db, 'r2', 'read2');
  insertOutcome(db, 'r3', 'read3', { agreement: 'override', aiVerdict: 'no_action' });
  insertOutcome(db, 'r4', 'read4');
  insertOutcome(db, 'r5', 'read5', { agreement: 'none' });
  insertOutcome(db, 'old1', 'read-purged-long-ago'); // the read is gone (reads live 90 days)
  insertOutcome(db, 'old2', null); // a decision made with no read in front of it
  store.close();
}

describe('migration 24: the casebook gains the gate columns', () => {
  it('is the 24th migration and the list is contiguous and append-only', () => {
    expect(M24).toBeDefined();
    expect(MIGRATIONS[23]?.version).toBe(24);
    expect(MIGRATIONS.map((m) => m.version).slice(0, 24)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    // Nothing earlier moved: the previous release's list is still a prefix of this one, byte for byte.
    expect(MIGRATIONS.slice(0, 23)).toEqual(UP_TO_23);
  });

  it('the migration is append-only: it adds columns and an index and drops or rebuilds nothing', () => {
    const sql = M24?.sql ?? '';
    expect(sql).not.toMatch(/\b(DROP|RENAME|DELETE)\b/i);
    const touched = new Set([...sql.matchAll(/\b(?:ALTER TABLE|ON|UPDATE)\s+(kit_\w+)/gi)].map((m) => m[1]));
    expect([...touched].sort()).toEqual(['kit_ai_outcomes']);
  });

  it('from an empty database the table has the five columns, the index and a CHECK on source', () => {
    const db = memDb();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    const cols = Object.fromEntries(info(db, 'kit_ai_outcomes').map((r) => [String(r.name), r]));
    for (const c of ['ai_rule', 'ai_severity', 'ai_confidence', 'decided_by']) expect(cols[c], c).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    expect(cols.source).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'human'" });
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_ai_outcomes_by_cell'").get();
    expect(String(idx?.sql)).toMatch(/ON kit_ai_outcomes \(ai_rule, ai_severity, decided_at\)/);
    insertOutcome(db, 'x', null);
    expect(db.prepare("SELECT source FROM kit_ai_outcomes WHERE report_id = 'x'").get()).toEqual({ source: 'human' });
    for (const ok of ['human', 'holdback', 'review']) expect(() => db.prepare("UPDATE kit_ai_outcomes SET source = ? WHERE report_id = 'x'").run(ok)).not.toThrow();
    for (const bad of ['ai', 'HUMAN', '', 'moderator']) expect(() => db.prepare("UPDATE kit_ai_outcomes SET source = ? WHERE report_id = 'x'").run(bad), bad).toThrow(/CHECK/);
  });

  it('the migration adds the columns, backfills them from a read that still exists and leaves older rows NULL', () => {
    const db = memDb();
    openAt23(db);
    openStore({ db }).close();
    const by = (id: string): Record<string, unknown> =>
      db.prepare('SELECT ai_rule, ai_severity, ai_confidence, decided_by, source FROM kit_ai_outcomes WHERE report_id = ?').get(id) ?? {};
    // the recommendation's own rule and conduct level, the read's confidence, the report's deciding moderator
    expect(by('r1')).toEqual({ ai_rule: '3', ai_severity: 'hostile', ai_confidence: 'high', decided_by: 'mod_ann', source: 'human' });
    expect(by('r2')).toEqual({ ai_rule: '7', ai_severity: 'severe', ai_confidence: 'medium', decided_by: 'mod_bea', source: 'human' });
    expect(by('r3')).toEqual({ ai_rule: 'uncovered', ai_severity: 'banter', ai_confidence: 'high', decided_by: 'mod_cy', source: 'human' });
    // a suspected injection never earns trust: the confidence is left out, so the row cannot qualify
    expect(by('r4')).toEqual({ ai_rule: '3', ai_severity: 'hostile', ai_confidence: null, decided_by: 'mod_di', source: 'human' });
    // no recommendation (level 1): the read's own rule and level
    expect(by('r5')).toEqual({ ai_rule: '4', ai_severity: 'rude', ai_confidence: 'high', decided_by: null, source: 'human' });
    // the read is gone, or there never was one: nothing to backfill, so the gates do not count the row
    for (const id of ['old1', 'old2']) expect(by(id)).toEqual({ ai_rule: null, ai_severity: null, ai_confidence: null, decided_by: null, source: 'human' });
  });

  it('every other column of every row is untouched, and the row count is the same', () => {
    const db = memDb();
    openAt23(db);
    const before = db.prepare('SELECT report_id, read_id, decided_at, level, verdict, rule, severity, ai_verdict, agreement, detail_json, reversed, dont_teach, bad_faith, example_json, corrective FROM kit_ai_outcomes ORDER BY report_id').all();
    openStore({ db }).close();
    const after = db.prepare('SELECT report_id, read_id, decided_at, level, verdict, rule, severity, ai_verdict, agreement, detail_json, reversed, dont_teach, bad_faith, example_json, corrective FROM kit_ai_outcomes ORDER BY report_id').all();
    expect(after).toEqual(before);
    expect(before).toHaveLength(7);
  });

  it('is idempotent on reopen: the second open runs nothing and changes nothing', () => {
    const db = memDb();
    openAt23(db);
    openStore({ db }).close();
    const first = db.prepare('SELECT * FROM kit_ai_outcomes ORDER BY report_id').all();
    const again = openStore({ db });
    expect(again.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(db.prepare('SELECT * FROM kit_ai_outcomes ORDER BY report_id').all()).toEqual(first);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('the database opens on the previous release reader: an older kit refuses a version-24 database, as it does for every newer schema', () => {
    const db = memDb();
    openStore({ db }).close();
    expect(() => openStore({ db, migrations: UP_TO_23 })).toThrow(/newer than this kit supports/);
  });

  it('a failing migration 24 rolls back whole: version 23, no new column, no index; it still upgrades afterwards', () => {
    const db = memDb();
    openAt23(db);
    const broken = [...UP_TO_23, { version: 24, sql: `${M24?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: UP_TO_23 }).schemaVersion()).toBe(23);
    expect(info(db, 'kit_ai_outcomes').map((r) => r.name)).not.toContain('ai_rule');
    expect(names(db, 'index')).not.toContain('kit_ai_outcomes_by_cell');
    expect(openStore({ db }).schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(info(db, 'kit_ai_outcomes').map((r) => r.name)).toContain('ai_rule');
  });

  it('the gate query reads kit_ai_outcomes through the by-cell index, in one statement', () => {
    const db = memDb();
    openStore({ db }).close();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${AI_GATE_ROWS_SQL}`).all(0, 0) as Array<{ detail: string }>;
    const text = plan.map((p) => p.detail).join('\n');
    expect(text).toMatch(/kit_ai_outcomes_by_cell/);
    expect(text).not.toMatch(/SCAN kit_ai_outcomes(?! USING)/);
  });

  it('the store answers over the backfilled rows: only a qualifying row with its read counts', () => {
    const db = memDb();
    openAt23(db);
    const store = openStore({ db });
    const rows = store.aiGateRows?.(NOW - 90 * DAY, NOW - 30 * DAY) ?? [];
    // r1 (3/hostile, upheld, high, agree) and r2 (7/severe but medium confidence: not qualifying); r3 is a no_action recommendation; r4 injected;
    // r5 level 1 (agreement none); old rows have no columns.
    expect(rows.map((r) => `${r.rule}/${r.severity}:${r.counts.qualifying}`)).toEqual(['3/hostile:1']);
    expect(rows[0]?.counts.deciders).toBe(1);
  });
});
