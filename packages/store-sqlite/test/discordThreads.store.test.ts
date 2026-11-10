import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Store } from '@chatwarden/core';
import { MemoryStore } from '../../core/test/memoryStore.js';
import { MIGRATIONS, openStore } from '../src/index.js';
import { discordThreadsContract } from './discordThreads.contract.js';

const stores: Array<[string, () => Store]> = [
  ['MemoryStore', () => new MemoryStore()],
  ['SqliteStore', () => openStore({ db: new DatabaseSync(':memory:') })],
];

describe('migration 14', () => {
  it('is version 14 and creates kit_discord_threads with the documented columns', () => {
    expect(MIGRATIONS[13]?.version).toBe(14);
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(14);
    const cols = db.prepare('PRAGMA table_info(kit_discord_threads)').all();
    expect(cols.map((c) => String(c.name)).sort()).toEqual(['created_at', 'label', 'subject', 'thread_id']);
    expect(Number(cols.find((c) => c.name === 'subject')?.pk)).toBe(1);
  });

  it('upgrades a version-13 database and keeps its rows', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: MIGRATIONS.slice(0, 13) }).close();
    db.prepare("INSERT INTO kit_audit (id, at, actor, action, subject_type, subject_ref) VALUES ('o', 1, 'a', 'add', 'term', 't')").run();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(db.prepare('SELECT * FROM kit_audit').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM kit_discord_threads').all()).toHaveLength(0);
  });

  it('a failing migration 14 rolls back and leaves version 13', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: MIGRATIONS.slice(0, 13) }).close();
    const broken = [...MIGRATIONS.slice(0, 13), { version: 14, sql: `${MIGRATIONS[13]?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: MIGRATIONS.slice(0, 13) }).schemaVersion()).toBe(13);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'kit_discord_threads'").all()).toHaveLength(0);
  });

  it('the table requires every column', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    expect(() => db.prepare("INSERT INTO kit_discord_threads (subject, thread_id, label) VALUES ('a', 't', 'l')").run()).toThrow();
    expect(() => db.prepare("INSERT INTO kit_discord_threads (subject, thread_id, label, created_at) VALUES ('a', 't', 'l', 1)").run()).not.toThrow();
  });
});

for (const [name, make] of stores) discordThreadsContract(name, make);
