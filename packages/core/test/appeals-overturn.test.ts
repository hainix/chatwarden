import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrikeService } from '../src/strikes.js';
import type { KitEvent } from '../src/events.js';
import type { Matcher, RawWho } from '../src/types.js';
import { appealsKit, DAY, HOUR, NOW } from './appealsWorld.js';
import type { AppealsKit } from './appealsWorld.js';

// A granted appeal (reduce or revoke) is recorded as an overturn (0.2.1): the group is marked, the strikes that earned an automatic restriction are set aside and
// forgiven in memory, the report behind a decision counts as overturned, and `sanction.overturned` is announced once after the commit. An uphold records nothing.

const MIN = 60_000;
const FIRST_MS = 30 * MIN;
const REPEAT_MS = 24 * HOUR;
afterEach(() => vi.restoreAllMocks());

/** Blocks three synthetic words, each with its own term id. */
const matcher: Matcher = {
  match: (t) => {
    const s = t.toLowerCase();
    if (s.includes('zorbak')) return { termId: 'syn:zorbak' };
    if (s.includes('vlemmo')) return { termId: 'syn:vlemmo' };
    if (s.includes('quissel')) return { termId: 'syn:quissel' };
    return null;
  },
};
const kit = (over: Parameters<typeof appealsKit>[0] = {}) => appealsKit({ matcher, ...over }, { perPlayerPerWeek: 20 });

const overturned = (k: AppealsKit) => k.events.filter((e): e is Extract<KitEvent, { type: 'sanction.overturned' }> => e.type === 'sanction.overturned');
const autoSubjectRows = (k: AppealsKit) => k.store.rawSanctions().filter((r) => r.source === 'auto_filter' && r.targetType === 'subject');

/** A player the chat filter restricted by three blocked lines (the third is `quissel`); returns what an appeal needs. */
async function restricted(k: AppealsKit, key = 'key-auto') {
  const t = k.table({ target: key });
  for (const word of ['zorbak', 'vlemmo', 'quissel']) k.cw.chat.accept(t.room, 'p2', word);
  const row = autoSubjectRows(k).at(-1);
  if (row === undefined) throw new Error('expected an automatic restriction');
  const notice = k.store.rawNotices().find((n) => n.groupId === row.groupId);
  if (notice === undefined) throw new Error('expected a notice');
  return { who: { clientKey: key } as RawWho, subject: t.target, room: t.room, groupId: row.groupId, noticeId: notice.id, startsAt: row.startsAt };
}
/** Three blocked lines from the player at the current time; returns how long the restriction they earned lasts (null when none). */
function threeLines(k: AppealsKit, room: string): number | null {
  const before = autoSubjectRows(k).length;
  for (const word of ['zorbak', 'vlemmo', 'quissel']) k.cw.chat.accept(room, 'p2', word);
  const rows = autoSubjectRows(k);
  const row = rows.at(-1);
  return rows.length === before + 1 && row !== undefined && row.endsAt !== null ? row.endsAt - row.startsAt : null;
}
const fileAppeal = (k: AppealsKit, s: { who: RawWho; noticeId: string }): string => {
  const r = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'It was not me.' });
  if (!r.ok) throw new Error(`filing refused: ${r.refused}`);
  return r.appeal.id;
};
/** The id of the one appeal in the kit (a test with one appeal). */
const fileAppealId = (k: AppealsKit): string => k.rows()[0]?.id as string;

const decide = (k: AppealsKit, appealId: string, outcome: 'uphold' | 'reduce' | 'revoke') =>
  k.cw.appeals.decide({ appealId, outcome, actor: 'senior_bea', reason: 'second look', ...(outcome === 'reduce' ? { to: { kind: 'chat' as const, durationMs: 10 * MIN } } : {}) });

