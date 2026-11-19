import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SanctionRow, StoredReport } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';
import { insertOldReport, insertOldSanction } from './oldRows.js';

// Migration 27, block 1 (release 0.2.1, appeals landing): the overturn columns on kit_sanctions, kit_strikes and kit_reports, the kit_overturns table with its four
// indexes, and the reporter-outcome index that gains `overturned_at`. The migration is shared by the whole release (each task appends a labelled block), so every
// assertion is about the schema AFTER it ran (set membership), never about the number being the last.

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
const names = (db: DatabaseSync, type: 'table' | 'index'): string[] =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`).all().map((r) => String(r.name));
const info = (db: DatabaseSync, table: string): Record<string, { type: string; notnull: number; dflt: unknown; pk: number }> =>
  Object.fromEntries(
    db.prepare(`PRAGMA table_info(${table})`).all().map((r) => [String(r.name), { type: String(r.type), notnull: Number(r.notnull), dflt: r.dflt_value, pk: Number(r.pk) }]),
  );
const columns = (db: DatabaseSync, table: string): string[] => Object.keys(info(db, table));
const dump = (db: DatabaseSync, table: string, order: string): Array<Record<string, unknown>> => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
const ddl = (db: DatabaseSync, name: string): string => String(db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name)?.sql);

const sanction = (i: number): SanctionRow => ({
  id: `sr${i}`,
  groupId: `g${i}`,
  refCode: `M-${String(i).padStart(5, '0')}`,
  kind: 'chat',
  targetType: 'subject',
  value: `s_${i}`,
  startsAt: NOW - i,
  endsAt: NOW + 1000,
  reason: 'private',
  rule: '2',
  gapNote: null,
  gapStatus: null,
  roomId: null,
  actor: 'chat_filter',
  source: 'auto_filter',
  automated: true,
  pending: false,
});
const report = (i: number): StoredReport => ({
  id: `r${i}`,
  createdAt: NOW - i,
  roomId: `ROOM-${i}`,
  tags: {},
  reporterSubject: `s_rep${i}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: `s_tgt${i}`,
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'spam',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  // The type only knows `open`; the version-26 row is stored as decided, as an upheld report is.
  status: 'actioned' as unknown as 'open',
});

/** A version-26 database with rows in every table the migration touches. */
function seeded26(db: DatabaseSync): void {
  const old = openStore({ db, migrations: UP_TO_26 });
  expect(old.schemaVersion()).toBe(26);
  for (let i = 0; i < 6; i++) {
    insertOldSanction(db, sanction(i));
    insertOldReport(db, report(i));
    db.prepare('INSERT INTO kit_strikes (id, at, subject_id, room_id, term_id, raw_line) VALUES (?, ?, ?, ?, ?, ?)').run(`k${i}`, NOW - i, `s_${i}`, 'ROOM1', `t${i % 2}`, 'a line');
  }
  old.close();
}

