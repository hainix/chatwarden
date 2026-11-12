import { describe, expect, it } from 'vitest';
import { checkRetentionFloors, purge, RETENTION_DEFAULTS } from '../src/retention.js';
import { ProfileError } from '../src/profile.js';
import { applySanction, revokeSanction } from '../src/sanctions.js';
import { SubjectIndex } from '../src/subjects.js';
import type { AppealRow, BlockedNameRow, NoticeRow, SanctionKind, SignalRow, Store, StoredReport, StrikeRow, SubjectId } from '../src/types.js';
import { MemoryStore, withMemoryAppeals, withMemoryNames, withMemorySignals } from '@chatwarden/store-memory';
import { markReportBadFaith } from './markBadFaith.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

function setup() {
  const store = withMemorySignals(new MemoryStore());
  const clock = { now: () => NOW };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const subject = (key: string): SubjectId => {
    const s = subjects.resolve({ clientKey: key, accountId: null, ipHash: null });
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  const sanction = (
    s: SubjectId,
    at: number,
    durationMs: number | null,
    kind: SanctionKind = 'ban',
    includeIp = false,
  ) =>
    applySanction(
      store,
      subjects,
      { kind, subject: s, includeIp, durationMs, reason: 'r', actor: 'mod', source: 'moderator', automated: false, rule: 1 },
      at,
    );
  return { store, subjects, subject, sanction };
}

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

const strike = (id: string, at: number): StrikeRow => ({
  id,
  at,
  subject: 's_x',
  roomId: 'R',
  termId: 'zorbak',
  rawLine: 'a line',
});

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id).sort();

describe('defaults', () => {
  it('are 90 d of reports, 90 d after a sanction ends, 30 d of strikes, 90 d of notices, 30 d of bad-faith marks, 365 d of audit entries, 365 d of AI outcomes, 180 d of AI example text', () => {
    expect(RETENTION_DEFAULTS).toEqual({
      reportsMs: 90 * DAY,
      sanctionAfterEndMs: 90 * DAY,
      strikesMs: 30 * DAY,
      noticesMs: 90 * DAY,
      badFaithMs: 30 * DAY,
      auditMs: 365 * DAY,
      aiOutcomesMs: 365 * DAY,
      aiExamplesMs: 180 * DAY,
      signalsMs: 90 * DAY,
      appealStatementsMs: 90 * DAY,
      appealsMs: 365 * DAY,
      blockedNamesMs: 30 * DAY,
    });
  });
});

describe('purge: reports', () => {
  /** A report closed as bad faith at `actionedAt`. */
  const markBad = (store: MemoryStore, id: string, createdAt: number, actionedAt: number) => {
    store.insertReport(report(id, createdAt));
    expect(store.closeReport(id, 'dismissed', true, 'mod', actionedAt, 'n')).toBe(true);
  };

  it('keeps a live bad-faith mark (actioned within 30 d) even past the 90 d cutoff', async () => {
    const { store } = setup();
    markBad(store, 'live', NOW - 100 * DAY, NOW - 10 * DAY);
    const res = await purge(store, NOW);
    expect(res.reports).toBe(0);
    expect(ids(store.rawReports())).toEqual(['live']);
  });

  it('a bad-faith mark exactly 30 d old is kept; one millisecond older goes', async () => {
    const { store } = setup();
    markBad(store, 'edge', NOW - 100 * DAY, NOW - 30 * DAY);
    markBad(store, 'past', NOW - 100 * DAY, NOW - 30 * DAY - 1);
    const res = await purge(store, NOW);
    expect(res.reports).toBe(1);
    expect(ids(store.rawReports())).toEqual(['edge']);
  });

  it('only bad_faith = 1 is spared: a plain dismissal and an actioned report of the same age go', async () => {
    const { store } = setup();
    store.insertReport(report('plain', NOW - 100 * DAY));
    store.closeReport('plain', 'dismissed', false, 'mod', NOW - 5 * DAY, 'n');
    store.insertReport(report('acted', NOW - 100 * DAY));
    store.closeReport('acted', 'actioned', false, 'mod', NOW - 5 * DAY, 'n');
    markBad(store, 'bad', NOW - 100 * DAY, NOW - 5 * DAY);
    expect((await purge(store, NOW)).reports).toBe(2);
    expect(ids(store.rawReports())).toEqual(['bad']);
  });

  it('an open report is never spared, and a mark with no actioned_at is not live', async () => {
    const { store } = setup();
    store.insertReport(report('open', NOW - 100 * DAY));
    store.insertReport(report('never', NOW - 100 * DAY));
    markReportBadFaith(store, 'never', null);
    expect((await purge(store, NOW)).reports).toBe(2);
  });

  it('badFaithMs moves the window; 0 keeps only a mark actioned at or after now', async () => {
    const { store } = setup();
    markBad(store, 'a', NOW - 100 * DAY, NOW - 40 * DAY);
    expect((await purge(store, NOW, { badFaithMs: 45 * DAY })).reports).toBe(0);
    expect((await purge(store, NOW, { badFaithMs: 39 * DAY })).reports).toBe(1);
  });

  it('a fresh-enough report is kept whatever its bad-faith state', async () => {
    const { store } = setup();
    markBad(store, 'new', NOW - 10 * DAY, NOW - 100 * DAY);
    expect((await purge(store, NOW)).reports).toBe(0);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid badFaithMs (%s)', async (bad) => {
    const { store } = setup();
    store.insertReport(report('old', NOW - 1000 * DAY));
    await expect(purge(store, NOW, { badFaithMs: bad })).rejects.toThrow('purge: invalid badFaithMs');
    expect(store.rawReports()).toHaveLength(1);
  });

  it('deletes the recorded decision of a purged report and keeps the one of a spared report', async () => {
    const { store } = setup();
    store.insertReport(report('gone', NOW - 100 * DAY));
    store.insertReport(report('kept', NOW - 100 * DAY));
    store.closeReport('kept', 'dismissed', true, 'mod', NOW - DAY, 'n');
    store.insertDecision('k-gone', 'gone', NOW - 100 * DAY, '{}');
    store.insertDecision('k-kept', 'kept', NOW - DAY, '{}');
    await purge(store, NOW);
    expect(store.findDecision('k-gone')).toBeNull();
    expect(store.findDecision('k-kept')).not.toBeNull();
  });

  it('old report purged, recent kept', async () => {
    const { store } = setup();
    store.insertReport(report('old', NOW - 90 * DAY - 1));
    store.insertReport(report('new', NOW - 89 * DAY));
    const res = await purge(store, NOW);
    expect(res.reports).toBe(1);
    expect(ids(store.rawReports())).toEqual(['new']);
  });

  it('a report exactly 90 d old is kept; one millisecond older goes', async () => {
    const { store } = setup();
    store.insertReport(report('edge', NOW - 90 * DAY));
    store.insertReport(report('past', NOW - 90 * DAY - 1));
    await purge(store, NOW);
    expect(ids(store.rawReports())).toEqual(['edge']);
  });

  it('purges reports whatever their status', async () => {
    const { store } = setup();
    store.insertReport(report('a', NOW - 100 * DAY));
    store.insertReport(report('b', NOW - 100 * DAY));
    store.closeReport('b', 'actioned', false, 'mod', NOW - 99 * DAY, 'n');
    expect((await purge(store, NOW)).reports).toBe(2);
    expect(store.rawReports()).toEqual([]);
  });
});

