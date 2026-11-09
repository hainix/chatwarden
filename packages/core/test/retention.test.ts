import { describe, expect, it } from 'vitest';
import { purge, RETENTION_DEFAULTS } from '../src/retention.js';
import { applySanction, revokeSanction } from '../src/sanctions.js';
import { SubjectIndex } from '../src/subjects.js';
import type { NoticeRow, SanctionKind, StoredReport, StrikeRow, SubjectId } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

function setup() {
  const store = new MemoryStore();
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
  it('are 90 d of reports, 90 d after a sanction ends, 30 d of strikes, 90 d of notices', () => {
    expect(RETENTION_DEFAULTS).toEqual({ reportsMs: 90 * DAY, sanctionAfterEndMs: 90 * DAY, strikesMs: 30 * DAY, noticesMs: 90 * DAY });
  });
});

describe('purge: reports', () => {
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
    store.closeReport('b', 'actioned', NOW - 99 * DAY);
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
    expect(await purge(t.store, NOW)).toEqual({ reports: 2, sanctions: 1, strikes: 1, mutes: 1, notices: 0 });
  });

  it('on an empty store, or run twice, deletes nothing', async () => {
    const { store } = setup();
    expect(await purge(store, NOW)).toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 0 });
    store.insertReport(report('r1', NOW - 100 * DAY));
    await purge(store, NOW);
    expect(await purge(store, NOW)).toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 0 });
  });

  it('a custom policy overrides the defaults, field by field', async () => {
    const t = setup();
    t.store.insertReport(report('r1', NOW - 10 * DAY));
    t.store.insertStrike(strike('s1', NOW - 10 * DAY));
    await t.sanction(t.subject('k1'), NOW - 20 * DAY, DAY); // ended 19 d ago
    const res = await purge(t.store, NOW, { reportsMs: 5 * DAY });
    expect(res).toEqual({ reports: 1, sanctions: 0, strikes: 0, mutes: 0, notices: 0 });
    const res2 = await purge(t.store, NOW, { strikesMs: 5 * DAY, sanctionAfterEndMs: 5 * DAY });
    expect(res2).toEqual({ reports: 0, sanctions: 1, strikes: 1, mutes: 0, notices: 0 });
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
    await expect(purge(t.store, 0)).resolves.toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 0 });
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