describe('an automatic restriction that is overturned', () => {
  it('revoking records an overturn with the tipping term, marks the sanction, and forgives the strikes (then three more blocked lines give the first-offence length)', async () => {
    const k = await kit();
    const a = await restricted(k);
    expect(autoSubjectRows(k).map((r) => r.endsAt! - r.startsAt)).toEqual([FIRST_MS]);
    const appealId = fileAppeal(k, a);
    expect(await decide(k, appealId, 'revoke')).toEqual({ ok: true, status: 'revoked' });
    // the term of the strike that tipped it, counted once as a group
    expect(k.store.overturnedTermCounts(0)).toEqual([{ termId: 'syn:quissel', overturned: 1, lastAt: NOW }]);
    expect(k.store.overturnedFilterCounts(0)).toEqual([]);
    expect(k.store.loadSanctionSubjectRow(a.groupId)).toMatchObject({ groupId: a.groupId, termId: 'syn:quissel', overturnedAt: NOW });
    // the strikes are set aside in the store (and so after a restart), still shown by the blocked-messages view
    expect(k.store.loadStrikes(0)).toEqual([]);
    expect(k.store.listStrikes(0, 10)).toHaveLength(3);
    // and the live service forgave them: the next restriction is not a repeat
    k.clock.t += 5 * MIN;
    expect(k.cw.chat.accept(a.room, 'p2', 'hello')).toHaveProperty('deliver');
    k.clock.t += 5 * MIN;
    expect(threeLines(k, a.room)).toBe(FIRST_MS);
  });

  it('control: an uphold records nothing, the strikes still count, and the next restriction is the 24 hours repeat', async () => {
    const k = await kit();
    const a = await restricted(k);
    const appealId = fileAppeal(k, a);
    expect(await decide(k, appealId, 'uphold')).toEqual({ ok: true, status: 'upheld' });
    expect(k.store.overturnedTermCounts(0)).toEqual([]);
    expect(k.store.loadSanctionSubjectRow(a.groupId)).not.toHaveProperty('overturnedAt');
    expect(k.store.loadStrikes(0)).toHaveLength(3);
    expect(overturned(k)).toEqual([]);
    k.clock.t += 31 * MIN; // the 30 minute restriction is over
    expect(threeLines(k, a.room)).toBe(REPEAT_MS);
  });

  it('reducing also overturns: the original group is marked, the strikes are forgiven and the next restriction is the first-offence length', async () => {
    const k = await kit();
    const a = await restricted(k);
    const appealId = fileAppeal(k, a);
    const res = await decide(k, appealId, 'reduce');
    expect(res).toMatchObject({ ok: true, status: 'reduced', replacementGroupId: expect.any(String) });
    expect(k.store.overturnedTermCounts(0)).toEqual([{ termId: 'syn:quissel', overturned: 1, lastAt: NOW }]);
    expect(k.store.loadSanctionSubjectRow(a.groupId)).toMatchObject({ overturnedAt: NOW });
    // the replacement is a moderator's sanction: it is not overturned and it is not an automatic start
    const replacement = (res as { replacementGroupId: string }).replacementGroupId;
    expect(k.store.loadSanctionSubjectRow(replacement)).not.toHaveProperty('overturnedAt');
    expect(k.store.loadStrikes(0)).toEqual([]);
    k.clock.t += 15 * MIN; // the 10 minute replacement is over
    expect(threeLines(k, a.room)).toBe(FIRST_MS);
  });

  it('an uphold of a decided appeal, or a second decision, records nothing more: one overturn row for the group', async () => {
    const k = await kit();
    const a = await restricted(k);
    const appealId = fileAppeal(k, a);
    expect(await decide(k, appealId, 'revoke')).toMatchObject({ ok: true });
    expect(await decide(k, appealId, 'revoke')).toEqual({ ok: false, error: 'already_decided' });
    expect(k.store.overturnedTermCounts(0)).toEqual([{ termId: 'syn:quissel', overturned: 1, lastAt: NOW }]);
    expect(overturned(k)).toHaveLength(1);
  });

  it("a moderator revoking the group outside an appeal records no overturn and the strikes still count (the start counts too)", async () => {
    const k = await kit();
    const a = await restricted(k);
    expect(await k.cw.sanctions.revoke(a.groupId, 'senior_bea', 'lifted')).toBe(true);
    expect(k.store.overturnedTermCounts(0)).toEqual([]);
    expect(k.store.loadSanctionSubjectRow(a.groupId)).not.toHaveProperty('overturnedAt');
    expect(k.store.loadStrikes(0)).toHaveLength(3);
    expect(overturned(k)).toEqual([]);
    k.clock.t += 5 * MIN;
    expect(threeLines(k, a.room)).toBe(REPEAT_MS);
  });

  it('two restrictions: overturning the second leaves the first as the start, so the next one is the repeat', async () => {
    const k = await kit();
    const a = await restricted(k);
    k.clock.t += 2 * HOUR;
    for (const word of ['zorbak', 'zorbak', 'vlemmo']) k.cw.chat.accept(a.room, 'p2', word);
    const rows = autoSubjectRows(k);
    expect(rows.map((r) => r.endsAt! - r.startsAt)).toEqual([FIRST_MS, REPEAT_MS]);
    const second = rows[1]!;
    const notice = k.store.rawNotices().find((n) => n.groupId === second.groupId)!;
    const appealId = fileAppeal(k, { who: a.who, noticeId: notice.id });
    expect(await decide(k, appealId, 'revoke')).toMatchObject({ ok: true });
    expect(k.store.overturnedTermCounts(0)).toEqual([{ termId: 'syn:vlemmo', overturned: 1, lastAt: NOW + 2 * HOUR }]);
    k.clock.t += 3 * HOUR;
    expect(threeLines(k, a.room)).toBe(REPEAT_MS);
  });
});

