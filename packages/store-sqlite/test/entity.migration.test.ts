import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredReport } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';
import { insertOldReport } from './oldRows.js';

// Migration 26, the entity block (spec 4.5 and section 7): `kit_reports.entity_json`, the clan, guild or team a report is about as `{ kind, ref, label }`. Shared migration: the assertions are about this
// block's column only, never about the number of migrations or other themes' columns.

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
const UP_TO_25 = MIGRATIONS.slice(0, 25);
const columns = (db: DatabaseSync, table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));

const report = (id: string, i: number, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: NOW + i,
  roomId: `R${i}`,
  tags: {},
  reporterSubject: `s_r${i}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: 's_t',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'spam',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
  ...over,
});
const ENTITY = { kind: 'clan', ref: 'clan-4711', label: 'Blue Wolves' };

describe('migration 26, the entity block', () => {
  it('a 25 database upgrades: kit_reports.entity_json exists, and old rows read null', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_25 });
    expect(columns(db, 'kit_reports')).not.toContain('entity_json');
    insertOldReport(db, report('old1', 1));
    insertOldReport(db, report('old2', 2));
    const store = openStore({ db });
    expect(columns(db, 'kit_reports')).toContain('entity_json');
    expect(store.loadReport('old1')?.entity).toBeNull();
    expect(store.listReports({ limit: 10 }).map((r) => r.entity)).toEqual([null, null]);
    expect(db.prepare('SELECT entity_json FROM kit_reports').all().map((r) => r.entity_json)).toEqual([null, null]);
  });

  it('the column is plain nullable TEXT with no default', () => {
    const db = memDb();
    openStore({ db });
    const info = db.prepare('PRAGMA table_info(kit_reports)').all().find((c) => c.name === 'entity_json');
    expect(info).toBeDefined();
    expect(String(info?.type)).toBe('TEXT');
    expect(Number(info?.notnull)).toBe(0);
    expect(info?.dflt_value).toBeNull();
  });

  it('a database migrated from 25 has the same report columns as a fresh one', () => {
    const a = memDb();
    openStore({ db: a });
    const b = memDb();
    openStore({ db: b, migrations: UP_TO_25 });
    openStore({ db: b });
    expect(columns(b, 'kit_reports').sort()).toEqual(columns(a, 'kit_reports').sort());
  });

  it('a rerun of the block is refused: its statement fails on a database that already has the column', () => {
    const db = memDb();
    openStore({ db });
    const sql = MIGRATIONS.find((m) => m.version === 26)?.sql ?? '';
    expect(sql).toContain('entity_json');
    expect(() => db.exec(sql)).toThrow();
    expect(() => openStore({ db })).not.toThrow();
  });

  it('there is still exactly one migration after 25: the entity block is part of version 26', () => {
    expect(MIGRATIONS.filter((m) => m.version > 25).map((m) => m.version)).toEqual([26]);
  });
});

describe('the store reads and writes it', () => {
  it('insertReport writes the entity as JSON and a read gives it back as an object; a report without one is NULL', () => {
    const db = memDb();
    const store = openStore({ db });
    store.insertReport(report('a', 1, { entity: ENTITY }));
    store.insertReport(report('b', 2));
    store.insertReport(report('c', 3, { entity: null }));
    const raw = Object.fromEntries(db.prepare('SELECT id, entity_json FROM kit_reports').all().map((r) => [String(r.id), r.entity_json]));
    expect(JSON.parse(String(raw.a))).toEqual(ENTITY);
    expect(raw.b).toBeNull();
    expect(raw.c).toBeNull();
    expect(store.loadReport('a')?.entity).toEqual(ENTITY);
    expect(store.loadReport('b')?.entity).toBeNull();
    expect(store.listReports({ limit: 10 }).find((r) => r.id === 'a')?.entity).toEqual(ENTITY);
    expect(store.listOpenReportsByPerson(['s_t'], 10).find((r) => r.id === 'a')?.entity).toEqual(ENTITY);
  });

  it('a damaged entity_json reads as no entity and never fails the read', () => {
    const db = memDb();
    const store = openStore({ db });
    store.insertReport(report('a', 1, { entity: ENTITY }));
    db.prepare("UPDATE kit_reports SET entity_json = '{not json' WHERE id = 'a'").run();
    expect(store.loadReport('a')?.entity).toBeNull();
    db.prepare('UPDATE kit_reports SET entity_json = \'{"kind":5}\' WHERE id = \'a\'').run();
    expect(store.loadReport('a')?.entity).toBeNull();
  });

  it('the entity goes with its report when the report is deleted', () => {
    const db = memDb();
    const store = openStore({ db });
    store.insertReport(report('a', 1, { entity: ENTITY }));
    db.prepare("DELETE FROM kit_reports WHERE id = 'a'").run();
    expect(store.loadReport('a')).toBeNull();
  });
});
