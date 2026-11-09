import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveTerms, type ExceptionRecord, type TermRecord, type TermStore } from '@chatwarden/matcher';
import { SYNTHETIC_EXCEPTIONS, SYNTHETIC_TERMS, syntheticTermPack } from '@chatwarden/matcher/test-fixtures';
import { MIGRATIONS, openStore, type SqliteStore } from '../src/index.js';

const T0 = 1_700_000_000_000;
const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-terms-'));
  tmpDirs.push(dir);
  return join(dir, 'kit.db');
}
const clock = () => {
  const c = { t: T0, now: () => c.t };
  return c;
};
const quiet = () => ({ warn: vi.fn() });

const termRec = (id: string, term: string, over: Partial<TermRecord> = {}): TermRecord => ({
  id, term, language: 'en', active: true, note: null, addedBy: 'tester', addedAt: T0, updatedBy: null, updatedAt: null, ...over,
});
const exRec = (id: string, phrase: string, over: Partial<ExceptionRecord> = {}): ExceptionRecord => ({
  id, phrase, language: 'en', active: true, note: null, addedBy: 'tester', addedAt: T0, updatedBy: null, updatedAt: null, ...over,
});
const count = (db: DatabaseSync, table: string) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe('migration 2: terms and audit', () => {
  it('is version 2 and creates kit_terms, kit_term_exceptions and kit_audit', () => {
    expect(MIGRATIONS[1]?.version).toBe(2);
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(2);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kit_%'")
      .all()
      .map((r) => String(r.name));
    expect(names).toEqual(expect.arrayContaining(['kit_terms', 'kit_term_exceptions', 'kit_audit', 'kit_subjects', 'kit_meta']));
    db.close();
  });

  it('upgrades a version 1 database in place and keeps its subjects', async () => {
    const path = tmpPath();
    const v1 = openStore({ path, migrations: [MIGRATIONS[0]!] });
    await v1.saveSubject({ id: 's_a', createdAt: 5, mergedInto: null });
    expect(v1.schemaVersion()).toBe(1);
    v1.close();
    const v2 = openStore({ path });
    expect(v2.schemaVersion()).toBeGreaterThanOrEqual(2);
    expect((await v2.loadSubjects()).subjects).toHaveLength(1);
    expect(v2.listTerms()).toEqual([]);
    v2.close();
  });

  it('kit_audit has the generic columns', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const cols = db.prepare('PRAGMA table_info(kit_audit)').all().map((c) => String(c.name));
    expect(cols).toEqual(['id', 'at', 'actor', 'action', 'subject_type', 'subject_ref', 'before_json', 'after_json']);
    db.close();
  });

  it('only touches kit_ tables, so it can share a host database', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    openStore({ db });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    expect(names.filter((n) => !n.startsWith('kit_') && !n.startsWith('sqlite_'))).toEqual(['users']);
    db.close();
  });
});

