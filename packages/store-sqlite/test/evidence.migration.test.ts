import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoticeRow } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

// Migration 28 (release 0.2.2, evidence kind): `kit_notices.evidence`, the kind of evidence (chat, play or name) a sanction notice is worded for. It is the
// first migration of the release and every later task appends a labelled block to it. Additive: NULL on every existing row, and no CHECK, so a later kind needs no migration.

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
const UP_TO_27 = MIGRATIONS.slice(0, 27);
const M28 = MIGRATIONS.find((m) => m.version === 28);
const columns = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => ({ name: String(r.name), type: String(r.type), notnull: Number(r.notnull), dflt: r.dflt_value }));

/** A notice written the way a version 27 database holds it (the store of today writes a column that database does not have yet). */
const rawNotice = (db: DatabaseSync, id: string, kind: string, until: number | null, excerpt: unknown[]): void => {
  db.prepare(
    `INSERT INTO kit_notices (id, subject_id, group_id, kind, rule, until, ref_code, excerpt_json, created_at, acked_at, withdrawn_at) VALUES (?, 's_a', 'g1', ?, '6', ?, 'M-AAAAA', ?, ?, NULL, NULL)`,
  ).run(id, kind, until, JSON.stringify(excerpt), NOW);
};

const notice = (id: string, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id,
  subject: 's_a',
  groupId: 'g1',
  kind: 'warning',
  rule: '6',
  until: null,
  refCode: 'M-AAAAA',
  excerpt: [],
  createdAt: NOW,
  ackedAt: null,
  withdrawnAt: null,
  ...over,
});

describe('migration 28: kit_notices.evidence', () => {
  it('is the release 0.2.2 migration, the only one after 27, and the versions run 1..N without a gap', () => {
    expect(M28).toBeDefined();
    expect(MIGRATIONS.filter((m) => m.version > 27).map((m) => m.version)).toEqual([28]);
    expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1));
    expect(M28?.sql ?? '').toMatch(/-- Block 1 \(evidence kind\)/);
  });

  it('a fresh database has a nullable TEXT column with no default and no CHECK, after the old columns', () => {
    const db = memDb();
    openStore({ db });
    expect(columns(db, 'kit_notices').at(-1)).toEqual({ name: 'evidence', type: 'TEXT', notnull: 0, dflt: null });
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_notices'").get()?.sql)).not.toMatch(/evidence[^,]*CHECK/i);
  });

  it('a version 27 database with notices upgrades: every row is untouched and reads without a kind', () => {
    const db = memDb();
    const old = openStore({ db, migrations: UP_TO_27 });
    rawNotice(db, 'n1', 'warning', null, []);
    rawNotice(db, 'n2', 'chat', NOW + 5, [{ text: 'a line', day: '2027-01-15' }]);
    old.close();
    const before = db.prepare('SELECT id, kind, rule, excerpt_json FROM kit_notices ORDER BY id').all();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(28);
    expect(db.prepare('SELECT evidence FROM kit_notices ORDER BY id').all().map((r) => r.evidence)).toEqual([null, null]);
    expect(db.prepare('SELECT id, kind, rule, excerpt_json FROM kit_notices ORDER BY id').all()).toEqual(before);
    for (const r of store.loadNotices(['s_a'])) expect(r).not.toHaveProperty('evidence');
    store.close();
  });

  it('a failing statement appended to 28 leaves the database at 27 with no column and the rows intact', () => {
    const db = memDb();
    const old = openStore({ db, migrations: UP_TO_27 });
    rawNotice(db, 'n1', 'warning', null, []);
    old.close();
    const broken = [...UP_TO_27, { version: 28, sql: `${M28?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: UP_TO_27 }).schemaVersion()).toBe(27);
    expect(columns(db, 'kit_notices').map((c) => c.name)).not.toContain('evidence');
    expect(db.prepare('SELECT COUNT(*) AS n FROM kit_notices').get()).toEqual({ n: 1 });
    expect(openStore({ db }).schemaVersion()).toBe(28);
  });
});

describe('the store writes and reads the kind', () => {
  it('insertNotice stores it as given and a read gives it back; no kind is NULL and no key', () => {
    const db = memDb();
    const store = openStore({ db });
    for (const kind of ['chat', 'play', 'name'] as const) store.insertNotice(notice(`n-${kind}`, { evidence: kind }));
    store.insertNotice(notice('n-none'));
    expect(db.prepare('SELECT id, evidence FROM kit_notices ORDER BY id').all().map((r) => [r.id, r.evidence])).toEqual([
      ['n-chat', 'chat'],
      ['n-none', null],
      ['n-name', 'name'],
      ['n-play', 'play'],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    expect(store.loadNotice?.('n-play')?.evidence).toBe('play');
    expect(store.loadNotice?.('n-none')).not.toHaveProperty('evidence');
    expect(store.loadNotices(['s_a']).map((r) => r.evidence)).toEqual(['chat', 'play', 'name', undefined]);
  });

  it('a stored value that is not a kind reads as no kind (a database edited by hand never breaks a read)', () => {
    const db = memDb();
    const store = openStore({ db });
    store.insertNotice(notice('n1'));
    db.prepare("UPDATE kit_notices SET evidence = 'moon'").run();
    expect(store.loadNotice?.('n1')).not.toHaveProperty('evidence');
  });
});
