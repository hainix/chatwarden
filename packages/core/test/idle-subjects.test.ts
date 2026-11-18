import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemorySignals } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import { PRIVACY_REGISTRY, registrySubjectColumns } from '../src/privacy.js';
import { checkRetentionFloors, purge, RETENTION_DEFAULTS } from '../src/retention.js';
import type { RetentionPolicy } from '../src/retention.js';
import { ProfileError } from '../src/profile.js';
import type { Store } from '../src/types.js';
import { A, B, DAY, NOW, privacyWorld } from './privacyWorld.js';

// The identity age-out (0.2.2, Moxgate audit W6): `retention.subjectsMs` (400 days by default) and what `purge()` does with it. The store-level rules (which
// records keep a person, merged aliases, the cutoff) are the contract in test/contract/idle.contract.ts; this file is the policy, the purge pass and the kit.

describe('retention.subjectsMs', () => {
  it('defaults to 400 days, the longest of the other defaults', () => {
    expect(RETENTION_DEFAULTS.subjectsMs).toBe(400 * DAY);
    const others = Object.entries(RETENTION_DEFAULTS).filter(([k]) => k !== 'subjectsMs').map(([, v]) => v);
    expect(Math.max(...others)).toBe(400 * DAY);
  });

  it('is optional on the policy type and checked when given: finite, and at least 90 days', () => {
    const p: Partial<RetentionPolicy> = { subjectsMs: 90 * DAY };
    expect(() => checkRetentionFloors(p, 7 * DAY)).not.toThrow();
    expect(() => checkRetentionFloors({}, 7 * DAY)).not.toThrow();
    expect(() => checkRetentionFloors({ subjectsMs: 5000 * DAY }, 7 * DAY)).not.toThrow();
    for (const bad of [89 * DAY, 0, -1]) {
      try {
        checkRetentionFloors({ subjectsMs: bad }, 7 * DAY);
        throw new Error('expected a ProfileError');
      } catch (e) {
        expect(e).toBeInstanceOf(ProfileError);
        expect((e as ProfileError).path).toBe('retention.subjectsMs');
        expect((e as ProfileError).reason).toContain('90 days');
      }
    }
    for (const bad of [NaN, Infinity, '400' as unknown as number]) {
      expect(() => checkRetentionFloors({ subjectsMs: bad }, 7 * DAY), String(bad)).toThrow(ProfileError);
    }
  });

  it('createChatwarden refuses a window below the floor and accepts one at it', async () => {
    const make = (subjectsMs: number) =>
      createChatwarden({ store: new MemoryStore(), secret: 's', platform: { identify: () => ({}) }, retention: { subjectsMs } });
    await expect(make(DAY)).rejects.toThrow(ProfileError);
    const cw = await make(90 * DAY);
    await cw.close();
  });
});

const sub = async (s: Store, id: string, lastSeen: number) => {
  await s.saveSubject({ id, createdAt: lastSeen - DAY, mergedInto: null });
  await s.saveIdentifier({ subjectId: id, kind: 'key', value: `key-${id}`, firstSeen: lastSeen - DAY, lastSeen });
};
const noStray = <S extends MemoryStore>(s: S): S => {
  s.purgeStrayRows = () => 0;
  return s;
};

