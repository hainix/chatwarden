import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiOutcomeInsert, NoticeKind, NoticeRow } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';
import type { SqliteStore } from '../src/index.js';

// Migration 22: appeals, blocked names, a rebuilt kit_notices (four new kinds), two ALTERs. One-way, wrapped by the runner in one savepoint
// with the version bump. Tested from a version-21 database with data, including notices of every old kind.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const UP_TO_21 = MIGRATIONS.slice(0, 21);
const M22 = MIGRATIONS.find((m) => m.version === 22);

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
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
const filePath = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-appmig-'));
  dirs.push(d);
  return join(d, 'kit.db');
};

const names = (db: DatabaseSync, type: 'table' | 'index'): string[] =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`).all().map((r) => String(r.name));
const columns = (db: DatabaseSync, table: string): string[] =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
const columnInfo = (db: DatabaseSync, table: string): unknown[] => db.prepare(`PRAGMA table_info(${table})`).all();
const dump = (db: DatabaseSync, table: string, order: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
const indexSql = (db: DatabaseSync, table: string): unknown[] =>
  db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(table);

const OLD_KINDS: NoticeKind[] = ['warning', 'chat', 'area', 'ban', 'report_outcome'];
const NEW_KINDS = ['rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked'] as const;
const NOTICE_INDEXES = ['kit_notices_by_created', 'kit_notices_by_group', 'kit_notices_by_subject'];
const APPEAL_INDEXES = ['kit_appeals_by_group', 'kit_appeals_by_rule', 'kit_appeals_by_status', 'kit_appeals_by_subject'];
const APPEAL_COLUMNS = [
  'id', 'subject_id', 'group_id', 'notice_id', 'report_id', 'rule', 'kind', 'statement', 'status', 'created_at', 'decided_at', 'decided_by',
  'decision_reason', 'replacement_group_id',
];

const notice = (i: number, kind: NoticeKind, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id: `n${String(i).padStart(3, '0')}`,
  subject: `s_${i % 4}`,
  groupId: kind === 'report_outcome' ? null : `g${i}`,
  kind,
  rule: kind === 'report_outcome' ? null : String((i % 3) + 1),
  until: kind === 'chat' || kind === 'area' ? NOW + DAY : null,
  refCode: kind === 'report_outcome' ? null : `M-${String(i).padStart(5, '0')}`,
  excerpt: kind === 'report_outcome' ? [] : [{ text: `line ${i}`, day: '2027-01-14' }],
  createdAt: NOW - i * 1000,
  ackedAt: i % 3 === 0 ? NOW : null,
  withdrawnAt: i % 7 === 0 ? NOW : null,
  ...over,
});

/** A sanction row written the way the kit wrote it before migration 22: no report_id column. */
function insertOldSanction(db: DatabaseSync, o: { id: string; group: string; ref: string; kind?: string; target?: 'subject' | 'ip'; source?: string; value?: string }): void {
  db.prepare(
    `INSERT INTO kit_sanctions
       (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'r', '2', 'mod', ?, 0, 0)`,
  ).run(o.id, o.group, o.ref, o.kind ?? 'chat', o.target ?? 'subject', o.value ?? 's_a', NOW, NOW + DAY, o.source ?? 'moderator');
}

const outcome = (i: number): AiOutcomeInsert => ({
  reportId: `rep${i}`,
  readId: null,
  decidedAt: NOW - i * DAY,
  level: 1,
  verdict: 'upheld',
  rule: '2',
  severity: null,
  aiVerdict: 'upheld',
  agreement: 'agree',
  detail: {} as never,
  badFaith: false,
  example: null,
});

/** A database at version 21 with notices of every old kind, sanctions, decisions, AI outcomes and an audit row. */
function openAt21(db: DatabaseSync): SqliteStore {
  const store = openStore({ db, migrations: UP_TO_21 });
  expect(store.schemaVersion()).toBe(21);
  OLD_KINDS.forEach((kind, i) => store.insertNotice(notice(i + 1, kind)));
  // a few more, so the rowid order and a gap (a deleted row) show
  for (let i = 6; i <= 20; i++) store.insertNotice(notice(i, OLD_KINDS[i % 5] as NoticeKind));
  db.prepare("DELETE FROM kit_notices WHERE id = 'n003'").run();
  for (let i = 0; i < 3; i++) store.insertAiOutcome(outcome(i));
  store.insertAudit({ id: 'a1', at: NOW, actor: 'mod', role: 'moderator', action: 'report.view', target: { type: 'report', ref: 'm1' } });
  return store;
}
const OLD_TABLES = ['kit_notices', 'kit_ai_outcomes', 'kit_audit', 'kit_decisions', 'kit_sanctions'];
const snapshot = (db: DatabaseSync): unknown => ({
  notices: dump(db, 'kit_notices', 'rowid'),
  outcomes: dump(db, 'kit_ai_outcomes', 'report_id'),
  audit: dump(db, 'kit_audit', 'rowid'),
  meta: db.prepare("SELECT key, value FROM kit_meta WHERE key <> 'schema_version' ORDER BY key").all(),
});

describe('migration 22: appeals, blocked names, four notice kinds', () => {
  it('is the 22nd migration and the last one', () => {
    expect(M22).toBeDefined();
    expect(MIGRATIONS[21]?.version).toBe(22);
    expect(MIGRATIONS.at(-1)?.version).toBe(22);
    expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
  });

  it('from an empty database creates kit_appeals with four indexes and kit_blocked_names; kit_ai_outcomes gains corrective defaulting to 0; kit_sanctions gains report_id', () => {
    const db = memDb();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(22);
    expect(names(db, 'table')).toEqual(expect.arrayContaining(['kit_appeals', 'kit_blocked_names']));
    expect(columns(db, 'kit_appeals')).toEqual(APPEAL_COLUMNS);
    for (const i of [...APPEAL_INDEXES, 'kit_blocked_names_by_at']) expect(names(db, 'index')).toContain(i);
    expect(indexSql(db, 'kit_appeals').map((r) => (r as { name: string }).name)).toEqual(APPEAL_INDEXES);
    expect(String((indexSql(db, 'kit_appeals').find((r) => (r as { name: string }).name === 'kit_appeals_by_group') as { sql: string }).sql)).toMatch(/UNIQUE INDEX kit_appeals_by_group\s+ON kit_appeals \(group_id\)/);
    expect(columns(db, 'kit_blocked_names')).toEqual(['id', 'subject_id', 'name', 'term_id', 'reason', 'at']);
    const corrective = db.prepare('PRAGMA table_info(kit_ai_outcomes)').all().find((r) => r.name === 'corrective');
    expect(corrective).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    expect(columns(db, 'kit_sanctions')).toContain('report_id');
    expect(db.prepare('SELECT COUNT(*) AS n FROM kit_appeals').get()).toEqual({ n: 0 });
  });

  it('from a version-21 database with notices of every old kind keeps each row with the same id, order and indexes; the new CHECK accepts the four kinds and refuses a fifth', () => {
    const db = memDb();
    openAt21(db).close();
    const before = snapshot(db);
    const noticeCols = columnInfo(db, 'kit_notices');
    const noticeIdx = indexSql(db, 'kit_notices');
    const tables = names(db, 'table');
    expect((before as { notices: Array<{ kind: string }> }).notices.map((r) => r.kind)).toEqual(expect.arrayContaining(OLD_KINDS));

    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(22);
    expect(snapshot(db)).toEqual({ ...(before as object), outcomes: (before as { outcomes: Array<Record<string, unknown>> }).outcomes.map((r) => ({ ...r, corrective: 0 })) });
    // the live schema survives the rebuild: the same columns (names, types, nullability, defaults, primary key) and the same three indexes, byte for byte
    expect(columnInfo(db, 'kit_notices')).toEqual(noticeCols);
    expect(indexSql(db, 'kit_notices')).toEqual(noticeIdx);
    expect(names(db, 'index').filter((i) => i.startsWith('kit_notices'))).toEqual(NOTICE_INDEXES);
    expect(names(db, 'table').filter((x) => !tables.includes(x))).toEqual(['kit_appeals', 'kit_blocked_names']);
    // the same rows through the store, in the same order
    expect(store.loadNotices(['s_0', 's_1', 's_2', 's_3']).map((r) => r.id)).toEqual(
      (before as { notices: Array<{ id: string; created_at: number }> }).notices
        .map((r, i) => ({ id: r.id, at: r.created_at, i }))
        .sort((a, b) => a.at - b.at || a.i - b.i)
        .map((r) => r.id),
    );

    // the four new kinds are accepted ...
    NEW_KINDS.forEach((kind, i) => store.insertNotice(notice(100 + i, kind, { groupId: null, until: null, excerpt: [], ackedAt: null, withdrawnAt: null })));
    for (const kind of NEW_KINDS) expect(db.prepare('SELECT COUNT(*) AS n FROM kit_notices WHERE kind = ?').get(kind)).toEqual({ n: 1 });
    // ... a fifth, and an old-kind row beside them, are not
    expect(() => store.insertNotice(notice(200, 'bogus' as NoticeKind))).toThrow(/CHECK/);
    expect(() => store.insertNotice(notice(201, '' as NoticeKind))).toThrow(/CHECK/);
    expect(() => store.insertNotice(notice(202, 'appeal_moot' as NoticeKind))).toThrow(/CHECK/);
    expect(() => store.insertNotice(notice(203, 'warning'))).not.toThrow();
    store.close();

    // Reopening runs nothing again and changes nothing.
    const again = openStore({ db });
    expect(again.schemaVersion()).toBe(22);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('the rebuilt table keeps its rowid order for the next insert: a new notice sorts after every old one with the same time', () => {
    const db = memDb();
    openAt21(db).close();
    const store = openStore({ db });
    const sameTime = NOW - 1000;
    store.insertNotice(notice(300, 'appeal_upheld', { subject: 's_1', createdAt: sameTime, groupId: null, until: null, excerpt: [], ackedAt: null, withdrawnAt: null }));
    const ids = store.loadNotices(['s_1']).filter((r) => r.createdAt === sameTime).map((r) => r.id);
    expect(ids[ids.length - 1]).toBe('n300');
  });

  it('the backfill links a moderator sanction to its decided report, leaves unmatched and automatic rows NULL, and is idempotent', () => {
    const db = memDb();
    const old = openStore({ db, migrations: UP_TO_21 });
    // decided: a group in a decision's result_json, with a subject row and an IP row; a second decision names two groups
    insertOldSanction(db, { id: 'a1', group: 'grp-decided', ref: 'M-AAAAA' });
    insertOldSanction(db, { id: 'a2', group: 'grp-decided', ref: 'M-AAAAA', target: 'ip', value: 'iphash' });
    insertOldSanction(db, { id: 'b1', group: 'grp-two-a', ref: 'M-BBBBB' });
    insertOldSanction(db, { id: 'b2', group: 'grp-two-b', ref: 'M-CCCCC' });
    // unmatched: a moderator sanction with no decision (a direct apply), an automatic one whose group id happens to sit in a decision, an api one
    insertOldSanction(db, { id: 'c1', group: 'grp-direct', ref: 'M-DDDDD' });
    insertOldSanction(db, { id: 'd1', group: 'grp-auto', ref: 'M-EEEEE', source: 'auto_filter' });
    insertOldSanction(db, { id: 'e1', group: 'grp-api', ref: 'M-FFFFF', source: 'api' });
    old.insertDecision('k1', 'rep_one', NOW, JSON.stringify({ groups: [{ subject: 's_a', groupId: 'grp-decided', refCode: 'M-AAAAA', kind: 'chat', noticeId: 'n1' }] }));
    old.insertDecision('k2', 'rep_two', NOW, JSON.stringify({ groups: [{ groupId: 'grp-two-a' }, { groupId: 'grp-two-b' }, { groupId: 'grp-auto' }] }));
    old.close();

    const store = openStore({ db });
    const reportIds = (): Record<string, string | null> =>
      Object.fromEntries(db.prepare('SELECT id, report_id FROM kit_sanctions ORDER BY id').all().map((r) => [String(r.id), r.report_id === null ? null : String(r.report_id)]));
    expect(reportIds()).toEqual({ a1: 'rep_one', a2: null, b1: 'rep_two', b2: 'rep_two', c1: null, d1: null, e1: null });
    // the sanctions read back as before: the generic loads do not carry the new column
    expect(store.loadSubjectActions(0).every((r) => !('reportId' in r))).toBe(true);
    expect(store.loadSanctionSubjectRow('grp-decided')?.reportId).toBe('rep_one');
    expect(store.loadSanctionSubjectRow('grp-direct')?.reportId).toBeUndefined();
    store.close();
    // idempotent: another open leaves every value alone, and re-running the UPDATE by hand changes nothing
    openStore({ db }).close();
    expect(reportIds()).toEqual({ a1: 'rep_one', a2: null, b1: 'rep_two', b2: 'rep_two', c1: null, d1: null, e1: null });
    const stmt = M22?.sql.match(/UPDATE kit_sanctions SET report_id[\s\S]*?;/)?.[0];
    expect(stmt).toBeDefined();
    db.exec(stmt ?? '');
    expect(reportIds()).toEqual({ a1: 'rep_one', a2: null, b1: 'rep_two', b2: 'rep_two', c1: null, d1: null, e1: null });
  });

  it('rows already in kit_ai_outcomes stay readable, and corrective reads 0', () => {
    const db = memDb();
    const old = openAt21(db);
    const before = [0, 1, 2].map((i) => old.loadAiOutcome(`rep${i}`));
    expect(before.every((r) => r !== null)).toBe(true);
    old.close();
    const store = openStore({ db });
    expect([0, 1, 2].map((i) => store.loadAiOutcome(`rep${i}`))).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n, SUM(corrective) AS c FROM kit_ai_outcomes').get()).toEqual({ n: 3, c: 0 });
    // a new outcome after the upgrade works as before
    expect(store.insertAiOutcome(outcome(9))).toBe(true);
  });

  it('kit_appeals CHECKs refuse an unknown kind or status; kit_blocked_names CHECK refuses an unknown reason', () => {
    const db = memDb();
    openStore({ db }).close();
    const put = (kind: string, status: string, id: string, group: string) =>
      db
        .prepare("INSERT INTO kit_appeals (id, subject_id, group_id, notice_id, kind, status, created_at) VALUES (?, 's', ?, 'n', ?, ?, 1)")
        .run(id, group, kind, status);
    expect(() => put('note', 'open', 'a1', 'g1')).toThrow(/CHECK/);
    expect(() => put('ip', 'open', 'a2', 'g2')).toThrow(/CHECK/);
    expect(() => put('chat', 'pending', 'a3', 'g3')).toThrow(/CHECK/);
    expect(() => put('chat', 'decided', 'a4', 'g4')).toThrow(/CHECK/);
    for (const [i, status] of (['open', 'upheld', 'reduced', 'revoked', 'moot'] as const).entries()) expect(() => put('warning', status, `ok${i}`, `gok${i}`)).not.toThrow();
    for (const [i, kind] of (['warning', 'chat', 'area', 'ban'] as const).entries()) expect(() => put(kind, 'open', `k${i}`, `gk${i}`)).not.toThrow();
    // one appeal per group
    expect(() => put('chat', 'open', 'dup', 'gok0')).toThrow(/UNIQUE/);
    const name = (reason: string, id: string) => db.prepare("INSERT INTO kit_blocked_names (id, name, reason, at) VALUES (?, 'x', ?, 1)").run(id, reason);
    expect(() => name('rude', 'b1')).toThrow(/CHECK/);
    expect(() => name('name_not_allowed', 'b2')).not.toThrow();
    expect(() => name('name_profane', 'b3')).not.toThrow();
  });

  it('a rerun of the migration is refused (it is one-way)', () => {
    const db = memDb();
    openStore({ db }).close();
    expect(() => db.exec(M22?.sql ?? '')).toThrow();
    expect(names(db, 'index').filter((x) => x === 'kit_appeals_by_group')).toHaveLength(1);
  });

  it('a version 18 database with rows upgrades through 22 without changing data', () => {
    const db = memDb();
    const s = openStore({ db, migrations: MIGRATIONS.slice(0, 18) });
    s.insertNotice(notice(1, 'warning'));
    s.insertNotice(notice(2, 'report_outcome'));
    s.close();
    const before = dump(db, 'kit_notices', 'rowid');
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(22);
    expect(dump(db, 'kit_notices', 'rowid')).toEqual(before);
  });

  it('is idempotent on a file: reopening twice leaves the same schema and rows', () => {
    const path = filePath();
    const seeded = new DatabaseSync(path);
    dbs.push(seeded);
    openAt21(seeded).close();
    openStore({ path }).close();
    const shot = (): unknown => {
      const raw = new DatabaseSync(path);
      try {
        return { data: snapshot(raw), tables: names(raw, 'table'), indexes: names(raw, 'index') };
      } finally {
        raw.close();
      }
    };
    const once = shot();
    openStore({ path }).close();
    openStore({ path }).close();
    expect(shot()).toEqual(once);
  });

  it('a fresh database lands on the same tables, indexes and columns as an upgraded one', () => {
    const fresh = memDb();
    openStore({ db: fresh });
    const upgraded = memDb();
    openAt21(upgraded).close();
    openStore({ db: upgraded });
    expect(names(fresh, 'table')).toEqual(names(upgraded, 'table'));
    expect(names(fresh, 'index')).toEqual(names(upgraded, 'index'));
    for (const t of [...OLD_TABLES, 'kit_appeals', 'kit_blocked_names']) expect(columnInfo(fresh, t), t).toEqual(columnInfo(upgraded, t));
    expect(indexSql(fresh, 'kit_notices')).toEqual(indexSql(upgraded, 'kit_notices'));
  });

  it('a failing migration 22 rolls back whole: version 21, the old notices table and indexes, no new table, no column, rows intact; it still upgrades afterwards', () => {
    const db = memDb();
    openAt21(db).close();
    const before = snapshot(db);
    const noticeCols = columnInfo(db, 'kit_notices');
    const noticeIdx = indexSql(db, 'kit_notices');
    const sanctionCols = columns(db, 'kit_sanctions');
    const broken = [...UP_TO_21, { version: 22, sql: `${M22?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: UP_TO_21 }).schemaVersion()).toBe(21);
    expect(names(db, 'table')).not.toEqual(expect.arrayContaining(['kit_appeals']));
    expect(names(db, 'table')).not.toContain('kit_notices_v22');
    expect(columnInfo(db, 'kit_notices')).toEqual(noticeCols);
    expect(indexSql(db, 'kit_notices')).toEqual(noticeIdx);
    expect(columns(db, 'kit_sanctions')).toEqual(sanctionCols);
    expect(columns(db, 'kit_ai_outcomes')).not.toContain('corrective');
    expect(snapshot(db)).toEqual(before);
    expect(openStore({ db }).schemaVersion()).toBe(22);
    expect(names(db, 'table')).toContain('kit_appeals');
  });

  it('an older kit refuses a database at version 22', () => {
    const db = memDb();
    openStore({ db }).close();
    expect(() => openStore({ db, migrations: UP_TO_21 })).toThrow(/newer than this kit supports/);
  });

  it('the shared contract works on an upgraded database too', () => {
    const db = memDb();
    openAt21(db).close();
    const store = openStore({ db });
    const row = {
      id: 'ap1', subject: 's_a', groupId: 'g1', noticeId: 'n1', reportId: null, rule: '2', kind: 'chat' as const, statement: 'hi', status: 'open' as const,
      createdAt: NOW, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null,
    };
    expect(store.insertAppeal(row)).toBe(true);
    expect(store.insertAppeal({ ...row, id: 'ap2' })).toBe(false);
    expect(store.loadAppeal('ap1')).toEqual(row);
    expect(store.decideAppeal('ap1', { status: 'upheld', at: NOW + 1, by: 'bea', reason: 'r', replacementGroupId: null })).toBe(true);
    expect(store.countOpenAppeals()).toBe(0);
  });
});
