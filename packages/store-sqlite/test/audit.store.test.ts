import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applySanction, AUDIT_ACTIONS, purge, SubjectIndex, type AuditRow, type Store } from '@chatwarden/core';
import { LiveTerms } from '@chatwarden/matcher';
import { MemoryStore } from '../../core/test/memoryStore.js';
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

const mem = (): Store => new MemoryStore();
const sql = (): Store => openStore({ db: new DatabaseSync(':memory:') });
const stores: Array<[string, () => Store]> = [
  ['MemoryStore', mem],
  ['SqliteStore', sql],
];

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
    expect(store.schemaVersion()).toBe(12);
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
    expect(openStore({ db }).schemaVersion()).toBe(12);
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

describe.each(stores)('%s: insertAudit and listAudit', (_name, make) => {
  it('round-trips a row exactly', () => {
    const s = make();
    const r = row('r1', NOW, { role: 'senior', action: 'sanction.apply', target: { type: 'person', ref: 's_abc' } });
    s.insertAudit(r);
    expect(s.listAudit({ limit: 5 })).toEqual([r]);
  });

  it('a row with no target and no role round-trips as null / null', () => {
    const s = make();
    s.insertAudit(row('r1', NOW, { role: null, target: null, action: 'policy.view' }));
    expect(s.listAudit({ limit: 5 })).toEqual([row('r1', NOW, { role: null, target: null, action: 'policy.view' })]);
  });

  it('newest first, ties on at by id descending', () => {
    const s = make();
    for (const [id, at] of [['b', 10], ['a', 10], ['c', 10], ['d', 5], ['e', 20]] as const) s.insertAudit(row(id, at));
    expect(s.listAudit({ limit: 10 }).map((r) => r.id)).toEqual(['e', 'c', 'b', 'a', 'd']);
  });

  it('keyset paging: before + beforeId, with a tie straddling the page edge', () => {
    const s = make();
    for (const [id, at] of [['a', 10], ['b', 10], ['c', 10], ['d', 10], ['e', 5]] as const) s.insertAudit(row(id, at));
    const p1 = s.listAudit({ limit: 2 });
    expect(p1.map((r) => r.id)).toEqual(['d', 'c']);
    const p2 = s.listAudit({ limit: 2, before: 10, beforeId: 'c' });
    expect(p2.map((r) => r.id)).toEqual(['b', 'a']);
    const p3 = s.listAudit({ limit: 2, before: 10, beforeId: 'a' });
    expect(p3.map((r) => r.id)).toEqual(['e']);
    expect(s.listAudit({ limit: 2, before: 5, beforeId: 'e' })).toEqual([]);
  });

  it('before without beforeId is exclusive on at; beforeId without before is ignored', () => {
    const s = make();
    for (const [id, at] of [['a', 10], ['b', 10], ['c', 5]] as const) s.insertAudit(row(id, at));
    expect(s.listAudit({ limit: 9, before: 10 }).map((r) => r.id)).toEqual(['c']);
    expect(s.listAudit({ limit: 9, beforeId: 'a' }).map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('filters by actor and action, alone and together', () => {
    const s = make();
    s.insertAudit(row('1', 1, { actor: 'alice', action: 'report.view' }));
    s.insertAudit(row('2', 2, { actor: 'bob', action: 'report.view' }));
    s.insertAudit(row('3', 3, { actor: 'alice', action: 'suggest' }));
    const ids = (q: object) => s.listAudit({ limit: 9, ...q }).map((r) => r.id);
    expect(ids({ actor: 'alice' })).toEqual(['3', '1']);
    expect(ids({ action: 'report.view' })).toEqual(['2', '1']);
    expect(ids({ actor: 'alice', action: 'report.view' })).toEqual(['1']);
    expect(ids({ actor: 'nobody' })).toEqual([]);
    expect(ids({ actor: 'Alice' })).toEqual([]);
  });

  it('limit is clamped to 1..200 and a fraction is floored', () => {
    const s = make();
    for (let i = 0; i < 205; i++) s.insertAudit(row(`id${String(i).padStart(3, '0')}`, i));
    expect(s.listAudit({ limit: 500 })).toHaveLength(200);
    expect(s.listAudit({ limit: 0 })).toHaveLength(1);
    expect(s.listAudit({ limit: 2.9 })).toHaveLength(2);
  });

  it('a duplicate id throws and writes nothing', () => {
    const s = make();
    s.insertAudit(row('same', 1));
    expect(() => s.insertAudit(row('same', 2))).toThrow();
    expect(s.listAudit({ limit: 9 })).toHaveLength(1);
  });

  it('insertAudit joins the surrounding transaction: a throw after it undoes it', () => {
    const s = make();
    s.insertAudit(row('keep', 1));
    expect(() =>
      s.transaction(() => {
        s.insertAudit(row('gone', 2));
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(s.listAudit({ limit: 9 }).map((r) => r.id)).toEqual(['keep']);
  });

  it('listed rows are copies', () => {
    const s = make();
    s.insertAudit(row('a', 1));
    const [first] = s.listAudit({ limit: 1 });
    if (first?.target) first.target.ref = 'tampered';
    expect(s.listAudit({ limit: 1 })[0]?.target?.ref).toBe('ref_a');
  });

  it('purgeAudit deletes strictly older rows and returns the count; a row on the line is kept', () => {
    const s = make();
    s.insertAudit(row('old', 99));
    s.insertAudit(row('line', 100));
    s.insertAudit(row('new', 101));
    expect(s.purgeAudit(100)).toBe(1);
    expect(s.listAudit({ limit: 9 }).map((r) => r.id)).toEqual(['new', 'line']);
    expect(s.purgeAudit(100)).toBe(0);
    expect(s.purgeAudit(1_000)).toBe(2);
  });

  it('purgeAudit is undone with its transaction', () => {
    const s = make();
    s.insertAudit(row('a', 1));
    expect(() =>
      s.transaction(() => {
        s.purgeAudit(100);
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(s.listAudit({ limit: 9 })).toHaveLength(1);
  });
});

describe('both stores agree', () => {
  it('give identical pages for the same writes, filters and cursors', () => {
    const a = mem();
    const b = sql();
    const actions = AUDIT_ACTIONS;
    for (let i = 0; i < 40; i++) {
      const r = row(`id${String(i * 7 % 40).padStart(2, '0')}`, NOW + Math.floor(i / 4), {
        actor: i % 3 === 0 ? 'alice' : 'bob',
        action: actions[i % actions.length] as AuditRow['action'],
        role: i % 5 === 0 ? null : (['moderator', 'senior', 'owner'] as const)[i % 3] ?? null,
        target: i % 4 === 0 ? null : { type: 'report', ref: `r${i}` },
      });
      a.insertAudit(r);
      b.insertAudit(r);
    }
    const queries: Array<Parameters<Store['listAudit']>[0]> = [
      { limit: 200 },
      { limit: 7 },
      { limit: 7, actor: 'alice' },
      { limit: 7, action: 'report.view' },
      { limit: 3, actor: 'bob', action: 'suggest' },
      { limit: 5, before: NOW + 5 },
      { limit: 5, before: NOW + 5, beforeId: 'id20' },
      { limit: 5, before: NOW + 5, beforeId: 'zzz' },
    ];
    for (const q of queries) expect(b.listAudit(q), JSON.stringify(q)).toEqual(a.listAudit(q));
    expect(b.purgeAudit(NOW + 4)).toBe(a.purgeAudit(NOW + 4));
    expect(b.listAudit({ limit: 200 })).toEqual(a.listAudit({ limit: 200 }));
  });

  it('closeGap records a gap.close entry (null role, sanction target) in both', async () => {
    const results: AuditRow[][] = [];
    for (const [, make] of stores) {
      const store = make();
      const subjects = new SubjectIndex(store, { now: () => NOW }, { logger: { warn() {} } });
      const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: null });
      if (s === null) throw new Error('expected a subject');
      const w = await applySanction(
        store,
        subjects,
        {
          kind: 'ban', subject: s, includeIp: false, durationMs: null, reason: 'r', actor: 'mod', source: 'moderator',
          automated: false, rule: 'uncovered', gapNote: 'a note about a gap',
        } as never,
        NOW,
      );
      expect(store.closeGap(w.groupId, 'ruled', '9', 'boss', NOW + 100)).toBe(true);
      expect(store.closeGap(w.groupId, 'ruled', '9', 'boss', NOW + 200)).toBe(false);
      const items = store.listAudit({ limit: 10 });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ at: NOW + 100, actor: 'boss', role: null, action: 'gap.close', target: { type: 'sanction', ref: w.groupId } });
      results.push(items.map((i) => ({ ...i, id: 'x', target: { type: 'sanction', ref: 'g' } })));
    }
    expect(results[1]).toEqual(results[0]);
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
