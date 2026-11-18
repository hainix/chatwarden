import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { NO_SUBJECT_COLUMNS, registrySubjectColumns } from '@chatwarden/core';
import { seedWorld } from '../../../test/contract/privacy.contract.js';
import { IDLE_SEEDERS } from '../../../test/contract/idle.contract.js';
import { openStore } from '../src/index.js';

// The identity age-out in SQLite (0.2.2, W6). The shared contract (test/contract/idle.contract.ts) proves what keeps a person; this file proves the registry matches the
// real schema, so a new person-keyed column cannot slip past the age-out, and the things only SQL can get wrong: foreign keys, big lists, one migration.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const kitTables = (db: DatabaseSync): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kit_%' ORDER BY name")
    .all()
    .map((r) => String(r.name));
const columnsOf = (db: DatabaseSync, table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));

/** Every `table.column` whose name says it may hold a person. */
const personish = (db: DatabaseSync): string[] =>
  kitTables(db).flatMap((t) => columnsOf(db, t).filter((c) => /(subject|person|who|viewer|reporter|target)/.test(c)).map((c) => `${t}.${c}`));

const declared = (): Set<string> => {
  const { plain, json } = registrySubjectColumns();
  return new Set([...plain, ...json, ...Object.keys(NO_SUBJECT_COLUMNS)]);
};
const undeclared = (db: DatabaseSync): string[] => personish(db).filter((c) => !declared().has(c));

describe('the registry names every column that can hold a person (sqlite)', () => {
  it('every column of a kit_ table that looks like a person is in the registry or in NO_SUBJECT_COLUMNS with a reason', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    expect(undeclared(db)).toEqual([]);
    for (const [column, reason] of Object.entries(NO_SUBJECT_COLUMNS)) expect(reason.length, column).toBeGreaterThan(20);
  });

  it('control: a new column that names a person fails until it is declared', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    db.exec('ALTER TABLE kit_notices ADD COLUMN owner_subject TEXT');
    db.exec('CREATE TABLE kit_urgent_notes (id TEXT PRIMARY KEY, person TEXT)');
    expect(undeclared(db)).toEqual(['kit_notices.owner_subject', 'kit_urgent_notes.person']);
  });

  it('every declared column exists in the schema, and every seeder is for a declared column', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const real = new Set(kitTables(db).flatMap((t) => columnsOf(db, t).map((c) => `${t}.${c}`)));
    const { plain, json } = registrySubjectColumns();
    for (const c of [...plain, ...json, ...Object.keys(NO_SUBJECT_COLUMNS)]) expect(real.has(c), c).toBe(true);
    expect(Object.keys(IDLE_SEEDERS).sort()).toEqual([...plain, ...json].sort());
  });

  it('the person-keyed tables the registry claims are all reached: no claimed table with a subject-looking column is left out', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const { plain, json } = registrySubjectColumns();
    const named = new Set([...plain, ...json, ...Object.keys(NO_SUBJECT_COLUMNS)]);
    for (const c of personish(db)) expect(named.has(c), c).toBe(true);
  });
});

describe('purgeIdleSubjects in SQLite', () => {
  it('adds no migration: the one last_seen column the identifiers always had is what it reads, and the schema version is unchanged by it', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(columnsOf(db, 'kit_subject_ids')).toEqual(expect.arrayContaining(['subject_id', 'kind', 'value', 'first_seen', 'last_seen']));
    expect(columnsOf(db, 'kit_subjects')).toEqual(['id', 'created_at', 'merged_into']);
    expect(store.schemaVersion()).toBe(28);
  });

  it('every person of the full privacy world has a record, so none is idle however late the cutoff', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    await seedWorld(store, { ban: true, held: true });
    expect(store.purgeIdleSubjects?.(NOW + 5000 * DAY)).toBe(0);
    expect((await store.loadSubjects()).subjects.map((s) => s.id).sort()).toEqual(['s_pp', 's_pp2', 's_qq', 's_xx']);
  });

  it('deletes a merged chain without a foreign key violation, and leaves a clean database', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    for (const [id, into] of [['s_c', null], ['s_b', 's_c'], ['s_a', 's_b']] as const) {
      await store.saveSubject({ id, createdAt: NOW - 900 * DAY, mergedInto: null });
      await store.saveIdentifier({ subjectId: id, kind: 'key', value: `k-${id}`, firstSeen: NOW - 900 * DAY, lastSeen: NOW - 800 * DAY });
      if (into !== null) await store.markMerged(id, into);
    }
    expect(store.purgeIdleSubjects?.(NOW - 400 * DAY)).toBe(3);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM kit_subjects').get()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM kit_subject_ids').get()?.n).toBe(0);
  });

  it('handles thousands of idle people in one call (the id lists are bound as one JSON value each)', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    store.transaction(() => {
      const sub = db.prepare('INSERT INTO kit_subjects (id, created_at, merged_into) VALUES (?, ?, NULL)');
      const ident = db.prepare('INSERT INTO kit_subject_ids (subject_id, kind, value, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < 3000; i++) {
        sub.run(`s_bulk${i}`, NOW - 900 * DAY);
        ident.run(`s_bulk${i}`, 'key', `k${i}`, NOW - 900 * DAY, NOW - 800 * DAY);
      }
      // one of them has a strike, one a mute target
      db.prepare("INSERT INTO kit_strikes (id, at, subject_id, room_id, term_id, raw_line) VALUES ('st', ?, 's_bulk17', 'R', 't', 'zorbak')").run(NOW - 500 * DAY);
      db.prepare('INSERT INTO kit_mutes (viewer_id, target_id, created_at) VALUES (?, ?, ?)').run('s_nobody', 's_bulk2999', NOW - 500 * DAY);
    });
    expect(store.purgeIdleSubjects?.(NOW - 400 * DAY)).toBe(2998);
    expect(db.prepare('SELECT id FROM kit_subjects ORDER BY id').all().map((r) => r.id)).toEqual(['s_bulk17', 's_bulk2999']);
  });

  it('a subject id that is only a piece of another id does not borrow its records (exact match, not a substring)', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    for (const id of ['s_pp', 's_pp2']) {
      await store.saveSubject({ id, createdAt: NOW - 900 * DAY, mergedInto: null });
      await store.saveIdentifier({ subjectId: id, kind: 'key', value: `k-${id}`, firstSeen: NOW - 900 * DAY, lastSeen: NOW - 800 * DAY });
    }
    store.insertReport({
      id: 'r1',
      createdAt: NOW - 900 * DAY,
      roomId: 'R',
      tags: {},
      reporterSubject: 's_x',
      reporterSeat: 'p1',
      reporterHandle: 'X',
      targetSubject: 's_y',
      targetSeat: 'p2',
      targetHandle: 'Y',
      category: 'harassment',
      reportedReason: 'harassment',
      note: null,
      lineId: null,
      excerpt: [],
      people: ['s_x', 's_pp2'],
      status: 'open',
    });
    expect(store.purgeIdleSubjects?.(NOW - 400 * DAY)).toBe(1);
    expect((await store.loadSubjects()).subjects.map((s) => s.id)).toEqual(['s_pp2']);
  });
});