describe('a decision made from a report', () => {
  it('a report-decided sanction records its report as overturned; termId and filterKey are null', async () => {
    const k = await kit();
    const s = await k.sanction();
    const reporter = k.store.loadReport(s.reportId)?.reporterSubject as string;
    expect(k.store.reporterOutcomes([reporter], 0)).toEqual([{ reporter, actioned: 1, noAction: 0, badFaith: 0, overturned: 0 }]);
    const appealId = fileAppeal(k, s);
    expect(await decide(k, appealId, 'revoke')).toMatchObject({ ok: true });
    expect(k.store.reporterOutcomes([reporter], 0)).toEqual([{ reporter, actioned: 0, noAction: 0, badFaith: 0, overturned: 1 }]);
    expect(k.store.overturnedTermCounts(0)).toEqual([]);
    expect(k.store.overturnedFilterCounts(0)).toEqual([]);
    expect(k.store.loadSanctionSubjectRow(s.groupId)).toMatchObject({ overturnedAt: NOW });
    // no strikes are touched for a moderator's sanction
    expect(overturned(k)).toEqual([{ type: 'sanction.overturned', groupId: s.groupId, at: NOW, source: 'moderator' }]);
  });

  it('the lifetime reporter record agrees with the accuracy: an overturned report is not "actioned" but counted as overturned, and the total still counts it', async () => {
    const k = await kit();
    const keep = await k.sanction({ key: 'key-keep' });
    const gone = await k.sanction({ key: 'key-gone' });
    const reporterOf = (id: string) => k.store.loadReport(id)?.reporterSubject as string;
    const reporter = reporterOf(gone.reportId);
    expect(reporterOf(keep.reportId)).toBe(reporter); // the world files every report from one reporter
    expect(k.cw.reports.reporterRecord(reporter)).toMatchObject({ reports: 2, actioned: 2 });
    expect(k.cw.reports.reporterRecord(reporter)).not.toHaveProperty('overturned');
    expect(await decide(k, fileAppeal(k, gone), 'revoke')).toMatchObject({ ok: true });
    const record = k.cw.reports.reporterRecord(reporter);
    expect(record).toMatchObject({ reports: 2, open: 0, actioned: 1, dismissed: 0, overturned: 1 });
    expect(record.accuracy).toMatchObject({ overturned: record.overturned, decided: record.actioned });
  });

  it('a sanction from a filter report records filterKey = the report\'s originKey, and no term', async () => {
    const k = await appealsKit({ overrides: { filters: { links: { action: 'flag' } } } as never }, { perPlayerPerWeek: 20 });
    const ROOM = 'RFILTER';
    k.cw.rooms.seat(ROOM, 'p1', { clientKey: 'k-speaker' }, 'Spk');
    k.cw.rooms.seat(ROOM, 'p2', { clientKey: 'k-other' }, 'Oth');
    k.cw.chat.accept(ROOM, 'p1', 'see vlemmo.com now');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const report = k.cw.reports.list({ status: 'open' }).items[0];
    expect(report).toMatchObject({ origin: 'filter', originKey: 'link.unlisted' });
    const subject = k.cw.rooms.subjectAt(ROOM, 'p1') as string;
    const res = await k.cw.decide({ reportId: report!.id, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject, kind: 'chat', durationMs: 6 * HOUR, rule: 2, lineIds: [] }] } as never);
    if (!res.ok) throw new Error(`decide refused: ${res.error}`);
    const g = res.groups[0]!;
    const appealId = fileAppeal(k, { who: { clientKey: 'k-speaker' }, noticeId: g.noticeId as string });
    expect(await decide(k, appealId, 'revoke')).toMatchObject({ ok: true });
    expect(k.store.overturnedFilterCounts(0)).toEqual([{ filterKey: 'link.unlisted', overturned: 1 }]);
    expect(k.store.overturnedTermCounts(0)).toEqual([]);
    expect(overturned(k)).toEqual([{ type: 'sanction.overturned', groupId: g.groupId, at: NOW, source: 'moderator', filterKey: 'link.unlisted' }]);
    // a filter report has no reporter: it is in nobody's accuracy
    expect(k.store.reporterOutcomes([`filter:${report!.id}`], 0)).toEqual([]);
  });
});

