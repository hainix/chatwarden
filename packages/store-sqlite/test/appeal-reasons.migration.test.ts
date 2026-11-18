import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppealRow } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';
import { NOTICE_BY_ID_SQL } from '../src/sqliteStore.js';

// Migration 27, block 2 (release 0.2.1, fixed reasons): `kit_appeals.reason_code`. The migration is shared by the whole release, so every assertion is about the
// schema AFTER it ran. The closed list lives in core: the column has no CHECK, so a later code needs no migration.

const NOW = 1_800_000_000_000;
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
const UP_TO_26 = MIGRATIONS.slice(0, 26);
const M27 = MIGRATIONS.find((m) => m.version === 27);
const columns = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => ({ name: String(r.name), type: String(r.type), notnull: Number(r.notnull), dflt: r.dflt_value }));

const appeal = (id: string, over: Partial<AppealRow> = {}): AppealRow => ({
  id,
  subject: 's_a',
  groupId: `g-${id}`,
  noticeId: `n-${id}`,
  reportId: null,
  rule: '2',
  kind: 'chat',
  statement: 'st',
  status: 'open',
  createdAt: NOW,
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  replacementGroupId: null,
  ...over,
});

describe('migration 27, block 2: kit_appeals.reason_code', () => {
  it('a fresh database has a nullable TEXT column with no default and no CHECK, after the old columns', () => {
    const db = memDb();
    openStore({ db });
    const cols = columns(db, 'kit_appeals');
    expect(cols.at(-1)).toEqual({ name: 'reason_code', type: 'TEXT', notnull: 0, dflt: null });
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_appeals'").get()?.sql)).not.toMatch(/reason_code[^,]*CHECK/i);
    // any text is accepted by the table: the closed list is the core's to check
    expect(() => db.prepare("UPDATE kit_appeals SET reason_code = 'anything'").run()).not.toThrow();
  });

  it('the migration carries a Block 2 label, and it is the same entry as block 1 (no 28)', () => {
    expect(M27?.sql ?? '').toMatch(/-- Block 1/);
    expect(M27?.sql ?? '').toMatch(/-- Block 2 \(appeals landing, fixed reasons\)/);
    expect(M27?.sql ?? '').toContain('ALTER TABLE kit_appeals ADD COLUMN reason_code TEXT;');
    expect(MIGRATIONS.find((m) => m.version === 28)).toBeUndefined();
  });

  it('a version 26 database with decided and open appeals upgrades: every row is untouched and reads without a code', () => {
    const db = memDb();
    const old = openStore({ db, migrations: UP_TO_26 });
    const ins = db.prepare(
      `INSERT INTO kit_appeals (id, subject_id, group_id, notice_id, report_id, rule, kind, statement, status, created_at, decided_at, decided_by, decision_reason, replacement_group_id)
       VALUES (?, 's_a', ?, ?, NULL, '2', 'chat', 'st', ?, ?, ?, ?, ?, NULL)`,
    );
    ins.run('open1', 'g1', 'n1', 'open', NOW, null, null, null);
    ins.run('done1', 'g2', 'n2', 'upheld', NOW, NOW + 5, 'senior_bea', 'private words');
    old.close();
    const before = db.prepare('SELECT * FROM kit_appeals ORDER BY id').all();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    const after = db.prepare('SELECT * FROM kit_appeals ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(after.map((r) => r.reason_code)).toEqual([null, null]);
    expect(after.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'reason_code')))).toEqual(before);
    // The rows read through the store with no reasonCode key at all, as before the release.
    for (const id of ['open1', 'done1']) expect(store.loadAppeal?.(id), id).not.toHaveProperty('reasonCode');
    expect(store.loadAppeal?.('done1')).toMatchObject({ status: 'upheld', decisionReason: 'private words' });
    store.close();
  });

  it('a failing statement appended to 27 leaves the database at 26 with no reason_code and the rows intact', () => {
    const db = memDb();
    const old = openStore({ db, migrations: UP_TO_26 });
    db.prepare(
      `INSERT INTO kit_appeals (id, subject_id, group_id, notice_id, report_id, rule, kind, statement, status, created_at) VALUES ('open1', 's_a', 'g1', 'n1', NULL, '2', 'chat', 'st', 'open', 1)`,
    ).run();
    old.close();
    const broken = [...UP_TO_26, { version: 27, sql: `${M27?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: UP_TO_26 }).schemaVersion()).toBe(26);
    expect(columns(db, 'kit_appeals').map((c) => c.name)).not.toContain('reason_code');
    expect(db.prepare('SELECT COUNT(*) AS n FROM kit_appeals').get()).toEqual({ n: 1 });
    expect(openStore({ db }).schemaVersion()).toBe(27);
  });
});

describe('the store writes and reads the code', () => {
  it('decideAppeal writes it as given (one UPDATE), insertAppeal keeps one it is given, and the key is absent when there is none', () => {
    const db = memDb();
    const store = openStore({ db });
    store.insertAppeal?.(appeal('a1'));
    store.insertAppeal?.(appeal('a2'));
    store.insertAppeal?.(appeal('a3', { status: 'revoked', decidedAt: NOW, decidedBy: 'x', decisionReason: 'r', reasonCode: 'mistake' }));
    expect(store.decideAppeal?.('a1', { status: 'upheld', at: NOW + 1, by: 'senior_bea', reason: 'r', replacementGroupId: null, reasonCode: 'evidence_clear' })).toBe(true);
    expect(store.decideAppeal?.('a2', { status: 'upheld', at: NOW + 1, by: 'senior_bea', reason: 'r', replacementGroupId: null })).toBe(true);
    expect(store.loadAppeal?.('a1')?.reasonCode).toBe('evidence_clear');
    expect(store.loadAppeal?.('a2')).not.toHaveProperty('reasonCode');
    expect(store.loadAppeal?.('a3')?.reasonCode).toBe('mistake');
    expect(db.prepare('SELECT id, reason_code FROM kit_appeals ORDER BY id').all()).toEqual([
      { id: 'a1', reason_code: 'evidence_clear' },
      { id: 'a2', reason_code: null },
      { id: 'a3', reason_code: 'mistake' },
    ]);
    // a second decision (the row is no longer open) changes no code
    expect(store.decideAppeal?.('a1', { status: 'revoked', at: NOW + 2, by: 'other', reason: 'r2', replacementGroupId: null, reasonCode: 'mistake' })).toBe(false);
    expect(store.loadAppeal?.('a1')?.reasonCode).toBe('evidence_clear');
  });

  it('loadNotice is one SELECT by id with a single placeholder', () => {
    expect((NOTICE_BY_ID_SQL.replace(/'[^']*'/g, '').match(/\?/g) ?? []).length).toBe(1);
    expect(NOTICE_BY_ID_SQL).not.toMatch(/\?\d/);
    const db = memDb();
    openStore({ db });
    expect(db.prepare(`EXPLAIN QUERY PLAN ${NOTICE_BY_ID_SQL}`).all('x').map((r) => String(r.detail)).join(' | ')).toMatch(/SEARCH kit_notices USING (COVERING )?INDEX|PRIMARY KEY/i);
  });
});