describe('purge() and the age-out', () => {
  it('reports the subject rows it deleted as idleSubjects, on the default window of 400 days (strict at the line)', async () => {
    const store = noStray(new MemoryStore());
    await sub(store, 's_old', NOW - 401 * DAY);
    await sub(store, 's_line', NOW - 400 * DAY);
    await sub(store, 's_new', NOW - 399 * DAY);
    const result = await purge(store, NOW);
    expect(result.idleSubjects).toBe(1);
    expect((await store.loadSubjects()).subjects.map((s) => s.id).sort()).toEqual(['s_line', 's_new']);
    expect((await purge(store, NOW)).idleSubjects).toBe(0);
    expect((await purge(store, NOW + DAY)).idleSubjects).toBe(1);
  });

  it('follows a window the caller sets, and 0 when nothing is idle', async () => {
    const store = noStray(new MemoryStore());
    await sub(store, 's_a', NOW - 120 * DAY);
    await sub(store, 's_b', NOW - 80 * DAY);
    expect((await purge(store, NOW, { subjectsMs: 100 * DAY })).idleSubjects).toBe(1);
    expect((await store.loadSubjects()).subjects.map((s) => s.id)).toEqual(['s_b']);
    expect((await purge(store, NOW, { subjectsMs: 100 * DAY })).idleSubjects).toBe(0);
  });

  it('a window that is not a finite number of at least 0 is refused like the others, and nothing is deleted', async () => {
    const store = noStray(new MemoryStore());
    await sub(store, 's_a', NOW - 900 * DAY);
    await expect(purge(store, NOW, { subjectsMs: NaN })).rejects.toThrow('purge: invalid subjectsMs');
    await expect(purge(store, NOW, { subjectsMs: -1 })).rejects.toThrow('purge: invalid subjectsMs');
    expect((await store.loadSubjects()).subjects).toHaveLength(1);
  });

  it('a store without the method purges everything else and reports 0', async () => {
    const store = noStray(new MemoryStore());
    (store as { purgeIdleSubjects?: unknown }).purgeIdleSubjects = undefined;
    await sub(store, 's_old', NOW - 900 * DAY);
    store.insertStrike({ id: 'st', at: NOW - 40 * DAY, subject: 's_old', roomId: 'R', termId: 't', rawLine: 'zorbak' });
    const result = await purge(store, NOW);
    expect(result.idleSubjects).toBe(0);
    expect(result.strikes).toBe(1);
    expect((await store.loadSubjects()).subjects).toHaveLength(1);
  });

  it('runs after the other tables, so a person whose last record ages out in this pass goes in this pass', async () => {
    const store = noStray(withMemorySignals(new MemoryStore()));
    await sub(store, 's_gone', NOW - 500 * DAY);
    await sub(store, 's_held', NOW - 500 * DAY);
    // an ended chat sanction, 200 days past its end (past the 90 days a sanction row is kept), and a strike 40 days old (past 30)
    store.insertSanctionGroup([
      { id: 'r1', groupId: 'g1', refCode: 'M-AAAAA', kind: 'chat', targetType: 'subject', value: 's_gone', startsAt: NOW - 300 * DAY, endsAt: NOW - 200 * DAY, reason: 'r', rule: '1', gapNote: null, gapStatus: null, roomId: null, actor: 'mod', source: 'moderator', automated: false, pending: false },
    ]);
    store.insertStrike({ id: 'st1', at: NOW - 40 * DAY, subject: 's_gone', roomId: 'R', termId: 't', rawLine: 'zorbak' });
    // a sanction that ended 20 days ago is still a record
    store.insertSanctionGroup([
      { id: 'r2', groupId: 'g2', refCode: 'M-BBBBB', kind: 'chat', targetType: 'subject', value: 's_held', startsAt: NOW - 30 * DAY, endsAt: NOW - 20 * DAY, reason: 'r', rule: '1', gapNote: null, gapStatus: null, roomId: null, actor: 'mod', source: 'moderator', automated: false, pending: false },
    ]);
    const result = await purge(store, NOW);
    expect(result).toMatchObject({ sanctions: 1, strikes: 1, idleSubjects: 1 });
    expect((await store.loadSubjects()).subjects.map((s) => s.id)).toEqual(['s_held']);
  });
});

describe('the registry names what keeps a person', () => {
  it('every rule has the two lists (an empty list is a decision, a missing one is a gap), each entry a table the rule claims', () => {
    for (const rule of PRIVACY_REGISTRY) {
      expect(Array.isArray(rule.subjectColumns), rule.category).toBe(true);
      expect(Array.isArray(rule.subjectJsonColumns), rule.category).toBe(true);
      for (const c of [...(rule.subjectColumns ?? []), ...(rule.subjectJsonColumns ?? [])]) {
        expect(c, `${rule.category}: ${c}`).toMatch(/^kit_[a-z_]+\.[a-z_]+$/);
        expect(rule.tables, `${rule.category}: ${c}`).toContain(c.split('.')[0]);
      }
    }
  });

  it('registrySubjectColumns lists each column once, split into plain and JSON, and none of the index tables', () => {
    const { plain, json } = registrySubjectColumns();
    expect(new Set(plain).size).toBe(plain.length);
    expect(new Set(json).size).toBe(json.length);
    expect(plain).toEqual(expect.arrayContaining(['kit_notices.subject_id', 'kit_sanctions.target_value', 'kit_mutes.viewer_id', 'kit_mutes.target_id', 'kit_signals.by_subject', 'kit_pace.who']));
    expect(json).toEqual(expect.arrayContaining(['kit_reports.people_json', 'kit_decisions.result_json']));
    for (const c of [...plain, ...json]) expect(c.startsWith('kit_subjects.') || c.startsWith('kit_subject_ids.'), c).toBe(false);
  });

  it('the subjects and identifiers categories now say they live on retention.subjectsMs', () => {
    for (const category of ['subjects', 'identifiers'] as const) {
      expect(PRIVACY_REGISTRY.find((r) => r.category === category)?.retention, category).toBe('subjectsMs');
    }
  });
});

