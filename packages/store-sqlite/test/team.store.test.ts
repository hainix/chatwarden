import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openStore } from '../src/index.js';
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
  it('is the latest migration, adds kit_claims and kit_reasons, and nothing named in the token', () => {
    expect(MIGRATIONS.at(-1)?.version).toBe(15);
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kit_%' ORDER BY name").all().map((r) => String(r.name));
    expect(tables).toContain('kit_claims');
    expect(tables).toContain('kit_reasons');
    expect(db.prepare("SELECT value FROM kit_meta WHERE key='schema_version'").get()?.value).toBe('15');
    // The token has no row until the first change: it reads as 0.
    expect(db.prepare("SELECT 1 AS one FROM kit_meta WHERE key='change_token'").get()).toBeUndefined();
  });

  it('upgrades a database left at version 14 and keeps its rows', () => {
    const path = tmpPath();
    const old = openStore({ path, migrations: MIGRATIONS.slice(0, 14) });
    expect(old.schemaVersion()).toBe(14);
    old.insertReport({
      id: 'old-report', createdAt: NOW, roomId: 'R', tags: {}, reporterSubject: 's_a', reporterSeat: 'p1', reporterHandle: 'A',
      targetSubject: 's_b', targetSeat: 'p2', targetHandle: 'B', category: 'spam', note: null, lineId: null, excerpt: [], people: [], status: 'open',
    });
    old.close();

    const s = openAt(path);
    expect(s.schemaVersion()).toBe(15);
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

  it('racing for one case, interleaved: exactly one wins, whichever connection starts', async () => {
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

  it('racing in "free" mode (take next) for one case: exactly one wins', async () => {
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
