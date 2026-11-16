import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinkRow } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

// Migration 23: `kit_links` and `kit_links_by_state` (K5 design 5.1), one additive table. Tested from a version-22 database with data.
// The behaviour both stores share is in the shared contract suite (test/contract/links.contract.ts, run by contract.test.ts).

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const UP_TO_22 = MIGRATIONS.slice(0, 22);
const M23 = MIGRATIONS.find((m) => m.version === 23);

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
const columnInfo = (db: DatabaseSync, table: string): unknown[] => db.prepare(`PRAGMA table_info(${table})`).all();
const dump = (db: DatabaseSync, table: string, order: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
const link = (over: Partial<LinkRow> = {}): LinkRow => ({ system: 'coop-report', ref: 'r1', external: 'job-zorbak-1', state: 'sent', at: NOW, ...over });

/** A database at version 22 with a sanction, an audit row and a notice's worth of neighbours in the older tables. */
function openAt22(db: DatabaseSync) {
  const store = openStore({ db, migrations: UP_TO_22 });
  store.insertSanctionGroup([
    {
      id: 'row1', groupId: 'g1', refCode: 'M-AAAAA', kind: 'chat', targetType: 'subject', value: 's_a', startsAt: NOW, endsAt: NOW + DAY,
      reason: 'r', rule: '1', gapNote: null, gapStatus: null, roomId: null, actor: 'mod', source: 'moderator', automated: false, pending: false,
    },
  ]);
  store.insertAudit({ id: 'a1', at: NOW, actor: 'mod', role: 'moderator', action: 'report.view', target: { type: 'report', ref: 'm1' } });
  return store;
}

describe('migration 23: kit_links', () => {
  it('is the 23rd migration and the next after the 22nd', () => {
    expect(M23).toBeDefined();
    expect(MIGRATIONS[22]?.version).toBe(23);
    expect(MIGRATIONS.map((m) => m.version).slice(0, 23)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  it('migration 23 creates kit_links and kit_links_by_state', () => {
    const db = memDb();
    openStore({ db });
    expect(names(db, 'table')).toContain('kit_links');
    expect(names(db, 'index')).toContain('kit_links_by_state');
    expect(columnInfo(db, 'kit_links').map((c) => String((c as { name: string }).name))).toEqual(['system', 'ref', 'external', 'state', 'at']);
    const pk = columnInfo(db, 'kit_links')
      .map((c) => c as { name: string; pk: number })
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(['system', 'ref']);
    const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_links'").get() as { sql: string }).sql);
    expect(sql).toMatch(/WITHOUT ROWID/i);
    const idx = db.prepare("PRAGMA index_info('kit_links_by_state')").all().map((c) => String(c.name));
    expect(idx).toEqual(['system', 'state', 'at']);
  });

  it('a v22 database upgrades in place: the old tables and rows are untouched, kit_links is new and empty', () => {
    const db = memDb();
    openAt22(db).close();
    expect(names(db, 'table')).not.toContain('kit_links');
    const sanctions = dump(db, 'kit_sanctions', 'id');
    const audit = dump(db, 'kit_audit', 'id');
    const tables = names(db, 'table');
    const indexes = names(db, 'index');
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(23);
    expect(names(db, 'table')).toEqual([...tables, 'kit_links'].sort());
    expect(names(db, 'index')).toEqual([...indexes, 'kit_links_by_state'].sort());
    expect(dump(db, 'kit_sanctions', 'id')).toEqual(sanctions);
    expect(dump(db, 'kit_audit', 'id')).toEqual(audit);
    expect(dump(db, 'kit_links', 'ref')).toEqual([]);
    expect(store.listSubjectSanctions({ limit: 10 })).toHaveLength(1);
  });

  it('a fresh database lands on the same tables, indexes and columns as an upgraded one', () => {
    const fresh = memDb();
    openStore({ db: fresh });
    const upgraded = memDb();
    openAt22(upgraded).close();
    openStore({ db: upgraded });
    expect(names(fresh, 'table')).toEqual(names(upgraded, 'table'));
    expect(names(fresh, 'index')).toEqual(names(upgraded, 'index'));
    expect(columnInfo(fresh, 'kit_links')).toEqual(columnInfo(upgraded, 'kit_links'));
  });

  it('is idempotent on reopen: the second open changes nothing, and rows written stay', () => {
    const db = memDb();
    openStore({ db }).putLink(link());
    const again = openStore({ db });
    expect(again.schemaVersion()).toBe(23);
    expect(again.getLink('coop-report', 'r1')).toEqual(link());
  });

  it('a failing migration 23 rolls back whole: version 22, no kit_links, no index; it still upgrades afterwards', () => {
    const db = memDb();
    openAt22(db).close();
    const broken = [...UP_TO_22, { version: 23, sql: `${M23?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: UP_TO_22 }).schemaVersion()).toBe(22);
    expect(names(db, 'table')).not.toContain('kit_links');
    expect(names(db, 'index')).not.toContain('kit_links_by_state');
    expect(openStore({ db }).schemaVersion()).toBe(23);
    expect(names(db, 'table')).toContain('kit_links');
  });

  it('an older kit (the release before) refuses a database at version 23, as it does for every newer schema', () => {
    const db = memDb();
    openStore({ db }).close();
    expect(() => openStore({ db, migrations: UP_TO_22 })).toThrow(/newer than this kit supports/);
  });

  it('the sql is additive: it names only kit_links and its index, and no other table', () => {
    const sql = M23?.sql ?? '';
    expect(sql).not.toMatch(/\b(ALTER|DROP)\b/i);
    const touched = [...sql.matchAll(/\b(?:TABLE|INDEX|ON)\s+(kit_\w+)/gi)].map((m) => m[1]);
    expect(new Set(touched)).toEqual(new Set(['kit_links', 'kit_links_by_state']));
  });

  it('the primary key makes (system, ref) one row and the store replaces rather than duplicates', () => {
    const db = memDb();
    const store = openStore({ db });
    store.putLink(link());
    store.putLink(link({ state: 'decided', at: NOW + 1 }));
    expect(dump(db, 'kit_links', 'ref')).toHaveLength(1);
    expect(() => db.prepare("INSERT INTO kit_links (system, ref, external, state, at) VALUES ('coop-report', 'r1', 'x', 's', 1)").run()).toThrow();
  });

  it('listing one state reads the by-state index (no table scan)', () => {
    const db = memDb();
    openStore({ db });
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT system, ref, external, state, at FROM kit_links WHERE system = ? AND state = ? ORDER BY at, ref LIMIT ?")
      .all('coop-report', 'sent', 10)
      .map((r) => String(r.detail))
      .join(' ');
    expect(plan).toContain('kit_links_by_state');
    expect(plan).not.toMatch(/USE TEMP B-TREE/);
  });

  it('the shared contract works on an upgraded database too', () => {
    const db = memDb();
    openAt22(db).close();
    const store = openStore({ db });
    store.putLink(link({ ref: 'b', at: NOW + 1 }));
    store.putLink(link({ ref: 'a', at: NOW }));
    expect(store.listLinks('coop-report', { limit: 10 }).map((r) => r.ref)).toEqual(['a', 'b']);
    expect(store.purgeLinks(NOW + 1)).toBe(1);
  });
});
