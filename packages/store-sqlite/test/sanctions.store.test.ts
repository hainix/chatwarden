import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applySanction,
  revokeSanction,
  SANCTION_KINDS,
  SanctionIndex,
  SubjectIndex,
  type Identifiers,
  type SanctionInput,
  type SanctionRow,
} from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const none: Identifiers = { clientKey: null, accountId: null, ipHash: null };

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-sanc-'));
  tmpDirs.push(dir);
  return join(dir, 'kit.db');
}

function row(over: Partial<SanctionRow> = {}): SanctionRow {
  return {
    id: 'r1',
    groupId: 'g1',
    refCode: 'M-AAAAA',
    kind: 'chat',
    targetType: 'subject',
    value: 's_x',
    startsAt: NOW,
    endsAt: NOW + H,
    reason: 'private',
    rule: null,
    gapNote: null,
    gapStatus: null,
    roomId: null,
    actor: 'mod',
    source: 'moderator',
    automated: false,
    pending: false,
    ...over,
  };
}

function env(db = new DatabaseSync(':memory:')) {
  const store = openStore({ db });
  const clock = { now: () => NOW };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const index = new SanctionIndex({ enabled: () => true, subjects });
  return { db, store, subjects, index };
}

function input(subject: string, over: Partial<SanctionInput> = {}): SanctionInput {
  return {
    kind: 'chat',
    subject,
    includeIp: false,
    durationMs: H,
    reason: 'slurs',
    actor: 'mod@x.com',
    source: 'moderator',
    automated: false,
    rule: 1,
    ...over,
  };
}

const dump = (db: DatabaseSync) =>
  db.prepare('SELECT * FROM kit_sanctions ORDER BY rowid').all() as Record<string, unknown>[];

describe('migration 3: kit_sanctions', () => {
  it('is version 3 and creates the table with the documented columns', () => {
    expect(MIGRATIONS[2]?.version).toBe(3);
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(3);
    const cols = db.prepare('PRAGMA table_info(kit_sanctions)').all().map((c) => String(c.name));
    expect(cols).toEqual([
      'id', 'group_id', 'ref_code', 'kind', 'target_type', 'target_value', 'starts_at', 'ends_at', 'reason',
      'rule', 'actor', 'source', 'automated', 'pending', 'revoked_by', 'revoked_at', 'revoke_reason',
      'gap_note', 'gap_status', 'gap_ref', 'room_id',
    ]);
    db.close();
  });

  it('upgrades a version 2 database in place and keeps its subjects', async () => {
    const path = tmpPath();
    const v2 = openStore({ path, migrations: MIGRATIONS.slice(0, 2) });
    await v2.saveSubject({ id: 's_a', createdAt: 5, mergedInto: null });
    expect(v2.schemaVersion()).toBe(2);
    v2.close();
    const v3 = openStore({ path });
    expect(v3.schemaVersion()).toBeGreaterThanOrEqual(3);
    expect((await v3.loadSubjects()).subjects).toHaveLength(1);
    expect(v3.loadSanctions(NOW)).toEqual([]);
    v3.close();
  });

  it('only touches kit_ tables', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    openStore({ db });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    expect(names.filter((n) => !n.startsWith('kit_') && !n.startsWith('sqlite_'))).toEqual(['users']);
    db.close();
  });

  it('rejects an unknown kind, target type or source at the database', () => {
    const { store, db } = env();
    expect(() => store.insertSanctionGroup([row({ kind: 'timeout' as never })])).toThrow();
    expect(() => store.insertSanctionGroup([row({ targetType: 'account' as never })])).toThrow();
    expect(() => store.insertSanctionGroup([row({ source: 'nobody' as never })])).toThrow();
    expect(dump(db)).toEqual([]);
  });
});