describe('the sanction.overturned event', () => {
  it('is emitted once, after the commit, with groupId, source and the term; never for an uphold; not when a decision is refused', async () => {
    const k = await kit();
    const a = await restricted(k);
    const b = await restricted(k, 'key-b');
    const seen: Array<number | null | undefined> = [];
    k.cw.on('sanction.overturned', (e) => {
      // after the commit: the group is marked and the appeal is decided
      seen.push(k.store.loadSanctionSubjectRow(e.groupId)?.overturnedAt, k.store.loadAppeal(appealA)?.status === 'revoked' ? 1 : 0);
    });
    const appealA = fileAppeal(k, a);
    const appealB = fileAppeal(k, b);
    // refused decisions emit nothing
    expect(await k.cw.appeals.decide({ appealId: appealA, outcome: 'revoke', actor: 'senior_bea', reason: 'r', reasonCode: 'rule_applies' })).toEqual({ ok: false, error: 'invalid_reason' });
    expect(await decide(k, 'no-such', 'revoke')).toEqual({ ok: false, error: 'not_found' });
    expect(overturned(k)).toEqual([]);
    // an uphold emits nothing
    expect(await decide(k, appealB, 'uphold')).toMatchObject({ ok: true });
    expect(overturned(k)).toEqual([]);
    // a revoke emits one
    expect(await decide(k, appealA, 'revoke')).toMatchObject({ ok: true });
    expect(overturned(k)).toEqual([{ type: 'sanction.overturned', groupId: a.groupId, at: NOW, source: 'auto_filter', termId: 'syn:quissel' }]);
    expect(seen).toEqual([NOW, 1]);
    // no person and no text in it
    const text = JSON.stringify(overturned(k));
    for (const secret of [a.subject, b.subject, 'second look', 'It was not me', 'quissel line']) expect(text).not.toContain(secret);
  });

  it('is not emitted when the decision loses a race: two decisions at once give one ok, one already_decided and one event', async () => {
    const k = await kit();
    const a = await restricted(k);
    const appealId = fileAppeal(k, a);
    const [x, y] = await Promise.all([decide(k, appealId, 'revoke'), decide(k, appealId, 'revoke')]);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);
    expect([x, y].filter((r) => !r.ok)).toEqual([{ ok: false, error: 'already_decided' }]);
    expect(overturned(k)).toHaveLength(1);
    expect(k.store.overturnedTermCounts(0)).toEqual([{ termId: 'syn:quissel', overturned: 1, lastAt: NOW }]);
  });

  it('a moot appeal announces nothing', async () => {
    const k = await kit();
    const a = await restricted(k);
    fileAppeal(k, a);
    await k.cw.sanctions.revoke(a.groupId, 'senior_bea', 'lifted');
    expect(overturned(k)).toEqual([]);
    expect(k.store.overturnedTermCounts(0)).toEqual([]);
  });

  it('a throwing listener cannot fail the decision', async () => {
    const k = await kit();
    const a = await restricted(k);
    k.cw.on('sanction.overturned', () => {
      throw new Error('listener boom');
    });
    expect(await decide(k, fileAppeal(k, a), 'revoke')).toMatchObject({ ok: true });
    expect(k.store.overturnedTermCounts(0)).toHaveLength(1);
  });
});