describe('the privacy statement', () => {
  it('says what keeps an identity row: the subjects and identifiers categories carry the live clock and a note, every other category has no note', async () => {
    const w = await privacyWorld({ retention: { subjectsMs: 100 * DAY } });
    const st = w.cw.privacy.statement();
    for (const c of st.categories) {
      if (c.category === 'subjects' || c.category === 'identifiers') {
        expect(c.retentionMs, c.category).toBe(100 * DAY);
        expect(c.retentionNote, c.category).toMatch(/no other record/);
        expect(c.retentionNote, c.category).toMatch(/last seen/);
      } else {
        expect(c.retentionNote, c.category).toBeNull();
      }
    }
    await w.cw.close();
  });

  it('on the default clock the statement says 400 days', async () => {
    const w = await privacyWorld();
    const by = (name: string) => w.cw.privacy.statement().categories.find((c) => c.category === name);
    expect(by('subjects')?.retentionMs).toBe(400 * DAY);
    expect(by('identifiers')?.retentionMs).toBe(400 * DAY);
  });
});

describe('the kit: an idle person is forgotten, a returning one is kept', () => {
  it('after 401 days with no record, purge() deletes both players, the index forgets them and a returning key is a new person', async () => {
    const w = await privacyWorld();
    expect(w.cw.privacy.find({ clientKey: A.key })).toBe(w.aId);
    w.clock.t = NOW + 401 * DAY;
    const result = await w.cw.purge();
    expect(result.idleSubjects).toBe(2);
    expect((await w.store.loadSubjects()).subjects).toEqual([]);
    expect((await w.store.loadSubjects()).ids).toEqual([]);
    expect(w.cw.privacy.find({ clientKey: A.key })).toBeNull();
    expect(w.cw.privacy.find({ accountId: B.account })).toBeNull();
    w.seat('R5', 'p1', A);
    await w.cw.flush();
    const back = w.cw.rooms.subjectAt('R5', 'p1');
    expect(back).not.toBeNull();
    expect(back).not.toBe(w.aId);
  });

  it('a person seen again (a touch) keeps their rows while an untouched player of the same age goes', async () => {
    const w = await privacyWorld();
    w.clock.t = NOW + 300 * DAY;
    w.seat('R6', 'p1', A);
    await w.cw.flush();
    w.clock.t = NOW + 401 * DAY;
    const result = await w.cw.purge();
    expect(result.idleSubjects).toBe(1);
    expect(w.cw.privacy.find({ clientKey: A.key })).toBe(w.aId);
    expect(w.cw.privacy.find({ clientKey: B.key })).toBeNull();
  });

  it('a person with a record keeps the rows: a report names both players, a mute names one', async () => {
    const w = await privacyWorld();
    w.cw.chat.accept('R1', 'p1', 'a line of alpha');
    const filed = await w.cw.reports.submit({ roomId: 'R1', reporterSeat: 'p2', targetSeat: 'p1', reason: 'harassment', note: 'x' });
    expect(filed.ok).toBe(true);
    w.clock.t = NOW + 401 * DAY;
    // the report is 401 days old: reports go on 90 days, so first take that clock out of the way
    const result = await w.cw.purge({ reportsMs: 1000 * DAY, badFaithMs: 1000 * DAY });
    expect(result.idleSubjects).toBe(0);
    expect(w.cw.privacy.find({ clientKey: A.key })).toBe(w.aId);
    expect(w.cw.privacy.find({ clientKey: B.key })).toBe(w.bId);
    // once the report ages out the same pass takes them: the other tables go first
    const later = await w.cw.purge();
    expect(later.reports).toBe(1);
    expect(later.idleSubjects).toBe(2);
  });

  it('the kit option retention.subjectsMs sets the window, and the result is in PurgeResult', async () => {
    const w = await privacyWorld({ retention: { subjectsMs: 100 * DAY } });
    w.clock.t = NOW + 101 * DAY;
    const result = await w.cw.purge();
    expect(result.idleSubjects).toBe(2);
    await w.cw.close();
  });

  it('a one-off purge(policy) can override the window, and the floor applies', async () => {
    const w = await privacyWorld();
    w.clock.t = NOW + 120 * DAY;
    await expect(w.cw.purge({ subjectsMs: DAY })).rejects.toThrow(ProfileError);
    expect((await w.cw.purge()).idleSubjects).toBe(0);
    expect((await w.cw.purge({ subjectsMs: 100 * DAY })).idleSubjects).toBe(2);
  });
});
