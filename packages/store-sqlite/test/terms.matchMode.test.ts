import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveTerms, type TermRecord } from '@chatwarden/matcher';
import { MIGRATIONS, openStore } from '../src/index.js';

// Migration 26, the term-mode block (spec 5.2 and section 7): `kit_terms.match_mode`, nullable with its CHECK; null means "by script". Shared migration: the assertions are about this block's column only.
// Invented strings only.

const T0 = 1_700_000_000_000;
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
const rec = (id: string, term: string, over: Partial<TermRecord> = {}): TermRecord => ({ id, term, language: 'en', active: true, note: null, addedBy: 'tester', addedAt: T0, updatedBy: null, updatedAt: null, ...over });
const HAN = '\u4f50\u5c14\u5df4\u514b';
const FRAGMENT = '\u5c14\u5df4\u5c3c';
const INSIDE = '\u6211\u53bb\u8fc7\u963f\u5c14\u5df4\u5c3c\u4e9a\u65c5\u6e38';

describe('migration 26, the term-mode block', () => {
  it('a 25 database upgrades: kit_terms.match_mode exists, old rows read null and match by script', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_25 });
    expect(columns(db, 'kit_terms')).not.toContain('match_mode');
    // rows written before the column existed, as the old code wrote them
    const insertOld = db.prepare("INSERT INTO kit_terms (id, term, language, active, note, added_by, added_at) VALUES (?, ?, ?, 1, NULL, 'tester', ?)");
    insertOld.run('t1', 'zorbak', 'en', T0);
    insertOld.run('t2', FRAGMENT, 'zh', T0);
    const store = openStore({ db });
    expect(columns(db, 'kit_terms')).toContain('match_mode');
    expect(store.listTerms().map((r) => r.matchMode ?? null)).toEqual([null, null]);
    // matched by script: a Latin word as a word, a Han term as a segment (it does not hit inside the longer word)
    const live = new LiveTerms({ store, pack: null, clock: { now: () => T0 }, logger: { warn: vi.fn() } });
    live.loadSync();
    expect(live.match('you zorbak')).toEqual({ termId: 't1' });
    expect(live.match(INSIDE)).toBeNull();
  });

  it('the column is nullable TEXT with a CHECK for word, segment and contains, and nothing else is stored', () => {
    const db = memDb();
    openStore({ db });
    const info = db.prepare('PRAGMA table_info(kit_terms)').all().find((c) => c.name === 'match_mode');
    expect(info).toBeDefined();
    expect(String(info?.type)).toBe('TEXT');
    expect(Number(info?.notnull)).toBe(0);
    expect(info?.dflt_value).toBeNull();
    const insert = (mode: string | null) => db.prepare("INSERT INTO kit_terms (id, term, language, active, added_by, added_at, match_mode) VALUES (?, 'x', 'en', 1, 'a', 1, ?)").run(`id-${String(mode)}`, mode);
    for (const ok of [null, 'word', 'segment', 'contains']) expect(() => insert(ok), String(ok)).not.toThrow();
    for (const bad of ['', 'Word', 'fuzzy', 'segment ', '1']) expect(() => insert(bad), bad).toThrow(/CHECK/i);
  });

  it('a database migrated from 25 has the same term columns as a fresh one', () => {
    const a = memDb();
    openStore({ db: a });
    const b = memDb();
    openStore({ db: b, migrations: UP_TO_25 });
    openStore({ db: b });
    expect(columns(b, 'kit_terms').sort()).toEqual(columns(a, 'kit_terms').sort());
  });

  it('a rerun of the block is refused: its statement fails on a database that already has the column', () => {
    const db = memDb();
    openStore({ db });
    const sql = MIGRATIONS.find((m) => m.version === 26)?.sql ?? '';
    expect(sql).toContain('match_mode');
    expect(() => db.exec(sql)).toThrow();
    expect(() => openStore({ db })).not.toThrow();
    expect(MIGRATIONS.filter((m) => m.version > 25).map((m) => m.version)).toEqual([26, 27]);
  });
});

