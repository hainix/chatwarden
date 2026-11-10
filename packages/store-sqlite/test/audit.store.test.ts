import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, purge, type AuditRow } from '@chatwarden/core';
import { LiveTerms } from '@chatwarden/matcher';
import { MIGRATIONS, openStore } from '../src/index.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const row = (id: string, at: number, over: Partial<AuditRow> = {}): AuditRow => ({
  id,
  at,
  actor: 'alice',
  role: 'moderator',
  action: 'report.view',
  target: { type: 'report', ref: `ref_${id}` },
  ...over,
});

describe('migration 12', () => {
  it('is version 12 and adds a nullable role column and an index on at', () => {
    expect(MIGRATIONS[11]?.version).toBe(12);
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    const cols = db.prepare('PRAGMA table_info(kit_audit)').all();
    const role = cols.find((c) => c.name === 'role');
    expect(role).toBeDefined();
    expect(Number(role?.notnull)).toBe(0);
    const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kit_audit'").all();
    expect(idx.map((i) => String(i.name))).toEqual(expect.arrayContaining(['kit_audit_by_subject']));
    expect(idx.some((i) => /\(\s*at\b/.test(String(i.sql)))).toBe(true);
  });

  it('keeps old rows (json included) with a null role, and the old index', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: MIGRATIONS.slice(0, 11) }).close();
    db.prepare(
      `INSERT INTO kit_audit (id, at, actor, action, subject_type, subject_ref, before_json, after_json)
       VALUES ('old1', ?, 'alice', 'add', 'term', 't1', NULL, '{"term":"zorbak"}'),
              ('old2', ?, 'bob', 'gap.close', 'sanction', 'g1', '{"gapStatus":"open"}', '{"gapStatus":"ruled"}')`,
    ).run(NOW, NOW + 1);
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    const rows = db.prepare('SELECT * FROM kit_audit ORDER BY at').all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'old1', actor: 'alice', action: 'add', role: null, after_json: '{"term":"zorbak"}' });
    expect(rows[1]).toMatchObject({ id: 'old2', role: null, before_json: '{"gapStatus":"open"}' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'kit_audit_by_subject'").all()).toHaveLength(1);
    expect(store.listAudit({ limit: 10 }).map((r) => r.id)).toEqual(['old2', 'old1']);
  });

  it('a failing migration 12 rolls back and leaves version 11', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: MIGRATIONS.slice(0, 11) }).close();
    db.prepare("INSERT INTO kit_audit (id, at, actor, action, subject_type, subject_ref) VALUES ('o', 1, 'a', 'add', 'term', 't')").run();
    const broken = [...MIGRATIONS.slice(0, 11), { version: 12, sql: `${MIGRATIONS[11]?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: MIGRATIONS.slice(0, 11) }).schemaVersion()).toBe(11);
    expect(db.prepare('PRAGMA table_info(kit_audit)').all().some((c) => c.name === 'role')).toBe(false);
    expect(db.prepare('SELECT * FROM kit_audit').all()).toHaveLength(1);
    expect(openStore({ db }).schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
  });
});

describe('legacy rows read through listAudit', () => {
  function legacy() {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    const put = (id: string, at: number, action: string, type: string, ref: string, after: string | null = '{"term":"zorbak"}') =>
      db
        .prepare(
          `INSERT INTO kit_audit (id, at, actor, action, subject_type, subject_ref, before_json, after_json)
           VALUES (?, ?, 'legacy-mod', ?, ?, ?, '{"term":"vlemmo"}', ?)`,
        )
        .run(id, at, action, type, ref, after);
    return { db, store, put };
  }

  it('maps the LiveTerms actions into the union, by subject type', () => {
    const { store, put } = legacy();
    put('a', 1, 'add', 'term', 't1');
    put('b', 2, 'edit', 'term', 't1');
    put('c', 3, 'enable', 'term', 't1');
    put('d', 4, 'disable', 'term', 't1');
    put('e', 5, 'add', 'exception', 'x1');
    put('f', 6, 'edit', 'exception', 'x1');
    put('g', 7, 'enable', 'exception', 'x1');
    put('h', 8, 'disable', 'exception', 'x1');
    put('i', 9, 'gap.close', 'sanction', 'grp1');
    const out = Object.fromEntries(store.listAudit({ limit: 50 }).map((r) => [r.id, r]));
    expect(out.a).toEqual({ id: 'a', at: 1, actor: 'legacy-mod', role: null, action: 'term.add', target: { type: 'term', ref: 't1' } });
    expect(out.b?.action).toBe('term.update');
    expect(out.c?.action).toBe('term.toggle');
    expect(out.d?.action).toBe('term.toggle');
    expect(out.e).toMatchObject({ action: 'exception.add', target: { type: 'exception', ref: 'x1' } });
    expect(out.f?.action).toBe('exception.update');
    expect(out.g?.action).toBe('exception.toggle');
    expect(out.h?.action).toBe('exception.toggle');
    expect(out.i).toMatchObject({ action: 'gap.close', role: null, target: { type: 'sanction', ref: 'grp1' } });
  });

  it('a legacy action that does not map shows as term.update; an unknown target type is dropped', () => {
    const { store, put } = legacy();
    put('x', 1, 'purge-everything', 'term', 't1');
    put('y', 2, 'frobnicate', 'widget', 'w1');
    put('z', 3, 'add', 'widget', 'w1');
    const out = Object.fromEntries(store.listAudit({ limit: 50 }).map((r) => [r.id, r]));
    expect(out.x).toMatchObject({ action: 'term.update', target: { type: 'term', ref: 't1' } });
    expect(out.y?.action).toBe('term.update');
    expect('target' in (out.y as object) && out.y?.target !== null).toBe(false);
    expect(out.z?.action).toBe('term.update');
  });

  it('never returns before_json / after_json or any term text', () => {
    const { store, put } = legacy();
    put('a', 1, 'add', 'term', 't1');
    put('b', 2, 'gap.close', 'sanction', 'g');
    const dumped = JSON.stringify(store.listAudit({ limit: 50 }));
    expect(dumped).not.toMatch(/zorbak|vlemmo|before|after|json/i);
    for (const r of store.listAudit({ limit: 50 })) {
      expect(Object.keys(r).every((k) => ['id', 'at', 'actor', 'role', 'action', 'target'].includes(k))).toBe(true);
    }
  });

  it('the action filter works on the mapped name, legacy and new rows alike', () => {
    const { store, put } = legacy();
    put('a', 1, 'add', 'term', 't1');
    put('b', 2, 'edit', 'term', 't1');
    put('c', 3, 'weird', 'term', 't1');
    store.insertAudit(row('n1', 4, { action: 'term.add', role: 'owner', target: { type: 'term', ref: 't2' } }));
    store.insertAudit(row('n2', 5, { action: 'term.update', role: 'owner', target: { type: 'term', ref: 't2' } }));
    const ids = (action: string) => store.listAudit({ limit: 50, action: action as never }).map((r) => r.id);
    expect(ids('term.add')).toEqual(['n1', 'a']);
    expect(ids('term.update')).toEqual(['n2', 'c', 'b']);
    expect(ids('term.toggle')).toEqual([]);
    expect(ids('exception.add')).toEqual([]);
    expect(ids('report.view')).toEqual([]);
  });

  it('a legacy row can be paged past and purged like a new one', () => {
    const { store, put } = legacy();
    put('a', 1, 'add', 'term', 't1');
    put('b', 1, 'edit', 'term', 't1');
    store.insertAudit(row('n', 1));
    const p1 = store.listAudit({ limit: 2 });
    expect(p1.map((r) => r.id)).toEqual(['n', 'b']);
    const last = p1[1] as AuditRow;
    expect(store.listAudit({ limit: 2, before: last.at, beforeId: last.id }).map((r) => r.id)).toEqual(['a']);
    expect(store.purgeAudit(2)).toBe(3);
  });
});

describe('rows written by the real term editor', () => {
  it('list as term.* / exception.* entries and never show the term, the hits or the json', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    const live = new LiveTerms({ store, pack: null, clock: { now: () => NOW }, logger: { warn() {} } });
    await live.load();
    const made = await live.change('alice', (e) => ({
      t: e.addTerm({ term: 'quissel', language: 'en', note: 'a private note' }, ['a player typed this line quissel']),
      x: e.addException({ phrase: 'drakkuun', language: 'en' }),
      keep: e.addTerm({ term: 'fenrisk', language: 'en' }),
    }));
    if (!made.ok) throw new Error('expected the change to succeed');
    await live.change('bob', (e) => e.updateTerm(made.value.t, { note: 'changed note' }));
    await live.change('bob', (e) => e.setTermActive(made.value.t, false));
    await live.change('carol', (e) => e.updateException(made.value.x, { language: 'xx' }));
    await live.change('carol', (e) => e.setExceptionActive(made.value.x, false));
    const items = store.listAudit({ limit: 50 });
    expect(items.map((i) => `${i.actor}:${i.action}:${i.target?.type}`).sort()).toEqual(
      [
        'alice:term.add:term',
        'alice:term.add:term',
        'alice:exception.add:exception',
        'bob:term.update:term',
        'bob:term.toggle:term',
        'carol:exception.update:exception',
        'carol:exception.toggle:exception',
      ].sort(),
    );
    expect(items.every((i) => i.role === null)).toBe(true);
    const dumped = JSON.stringify(items);
    expect(dumped).not.toMatch(/quissel|drakkuun|typed|note/);
    // The text is in the table (legacy), which is why the store never selects those columns.
    expect(String(db.prepare('SELECT group_concat(after_json) AS j FROM kit_audit').get()?.j)).toContain('quissel');
  });
});

describe('SqliteStore: what is on disk', () => {
  it('a new row writes NULL for both json columns and keeps the role', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    store.insertAudit(row('a', 1, { role: 'owner', target: { type: 'term', ref: 't9' }, action: 'term.toggle' }));
    store.insertAudit(row('b', 2, { role: null, target: null, action: 'policy.view' }));
    const rows = db.prepare('SELECT * FROM kit_audit ORDER BY at').all();
    expect(rows[0]).toMatchObject({
      id: 'a', at: 1, actor: 'alice', role: 'owner', action: 'term.toggle', subject_type: 'term', subject_ref: 't9',
      before_json: null, after_json: null,
    });
    expect(rows[1]).toMatchObject({ role: null, subject_type: '', subject_ref: '', before_json: null, after_json: null });
  });

  it('the scan finds no text: every column of every row is an id, a name, a number or null', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    for (const action of AUDIT_ACTIONS) store.insertAudit(row(`id_${action}`, 1, { action }));
    const allowed = new Set([...AUDIT_ACTIONS, 'alice', 'moderator', 'report', '', null]);
    for (const r of db.prepare('SELECT * FROM kit_audit').all()) {
      for (const [col, v] of Object.entries(r)) {
        if (col === 'id' || col === 'subject_ref' || col === 'at') continue;
        expect(allowed.has(v as never), `${col}=${String(v)}`).toBe(true);
      }
    }
  });

  it('the first page and a cursor page seek the at index instead of scanning', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    for (let i = 0; i < 20; i++) store.insertAudit(row(`i${i}`, i));
    for (const where of ['', 'WHERE at <= 10 AND (at < 10 OR id < \'i9\')']) {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT id FROM kit_audit ${where} ORDER BY at DESC, id DESC LIMIT 5`)
        .all()
        .map((r) => String(r.detail))
        .join(' | ');
      expect(plan).toMatch(/kit_audit_by_at/);
      expect(plan).not.toMatch(/SCAN kit_audit(?! USING)/);
    }
  });
});

describe('purge with the audit trail', () => {
  it('purge() deletes audit rows past auditMs in the same call, and nothing else of the trail', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    store.insertAudit(row('old', NOW - 366 * DAY));
    store.insertAudit(row('line', NOW - 365 * DAY));
    store.insertAudit(row('new', NOW - DAY));
    const res = await purge(store, NOW);
    expect(res.audit).toBe(1);
    expect(store.listAudit({ limit: 9 }).map((r) => r.id)).toEqual(['new', 'line']);
    expect((await purge(store, NOW, { auditMs: 90 * DAY })).audit).toBe(1);
    expect(store.listAudit({ limit: 9 }).map((r) => r.id)).toEqual(['new']);
  });
});
