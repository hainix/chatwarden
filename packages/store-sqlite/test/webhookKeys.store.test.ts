import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openStore } from '../src/index.js';

describe('migration 13', () => {
  it('is version 13 and creates kit_webhook_keys with the documented columns', () => {
    expect(MIGRATIONS[12]?.version).toBe(13);
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    const cols = db.prepare('PRAGMA table_info(kit_webhook_keys)').all();
    expect(cols.map((c) => String(c.name)).sort()).toEqual(['created_at', 'fingerprint', 'key', 'result_json', 'state']);
    expect(Number(cols.find((c) => c.name === 'key')?.pk)).toBe(1);
  });

  it('upgrades a version-12 database and keeps its rows', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: MIGRATIONS.slice(0, 12) }).close();
    db.prepare("INSERT INTO kit_audit (id, at, actor, action, subject_type, subject_ref) VALUES ('o', 1, 'a', 'add', 'term', 't')").run();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
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
    const ins = db.prepare("INSERT INTO kit_webhook_keys (key, created_at, state, result_json, fingerprint) VALUES (?, ?, ?, ?, 'fp')");
    expect(() => ins.run('a', 1, 'bogus', null)).toThrow();
    expect(() => ins.run('b', 1, 'done', null)).toThrow();
    expect(() => ins.run('c', 1, 'pending', '{}')).toThrow();
    expect(() => ins.run('d', 1, 'pending', null)).not.toThrow();
    expect(() => ins.run('e', 1, 'done', '{"ok":true}')).not.toThrow();
    expect(() => db.prepare("INSERT INTO kit_webhook_keys (key, created_at, state, result_json) VALUES ('f', 1, 'pending', NULL)").run()).toThrow();
  });
});