describe('SqliteStore sanction methods', () => {
  it('round-trips a group: every column, booleans as 0/1, null rule and end preserved', () => {
    const { store, db } = env();
    expect(
      store.insertSanctionGroup([
        row({ rule: '3.1', automated: true, pending: true, endsAt: null, source: 'auto_filter' }),
        row({ id: 'r2', targetType: 'ip', value: 'iphash', endsAt: NOW + DAY }),
      ]),
    ).toBe(true);
    const raw = dump(db);
    expect(raw).toHaveLength(2);
    expect(raw[0]).toMatchObject({
      id: 'r1', group_id: 'g1', ref_code: 'M-AAAAA', kind: 'chat', target_type: 'subject', target_value: 's_x',
      starts_at: NOW, ends_at: null, reason: 'private', rule: '3.1', actor: 'mod', source: 'auto_filter',
      automated: 1, pending: 1, revoked_by: null, revoked_at: null, revoke_reason: null,
    });
    expect(raw[1]).toMatchObject({ target_type: 'ip', target_value: 'iphash', rule: null, automated: 0, pending: 0 });
    const loaded = store.loadSanctions(NOW);
    expect(loaded[0]).toEqual(row({ rule: '3.1', automated: true, pending: true, endsAt: null, source: 'auto_filter' }));
    expect(loaded[1]?.targetType).toBe('ip');
  });

  it('is all-or-nothing: a failure on the SECOND row leaves nothing behind', () => {
    const { store, db } = env();
    db.exec(`CREATE TRIGGER fail_ip BEFORE INSERT ON kit_sanctions WHEN NEW.target_type = 'ip'
             BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(() =>
      store.insertSanctionGroup([row(), row({ id: 'r2', targetType: 'ip', value: 'iphash' })]),
    ).toThrow(/boom/);
    expect(dump(db)).toEqual([]);
    // No savepoint was left open: the next write works.
    db.exec('DROP TRIGGER fail_ip');
    expect(store.insertSanctionGroup([row()])).toBe(true);
    expect(dump(db)).toHaveLength(1);
  });

  it('returns false and writes nothing when another group already has the ref code', () => {
    const { store, db } = env();
    expect(store.insertSanctionGroup([row()])).toBe(true);
    expect(store.insertSanctionGroup([row({ id: 'r9', groupId: 'g2' }), row({ id: 'r10', groupId: 'g2', targetType: 'ip', value: 'i' })])).toBe(false);
    expect(dump(db)).toHaveLength(1);
    expect(store.insertSanctionGroup([row({ id: 'r9', groupId: 'g2', refCode: 'M-BBBBB' })])).toBe(true);
  });

  it('the database itself enforces one ref code per group (unique index on ref_code)', () => {
    const { db } = env();
    const ins = db.prepare(
      `INSERT INTO kit_sanctions (id, group_id, ref_code, kind, target_type, target_value, starts_at, reason, actor, source, automated, pending)
       VALUES (?, ?, ?, 'chat', 'subject', ?, 0, 'r', 'a', 'api', 0, 0)`,
    );
    ins.run('a', 'g1', 'M-AAAAA', 's1');
    expect(() => ins.run('b', 'g2', 'M-AAAAA', 's2')).toThrow(/UNIQUE/i);
  });

  it('a group may carry its ref code on both of its rows', () => {
    const { store, db } = env();
    expect(store.insertSanctionGroup([row(), row({ id: 'r2', targetType: 'ip', value: 'i' })])).toBe(true);
    expect(dump(db).map((r) => r.ref_code)).toEqual(['M-AAAAA', 'M-AAAAA']);
  });

  it('an empty group writes nothing and succeeds', () => {
    const { store, db } = env();
    expect(store.insertSanctionGroup([])).toBe(true);
    expect(dump(db)).toEqual([]);
  });

  it('revokes every row of the group only; the first revoke wins; unknown group changes nothing', () => {
    const { store, db } = env();
    store.insertSanctionGroup([row(), row({ id: 'r2', targetType: 'ip', value: 'i' })]);
    store.insertSanctionGroup([row({ id: 'r3', groupId: 'g2', refCode: 'M-BBBBB' })]);
    expect(store.revokeSanctionGroup('g1', 'first', NOW + 1, 'first reason')).toBe(2);
    expect(store.revokeSanctionGroup('g1', 'second', NOW + 2, 'second reason')).toBe(0);
    expect(store.revokeSanctionGroup('nope', 'x', NOW, 'r')).toBe(0);
    const raw = dump(db);
    for (const r of raw.filter((x) => x.group_id === 'g1')) {
      expect(r).toMatchObject({ revoked_by: 'first', revoked_at: NOW + 1, revoke_reason: 'first reason' });
    }
    expect(raw.find((x) => x.group_id === 'g2')).toMatchObject({ revoked_by: null, revoked_at: null });
  });

  it('loadSanctions leaves out revoked rows and rows that ended at or before now', () => {
    const { store } = env();
    store.insertSanctionGroup([row({ id: 'live', groupId: 'g1', refCode: 'M-AAAAA', endsAt: NOW + H })]);
    store.insertSanctionGroup([row({ id: 'perm', groupId: 'g2', refCode: 'M-BBBBB', endsAt: null })]);
    store.insertSanctionGroup([row({ id: 'edge', groupId: 'g3', refCode: 'M-CCCCC', endsAt: NOW })]);
    store.insertSanctionGroup([row({ id: 'past', groupId: 'g4', refCode: 'M-DDDDD', endsAt: NOW - 1 })]);
    store.insertSanctionGroup([row({ id: 'gone', groupId: 'g5', refCode: 'M-EEEEE' })]);
    store.revokeSanctionGroup('g5', 'm', NOW, 'r');
    expect(store.loadSanctions(NOW).map((r) => r.id).sort()).toEqual(['live', 'perm']);
  });
});

describe('sanctions on a real database file', () => {
  it('survives a reopen: apply, revoke, reload an index and enforce', async () => {
    const path = tmpPath();
    let store = openStore({ path });
    const clock = { now: () => NOW };
    let subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    await subjects.load();
    const s1 = subjects.resolve({ clientKey: 'k1', accountId: 'a1', ipHash: 'ip1' });
    if (s1 === null) throw new Error('subject');
    const index = new SanctionIndex({ enabled: () => true, subjects });
    const keep = await applySanction(store, subjects, input(s1, { includeIp: true, rule: 2 }), NOW, index);
    const drop = await applySanction(store, subjects, input(s1, { kind: 'ban', durationMs: null }), NOW, index);
    await revokeSanction(store, drop.groupId, 'boss', NOW + 1, 'mistake', index);
    await subjects.flush();
    store.close();

    store = openStore({ path });
    subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    await subjects.load();
    const fresh = new SanctionIndex({ enabled: () => true, subjects });
    await fresh.load(store, NOW + 2);
    expect(fresh.active('chat', none, s1, NOW + 2)).toEqual({
      until: NOW + H, automated: false, groupId: keep.groupId, refCode: keep.refCode, rule: '2', own: true,
    });
    expect(fresh.active('chat', { clientKey: null, accountId: null, ipHash: 'ip1' }, null, NOW + 2)).not.toBeNull();
    expect(fresh.active('ban', none, s1, NOW + 2)).toBeNull();
    const kept = store.loadSanctions(NOW + 2);
    expect(kept.every((r) => r.rule === '2')).toBe(true);
    store.close();
  });

  it('a collision-free group of 200 sanctions keeps unique ref codes at the database', async () => {
    const { store, subjects, db } = env();
    const s = subjects.resolve({ clientKey: 'k', accountId: null, ipHash: null });
    if (s === null) throw new Error('subject');
    for (let i = 0; i < 200; i++) await applySanction(store, subjects, input(s, { durationMs: 1 }), NOW);
    const codes = dump(db).map((r) => r.ref_code);
    expect(new Set(codes).size).toBe(200);
  });

  it('a sanction follows a merge after a reload (the merge is stored, the row names the old subject)', async () => {
    const path = tmpPath();
    const t = { t: NOW, now: () => t.t };
    let store = openStore({ path });
    let subjects = new SubjectIndex(store, t, { logger: { warn() {} } });
    await subjects.load();
    const older = subjects.resolve({ clientKey: 'k-old', accountId: null, ipHash: null });
    t.t = NOW + 1_000;
    const younger = subjects.resolve({ clientKey: 'k-young', accountId: null, ipHash: null });
    if (older === null || younger === null) throw new Error('subject');
    await applySanction(store, subjects, input(younger), t.t);
    subjects.resolve({ clientKey: 'k-young', accountId: 'acct', ipHash: null });
    subjects.resolve({ clientKey: 'k-old', accountId: 'acct', ipHash: null });
    await subjects.flush();
    store.close();

    store = openStore({ path });
    subjects = new SubjectIndex(store, t, { logger: { warn() {} } });
    await subjects.load();
    const idx = new SanctionIndex({ enabled: () => true, subjects });
    await idx.load(store, t.t);
    expect(idx.active('chat', none, subjects.canonical(older), t.t)).not.toBeNull();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// K2 Task 3: migration 7 (the Warning kind and the rule-gap columns), listGaps and closeGap
// ---------------------------------------------------------------------------

const GAP = 'private gap note';
const v6 = MIGRATIONS.slice(0, 6);

/** A version 6 database holding a few sanction rows written the way version 6 wrote them. */
function seedV6(db: DatabaseSync): void {
  openStore({ db, migrations: v6 });
  const ins = db.prepare(
    `INSERT INTO kit_sanctions
       (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending,
        revoked_by, revoked_at, revoke_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run('a1', 'ga', 'M-AAAAA', 'chat', 'subject', 's_a', NOW, NOW + H, 'slur', null, 'auto', 'auto_filter', 1, 0, null, null, null);
  ins.run('a2', 'ga', 'M-AAAAA', 'chat', 'ip', 'iphash', NOW, NOW + H, 'slur', null, 'auto', 'auto_filter', 1, 1, null, null, null);
  ins.run('b1', 'gb', 'M-BBBBB', 'ban', 'subject', 's_b', NOW + 5, null, 'bad', '3.1', 'mod', 'moderator', 0, 0, 'boss', NOW + 9, 'appeal');
  ins.run('c1', 'gc', 'M-CCCCC', 'area', 'subject', 's_c', NOW + 7, NOW + 2 * H, 'x', null, 'mod', 'api', 0, 0, null, null, null);
}

describe('migration 7: kit_sanctions rebuild', () => {
  it('is version 7', () => {
    expect(MIGRATIONS[6]?.version).toBe(7);
  });

  it('adds the three gap columns after the old ones', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: MIGRATIONS.slice(0, 7) });
    const cols = db.prepare('PRAGMA table_info(kit_sanctions)').all().map((c) => String(c.name));
    expect(cols.slice(-3)).toEqual(['gap_note', 'gap_status', 'gap_ref']);
    expect(cols).toHaveLength(20);
    db.close();
  });

  it('keeps every existing row, column for column and in the same order', () => {
    const db = new DatabaseSync(':memory:');
    seedV6(db);
    const before = dump(db);
    const store = openStore({ db });
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(7);
    const after = dump(db);
    expect(after).toHaveLength(4);
    after.forEach((r, i) => {
      expect(r).toMatchObject(before[i] as Record<string, unknown>);
      expect(r).toMatchObject({ gap_note: null, gap_status: null, gap_ref: null });
    });
    expect(after.map((r) => r.id)).toEqual(['a1', 'a2', 'b1', 'c1']);
    // The old revocation survived: loadSanctions leaves the revoked ban out, keeps the rest.
    expect(store.loadSanctions(NOW + 10).map((r) => r.id)).toEqual(['a1', 'a2', 'c1']);
    expect(after.find((r) => r.id === 'b1')).toMatchObject({ revoked_by: 'boss', revoked_at: NOW + 9, revoke_reason: 'appeal' });
    db.close();
  });

  it('keeps the old rule text and reads a null rule as null', () => {
    const db = new DatabaseSync(':memory:');
    seedV6(db);
    const store = openStore({ db });
    const rules = store.loadSanctions(NOW - 1).map((r) => [r.id, r.rule]);
    expect(rules).toEqual([['a1', null], ['a2', null], ['c1', null]]);
    db.close();
  });

  it('recreates the indexes, the ref-code uniqueness among them', () => {
    const db = new DatabaseSync(':memory:');
    seedV6(db);
    openStore({ db });
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kit_sanctions' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name").all();
    expect(idx.map((r) => String(r.name))).toEqual(['kit_sanctions_by_group', 'kit_sanctions_by_target', 'kit_sanctions_ref_code']);
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_sanctions_ref_code'").get()?.sql);
    expect(sql).toMatch(/UNIQUE/i);
    expect(sql).toMatch(/WHERE target_type = 'subject'/);
    const ins = db.prepare(
      `INSERT INTO kit_sanctions (id, group_id, ref_code, kind, target_type, target_value, starts_at, reason, actor, source, automated, pending)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'r', 'a', 'api', 0, 0)`,
    );
    // An existing code cannot be taken by another group's subject row...
    expect(() => ins.run('z1', 'gz', 'M-AAAAA', 'chat', 'subject', 's_z')).toThrow(/UNIQUE/i);
    expect(() => ins.run('z2', 'gz', 'M-BBBBB', 'warning', 'subject', 's_z')).toThrow(/UNIQUE/i);
    // ...but the IP row of a group repeats its group's code (the index is partial).
    ins.run('z3', 'ga', 'M-AAAAA', 'chat', 'ip', 'other-ip');
    db.close();
  });

  it('leaves no scratch table behind and no foreign key problems', () => {
    const db = new DatabaseSync(':memory:');
    seedV6(db);
    openStore({ db });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kit_sanctions%'").all();
    expect(names.map((r) => String(r.name))).toEqual(['kit_sanctions']);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('accepts the warning kind and still rejects an unknown kind', () => {
    const { store, db } = env();
    expect(store.insertSanctionGroup([row({ kind: 'warning', endsAt: NOW })])).toBe(true);
    expect(dump(db)[0]).toMatchObject({ kind: 'warning', starts_at: NOW, ends_at: NOW });
    expect(() => store.insertSanctionGroup([row({ id: 'r2', groupId: 'g2', refCode: 'M-BBBBB', kind: 'timeout' as never })])).toThrow();
  });

  it('keeps SANCTION_KINDS and the CHECK constraint in step', () => {
    const { db, store } = env();
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_sanctions'").get()?.sql);
    const list = /kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? '';
    const checked = list.split(',').map((x) => x.trim().replace(/'/g, ''));
    expect([...checked].sort()).toEqual([...SANCTION_KINDS].sort());
    // And every kind the code knows really inserts.
    SANCTION_KINDS.forEach((kind, i) => {
      expect(store.insertSanctionGroup([row({ id: `k${i}`, groupId: `gk${i}`, refCode: `M-KKKK${i}`, kind })])).toBe(true);
    });
  });

  it('checks gap_status at the database', () => {
    const { db } = env();
    const ins = db.prepare(
      `INSERT INTO kit_sanctions (id, group_id, ref_code, kind, target_type, target_value, starts_at, reason, actor, source, automated, pending, gap_note, gap_status)
       VALUES (?, ?, ?, 'chat', 'subject', 's', 0, 'r', 'a', 'moderator', 0, 0, 'n', ?)`,
    );
    ins.run('a', 'g1', 'M-AAAAA', 'open');
    ins.run('b', 'g2', 'M-BBBBB', 'ruled');
    ins.run('c', 'g3', 'M-CCCCC', 'not_a_rule');
    expect(() => ins.run('d', 'g4', 'M-DDDDD', 'closed')).toThrow(/CHECK/i);
  });

  it('is all-or-nothing: a failure inside the migration restores the old table and version', () => {
    const db = new DatabaseSync(':memory:');
    seedV6(db);
    const broken = [...v6, { version: 7, sql: `${MIGRATIONS[6]?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    const cols = db.prepare('PRAGMA table_info(kit_sanctions)').all().map((c) => String(c.name));
    expect(cols).toHaveLength(17);
    expect(dump(db)).toHaveLength(4);
    expect(String(db.prepare("SELECT value FROM kit_meta WHERE key = 'schema_version'").get()?.value)).toBe('6');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kit_sanctions' AND name NOT LIKE 'sqlite_autoindex%'").all();
    expect(idx).toHaveLength(3);
    // And a proper retry works.
    expect(openStore({ db }).schemaVersion()).toBeGreaterThanOrEqual(7);
    expect(dump(db)).toHaveLength(4);
    db.close();
  });

  it('upgrades a version 6 file on disk', () => {
    const path = tmpPath();
    const raw = new DatabaseSync(path);
    seedV6(raw);
    raw.close();
    const store = openStore({ path });
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(7);
    expect(store.loadSanctions(NOW).map((r) => r.id)).toEqual(['a1', 'a2', 'c1']);
    store.close();
  });

  it('a fresh database has no rows and no gaps', () => {
    const { store } = env();
    expect(store.loadSanctions(NOW)).toEqual([]);
    expect(store.listGaps()).toEqual([]);
  });
});

describe('a warning in the sqlite store', () => {
  it('applySanction writes one row, ends = starts, and loads nowhere', async () => {
    const { store, subjects, index, db } = env();
    const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'ip1' });
    if (s === null) throw new Error('subject');
    await applySanction(store, subjects, input(s, { kind: 'warning', durationMs: null }), NOW, index);
    expect(dump(db)).toHaveLength(1);
    expect(dump(db)[0]).toMatchObject({ kind: 'warning', starts_at: NOW, ends_at: NOW, rule: '1', target_type: 'subject' });
    // Even loaded early enough that the store hands the row back, the index keeps it out.
    expect(store.loadSanctions(NOW - 1)).toHaveLength(1);
    const fresh = new SanctionIndex({ enabled: () => true, subjects });
    await fresh.load(store, NOW - 1);
    for (const kind of SANCTION_KINDS) {
      expect(fresh.active(kind, { clientKey: null, accountId: null, ipHash: 'ip1' }, s, NOW - 1)).toBeNull();
    }
    expect(index.active('ban', none, s, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// K3a Task 2: migration 11 (the Note kind and the room column), notes and room ids in the sqlite store
// ---------------------------------------------------------------------------

const v10 = MIGRATIONS.slice(0, 10);

/** A version 10 database holding sanction rows the way versions 7..10 wrote them, gap columns and a revoke included. */
function seedV10(db: DatabaseSync): void {
  openStore({ db, migrations: v10 });
  const ins = db.prepare(
    `INSERT INTO kit_sanctions
       (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending,
        revoked_by, revoked_at, revoke_reason, gap_note, gap_status, gap_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run('a1', 'ga', 'M-AAAAA', 'chat', 'subject', 's_a', NOW, NOW + H, 'slur', '1', 'auto', 'auto_filter', 1, 0, null, null, null, null, null, null);
  ins.run('a2', 'ga', 'M-AAAAA', 'chat', 'ip', 'iphash', NOW, NOW + H, 'slur', '1', 'auto', 'auto_filter', 1, 1, null, null, null, null, null, null);
  ins.run('b1', 'gb', 'M-BBBBB', 'ban', 'subject', 's_b', NOW + 5, null, 'bad', '3', 'mod', 'moderator', 0, 0, 'boss', NOW + 9, 'appeal', null, null, null);
  ins.run('c1', 'gc', 'M-CCCCC', 'warning', 'subject', 's_c', NOW + 7, NOW + 7, 'x', 'uncovered', 'mod', 'moderator', 0, 0, null, null, null, 'gap text', 'ruled', '9');
  ins.run('d1', 'gd', 'M-DDDDD', 'area', 'subject', 's_d', NOW + 8, NOW + 2 * H, 'y', null, 'mod', 'api', 0, 1, null, null, null, 'open gap', 'open', null);
}

describe('migration 11: kit_sanctions rebuild (kind CHECK gains note, room_id added)', () => {
  it('is version 11', () => {
    expect(MIGRATIONS[10]?.version).toBe(11);
    expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(11);
  });

  it('a fresh database has room_id as the last column, nullable TEXT', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const info = db.prepare('PRAGMA table_info(kit_sanctions)').all();
    expect(info).toHaveLength(21);
    expect(info.at(-1)).toMatchObject({ name: 'room_id', type: 'TEXT', notnull: 0, dflt_value: null });
    expect(info.slice(-4, -1).map((c) => String(c.name))).toEqual(['gap_note', 'gap_status', 'gap_ref']);
    db.close();
  });

  it('keeps every existing row, every column (gap_ref and the revoke included), in the same order, with a null room', () => {
    const db = new DatabaseSync(':memory:');
    seedV10(db);
    const before = dump(db);
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    const after = dump(db);
    expect(after.map((r) => r.id)).toEqual(['a1', 'a2', 'b1', 'c1', 'd1']);
    after.forEach((r, i) => {
      expect(r).toMatchObject(before[i] as Record<string, unknown>);
      expect(r.room_id).toBeNull();
    });
    expect(after.find((r) => r.id === 'c1')).toMatchObject({ gap_note: 'gap text', gap_status: 'ruled', gap_ref: '9', kind: 'warning' });
    expect(after.find((r) => r.id === 'b1')).toMatchObject({ revoked_by: 'boss', revoked_at: NOW + 9, revoke_reason: 'appeal' });
    // Read through the store: old rows have no room.
    expect(store.loadSubjectActions(0).map((r) => [r.id, r.roomId])).toEqual([['a1', null], ['b1', null], ['c1', null], ['d1', null]]);
    expect(store.listGaps().map((r) => r.id)).toEqual(['d1', 'c1']);
    db.close();
  });

  it('recreates every index, the partial unique ref_code one included', () => {
    const db = new DatabaseSync(':memory:');
    seedV10(db);
    openStore({ db });
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kit_sanctions' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name")
      .all();
    expect(idx.map((r) => String(r.name))).toEqual(['kit_sanctions_by_group', 'kit_sanctions_by_target', 'kit_sanctions_ref_code']);
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_sanctions_ref_code'").get()?.sql);
    expect(sql).toMatch(/UNIQUE/i);
    expect(sql).toMatch(/WHERE target_type = 'subject'/);
    const ins = db.prepare(
      `INSERT INTO kit_sanctions (id, group_id, ref_code, kind, target_type, target_value, starts_at, reason, actor, source, automated, pending)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'r', 'a', 'api', 0, 0)`,
    );
    expect(() => ins.run('z1', 'gz', 'M-AAAAA', 'chat', 'subject', 's_z')).toThrow(/UNIQUE/i);
    expect(() => ins.run('z2', 'gz', 'M-BBBBB', 'note', 'subject', 's_z')).toThrow(/UNIQUE/i);
    ins.run('z3', 'ga', 'M-AAAAA', 'chat', 'ip', 'other-ip');
    db.close();
  });

  it('leaves no scratch table behind and no foreign key problems', () => {
    const db = new DatabaseSync(':memory:');
    seedV10(db);
    openStore({ db });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kit_sanctions%'").all();
    expect(names.map((r) => String(r.name))).toEqual(['kit_sanctions']);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('accepts the note kind (and the old kinds) and still rejects an unknown kind', () => {
    const { store, db } = env();
    expect(store.insertSanctionGroup([row({ kind: 'note', endsAt: NOW, roomId: 'room-1' })])).toBe(true);
    expect(dump(db)[0]).toMatchObject({ kind: 'note', starts_at: NOW, ends_at: NOW, room_id: 'room-1' });
    expect(() => store.insertSanctionGroup([row({ id: 'r2', groupId: 'g2', refCode: 'M-BBBBB', kind: 'timeout' as never })])).toThrow();
  });

  it('the CHECK lists exactly SANCTION_KINDS, and note is one of them', () => {
    const { db } = env();
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_sanctions'").get()?.sql);
    const list = /kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? '';
    const checked = list.split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(checked).toContain('note');
    expect([...checked].sort()).toEqual([...SANCTION_KINDS].sort());
  });

  it('the old kinds and the other CHECKs survive the rebuild (target_type, source, gap_status, automated)', () => {
    const { db } = env();
    const base = (over: string) =>
      `INSERT INTO kit_sanctions (id, group_id, ref_code, kind, target_type, target_value, starts_at, reason, actor, source, automated, pending, gap_status)
       VALUES ${over}`;
    expect(() => db.prepare(base("('a','g','M-AAAAA','chat','group','v',0,'r','a','api',0,0,NULL)")).run()).toThrow(/CHECK/i);
    expect(() => db.prepare(base("('a','g','M-AAAAA','chat','subject','v',0,'r','a','robot',0,0,NULL)")).run()).toThrow(/CHECK/i);
    expect(() => db.prepare(base("('a','g','M-AAAAA','chat','subject','v',0,'r','a','api',2,0,NULL)")).run()).toThrow(/CHECK/i);
    expect(() => db.prepare(base("('a','g','M-AAAAA','chat','subject','v',0,'r','a','api',0,0,'closed')")).run()).toThrow(/CHECK/i);
    db.prepare(base("('a','g','M-AAAAA','chat','subject','v',0,'r','a','api',0,0,'open')")).run();
  });

  it('is all-or-nothing: a failure inside the migration restores the old table, rows and version', () => {
    const db = new DatabaseSync(':memory:');
    seedV10(db);
    const broken = [...v10, { version: 11, sql: `${MIGRATIONS[10]?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    const cols = db.prepare('PRAGMA table_info(kit_sanctions)').all().map((c) => String(c.name));
    expect(cols).toHaveLength(20);
    expect(cols).not.toContain('room_id');
    expect(dump(db)).toHaveLength(5);
    expect(String(db.prepare("SELECT value FROM kit_meta WHERE key = 'schema_version'").get()?.value)).toBe('10');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kit_sanctions' AND name NOT LIKE 'sqlite_autoindex%'").all();
    expect(idx).toHaveLength(3);
    // The old table still refuses a note...
    expect(() =>
      db
        .prepare(
          `INSERT INTO kit_sanctions (id, group_id, ref_code, kind, target_type, target_value, starts_at, reason, actor, source, automated, pending)
           VALUES ('n', 'gn', 'M-NNNNN', 'note', 'subject', 's', 0, 'r', 'a', 'api', 0, 0)`,
        )
        .run(),
    ).toThrow(/CHECK/i);
    // ...and a proper retry works.
    expect(openStore({ db }).schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(dump(db)).toHaveLength(5);
    db.close();
  });

  it('upgrades a version 10 file on disk', () => {
    const path = tmpPath();
    const raw = new DatabaseSync(path);
    seedV10(raw);
    raw.close();
    const store = openStore({ path });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(store.loadSanctions(NOW).map((r) => r.id)).toEqual(['a1', 'a2', 'c1', 'd1']);
    store.close();
  });
});

describe('a note and a room id in the sqlite store', () => {
  it('applySanction writes one row, ends = starts, with the room; loads nowhere in the index', async () => {
    const { store, subjects, index, db } = env();
    const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'ip1' });
    if (s === null) throw new Error('subject');
    await applySanction(store, subjects, input(s, { kind: 'note', durationMs: null, roomId: 'room-A' }), NOW, index);
    expect(dump(db)).toHaveLength(1);
    expect(dump(db)[0]).toMatchObject({ kind: 'note', starts_at: NOW, ends_at: NOW, rule: '1', target_type: 'subject', room_id: 'room-A' });
    const fresh = new SanctionIndex({ enabled: () => true, subjects });
    await fresh.load(store, NOW - 1);
    for (const kind of SANCTION_KINDS) {
      expect(fresh.active(kind, { clientKey: null, accountId: null, ipHash: 'ip1' }, s, NOW - 1)).toBeNull();
    }
  });

  it('the room is stored on every row of a group and read back by loadSubjectActions and loadSanctions', async () => {
    const { store, subjects, index } = env();
    const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'ip1' });
    if (s === null) throw new Error('subject');
    await applySanction(store, subjects, input(s, { kind: 'ban', includeIp: true, roomId: 'room-B' }), NOW, index);
    await applySanction(store, subjects, input(s), NOW + 1, index);
    expect(store.loadSanctions(NOW).map((r) => [r.targetType, r.roomId])).toEqual([['subject', 'room-B'], ['ip', 'room-B'], ['subject', null]]);
    expect(store.loadSubjectActions(0).map((r) => r.roomId)).toEqual(['room-B', null]);
    expect(store.listGaps()).toEqual([]);
  });

  it('purgeSanctions removes a note 90 d after its start and keeps a newer one', async () => {
    const { store, subjects } = env();
    const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: null });
    if (s === null) throw new Error('subject');
    const old = await applySanction(store, subjects, input(s, { kind: 'note', durationMs: null }), NOW - 91 * DAY);
    const edge = await applySanction(store, subjects, input(s, { kind: 'note', durationMs: null }), NOW - 90 * DAY);
    const fresh = await applySanction(store, subjects, input(s, { kind: 'note', durationMs: null }), NOW - DAY);
    expect(store.purgeSanctions(NOW - 90 * DAY)).toBe(1);
    expect(store.loadSubjectActions(0).map((r) => r.groupId).sort()).toEqual([edge.groupId, fresh.groupId].sort());
    expect(store.loadSubjectActions(0).map((r) => r.groupId)).not.toContain(old.groupId);
  });
});

describe('SqliteStore listGaps and closeGap', () => {
  async function gaps() {
    const t = env();
    const s = t.subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'ip1' });
    if (s === null) throw new Error('subject');
    const a = await applySanction(t.store, t.subjects, input(s, { rule: 'uncovered', gapNote: 'first' }), NOW, t.index);
    const b = await applySanction(
      t.store, t.subjects, input(s, { includeIp: true, rule: 'uncovered', gapNote: GAP }), NOW + 10, t.index,
    );
    await applySanction(t.store, t.subjects, input(s, { rule: 4 }), NOW + 20, t.index);
    await applySanction(t.store, t.subjects, input(s, { source: 'auto_filter', automated: true }), NOW + 30, t.index);
    return { ...t, s, a, b };
  }

  it('lists only subject rows with a note, newest first, mapped to SanctionRow', async () => {
    const { store, a, b } = await gaps();
    const list = store.listGaps();
    expect(list.map((g) => g.groupId)).toEqual([b.groupId, a.groupId]);
    expect(list[0]).toMatchObject({
      kind: 'chat', targetType: 'subject', rule: 'uncovered', gapNote: GAP, gapStatus: 'open', refCode: b.refCode,
      source: 'moderator', automated: false, endsAt: NOW + 10 + H,
    });
    expect(list.every((g) => g.targetType === 'subject')).toBe(true);
  });

  it('lists gaps whatever their status, and revoked ones too', async () => {
    const { store, a, b } = await gaps();
    await revokeSanction(store, a.groupId, 'boss', NOW + 40, 'x');
    store.closeGap(b.groupId, 'not_a_rule', null, 'boss', NOW + 50);
    const list = store.listGaps();
    expect(list.map((g) => [g.groupId, g.gapStatus])).toEqual([
      [b.groupId, 'not_a_rule'],
      [a.groupId, 'open'],
    ]);
  });

  it('closeGap sets the status and the reference once, and reports whether it changed anything', async () => {
    const { store, db, a } = await gaps();
    expect(store.closeGap(a.groupId, 'ruled', '9', 'boss', NOW + 100)).toBe(true);
    expect(dump(db).find((r) => r.group_id === a.groupId && r.target_type === 'subject')).toMatchObject({
      gap_status: 'ruled', gap_ref: '9',
    });
    expect(store.closeGap(a.groupId, 'not_a_rule', null, 'boss', NOW + 101)).toBe(false);
    expect(dump(db).find((r) => r.group_id === a.groupId)).toMatchObject({ gap_status: 'ruled', gap_ref: '9' });
  });

  it('closeGap writes who closed it and when to the audit trail, in the same transaction', async () => {
    const { store, db, a } = await gaps();
    store.closeGap(a.groupId, 'ruled', '9', 'boss', NOW + 100);
    const audit = db.prepare('SELECT * FROM kit_audit').all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ at: NOW + 100, actor: 'boss', action: 'gap.close', subject_type: 'sanction', subject_ref: a.groupId });
    expect(JSON.parse(String(audit[0]?.after_json))).toEqual({ gapStatus: 'ruled', gapRef: '9' });
    // A refused close leaves no audit row, and a rolled-back one leaves none either.
    store.closeGap(a.groupId, 'not_a_rule', null, 'boss', NOW + 101);
    store.closeGap('nope', 'ruled', '1', 'boss', NOW + 102);
    expect(db.prepare('SELECT * FROM kit_audit').all()).toHaveLength(1);
    expect(() =>
      store.transaction(() => {
        store.closeGap(String(dump(db).find((r) => r.gap_status === 'open')?.group_id), 'ruled', '2', 'boss', NOW);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT * FROM kit_audit').all()).toHaveLength(1);
  });

  it('closeGap as not_a_rule stores a null reference and leaves the IP row alone', async () => {
    const { store, db, b } = await gaps();
    expect(store.closeGap(b.groupId, 'not_a_rule', null, 'boss', NOW)).toBe(true);
    expect(dump(db).filter((r) => r.group_id === b.groupId).map((r) => [r.target_type, r.gap_status, r.gap_ref])).toEqual([
      ['subject', 'not_a_rule', null],
      ['ip', null, null],
    ]);
  });

  it('closeGap is false for an unknown group and for a group with no note', async () => {
    const { store, db } = await gaps();
    expect(store.closeGap('nope', 'ruled', '1', 'boss', NOW)).toBe(false);
    const cited = dump(db).find((r) => r.rule === '4');
    expect(store.closeGap(String(cited?.group_id), 'ruled', '1', 'boss', NOW)).toBe(false);
    expect(dump(db).filter((r) => r.gap_status !== null)).toHaveLength(2);
  });

  it('closeGap refuses an invalid status at the database and changes nothing', async () => {
    const { store, db, a } = await gaps();
    expect(() => store.closeGap(a.groupId, 'bogus' as never, null, 'boss', NOW)).toThrow();
    expect(dump(db).filter((r) => r.gap_status === 'open')).toHaveLength(2);
  });

  it('a close inside a rolled-back transaction is undone', async () => {
    const { store, a } = await gaps();
    expect(() =>
      store.transaction(() => {
        store.closeGap(a.groupId, 'ruled', '3', 'boss', NOW);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.listGaps().find((g) => g.groupId === a.groupId)?.gapStatus).toBe('open');
  });

  it('loadSanctions rows carry the gap fields as null for a cited rule', async () => {
    const { store } = await gaps();
    const cited = store.loadSanctions(NOW + 31).find((r) => r.rule === '4');
    expect(cited).toMatchObject({ gapNote: null, gapStatus: null });
  });
});

describe('SqliteStore loadSubjectActions', () => {
  it('returns subject rows at or after since (revoked and ended ones too), with revokedAt, in write order', async () => {
    const { store, subjects, index } = env();
    const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'ip1' });
    if (s === null) throw new Error('subject');
    const old = await applySanction(store, subjects, input(s), NOW - 5 * DAY, index);
    const ended = await applySanction(store, subjects, input(s, { kind: 'ban', includeIp: true }), NOW - 3 * DAY, index);
    const warn = await applySanction(store, subjects, input(s, { kind: 'warning', durationMs: null }), NOW - 2 * DAY, index);
    await applySanction(store, subjects, input(s, { kind: 'ban', durationMs: null }), NOW - DAY, index);
    store.revokeSanctionGroup(ended.groupId, 'mod', NOW, 'oops');

    const got = store.loadSubjectActions(NOW - 3 * DAY);
    expect(got).toHaveLength(3);
    expect(got.every((r) => r.targetType === 'subject')).toBe(true);
    expect(got.map((r) => r.kind)).toEqual(['ban', 'warning', 'ban']);
    expect(got[0]?.revokedAt).toBe(NOW);
    expect(got[1]?.revokedAt ?? null).toBeNull();
    expect(got[1]).toMatchObject({ groupId: warn.groupId, startsAt: NOW - 2 * DAY, endsAt: NOW - 2 * DAY });
    // The boundary is inclusive, and a later since drops older rows.
    expect(store.loadSubjectActions(NOW - 5 * DAY)).toHaveLength(4);
    expect(store.loadSubjectActions(NOW - 5 * DAY + 1).map((r) => r.groupId)).not.toContain(old.groupId);
    expect(store.loadSubjectActions(NOW + 1)).toEqual([]);
  });

  it('loadSanctions rows carry no revokedAt (unchanged shape)', async () => {
    const { store, subjects, index } = env();
    const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'ip1' });
    if (s === null) throw new Error('subject');
    await applySanction(store, subjects, input(s), NOW, index);
    expect(store.loadSanctions(NOW)[0]).not.toHaveProperty('revokedAt');
  });
});

describe('SqliteStore.sanctionGroupTarget', () => {
  it('names the subject row and the rule of a group (also revoked, also with an IP row), null for an unknown one', async () => {
    const { store, subjects, index } = env();
    const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'ip1' });
    if (s === null) throw new Error('subject');
    const withIp = await applySanction(store, subjects, input(s, { includeIp: true, rule: 4 }), NOW, index);
    const gap = await applySanction(store, subjects, input(s, { rule: 'uncovered', gapNote: 'a note', kind: 'warning', durationMs: null }), NOW, index);
    store.revokeSanctionGroup(withIp.groupId, 'mod', NOW, 'oops');
    expect(store.sanctionGroupTarget(withIp.groupId)).toEqual({ subject: s, rule: '4' });
    expect(store.sanctionGroupTarget(gap.groupId)).toEqual({ subject: s, rule: 'uncovered' });
    expect(store.sanctionGroupTarget('no-such-group')).toBeNull();
    expect(store.sanctionGroupTarget('')).toBeNull();
  });
});

describe('SqliteStore.sanctionRefCode', () => {
  it('finds the ref code of a group, revoked or ended, and null for an unknown group', async () => {
    const { store, subjects, index } = env();
    const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'ip1' });
    if (s === null) throw new Error('subject');
    const live = await applySanction(store, subjects, input(s), NOW, index);
    const ended = await applySanction(store, subjects, input(s, { durationMs: 1 }), NOW - DAY, index);
    const revoked = await applySanction(store, subjects, input(s, { kind: 'ban', durationMs: null }), NOW, index);
    store.revokeSanctionGroup(revoked.groupId, 'mod', NOW, 'oops');
    expect(store.sanctionRefCode(live.groupId)).toBe(live.refCode);
    expect(store.sanctionRefCode(ended.groupId)).toBe(ended.refCode);
    expect(store.sanctionRefCode(revoked.groupId)).toBe(revoked.refCode);
    expect(store.sanctionRefCode('no-such-group')).toBeNull();
    expect(store.sanctionRefCode('')).toBeNull();
  });

  it('gives the same code for a group that has an IP row too', async () => {
    const { store, subjects, index } = env();
    const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'ip1' });
    if (s === null) throw new Error('subject');
    const g = await applySanction(store, subjects, input(s, { includeIp: true }), NOW, index);
    expect(store.sanctionRefCode(g.groupId)).toBe(g.refCode);
  });
});
