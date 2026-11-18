import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden, RawWho } from '@chatwarden/core';
import { openStore } from '../src/index.js';
import type { SqliteStore } from '../src/index.js';

// The kit over real SQLite, two processes (two connections) on one database file: the chunk 5 fix round, Important 1 (a failed `saveSubject`) and Important 3 (an
// erase here must not swallow another process's earlier erase).

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 86_400_000;
const OWNER = 'owner_ann';

const dirs: string[] = [];
const stores: SqliteStore[] = [];
const kits: Chatwarden[] = [];
afterEach(async () => {
  for (const k of kits.splice(0)) await k.close();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const clock = { t: NOW, now: () => clock.t };
const fileDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-privfac-'));
  dirs.push(dir);
  return join(dir, 'kit.db');
};
const kit = async (path: string): Promise<{ cw: Chatwarden; store: SqliteStore }> => {
  const store = openStore({ path });
  stores.push(store);
  const cw = await createChatwarden({ store, secret: 'privacy-facade-secret', platform: { identify: (ctx) => ctx as RawWho }, clock, retention: false });
  kits.push(cw);
  return { cw, store };
};

describe('two processes on one file: an erase here keeps what another process erased before', () => {
  it('B erases X, then A erases Y: A still drops X within the same pass, its seat for X becomes a guest, and the database holds neither', async () => {
    clock.t = NOW;
    const path = fileDb();
    const seed = await kit(path);
    for (const [seat, key] of [['p1', 'key-x'], ['p2', 'key-y'], ['p3', 'key-z']] as const) seed.cw.rooms.seat('R1', seat, { clientKey: key, accountId: `acct-${key}` }, key);
    await seed.cw.flush();
    const x = seed.cw.rooms.subjectAt('R1', 'p1') as string;
    const y = seed.cw.rooms.subjectAt('R1', 'p2') as string;
    const z = seed.cw.rooms.subjectAt('R1', 'p3') as string;
    await seed.cw.close();

    const a = await kit(path);
    const b = await kit(path);
    for (const k of [a, b]) {
      k.cw.rooms.seat('R2', 'p1', { clientKey: 'key-x', accountId: 'acct-key-x' }, 'X');
      k.cw.rooms.seat('R2', 'p2', { clientKey: 'key-y', accountId: 'acct-key-y' }, 'Y');
      k.cw.rooms.seat('R2', 'p3', { clientKey: 'key-z', accountId: 'acct-key-z' }, 'Z');
      await k.cw.flush();
    }
    expect(a.cw.rooms.subjectAt('R2', 'p1')).toBe(x);

    expect('ok' in (await b.cw.privacy.erase(x, { keep: 'none', actor: OWNER }))).toBe(false);
    expect('ok' in (await a.cw.privacy.erase(y, { keep: 'none', actor: OWNER }))).toBe(false);
    await a.cw.flush();

    expect(a.cw.people.accountIds(x)).toEqual([]);
    expect(a.cw.people.accountIds(y)).toEqual([]);
    expect(a.cw.people.accountIds(z)).not.toEqual([]);
    expect(a.cw.privacy.find({ clientKey: 'key-x' })).toBeNull();
    expect(a.cw.rooms.subjectAt('R2', 'p1')).toBeNull();
    expect(a.cw.rooms.subjectAt('R2', 'p3')).toBe(z);
    // lines of X typed in A afterwards are written under nobody
    a.cw.chat.accept('R2', 'p1', 'a line after the erase');
    await a.cw.flush();
    const left = (await a.store.loadSubjects()).subjects.map((s) => s.id);
    expect(left).toEqual([z]);
  });

  it('with only its own erase in between, nothing is reloaded (the epoch moved by exactly one)', async () => {
    clock.t = NOW;
    const path = fileDb();
    const a = await kit(path);
    a.cw.rooms.seat('R1', 'p1', { clientKey: 'key-x' }, 'X');
    a.cw.rooms.seat('R1', 'p2', { clientKey: 'key-y' }, 'Y');
    await a.cw.flush();
    const x = a.cw.rooms.subjectAt('R1', 'p1') as string;
    let loads = 0;
    const real = a.store.loadSubjects.bind(a.store);
    a.store.loadSubjects = () => {
      loads += 1;
      return real();
    };
    await a.cw.privacy.erase(x, { keep: 'none', actor: OWNER });
    clock.t = NOW + 2 * MIN;
    a.cw.rooms.seat('R3', 'p1', { clientKey: 'key-new' }, 'N');
    await a.cw.flush();
    expect(loads).toBe(0);
  });
});

describe('a saveSubject that fails once must not cost the person their rows', () => {
  it('rows written, a sweep ten minutes later: the notice and the strike survive, and the subject row is there', async () => {
    clock.t = NOW;
    const { cw, store } = await kit(fileDb());
    const real = store.saveSubject.bind(store);
    let calls = 0;
    store.saveSubject = async (s) => {
      calls += 1;
      if (calls === 2) throw new Error('SQLITE_BUSY');
      return real(s);
    };
    cw.rooms.seat('R1', 'p1', { clientKey: 'key-rep' }, 'Rep');
    cw.rooms.seat('R1', 'p2', { clientKey: 'key-tgt' }, 'Tgt');
    await cw.flush();
    const target = cw.rooms.subjectAt('R1', 'p2') as string;
    const filed = await cw.reports.submit({ roomId: 'R1', reporterSeat: 'p1', targetSeat: 'p2' });
    if (!filed.ok) throw new Error('report refused');
    const res = await cw.decide({ reportId: filed.reportId, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: target, kind: 'chat', durationMs: DAY, rule: 2, lineIds: [] }] });
    if (!res.ok) throw new Error('decision refused');
    store.insertStrike({ id: 'st-t', at: NOW, subject: target, roomId: 'R1', termId: 't', rawLine: 'zorbak line' });
    expect((await store.loadSubjects()).subjects.map((s) => s.id)).not.toContain(target);

    clock.t = NOW + 11 * MIN;
    const result = await cw.purge();
    expect(result.strayRows).toBe(0);
    expect(store.loadNotices([target]).length).toBe(1);
    expect(store.loadStrikes(0).map((s) => s.id)).toEqual(['st-t']);
    const loaded = await store.loadSubjects();
    expect(loaded.subjects.map((s) => s.id)).toContain(target);
    expect(loaded.ids.some((r) => r.subjectId === target && r.value.length > 0)).toBe(true);
  });
});