describe('the store reads and writes it', () => {
  it('insertTerm writes the mode and listTerms gives it back; a row without one has no matchMode key', () => {
    const db = memDb();
    const store = openStore({ db });
    store.insertTerm(rec('a', FRAGMENT, { language: 'zh', matchMode: 'contains' }));
    store.insertTerm(rec('b', HAN, { language: 'zh', matchMode: 'segment' }));
    store.insertTerm(rec('c', 'zorbak'));
    store.insertTerm(rec('d', 'glarn', { matchMode: null }));
    const rows = store.listTerms();
    expect(rows.map((r) => r.matchMode ?? null)).toEqual(['contains', 'segment', null, null]);
    expect(Object.hasOwn(rows[2] as object, 'matchMode')).toBe(false);
    expect(Object.hasOwn(rows[3] as object, 'matchMode')).toBe(false);
    expect(db.prepare('SELECT id, match_mode FROM kit_terms ORDER BY rowid').all().map((r) => ({ ...r }))).toEqual([
      { id: 'a', match_mode: 'contains' },
      { id: 'b', match_mode: 'segment' },
      { id: 'c', match_mode: null },
      { id: 'd', match_mode: null },
    ]);
  });

  it('updateTerm sets the mode, null clears it, and leaving it out keeps it; the stamps always move', () => {
    const store = openStore({ db: memDb() });
    store.insertTerm(rec('a', FRAGMENT, { language: 'zh' }));
    store.updateTerm('a', { matchMode: 'contains', updatedBy: 'alice', updatedAt: T0 + 1 });
    expect(store.listTerms()[0]).toMatchObject({ matchMode: 'contains', updatedBy: 'alice', updatedAt: T0 + 1 });
    store.updateTerm('a', { note: 'n', updatedBy: 'bob', updatedAt: T0 + 2 });
    expect(store.listTerms()[0]).toMatchObject({ matchMode: 'contains', note: 'n', updatedBy: 'bob' });
    store.updateTerm('a', { matchMode: null, updatedBy: 'bob', updatedAt: T0 + 3 });
    expect(store.listTerms()[0]?.matchMode ?? null).toBeNull();
    store.updateTerm('a', { term: HAN, language: 'zh', matchMode: 'segment', updatedBy: 'bob', updatedAt: T0 + 4 });
    expect(store.listTerms()[0]).toMatchObject({ term: HAN, matchMode: 'segment' });
  });

  it('a mode the CHECK refuses throws and writes nothing; an unknown id still throws', () => {
    const store = openStore({ db: memDb() });
    store.insertTerm(rec('a', 'zorbak'));
    expect(() => store.updateTerm('a', { matchMode: 'fuzzy' as never, updatedBy: 'x', updatedAt: 1 })).toThrow();
    expect(() => store.insertTerm(rec('b', 'glarn', { matchMode: 'fuzzy' as never }))).toThrow();
    expect(store.listTerms().map((r) => r.id)).toEqual(['a']);
    expect(() => store.updateTerm('nope', { matchMode: 'contains', updatedBy: 'x', updatedAt: 1 })).toThrow(/not found/);
  });

  it('LiveTerms over SQLite: the mode is stored, rebuilt into the matcher, restored after a restart, and audited', async () => {
    const db = memDb();
    const store = openStore({ db });
    const clock = { now: () => T0 };
    const pack = { id: 'p', version: '1', terms: [{ id: 'lat', term: 'zorbak', language: 'en', active: true, positive: [], negative: [] }], exceptions: [], negativeCorpus: [], knownLosses: [] };
    const live = new LiveTerms({ store, pack, clock, logger: { warn: vi.fn() } });
    await live.load();
    let id = '';
    expect((await live.change('alice', (e) => (id = e.addTerm({ term: FRAGMENT, language: 'zh', matchMode: 'contains' })))).ok).toBe(true);
    expect(live.match(INSIDE)).toEqual({ termId: id });
    const again = new LiveTerms({ store, pack, clock, logger: { warn: vi.fn() } });
    await again.load();
    expect(again.match(INSIDE)).toEqual({ termId: id });
    expect(await again.change('alice', (e) => e.updateTerm(id, { matchMode: null }))).toMatchObject({ ok: true });
    expect(again.match(INSIDE)).toBeNull();
    const audit = db.prepare("SELECT action, after_json FROM kit_audit WHERE subject_ref = ? ORDER BY rowid").all(id).map((r) => ({ action: String(r.action), after: JSON.parse(String(r.after_json)) as Record<string, unknown> }));
    expect(audit.map((a) => a.action)).toEqual(['term.add', 'term.update']);
    expect(audit[0]?.after.matchMode).toBe('contains');
    expect(Object.hasOwn(audit[1]?.after as object, 'matchMode')).toBe(false);
  });
});
