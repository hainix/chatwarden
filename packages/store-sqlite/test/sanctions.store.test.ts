import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applySanction,
  revokeSanction,
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
    expect(() => store.insertSanctionGroup([row({ kind: 'warning' as never })])).toThrow();
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
    const keep = await applySanction(store, subjects, input(s1, { includeIp: true, rule: '2.4' }), NOW, index);
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
      until: NOW + H, automated: false, groupId: keep.groupId, refCode: keep.refCode,
    });
    expect(fresh.active('chat', { clientKey: null, accountId: null, ipHash: 'ip1' }, null, NOW + 2)).not.toBeNull();
    expect(fresh.active('ban', none, s1, NOW + 2)).toBeNull();
    const kept = store.loadSanctions(NOW + 2);
    expect(kept.every((r) => r.rule === '2.4')).toBe(true);
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