describe('SqliteStore as a TermStore', () => {
  const open = (): SqliteStore => openStore({ path: ':memory:' });

  it('is assignable to TermStore', () => {
    const s: TermStore = open();
    expect(typeof s.transaction).toBe('function');
  });

  it('terms round trip in insertion order with booleans and nulls', () => {
    const s = open();
    s.insertTerm(termRec('b', 'blorft', { note: 'n', active: false }));
    s.insertTerm(termRec('a', 'snoddle'));
    expect(s.listTerms()).toEqual([
      termRec('b', 'blorft', { note: 'n', active: false }),
      termRec('a', 'snoddle'),
    ]);
    s.close();
  });

  it('exceptions round trip in insertion order', () => {
    const s = open();
    s.insertException(exRec('x2', 'blorft stew'));
    s.insertException(exRec('x1', 'snoddle soup', { active: false, note: 'n' }));
    expect(s.listExceptions()).toEqual([exRec('x2', 'blorft stew'), exRec('x1', 'snoddle soup', { active: false, note: 'n' })]);
    s.close();
  });

  it('a duplicate id throws', () => {
    const s = open();
    s.insertTerm(termRec('a', 'blorft'));
    expect(() => s.insertTerm(termRec('a', 'snoddle'))).toThrow();
    expect(s.listTerms()).toHaveLength(1);
    s.close();
  });

  it('updateTerm changes only the patched fields and stamps the editor', () => {
    const s = open();
    s.insertTerm(termRec('a', 'blorft', { note: 'keep' }));
    s.updateTerm('a', { term: 'snoddle', updatedBy: 'bob', updatedAt: T0 + 9 });
    expect(s.listTerms()[0]).toMatchObject({ term: 'snoddle', language: 'en', note: 'keep', updatedBy: 'bob', updatedAt: T0 + 9, addedBy: 'tester' });
    s.updateTerm('a', { note: null, language: 'pt', updatedBy: 'cy', updatedAt: T0 + 10 });
    expect(s.listTerms()[0]).toMatchObject({ term: 'snoddle', language: 'pt', note: null, updatedBy: 'cy' });
    s.close();
  });

  it('updateException changes only the patched fields', () => {
    const s = open();
    s.insertException(exRec('x', 'blorft stew', { note: 'keep' }));
    s.updateException('x', { phrase: 'blorft soup', updatedBy: 'bob', updatedAt: T0 + 1 });
    expect(s.listExceptions()[0]).toMatchObject({ phrase: 'blorft soup', note: 'keep', updatedBy: 'bob', updatedAt: T0 + 1 });
    s.close();
  });

  it('setTermActive and setExceptionActive flip the flag and stamp the editor', () => {
    const s = open();
    s.insertTerm(termRec('a', 'blorft'));
    s.insertException(exRec('x', 'blorft stew'));
    s.setTermActive('a', false, 'bob', T0 + 1);
    s.setExceptionActive('x', false, 'bob', T0 + 2);
    expect(s.listTerms()[0]).toMatchObject({ active: false, updatedBy: 'bob', updatedAt: T0 + 1 });
    expect(s.listExceptions()[0]).toMatchObject({ active: false, updatedBy: 'bob', updatedAt: T0 + 2 });
    s.close();
  });

  it('updating or toggling a missing id throws', () => {
    const s = open();
    expect(() => s.updateTerm('nope', { note: 'x', updatedBy: 'a', updatedAt: 1 })).toThrow(/not found/);
    expect(() => s.setTermActive('nope', false, 'a', 1)).toThrow(/not found/);
    expect(() => s.updateException('nope', { note: 'x', updatedBy: 'a', updatedAt: 1 })).toThrow(/not found/);
    expect(() => s.setExceptionActive('nope', false, 'a', 1)).toThrow(/not found/);
    s.close();
  });

  it('writeAudit stores a row with a generated id and the generic columns', () => {
    const db = new DatabaseSync(':memory:');
    const s = openStore({ db });
    s.writeAudit({ at: T0, actor: 'alice', action: 'add', subjectType: 'term', subjectRef: 'a', beforeJson: null, afterJson: '{"x":1}' });
    s.writeAudit({ at: T0 + 1, actor: 'bob', action: 'disable', subjectType: 'exception', subjectRef: 'x', beforeJson: '{}', afterJson: '{"y":2}' });
    const rows = db.prepare('SELECT * FROM kit_audit ORDER BY rowid').all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      at: T0, actor: 'alice', action: 'add', subject_type: 'term', subject_ref: 'a', before_json: null, after_json: '{"x":1}',
    });
    expect(String(rows[0]!.id)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    expect(rows[1]).toMatchObject({ action: 'disable', subject_type: 'exception', before_json: '{}' });
    db.close();
  });

  it('the seed marker is kit_meta terms_seeded:<pack id>, per pack id', () => {
    const db = new DatabaseSync(':memory:');
    const s = openStore({ db });
    expect(s.isSeeded('p1')).toBe(false);
    s.markSeeded('p1', T0);
    expect(s.isSeeded('p1')).toBe(true);
    expect(s.isSeeded('p2')).toBe(false);
    s.markSeeded('p1', T0 + 1);
    expect(db.prepare("SELECT value FROM kit_meta WHERE key = 'terms_seeded:p1'").get()).toBeTruthy();
    expect(count(db, 'kit_meta')).toBe(2); // schema_version and the marker
    db.close();
  });

  it('transaction rolls term, exception, audit and marker writes back together', () => {
    const db = new DatabaseSync(':memory:');
    const s = openStore({ db });
    expect(() =>
      s.transaction(() => {
        s.insertTerm(termRec('a', 'blorft'));
        s.insertException(exRec('x', 'blorft stew'));
        s.writeAudit({ at: T0, actor: 'a', action: 'add', subjectType: 'term', subjectRef: 'a', beforeJson: null, afterJson: '{}' });
        s.markSeeded('p1', T0);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect([count(db, 'kit_terms'), count(db, 'kit_term_exceptions'), count(db, 'kit_audit')]).toEqual([0, 0, 0]);
    expect(s.isSeeded('p1')).toBe(false);
    db.close();
  });

  it('transactions nest: an inner failure undoes only the inner writes', () => {
    const s = open();
    s.transaction(() => {
      s.insertTerm(termRec('outer', 'blorft'));
      expect(() =>
        s.transaction(() => {
          s.insertTerm(termRec('inner', 'snoddle'));
          throw new Error('inner');
        }),
      ).toThrow('inner');
    });
    expect(s.listTerms().map((t) => t.id)).toEqual(['outer']);
    s.close();
  });

  it('works inside a transaction the host already opened', () => {
    const db = new DatabaseSync(':memory:');
    const s = openStore({ db });
    db.exec('BEGIN');
    s.insertTerm(termRec('a', 'blorft'));
    db.exec('ROLLBACK');
    expect(s.listTerms()).toEqual([]);
    db.close();
  });
});

describe('LiveTerms on SQLite, end to end', () => {
  it('seeds from the pack once, then the store rules (across a reopen)', async () => {
    const path = tmpPath();
    const store1 = openStore({ path });
    const c = clock();
    const live1 = new LiveTerms({ store: store1, pack: syntheticTermPack(), clock: c, logger: quiet() });
    await live1.load();
    expect(live1.usingPack).toBe(false);
    expect(store1.listTerms().map((t) => t.id)).toEqual(SYNTHETIC_TERMS.map((t) => t.id));
    expect(store1.listExceptions().map((e) => e.id)).toEqual(SYNTHETIC_EXCEPTIONS.map((e) => e.id));
    expect(store1.listTerms()[0]).toMatchObject({ addedBy: 'seed', addedAt: T0 });
    expect(store1.isSeeded('synthetic')).toBe(true);
    expect((await live1.change('alice', (e) => e.setTermActive('syn:zorbak', false))).ok).toBe(true);
    expect(live1.match('you zorbak')).toBeNull();
    store1.close();

    c.t = T0 + 99_999;
    const store2 = openStore({ path });
    const live2 = new LiveTerms({ store: store2, pack: syntheticTermPack(), clock: c, logger: quiet() });
    await live2.load();
    expect(live2.match('you zorbak')).toBeNull();
    expect(live2.match('you vlemmo')).toEqual({ termId: 'syn:vlemmo' });
    expect(store2.listTerms().filter((t) => t.addedAt !== T0)).toEqual([]);
    expect(store2.listTerms().find((t) => t.id === 'syn:zorbak')!.active).toBe(false);
    store2.close();
  });

  it('a seeding failure leaves nothing behind: no rows, no marker', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    // A trigger makes the last pack exception insert fail, after the terms went in.
    db.exec(`CREATE TRIGGER kit_test_boom BEFORE INSERT ON kit_term_exceptions
             WHEN NEW.id = '${SYNTHETIC_EXCEPTIONS.at(-1)!.id}' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const warn = quiet();
    const live = new LiveTerms({ store, pack: syntheticTermPack(), clock: clock(), logger: warn });
    await live.load();
    expect(live.usingPack).toBe(true);
    expect(live.match('you zorbak')).not.toBeNull();
    expect([count(db, 'kit_terms'), count(db, 'kit_term_exceptions')]).toEqual([0, 0]);
    expect(store.isSeeded('synthetic')).toBe(false);
    expect(warn.warn).toHaveBeenCalledTimes(1);
    db.exec('DROP TRIGGER kit_test_boom');
    await live.load();
    expect(live.usingPack).toBe(false);
    expect(store.isSeeded('synthetic')).toBe(true);
    db.close();
  });

  it('store failure on load falls back to pack (the database is closed under it)', async () => {
    const store = openStore({ path: tmpPath() });
    store.close();
    const warn = quiet();
    const live = new LiveTerms({ store, pack: syntheticTermPack(), clock: clock(), logger: warn });
    await expect(live.load()).resolves.toBeUndefined();
    expect(live.usingPack).toBe(true);
    expect(live.match('you zorbak')).toEqual({ termId: 'syn:zorbak' });
    expect(warn.warn).toHaveBeenCalledTimes(1);
  });

  it('no pack and an empty store: matches nothing, never throws', async () => {
    const store = openStore({ path: ':memory:' });
    const live = new LiveTerms({ store, pack: null, clock: clock(), logger: quiet() });
    await live.load();
    expect(live.match('you zorbak')).toBeNull();
    expect(live.usingPack).toBe(false);
    store.close();
  });

  it('an audit row per change lands in kit_audit with the generic columns', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    const c = clock();
    const live = new LiveTerms({ store, pack: syntheticTermPack(), clock: c, logger: quiet() });
    await live.load();
    expect(count(db, 'kit_audit')).toBe(0);
    const add = await live.change('alice', (e) => e.addTerm({ term: 'Blorft', language: 'en', note: 'n' }, ['a line']));
    if (!add.ok) throw new Error('setup');
    c.t = T0 + 1;
    await live.change('bob', (e) => e.setTermActive(add.value, false));
    c.t = T0 + 2;
    const ex = await live.change('bob', (e) => e.addException({ phrase: 'blorft stew', language: 'en' }));
    if (!ex.ok) throw new Error('setup');
    const rows = db.prepare('SELECT * FROM kit_audit ORDER BY rowid').all();
    expect(rows.map((r) => [r.at, r.actor, r.action, r.subject_type, r.subject_ref])).toEqual([
      [T0, 'alice', 'add', 'term', add.value],
      [T0 + 1, 'bob', 'disable', 'term', add.value],
      [T0 + 2, 'bob', 'add', 'exception', ex.value],
    ]);
    expect(rows[0]!.before_json).toBeNull();
    expect(JSON.parse(String(rows[0]!.after_json))).toMatchObject({ id: add.value, term: 'blorft', active: true, note: 'n', hits: ['a line'] });
    expect(JSON.parse(String(rows[1]!.before_json)).active).toBe(true);
    expect(JSON.parse(String(rows[1]!.after_json)).active).toBe(false);
    db.close();
  });

  it('a refused change rolls back rows and audit in SQLite', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    const live = new LiveTerms({ store, pack: syntheticTermPack(), clock: clock(), logger: quiet() });
    await live.load();
    const counts = () => [count(db, 'kit_terms'), count(db, 'kit_term_exceptions'), count(db, 'kit_audit')];
    const before = counts();

    // malformed term, after a good step
    expect(
      (await live.change('a', (e) => {
        e.setTermActive('syn:snerp', false);
        e.addTerm({ term: 'two words', language: 'en' });
      })).ok,
    ).toBe(false);
    // duplicate
    expect((await live.change('a', (e) => e.addTerm({ term: 'ZORBAK', language: 'pt' }))).ok).toBe(false);
    // canary
    expect((await live.change('a', (e) => e.addException({ phrase: 'fenrisk', language: 'en' }))).ok).toBe(false);
    // last active term
    expect(
      (await live.change('a', (e) => SYNTHETIC_TERMS.forEach((t) => e.setTermActive(t.id, false)))).ok,
    ).toBe(false);
    expect(counts()).toEqual(before);
    expect(store.listTerms().every((t) => t.active)).toBe(true);
    expect(live.match('you snerp')).not.toBeNull();
    db.close();
  });

  it('refuses removing the last active term', async () => {
    const store = openStore({ path: ':memory:' });
    const pack = syntheticTermPack({ terms: [syntheticTermPack().terms[0]!], exceptions: [] });
    const live = new LiveTerms({ store, pack, clock: clock(), logger: quiet() });
    await live.load();
    const res = await live.change('a', (e) => e.setTermActive('syn:zorbak', false));
    expect(res.ok).toBe(false);
    expect(store.listTerms()[0]!.active).toBe(true);
    expect(live.match('you zorbak')).not.toBeNull();
    store.close();
  });

  it('exception canary refuses an exception that unblocks a positive line, and a legitimate one passes', async () => {
    const store = openStore({ path: ':memory:' });
    const live = new LiveTerms({ store, pack: syntheticTermPack(), clock: clock(), logger: quiet() });
    await live.load();
    const bad = await live.change('a', (e) => e.addException({ phrase: 'quissel', language: 'en' }));
    expect(bad).toEqual({ ok: false, error: expect.stringContaining('syn:quissel') });
    expect(live.match('you quissel')).not.toBeNull();
    expect((await live.change('a', (e) => e.addException({ phrase: 'blorft stew', language: 'en' }))).ok).toBe(true);
    store.close();
  });

  it('check runs against the pack corpus and the live exceptions', async () => {
    const store = openStore({ path: ':memory:' });
    const live = new LiveTerms({ store, pack: syntheticTermPack({ knownLosses: ['zorba!'] }), clock: clock(), logger: quiet() });
    await live.load();
    expect(live.check('zorba', 'en', ['we like zorba'])).toEqual({ ok: true, hits: expect.arrayContaining(['zorba', 'we like zorba']) });
    const res = live.check('zorba', 'en', []);
    expect(res.ok && res.hits).not.toContain('zorba!');
    expect(live.check('tarvo', 'en', [])).toEqual({ ok: true, hits: [] });
    store.close();
  });

  it('works on a host-owned connection shared with other tables', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE host_things (id INTEGER PRIMARY KEY)');
    const store = openStore({ db });
    const live = new LiveTerms({ store, pack: syntheticTermPack(), clock: clock(), logger: quiet() });
    await live.load();
    expect((await live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' }))).ok).toBe(true);
    expect(live.match('what a blorft')).not.toBeNull();
    expect(count(db, 'host_things')).toBe(0);
    db.close();
  });
});
