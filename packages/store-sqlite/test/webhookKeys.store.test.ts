import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { purge, WEBHOOK_KEY_TTL_MS, type Store } from '@chatwarden/core';
import { MemoryStore } from '../../core/test/memoryStore.js';
import { MIGRATIONS, openStore } from '../src/index.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const FLOOR = NOW - WEBHOOK_KEY_TTL_MS;

const stores: Array<[string, () => Store]> = [
  ['MemoryStore', () => new MemoryStore()],
  ['SqliteStore', () => openStore({ db: new DatabaseSync(':memory:') })],
];

describe('migration 13', () => {
  it('is version 13 and creates kit_webhook_keys with the documented columns', () => {
    expect(MIGRATIONS[12]?.version).toBe(13);
    expect(MIGRATIONS.at(-1)?.version).toBe(13);
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(13);
    const cols = db.prepare('PRAGMA table_info(kit_webhook_keys)').all();
    expect(cols.map((c) => String(c.name)).sort()).toEqual(['created_at', 'key', 'result_json', 'state']);
    expect(Number(cols.find((c) => c.name === 'key')?.pk)).toBe(1);
  });

  it('upgrades a version-12 database and keeps its rows', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: MIGRATIONS.slice(0, 12) }).close();
    db.prepare("INSERT INTO kit_audit (id, at, actor, action, subject_type, subject_ref) VALUES ('o', 1, 'a', 'add', 'term', 't')").run();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(13);
    expect(db.prepare('SELECT * FROM kit_audit').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM kit_webhook_keys').all()).toHaveLength(0);
  });

  it('a failing migration 13 rolls back and leaves version 12', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: MIGRATIONS.slice(0, 12) }).close();
    const broken = [...MIGRATIONS.slice(0, 12), { version: 13, sql: `${MIGRATIONS[12]?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: MIGRATIONS.slice(0, 12) }).schemaVersion()).toBe(12);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'kit_webhook_keys'").all()).toHaveLength(0);
  });

  it('the table refuses a state outside pending/done and a row whose result does not match its state', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const ins = db.prepare('INSERT INTO kit_webhook_keys (key, created_at, state, result_json) VALUES (?, ?, ?, ?)');
    expect(() => ins.run('a', 1, 'bogus', null)).toThrow();
    expect(() => ins.run('b', 1, 'done', null)).toThrow();
    expect(() => ins.run('c', 1, 'pending', '{}')).toThrow();
    expect(() => ins.run('d', 1, 'pending', null)).not.toThrow();
    expect(() => ins.run('e', 1, 'done', '{"ok":true}')).not.toThrow();
  });
});

describe.each(stores)('webhook keys: %s', (_name, make) => {
  it('the TTL is 24 hours', () => {
    expect(WEBHOOK_KEY_TTL_MS).toBe(DAY);
  });

  it('reserve inserts a pending row the first time', () => {
    const s = make();
    expect(s.reserveWebhookKey('k1', NOW, FLOOR)).toEqual({ reserved: true });
  });

  it('a second reserve returns the existing pending row and does not reserve', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR);
    expect(s.reserveWebhookKey('k1', NOW + 1, FLOOR)).toEqual({ reserved: false, state: 'pending', resultJson: null });
  });

  it('complete stores the result; reserve then returns it as done', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR);
    expect(s.completeWebhookKey('k1', '{"groupId":"g"}')).toBe(true);
    expect(s.reserveWebhookKey('k1', NOW + 5, FLOOR)).toEqual({ reserved: false, state: 'done', resultJson: '{"groupId":"g"}' });
  });

  it('complete is false for an unknown key and for a key already done (the first result stands)', () => {
    const s = make();
    expect(s.completeWebhookKey('nope', '{}')).toBe(false);
    s.reserveWebhookKey('k1', NOW, FLOOR);
    expect(s.completeWebhookKey('k1', '{"a":1}')).toBe(true);
    expect(s.completeWebhookKey('k1', '{"a":2}')).toBe(false);
    expect(s.reserveWebhookKey('k1', NOW, FLOOR)).toEqual({ reserved: false, state: 'done', resultJson: '{"a":1}' });
  });

  it('release deletes a pending reservation so the key can be reserved again', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR);
    expect(s.releaseWebhookKey('k1')).toBe(true);
    expect(s.releaseWebhookKey('k1')).toBe(false);
    expect(s.reserveWebhookKey('k1', NOW + 1, FLOOR)).toEqual({ reserved: true });
  });

  it('release never deletes a done row', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR);
    s.completeWebhookKey('k1', '{"a":1}');
    expect(s.releaseWebhookKey('k1')).toBe(false);
    expect(s.reserveWebhookKey('k1', NOW, FLOOR)).toMatchObject({ reserved: false, state: 'done' });
  });

  it('keys are independent', () => {
    const s = make();
    expect(s.reserveWebhookKey('a', NOW, FLOOR)).toEqual({ reserved: true });
    expect(s.reserveWebhookKey('b', NOW, FLOOR)).toEqual({ reserved: true });
    s.completeWebhookKey('a', '{"x":1}');
    expect(s.reserveWebhookKey('b', NOW, FLOOR)).toMatchObject({ state: 'pending' });
  });

  it('keys are case sensitive and exact', () => {
    const s = make();
    expect(s.reserveWebhookKey('Key', NOW, FLOOR)).toEqual({ reserved: true });
    expect(s.reserveWebhookKey('key', NOW, FLOOR)).toEqual({ reserved: true });
    expect(s.reserveWebhookKey('key ', NOW, FLOOR)).toEqual({ reserved: true });
  });

  it('a row older than the floor is replaced by a fresh pending reservation (the key is free again)', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW - DAY - 1, NOW - 2 * DAY);
    s.completeWebhookKey('k1', '{"old":true}');
    expect(s.reserveWebhookKey('k1', NOW, FLOOR)).toEqual({ reserved: true });
    expect(s.reserveWebhookKey('k1', NOW, FLOOR)).toEqual({ reserved: false, state: 'pending', resultJson: null });
  });

  it('a row exactly on the floor is still the first one', () => {
    const s = make();
    s.reserveWebhookKey('k1', FLOOR, FLOOR - 1);
    expect(s.reserveWebhookKey('k1', NOW, FLOOR)).toMatchObject({ reserved: false, state: 'pending' });
  });

  it('purgeWebhookKeys deletes strictly older rows, done or pending, and returns the count', () => {
    const s = make();
    s.reserveWebhookKey('old-done', NOW - DAY - 1, 0);
    s.completeWebhookKey('old-done', '{}');
    s.reserveWebhookKey('old-pending', NOW - 3 * DAY, 0);
    s.reserveWebhookKey('edge', FLOOR, 0);
    s.reserveWebhookKey('new', NOW, 0);
    expect(s.purgeWebhookKeys(FLOOR)).toBe(2);
    expect(s.reserveWebhookKey('edge', NOW, 0)).toMatchObject({ reserved: false });
    expect(s.reserveWebhookKey('new', NOW, 0)).toMatchObject({ reserved: false });
    expect(s.reserveWebhookKey('old-done', NOW, 0)).toEqual({ reserved: true });
    expect(s.purgeWebhookKeys(FLOOR)).toBe(0);
  });

  it('the shared purge removes keys past 24 h and reports them', async () => {
    const s = make();
    s.reserveWebhookKey('old', NOW - DAY - 1, 0);
    s.reserveWebhookKey('edge', NOW - DAY, 0);
    const res = await purge(s, NOW);
    expect(res.webhookKeys).toBe(1);
    expect(s.reserveWebhookKey('edge', NOW, 0)).toMatchObject({ reserved: false });
    expect(s.reserveWebhookKey('old', NOW, 0)).toEqual({ reserved: true });
  });

  it('writes inside a transaction roll back with it', () => {
    const s = make();
    expect(() =>
      s.transaction(() => {
        s.reserveWebhookKey('k1', NOW, FLOOR);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.reserveWebhookKey('k1', NOW, FLOOR)).toEqual({ reserved: true });
  });
});
