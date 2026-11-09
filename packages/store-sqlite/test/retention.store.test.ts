import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  applySanction,
  purge,
  revokeSanction,
  SubjectIndex,
  type SanctionKind,
  type StoredReport,
  type StrikeRow,
} from '@chatwarden/core';
import { openStore } from '../src/index.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function env() {
  const db = new DatabaseSync(':memory:');
  const store = openStore({ db });
  const subjects = new SubjectIndex(store, { now: () => NOW }, { logger: { warn() {} } });
  return { db, store, subjects };
}

const count = (db: DatabaseSync, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

const report = (id: string, createdAt: number): StoredReport => ({
  id,
  createdAt,
  roomId: `ROOM-${id}`,
  tags: {},
  reporterSubject: `s_rep_${id}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: `s_tgt_${id}`,
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
});

const strike = (id: string, at: number): StrikeRow => ({ id, at, subject: 's_x', roomId: 'R', termId: 'zorbak', rawLine: 'x' });

async function sanction(
  e: ReturnType<typeof env>,
  subject: string,
  at: number,
  durationMs: number | null,
  kind: SanctionKind = 'ban',
  includeIp = false,
) {
  return applySanction(
    e.store,
    e.subjects,
    { kind, subject, includeIp, durationMs, reason: 'r', actor: 'mod', source: 'moderator', automated: false, rule: 1 },
    at,
  );
}

describe('purge against SQLite', () => {
  it('deletes old reports, strikes and mutes at the exact cutoffs', async () => {
    const { db, store } = env();
    store.insertReport(report('old', NOW - 90 * DAY - 1));
    store.insertReport(report('edge', NOW - 90 * DAY));
    store.insertStrike(strike('old', NOW - 30 * DAY - 1));
    store.insertStrike(strike('edge', NOW - 30 * DAY));
    store.upsertMute({ viewer: 'v', target: 'old', createdAt: NOW - 180 * DAY - 1 });
    store.upsertMute({ viewer: 'v', target: 'edge', createdAt: NOW - 180 * DAY });
    expect(await purge(store, NOW)).toEqual({ reports: 1, sanctions: 0, strikes: 1, mutes: 1 });
    expect(db.prepare('SELECT id FROM kit_reports').all().map((r) => r.id)).toEqual(['edge']);
    expect(db.prepare('SELECT id FROM kit_strikes').all().map((r) => r.id)).toEqual(['edge']);
    expect(db.prepare('SELECT target_id FROM kit_mutes').all().map((r) => r.target_id)).toEqual(['edge']);
  });

  it('ended sanction kept until +90 d; permanent kept until revoked +90 d', async () => {
    const e = env();
    const s = e.subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: null });
    if (s === null) throw new Error('expected a subject');
    await sanction(e, s, NOW - 100 * DAY, 10 * DAY); // ended exactly 90 d ago
    const perm = await sanction(e, s, NOW - 500 * DAY, null);
    expect((await purge(e.store, NOW)).sanctions).toBe(0);
    expect(count(e.db, 'kit_sanctions')).toBe(2);

    expect((await purge(e.store, NOW + 1)).sanctions).toBe(1); // the ended one
    expect(count(e.db, 'kit_sanctions')).toBe(1);
    expect((await purge(e.store, NOW + 10_000 * DAY)).sanctions).toBe(0); // permanent, unrevoked: kept forever

    await revokeSanction(e.store, perm.groupId, 'mod', NOW, 'appeal');
    expect((await purge(e.store, NOW + 90 * DAY)).sanctions).toBe(0);
    expect((await purge(e.store, NOW + 90 * DAY + 1)).sanctions).toBe(1);
    expect(count(e.db, 'kit_sanctions')).toBe(0);
  });

  it('purges the IP row of a long ban on its own schedule and frees nothing it should keep', async () => {
    const e = env();
    const s = e.subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'iph' });
    if (s === null) throw new Error('expected a subject');
    await sanction(e, s, NOW - 100 * DAY, null, 'ban', true);
    expect((await purge(e.store, NOW)).sanctions).toBe(1);
    expect(e.db.prepare('SELECT target_type FROM kit_sanctions').all().map((r) => r.target_type)).toEqual(['subject']);
  });

  it('never touches subjects, terms or the audit trail', async () => {
    const e = env();
    e.subjects.resolve({ clientKey: 'k1', accountId: 'a1', ipHash: 'iph' });
    await e.subjects.flush();
    e.store.insertTerm({
      id: 't1', term: 'zorbak', language: 'xx', active: true, note: null,
      addedBy: 'mod', addedAt: NOW - 1000 * DAY, updatedBy: null, updatedAt: null,
    });
    e.store.writeAudit({
      at: NOW - 1000 * DAY, actor: 'mod', action: 'add', subjectType: 'term', subjectRef: 't1',
      beforeJson: null, afterJson: '{}',
    });
    e.store.insertReport(report('old', NOW - 1000 * DAY));
    const before = ['kit_subjects', 'kit_subject_ids', 'kit_terms', 'kit_audit'].map((t) => count(e.db, t));
    await purge(e.store, NOW + 1000 * DAY, { reportsMs: 0, strikesMs: 0, sanctionAfterEndMs: 0 });
    expect(['kit_subjects', 'kit_subject_ids', 'kit_terms', 'kit_audit'].map((t) => count(e.db, t))).toEqual(before);
    expect(before.every((n) => n > 0)).toBe(true);
    expect(count(e.db, 'kit_reports')).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a non-finite now (%s) and deletes nothing',
    async (bad) => {
      const { db, store } = env();
      store.insertReport(report('old', NOW - 1000 * DAY));
      store.insertStrike(strike('old', NOW - 1000 * DAY));
      store.upsertMute({ viewer: 'v', target: 'old', createdAt: NOW - 1000 * DAY });
      await expect(purge(store, bad)).rejects.toThrow('purge: invalid now');
      expect(count(db, 'kit_reports')).toBe(1);
      expect(count(db, 'kit_strikes')).toBe(1);
      expect(count(db, 'kit_mutes')).toBe(1);
    },
  );

  it('is atomic: a failing table rolls the others back', async () => {
    const { db, store } = env();
    store.insertReport(report('old', NOW - 100 * DAY));
    store.insertStrike(strike('old', NOW - 40 * DAY));
    store.purgeMutes = () => {
      throw new Error('disk full');
    };
    await expect(purge(store, NOW)).rejects.toThrow('disk full');
    expect(count(db, 'kit_reports')).toBe(1);
    expect(count(db, 'kit_strikes')).toBe(1);
  });
});
