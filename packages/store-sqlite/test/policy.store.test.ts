import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden, PolicyLayer } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const memDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return db;
};
const filePath = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-policy-'));
  dirs.push(d);
  return join(d, 'kit.db');
};

describe('migration 16: the policy layer and the audit detail', () => {
  it('is the latest migration, version 16, and creates the layer table and the detail column', () => {
    expect(MIGRATIONS.at(-1)?.version).toBe(16);
    const db = memDb();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(16);
    const cols = db.prepare('PRAGMA table_info(kit_policy_layer)').all().map((c) => String(c.name));
    expect(cols).toEqual(['id', 'layer_json', 'version']);
    const audit = db.prepare('PRAGMA table_info(kit_audit)').all();
    const detail = audit.find((c) => c.name === 'detail_json');
    expect(detail).toBeDefined();
    expect(Number(detail?.notnull)).toBe(0);
  });

  it('upgrades an existing version 15 database cleanly: old rows, claims and reasons are untouched, and policy works after', () => {
    const db = memDb();
    const old = openStore({ db, migrations: MIGRATIONS.slice(0, 15) });
    expect(old.schemaVersion()).toBe(15);
    // Written the way the 0.1.1 kit wrote it (no detail column yet), not through this version's insertAudit.
    db.prepare(
      `INSERT INTO kit_audit (id, at, actor, role, action, subject_type, subject_ref, before_json, after_json)
       VALUES ('old1', ?, 'ann', 'senior', 'report.view', 'report', 'r1', NULL, NULL)`,
    ).run(NOW);
    old.insertReason({ id: 'rs1', label: 'Spam', text: 'Spamming the lobby.', active: true });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'kit_policy_layer'").all()).toHaveLength(0);

    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(16);
    expect(store.listAudit({ limit: 5 })).toEqual([
      { id: 'old1', at: NOW, actor: 'ann', role: 'senior', action: 'report.view', target: { type: 'report', ref: 'r1' } },
    ]);
    expect(store.listReasons()).toEqual([{ id: 'rs1', label: 'Spam', text: 'Spamming the lobby.', active: true }]);
    expect(store.loadPolicyLayer()).toBeNull();
    expect(store.savePolicyLayer({ durations: [HOUR] }, 0)).toBe(1);
    store.insertAudit({ id: 'new1', at: NOW + 1, actor: 'ann', role: 'owner', action: 'policy.update', target: null, detail: { sections: ['durations'], reason: 'six hours' } });
    expect(store.listAudit({ limit: 1 })[0]?.detail).toEqual({ sections: ['durations'], reason: 'six hours' });
  });

  it('upgrading twice (a second open) changes nothing and keeps the saved layer', () => {
    const path = filePath();
    const a = openStore({ path });
    a.savePolicyLayer({ customDuration: false }, 0);
    a.close();
    const b = openStore({ path });
    expect(b.schemaVersion()).toBe(16);
    expect(b.loadPolicyLayer()).toEqual({ layer: { customDuration: false }, version: 1 });
    b.close();
  });

  it('a failing migration 16 rolls back whole: version 15, no table, no column', () => {
    const db = memDb();
    openStore({ db, migrations: MIGRATIONS.slice(0, 15) }).close();
    const broken = [...MIGRATIONS.slice(0, 15), { version: 16, sql: `${MIGRATIONS[15]?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: MIGRATIONS.slice(0, 15) }).schemaVersion()).toBe(15);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'kit_policy_layer'").all()).toHaveLength(0);
    expect(db.prepare('PRAGMA table_info(kit_audit)').all().some((c) => c.name === 'detail_json')).toBe(false);
  });

  it('the layer table holds one row only', () => {
    const db = memDb();
    openStore({ db });
    db.prepare("INSERT INTO kit_policy_layer (id, layer_json, version) VALUES (1, '{}', 1)").run();
    expect(() => db.prepare("INSERT INTO kit_policy_layer (id, layer_json, version) VALUES (2, '{}', 1)").run()).toThrow();
  });
});

describe('savePolicyLayer on SQLite', () => {
  it('is one conditional statement: two connections to one file with the same expected version, one wins', () => {
    const path = filePath();
    const a = openStore({ path });
    const b = openStore({ path });
    expect(a.savePolicyLayer({ durations: [HOUR] }, 0)).toBe(1);
    expect(b.savePolicyLayer({ durations: [2 * HOUR] }, 0)).toBeNull();
    expect(b.loadPolicyLayer()).toEqual({ layer: { durations: [HOUR] }, version: 1 });
    expect(b.savePolicyLayer({ durations: [2 * HOUR] }, 1)).toBe(2);
    expect(a.savePolicyLayer({ durations: [3 * HOUR] }, 1)).toBeNull();
    expect(a.loadPolicyLayer()).toEqual({ layer: { durations: [2 * HOUR] }, version: 2 });
    a.close();
    b.close();
  });

  it('a stale save never overwrites: the row is untouched (no write at all)', () => {
    const db = memDb();
    const store = openStore({ db });
    store.savePolicyLayer({ durations: [HOUR] }, 0);
    const before = db.prepare('SELECT layer_json, version FROM kit_policy_layer').get();
    expect(store.savePolicyLayer({ durations: [9 * HOUR] }, 5)).toBeNull();
    expect(db.prepare('SELECT layer_json, version FROM kit_policy_layer').get()).toEqual(before);
  });

  it('waits for another connection’s lock instead of failing at once (the busy timeout is in force)', () => {
    const path = filePath();
    const store = openStore({ path });
    const timeout = Number((store as unknown as { db: DatabaseSync }).db.prepare('PRAGMA busy_timeout').get()?.timeout);
    expect(timeout).toBeGreaterThanOrEqual(5000);
    store.close();
  });

  it('is atomic inside the caller’s transaction and is rolled back with it', () => {
    const store = openStore({ db: memDb() });
    store.savePolicyLayer({ durations: [HOUR] }, 0);
    expect(() =>
      store.transaction(() => {
        store.savePolicyLayer({ durations: [2 * HOUR] }, 1);
        throw new Error('no');
      }),
    ).toThrow('no');
    expect(store.loadPolicyLayer()).toEqual({ layer: { durations: [HOUR] }, version: 1 });
  });

  it('a row holding text that is not JSON reads as an error, never as a silent empty layer', () => {
    const db = memDb();
    const store = openStore({ db });
    db.prepare("INSERT INTO kit_policy_layer (id, layer_json, version) VALUES (1, 'not json', 1)").run();
    expect(() => store.loadPolicyLayer()).toThrow();
  });
});

describe('two kits on one SQLite file (the cross-process refresh)', () => {
  const build = async (path: string, clock: { t: number; now(): number }): Promise<Chatwarden> =>
    createChatwarden({
      store: openStore({ path }),
      secret: 'two-kits',
      platform: { identify: (ctx) => ctx as never },
      clock,
      logger: { warn: () => undefined },
      retention: false,
    });

  it('a save in one is seen by the other after 10 seconds', async () => {
    const path = filePath();
    const clock = { t: NOW, now: () => clock.t };
    const a = await build(path, clock);
    const b = await build(path, clock);
    const layer: PolicyLayer = { durations: [HOUR, 6 * HOUR], customDuration: false };
    expect(a.policy.save(layer, { version: 0, actor: 'owner_ann', reason: 'tune' })).toMatchObject({ ok: true, version: 1 });
    expect(b.profile.durations).not.toEqual([HOUR, 6 * HOUR]);
    clock.t += 10_000;
    expect(b.profile.durations).toEqual([HOUR, 6 * HOUR]);
    expect(b.profile.customDuration).toBe(false);
    expect(b.policy.save({ durations: [HOUR] }, { version: 0, actor: 'owner_bob', reason: 'late' })).toEqual({ ok: false, error: 'conflict' });
    await a.close();
    await b.close();
  });
});