describe('migration 27 (release 0.2.1), block 1: overturn storage', () => {
  it('versions run 1..N without a gap, 27 is release 0.2.1, and 28 (release 0.2.2) is the last', () => {
    expect(M27).toBeDefined();
    expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
    expect(MIGRATIONS.find((m) => m.version === 29)).toBeUndefined();
  });

  it('a fresh database has the columns, the table and its four indexes, and the new covering index replaces the old one', () => {
    const db = memDb();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(info(db, 'kit_sanctions').term_id).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(info(db, 'kit_sanctions').overturned_at).toMatchObject({ type: 'INTEGER', notnull: 0 });
    expect(info(db, 'kit_strikes').overturned).toMatchObject({ type: 'INTEGER', notnull: 1, dflt: '0' });
    expect(info(db, 'kit_reports').overturned_at).toMatchObject({ type: 'INTEGER', notnull: 0 });
    expect(columns(db, 'kit_overturns')).toEqual(['group_id', 'at', 'subject_id', 'source', 'term_id', 'filter_key', 'report_id']);
    expect(info(db, 'kit_overturns').group_id?.pk).toBe(1);
    for (const c of ['group_id', 'at', 'subject_id', 'source']) expect(info(db, 'kit_overturns')[c]?.notnull, c).toBe(1);
    for (const c of ['term_id', 'filter_key', 'report_id']) expect(info(db, 'kit_overturns')[c]?.notnull, c).toBe(0);
    expect(ddl(db, 'kit_overturns')).toMatch(/WITHOUT ROWID/);
    expect(names(db, 'index')).toEqual(
      expect.arrayContaining(['kit_overturns_by_term', 'kit_overturns_by_filter', 'kit_overturns_by_subject', 'kit_overturns_by_at', 'kit_reports_by_reporter_outcome_overturned']),
    );
    expect(names(db, 'index')).not.toContain('kit_reports_by_reporter_outcome_reason');
    expect(ddl(db, 'kit_overturns_by_term')).toMatch(/\(term_id, at\)\s+WHERE term_id IS NOT NULL/);
    expect(ddl(db, 'kit_overturns_by_filter')).toMatch(/\(filter_key, at\)\s+WHERE filter_key IS NOT NULL/);
    expect(ddl(db, 'kit_overturns_by_subject')).toMatch(/\(subject_id\)/);
    expect(ddl(db, 'kit_overturns_by_at')).toMatch(/\(at\)/);
    expect(ddl(db, 'kit_reports_by_reporter_outcome_overturned')).toMatch(/\(reporter_subject, created_at, status, bad_faith, reported_reason, overturned_at\)/);
  });

  it('the migration 19 reporter index stays: the open-reports-by-reporter read names it (INDEXED BY), so dropping it would break that read (m7 check)', () => {
    const db = memDb();
    const store = openStore({ db });
    expect(names(db, 'index')).toContain('kit_reports_by_reporter_outcome');
    store.insertReport({
      id: 'r1', createdAt: NOW, roomId: 'R', tags: {}, reporterSubject: 's_rep', reporterSeat: 'p1', reporterHandle: 'Rep', targetSubject: 's_t', targetSeat: 'p2', targetHandle: 'T',
      category: 'spam', note: null, lineId: null, excerpt: [], people: [], status: 'open',
    } as StoredReport);
    expect(store.listOpenReportsByReporter?.(['s_rep'], 10).map((r) => r.id)).toEqual(['r1']);
    // and the source keeps saying so, so a later change to either side shows in review
    expect(String(MIGRATIONS.find((m) => m.version === 27)?.sql ?? '')).not.toMatch(/DROP INDEX kit_reports_by_reporter_outcome(?!_)/);
  });

  it('the strike flag refuses a value other than 0 or 1', () => {
    const db = memDb();
    openStore({ db });
    const insert = (flag: number) => () =>
      db.prepare('INSERT INTO kit_strikes (id, at, subject_id, room_id, term_id, raw_line, overturned) VALUES (?, 1, ?, ?, ?, ?, ?)').run(`k${flag}`, 's_a', 'R', 't', 'l', flag);
    expect(insert(0)).not.toThrow();
    expect(insert(1)).not.toThrow();
    expect(insert(2)).toThrow(/CHECK/i);
  });

  it('a version 26 database with rows upgrades: every old row and column is untouched and the new columns start empty', () => {
    const db = memDb();
    seeded26(db);
    const before = {
      kit_sanctions: dump(db, 'kit_sanctions', 'rowid'),
      kit_strikes: dump(db, 'kit_strikes', 'rowid'),
      kit_reports: dump(db, 'kit_reports', 'rowid'),
    };
    const tables = names(db, 'table');
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    for (const [table, rows] of Object.entries(before)) {
      const after = dump(db, table, 'rowid');
      expect(after, table).toHaveLength(rows.length);
      expect(rows.length).toBe(6);
      const old = Object.keys(rows[0] ?? {});
      expect(after.map((r) => Object.fromEntries(old.map((c) => [c, r[c]]))), table).toEqual(rows);
    }
    expect(dump(db, 'kit_sanctions', 'rowid').map((r) => [r.term_id, r.overturned_at])).toEqual(Array.from({ length: 6 }, () => [null, null]));
    expect(dump(db, 'kit_strikes', 'rowid').map((r) => r.overturned)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(dump(db, 'kit_reports', 'rowid').map((r) => r.overturned_at)).toEqual(Array.from({ length: 6 }, () => null));
    expect(names(db, 'table').filter((n) => !tables.includes(n))).toContain('kit_overturns');
    expect(dump(db, 'kit_overturns', 'group_id')).toEqual([]);
    // the old rows still read through the store
    expect(store.loadStrikes(0)).toHaveLength(6);
    expect(store.loadSanctionSubjectRow?.('g3')).toMatchObject({ groupId: 'g3', termId: null });
    expect(store.reporterOutcomes?.(['s_rep2'], 0)).toEqual([{ reporter: 's_rep2', actioned: 1, noAction: 0, badFaith: 0, overturned: 0 }]);
    store.close();
    // reopening runs nothing again and changes nothing
    const again = openStore({ db });
    expect(dump(db, 'kit_strikes', 'rowid').map((r) => r.id)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5']);
    again.close();
  });

  it('a rerun of the block is refused: its statements fail on a database that already has them', () => {
    const db = memDb();
    openStore({ db });
    expect(() => db.exec(M27?.sql ?? '')).toThrow();
    expect(() => openStore({ db })).not.toThrow();
  });

  it('a fresh database lands on the same schema as an upgraded one', () => {
    const a = memDb();
    openStore({ db: a });
    const b = memDb();
    openStore({ db: b, migrations: UP_TO_26 }).close();
    openStore({ db: b });
    expect(names(b, 'table')).toEqual(names(a, 'table'));
    expect(names(b, 'index')).toEqual(names(a, 'index'));
    for (const t of ['kit_sanctions', 'kit_strikes', 'kit_reports', 'kit_overturns']) expect(columns(b, t).sort()).toEqual(columns(a, t).sort());
  });

  it('a failing statement appended to 27 leaves the database at 26, rows intact and nothing new, and it still upgrades afterwards', () => {
    const db = memDb();
    seeded26(db);
    const broken = [...UP_TO_26, { version: 27, sql: `${M27?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: UP_TO_26 }).schemaVersion()).toBe(26);
    expect(columns(db, 'kit_sanctions')).not.toContain('term_id');
    expect(columns(db, 'kit_strikes')).not.toContain('overturned');
    expect(columns(db, 'kit_reports')).not.toContain('overturned_at');
    expect(names(db, 'table')).not.toContain('kit_overturns');
    expect(names(db, 'index')).not.toContain('kit_overturns_by_at');
    expect(names(db, 'index')).toContain('kit_reports_by_reporter_outcome_reason');
    expect(names(db, 'index')).not.toContain('kit_reports_by_reporter_outcome_overturned');
    expect(dump(db, 'kit_strikes', 'rowid')).toHaveLength(6);
    expect(openStore({ db }).schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('the migration carries a comment block naming the release and block 1', () => {
    expect(M27?.sql ?? '').toContain('kit_overturns');
    expect(M27?.sql ?? '').toMatch(/-- Block 1/);
  });
});
