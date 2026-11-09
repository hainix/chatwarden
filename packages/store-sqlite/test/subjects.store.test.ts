import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SubjectIndex, type Identifiers, type Logger } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-subj-'));
  tmpDirs.push(dir);
  return join(dir, 'kit.db');
}

function clockAt(start: number) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

function who(clientKey: string | null, accountId: string | null = null, ipHash: string | null = null): Identifiers {
  return { clientKey, accountId, ipHash };
}

const quiet: Logger & { events: string[] } = {
  events: [],
  warn(event) {
    this.events.push(event);
  },
};

describe('migration 1: subjects', () => {
  it('creates kit_subjects and kit_subject_ids and is version 1 or later', () => {
    expect(MIGRATIONS[0]?.version).toBe(1);
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(1);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kit_%' ORDER BY name")
      .all()
      .map((r) => String(r.name));
    expect(names).toEqual(expect.arrayContaining(['kit_meta', 'kit_subject_ids', 'kit_subjects']));
    db.close();
  });
});

describe('SqliteStore subject methods', () => {
  it('saveSubject / loadSubjects round trip, and saveSubject is idempotent', async () => {
    const store = openStore({ path: ':memory:' });
    await store.saveSubject({ id: 's_a', createdAt: 10, mergedInto: null });
    await store.saveSubject({ id: 's_a', createdAt: 10, mergedInto: null });
    expect(await store.loadSubjects()).toEqual({
      subjects: [{ id: 's_a', createdAt: 10, mergedInto: null }],
      ids: [],
    });
    store.close();
  });

  it('markMerged sets merged_into', async () => {
    const store = openStore({ path: ':memory:' });
    await store.saveSubject({ id: 's_a', createdAt: 1, mergedInto: null });
    await store.saveSubject({ id: 's_b', createdAt: 2, mergedInto: null });
    await store.markMerged('s_b', 's_a');
    const { subjects } = await store.loadSubjects();
    expect(subjects.find((s) => s.id === 's_b')?.mergedInto).toBe('s_a');
    expect(subjects.find((s) => s.id === 's_a')?.mergedInto).toBeNull();
    store.close();
  });

  it('saveIdentifier upserts: first_seen is kept, last_seen only moves forward', async () => {
    const store = openStore({ path: ':memory:' });
    await store.saveSubject({ id: 's_a', createdAt: 1, mergedInto: null });
    await store.saveIdentifier({ subjectId: 's_a', kind: 'key', value: 'k', firstSeen: 100, lastSeen: 100 });
    await store.saveIdentifier({ subjectId: 's_a', kind: 'key', value: 'k', firstSeen: 300, lastSeen: 300 });
    await store.saveIdentifier({ subjectId: 's_a', kind: 'key', value: 'k', firstSeen: 200, lastSeen: 200 });
    const { ids } = await store.loadSubjects();
    expect(ids).toEqual([{ subjectId: 's_a', kind: 'key', value: 'k', firstSeen: 100, lastSeen: 300 }]);
    store.close();
  });

  it('the same IP may be recorded on two subjects; the same key twice on one subject is one row', async () => {
    const store = openStore({ path: ':memory:' });
    await store.saveSubject({ id: 's_a', createdAt: 1, mergedInto: null });
    await store.saveSubject({ id: 's_b', createdAt: 2, mergedInto: null });
    await store.saveIdentifier({ subjectId: 's_a', kind: 'ip', value: 'ip', firstSeen: 1, lastSeen: 1 });
    await store.saveIdentifier({ subjectId: 's_b', kind: 'ip', value: 'ip', firstSeen: 2, lastSeen: 2 });
    expect((await store.loadSubjects()).ids).toHaveLength(2);
    store.close();
  });

  it('an identifier for a subject that does not exist is rejected (foreign key)', async () => {
    const store = openStore({ path: ':memory:' });
    await expect(
      store.saveIdentifier({ subjectId: 's_missing', kind: 'key', value: 'k', firstSeen: 1, lastSeen: 1 }),
    ).rejects.toThrow();
    store.close();
  });

  it('an unknown identifier kind is rejected', async () => {
    const store = openStore({ path: ':memory:' });
    await store.saveSubject({ id: 's_a', createdAt: 1, mergedInto: null });
    await expect(
      store.saveIdentifier({ subjectId: 's_a', kind: 'phone' as 'key', value: 'k', firstSeen: 1, lastSeen: 1 }),
    ).rejects.toThrow();
    store.close();
  });

  it('loadSubjects on an empty database returns empty lists', async () => {
    const store = openStore({ path: ':memory:' });
    expect(await store.loadSubjects()).toEqual({ subjects: [], ids: [] });
    store.close();
  });
});