describe('purge: sanctions', () => {
  it('ended sanction kept until +90 d, then purged', async () => {
    const t = setup();
    const s = t.subject('k1');
    await t.sanction(s, NOW - 100 * DAY, 10 * DAY); // ends at NOW - 90 d exactly
    expect((await purge(t.store, NOW)).sanctions).toBe(0);
    expect(t.store.rawSanctions()).toHaveLength(1);
    expect((await purge(t.store, NOW + 1)).sanctions).toBe(1);
    expect(t.store.rawSanctions()).toEqual([]);
  });

  it('a recently ended or still running timed sanction is kept', async () => {
    const t = setup();
    const s = t.subject('k1');
    await t.sanction(s, NOW - 40 * DAY, 10 * DAY); // ended 30 d ago
    await t.sanction(s, NOW - DAY, 30 * DAY); // running
    expect((await purge(t.store, NOW)).sanctions).toBe(0);
    expect(t.store.rawSanctions()).toHaveLength(2);
  });

  it('permanent kept until revoked +90 d', async () => {
    const t = setup();
    const s = t.subject('k1');
    const { groupId } = await t.sanction(s, NOW - 500 * DAY, null);
    // Never purged while unrevoked, however old.
    expect((await purge(t.store, NOW)).sanctions).toBe(0);
    expect(t.store.rawSanctions()).toHaveLength(1);
    // Revoked 89 d ago: kept.
    await revokeSanction(t.store, groupId, 'mod', NOW - 89 * DAY, 'appeal');
    expect((await purge(t.store, NOW)).sanctions).toBe(0);
    expect(t.store.rawSanctions()).toHaveLength(1);
    // Exactly 90 d after the revoke: kept; one ms later: purged.
    expect((await purge(t.store, NOW - 89 * DAY + 90 * DAY)).sanctions).toBe(0);
    expect((await purge(t.store, NOW - 89 * DAY + 90 * DAY + 1)).sanctions).toBe(1);
    expect(t.store.rawSanctions()).toEqual([]);
  });

  it('an unrevoked permanent sanction survives any amount of time', async () => {
    const t = setup();
    await t.sanction(t.subject('k1'), NOW, null);
    expect((await purge(t.store, NOW + 10_000 * DAY)).sanctions).toBe(0);
    expect(t.store.rawSanctions()).toHaveLength(1);
  });

  it('a revoked timed sanction goes 90 d after the revoke even if it has not ended', async () => {
    const t = setup();
    const { groupId } = await t.sanction(t.subject('k1'), NOW - 200 * DAY, 365 * DAY);
    await revokeSanction(t.store, groupId, 'mod', NOW - 91 * DAY, 'oops');
    expect((await purge(t.store, NOW)).sanctions).toBe(1);
  });

  it('counts every row of a group (subject row and IP row) that qualifies', async () => {
    const t = setup();
    const s = t.subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'iphash' });
    if (s === null) throw new Error('expected a subject');
    // 7 d group with an IP row that ended after 24 h; at NOW both are long over.
    await t.sanction(s, NOW - 200 * DAY, 7 * DAY, 'ban', true);
    expect(t.store.rawSanctions()).toHaveLength(2);
    expect((await purge(t.store, NOW)).sanctions).toBe(2);
  });

  it('the IP row of a long ban goes on its own schedule, the subject row stays', async () => {
    const t = setup();
    const s = t.subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'iphash' });
    if (s === null) throw new Error('expected a subject');
    await t.sanction(s, NOW - 100 * DAY, null, 'ban', true); // IP row ended 99 d ago, subject row permanent
    expect((await purge(t.store, NOW)).sanctions).toBe(1);
    const left = t.store.rawSanctions();
    expect(left).toHaveLength(1);
    expect(left[0]?.targetType).toBe('subject');
  });

  it('a purged ref code can be allocated again; a live one cannot', async () => {
    const t = setup();
    const s = t.subject('k1');
    const old = await t.sanction(s, NOW - 200 * DAY, DAY);
    const live = await t.sanction(s, NOW, DAY);
    await purge(t.store, NOW);
    const codes = t.store.rawSanctions().map((r) => r.refCode);
    expect(codes).toEqual([live.refCode]);
    const reuse = { ...t.store.rawSanctions()[0], id: 'new', groupId: 'g-new', refCode: old.refCode };
    expect(t.store.insertSanctionGroup([reuse as never])).toBe(true);
    const clash = { ...reuse, id: 'new2', groupId: 'g-new2', refCode: live.refCode };
    expect(t.store.insertSanctionGroup([clash as never])).toBe(false);
  });
});

