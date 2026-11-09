import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applySanction,
  StrikeService,
  SubjectIndex,
  type Identifiers,
  type SanctionKind,
  type Source,
  type StrikeRow,
} from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const who = (clientKey: string | null, accountId: string | null = null, ipHash: string | null = null): Identifiers => ({
  clientKey,
  accountId,
  ipHash,
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-strike-'));
  tmpDirs.push(dir);
  return join(dir, 'kit.db');
}

const strike = (over: Partial<StrikeRow> = {}): StrikeRow => ({
  id: 'x1',
  at: NOW,
  subject: 's_a',
  roomId: 'ROOM1',
  termId: 'term-1',
  rawLine: 'zorbak you',
  ...over,
});

function env() {
  const db = new DatabaseSync(':memory:');
  const store = openStore({ db });
  return { db, store };
}

describe('migration 5: kit_strikes', () => {
  it('is version 5 and creates the table with the documented columns', () => {
    expect(MIGRATIONS[4]?.version).toBe(5);
    const { db, store } = env();
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(5);
    const cols = db.prepare('PRAGMA table_info(kit_strikes)').all().map((c) => String(c.name));
    expect(cols).toEqual(['id', 'at', 'subject_id', 'room_id', 'term_id', 'raw_line']);
    db.close();
  });

  it('has an index on (subject_id, at)', () => {
    const { db } = env();
    const cols = db
      .prepare("SELECT name FROM pragma_index_info('kit_strikes_by_subject') ORDER BY seqno")
      .all()
      .map((c) => String(c.name));
    expect(cols).toEqual(['subject_id', 'at']);
    db.close();
  });

  it('holds no ip, key or account column: a strike is never keyed by IP', () => {
    const { db } = env();
    const cols = db.prepare('PRAGMA table_info(kit_strikes)').all().map((c) => String(c.name));
    expect(cols.filter((c) => /ip|key|account/.test(c))).toEqual([]);
    db.close();
  });

  it('upgrades a version 4 database in place and keeps its rows', async () => {
    const path = tmpPath();
    const v4 = openStore({ path, migrations: MIGRATIONS.slice(0, 4) });
    await v4.saveSubject({ id: 's_a', createdAt: 5, mergedInto: null });
    expect(v4.schemaVersion()).toBe(4);
    v4.close();
    const v5 = openStore({ path });
    expect(v5.schemaVersion()).toBeGreaterThanOrEqual(5);
    expect((await v5.loadSubjects()).subjects).toHaveLength(1);
    expect(v5.loadStrikes(0)).toEqual([]);
    v5.close();
  });

  it('only touches kit_ tables', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    openStore({ db });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    expect(names.filter((n) => !n.startsWith('kit_') && !n.startsWith('sqlite_'))).toEqual(['users']);
    db.close();
  });
});