describe('SubjectIndex on SQLite', () => {
  it('reload after merge restores aliases', async () => {
    const path = tmpPath();
    const clock = clockAt(100);
    const store = openStore({ path });
    const index = new SubjectIndex(store, clock, { logger: quiet });
    await index.load();

    const older = index.resolve(who('k1', null, 'ip-1'));
    clock.set(200);
    const newer = index.resolve(who(null, 'a1'));
    clock.set(300);
    const merged = index.resolve(who('k1', 'a1'));
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();
    expect(older).not.toBe(newer);
    expect(merged).toBe(older);
    await index.flush();
    store.close();

    const reopened = openStore({ path });
    const fresh = new SubjectIndex(reopened, clock, { logger: quiet });
    await fresh.load();
    expect(fresh.canonical(newer as string)).toBe(older);
    expect(fresh.resolve(who(null, 'a1'))).toBe(older);
    expect(fresh.resolve(who('k1'))).toBe(older);
    expect(fresh.identifiersOf(older as string)).toEqual({ accounts: ['a1'], keys: ['k1'], ips: ['ip-1'] });
    expect(quiet.events).toEqual([]);
    reopened.close();
  });

  it('reload after a chain of merges resolves every alias to the root', async () => {
    const clock = clockAt(0);
    const store = openStore({ path: ':memory:' });
    const index = new SubjectIndex(store, clock, { logger: quiet });
    await index.load();
    const c = index.resolve(who('kc'));
    clock.set(10);
    const b = index.resolve(who('kb'));
    clock.set(20);
    const a = index.resolve(who('ka'));
    index.resolve(who('ka', 'x'));
    index.resolve(who('kb', 'x'));
    index.resolve(who('kc', 'x'));
    await index.flush();

    const fresh = new SubjectIndex(store, clock, { logger: quiet });
    await fresh.load();
    expect(fresh.canonical(a as string)).toBe(c);
    expect(fresh.canonical(b as string)).toBe(c);
    expect(fresh.identifiersOf(c as string).keys).toEqual(['ka', 'kb', 'kc']);
    store.close();
  });

  it('writes land in order, so the identifier foreign keys hold (no failures logged)', async () => {
    const store = openStore({ path: ':memory:' });
    const events: string[] = [];
    const index = new SubjectIndex(store, clockAt(1), { logger: { warn: (e) => void events.push(e) } });
    await index.load();
    for (let i = 0; i < 20; i++) index.resolve(who(`k${i}`, `a${i}`, `ip${i}`));
    await index.flush();
    expect(events).toEqual([]);
    expect((await store.loadSubjects()).ids).toHaveLength(60);
    store.close();
  });

  it('IP alone writes nothing', async () => {
    const store = openStore({ path: ':memory:' });
    const index = new SubjectIndex(store, clockAt(1), { logger: quiet });
    await index.load();
    expect(index.resolve(who(null, null, 'ip-1'))).toBeNull();
    await index.flush();
    expect(await store.loadSubjects()).toEqual({ subjects: [], ids: [] });
    store.close();
  });

  it('works on a connection the host owns, beside the host tables', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE host_users (id INTEGER PRIMARY KEY)');
    const store = openStore({ db });
    const index = new SubjectIndex(store, clockAt(1), { logger: quiet });
    await index.load();
    index.resolve(who('k1'));
    await index.flush();
    expect((await store.loadSubjects()).subjects).toHaveLength(1);
    store.close();
    expect(db.isOpen).toBe(true);
    db.close();
  });
});