describe('failures', () => {
  it('a throwing forgive hook never fails the decision: the overturn is recorded and the event still goes out, logged by class', async () => {
    const k = await kit();
    const a = await restricted(k);
    vi.spyOn(StrikeService.prototype, 'forgive').mockImplementation(() => {
      throw new RangeError('forgive boom');
    });
    expect(await decide(k, fileAppeal(k, a), 'revoke')).toMatchObject({ ok: true, status: 'revoked' });
    expect(k.store.overturnedTermCounts(0)).toHaveLength(1);
    expect(overturned(k)).toHaveLength(1);
    expect(k.logged.map(([e]) => e)).toContain('chatwarden.event_failed');
    expect(JSON.stringify(k.logged)).not.toContain('forgive boom');
  });

  it('a store without recordOverturn never fails the decision: it is decided, nothing is recorded and no event is emitted', async () => {
    const k = await kit();
    const a = await restricted(k);
    (k.store as unknown as { recordOverturn?: unknown }).recordOverturn = undefined;
    expect(await decide(k, fileAppeal(k, a), 'revoke')).toMatchObject({ ok: true, status: 'revoked' });
    expect(k.store.loadAppeal(fileAppealId(k))?.status).toBe('revoked');
    expect(overturned(k)).toEqual([]);
    expect(k.store.loadStrikes(0)).toHaveLength(3);
  });

  it('a recordOverturn that throws is the store failing: the decision is rolled back whole and rejects', async () => {
    const k = await kit();
    const a = await restricted(k);
    const appealId = fileAppeal(k, a);
    (k.store as unknown as { recordOverturn: () => never }).recordOverturn = () => {
      throw new Error('store boom');
    };
    await expect(decide(k, appealId, 'revoke')).rejects.toThrow('store boom');
    expect(k.store.loadAppeal(appealId)?.status).toBe('open');
    expect(k.store.rawSanctions().every((r) => r.revokedAt === null)).toBe(true);
    expect(k.store.rawNotices().find((n) => n.id === a.noticeId)?.withdrawnAt).toBeNull();
    expect(k.events.filter((e) => e.type === 'appeal.decided' || e.type === 'sanction.overturned')).toEqual([]);
  });

  it('an already-recorded overturn (recordOverturn answers false) is not an error and announces nothing', async () => {
    const k = await kit();
    const a = await restricted(k);
    const appealId = fileAppeal(k, a);
    // another process recorded it first
    k.store.recordOverturn({ groupId: a.groupId, at: NOW - 1, subject: a.subject, aliases: [a.subject], source: 'auto_filter', termId: 'syn:quissel', filterKey: null, reportId: null, strikes: null });
    expect(await decide(k, appealId, 'revoke')).toMatchObject({ ok: true, status: 'revoked' });
    expect(overturned(k)).toEqual([]);
    expect(k.store.overturnedTermCounts(0)).toEqual([{ termId: 'syn:quissel', overturned: 1, lastAt: NOW - 1 }]);
  });
});

