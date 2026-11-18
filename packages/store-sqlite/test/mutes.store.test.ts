import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_MUTES_PER_VIEWER, MuteService, SubjectIndex, type Identifiers, type Logger, type MuteRow } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const who = (clientKey: string | null, accountId: string | null = null): Identifiers => ({
  clientKey,
  accountId,
  ipHash: null,
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-mute-'));
  tmpDirs.push(dir);
  return join(dir, 'kit.db');
}

const mute = (viewer: string, target: string, createdAt = NOW, block = false): MuteRow => ({ viewer, target, createdAt, block });

function env() {
  const db = new DatabaseSync(':memory:');
  const store = openStore({ db });
  return { db, store };
}

const dump = (db: DatabaseSync) =>
  db
    .prepare('SELECT viewer_id, target_id, created_at FROM kit_mutes ORDER BY rowid')
    .all()
    .map((r) => [r.viewer_id, r.target_id, r.created_at]);

describe('migration 4: kit_mutes', () => {
  it('is version 4 and creates the table with the documented columns', () => {
    expect(MIGRATIONS[3]?.version).toBe(4);
    const { db, store } = env();
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(4);
    const cols = db.prepare('PRAGMA table_info(kit_mutes)').all().map((c) => String(c.name));
    // The release adds the block flag in migration 26 (any-server block 2): this test is about the first three, in order.
    expect(cols.slice(0, 3)).toEqual(['viewer_id', 'target_id', 'created_at']);
    db.close();
  });

  it('upgrades a version 3 database in place and keeps its subjects', async () => {
    const path = tmpPath();
    const v3 = openStore({ path, migrations: MIGRATIONS.slice(0, 3) });
    await v3.saveSubject({ id: 's_a', createdAt: 5, mergedInto: null });
    expect(v3.schemaVersion()).toBe(3);
    v3.close();
    const v4 = openStore({ path });
    expect(v4.schemaVersion()).toBeGreaterThanOrEqual(4);
    expect((await v4.loadSubjects()).subjects).toHaveLength(1);
    expect(v4.loadMutes(0)).toEqual([]);
    v4.close();
  });

  it('only touches kit_ tables', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    openStore({ db });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    expect(names.filter((n) => !n.startsWith('kit_') && !n.startsWith('sqlite_'))).toEqual(['users']);
    db.close();
  });

  it('holds no identifier other than the two subject ids (no ip, key or account column)', () => {
    const { db } = env();
    const cols = db.prepare('PRAGMA table_info(kit_mutes)').all().map((c) => String(c.name));
    expect(cols.join(' ')).not.toMatch(/ip|key|account/);
    db.close();
  });
});