describe('purge: notes follow the warning rule (90 d after the start)', () => {
  it('a note started more than 90 d ago goes; at exactly 90 d, and newer, stays', async () => {
    const t = setup();
    await t.sanction(t.subject('k1'), NOW - 90 * DAY - 1, null, 'note');
    await t.sanction(t.subject('k2'), NOW - 90 * DAY, null, 'note');
    await t.sanction(t.subject('k3'), NOW - DAY, null, 'note');
    expect((await purge(t.store, NOW)).sanctions).toBe(1);
    expect(t.store.rawSanctions().map((r) => r.startsAt)).toEqual([NOW - 90 * DAY, NOW - DAY]);
  });

  it('a note is purged exactly like a warning of the same age', async () => {
    const t = setup();
    for (const kind of ['note', 'warning'] as const) {
      await t.sanction(t.subject(`${kind}-old`), NOW - 120 * DAY, null, kind);
      await t.sanction(t.subject(`${kind}-new`), NOW - 10 * DAY, null, kind);
    }
    expect((await purge(t.store, NOW)).sanctions).toBe(2);
    expect(t.store.rawSanctions().map((r) => [r.kind, r.startsAt])).toEqual([
      ['note', NOW - 10 * DAY],
      ['warning', NOW - 10 * DAY],
    ]);
  });

  it('a revoked note goes 90 d after the revoke', async () => {
    const t = setup();
    const { groupId } = await t.sanction(t.subject('k1'), NOW - 10 * DAY, null, 'note');
    await revokeSanction(t.store, groupId, 'mod', NOW - 91 * DAY, 'oops');
    expect((await purge(t.store, NOW)).sanctions).toBe(1);
  });

  it('a note whose rule gap is still open is kept', async () => {
    const t = setup();
    await applySanction(
      t.store,
      t.subjects,
      { kind: 'note', subject: t.subject('k1'), includeIp: false, durationMs: null, reason: 'r', actor: 'mod', source: 'moderator', automated: false, rule: 'uncovered', gapNote: 'gap' },
      NOW - 200 * DAY,
    );
    expect((await purge(t.store, NOW)).sanctions).toBe(0);
  });
});

describe('purge: sanctions with an open rule gap', () => {
  it('spares an old ended sanction whose gap is open, and purges it once the gap is closed', async () => {
    const { store, subjects, subject } = setup();
    const s = subject('k1');
    const gap = await applySanction(
      store,
      subjects,
      { kind: 'chat', subject: s, includeIp: false, durationMs: DAY, reason: 'r', actor: 'mod', source: 'moderator', automated: false, rule: 'uncovered', gapNote: 'no rule fits' },
      NOW - 200 * DAY,
    );
    expect((await purge(store, NOW)).sanctions).toBe(0);
    expect(store.rawSanctions()).toHaveLength(1);
    store.closeGap(gap.groupId, 'not_a_rule', null, 'mod', NOW);
    expect((await purge(store, NOW)).sanctions).toBe(1);
  });

  it('spares an open-gap sanction that was revoked long ago too; ruled and not_a_rule gaps are not spared', async () => {
    const e = setup();
    const s = e.subject('k1');
    const mk = (note: string | undefined) =>
      applySanction(
        e.store,
        e.subjects,
        { kind: 'warning', subject: s, includeIp: false, durationMs: null, reason: 'r', actor: 'mod', source: 'moderator', automated: false, rule: note === undefined ? 1 : 'uncovered', ...(note === undefined ? {} : { gapNote: note }) },
        NOW - 200 * DAY,
      );
    const open = await mk('gap');
    const ruled = await mk('gap2');
    await mk(undefined);
    await revokeSanction(e.store, open.groupId, 'mod', NOW - 150 * DAY, 'x');
    await revokeSanction(e.store, ruled.groupId, 'mod', NOW - 150 * DAY, 'x');
    e.store.closeGap(ruled.groupId, 'ruled', '9', 'mod', NOW - 140 * DAY);
    // The closed (ruled) gap and the plain warning (it ends where it starts, long ago) go; the open gap stays.
    expect((await purge(e.store, NOW)).sanctions).toBe(2);
    expect(e.store.rawSanctions().map((r) => r.gapStatus)).toEqual(['open']);
  });
});

describe('purge: strikes', () => {
  it('purges strikes older than 30 d and keeps the rest', async () => {
    const { store } = setup();
    store.insertStrike(strike('old', NOW - 30 * DAY - 1));
    store.insertStrike(strike('edge', NOW - 30 * DAY));
    store.insertStrike(strike('new', NOW - DAY));
    const res = await purge(store, NOW);
    expect(res.strikes).toBe(1);
    expect(ids(store.rawStrikes())).toEqual(['edge', 'new']);
  });
});

describe('purge: mutes', () => {
  it('purges mutes past the 180-day TTL (ruling R27) and keeps the rest', async () => {
    const { store } = setup();
    store.upsertMute({ viewer: 'v', target: 'old', createdAt: NOW - 180 * DAY - 1 });
    store.upsertMute({ viewer: 'v', target: 'edge', createdAt: NOW - 180 * DAY });
    store.upsertMute({ viewer: 'v', target: 'new', createdAt: NOW - DAY });
    const res = await purge(store, NOW);
    expect(res.mutes).toBe(1);
    expect(store.rawMutes().map((m) => m.target).sort()).toEqual(['edge', 'new']);
  });

  it('a refreshed mute (same pair muted again) is judged by its new time', async () => {
    const { store } = setup();
    store.upsertMute({ viewer: 'v', target: 't', createdAt: NOW - 400 * DAY });
    store.upsertMute({ viewer: 'v', target: 't', createdAt: NOW - DAY });
    expect((await purge(store, NOW)).mutes).toBe(0);
    expect(store.rawMutes()).toHaveLength(1);
  });
});

