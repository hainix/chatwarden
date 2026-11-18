import { describe, expect, it } from 'vitest';
import type { AppealCause } from '../src/index.js';
import type { Matcher, RawWho, SanctionRow, Source } from '../src/types.js';
import { appealsKit, HOUR, NOW } from './appealsWorld.js';
import type { AppealsKit } from './appealsWorld.js';

// Why a sanction was made, shown to the moderator who decides its appeal (0.2.1): `AppealDetail.cause`, from the sanction's subject row and the report behind it.
// One shape per source. It is on `get()` and not on the list.

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
const causeOf = (k: AppealsKit, id: string): AppealCause | undefined => k.cw.appeals.get(id)?.cause;

const sanctionRow = (groupId: string, over: Partial<SanctionRow> = {}): SanctionRow => ({
  id: `row-${groupId}`,
  groupId,
  refCode: `M-${groupId.slice(-5).toUpperCase().padEnd(5, 'X')}`,
  kind: 'chat',
  targetType: 'subject',
  value: 's_direct',
  startsAt: NOW,
  endsAt: NOW + 6 * HOUR,
  reason: 'private',
  rule: '2',
  gapNote: null,
  gapStatus: null,
  roomId: null,
  actor: 'mod_ann',
  source: 'moderator',
  automated: false,
  pending: false,
  ...over,
});
/** A group and an open appeal written straight into the store (a row shape no live path writes any more, or never wrote). */
function direct(k: AppealsKit, id: string, over: Partial<SanctionRow> = {}, appealOver: { reportId?: string | null; noRows?: boolean } = {}): string {
  const groupId = `g-${id}`;
  if (appealOver.noRows !== true) k.store.insertSanctionGroup([sanctionRow(groupId, over)]);
  k.store.insertAppeal({
    id: `ap-${id}`,
    subject: over.value ?? 's_direct',
    groupId,
    noticeId: `n-${id}`,
    reportId: appealOver.reportId ?? over.reportId ?? null,
    rule: '2',
    kind: 'chat',
    statement: 'st',
    status: 'open',
    createdAt: NOW,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    replacementGroupId: null,
  });
  return `ap-${id}`;
}

async function appealFor(k: AppealsKit, s: { who: RawWho; noticeId: string }): Promise<string> {
  const r = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'It was not me.' });
  if (!r.ok) throw new Error(`filing refused: ${r.refused}`);
  return r.appeal.id;
}