describe('SqliteStore mute methods', () => {
  it('upsertMute inserts, and a repeat refreshes created_at without a second row', () => {
    const { db, store } = env();
    store.upsertMute(mute('s_v', 's_t', 10));
    store.upsertMute(mute('s_v', 's_t', 99));
    expect(dump(db)).toEqual([['s_v', 's_t', 99]]);
    db.close();
  });

  it('different pairs are different rows; direction matters', () => {
    const { db, store } = env();
    store.upsertMute(mute('s_a', 's_b'));
    store.upsertMute(mute('s_b', 's_a'));
    store.upsertMute(mute('s_a', 's_c'));
    expect(dump(db)).toHaveLength(3);
    db.close();
  });

  it('deleteMute removes exactly one pair and reports whether it did', () => {
    const { db, store } = env();
    store.upsertMute(mute('s_a', 's_b'));
    store.upsertMute(mute('s_a', 's_c'));
    expect(store.deleteMute('s_a', 's_b')).toBe(true);
    expect(store.deleteMute('s_a', 's_b')).toBe(false);
    expect(store.deleteMute('s_x', 's_c')).toBe(false);
    expect(dump(db)).toEqual([['s_a', 's_c', NOW]]);
    db.close();
  });

  it('loadMutes returns rows created at or after the cutoff, in write order, with every column', () => {
    const { store } = env();
    store.upsertMute(mute('s_a', 's_old', 100));
    store.upsertMute(mute('s_a', 's_edge', 200));
    store.upsertMute(mute('s_b', 's_new', 300));
    expect(store.loadMutes(200)).toEqual([mute('s_a', 's_edge', 200), mute('s_b', 's_new', 300)]);
    expect(store.loadMutes(301)).toEqual([]);
    expect(store.loadMutes(0)).toHaveLength(3);
  });

  it('pruneMutes drops the oldest beyond keep and returns their targets, oldest first', () => {
    const { db, store } = env();
    store.upsertMute(mute('s_a', 't3', 3));
    store.upsertMute(mute('s_a', 't1', 1));
    store.upsertMute(mute('s_a', 't2', 2));
    store.upsertMute(mute('s_a', 't4', 4));
    expect(store.pruneMutes('s_a', 2)).toEqual(['t1', 't2']);
    expect(dump(db).map((r) => r[1])).toEqual(['t3', 't4']);
    db.close();
  });

  it('pruneMutes does nothing at or under the cap, and keep 0 clears the viewer', () => {
    const { db, store } = env();
    store.upsertMute(mute('s_a', 't1', 1));
    store.upsertMute(mute('s_a', 't2', 2));
    expect(store.pruneMutes('s_a', 2)).toEqual([]);
    expect(store.pruneMutes('s_a', 5)).toEqual([]);
    expect(store.pruneMutes('s_none', 1)).toEqual([]);
    expect(dump(db)).toHaveLength(2);
    expect(store.pruneMutes('s_a', 0)).toEqual(['t1', 't2']);
    expect(dump(db)).toEqual([]);
    db.close();
  });

  it('pruneMutes breaks created_at ties by write order: the newest write survives', () => {
    const { store } = env();
    store.upsertMute(mute('s_a', 't1', 5));
    store.upsertMute(mute('s_a', 't2', 5));
    store.upsertMute(mute('s_a', 't3', 5));
    expect(store.pruneMutes('s_a', 1)).toEqual(['t1', 't2']);
    expect(store.loadMutes(0).map((r) => r.target)).toEqual(['t3']);
  });

  it('pruneMutes is per viewer', () => {
    const { store } = env();
    store.upsertMute(mute('s_a', 't1', 1));
    store.upsertMute(mute('s_a', 't2', 2));
    store.upsertMute(mute('s_b', 't1', 0));
    expect(store.pruneMutes('s_a', 1)).toEqual(['t1']);
    expect(store.loadMutes(0).filter((r) => r.viewer === 's_b')).toHaveLength(1);
  });

  it('writes roll back with the surrounding transaction', () => {
    const { db, store } = env();
    store.upsertMute(mute('s_a', 't1', 1));
    expect(() =>
      store.transaction(() => {
        store.upsertMute(mute('s_a', 't2', 2));
        store.upsertMute(mute('s_a', 't1', 50));
        store.deleteMute('s_a', 't1');
        store.pruneMutes('s_a', 0);
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(dump(db)).toEqual([['s_a', 't1', 1]]);
    db.close();
  });

  it('survives a close and reopen', () => {
    const path = tmpPath();
    const a = openStore({ path });
    a.upsertMute(mute('s_a', 's_b', 7));
    a.close();
    const b = openStore({ path });
    expect(b.loadMutes(0)).toEqual([mute('s_a', 's_b', 7)]);
    b.close();
  });
});

describe('MuteService over the SQLite store', () => {
  function service(db = new DatabaseSync(':memory:'), logger: Logger = { warn() {} }) {
    const store = openStore({ db });
    const clock = { t: NOW, now: () => clock.t };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const mutes = new MuteService(store, clock, subjects, { logger });
    const person = (ids: Identifiers): string => {
      clock.t += 1;
      const s = subjects.resolve(ids);
      if (s === null) throw new Error('expected a subject');
      return s;
    };
    return { db, store, clock, subjects, mutes, person };
  }

  it('writes through, and a new service over the same file sees the mutes after load()', async () => {
    const path = tmpPath();
    const first = service(new DatabaseSync(path));
    const v = first.person(who('vk'));
    const t = first.person(who('tk'));
    first.mutes.set(v, t, true);
    await first.subjects.flush();
    first.db.close();

    const second = service(new DatabaseSync(path));
    await second.subjects.load();
    await second.mutes.load();
    expect(second.mutes.isMuted(v, t)).toBe(true);
    expect(second.mutes.isMuted(t, v)).toBe(false);
    second.db.close();
  });

  it('unmute is durable', async () => {
    const path = tmpPath();
    const first = service(new DatabaseSync(path));
    const v = first.person(who('vk'));
    const t = first.person(who('tk'));
    first.mutes.set(v, t, true);
    first.mutes.set(v, t, false);
    first.db.close();
    const second = service(new DatabaseSync(path));
    await second.mutes.load();
    expect(second.mutes.isMuted(v, t)).toBe(false);
    second.db.close();
  });

  it('cap drops oldest in the real table: the 501st mute leaves 500 rows without the first', () => {
    const { db, mutes, clock, person } = service();
    const v = person(who('vk'));
    const ts = Array.from({ length: MAX_MUTES_PER_VIEWER + 1 }, (_, i) => person(who(`t${i}`)));
    for (const t of ts) {
      clock.t += 1;
      mutes.set(v, t, true);
    }
    const n = (db.prepare('SELECT COUNT(*) AS n FROM kit_mutes').get() as { n: number }).n;
    expect(n).toBe(500);
    expect(mutes.isMuted(v, ts[0] as string)).toBe(false);
    expect(mutes.isMuted(v, ts[1] as string)).toBe(true);
    expect(mutes.isMuted(v, ts[500] as string)).toBe(true);
    db.close();
  });

  it('cap with every mute in the same millisecond keeps the newest', () => {
    const { db, mutes, person } = service();
    const v = person(who('vk'));
    const ts = Array.from({ length: MAX_MUTES_PER_VIEWER + 1 }, (_, i) => person(who(`t${i}`)));
    for (const t of ts) mutes.set(v, t, true); // clock frozen: one created_at for all
    expect(mutes.isMuted(v, ts[500] as string)).toBe(true);
    expect(mutes.isMuted(v, ts[0] as string)).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS n FROM kit_mutes').get() as { n: number }).n).toBe(500);
    db.close();
  });

  it('a mute survives a merge of the target, in the real table', async () => {
    const path = tmpPath();
    const a = service(new DatabaseSync(path));
    const v = a.person(who('vk'));
    const t1 = a.person(who('t-key'));
    a.person(who(null, 't-acct'));
    a.mutes.set(v, t1, true);
    const merged = a.person(who('t-key', 't-acct'));
    await a.subjects.flush();
    a.db.close();

    const b = service(new DatabaseSync(path));
    await b.subjects.load();
    await b.mutes.load();
    expect(b.mutes.isMuted(v, merged)).toBe(true);
    b.mutes.set(v, merged, false);
    expect((b.db.prepare('SELECT COUNT(*) AS n FROM kit_mutes').get() as { n: number }).n).toBe(0);
    b.db.close();
  });

  it('a failing table (dropped) is logged and does not throw', () => {
    const warnings: string[] = [];
    const { db, mutes, person } = service(new DatabaseSync(':memory:'), { warn: (e) => warnings.push(e) });
    const v = person(who('vk'));
    const t = person(who('tk'));
    db.exec('DROP TABLE kit_mutes');
    expect(() => mutes.set(v, t, true)).not.toThrow();
    expect(mutes.isMuted(v, t)).toBe(false);
    expect(warnings).toEqual(['mutes.write_failed']);
    db.close();
  });

  it('an expired row stays in the table but is neither loaded nor applied', async () => {
    const path = tmpPath();
    const a = service(new DatabaseSync(path));
    const v = a.person(who('vk'));
    const t = a.person(who('tk'));
    a.mutes.set(v, t, true);
    a.clock.t += 181 * DAY;
    expect(a.mutes.isMuted(v, t)).toBe(false);
    a.db.close();
    const b = service(new DatabaseSync(path));
    b.clock.t = a.clock.t;
    await b.mutes.load();
    expect(b.mutes.isMuted(v, t)).toBe(false);
    b.db.close();
  });
});

describe('migration 26, the block flag (any-server block 2)', () => {
  const UP_TO_25 = MIGRATIONS.slice(0, 25);
  const colsOf = (db: DatabaseSync): string[] => db.prepare('PRAGMA table_info(kit_mutes)').all().map((c) => String(c.name));

  it('a 25 database upgrades: kit_mutes.block defaults 0 for old rows, and the rows keep their ids and times', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: UP_TO_25 });
    expect(colsOf(db)).not.toContain('block');
    db.prepare('INSERT INTO kit_mutes (viewer_id, target_id, created_at) VALUES (?, ?, ?)').run('s_v', 's_t', 123);
    db.prepare('INSERT INTO kit_mutes (viewer_id, target_id, created_at) VALUES (?, ?, ?)').run('s_v', 's_u', 456);
    const store = openStore({ db });
    expect(colsOf(db)).toContain('block');
    expect(db.prepare('SELECT viewer_id, target_id, created_at, block FROM kit_mutes ORDER BY created_at').all().map((r) => ({ ...r }))).toEqual([
      { viewer_id: 's_v', target_id: 's_t', created_at: 123, block: 0 },
      { viewer_id: 's_v', target_id: 's_u', created_at: 456, block: 0 },
    ]);
    expect(store.loadMutes(0)).toEqual([mute('s_v', 's_t', 123, false), mute('s_v', 's_u', 456, false)]);
    db.close();
  });

  it('the column is NOT NULL DEFAULT 0 and refuses anything but 0 and 1', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const info = db.prepare('PRAGMA table_info(kit_mutes)').all().find((c) => c.name === 'block');
    expect(Number(info?.notnull)).toBe(1);
    expect(String(info?.dflt_value)).toBe('0');
    const ins = db.prepare('INSERT INTO kit_mutes (viewer_id, target_id, created_at, block) VALUES (?, ?, 1, ?)');
    ins.run('a', 'b', 1);
    ins.run('a', 'c', 0);
    expect(() => ins.run('a', 'd', 2)).toThrow();
    expect(() => ins.run('a', 'e', -1)).toThrow();
    db.close();
  });

  it('a block row survives purgeMutes at any age while a mute older than 180 days goes', () => {
    const { db, store } = env();
    store.upsertMute(mute('s_v', 's_b', NOW - 900 * DAY, true));
    store.upsertMute(mute('s_v', 's_m', NOW - 900 * DAY, false));
    expect(store.purgeMutes(NOW - 180 * DAY)).toBe(1);
    expect(store.loadMutes(0)).toEqual([mute('s_v', 's_b', NOW - 900 * DAY, true)]);
    db.close();
  });

  it('a block over a mute keeps one row; a mute over a block keeps the block', () => {
    const { db, store } = env();
    store.upsertMute(mute('s_v', 's_t', 1, false));
    store.upsertMute(mute('s_v', 's_t', 2, true));
    store.upsertMute(mute('s_v', 's_t', 3, false));
    expect(db.prepare('SELECT created_at, block FROM kit_mutes').all().map((r) => ({ ...r }))).toEqual([{ created_at: 3, block: 1 }]);
    db.close();
  });

  it('the cap drops the oldest MUTE in the real table and never a block; with 500 blocks the service refuses a new one', () => {
    const { db, store } = env();
    const clock = { t: NOW, now: () => NOW };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const mutes = new MuteService(store, clock, subjects, { logger: { warn() {} } });
    const v = subjects.resolve(who('vk')) as string;
    const targets: string[] = [];
    for (let i = 0; i < MAX_MUTES_PER_VIEWER; i += 1) {
      const t = subjects.resolve(who(`tk-${i}`)) as string;
      targets.push(t);
      mutes.set(v, t, true, i === 0 ? 'block' : 'mute');
    }
    const extra = subjects.resolve(who('extra')) as string;
    expect(mutes.set(v, extra, true)).toBe('ok');
    const rows = store.loadMutes(0).filter((r) => r.viewer === v);
    expect(rows).toHaveLength(MAX_MUTES_PER_VIEWER);
    expect(rows.find((r) => r.target === targets[0])?.block).toBe(true);
    expect(rows.some((r) => r.target === targets[1])).toBe(false);
    db.close();
    const full = env();
    const sub2 = new SubjectIndex(full.store, clock, { logger: { warn() {} } });
    const svc = new MuteService(full.store, clock, sub2, { logger: { warn() {} } });
    const v2 = sub2.resolve(who('v2')) as string;
    for (let i = 0; i < MAX_MUTES_PER_VIEWER; i += 1) svc.set(v2, sub2.resolve(who(`b-${i}`)) as string, true, 'block');
    expect(svc.set(v2, sub2.resolve(who('one-more')) as string, true, 'block')).toBe('limit');
    expect(full.store.loadMutes(0).filter((r) => r.viewer === v2)).toHaveLength(MAX_MUTES_PER_VIEWER);
    full.db.close();
  });

  it('a rerun of the block is refused: its statement fails on a database that already has the column', () => {
    const { db } = env();
    const sql = MIGRATIONS.find((m) => m.version === 26)?.sql ?? '';
    expect(sql).toMatch(/ALTER TABLE kit_mutes ADD COLUMN block/);
    expect(() => db.exec(sql)).toThrow();
    expect(() => openStore({ db })).not.toThrow();
    db.close();
  });

  it('a database migrated from 25 has the same kit_mutes schema as a fresh one', () => {
    const a = new DatabaseSync(':memory:');
    openStore({ db: a });
    const b = new DatabaseSync(':memory:');
    openStore({ db: b, migrations: UP_TO_25 });
    openStore({ db: b });
    expect(colsOf(b)).toEqual(colsOf(a));
    a.close();
    b.close();
  });

  it('the export counts a block a person placed with their mutes and never one placed on them (SQL statement, bound values)', async () => {
    const { db, store } = env();
    for (const id of ['s_me', 's_a']) await store.saveSubject({ id, createdAt: NOW, mergedInto: null });
    store.upsertMute(mute('s_me', 's_a', NOW, true));
    store.upsertMute(mute('s_a', 's_me', NOW, true));
    expect(store.exportSubjects(['s_me']).mutes).toEqual({ placed: 1, received: 0 });
    db.close();
  });
});