describe('purge: result, policy and scope', () => {
  it('reports the rows deleted per table', async () => {
    const t = setup();
    t.store.insertReport(report('r1', NOW - 100 * DAY));
    t.store.insertReport(report('r2', NOW - 100 * DAY));
    t.store.insertStrike(strike('s1', NOW - 40 * DAY));
    t.store.upsertMute({ viewer: 'v', target: 't', createdAt: NOW - 200 * DAY });
    await t.sanction(t.subject('k1'), NOW - 200 * DAY, DAY);
    expect(await purge(t.store, NOW)).toEqual({ reports: 2, sanctions: 1, strikes: 1, mutes: 1, notices: 0, audit: 0, webhookKeys: 0, aiReads: 0, aiOutcomes: 0, signals: 0, appeals: 0, appealStatements: 0, blockedNames: 0 });
  });

  it('on an empty store, or run twice, deletes nothing', async () => {
    const { store } = setup();
    expect(await purge(store, NOW)).toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 0, audit: 0, webhookKeys: 0, aiReads: 0, aiOutcomes: 0, signals: 0, appeals: 0, appealStatements: 0, blockedNames: 0 });
    store.insertReport(report('r1', NOW - 100 * DAY));
    await purge(store, NOW);
    expect(await purge(store, NOW)).toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 0, audit: 0, webhookKeys: 0, aiReads: 0, aiOutcomes: 0, signals: 0, appeals: 0, appealStatements: 0, blockedNames: 0 });
  });

  it('a custom policy overrides the defaults, field by field', async () => {
    const t = setup();
    t.store.insertReport(report('r1', NOW - 10 * DAY));
    t.store.insertStrike(strike('s1', NOW - 10 * DAY));
    await t.sanction(t.subject('k1'), NOW - 20 * DAY, DAY); // ended 19 d ago
    const res = await purge(t.store, NOW, { reportsMs: 5 * DAY });
    expect(res).toEqual({ reports: 1, sanctions: 0, strikes: 0, mutes: 0, notices: 0, audit: 0, webhookKeys: 0, aiReads: 0, aiOutcomes: 0, signals: 0, appeals: 0, appealStatements: 0, blockedNames: 0 });
    const res2 = await purge(t.store, NOW, { strikesMs: 5 * DAY, sanctionAfterEndMs: 5 * DAY });
    expect(res2).toEqual({ reports: 0, sanctions: 1, strikes: 1, mutes: 0, notices: 0, audit: 0, webhookKeys: 0, aiReads: 0, aiOutcomes: 0, signals: 0, appeals: 0, appealStatements: 0, blockedNames: 0 });
  });

  it('a zero window purges everything already past', async () => {
    const t = setup();
    t.store.insertReport(report('r1', NOW - 1));
    t.store.insertReport(report('r2', NOW));
    expect((await purge(t.store, NOW, { reportsMs: 0 })).reports).toBe(1);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid window %s and deletes nothing', async (bad) => {
    const t = setup();
    t.store.insertReport(report('r1', NOW - 1000 * DAY));
    await expect(purge(t.store, NOW, { reportsMs: bad })).rejects.toThrow(/purge/);
    await expect(purge(t.store, NOW, { strikesMs: bad })).rejects.toThrow(/purge/);
    await expect(purge(t.store, NOW, { sanctionAfterEndMs: bad })).rejects.toThrow(/purge/);
    expect(t.store.rawReports()).toHaveLength(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a non-finite now (%s) before any write and deletes nothing',
    async (bad) => {
      const t = setup();
      t.store.insertReport(report('r1', NOW - 1000 * DAY));
      t.store.insertStrike(strike('s1', NOW - 1000 * DAY));
      await expect(purge(t.store, bad)).rejects.toThrow('purge: invalid now');
      expect(t.store.rawReports()).toHaveLength(1);
      expect(t.store.loadStrikes(0)).toHaveLength(1);
    },
  );

  it('a finite now (zero, negative) is accepted (control)', async () => {
    const t = setup();
    await expect(purge(t.store, 0)).resolves.toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 0, audit: 0, webhookKeys: 0, aiReads: 0, aiOutcomes: 0, signals: 0, appeals: 0, appealStatements: 0, blockedNames: 0 });
    await expect(purge(t.store, -5)).resolves.toBeDefined();
  });

  it('never touches subjects (or their identifiers)', async () => {
    const t = setup();
    t.subject('k1');
    await t.subjects.flush();
    const before = await t.store.loadSubjects();
    t.store.insertReport(report('r1', NOW - 1000 * DAY));
    await purge(t.store, NOW);
    expect(await t.store.loadSubjects()).toEqual(before);
    expect(before.subjects).toHaveLength(1);
  });

  it('is atomic: a failure part-way leaves every table as it was', async () => {
    const t = setup();
    t.store.insertReport(report('r1', NOW - 100 * DAY));
    t.store.insertStrike(strike('s1', NOW - 40 * DAY));
    t.store.upsertMute({ viewer: 'v', target: 't', createdAt: NOW - 200 * DAY });
    await t.sanction(t.subject('k1'), NOW - 200 * DAY, DAY);
    t.store.purgeMutes = () => {
      throw new Error('disk full');
    };
    await expect(purge(t.store, NOW)).rejects.toThrow('disk full');
    expect(t.store.rawReports()).toHaveLength(1);
    expect(t.store.rawStrikes()).toHaveLength(1);
    expect(t.store.rawMutes()).toHaveLength(1);
    expect(t.store.rawSanctions()).toHaveLength(1);
  });

  it('uses the time it is given, not the wall clock', async () => {
    const { store } = setup();
    store.insertReport(report('r1', 1_000));
    expect((await purge(store, 1_000 + 90 * DAY)).reports).toBe(0);
    expect((await purge(store, 1_000 + 90 * DAY + 1)).reports).toBe(1);
  });
});

const notice = (id: string, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id,
  subject: 's_x',
  groupId: `g-${id}`,
  kind: 'chat',
  rule: '2',
  until: NOW + DAY,
  refCode: 'M-AAAAA',
  excerpt: [],
  createdAt: NOW - DAY,
  ackedAt: null,
  withdrawnAt: null,
  ...over,
});