describe('a sanction written by the AI', () => {
  it("a row of source 'ai' with a reportId still runs onGranted (6.3): the casebook marks the report reversed, and the overturn is recorded", async () => {
    const k = await kit();
    const f = await k.file();
    // acting is shadow-only in 0.2.0 and nothing else writes such a row: write it by hand
    k.store.insertSanctionGroup([
      {
        id: 'ai-row-1',
        groupId: 'g-ai',
        refCode: 'M-AIAAA',
        kind: 'chat',
        targetType: 'subject',
        value: f.target,
        startsAt: NOW,
        endsAt: NOW + 6 * HOUR,
        reason: 'ai',
        rule: '2',
        gapNote: null,
        gapStatus: null,
        roomId: null,
        actor: 'ai',
        source: 'ai',
        automated: true,
        pending: false,
        reportId: f.id,
      },
    ]);
    k.store.insertAppeal({ id: 'ap-ai', subject: f.target, groupId: 'g-ai', noticeId: 'n-ai', reportId: f.id, rule: '2', kind: 'chat', statement: 'st', status: 'open', createdAt: NOW, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null });
    const calls: Array<[string, unknown]> = [];
    const real = k.cw.ai.markReversed.bind(k.cw.ai);
    k.cw.ai.markReversed = (id: string, opts?: { corrective?: boolean }) => {
      calls.push([id, opts]);
      return real(id, opts);
    };
    expect(await decide(k, 'ap-ai', 'revoke')).toMatchObject({ ok: true, status: 'revoked' });
    expect(calls).toEqual([[f.id, { corrective: true }]]);
    // and the overturn is recorded with the AI as the source, no term and no strikes
    expect(overturned(k)).toEqual([{ type: 'sanction.overturned', groupId: 'g-ai', at: NOW, source: 'ai' }]);
    expect(k.store.loadSanctionSubjectRow('g-ai')).toMatchObject({ overturnedAt: NOW });
  });

  it("an 'ai' row is not an automatic filter start: forgive is not called for it", async () => {
    const k = await kit();
    const f = await k.file();
    k.store.insertSanctionGroup([
      { id: 'ai-row-2', groupId: 'g-ai2', refCode: 'M-AIBBB', kind: 'chat', targetType: 'subject', value: f.target, startsAt: NOW, endsAt: NOW + HOUR, reason: 'ai', rule: '2', gapNote: null, gapStatus: null, roomId: null, actor: 'ai', source: 'ai', automated: true, pending: false, reportId: f.id },
    ]);
    k.store.insertAppeal({ id: 'ap-ai2', subject: f.target, groupId: 'g-ai2', noticeId: 'n-ai2', reportId: f.id, rule: '2', kind: 'chat', statement: 'st', status: 'open', createdAt: NOW, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null });
    const forgive = vi.spyOn(StrikeService.prototype, 'forgive');
    expect(await decide(k, 'ap-ai2', 'revoke')).toMatchObject({ ok: true });
    expect(forgive).not.toHaveBeenCalled();
  });
});

describe('what survives', () => {
  it("the overturn survives the strikes' purge: the counts read the overturn rows, never the strikes", async () => {
    const k = await kit();
    const a = await restricted(k);
    expect(await decide(k, fileAppeal(k, a), 'revoke')).toMatchObject({ ok: true });
    expect(k.store.purgeStrikes(NOW + 40 * DAY)).toBe(3);
    expect(k.store.listStrikes(0, 10)).toEqual([]);
    expect(k.store.overturnedTermCounts(0)).toEqual([{ termId: 'syn:quissel', overturned: 1, lastAt: NOW }]);
  });
});
