import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { RawWho } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';
import { insertOldReport } from './oldRows.js';
import type { SqliteStore } from '../src/index.js';

// The SQLite side of the team workbench: the tables, an upgrade from the previous schema, the token persisting, and two
// connections (standing in for two server processes) racing on one file.

const MIN = 60_000;
const TTL = 10 * MIN;
const NOW = 1_800_000_000_000;

const tmpDirs: string[] = [];
const open: SqliteStore[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmpPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-team-'));
  tmpDirs.push(dir);
  return join(dir, 'kit.db');
};
const openAt = (path: string): SqliteStore => {
  const s = openStore({ path });
  open.push(s);
  return s;
};

describe('migration 15', () => {
  it('is migration 15 (a later one may follow), adds kit_claims and kit_reasons, and nothing named in the token', () => {
    expect(MIGRATIONS[14]?.version).toBe(15);
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kit_%' ORDER BY name").all().map((r) => String(r.name));
    expect(tables).toContain('kit_claims');
    expect(tables).toContain('kit_reasons');
    expect(db.prepare("SELECT value FROM kit_meta WHERE key='schema_version'").get()?.value).toBe(String(MIGRATIONS.at(-1)?.version));
    // The token has no row until the first change: it reads as 0.
    expect(db.prepare("SELECT 1 AS one FROM kit_meta WHERE key='change_token'").get()).toBeUndefined();
  });

  it('upgrades a database left at version 14 and keeps its rows', () => {
    const path = tmpPath();
    const rawDb = new DatabaseSync(path);
    const old = openStore({ db: rawDb, migrations: MIGRATIONS.slice(0, 14) });
    expect(old.schemaVersion()).toBe(14);
    insertOldReport(rawDb, {
      id: 'old-report', createdAt: NOW, roomId: 'R', tags: {}, reporterSubject: 's_a', reporterSeat: 'p1', reporterHandle: 'A',
      targetSubject: 's_b', targetSeat: 'p2', targetHandle: 'B', category: 'spam', note: null, lineId: null, excerpt: [], people: [], status: 'open',
    });
    old.close();
    rawDb.close();

    const s = openAt(path);
    expect(s.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(s.loadReport('old-report')).toMatchObject({ id: 'old-report', status: 'open' });
    expect(s.listOpenReports({ limit: 5 }).map((r) => r.id)).toEqual(['old-report']);
    expect(s.listReasons()).toEqual([]);
    expect(s.loadClaims(['s_b'], NOW)).toEqual([]);
    expect(s.claimCase('s_b', 'ann', NOW, NOW + TTL, 'claim').won).toBe(true);
  });
});

describe('the change token persists', () => {
  it('survives closing and reopening the file, and keeps counting from there', () => {
    const path = tmpPath();
    const a = openAt(path);
    a.claimCase('s_p1', 'ann', NOW, NOW + TTL, 'claim');
    const t = a.changeToken();
    a.close();
    const b = openAt(path);
    expect(b.changeToken()).toBe(t);
    b.releaseClaim('s_p1', 'ann', NOW);
    expect(b.changeToken()).not.toBe(t);
  });

  it('the claim itself survives a restart too', () => {
    const path = tmpPath();
    openAt(path).claimCase('s_p1', 'ann', NOW, NOW + TTL, 'claim');
    const again = openAt(path);
    expect(again.loadClaims(['s_p1'], NOW + MIN)).toEqual([{ person: 's_p1', by: 'ann', since: NOW, until: NOW + TTL }]);
    expect(again.claimCase('s_p1', 'bea', NOW + MIN, NOW + MIN + TTL, 'claim').won).toBe(false);
  });
});

describe('two connections on one database (two server processes)', () => {
  it('see each other: one claims, the other loses and reads the same token', () => {
    const path = tmpPath();
    const one = openAt(path);
    const two = openAt(path);
    expect(one.claimCase('s_p1', 'ann', NOW, NOW + TTL, 'claim').won).toBe(true);
    const lost = two.claimCase('s_p1', 'bea', NOW + 1, NOW + 1 + TTL, 'claim');
    expect(lost).toEqual({ won: false, claim: { person: 's_p1', by: 'ann', since: NOW, until: NOW + TTL } });
    expect(two.changeToken()).toBe(one.changeToken());
    expect(two.releaseClaim('s_p1', 'ann', NOW + 2)).toBe(true);
    expect(one.loadClaims(['s_p1'], NOW + 2)).toEqual([]);
  });

  it('back to back from two connections: exactly one wins, whichever connection starts', async () => {
    for (const first of [0, 1]) {
      const path = tmpPath();
      const stores = [openAt(path), openAt(path)];
      const names = ['ann', 'bea'];
      const order = first === 0 ? [0, 1] : [1, 0];
      const tries = await Promise.all(
        order.map(async (i) => Promise.resolve().then(() => stores[i]!.claimCase('s_race', names[i]!, NOW, NOW + TTL, 'claim'))),
      );
      expect(tries.filter((t) => t.won)).toHaveLength(1);
      const winner = names[order[0]!];
      expect(stores[0]!.loadClaims(['s_race'], NOW)[0]?.by).toBe(winner);
      expect(stores[1]!.loadClaims(['s_race'], NOW)[0]?.by).toBe(winner);
    }
  });

  it('back to back in "free" mode (take next) for one case: exactly one wins', async () => {
    const path = tmpPath();
    const stores = [openAt(path), openAt(path)];
    const tries = await Promise.all(
      stores.map(async (s, i) => Promise.resolve().then(() => s.claimCase('s_race', `mod${i}`, NOW, NOW + TTL, 'free'))),
    );
    expect(tries.filter((t) => t.won)).toHaveLength(1);
  });

  it('a claim written through one connection is the conditional write of the other: the loser leaves no trace', () => {
    const path = tmpPath();
    const one = openAt(path);
    const two = openAt(path);
    one.claimCase('s_p1', 'ann', NOW, NOW + TTL, 'claim');
    const before = two.changeToken();
    for (let i = 0; i < 5; i++) two.claimCase('s_p1', `bea${i}`, NOW + 1, NOW + 1 + TTL, 'claim');
    expect(two.changeToken()).toBe(before);
    expect(one.loadClaims(['s_p1'], NOW + 1)[0]).toEqual({ person: 's_p1', by: 'ann', since: NOW, until: NOW + TTL });
  });

  it('a take over through one connection is seen by the other, which is then the one locked out', () => {
    const path = tmpPath();
    const one = openAt(path);
    const two = openAt(path);
    one.claimCase('s_p1', 'ann', NOW, NOW + TTL, 'claim');
    expect(two.claimCase('s_p1', 'sam', NOW + MIN, NOW + MIN + TTL, 'takeover')).toMatchObject({ won: true, from: 'ann' });
    expect(one.claimCase('s_p1', 'ann', NOW + MIN, NOW + MIN + TTL, 'claim').won).toBe(false);
  });

  it('saved reasons added on one connection are listed by the other', () => {
    const path = tmpPath();
    const one = openAt(path);
    const two = openAt(path);
    one.insertReason({ id: 'r1', label: 'Spam', text: 'Spamming.', active: true });
    expect(two.listReasons()).toEqual([{ id: 'r1', label: 'Spam', text: 'Spamming.', active: true }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 1: tests that can fail. The earlier "racing" tests ran each call to completion, so a read-then-write claim
// would have passed them. These put a rival's write BETWEEN the pre-read and the conditional write.
// ---------------------------------------------------------------------------------------------------------------------

const UPSERT = 'INSERT INTO kit_claims';

const rawOpen: DatabaseSync[] = [];
afterEach(() => {
  for (const db of rawOpen.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

/**
 * A store over a `DatabaseSync` that runs `between` once, at the moment the claim's conditional write is about to be
 * prepared: after the store read the claim row, before it writes. `between` plays the other process.
 */
function hookedStore(path: string, between: () => void): { store: SqliteStore; arm: () => void; raw: DatabaseSync } {
  const raw = new DatabaseSync(path);
  rawOpen.push(raw);
  raw.exec('PRAGMA journal_mode = WAL');
  let armed = false;
  const db = new Proxy(raw, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === 'prepare') {
        return (sql: string) => {
          if (armed && sql.includes(UPSERT)) {
            armed = false;
            between();
          }
          return target.prepare(sql);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as DatabaseSync;
  const store = openStore({ db });
  open.push(store);
  return { store, arm: () => void (armed = true), raw };
}

const rivalSql = (person: string, by: string): string =>
  `INSERT INTO kit_claims (person, claimed_by, since, until) VALUES ('${person}', '${by}', ${NOW}, ${NOW + TTL})`;

describe('a rival who writes between the read and the conditional write', () => {
  it('on the same connection: the conditional write loses, answers the rival as holder, and moves no token', () => {
    const path = tmpPath();
    const h = hookedStore(path, () => h.raw.exec(rivalSql('s_race', 'rival')));
    const before = h.store.changeToken();
    h.arm();
    const res = h.store.claimCase('s_race', 'ann', NOW, NOW + TTL, 'claim');
    expect(res).toEqual({ won: false, claim: { person: 's_race', by: 'rival', since: NOW, until: NOW + TTL } });
    expect(h.store.loadClaims(['s_race'], NOW)[0]?.by).toBe('rival');
    expect(h.store.changeToken()).toBe(before);
  });

  it("in 'free' mode too", () => {
    const h = hookedStore(tmpPath(), () => h.raw.exec(rivalSql('s_race', 'rival')));
    h.arm();
    const res = h.store.claimCase('s_race', 'ann', NOW, NOW + TTL, 'free');
    expect(res.won).toBe(false);
    expect(h.store.loadClaims(['s_race'], NOW)[0]?.by).toBe('rival');
  });

  it('a rival who appears over a LAPSED claim of the same actor also wins: the old row is not "mine" any more', () => {
    const h = hookedStore(tmpPath(), () => h.raw.exec(`UPDATE kit_claims SET claimed_by = 'rival', since = ${NOW + TTL}, until = ${NOW + 2 * TTL} WHERE person = 's_race'`));
    h.store.claimCase('s_race', 'ann', NOW - TTL, NOW, 'claim'); // ann's claim lapsed at NOW
    h.arm();
    const res = h.store.claimCase('s_race', 'ann', NOW + 1, NOW + 1 + TTL, 'claim');
    expect(res.won).toBe(false);
    expect(h.store.loadClaims(['s_race'], NOW + 1)[0]?.by).toBe('rival');
  });

  it("a take over is the one mode that still wins, and the rival's claim is replaced", () => {
    const h = hookedStore(tmpPath(), () => h.raw.exec(rivalSql('s_race', 'rival')));
    h.arm();
    const res = h.store.claimCase('s_race', 'boss', NOW, NOW + TTL, 'takeover');
    expect(res.won).toBe(true);
    expect(h.store.loadClaims(['s_race'], NOW)[0]?.by).toBe('boss');
  });

  it('on another connection (a stale snapshot): the write is refused by SQLite, never a win, and the rival stands', () => {
    const path = tmpPath();
    const other = openAt(path);
    const h = hookedStore(path, () => void other.claimCase('s_race', 'rival', NOW, NOW + TTL, 'claim'));
    h.arm();
    let outcome: unknown;
    try {
      outcome = h.store.claimCase('s_race', 'ann', NOW, NOW + TTL, 'claim');
    } catch (err) {
      outcome = err;
    }
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as { errcode?: number }).errcode).toBeDefined();
    expect(((outcome as { errcode: number }).errcode) & 0xff).toBe(5);
    expect(other.loadClaims(['s_race'], NOW)[0]?.by).toBe('rival');
    expect(h.store.loadClaims(['s_race'], NOW)).toEqual([{ person: 's_race', by: 'rival', since: NOW, until: NOW + TTL }]);
  });

  it('a stale snapshot held across the whole call (a savepoint opened and read first) never wins either', () => {
    const path = tmpPath();
    const a = openAt(path);
    const b = hookedStore(path, () => undefined);
    b.raw.exec('SAVEPOINT outer');
    b.raw.prepare('SELECT * FROM kit_claims').all(); // B's snapshot: no claim
    a.claimCase('s_race', 'rival', NOW, NOW + TTL, 'claim');
    expect(() => b.store.claimCase('s_race', 'ann', NOW, NOW + TTL, 'claim')).toThrow();
    b.raw.exec('ROLLBACK TO outer');
    b.raw.exec('RELEASE outer');
    expect(b.store.loadClaims(['s_race'], NOW)[0]?.by).toBe('rival');
  });
});

describe('through the kit, a lost race on a real database is the normal answer, not an error', () => {
  const report = (id: string, person: string, n: number) => ({
    id, createdAt: NOW + n, roomId: `R${n}`, tags: {}, reporterSubject: `s_rep${n}`, reporterSeat: 'p1', reporterHandle: 'R',
    targetSubject: person, targetSeat: 'p2', targetHandle: 'T', category: 'harassment' as const, note: null, lineId: null,
    excerpt: [], people: [], status: 'open' as const,
  });
  const kit = async (store: SqliteStore) =>
    createChatwarden({ store, secret: 's', platform: { identify: (c) => c as RawWho }, clock: { now: () => NOW }, retention: false, logger: { warn() {} } });

  it('claim: the loser (stale snapshot) is retried and sees claimed with the rival, no exception', async () => {
    const path = tmpPath();
    const other = openAt(path);
    const h = hookedStore(path, () => void other.claimCase('s_race', 'rival', NOW, NOW + TTL, 'claim'));
    h.store.insertReport(report('r1', 's_race', 1));
    const cw = await kit(h.store);
    h.arm();
    expect(cw.cases.claim('s_race', 'ann')).toEqual({
      ok: false,
      error: 'claimed',
      claim: { by: 'rival', since: NOW, until: NOW + TTL },
    });
  });

  it('take next: the candidate lost to a rival is skipped and the next one is taken', async () => {
    const path = tmpPath();
    const other = openAt(path);
    const h = hookedStore(path, () => void other.claimCase('s_a', 'rival', NOW, NOW + TTL, 'claim'));
    h.store.insertReport(report('r1', 's_a', 1));
    h.store.insertReport(report('r2', 's_b', 2));
    const cw = await kit(h.store);
    h.arm();
    expect(cw.cases.next('ann')).toMatchObject({ person: 's_b', reportId: 'r2', claim: { by: 'ann' } });
    expect(cw.cases.holder('s_a')?.by).toBe('rival');
  });

  it('two kits on one file: back to back, exactly one claim wins and the other gets claimed', async () => {
    const path = tmpPath();
    const one = openAt(path);
    const two = openAt(path);
    one.insertReport(report('r1', 's_race', 1));
    const [a, b] = await Promise.all([kit(one), kit(two)]);
    const results = [a.cases.claim('s_race', 'ann'), b.cases.claim('s_race', 'bea')];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === 'claimed')).toHaveLength(1);
  });
});

describe('the connection waits for a lock instead of failing at once', () => {
  const timeoutOf = (db: DatabaseSync): number => Number(db.prepare('PRAGMA busy_timeout').get()?.timeout);

  it('a file the kit opens gets a busy timeout', () => {
    const path = tmpPath();
    const s = openAt(path);
    const probe = (s as unknown as { db: DatabaseSync }).db;
    expect(timeoutOf(probe)).toBeGreaterThanOrEqual(1000);
  });

  it('a connection handed in with none gets one; one that already has a timeout keeps its own', () => {
    const none = new DatabaseSync(':memory:');
    rawOpen.push(none);
    expect(timeoutOf(none)).toBe(0);
    openStore({ db: none });
    expect(timeoutOf(none)).toBeGreaterThanOrEqual(1000);

    const own = new DatabaseSync(':memory:');
    rawOpen.push(own);
    own.exec('PRAGMA busy_timeout = 1234');
    openStore({ db: own });
    expect(timeoutOf(own)).toBe(1234);
  });
});