describe('purge: notices', () => {
  const left = (store: MemoryStore): string[] => store.rawNotices().map((n) => n.id).sort();

  it('deletes an acked warning created before the cutoff, keeps the edge and newer', async () => {
    const { store } = setup();
    store.insertNotice(notice('old', { kind: 'warning', until: null, createdAt: NOW - 90 * DAY - 1, ackedAt: NOW - 100 * DAY }));
    store.insertNotice(notice('edge', { kind: 'warning', until: null, createdAt: NOW - 90 * DAY, ackedAt: NOW - 80 * DAY }));
    store.insertNotice(notice('new', { kind: 'warning', until: null, createdAt: NOW - DAY, ackedAt: NOW }));
    const res = await purge(store, NOW);
    expect(res.notices).toBe(1);
    expect(left(store)).toEqual(['edge', 'new']);
  });

  it('deletes a withdrawn notice the same way', async () => {
    const { store } = setup();
    store.insertNotice(notice('old', { createdAt: NOW - 91 * DAY, withdrawnAt: NOW - 91 * DAY, until: null }));
    store.insertNotice(notice('new', { createdAt: NOW - 5 * DAY, withdrawnAt: NOW - 4 * DAY }));
    expect((await purge(store, NOW)).notices).toBe(1);
    expect(left(store)).toEqual(['new']);
  });

  it('an acked permanent ban older than 90 d survives while it applies; an acked warning of that age does not', async () => {
    const { store } = setup();
    store.insertNotice(notice('ban', { kind: 'ban', until: null, createdAt: NOW - 400 * DAY, ackedAt: NOW - 399 * DAY }));
    store.insertNotice(notice('warn', { kind: 'warning', until: null, createdAt: NOW - 400 * DAY, ackedAt: NOW - 399 * DAY }));
    store.insertNotice(notice('outcome', { kind: 'report_outcome', groupId: null, rule: null, until: null, refCode: null, createdAt: NOW - 400 * DAY, ackedAt: NOW - 399 * DAY }));
    expect((await purge(store, NOW)).notices).toBe(2);
    expect(left(store)).toEqual(['ban']);
  });

  it('an acked running sanction (chat, area, ban) older than 90 d is kept; withdrawing it makes it purgeable', async () => {
    const { store } = setup();
    for (const kind of ['chat', 'area', 'ban'] as const) {
      store.insertNotice(notice(kind, { kind, until: NOW + 30 * DAY, createdAt: NOW - 100 * DAY, ackedAt: NOW - 99 * DAY }));
    }
    expect((await purge(store, NOW)).notices).toBe(0);
    store.withdrawNoticeGroup('g-chat', NOW);
    expect((await purge(store, NOW)).notices).toBe(1);
    expect(left(store)).toEqual(['area', 'ban']);
  });

  it('an unacked warning older than 90 d is kept until it is acked or withdrawn', async () => {
    const { store } = setup();
    store.insertNotice(notice('w1', { kind: 'warning', until: null, createdAt: NOW - 200 * DAY }));
    store.insertNotice(notice('w2', { kind: 'warning', until: null, createdAt: NOW - 200 * DAY }));
    expect((await purge(store, NOW)).notices).toBe(0);
    store.ackNotice('w1', NOW);
    store.withdrawNoticeGroup('g-w2', NOW);
    expect((await purge(store, NOW)).notices).toBe(2);
    expect(left(store)).toEqual([]);
  });

  it('an acked report outcome older than 90 d is purged; an unacked one is kept', async () => {
    const { store } = setup();
    const o = { kind: 'report_outcome', groupId: null, rule: null, until: null, refCode: null, createdAt: NOW - 100 * DAY } as const;
    store.insertNotice(notice('seen', { ...o, ackedAt: NOW - 99 * DAY }));
    store.insertNotice(notice('unseen', { ...o }));
    expect((await purge(store, NOW)).notices).toBe(1);
    expect(left(store)).toEqual(['unseen']);
  });

  it('keeps an UNACKED, unwithdrawn permanent notice however old', async () => {
    const { store } = setup();
    store.insertNotice(notice('perm', { createdAt: NOW - 1000 * DAY, until: null }));
    store.insertNotice(notice('warn', { kind: 'warning', createdAt: NOW - 1000 * DAY, until: null }));
    expect((await purge(store, NOW + 5000 * DAY)).notices).toBe(0);
    expect(left(store)).toEqual(['perm', 'warn']);
  });

  it('deletes any notice whose end is more than 90 days past, acked or not', async () => {
    const { store } = setup();
    store.insertNotice(notice('unacked-old-end', { createdAt: NOW - 200 * DAY, until: NOW - 90 * DAY - 1 }));
    store.insertNotice(notice('acked-old-end', { createdAt: NOW - 20 * DAY, until: NOW - 90 * DAY - 1, ackedAt: NOW - 10 * DAY }));
    store.insertNotice(notice('end-edge', { createdAt: NOW - 200 * DAY, until: NOW - 90 * DAY }));
    store.insertNotice(notice('running', { createdAt: NOW - 200 * DAY, until: NOW + DAY }));
    expect((await purge(store, NOW)).notices).toBe(2);
    expect(left(store)).toEqual(['end-edge', 'running']);
  });

  it('keeps an unacked temporary notice created long ago while it is still running', async () => {
    const { store } = setup();
    store.insertNotice(notice('x', { createdAt: NOW - 120 * DAY, until: NOW + 10 * DAY }));
    expect((await purge(store, NOW)).notices).toBe(0);
  });

  it('noticesMs overrides the window', async () => {
    const { store } = setup();
    store.insertNotice(notice('a', { kind: 'warning', until: null, createdAt: NOW - 10 * DAY, ackedAt: NOW - 9 * DAY }));
    expect((await purge(store, NOW)).notices).toBe(0);
    expect((await purge(store, NOW, { noticesMs: 5 * DAY })).notices).toBe(1);
  });

  it('rejects an invalid noticesMs and deletes nothing', async () => {
    const { store } = setup();
    store.insertNotice(notice('a', { kind: 'warning', until: null, createdAt: NOW - 1000 * DAY, ackedAt: NOW - 999 * DAY }));
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(purge(store, NOW, { noticesMs: bad })).rejects.toThrow(/purge/);
    }
    expect(left(store)).toEqual(['a']);
  });

  it('is part of the one transaction: a later failure restores the notices', async () => {
    const { store } = setup();
    store.insertNotice(notice('old', { kind: 'warning', until: null, createdAt: NOW - 200 * DAY, ackedAt: NOW - 199 * DAY }));
    store.purgeMutes = () => {
      throw new Error('disk full');
    };
    await expect(purge(store, NOW)).rejects.toThrow('disk full');
    expect(left(store)).toEqual(['old']);
  });

  it('purgeNotices itself journals an undo', () => {
    const { store } = setup();
    store.insertNotice(notice('old', { kind: 'warning', until: null, createdAt: NOW - 200 * DAY, ackedAt: NOW - 199 * DAY }));
    expect(() =>
      store.transaction(() => {
        expect(store.purgeNotices(NOW - 90 * DAY)).toBe(1);
        expect(left(store)).toEqual([]);
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(left(store)).toEqual(['old']);
  });
});

describe('signals retention', () => {
  const sig = (id: string, at: number, kind = 'muted_by_player'): SignalRow => ({
    id,
    kind,
    subject: 's_x',
    sourceKey: `d:${id}`,
    bySubject: null,
    roomId: null,
    at,
    weight: 1,
    capBucket: Math.floor(at / DAY),
  });
  const kept = (store: ReturnType<typeof withMemorySignals<MemoryStore>>): string[] =>
    store
      .listSignalSources(['s_x'], 0)
      .map((r) => r.sourceKey.slice(2))
      .sort();

  it('the default is 90 days', () => {
    expect(RETENTION_DEFAULTS.signalsMs).toBe(90 * DAY);
  });

  it('14 days is accepted, 13 days is refused naming retention.signalsMs', () => {
    expect(() => checkRetentionFloors({ signalsMs: 14 * DAY }, 30 * DAY)).not.toThrow();
    expect(() => checkRetentionFloors({ signalsMs: 400 * DAY }, 30 * DAY)).not.toThrow();
    for (const bad of [13 * DAY, 14 * DAY - 1, 0, -1]) {
      let caught: unknown;
      try {
        checkRetentionFloors({ signalsMs: bad }, 30 * DAY);
      } catch (err) {
        caught = err;
      }
      expect(caught, String(bad)).toBeInstanceOf(ProfileError);
      expect((caught as ProfileError).path).toBe('retention.signalsMs');
      expect((caught as ProfileError).message).toContain('two weeks');
    }
  });

  it('NaN, Infinity and a non-number are refused naming retention.signalsMs', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '90', null, true]) {
      let caught: unknown;
      try {
        checkRetentionFloors({ signalsMs: bad as never }, 30 * DAY);
      } catch (err) {
        caught = err;
      }
      expect((caught as ProfileError | undefined)?.path, String(bad)).toBe('retention.signalsMs');
    }
  });

  it('a policy without signalsMs is as valid as before', () => {
    expect(() => checkRetentionFloors({}, 30 * DAY)).not.toThrow();
    expect(() => checkRetentionFloors({ reportsMs: 1 }, 30 * DAY)).not.toThrow();
  });

  it('purge deletes rows older than the default and reports how many', async () => {
    const { store } = setup();
    store.insertSignal(sig('old', NOW - 91 * DAY));
    store.insertSignal(sig('edge', NOW - 90 * DAY));
    store.insertSignal(sig('new', NOW - 1 * DAY));
    const res = await purge(store, NOW);
    expect(res.signals).toBe(1);
    expect(kept(store)).toEqual(['edge', 'new']);
  });

  it('the cutoff is strict: a row exactly signalsMs old is kept, one millisecond older goes', async () => {
    const { store } = setup();
    store.insertSignal(sig('exact', NOW - 20 * DAY));
    store.insertSignal(sig('older', NOW - 20 * DAY - 1));
    const res = await purge(store, NOW, { signalsMs: 20 * DAY });
    expect(res.signals).toBe(1);
    expect(kept(store)).toEqual(['exact']);
  });

  it('purge deletes flood_triggered rows with the same field', async () => {
    const { store } = setup();
    store.insertSignal(sig('f-old', NOW - 30 * DAY, 'flood_triggered'));
    store.insertSignal(sig('f-new', NOW - 5 * DAY, 'flood_triggered'));
    store.insertSignal(sig('m-old', NOW - 30 * DAY));
    const res = await purge(store, NOW, { signalsMs: 14 * DAY });
    expect(res.signals).toBe(2);
    expect(kept(store)).toEqual(['f-new']);
  });

  it('an invalid signalsMs makes purge throw and delete nothing', async () => {
    const { store } = setup();
    store.insertSignal(sig('a', NOW - 500 * DAY));
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) await expect(purge(store, NOW, { signalsMs: bad })).rejects.toThrow(/purge/);
    expect(kept(store)).toEqual(['a']);
  });

  it('a store without the method purges the rest and reports 0 signals', async () => {
    const { store } = setup();
    store.insertStrike(strike('old', NOW - 60 * DAY));
    Object.defineProperty(store, 'purgeSignals', { value: undefined });
    const res = await purge(store, NOW);
    expect(res.signals).toBe(0);
    expect(res.strikes).toBe(1);
  });

  it('is part of the one transaction: a later failure restores the signals', async () => {
    const { store } = setup();
    store.insertSignal(sig('old', NOW - 200 * DAY));
    store.purgeMutes = () => {
      throw new Error('disk full');
    };
    await expect(purge(store, NOW)).rejects.toThrow('disk full');
    expect(kept(store)).toEqual(['old']);
  });
});

