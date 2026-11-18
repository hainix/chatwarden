import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { NO_PERSON_JSON_COLUMNS, NO_PERSON_TABLES, PRIVACY_REGISTRY } from '@chatwarden/core';
import type { ErasePlan } from '@chatwarden/core';
import { WHO, seedWorld } from '../../../test/contract/privacy.contract.js';
import { openStore } from '../src/index.js';

// The completeness test of the privacy registry (design 5.4): every `kit_` table the migrations create must be claimed by a category of PRIVACY_REGISTRY or be
// in NO_PERSON_TABLES with a reason. A later theme (urgent desk, rooms, staff scope, languages) that adds a table fails THIS test until someone decides what an
// export and an erase do with it. The check is a function so a control can prove it fails.

const claimed = (): Set<string> => new Set([...PRIVACY_REGISTRY.flatMap((r) => r.tables), ...Object.keys(NO_PERSON_TABLES)]);

/** The `kit_` tables of the database that no category claims. */
const unclaimedTables = (db: DatabaseSync): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kit_%' ORDER BY name")
    .all()
    .map((r) => String(r.name))
    .filter((n) => !claimed().has(n));

describe('completeness (sqlite): every kit_ table in sqlite_master is in the registry map or in the "holds no person" list', () => {
  it('after every migration, no table is unclaimed', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    expect(unclaimedTables(db)).toEqual([]);
  });

  it('control: adding a table without an entry fails', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    db.exec('CREATE TABLE kit_urgent_desk_rows (id TEXT PRIMARY KEY, subject_id TEXT)');
    expect(unclaimedTables(db)).toEqual(['kit_urgent_desk_rows']);
  });

  it('every claimed table exists: nothing claimed is a table that never existed', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const real = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => String(r.name)),
    );
    for (const t of claimed()) expect(real.has(t), t).toBe(true);
  });

  it('names the tables and columns this release added: kit_filter_hits, kit_erasures, kit_reports.origin and origin_key and their indexes', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    expect(claimed().has('kit_filter_hits')).toBe(true);
    expect(claimed().has('kit_erasures')).toBe(true);
    const cols = db.prepare('PRAGMA table_info(kit_reports)').all().map((r) => String(r.name));
    expect(cols).toEqual(expect.arrayContaining(['origin', 'origin_key']));
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kit_reports'").all().map((r) => String(r.name));
    expect(idx).toEqual(expect.arrayContaining(['kit_reports_open_filter', 'kit_reports_by_origin']));
  });
});

// Column level (chunk 5 review, Finding 2). A table the registry claims can still hide a person INSIDE a JSON column (a decision's `result_json` names the people it
// sanctioned). Every `*_json` column of every `kit_` table must be declared by a rule's `jsonColumns` (it carries a person and the erase rewrites it) or in
// NO_PERSON_JSON_COLUMNS with a reason, and the data proves both lists: after a real erase no declared column holds the person, and before it no undeclared column does.

const declaredJson = (): Set<string> => new Set([...PRIVACY_REGISTRY.flatMap((r) => r.jsonColumns), ...Object.keys(NO_PERSON_JSON_COLUMNS)]);

/** Every `table.column` of a `kit_` table whose column name ends in `_json`. */
const jsonColumns = (db: DatabaseSync): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kit_%' ORDER BY name")
    .all()
    .flatMap((t) =>
      db
        .prepare(`PRAGMA table_info(${String(t.name)})`)
        .all()
        .map((c) => `${String(t.name)}.${String(c.name)}`)
        .filter((c) => c.endsWith('_json')),
    );

const undeclaredJson = (db: DatabaseSync): string[] => jsonColumns(db).filter((c) => !declaredJson().has(c));

/** The whole text of one column over every row. */
const columnText = (db: DatabaseSync, qualified: string): string => {
  const [table, column] = qualified.split('.') as [string, string];
  return db
    .prepare(`SELECT ${column} AS v FROM ${table}`)
    .all()
    .map((r) => String(r.v))
    .join('\n');
};

/** What names the person under test inside the seed's JSON: ids, handle, lines, and the group ids, reference codes and notice ids of the person's own sanctions. */
const NEEDLES = [...WHO.ids, ...WHO.accounts, WHO.handle, WHO.line, WHO.line2, WHO.noticeLine, 'gEnded', 'M-ENDED', 'gThirdPP', 'gThirdP2', 'gFiledPP', 'n-third-pp', 'n-filed-pp', 'n-ended'];

describe('completeness at column level: every JSON column is declared or listed as holding no person', () => {
  it('no *_json column is undeclared', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    expect(undeclaredJson(db)).toEqual([]);
  });

  it('control: a new table with a JSON column and no entry fails, and so does a new JSON column on a claimed table', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    db.exec('CREATE TABLE kit_urgent_notes (id TEXT PRIMARY KEY, who_json TEXT)');
    db.exec('ALTER TABLE kit_notices ADD COLUMN extra_json TEXT');
    expect(undeclaredJson(db)).toEqual(['kit_notices.extra_json', 'kit_urgent_notes.who_json']);
  });

  it('every declared column exists (nothing declared is a column that never existed)', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const real = new Set(jsonColumns(db));
    for (const c of declaredJson()) expect(real.has(c), c).toBe(true);
  });

  const seeded = async (ban: boolean) => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    await seedWorld(store, { ban, reporterOnly: true });
    return { db, store };
  };

  it('before an erase the seed is real: the declared columns hold the person (the check below is not vacuous)', async () => {
    const { db } = await seeded(true);
    const declared = PRIVACY_REGISTRY.flatMap((r) => r.jsonColumns);
    expect(declared.length).toBeGreaterThan(4);
    for (const c of ['kit_decisions.result_json', 'kit_reports.people_json', 'kit_reports.excerpt_json', 'kit_notices.excerpt_json', 'kit_webhook_keys.result_json']) {
      const text = columnText(db, c);
      expect(NEEDLES.some((n) => text.includes(n)), c).toBe(true);
    }
  });

  it('an undeclared JSON column holds no person even in a fully seeded database (the "no person" claims are true)', async () => {
    const { db } = await seeded(true);
    for (const c of Object.keys(NO_PERSON_JSON_COLUMNS)) {
      const text = columnText(db, c);
      for (const n of NEEDLES) expect(text, `${c}: ${n}`).not.toContain(n);
    }
  });

  it('after an erase with keep none, no declared JSON column holds the person', async () => {
    const { db, store } = await seeded(true);
    const plan: ErasePlan = { subjects: ['s_pp'], mode: 'none', heldReportIds: new Set(), receiptId: 'e_cols', at: 1_800_000_000_000 };
    store.eraseSubjects(plan);
    for (const c of PRIVACY_REGISTRY.flatMap((r) => r.jsonColumns)) {
      const text = columnText(db, c);
      for (const n of NEEDLES) expect(text, `${c}: ${n}`).not.toContain(n);
    }
  });

  it('control: a person nobody erased is still in the declared columns afterwards (the erase does not wipe other people)', async () => {
    const { db, store } = await seeded(false);
    store.eraseSubjects({ subjects: ['s_pp'], mode: 'none', heldReportIds: new Set(), receiptId: 'e_cols2', at: 1_800_000_000_000 });
    expect(columnText(db, 'kit_decisions.result_json')).toContain('s_xx');
    expect(columnText(db, 'kit_webhook_keys.result_json')).toContain('gQ');
  });
});