describe('insertStrike / loadStrikes', () => {
  it('round-trips a row, including the raw line', () => {
    const { store } = env();
    const row = strike({ rawLine: 'a line, with "quotes" and é' });
    store.insertStrike(row);
    expect(store.loadStrikes(0)).toEqual([row]);
  });

  it('loadStrikes keeps rows at or after `since`, oldest first', () => {
    const { store } = env();
    store.insertStrike(strike({ id: 'c', at: NOW + 20 }));
    store.insertStrike(strike({ id: 'a', at: NOW }));
    store.insertStrike(strike({ id: 'b', at: NOW + 10 }));
    expect(store.loadStrikes(NOW + 10).map((r) => r.id)).toEqual(['b', 'c']);
    expect(store.loadStrikes(0).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(store.loadStrikes(NOW + 21)).toEqual([]);
  });

  it('a duplicate id is rejected (primary key) and writes nothing', () => {
    const { store } = env();
    store.insertStrike(strike());
    expect(() => store.insertStrike(strike({ at: NOW + 1 }))).toThrow();
    expect(store.loadStrikes(0)).toHaveLength(1);
  });

  it('is rolled back with the enclosing transaction', () => {
    const { store } = env();
    expect(() =>
      store.transaction(() => {
        store.insertStrike(strike());
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.loadStrikes(0)).toEqual([]);
  });
});

describe('loadAutoChatStarts', () => {
  const sanction = (
    store: ReturnType<typeof env>['store'],
    subjects: SubjectIndex,
    subject: string,
    at: number,
    over: { kind?: SanctionKind; source?: Source; includeIp?: boolean } = {},
  ) =>
    applySanction(
      store,
      subjects,
      {
        kind: over.kind ?? 'chat',
        subject,
        includeIp: over.includeIp ?? false,
        durationMs: 30 * MIN,
        reason: 'auto',
        actor: 'auto',
        source: over.source ?? 'auto_filter',
        automated: true,
      },
      at,
    );

  function fixture() {
    const { db, store } = env();
    const clock = { now: () => NOW };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const a = subjects.resolve(who('ka', null, 'ip1')) as string;
    const b = subjects.resolve(who('kb')) as string;
    return { db, store, subjects, a, b };
  }

  it('returns the latest start per subject, for chat sanctions from auto_filter only', async () => {
    const { store, subjects, a, b } = fixture();
    await subjects.flush();
    await sanction(store, subjects, a, NOW - 5 * DAY);
    await sanction(store, subjects, a, NOW - 2 * DAY);
    await sanction(store, subjects, a, NOW - DAY, { source: 'moderator' });
    await sanction(store, subjects, a, NOW, { kind: 'area' });
    await sanction(store, subjects, b, NOW - 3 * DAY, { source: 'coop' });
    expect(store.loadAutoChatStarts()).toEqual([{ subject: a, startsAt: NOW - 2 * DAY }]);
  });

  it('counts revoked and expired rows', async () => {
    const { store, subjects, a } = fixture();
    await subjects.flush();
    const { groupId } = await sanction(store, subjects, a, NOW - 20 * DAY);
    store.revokeSanctionGroup(groupId, 'mod', NOW - 19 * DAY, 'sorry');
    expect(store.loadAutoChatStarts()).toEqual([{ subject: a, startsAt: NOW - 20 * DAY }]);
  });

  it('never reports the IP row of a sanction', async () => {
    const { store, subjects, a } = fixture();
    await subjects.flush();
    await sanction(store, subjects, a, NOW - DAY, { includeIp: true });
    expect(store.loadAutoChatStarts()).toEqual([{ subject: a, startsAt: NOW - DAY }]);
  });

  it('is empty on a fresh store', () => {
    expect(env().store.loadAutoChatStarts()).toEqual([]);
  });
});

describe('StrikeService on SQLite', () => {
  it('survives a restart: the tally and the escalation come back from disk', async () => {
    const path = tmpPath();
    const clock = { t: NOW, now: () => clock.t };
    const quiet = { warn() {} };

    const store1 = openStore({ path });
    const subjects1 = new SubjectIndex(store1, clock, { logger: quiet });
    await subjects1.load();
    const person = subjects1.resolve(who('k1', 'a1')) as string;
    const strikes1 = new StrikeService(store1, clock, subjects1, { logger: quiet });
    await strikes1.load();
    strikes1.record(person, 'rk', 'ROOM1', 'term-1', 'line one');
    clock.t = NOW + MIN;
    strikes1.record(person, 'rk', 'ROOM1', 'term-1', 'line two');
    clock.t = NOW + 2 * MIN;
    const first = strikes1.record(person, 'rk', 'ROOM1', 'term-1', 'line three');
    expect(first.autoRestrict).toEqual({ durationMs: 30 * MIN });
    await applySanction(
      store1,
      subjects1,
      { kind: 'chat', subject: person, includeIp: false, durationMs: 30 * MIN, reason: 'auto', actor: 'auto', source: 'auto_filter', automated: true },
      clock.t,
    );
    clock.t = NOW + 3 * MIN;
    strikes1.record(person, 'rk', 'ROOM1', 'term-1', 'line four');
    await subjects1.flush();
    store1.close();

    const store2 = openStore({ path });
    const subjects2 = new SubjectIndex(store2, clock, { logger: quiet });
    await subjects2.load();
    const strikes2 = new StrikeService(store2, clock, subjects2, { logger: quiet });
    clock.t = NOW + 33 * MIN;
    await strikes2.load();
    // One strike since the restriction began (line four); two more fire it, escalated to 24 h.
    expect(strikes2.record(person, 'rk', 'ROOM1', 'term-1', 'five').autoRestrict).toBeNull();
    clock.t = NOW + 34 * MIN;
    expect(strikes2.record(person, 'rk', 'ROOM1', 'term-1', 'six').autoRestrict).toEqual({ durationMs: 24 * H });
    expect(store2.loadStrikes(0)).toHaveLength(6);
    store2.close();
  });

  it('a table that is gone: the service still decides from memory and logs only the event', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    const clock = { t: NOW, now: () => clock.t };
    const logs: Array<[string, unknown]> = [];
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const person = subjects.resolve(who('k1')) as string;
    await subjects.flush();
    const strikes = new StrikeService(store, clock, subjects, { logger: { warn: (e, d) => logs.push([e, d]) } });
    db.exec('DROP TABLE kit_strikes');
    const out = [0, 1, 2].map((i) => {
      clock.t = NOW + i;
      return strikes.record(person, 'rk', 'R', 't', 'x').autoRestrict;
    });
    expect(out).toEqual([null, null, { durationMs: 30 * MIN }]);
    expect(logs).toHaveLength(3);
    for (const [event, detail] of logs) {
      expect(event).toBe('strikes.write_failed');
      expect(Object.keys(detail as object)).toEqual(['error']);
    }
    db.close();
  });
});