describe('appeals and blocked-name retention', () => {
  function appealsSetup() {
    const base = setup();
    const store = withMemoryNames(withMemoryAppeals(base.store));
    return { ...base, store };
  }
  const appeal = (id: string, groupId: string, over: Partial<AppealRow> = {}): AppealRow => ({
    id,
    subject: 's_x',
    groupId,
    noticeId: `n-${id}`,
    reportId: null,
    rule: '2',
    kind: 'chat',
    statement: `statement ${id}`,
    status: 'open',
    createdAt: NOW - 500 * DAY,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    replacementGroupId: null,
    ...over,
  });
  const decide = (store: { decideAppeal: NonNullable<Store['decideAppeal']> }, id: string, at: number): void => {
    expect(store.decideAppeal(id, { status: 'upheld', at, by: 'bea', reason: 'r', replacementGroupId: null })).toBe(true);
  };
  const blocked = (id: string, at: number): BlockedNameRow => ({ id, subject: 's_x', name: `quissel-${id}`, termId: 'syn:quissel', reason: 'name_not_allowed', at });

  it('defaults are 90, 365 and 30 days', () => {
    expect(RETENTION_DEFAULTS.appealStatementsMs).toBe(90 * DAY);
    expect(RETENTION_DEFAULTS.appealsMs).toBe(365 * DAY);
    expect(RETENTION_DEFAULTS.blockedNamesMs).toBe(30 * DAY);
    // the older fields did not move
    expect(RETENTION_DEFAULTS.noticesMs).toBe(90 * DAY);
    expect(RETENTION_DEFAULTS.signalsMs).toBe(90 * DAY);
  });

  it('appealsMs below 90 days is refused naming retention.appealsMs; 90 days accepted', () => {
    expect(() => checkRetentionFloors({ appealsMs: 90 * DAY }, 30 * DAY)).not.toThrow();
    expect(() => checkRetentionFloors({ appealsMs: 1000 * DAY }, 30 * DAY)).not.toThrow();
    for (const bad of [89 * DAY, 90 * DAY - 1, 0, -1]) {
      let caught: unknown;
      try {
        checkRetentionFloors({ appealsMs: bad }, 30 * DAY);
      } catch (err) {
        caught = err;
      }
      expect(caught, String(bad)).toBeInstanceOf(ProfileError);
      expect((caught as ProfileError).path).toBe('retention.appealsMs');
      expect((caught as ProfileError).message).toContain('90 days');
    }
  });

  it('appealStatementsMs 0 and blockedNamesMs 0 accepted; NaN and Infinity refused (and a negative or a non-number)', () => {
    expect(() => checkRetentionFloors({ appealStatementsMs: 0 }, 30 * DAY)).not.toThrow();
    expect(() => checkRetentionFloors({ blockedNamesMs: 0 }, 30 * DAY)).not.toThrow();
    expect(() => checkRetentionFloors({ appealStatementsMs: 1, blockedNamesMs: 1 }, 30 * DAY)).not.toThrow();
    for (const field of ['appealStatementsMs', 'blockedNamesMs', 'appealsMs'] as const) {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '90', null, true]) {
        let caught: unknown;
        try {
          checkRetentionFloors({ [field]: bad } as never, 30 * DAY);
        } catch (err) {
          caught = err;
        }
        expect((caught as ProfileError | undefined)?.path, `${field} ${String(bad)}`).toBe(`retention.${field}`);
      }
    }
    for (const field of ['appealStatementsMs', 'blockedNamesMs'] as const) {
      expect(() => checkRetentionFloors({ [field]: -1 } as never, 30 * DAY), field).toThrow(ProfileError);
    }
  });

  it('a policy without the three fields is as valid as before', () => {
    expect(() => checkRetentionFloors({}, 30 * DAY)).not.toThrow();
    expect(() => checkRetentionFloors({ noticesMs: 90 * DAY, signalsMs: 14 * DAY }, 30 * DAY)).not.toThrow();
  });

  it('purge reports appeals, appealStatements and blockedNames', async () => {
    const { store } = appealsSetup();
    for (const [id, group] of [['old', 'g-old'], ['mid', 'g-mid'], ['new', 'g-new']] as const) store.insertAppeal(appeal(id, group));
    decide(store, 'old', NOW - 400 * DAY); // past both
    decide(store, 'mid', NOW - 100 * DAY); // past the statement clock only
    decide(store, 'new', NOW - 10 * DAY);
    store.insertBlockedName(blocked('b-old', NOW - 31 * DAY));
    store.insertBlockedName(blocked('b-new', NOW - 1 * DAY));
    const res = await purge(store, NOW);
    // The statements are cleared first, then the old rows go: the row that was deleted had its statement counted as cleared on the way.
    expect(res).toMatchObject({ appeals: 1, appealStatements: 2, blockedNames: 1 });
    expect(store.loadAppeal('old')).toBeNull();
    expect(store.loadAppeal('mid')).toMatchObject({ statement: null, status: 'upheld' });
    expect(store.loadAppeal('new')?.statement).toBe('statement new');
    expect(store.listBlockedNames(0, 10).map((r) => r.id)).toEqual(['b-new']);
  });

  it('the result of a purge always has the three fields, 0 when nothing is due', async () => {
    const { store } = appealsSetup();
    expect(await purge(store, NOW)).toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 0, audit: 0, webhookKeys: 0, aiReads: 0, aiOutcomes: 0, signals: 0, appeals: 0, appealStatements: 0, blockedNames: 0 });
  });

  it('strict cutoffs: a row exactly on the line is kept, one millisecond older goes', async () => {
    const { store } = appealsSetup();
    store.insertAppeal(appeal('edge', 'g-edge'));
    store.insertAppeal(appeal('older', 'g-older'));
    decide(store, 'edge', NOW - 365 * DAY);
    decide(store, 'older', NOW - 365 * DAY - 1);
    store.insertBlockedName(blocked('b-edge', NOW - 30 * DAY));
    store.insertBlockedName(blocked('b-older', NOW - 30 * DAY - 1));
    const res = await purge(store, NOW);
    expect(res.appeals).toBe(1);
    expect(res.blockedNames).toBe(1);
    expect(store.loadAppeal('edge')).not.toBeNull();
    expect(store.loadAppeal('older')).toBeNull();
    expect(store.listBlockedNames(0, 10).map((r) => r.id)).toEqual(['b-edge']);
    // the statement line is strict too
    const again = appealsSetup().store;
    again.insertAppeal(appeal('s-edge', 'g-1'));
    again.insertAppeal(appeal('s-older', 'g-2'));
    decide(again, 's-edge', NOW - 90 * DAY);
    decide(again, 's-older', NOW - 90 * DAY - 1);
    expect((await purge(again, NOW)).appealStatements).toBe(1);
    expect(again.loadAppeal('s-edge')?.statement).toBe('statement s-edge');
    expect(again.loadAppeal('s-older')?.statement).toBeNull();
  });

  it("an open appeal's statement survives any purge; a decided one is nulled after appealStatementsMs and the row stays until appealsMs", async () => {
    const { store } = appealsSetup();
    store.insertAppeal(appeal('open', 'g-open', { createdAt: NOW - 3000 * DAY }));
    store.insertAppeal(appeal('done', 'g-done'));
    decide(store, 'done', NOW - 120 * DAY);
    // the tightest windows: nothing a policy can say touches an open appeal
    const tight = await purge(store, NOW, { appealStatementsMs: 0, appealsMs: 90 * DAY, blockedNamesMs: 0 });
    expect(tight).toMatchObject({ appealStatements: 1, appeals: 1 });
    expect(store.loadAppeal('open')?.statement).toBe('statement open');
    expect(store.loadAppeal('done')).toBeNull();
    // the same, step by step with the defaults
    store.insertAppeal(appeal('done2', 'g-done2'));
    decide(store, 'done2', NOW - 100 * DAY);
    await purge(store, NOW);
    expect(store.loadAppeal('done2')).toMatchObject({ statement: null, status: 'upheld', decidedBy: 'bea' });
    await purge(store, NOW + 200 * DAY);
    expect(store.loadAppeal('done2')).not.toBeNull();
    await purge(store, NOW + 270 * DAY);
    expect(store.loadAppeal('done2')).toBeNull();
    expect(store.loadAppeal('open')?.statement).toBe('statement open');
  });

  it('appealStatementsMs 0 nulls a decided statement at the next purge, and the row stays', async () => {
    const { store } = appealsSetup();
    store.insertAppeal(appeal('a', 'g-a'));
    decide(store, 'a', NOW - 1);
    expect((await purge(store, NOW, { appealStatementsMs: 0 })).appealStatements).toBe(1);
    expect(store.loadAppeal('a')).toMatchObject({ statement: null, status: 'upheld' });
    expect((await purge(store, NOW, { appealStatementsMs: 0 })).appealStatements).toBe(0);
  });

  it("a permanent unrevoked sanction's decided appeal survives appealsMs", async () => {
    const { store, subject, sanction } = appealsSetup();
    const ban = await sanction(subject('p1'), NOW - 500 * DAY, null, 'ban', true);
    const timed = await sanction(subject('p2'), NOW - 500 * DAY, 7 * DAY, 'ban', true);
    store.insertAppeal(appeal('perm', ban.groupId, { kind: 'ban' }));
    store.insertAppeal(appeal('timed', timed.groupId, { kind: 'ban' }));
    decide(store, 'perm', NOW - 400 * DAY);
    decide(store, 'timed', NOW - 400 * DAY);
    const res = await purge(store, NOW);
    expect(res.appeals).toBe(1);
    expect(store.loadAppeal('perm')).not.toBeNull();
    expect(store.loadAppeal('timed')).toBeNull();
    // the statement of the kept row is still cleared, on its own and shorter clock
    expect(store.loadAppeal('perm')?.statement).toBeNull();
    // once the sanction is revoked the row goes
    store.revokeSanctionGroup(ban.groupId, 'mod', NOW + DAY, 'lifted');
    expect((await purge(store, NOW + 2 * DAY)).appeals).toBe(1);
    expect(store.loadAppeal('perm')).toBeNull();
  });

  it('a store without the methods purges the rest and reports 0 for the three', async () => {
    const { store } = setup();
    store.insertStrike(strike('old', NOW - 60 * DAY));
    const res = await purge(store, NOW);
    expect(res).toMatchObject({ strikes: 1, appeals: 0, appealStatements: 0, blockedNames: 0 });
    // a store with only the appeal methods, and one with only the name methods
    const onlyAppeals = withMemoryAppeals(new MemoryStore());
    onlyAppeals.insertAppeal(appeal('a', 'g-a'));
    decide(onlyAppeals, 'a', NOW - 400 * DAY);
    expect(await purge(onlyAppeals, NOW)).toMatchObject({ appeals: 1, blockedNames: 0 });
    const onlyNames = withMemoryNames(new MemoryStore());
    onlyNames.insertBlockedName(blocked('b', NOW - 40 * DAY));
    expect(await purge(onlyNames, NOW)).toMatchObject({ appeals: 0, appealStatements: 0, blockedNames: 1 });
  });

  it('an invalid window makes purge throw and delete nothing', async () => {
    const { store } = appealsSetup();
    store.insertAppeal(appeal('a', 'g-a'));
    decide(store, 'a', NOW - 800 * DAY);
    store.insertBlockedName(blocked('b', NOW - 400 * DAY));
    for (const field of ['appealStatementsMs', 'appealsMs', 'blockedNamesMs'] as const) {
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) await expect(purge(store, NOW, { [field]: bad }), `${field} ${bad}`).rejects.toThrow(/purge/);
    }
    expect(store.loadAppeal('a')?.statement).toBe('statement a');
    expect(store.listBlockedNames(0, 10)).toHaveLength(1);
  });

  it('is part of the one transaction: a later failure restores appeals, statements and names', async () => {
    const { store } = appealsSetup();
    store.insertAppeal(appeal('a', 'g-a'));
    decide(store, 'a', NOW - 800 * DAY);
    store.insertBlockedName(blocked('b', NOW - 400 * DAY));
    store.purgeMutes = () => {
      throw new Error('disk full');
    };
    await expect(purge(store, NOW)).rejects.toThrow('disk full');
    expect(store.loadAppeal('a')).toMatchObject({ statement: 'statement a', status: 'upheld' });
    expect(store.listBlockedNames(0, 10)).toHaveLength(1);
  });
});