describe('the cause of an appeal', () => {
  it("a moderator's decision gives { source: 'report', reportId, decidedBy: 'human' }", async () => {
    const k = await kit();
    const s = await k.sanction();
    const id = await appealFor(k, s);
    expect(causeOf(k, id)).toEqual({ source: 'report', reportId: s.reportId, decidedBy: 'human' });
  });

  it("an automatic restriction gives { source: 'term', termId: the tipping term, strikes: 3 }", async () => {
    const k = await kit();
    const t = k.table({ target: 'key-auto' });
    for (const word of ['zorbak', 'vlemmo', 'quissel']) k.cw.chat.accept(t.room, 'p2', word);
    const row = k.store.rawSanctions().find((r) => r.source === 'auto_filter' && r.targetType === 'subject');
    const notice = k.store.rawNotices().find((n) => n.groupId === row?.groupId);
    const id = await appealFor(k, { who: { clientKey: 'key-auto' }, noticeId: notice?.id as string });
    expect(causeOf(k, id)).toEqual({ source: 'term', termId: 'syn:quissel', strikes: 3 });
  });

  it.each([['an empty string', ''], ['a non-string', 7 as unknown as string], ['null', null as unknown as string]])(
    'a custom matcher that gives %s as the term id still gets its automatic restriction, with no term stored',
    async (_name, termId) => {
      const odd: Matcher = { match: (t) => (t.toLowerCase().includes('glarn') ? { termId } : null) };
      const k = await kit({ matcher: odd });
      const t = k.table({ target: 'key-odd' });
      for (const word of ['glarn', 'glarn two', 'glarn three']) k.cw.chat.accept(t.room, 'p2', word);
      const rows = k.store.rawSanctions().filter((r) => r.source === 'auto_filter' && r.targetType === 'subject');
      expect(rows).toHaveLength(1);
      expect(k.store.loadSanctionSubjectRow(rows[0]!.groupId)?.termId).toBeNull();
    },
  );

  it('a normal term id is still stored on the restriction (control)', async () => {
    const k = await kit();
    const t = k.table({ target: 'key-ctl' });
    for (const word of ['zorbak', 'vlemmo', 'quissel']) k.cw.chat.accept(t.room, 'p2', word);
    const rows = k.store.rawSanctions().filter((r) => r.source === 'auto_filter' && r.targetType === 'subject');
    expect(k.store.loadSanctionSubjectRow(rows[0]!.groupId)?.termId).toBe('syn:quissel');
  });

  it('a row written before 0.2.1 (no term id) gives termId: null', async () => {
    const k = await kit();
    const id = direct(k, 'old-auto', { source: 'auto_filter', automated: true, actor: 'auto' });
    expect(causeOf(k, id)).toEqual({ source: 'term', termId: null, strikes: 3 });
  });

  it('a term cause with the term id stored on the row gives it back (a direct row)', async () => {
    const k = await kit();
    const id = direct(k, 'auto-term', { source: 'auto_filter', automated: true, actor: 'auto', termId: 'syn:vlemmo' });
    expect(causeOf(k, id)).toEqual({ source: 'term', termId: 'syn:vlemmo', strikes: 3 });
  });

  it("a filter report gives { source: 'filter', reportId, filterKey, decidedBy: 'human' }", async () => {
    const k = await appealsKit({ overrides: { filters: { links: { action: 'flag' } } } as never }, { perPlayerPerWeek: 20 });
    const ROOM = 'RCAUSE';
    k.cw.rooms.seat(ROOM, 'p1', { clientKey: 'k-speaker' }, 'Spk');
    k.cw.rooms.seat(ROOM, 'p2', { clientKey: 'k-other' }, 'Oth');
    k.cw.chat.accept(ROOM, 'p1', 'see vlemmo.com now');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const report = k.cw.reports.list({ status: 'open' }).items[0];
    const subject = k.cw.rooms.subjectAt(ROOM, 'p1') as string;
    const res = await k.cw.decide({ reportId: report!.id, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject, kind: 'chat', durationMs: 6 * HOUR, rule: 2, lineIds: [] }] } as never);
    if (!res.ok) throw new Error(`decide refused: ${res.error}`);
    const id = await appealFor(k, { who: { clientKey: 'k-speaker' }, noticeId: res.groups[0]!.noticeId as string });
    expect(causeOf(k, id)).toEqual({ source: 'filter', reportId: report!.id, filterKey: 'link.unlisted', decidedBy: 'human' });
  });

  it("a source 'ai' row with a report id gives decidedBy: 'ai' (written directly: acting is shadow-only in 0.2.0)", async () => {
    const k = await kit();
    const f = await k.file();
    const id = direct(k, 'ai', { source: 'ai', automated: true, actor: 'ai', value: f.target, reportId: f.id });
    expect(causeOf(k, id)).toEqual({ source: 'report', reportId: f.id, decidedBy: 'ai' });
  });

  it("a coop sanction with no report gives via: 'coop'; an api one, and a moderator's direct one, give 'api'", async () => {
    const k = await kit();
    const cases: Array<[Source, 'coop' | 'api']> = [['coop', 'coop'], ['api', 'api'], ['moderator', 'api']];
    for (const [source, via] of cases) {
      const id = direct(k, `other-${source}`, { source, actor: source === 'coop' ? 'coop' : 'mod_ann' });
      expect(causeOf(k, id), source).toEqual({ source: 'other', via });
    }
  });

  it('a report row that is gone (purged) reads as other, not an error', async () => {
    const k = await kit();
    const s = await k.sanction();
    const id = await appealFor(k, s);
    expect(causeOf(k, id)).toMatchObject({ source: 'report' });
    // retention deletes decided reports; the sanction row keeps the id of one that is no longer there
    expect(k.store.purgeReports(NOW + 1, 0)).toBeGreaterThan(0);
    expect(k.store.loadReport(s.reportId)).toBeNull();
    expect(causeOf(k, id)).toEqual({ source: 'other', via: 'api' });
    // the same for a coop row that cites a report which is gone
    const coop = direct(k, 'coop-gone', { source: 'coop', actor: 'coop', reportId: 'no-such-report' });
    expect(causeOf(k, coop)).toEqual({ source: 'other', via: 'coop' });
  });

  it('a group whose rows are gone (retention) reads as other, via api', async () => {
    const k = await kit();
    const id = direct(k, 'rows-gone', {}, { noRows: true });
    expect(causeOf(k, id)).toEqual({ source: 'other', via: 'api' });
  });

  it('a store that fails the read reads as other, never throws', async () => {
    const k = await kit();
    const s = await k.sanction();
    const id = await appealFor(k, s);
    const real = k.store.loadReport.bind(k.store);
    k.store.loadReport = () => {
      throw new TypeError('store boom');
    };
    expect(k.cw.appeals.get(id)?.cause).toEqual({ source: 'other', via: 'api' });
    expect(JSON.stringify(k.logged)).not.toContain('store boom');
    k.store.loadReport = real;
    expect(causeOf(k, id)).toMatchObject({ source: 'report' });
  });

  it('cause is on get() and not on list()', async () => {
    const k = await kit();
    const s = await k.sanction();
    const id = await appealFor(k, s);
    expect(Object.keys(k.cw.appeals.get(id) ?? {})).toContain('cause');
    const item = k.cw.appeals.list({}).items.find((i) => i.id === id);
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {})).not.toContain('cause');
    expect(k.cw.appeals.mine(s.who).map((i) => Object.keys(i))).not.toContainEqual(expect.arrayContaining(['cause']));
  });

  it('with the configured strikes count 5 the term cause says 5', async () => {
    const k = await kit({ limits: { strikes: { count: 5 } } });
    const t = k.table({ target: 'key-five' });
    // the fixed chat rate (3 lines in 5 seconds) is not what is under test: space the lines out
    for (const word of ['zorbak', 'vlemmo', 'quissel', 'zorbak']) {
      k.cw.chat.accept(t.room, 'p2', word);
      k.clock.t += 6_000;
    }
    expect(k.store.rawSanctions()).toEqual([]);
    expect(k.store.loadStrikes(0)).toHaveLength(4);
    k.cw.chat.accept(t.room, 'p2', 'vlemmo');
    const row = k.store.rawSanctions().find((r) => r.source === 'auto_filter' && r.targetType === 'subject');
    const notice = k.store.rawNotices().find((n) => n.groupId === row?.groupId);
    const id = await appealFor(k, { who: { clientKey: 'key-five' }, noticeId: notice?.id as string });
    expect(causeOf(k, id)).toEqual({ source: 'term', termId: 'syn:vlemmo', strikes: 5 });
  });

  it('a decided or moot appeal has its cause too', async () => {
    const k = await kit();
    const a = await k.sanction();
    const idA = await appealFor(k, a);
    expect((await k.cw.appeals.decide({ appealId: idA, outcome: 'uphold', actor: 'senior_bea', reason: 'r' })).ok).toBe(true);
    expect(causeOf(k, idA)).toEqual({ source: 'report', reportId: a.reportId, decidedBy: 'human' });
    const b = await k.sanction();
    const idB = await appealFor(k, b);
    await k.cw.sanctions.revoke(b.groupId, 'senior_bea', 'lifted');
    expect(causeOf(k, idB)).toEqual({ source: 'report', reportId: b.reportId, decidedBy: 'human' });
  });

  it('the cause holds ids and keys only: no handle, no statement, no moderator text', async () => {
    const k = await kit();
    const s = await k.sanction();
    const id = await appealFor(k, s);
    const text = JSON.stringify(causeOf(k, id));
    for (const secret of ['private reason', 'It was not me', 'mod_ann', s.subject]) expect(text).not.toContain(secret);
  });
});
