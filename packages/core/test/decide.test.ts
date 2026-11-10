import { describe, expect, it } from 'vitest';
import { DecisionService, decisionKey, revokeAndWithdraw } from '../src/decide.js';
import type { DecisionAction, DecisionInput } from '../src/decide.js';
import { EvidenceBuffer, RoomRoster } from '../src/evidence.js';
import { NoticeService } from '../src/notices.js';
import { historyOf, recordStep } from '../src/ladder.js';
import { purge } from '../src/retention.js';
import { ReportService } from '../src/reports.js';
import { CommunityRules, STARTER_RULES } from '../src/rules.js';
import { MAX_SANCTION_DURATION_MS, SanctionIndex } from '../src/sanctions.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, Logger, SubjectId } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const EVIDENCE = 'filed the same false report against three players in one evening';

const who = (clientKey: string | null, accountId: string | null = null, ipHash: string | null = null): Identifiers => ({
  clientKey,
  accountId,
  ipHash,
});

/** A rules list with a retired rule 9 and an active rule 10 on top of the starters. */
const rules = new CommunityRules([
  ...STARTER_RULES,
  { number: 9, title: 'Old rule', text: 'No longer applies.', retired: true },
  { number: 10, title: 'Newer rule', text: 'Be kind.' },
]);

class FailOnSecondSanction extends MemoryStore {
  n = 0;
  override insertSanctionGroup(rows: Parameters<MemoryStore['insertSanctionGroup']>[0]): boolean {
    if (++this.n === 2) throw new Error('disk full');
    return super.insertSanctionGroup(rows);
  }
}
class FailOnNotice extends MemoryStore {
  n = 0;
  at: number;
  constructor(at: number) {
    super();
    this.at = at;
  }
  override insertNotice(row: Parameters<MemoryStore['insertNotice']>[0]): void {
    if (++this.n === this.at) throw new Error('disk full');
    super.insertNotice(row);
  }
}
class FailOnDecision extends MemoryStore {
  override insertDecision(): never {
    throw new Error('disk full');
  }
}
class FailOnClose extends MemoryStore {
  override closeReport(): never {
    throw new Error('disk full');
  }
}

function setup(
  opts: { store?: MemoryStore; enabled?: () => boolean; notify?: (s: SubjectId, e: { type: 'notice_pending'; count: number }) => unknown } = {},
) {
  const store = opts.store ?? new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const logs: Array<{ event: string; detail?: Record<string, string | number | boolean> }> = [];
  const logger: Logger = { warn: (event, detail) => void logs.push({ event, detail }) };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const index = new SanctionIndex({ enabled: opts.enabled ?? (() => true), subjects });
  const pushed: Array<{ subject: SubjectId; count: number }> = [];
  const notify =
    opts.notify ?? ((subject: SubjectId, e: { type: 'notice_pending'; count: number }) => void pushed.push({ subject, count: e.count }));
  const notices = new NoticeService({ store, subjects, rules, clock, logger, notify: notify as never });
  const decisions = new DecisionService({ store, subjects, rules, notices, clock, index, logger });
  const roster = new RoomRoster();
  const buffer = new EvidenceBuffer({ clock });
  const reports = new ReportService({ roster, buffer, subjects, store, clock, onReport: () => {}, logger });

  const person = (ids: Identifiers): SubjectId => {
    const s = subjects.resolve(ids);
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  const sit = (room: string, seat: string, ids: Identifiers, handle = `h-${seat}`): SubjectId => {
    const s = person(ids);
    roster.seat(room, seat, s, handle);
    return s;
  };
  const say = (room: string, seat: string, raw: string, over: { blocked?: boolean } = {}): string => {
    const occ = roster.occupant(room, seat);
    return buffer.append(room, {
      ts: NOW - 1000,
      seatId: seat,
      handle: occ?.handle ?? seat,
      subject: occ?.subject ?? null,
      raw,
      delivered: over.blocked ? null : raw,
      blocked: over.blocked ?? false,
      audience: null,
    });
  };

  /**
   * A table in its own room: reporter, target and a bystander, each with one line, then a real report from the
   * reporter. Keys are unique per room so many reports can coexist.
   */
  let n = 0;
  const table = async (reporterKey = `rk${n}`, targetKey = `tk${n}`) => {
    const room = `room-${++n}`;
    const reporter = sit(room, 'p1', who(reporterKey));
    const target = sit(room, 'p2', who(targetKey));
    const bystander = sit(room, 'p3', who(`bk${n}`));
    const lines = {
      reporter: say(room, 'p1', 'reporter says hello'),
      target: say(room, 'p2', 'target says one'),
      target2: say(room, 'p2', 'target says two'),
      bystander: say(room, 'p3', 'bystander says hi'),
    };
    const res = await reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    return { room, reportId: res.reportId, reporter, target, bystander, lines };
  };
  /** File a report from p1 against p2 in a room the caller seated, and return its id. */
  const file = async (room: string): Promise<string> => {
    const res = await reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'other' });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    return res.reportId;
  };

  const warn = (subject: SubjectId, over: Partial<DecisionAction> = {}): DecisionAction => ({
    subject,
    kind: 'warning',
    durationMs: null,
    rule: 2,
    ...over,
  });
  const note = (subject: SubjectId, over: Partial<DecisionAction> = {}): DecisionAction => ({
    subject,
    kind: 'note',
    durationMs: null,
    rule: 2,
    ...over,
  });
  const chat = (subject: SubjectId, over: Partial<DecisionAction> = {}): DecisionAction => ({
    subject,
    kind: 'chat',
    durationMs: DAY,
    rule: 2,
    ...over,
  });
  // A bad_faith verdict needs evidence: supply it unless the test names `evidence` itself (even as undefined).
  const decide = (reportId: string, over: Partial<DecisionInput> = {}) =>
    decisions.decide({
      reportId,
      verdict: 'upheld',
      actions: [],
      actor: 'mod-a',
      reason: 'clear violation',
      ...(over.verdict === 'bad_faith' && !('evidence' in over) ? { evidence: EVIDENCE } : {}),
      ...over,
    });

  /** Everything the store holds that a decision writes. */
  const snapshot = () => ({
    reports: store.rawReports(),
    sanctions: store.rawSanctions(),
    notices: store.rawNotices(),
    decisions: store.rawDecisions(),
  });

  return { store, clock, logs, subjects, index, notices, decisions, roster, buffer, reports, pushed, person, sit, say, table, file, warn, note, chat, decide, snapshot };
}

type T = ReturnType<typeof setup>;
const okOf = <R extends { ok: boolean }>(r: R): Extract<R, { ok: true }> => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<R, { ok: true }>;
};
const activeChat = (t: T, subject: SubjectId) => t.index.active('chat', { clientKey: null, accountId: null, ipHash: null }, subject, NOW + 1);

// ---------------------------------------------------------------------------

describe('decide: upheld', () => {
  it('a warning: the report is actioned, the target gets a notice to acknowledge, the reporter gets report_outcome', async () => {
    const t = setup();
    const { reportId, target, reporter } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [t.warn(target)] }));
    expect(res.replay).toBe(false);
    expect(res.groups).toHaveLength(1);
    const g = res.groups[0];
    expect(g).toMatchObject({ subject: target });
    expect(g?.refCode).toMatch(/^M-[A-Z2-9]{5}$/);

    expect(t.store.loadReport(reportId)).toMatchObject({
      status: 'actioned',
      badFaith: false,
      actionedAt: NOW,
      actionedBy: 'mod-a',
      modNote: 'clear violation',
    });
    const pending = t.notices.pending(target);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: g?.noticeId, kind: 'warning', rule: 2, mustAcknowledge: true, until: null, refCode: g?.refCode });
    expect(t.notices.pending(reporter).map((x) => x.kind)).toEqual(['report_outcome']);
    expect(t.store.rawSanctions()).toHaveLength(1);
    expect(t.store.rawSanctions()[0]).toMatchObject({ kind: 'warning', value: target, rule: '2', actor: 'mod-a', source: 'moderator', reason: 'clear violation' });
  });

  it('a chat restriction: the index sees it at once, the notice carries the end', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.chat(target, { durationMs: 2 * H })] }));
    expect(activeChat(t, target)).toMatchObject({ until: NOW + 2 * H, automated: false });
    const [n] = t.notices.pending(target);
    expect(n).toMatchObject({ kind: 'chat', until: NOW + 2 * H, mustAcknowledge: false });
  });

  it('a permanent ban', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { actions: [{ subject: target, kind: 'ban', durationMs: null, rule: 1 }] }));
    expect(t.index.active('ban', { clientKey: null, accountId: null, ipHash: null }, target, NOW + 999 * DAY)).not.toBeNull();
    expect(t.notices.pending(target)[0]).toMatchObject({ kind: 'ban', until: null, rule: 1 });
  });

  it('with no actions it still closes the report as actioned, writes no sanction and sends no reporter feedback', async () => {
    const t = setup();
    const { reportId, reporter } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [] }));
    expect(res.groups).toEqual([]);
    expect(t.store.loadReport(reportId)?.status).toBe('actioned');
    expect(t.store.rawSanctions()).toHaveLength(0);
    expect(t.notices.pending(reporter)).toEqual([]);
  });

  it('two different actions on one person make two groups and two notices', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [t.warn(target), t.chat(target)] }));
    expect(res.groups).toHaveLength(2);
    expect(new Set(res.groups.map((g) => g.groupId)).size).toBe(2);
    expect(new Set(res.groups.map((g) => g.noticeId)).size).toBe(2);
    expect(t.notices.pending(target)).toHaveLength(2);
  });

  it('actions on two people: one group and one notice each; the reporter is told once', async () => {
    const t = setup();
    const { reportId, target, bystander, reporter } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [t.warn(target), t.warn(bystander)] }));
    expect(res.groups.map((g) => g.subject).sort()).toEqual([target, bystander].sort());
    expect(t.notices.pending(target)).toHaveLength(1);
    expect(t.notices.pending(bystander)).toHaveLength(1);
    expect(t.notices.pending(reporter).filter((x) => x.kind === 'report_outcome')).toHaveLength(1);
  });

  it('source defaults to moderator; an api source is recorded', async () => {
    const t = setup();
    const a = await t.table();
    okOf(await t.decide(a.reportId, { actions: [t.warn(a.target)] }));
    const b = await t.table();
    okOf(await t.decide(b.reportId, { actions: [t.warn(b.target)], source: 'api' }));
    expect(t.store.rawSanctions().map((r) => r.source)).toEqual(['moderator', 'api']);
  });

  it('includeIp writes the subject row and an IP row', async () => {
    const t = setup();
    const room = 'ipr';
    t.sit(room, 'p1', who('ip-rep'));
    const target = t.sit(room, 'p2', who('ip-tgt', null, 'iphash'));
    t.say(room, 'p2', 'hello');
    const reportId = await t.file(room);
    okOf(await t.decide(reportId, { actions: [t.chat(target, { includeIp: true })] }));
    expect(t.store.rawSanctions().map((r) => r.targetType).sort()).toEqual(['ip', 'subject']);
  });

  it('records pending when enforcement is off', async () => {
    const t = setup({ enabled: () => false });
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.chat(target)] }));
    expect(t.store.rawSanctions()[0]?.pending).toBe(true);
  });

  it('stores the CANONICAL subject when the action names an alias', async () => {
    const t = setup();
    const { reportId, target } = await t.table('ra', 'tb');
    const other = t.person(who('tb-alt', 'acct-t'));
    t.person(who('tb', 'acct-t')); // merges the two subjects
    const canon = t.subjects.canonical(target);
    expect(t.subjects.canonical(other)).toBe(canon);
    const alias = canon === target ? other : target;
    expect(alias).not.toBe(canon);
    const res = okOf(await t.decide(reportId, { actions: [t.warn(alias)] }));
    expect(res.groups[0]?.subject).toBe(canon);
    expect(t.store.rawSanctions()[0]?.value).toBe(canon);
  });

  it('trims the reason before it is stored', async () => {
    const t = setup();
    const { reportId } = await t.table();
    okOf(await t.decide(reportId, { reason: '  spaced out  ' }));
    expect(t.store.loadReport(reportId)?.modNote).toBe('spaced out');
  });
});

describe('decide: upheld acts only on people in the report', () => {
  it('a stranger is invalid and the store is unchanged', async () => {
    const t = setup();
    const { reportId } = await t.table();
    const stranger = t.person(who('stranger-fair'));
    const before = t.snapshot();
    expect(await t.decide(reportId, { actions: [t.warn(stranger)] })).toEqual({ ok: false, error: 'invalid' });
    expect(t.snapshot()).toEqual(before);
    expect(t.store.loadReport(reportId)?.status).toBe('open');
  });

  it('a stranger beside a valid action stops the whole decision', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const stranger = t.person(who('stranger-fair2'));
    const before = t.snapshot();
    expect(await t.decide(reportId, { actions: [t.warn(target), t.warn(stranger)] })).toEqual({ ok: false, error: 'invalid' });
    expect(t.snapshot()).toEqual(before);
  });

  it.each(['target', 'reporter', 'bystander'] as const)('accepts the %s', async (who_) => {
    const t = setup();
    const r = await t.table();
    okOf(await t.decide(r.reportId, { actions: [t.warn(r[who_])] }));
    expect(t.notices.pending(r[who_]).some((n) => n.kind === 'warning')).toBe(true);
  });

  it.each(['target', 'reporter', 'bystander'] as const)('accepts an alias of the %s', async (who_) => {
    const t = setup();
    const r = await t.table(`fr-${who_}`, `ft-${who_}`);
    const person = r[who_];
    const key = who_ === 'target' ? `ft-${who_}` : who_ === 'reporter' ? `fr-${who_}` : 'bk1';
    const other = t.person(who(`${key}-alt`, `acct-f-${who_}`));
    t.person(who(key, `acct-f-${who_}`));
    const canon = t.subjects.canonical(person);
    expect(t.subjects.canonical(other)).toBe(canon);
    const alias = canon === person ? other : person;
    const res = okOf(await t.decide(r.reportId, { actions: [t.warn(alias)] }));
    expect(res.groups[0]?.subject).toBe(canon);
  });
});

describe('decide: a report filed with an empty room id', () => {
  /** A table whose room id is the empty string: the report keeps it, the sanction rows must not. */
  async function emptyRoomTable() {
    const t = setup();
    const reporter = t.sit('', 'p1', who('rk-empty'));
    const target = t.sit('', 'p2', who('tk-empty'));
    t.say('', 'p2', 'target says one');
    const res = await t.reports.submit({ roomId: '', reporterSeat: 'p1', targetSeat: 'p2', category: 'other' });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    return { t, reportId: res.reportId, reporter, target };
  }

  it('can be upheld with a warning', async () => {
    const { t, reportId, target } = await emptyRoomTable();
    const res = await t.decide(reportId, { verdict: 'upheld', actions: [t.warn(target)] });
    expect(res.ok).toBe(true);
    expect(t.store.rawSanctions().map((r) => [r.kind, r.roomId ?? null])).toEqual([['warning', null]]);
  });

  it('can be upheld with a chat restriction', async () => {
    const { t, reportId, target } = await emptyRoomTable();
    expect((await t.decide(reportId, { verdict: 'upheld', actions: [t.chat(target)] })).ok).toBe(true);
    expect(t.store.rawSanctions().map((r) => r.roomId ?? null)).toEqual([null]);
  });

  it('can be noted, and the note reaches the history with a null room', async () => {
    const { t, reportId, target } = await emptyRoomTable();
    expect((await t.decide(reportId, { verdict: 'noted', actions: [t.note(target)] })).ok).toBe(true);
    expect(t.store.rawSanctions().map((r) => [r.kind, r.roomId ?? null])).toEqual([['note', null]]);
    expect(historyOf(t.store, t.subjects, target, NOW).map((h) => h.roomId)).toEqual([null]);
  });

  it('can be closed as no_action with a warning on the reporter', async () => {
    const { t, reportId, reporter } = await emptyRoomTable();
    expect((await t.decide(reportId, { verdict: 'no_action', actions: [t.warn(reporter, { rule: 4 })] })).ok).toBe(true);
    expect(t.store.rawSanctions().map((r) => r.roomId ?? null)).toEqual([null]);
  });

  it('can be closed as no_action with no actions at all', async () => {
    const { t, reportId } = await emptyRoomTable();
    expect((await t.decide(reportId, { verdict: 'no_action' })).ok).toBe(true);
    expect(t.store.loadReport(reportId)).toMatchObject({ status: 'dismissed' });
  });

  it('control: a report with a real room still records that room', async () => {
    const t = setup();
    const { reportId, target, room } = await t.table();
    okOf(await t.decide(reportId, { verdict: 'noted', actions: [t.note(target)] }));
    expect(t.store.rawSanctions().map((r) => r.roomId)).toEqual([room]);
  });
});

describe('decide: no_action', () => {
  it('dismisses with no bad-faith mark, no actions and no reporter feedback', async () => {
    const t = setup();
    const { reportId, reporter, target } = await t.table();
    const res = okOf(await t.decide(reportId, { verdict: 'no_action' }));
    expect(res.groups).toEqual([]);
    expect(t.store.loadReport(reportId)).toMatchObject({ status: 'dismissed', badFaith: false, actionedBy: 'mod-a', actionedAt: NOW });
    expect(t.notices.pending(reporter)).toEqual([]);
    expect(t.notices.pending(target)).toEqual([]);
    expect(t.store.loadBadFaithMarks(0)).toEqual([]);
  });

  it('an action against the reported target is invalid and writes nothing', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const before = t.snapshot();
    expect(await t.decide(reportId, { verdict: 'no_action', actions: [t.warn(target)] })).toEqual({ ok: false, error: 'invalid' });
    expect(t.snapshot()).toEqual(before);
    expect(t.store.loadReport(reportId)?.status).toBe('open');
  });

  it('an action against the target named by a merged alias is invalid too', async () => {
    const t = setup();
    const { reportId, target } = await t.table('r1k', 't1k');
    const other = t.person(who('t1k-alt', 'acct-x'));
    t.person(who('t1k', 'acct-x'));
    expect(t.subjects.canonical(other)).toBe(t.subjects.canonical(target));
    for (const subject of [other, target]) {
      expect(await t.decide(reportId, { verdict: 'no_action', actions: [t.warn(subject)] })).toEqual({ ok: false, error: 'invalid' });
    }
    expect(t.store.rawSanctions()).toHaveLength(0);
  });

  it('an action against the reporter is a normal action; no reporter feedback and no outcome notice', async () => {
    const t = setup();
    const { reportId, reporter } = await t.table();
    const res = okOf(await t.decide(reportId, { verdict: 'no_action', actions: [t.warn(reporter, { rule: 4 })] }));
    expect(res.groups).toHaveLength(1);
    expect(t.notices.pending(reporter).map((n) => n.kind)).toEqual(['warning']);
  });

  it('still refuses the target through an alias (bad_faith too)', async () => {
    const t = setup();
    const { reportId, target } = await t.table('ura', 'utg');
    const other = t.person(who('utg-alt', 'acct-u'));
    t.person(who('utg', 'acct-u'));
    const canon = t.subjects.canonical(target);
    const alias = canon === target ? other : target;
    for (const verdict of ['no_action', 'bad_faith'] as const) {
      expect(await t.decide(reportId, { verdict, actions: [t.warn(alias)] })).toEqual({ ok: false, error: 'invalid' });
    }
    expect(t.store.rawSanctions()).toHaveLength(0);
  });

  it('an action against another person who wrote in the excerpt is allowed', async () => {
    const t = setup();
    const { reportId, bystander } = await t.table();
    okOf(await t.decide(reportId, { verdict: 'no_action', actions: [t.warn(bystander)] }));
    expect(t.notices.pending(bystander)).toHaveLength(1);
  });

  it('an action against a stranger to the report is invalid', async () => {
    const t = setup();
    const { reportId } = await t.table();
    const stranger = t.person(who('stranger'));
    expect(await t.decide(reportId, { verdict: 'no_action', actions: [t.warn(stranger)] })).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('decide: bad_faith', () => {
  it('dismisses the report with bad_faith = 1', async () => {
    const t = setup();
    const { reportId } = await t.table();
    okOf(await t.decide(reportId, { verdict: 'bad_faith' }));
    expect(t.store.loadReport(reportId)).toMatchObject({ status: 'dismissed', badFaith: true, actionedAt: NOW });
    expect(t.store.loadBadFaithMarks(0)).toHaveLength(1);
  });

  it('three bad-faith dismissals suspend the reporter at the next submit', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) {
      const room = `bf-${i}`;
      t.sit(room, 'p1', who('same-reporter'));
      t.sit(room, 'p2', who(`victim-${i}`));
      okOf(await t.decide(await t.file(room), { verdict: 'bad_faith' }));
    }
    t.sit('bf-next', 'p1', who('same-reporter'));
    t.sit('bf-next', 'p2', who('victim-next'));
    expect(await t.reports.submit({ roomId: 'bf-next', reporterSeat: 'p1', targetSeat: 'p2', category: 'other' })).toEqual({
      ok: false,
      refused: 'suspended',
    });
  });

  it('two bad-faith dismissals do not suspend; a plain no_action one is not counted', async () => {
    const t = setup();
    for (const [i, verdict] of (['bad_faith', 'bad_faith', 'no_action'] as const).entries()) {
      const room = `bfx-${i}`;
      t.sit(room, 'p1', who('same-reporter'));
      t.sit(room, 'p2', who(`victim-${i}`));
      okOf(await t.decide(await t.file(room), { verdict }));
    }
    t.sit('bfx-next', 'p1', who('same-reporter'));
    t.sit('bfx-next', 'p2', who('victim-next'));
    expect(await t.reports.submit({ roomId: 'bfx-next', reporterSeat: 'p1', targetSeat: 'p2', category: 'other' })).toMatchObject({ ok: true });
  });

  it('acting on the reporter: the reporter gets a sanction notice for their false report', async () => {
    const t = setup();
    const { reportId, reporter, target } = await t.table();
    const res = okOf(await t.decide(reportId, { verdict: 'bad_faith', actions: [t.chat(reporter, { rule: 4 })] }));
    expect(res.groups[0]?.subject).toBe(reporter);
    expect(activeChat(t, reporter)).not.toBeNull();
    expect(t.notices.pending(reporter).map((n) => n.kind)).toEqual(['chat']);
    expect(t.notices.pending(target)).toEqual([]);
  });

  it('an action against the target is invalid', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    expect(await t.decide(reportId, { verdict: 'bad_faith', actions: [t.chat(target)] })).toEqual({ ok: false, error: 'invalid' });
    expect(t.store.loadReport(reportId)?.status).toBe('open');
  });
});

describe('decide: verdicts (renamed in K3a)', () => {
  it.each([
    ['upheld', 'actioned', false],
    ['no_action', 'dismissed', false],
    ['bad_faith', 'dismissed', true],
  ] as const)('%s closes the report as %s with bad_faith = %s', async (verdict, status, badFaith) => {
    const t = setup();
    const { reportId } = await t.table();
    okOf(await t.decide(reportId, { verdict }));
    expect(t.store.loadReport(reportId)).toMatchObject({ status, badFaith, actionedAt: NOW, actionedBy: 'mod-a' });
  });

  it.each(['fair', 'unfair', 'Upheld', 'NOTED', 'no-action', 'badfaith', '', 'dismissed', 'actioned'])(
    'the old or unknown verdict %j is invalid and writes nothing',
    async (verdict) => {
      const t = setup();
      const { reportId, target } = await t.table();
      const before = t.snapshot();
      expect(await t.decisions.decide({ reportId, verdict: verdict as never, actions: [t.warn(target)], actor: 'm', reason: 'r' })).toEqual({
        ok: false,
        error: 'invalid',
      });
      expect(t.snapshot()).toEqual(before);
      expect(t.store.loadReport(reportId)?.status).toBe('open');
    },
  );

  it('a missing or non-string verdict is invalid', async () => {
    const t = setup();
    const { reportId } = await t.table();
    for (const verdict of [undefined, null, 1, {}]) {
      expect(await t.decide(reportId, { verdict: verdict as never })).toEqual({ ok: false, error: 'invalid' });
    }
  });

  it('upheld keeps the old fair scope: it may act on the target', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { verdict: 'upheld', actions: [t.warn(target)] }));
    expect(t.notices.pending(target).map((n) => n.kind)).toEqual(['warning']);
  });

  it.each(['no_action', 'bad_faith'] as const)('%s keeps the old dismissal scope: never the target, nor a stranger; the reporter is fine', async (verdict) => {
    const t = setup();
    const { reportId, target, reporter } = await t.table();
    const stranger = t.person(who(`stranger-${verdict}`));
    expect(await t.decide(reportId, { verdict, actions: [t.warn(target)] })).toEqual({ ok: false, error: 'invalid' });
    expect(await t.decide(reportId, { verdict, actions: [t.warn(stranger)] })).toEqual({ ok: false, error: 'invalid' });
    expect(t.store.loadReport(reportId)?.status).toBe('open');
    okOf(await t.decide(reportId, { verdict, actions: [t.warn(reporter, { rule: 4 })] }));
    expect(t.store.loadReport(reportId)?.status).toBe('dismissed');
  });
});

describe('decide: noted (the Note outcome: on the record, never punishing)', () => {
  const invalid = { ok: false, error: 'invalid' };

  it('a note on the target: the report is actioned, one note row, and NO notice for anyone', async () => {
    const t = setup();
    const { reportId, target, reporter, room } = await t.table();
    const res = okOf(await t.decide(reportId, { verdict: 'noted', actions: [t.note(target)] }));
    expect(res.replay).toBe(false);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({ subject: target, noticeId: null });
    expect(res.groups[0]?.refCode).toMatch(/^M-[A-Z2-9]{5}$/);
    expect(t.store.loadReport(reportId)).toMatchObject({ status: 'actioned', badFaith: false, actionedBy: 'mod-a', modNote: 'clear violation' });
    const rows = t.store.rawSanctions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'note', targetType: 'subject', value: target, startsAt: NOW, endsAt: NOW, rule: '2', roomId: room,
      actor: 'mod-a', source: 'moderator', reason: 'clear violation', groupId: res.groups[0]?.groupId,
    });
    // No notice for the target, none for the reporter, nothing pushed.
    expect(t.store.rawNotices()).toEqual([]);
    expect(t.notices.pending(target)).toEqual([]);
    expect(t.notices.pending(reporter)).toEqual([]);
    expect(t.notices.record(target)).toEqual([]);
    expect(t.pushed).toEqual([]);
  });

  it('a note restricts nothing: the index never sees it', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { verdict: 'noted', actions: [t.note(target)] }));
    const ids = { clientKey: null, accountId: null, ipHash: null };
    for (const k of ['chat', 'area', 'ban', 'warning', 'note'] as const) {
      expect(t.index.active(k, ids, target, NOW + 1)).toBeNull();
    }
  });

  it('notes on two people: one group each, no notice for anyone', async () => {
    const t = setup();
    const { reportId, target, bystander, room } = await t.table();
    const res = okOf(await t.decide(reportId, { verdict: 'noted', actions: [t.note(target), t.note(bystander, { rule: 4 })] }));
    expect(res.groups.map((g) => g.subject).sort()).toEqual([target, bystander].sort());
    expect(res.groups.every((g) => g.noticeId === null)).toBe(true);
    expect(t.store.rawSanctions().map((r) => [r.kind, r.roomId])).toEqual([['note', room], ['note', room]]);
    expect(t.store.rawNotices()).toEqual([]);
  });

  it('a note on the reporter is allowed (the same scope as upheld) and still tells nobody', async () => {
    const t = setup();
    const { reportId, reporter } = await t.table();
    okOf(await t.decide(reportId, { verdict: 'noted', actions: [t.note(reporter)] }));
    expect(t.store.rawNotices()).toEqual([]);
  });

  it('the note joins the target\'s history with the report\'s room, and does not move the step', async () => {
    const t = setup();
    const { reportId, target, room } = await t.table();
    okOf(await t.decide(reportId, { verdict: 'noted', actions: [t.note(target)] }));
    const h = historyOf(t.store, t.subjects, target, NOW);
    expect(h).toEqual([{ kind: 'note', durationMs: 0, startsAt: NOW, revoked: false, automated: false, roomId: room }]);
    expect(recordStep(h)).toBe(0);
  });

  it('a gap note works when no rule is cited, like a warning', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { verdict: 'noted', actions: [t.note(target, { rule: 'uncovered', gapNote: 'odd case' })] }));
    expect(t.store.rawSanctions()[0]).toMatchObject({ kind: 'note', rule: 'uncovered', gapNote: 'odd case', gapStatus: 'open' });
  });

  it('is invalid with no action and writes nothing', async () => {
    const t = setup();
    const { reportId } = await t.table();
    const before = t.snapshot();
    expect(await t.decide(reportId, { verdict: 'noted', actions: [] })).toEqual(invalid);
    expect(t.snapshot()).toEqual(before);
    expect(t.store.loadReport(reportId)?.status).toBe('open');
  });

  it.each([
    ['a warning', (t: T, p: SubjectId) => [t.warn(p)]],
    ['a chat restriction', (t: T, p: SubjectId) => [t.chat(p)]],
    ['an area ban', (_t: T, p: SubjectId) => [{ subject: p, kind: 'area' as const, durationMs: DAY, rule: 5 }]],
    ['a ban', (_t: T, p: SubjectId) => [{ subject: p, kind: 'ban' as const, durationMs: null, rule: 1 }]],
    ['a note AND a warning', (t: T, p: SubjectId) => [t.note(p), t.warn(p)]],
    ['a note on one person and a chat restriction on another', (t: T, p: SubjectId, q: SubjectId) => [t.note(p), t.chat(q)]],
  ])('is invalid with %s and writes nothing', async (_name, mk) => {
    const t = setup();
    const { reportId, target, bystander } = await t.table();
    const before = t.snapshot();
    expect(await t.decide(reportId, { verdict: 'noted', actions: mk(t, target, bystander) })).toEqual(invalid);
    expect(t.snapshot()).toEqual(before);
    expect(t.store.loadReport(reportId)?.status).toBe('open');
  });

  it('is invalid for a stranger, with the store unchanged', async () => {
    const t = setup();
    const { reportId } = await t.table();
    const stranger = t.person(who('stranger-note'));
    const before = t.snapshot();
    expect(await t.decide(reportId, { verdict: 'noted', actions: [t.note(stranger)] })).toEqual(invalid);
    expect(t.snapshot()).toEqual(before);
  });

  it.each([
    ['a duration', { durationMs: DAY }],
    ['includeIp', { includeIp: true }],
    ['a retired rule', { rule: 9 }],
    ['an unknown rule', { rule: 99 }],
    ['an uncovered rule without a gap note', { rule: 'uncovered' as const }],
  ])('a note with %s is invalid', async (_name, over) => {
    const t = setup();
    const { reportId, target } = await t.table();
    const before = t.snapshot();
    expect(await t.decide(reportId, { verdict: 'noted', actions: [t.note(target, over as Partial<DecisionAction>)] })).toEqual(invalid);
    expect(t.snapshot()).toEqual(before);
  });

  it('the same note twice for one person is invalid', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    expect(await t.decide(reportId, { verdict: 'noted', actions: [t.note(target), t.note(target, { rule: 4 })] })).toEqual(invalid);
  });

  it('sending it again replays: one note, same groups with a null noticeId', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const first = okOf(await t.decide(reportId, { verdict: 'noted', actions: [t.note(target)] }));
    const again = okOf(await t.decide(reportId, { verdict: 'noted', actions: [t.note(target)] }));
    expect(again.replay).toBe(true);
    expect(again.groups).toEqual(first.groups);
    expect(again.groups[0]?.noticeId).toBeNull();
    expect(t.store.rawSanctions()).toHaveLength(1);
  });

  it('a different decision on the closed report is already_decided', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { verdict: 'noted', actions: [t.note(target)] }));
    expect(await t.decide(reportId, { verdict: 'upheld', actions: [t.warn(target)] })).toEqual({ ok: false, error: 'already_decided' });
  });

  it('is atomic: a store failure on the second note leaves nothing behind', async () => {
    const t = setup({ store: new FailOnSecondSanction() });
    const { reportId, target, bystander } = await t.table();
    const before = t.snapshot();
    await expect(t.decide(reportId, { verdict: 'noted', actions: [t.note(target), t.note(bystander)] })).rejects.toThrow('disk full');
    expect(t.snapshot()).toEqual(before);
  });

  it('the decision key is distinct from the same action under upheld', async () => {
    const t = setup();
    const a = decisionKey(t.subjects, { reportId: 'r', verdict: 'noted', actions: [t.note('s1')], actor: 'x', reason: 'y' });
    const b = decisionKey(t.subjects, { reportId: 'r', verdict: 'upheld', actions: [t.note('s1')], actor: 'x', reason: 'y' });
    expect(a).not.toBe(b);
  });
});

describe('decide: notes inside other verdicts', () => {
  it('upheld with ONLY notes: report actioned, no notice for anyone, and NO reporter feedback', async () => {
    const t = setup();
    const { reportId, target, reporter } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [t.note(target)] }));
    expect(res.groups[0]?.noticeId).toBeNull();
    expect(t.store.loadReport(reportId)?.status).toBe('actioned');
    expect(t.store.rawNotices()).toEqual([]);
    expect(t.notices.pending(reporter)).toEqual([]);
    expect(t.pushed).toEqual([]);
  });

  it('upheld with a note AND a warning: the warning notifies, the note does not, and the reporter is told once', async () => {
    const t = setup();
    const { reportId, target, reporter } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [t.note(target), t.warn(target)] }));
    expect(res.groups).toHaveLength(2);
    const byKind = new Map(t.store.rawSanctions().map((r) => [r.kind, r.groupId]));
    const noteGroup = res.groups.find((g) => g.groupId === byKind.get('note'));
    const warnGroup = res.groups.find((g) => g.groupId === byKind.get('warning'));
    expect(noteGroup?.noticeId).toBeNull();
    expect(typeof warnGroup?.noticeId).toBe('string');
    expect(t.notices.pending(target).map((n) => n.kind)).toEqual(['warning']);
    expect(t.notices.pending(reporter).map((n) => n.kind)).toEqual(['report_outcome']);
    expect(t.store.rawNotices()).toHaveLength(2);
  });

  it('upheld with a note on one person and a chat restriction on another: feedback is sent (a non-note action exists)', async () => {
    const t = setup();
    const { reportId, target, bystander, reporter } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.note(bystander), t.chat(target)] }));
    expect(t.notices.pending(reporter).map((n) => n.kind)).toEqual(['report_outcome']);
    expect(t.notices.pending(bystander)).toEqual([]);
    expect(t.notices.pending(target).map((n) => n.kind)).toEqual(['chat']);
  });

  it('upheld with a note and no other action twice-checked: a note on the reporter alone is no feedback either', async () => {
    const t = setup();
    const { reportId, reporter } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.note(reporter)] }));
    expect(t.notices.pending(reporter)).toEqual([]);
  });

  it.each(['no_action', 'bad_faith'] as const)('%s may write a note on the reporter: no notice, never on the target', async (verdict) => {
    const t = setup();
    const { reportId, target, reporter } = await t.table();
    expect(await t.decide(reportId, { verdict, actions: [t.note(target)] })).toEqual({ ok: false, error: 'invalid' });
    okOf(await t.decide(reportId, { verdict, actions: [t.note(reporter)] }));
    expect(t.store.rawSanctions().map((r) => r.kind)).toEqual(['note']);
    expect(t.store.rawNotices()).toEqual([]);
  });

  it('every action a decision writes carries the report\'s room, whatever its kind', async () => {
    const t = setup();
    const { reportId, target, room } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.warn(target), t.chat(target, { includeIp: false })] }));
    expect(t.store.rawSanctions().map((r) => r.roomId)).toEqual([room, room]);
  });

  it('includeIp rows of a decision carry the room too', async () => {
    const t = setup();
    const room = 'ipr2';
    t.sit(room, 'p1', who('ip-rep2'));
    const target = t.sit(room, 'p2', who('ip-tgt2', null, 'iphash2'));
    t.say(room, 'p2', 'hello');
    const reportId = await t.file(room);
    okOf(await t.decide(reportId, { actions: [t.chat(target, { includeIp: true })] }));
    expect(t.store.rawSanctions().map((r) => r.roomId)).toEqual([room, room]);
  });
});

describe('decide: bad_faith evidence', () => {
  const invalid = { ok: false, error: 'invalid' };

  it('is stored on the report, trimmed; loadReport returns it', async () => {
    const t = setup();
    const { reportId } = await t.table();
    okOf(await t.decide(reportId, { verdict: 'bad_faith', evidence: '  three false reports tonight  ' }));
    expect(t.store.loadReport(reportId)).toMatchObject({ badFaith: true, badFaithEvidence: 'three false reports tonight' });
  });

  it('is null on an open report and on every other verdict', async () => {
    const t = setup();
    const a = await t.table();
    expect(t.store.loadReport(a.reportId)?.badFaithEvidence).toBeNull();
    okOf(await t.decide(a.reportId, { verdict: 'upheld' }));
    expect(t.store.loadReport(a.reportId)?.badFaithEvidence).toBeNull();
    const b = await t.table();
    okOf(await t.decide(b.reportId, { verdict: 'no_action' }));
    expect(t.store.loadReport(b.reportId)?.badFaithEvidence).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['blank', '   \t\n '],
    ['501 characters', 'x'.repeat(501)],
    ['501 characters after trimming', ` ${'x'.repeat(501)} `],
    ['a number', 7],
    ['null', null],
    ['an object', { text: 'x' }],
  ])('a bad_faith verdict with evidence that is %s is invalid and writes nothing', async (_name, evidence) => {
    const t = setup();
    const { reportId } = await t.table();
    const before = t.snapshot();
    expect(await t.decide(reportId, { verdict: 'bad_faith', evidence: evidence as never })).toEqual(invalid);
    expect(t.snapshot()).toEqual(before);
    expect(t.store.loadReport(reportId)?.status).toBe('open');
  });

  it('exactly 500 characters is accepted (also with padding that trims away); 1 character is accepted', async () => {
    const t = setup();
    const a = await t.table();
    okOf(await t.decide(a.reportId, { verdict: 'bad_faith', evidence: ` ${'x'.repeat(500)} ` }));
    expect(t.store.loadReport(a.reportId)?.badFaithEvidence).toBe('x'.repeat(500));
    const b = await t.table();
    okOf(await t.decide(b.reportId, { verdict: 'bad_faith', evidence: 'x' }));
  });

  it.each(['upheld', 'no_action', 'noted'] as const)('evidence with the %s verdict is invalid, even empty', async (verdict) => {
    const t = setup();
    const { reportId } = await t.table();
    const before = t.snapshot();
    for (const evidence of ['why not', '', '   ']) {
      expect(await t.decide(reportId, { verdict, evidence })).toEqual(invalid);
    }
    expect(t.snapshot()).toEqual(before);
  });

  it('evidence is not part of the idempotency key: the same decision with reworded evidence is a replay', async () => {
    const t = setup();
    const { reportId } = await t.table();
    okOf(await t.decide(reportId, { verdict: 'bad_faith', evidence: 'first wording' }));
    const again = okOf(await t.decide(reportId, { verdict: 'bad_faith', evidence: 'second wording' }));
    expect(again.replay).toBe(true);
    expect(t.store.loadReport(reportId)?.badFaithEvidence).toBe('first wording');
  });

  it('is staff only: it is in no notice, no pending value, no record, no decision result and no log line', async () => {
    const t = setup();
    const secret = 'EVIDENCE-MARKER-9f3a';
    const { reportId, reporter, target, bystander } = await t.table();
    const res = okOf(await t.decide(reportId, { verdict: 'bad_faith', evidence: secret, actions: [t.chat(reporter, { rule: 4 })] }));
    expect(JSON.stringify(res)).not.toContain(secret);
    for (const person of [reporter, target, bystander]) {
      expect(JSON.stringify(t.notices.pending(person))).not.toContain(secret);
      expect(JSON.stringify(t.notices.record(person))).not.toContain(secret);
    }
    expect(JSON.stringify(t.store.rawNotices())).not.toContain(secret);
    expect(JSON.stringify(t.store.rawSanctions())).not.toContain(secret);
    expect(JSON.stringify(t.store.rawDecisions())).not.toContain(secret);
    expect(JSON.stringify(t.logs)).not.toContain(secret);
    // ...and it IS on the staff-only report.
    expect(t.store.loadReport(reportId)?.badFaithEvidence).toBe(secret);
  });

  it('a failing decision rolls the evidence back with the rest', async () => {
    const t = setup({ store: new FailOnDecision() });
    const { reportId } = await t.table();
    await expect(t.decide(reportId, { verdict: 'bad_faith', evidence: 'rolled back' })).rejects.toThrow('disk full');
    expect(t.store.loadReport(reportId)).toMatchObject({ status: 'open', badFaith: false, badFaithEvidence: null });
  });
});

describe('decide: validation (nothing is written on any failure)', () => {
  const invalid = { ok: false, error: 'invalid' };

  it('not_found for an unknown report', async () => {
    const t = setup();
    expect(await t.decide('no-such-report')).toEqual({ ok: false, error: 'not_found' });
    expect(t.snapshot().decisions).toEqual([]);
  });

  it('a foreign lineId is refused and nothing is written', async () => {
    const t = setup();
    const { reportId, target, lines } = await t.table();
    const before = t.snapshot();
    expect(await t.decide(reportId, { actions: [t.warn(target, { lineIds: [lines.bystander] })] })).toEqual(invalid);
    expect(await t.decide(reportId, { actions: [t.warn(target, { lineIds: [lines.target, lines.reporter] })] })).toEqual(invalid);
    expect(t.snapshot()).toEqual(before);
    expect(t.pushed).toEqual([]);
    expect(activeChat(t, target)).toBeNull();
  });

  it('a line id that is not in the excerpt at all is refused', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    expect(await t.decide(reportId, { actions: [t.warn(target, { lineIds: ['nope'] })] })).toEqual(invalid);
    expect(t.snapshot().sanctions).toEqual([]);
  });

  it('more than five lines is refused; a non-array lineIds is refused', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(await t.decide(reportId, { actions: [t.warn(target, { lineIds: six })] })).toEqual(invalid);
    expect(await t.decide(reportId, { actions: [t.warn(target, { lineIds: 'x' as never })] })).toEqual(invalid);
    expect(t.store.loadReport(reportId)?.status).toBe('open');
  });

  it('a second action with a foreign line stops the whole decision, including the first (valid) action', async () => {
    const t = setup();
    const { reportId, target, bystander, lines } = await t.table();
    const before = t.snapshot();
    expect(
      await t.decide(reportId, { actions: [t.warn(target, { lineIds: [lines.target] }), t.warn(bystander, { lineIds: [lines.target] })] }),
    ).toEqual(invalid);
    expect(t.snapshot()).toEqual(before);
  });

  it("the target's own lines become the notice excerpt, and nobody else's do", async () => {
    const t = setup();
    const { reportId, target, lines } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.warn(target, { lineIds: [lines.target, lines.target2] })] }));
    const [n] = t.notices.pending(target);
    expect(n?.excerpt.map((l) => l.text)).toEqual(['target says one', 'target says two']);
    expect(JSON.stringify(n)).not.toContain('bystander');
    expect(JSON.stringify(n)).not.toContain('reporter says');
  });

  it("a merged alias's line is the person's own line", async () => {
    const t = setup();
    const room = 'merge-room';
    t.sit(room, 'p1', who('mr'));
    const old = t.sit(room, 'p2', who('old-key'));
    t.clock.t = NOW + 1;
    const newer = t.person(who('new-key')); // created later, so the older subject survives a merge
    t.clock.t = NOW;
    const line = t.say(room, 'p2', 'said as the old key');
    const reportId = await t.file(room);
    t.person(who('old-key', 'acct-merge'));
    t.person(who('new-key', 'acct-merge'));
    expect(t.subjects.canonical(newer)).toBe(old);
    okOf(await t.decide(reportId, { actions: [t.warn(newer, { lineIds: [line] })] }));
    expect(t.notices.pending(old)[0]?.excerpt.map((l) => l.text)).toEqual(['said as the old key']);
  });

  it('a retired rule is refused; so are an unknown rule, 0, a fraction and NaN', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    for (const rule of [9, 99, 0, 1.5, Number.NaN, -1, '3' as never]) {
      expect(await t.decide(reportId, { actions: [t.warn(target, { rule })] })).toEqual(invalid);
    }
    expect(t.snapshot().sanctions).toEqual([]);
    expect(t.store.loadReport(reportId)?.status).toBe('open');
  });

  it('an active rule added later is citable', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.warn(target, { rule: 10 })] }));
  });

  it('uncovered with no gapNote is refused; with a blank or over-long one too', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    for (const gapNote of [undefined, '', '   ', 'x'.repeat(501)]) {
      expect(await t.decide(reportId, { actions: [t.warn(target, { rule: 'uncovered', ...(gapNote === undefined ? {} : { gapNote }) })] })).toEqual(invalid);
    }
    expect(t.snapshot().sanctions).toEqual([]);
  });

  it('uncovered with a gap note opens a gap; the note never reaches the player', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.warn(target, { rule: 'uncovered', gapNote: 'no rule covers griefing the lobby' })] }));
    expect(t.store.rawSanctions()[0]).toMatchObject({ rule: 'uncovered', gapStatus: 'open', gapNote: 'no rule covers griefing the lobby' });
    const [n] = t.notices.pending(target);
    expect(n?.rule).toBe('uncovered');
    expect(JSON.stringify(n)).not.toContain('griefing');
  });

  it('a gap note on a numbered rule is refused', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    expect(await t.decide(reportId, { actions: [t.warn(target, { rule: 2, gapNote: 'stray' })] })).toEqual(invalid);
  });

  it.each([undefined, '', '   ', 'x'.repeat(501), 5 as never])('a bad reason (%j) is refused', async (reason) => {
    const t = setup();
    const { reportId } = await t.table();
    expect(await t.decide(reportId, { reason: reason as string })).toEqual(invalid);
    expect(t.store.loadReport(reportId)?.status).toBe('open');
  });

  it('a 500-character reason is accepted', async () => {
    const t = setup();
    const { reportId } = await t.table();
    okOf(await t.decide(reportId, { reason: 'r'.repeat(500) }));
  });

  it('a blank or missing actor is refused', async () => {
    const t = setup();
    const { reportId } = await t.table();
    expect(await t.decide(reportId, { actor: '' })).toEqual(invalid);
    expect(await t.decide(reportId, { actor: undefined as never })).toEqual(invalid);
  });

  it.each([
    ['an unknown verdict', { verdict: 'maybe' as never }],
    ['actions that are not a list', { actions: 'x' as never }],
    ['a null action', { actions: [null as never] }],
    ['an unknown kind', { actions: [{ subject: 's', kind: 'mute' as never, durationMs: 1000, rule: 1 }] }],
    ['a missing subject', { actions: [{ subject: '', kind: 'chat' as const, durationMs: 1000, rule: 1 }] }],
    ['an unknown source', { source: 'robot' as never }],
    ['a report id that is not a string', { reportId: 7 as never }],
  ])('%s is refused without throwing', async (_name, over) => {
    const t = setup();
    const { reportId } = await t.table();
    const before = t.snapshot();
    await expect(t.decisions.decide({ reportId, verdict: 'upheld', actions: [], actor: 'm', reason: 'r', ...over } as DecisionInput)).resolves.toEqual(invalid);
    expect(t.snapshot()).toEqual(before);
  });

  it.each([
    ['a warning with a duration', (s: SubjectId) => ({ subject: s, kind: 'warning' as const, durationMs: DAY, rule: 1 })],
    ['a warning with includeIp', (s: SubjectId) => ({ subject: s, kind: 'warning' as const, durationMs: null, rule: 1, includeIp: true })],
    ['a chat restriction of zero length', (s: SubjectId) => ({ subject: s, kind: 'chat' as const, durationMs: 0, rule: 1 })],
    ['a negative duration', (s: SubjectId) => ({ subject: s, kind: 'ban' as const, durationMs: -5, rule: 1 })],
    ['a NaN duration', (s: SubjectId) => ({ subject: s, kind: 'area' as const, durationMs: Number.NaN, rule: 1 })],
    ['an infinite duration', (s: SubjectId) => ({ subject: s, kind: 'chat' as const, durationMs: Number.POSITIVE_INFINITY, rule: 1 })],
  ])('%s is refused and nothing is written', async (_name, make) => {
    const t = setup();
    const { reportId, target } = await t.table();
    const before = t.snapshot();
    expect(await t.decide(reportId, { actions: [t.warn(target), make(target)] })).toEqual(invalid);
    expect(t.snapshot()).toEqual(before);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'a %s duration is invalid even when a matching permanent decision exists (no false replay)',
    async (bad) => {
      const t = setup();
      const { reportId, target } = await t.table();
      const permanent = okOf(await t.decide(reportId, { actions: [{ subject: target, kind: 'ban', durationMs: null, rule: 1 }] }));
      expect(permanent.replay).toBe(false);
      const after = t.snapshot();
      expect(await t.decide(reportId, { actions: [{ subject: target, kind: 'ban', durationMs: bad, rule: 1 }] })).toEqual(invalid);
      expect(t.snapshot()).toEqual(after);
    },
  );

  it('decisionKey refuses a non-finite duration instead of keying it as permanent', () => {
    const t = setup();
    const a = t.person(who('ka-nf'));
    const mk = (durationMs: number | null): DecisionInput => ({
      reportId: 'r', verdict: 'upheld', actions: [{ subject: a, kind: 'ban', durationMs, rule: 1 }], actor: 'x', reason: 'y',
    });
    expect(() => decisionKey(t.subjects, mk(Number.POSITIVE_INFINITY))).toThrow();
    expect(() => decisionKey(t.subjects, mk(Number.NaN))).toThrow();
    expect(decisionKey(t.subjects, mk(null))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('after the report ages out and is purged, the decision is not_found', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const input = { actions: [t.warn(target)] };
    okOf(await t.decide(reportId, input));
    t.clock.t = NOW + 100 * DAY;
    expect((await purge(t.store, t.clock.now())).reports).toBe(1);
    expect(await t.decide(reportId, input)).toEqual({ ok: false, error: 'not_found' });
  });

  it('the same kind twice for one person is refused (it would double the sanction)', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    expect(await t.decide(reportId, { actions: [t.warn(target), t.warn(target)] })).toEqual(invalid);
    expect(t.snapshot().sanctions).toEqual([]);
  });

  it('a store read that throws rejects with the store error (not a silent invalid)', async () => {
    class BadRead extends MemoryStore {
      override loadReport(): never {
        throw new Error('disk full');
      }
    }
    const t = setup({ store: new BadRead() });
    await expect(t.decide('x')).rejects.toThrow('disk full');
  });
});

describe('decide: idempotent', () => {
  it('the same decision twice replays: same groups, no second sanction, notice or push', async () => {
    const t = setup();
    const { reportId, target, reporter } = await t.table();
    const input = { actions: [t.warn(target, { lineIds: [] }), t.chat(target)] };
    const first = okOf(await t.decide(reportId, input));
    const after = t.snapshot();
    const pushedAfter = t.pushed.length;
    const second = okOf(await t.decide(reportId, input));
    expect(second.replay).toBe(true);
    expect(second.groups).toEqual(first.groups);
    expect(t.snapshot()).toEqual(after);
    expect(t.pushed).toHaveLength(pushedAfter);
    expect(t.notices.pending(target)).toHaveLength(2);
    expect(t.notices.pending(reporter)).toHaveLength(1);
    expect(t.store.rawSanctions()).toHaveLength(2);
  });

  it('a double click (two calls in flight) applies once', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const [a, b] = await Promise.all([t.decide(reportId, { actions: [t.warn(target)] }), t.decide(reportId, { actions: [t.warn(target)] })]);
    expect([okOf(a).replay, okOf(b).replay].sort()).toEqual([false, true]);
    expect(t.store.rawSanctions()).toHaveLength(1);
    expect(t.store.rawNotices().filter((n) => n.kind === 'warning')).toHaveLength(1);
  });

  it('the order of the actions does not matter', async () => {
    const t = setup();
    const { reportId, target, bystander } = await t.table();
    const first = okOf(await t.decide(reportId, { actions: [t.warn(target), t.warn(bystander), t.chat(target)] }));
    const second = okOf(await t.decide(reportId, { actions: [t.chat(target), t.warn(bystander), t.warn(target)] }));
    expect(second.replay).toBe(true);
    expect(second.groups).toEqual(first.groups);
  });

  it('an alias of the person replays (the key uses the canonical subject)', async () => {
    const t = setup();
    const { reportId, target } = await t.table('ra1', 'ta1');
    const alias = t.person(who('ta1-other', 'acct-a'));
    t.person(who('ta1', 'acct-a'));
    const canon = t.subjects.canonical(target);
    const other = canon === target ? alias : target;
    expect(t.subjects.canonical(other)).toBe(canon);
    const first = okOf(await t.decide(reportId, { actions: [t.warn(canon)] }));
    const second = okOf(await t.decide(reportId, { actions: [t.warn(other)] }));
    expect(second.replay).toBe(true);
    expect(second.groups).toEqual(first.groups);
    expect(t.store.rawSanctions()).toHaveLength(1);
  });

  it('a different reason or actor with the same verdict and actions is still a replay', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const first = okOf(await t.decide(reportId, { actions: [t.warn(target)], reason: 'one', actor: 'a' }));
    const second = okOf(await t.decide(reportId, { actions: [t.warn(target)], reason: 'two', actor: 'b' }));
    expect(second.replay).toBe(true);
    expect(second.groups).toEqual(first.groups);
    expect(t.store.loadReport(reportId)).toMatchObject({ actionedBy: 'a', modNote: 'one' });
  });

  it('a replay still answers after the rule was retired since', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const first = okOf(await t.decide(reportId, { actions: [t.warn(target)] }));
    const retired = new CommunityRules(STARTER_RULES.map((r) => (r.number === 2 ? { ...r, retired: true } : r)));
    const again = new DecisionService({ store: t.store, subjects: t.subjects, rules: retired, notices: t.notices, clock: t.clock, index: t.index });
    const second = okOf(await again.decide({ reportId, verdict: 'upheld', actions: [t.warn(target)], actor: 'a', reason: 'r' }));
    expect(second.replay).toBe(true);
    expect(second.groups).toEqual(first.groups);
  });

  it('a different decision on a closed report is already_decided and changes nothing', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.warn(target)] }));
    const after = t.snapshot();
    expect(await t.decide(reportId, { actions: [t.chat(target)] })).toEqual({ ok: false, error: 'already_decided' });
    expect(await t.decide(reportId, { verdict: 'no_action' })).toEqual({ ok: false, error: 'already_decided' });
    expect(await t.decide(reportId, { verdict: 'bad_faith' })).toEqual({ ok: false, error: 'already_decided' });
    expect(await t.decide(reportId, { actions: [] })).toEqual({ ok: false, error: 'already_decided' });
    expect(t.snapshot()).toEqual(after);
  });

  it('an invalid input on a closed report is invalid, not already_decided', async () => {
    const t = setup();
    const { reportId } = await t.table();
    okOf(await t.decide(reportId));
    expect(await t.decide(reportId, { reason: '' })).toEqual({ ok: false, error: 'invalid' });
  });

  it('a lost close race (report closed between the check and the write) is already_decided and writes nothing else', async () => {
    class Racy extends MemoryStore {
      override closeReport(): boolean {
        return false; // someone else closed it first
      }
    }
    const t = setup({ store: new Racy() });
    const { reportId, target } = await t.table();
    expect(await t.decide(reportId, { actions: [t.warn(target)] })).toEqual({ ok: false, error: 'already_decided' });
    expect(t.snapshot().sanctions).toEqual([]);
    expect(t.snapshot().notices).toEqual([]);
    expect(t.pushed).toEqual([]);
  });

  it('decisionKey: order-free, canonical, and sensitive to the report, the verdict and every action field', () => {
    const t = setup();
    const a = t.person(who('ka'));
    const b = t.person(who('kb'));
    const base = (over: Partial<DecisionInput> = {}): DecisionInput => ({
      reportId: 'r1',
      verdict: 'upheld',
      actions: [t.warn(a), t.chat(b)],
      actor: 'x',
      reason: 'y',
      ...over,
    });
    const k = decisionKey(t.subjects, base());
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(decisionKey(t.subjects, base({ actions: [t.chat(b), t.warn(a)] }))).toBe(k);
    expect(decisionKey(t.subjects, base({ actor: 'other', reason: 'other' }))).toBe(k);
    expect(decisionKey(t.subjects, base({ reportId: 'r2' }))).not.toBe(k);
    expect(decisionKey(t.subjects, base({ verdict: 'no_action' }))).not.toBe(k);
    expect(decisionKey(t.subjects, base({ verdict: 'bad_faith', evidence: 'e' }))).not.toBe(k);
    expect(decisionKey(t.subjects, base({ verdict: 'bad_faith', evidence: 'e' }))).not.toBe(decisionKey(t.subjects, base({ verdict: 'no_action' })));
    // the old names are no longer decisions at all
    expect(() => decisionKey(t.subjects, base({ verdict: 'fair' as never }))).toThrow();
    expect(() => decisionKey(t.subjects, base({ verdict: 'unfair' as never }))).toThrow();
    expect(decisionKey(t.subjects, base({ actions: [t.warn(a)] }))).not.toBe(k);
    expect(decisionKey(t.subjects, base({ actions: [t.warn(a), t.chat(b, { durationMs: 2 * DAY })] }))).not.toBe(k);
    expect(decisionKey(t.subjects, base({ actions: [t.warn(a), t.chat(b, { rule: 3 })] }))).not.toBe(k);
    expect(decisionKey(t.subjects, base({ actions: [t.warn(a), t.chat(b, { includeIp: true })] }))).not.toBe(k);
    expect(decisionKey(t.subjects, base({ actions: [t.warn(a), t.chat(b, { lineIds: ['1'] })] }))).not.toBe(k);
    // includeIp false is the same as absent, and the line order does not matter
    expect(decisionKey(t.subjects, base({ actions: [t.warn(a), t.chat(b, { includeIp: false })] }))).toBe(k);
    expect(decisionKey(t.subjects, base({ actions: [t.warn(a), t.chat(b, { lineIds: ['2', '1'] })] }))).toBe(
      decisionKey(t.subjects, base({ actions: [t.warn(a), t.chat(b, { lineIds: ['1', '2'] })] })),
    );
  });

  it('keys do not collide across report ids that run into the verdict', () => {
    const t = setup();
    const k1 = decisionKey(t.subjects, { reportId: 'ab', verdict: 'upheld', actions: [], actor: 'x', reason: 'y' });
    const k2 = decisionKey(t.subjects, { reportId: 'a', verdict: 'upheld', actions: [], actor: 'x', reason: 'y' });
    expect(k1).not.toBe(k2);
  });
});

describe('decide: atomic', () => {
  it('a store throw on the second action leaves no report change, sanction, notice or decision, and the index stays empty', async () => {
    const t = setup({ store: new FailOnSecondSanction() });
    const { reportId, target, bystander } = await t.table();
    const before = t.snapshot();
    await expect(t.decide(reportId, { actions: [t.warn(target), t.chat(bystander)] })).rejects.toThrow('disk full');
    expect(t.snapshot()).toEqual(before);
    expect(t.store.loadReport(reportId)?.status).toBe('open');
    expect(activeChat(t, bystander)).toBeNull();
    expect(t.pushed).toEqual([]);
  });

  it('a failing sanction does not make the index see an earlier action of the same decision', async () => {
    const t = setup({ store: new FailOnSecondSanction() });
    const { reportId, target, bystander } = await t.table();
    await expect(t.decide(reportId, { actions: [t.chat(target), t.chat(bystander)] })).rejects.toThrow();
    expect(activeChat(t, target)).toBeNull();
    expect(activeChat(t, bystander)).toBeNull();
  });

  it('after a failed attempt the same decision can be sent again and applies once', async () => {
    const store = new FailOnSecondSanction();
    const t = setup({ store });
    const { reportId, target, bystander } = await t.table();
    await expect(t.decide(reportId, { actions: [t.chat(target), t.chat(bystander)] })).rejects.toThrow();
    store.n = 100; // the disk is back
    const res = okOf(await t.decide(reportId, { actions: [t.chat(target), t.chat(bystander)] }));
    expect(res.replay).toBe(false);
    expect(t.store.rawSanctions()).toHaveLength(2);
    expect(activeChat(t, target)).not.toBeNull();
  });

  it.each([
    ['the first notice', 1],
    ['the second notice', 2],
    ['the reporter outcome', 3],
  ])('a store throw on %s rolls back everything', async (_name, at) => {
    const t = setup({ store: new FailOnNotice(at) });
    const { reportId, target, bystander } = await t.table();
    const before = t.snapshot();
    await expect(t.decide(reportId, { actions: [t.chat(target), t.chat(bystander)] })).rejects.toThrow('disk full');
    expect(t.snapshot()).toEqual(before);
    expect(activeChat(t, target)).toBeNull();
    expect(t.pushed).toEqual([]);
  });

  it('a store throw recording the decision rolls back everything', async () => {
    const t = setup({ store: new FailOnDecision() });
    const { reportId, target } = await t.table();
    const before = t.snapshot();
    await expect(t.decide(reportId, { actions: [t.chat(target)] })).rejects.toThrow('disk full');
    expect(t.snapshot()).toEqual(before);
    expect(activeChat(t, target)).toBeNull();
  });

  it('a store throw closing the report writes nothing', async () => {
    const t = setup({ store: new FailOnClose() });
    const { reportId, target } = await t.table();
    await expect(t.decide(reportId, { actions: [t.chat(target)] })).rejects.toThrow('disk full');
    expect(t.snapshot().sanctions).toEqual([]);
    expect(t.snapshot().notices).toEqual([]);
  });

  it('the error that escapes carries no identifier (it is the store error as raised)', async () => {
    const t = setup({ store: new FailOnDecision() });
    const { reportId, target } = await t.table();
    const err = await t.decide(reportId, { actions: [t.chat(target)] }).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(target);
  });
});

describe('decide: pushes and hooks run after the commit', () => {
  it('announces once per distinct person: each target and the reporter', async () => {
    const t = setup();
    const { reportId, target, bystander, reporter } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.warn(target), t.chat(target), t.warn(bystander)] }));
    expect(t.pushed.map((p) => p.subject).sort()).toEqual([target, bystander, reporter].sort());
    expect(t.pushed.find((p) => p.subject === target)?.count).toBe(2);
    expect(t.pushed.find((p) => p.subject === reporter)?.count).toBe(1);
  });

  it('a push sees the committed decision: the report closed and every notice written', async () => {
    const probe: Array<{ notices: number; status: string | undefined }> = [];
    const store = new MemoryStore();
    const t = setup({
      store,
      notify: () => {
        const id = store.rawReports()[0]?.id;
        probe.push({ notices: store.rawNotices().length, status: id === undefined ? undefined : store.loadReport(id)?.status });
      },
    });
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.warn(target), t.chat(target)] }));
    expect(probe.length).toBe(2); // the target and the reporter
    for (const p of probe) expect(p).toEqual({ notices: 3, status: 'actioned' }); // two sanction notices + the reporter outcome
  });

  it('no push for no_action or bad_faith without actions', async () => {
    const t = setup();
    const a = await t.table();
    okOf(await t.decide(a.reportId, { verdict: 'no_action' }));
    const b = await t.table();
    okOf(await t.decide(b.reportId, { verdict: 'bad_faith' }));
    expect(t.pushed).toEqual([]);
  });

  it('a notify hook that throws or rejects never fails the decision', async () => {
    const throwing = setup({ notify: () => { throw new Error('hook boom'); } });
    const a = await throwing.table();
    okOf(await throwing.decide(a.reportId, { actions: [throwing.warn(a.target)] }));
    expect(throwing.store.loadReport(a.reportId)?.status).toBe('actioned');

    const rejecting = setup({ notify: () => Promise.reject(new Error('async boom')) });
    const b = await rejecting.table();
    okOf(await rejecting.decide(b.reportId, { actions: [rejecting.warn(b.target)] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(rejecting.logs.some((l) => l.event === 'notices.notify_failed')).toBe(true);
  });

  it('a hook error is logged by class only, with no identifier', async () => {
    const t = setup({ notify: () => { throw new RangeError('secret-detail'); } });
    const { reportId, target } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.warn(target)] }));
    const logged = JSON.stringify(t.logs);
    expect(logged).not.toContain('secret-detail');
    expect(logged).not.toContain(target);
  });

  it('works without an index (the host has none): rows are still written', async () => {
    const t = setup();
    const bare = new DecisionService({ store: t.store, subjects: t.subjects, rules, notices: t.notices, clock: t.clock });
    const { reportId, target } = await t.table();
    okOf(await bare.decide({ reportId, verdict: 'upheld', actions: [t.chat(target)], actor: 'm', reason: 'r' }));
    expect(t.store.rawSanctions()).toHaveLength(1);
  });
});

describe('decide: reporter feedback', () => {
  it('only on upheld with at least one applied action, and once', async () => {
    const t = setup();
    const a = await t.table();
    okOf(await t.decide(a.reportId, { actions: [t.warn(a.target), t.chat(a.target)] }));
    expect(t.store.rawNotices().filter((n) => n.kind === 'report_outcome')).toHaveLength(1);
    // a replay does not add another
    okOf(await t.decide(a.reportId, { actions: [t.warn(a.target), t.chat(a.target)] }));
    expect(t.store.rawNotices().filter((n) => n.kind === 'report_outcome')).toHaveLength(1);
  });

  it('never for no_action, bad_faith or an upheld decision with no actions', async () => {
    const t = setup();
    const a = await t.table();
    const b = await t.table();
    const c = await t.table();
    okOf(await t.decide(a.reportId, { verdict: 'no_action' }));
    okOf(await t.decide(b.reportId, { verdict: 'bad_faith' }));
    okOf(await t.decide(c.reportId, { actions: [] }));
    expect(t.store.rawNotices()).toEqual([]);
  });

  it('the reporter outcome carries nothing about the other player', async () => {
    const t = setup();
    const { reportId, target, reporter } = await t.table();
    okOf(await t.decide(reportId, { actions: [t.chat(target)] }));
    const [n] = t.notices.pending(reporter);
    expect(n).toEqual({ id: expect.any(String), kind: 'report_outcome', rule: null, ruleLabel: null, until: null, refCode: null, excerpt: [], createdAt: NOW, mustAcknowledge: false });
  });

  it('goes to the canonical reporter even when the report names an alias', async () => {
    const t = setup();
    const { reportId, target, reporter } = await t.table('rr1', 'tt1');
    const alias = t.person(who('rr1-alt', 'acct-r'));
    t.person(who('rr1', 'acct-r'));
    okOf(await t.decide(reportId, { actions: [t.warn(target)] }));
    expect(t.notices.pending(alias).map((n) => n.kind)).toEqual(['report_outcome']);
    expect(t.notices.pending(reporter).map((n) => n.kind)).toEqual(['report_outcome']);
  });
});

describe('revokeAndWithdraw', () => {
  it('revokes the sanction, frees the index and withdraws the unseen notice', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [t.chat(target)] }));
    const group = res.groups[0];
    expect(activeChat(t, target)).not.toBeNull();
    const out = await revokeAndWithdraw(t.store, group?.groupId ?? '', 'mod-b', 'appeal upheld', { notices: t.notices, clock: t.clock, index: t.index });
    expect(out).toEqual({ revoked: true, withdrawn: 1 });
    expect(activeChat(t, target)).toBeNull();
    expect(t.notices.pending(target)).toEqual([]);
    expect(t.notices.record(target)).toEqual([]);
    expect(t.store.rawSanctions()[0]).toMatchObject({ revokedBy: 'mod-b', revokeReason: 'appeal upheld' });
  });

  it('a seen notice leaves "My record" once its sanction is revoked', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [t.warn(target)] }));
    const noticeId = res.groups[0]?.noticeId ?? '';
    expect(t.notices.ack(target, noticeId)).toBe(true);
    expect(t.notices.record(target)).toHaveLength(1);
    await revokeAndWithdraw(t.store, res.groups[0]?.groupId ?? '', 'mod-b', 'oops', { notices: t.notices, clock: t.clock, index: t.index });
    expect(t.notices.record(target)).toEqual([]);
    expect(t.notices.pendingWarning(target)).toBe(false);
  });

  it('only that group is revoked; the other notice stays', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [t.warn(target), t.chat(target)] }));
    const chatGroup = res.groups.find((g) => t.store.rawSanctions().find((r) => r.groupId === g.groupId)?.kind === 'chat');
    await revokeAndWithdraw(t.store, chatGroup?.groupId ?? '', 'mod-b', 'x', { notices: t.notices, clock: t.clock, index: t.index });
    expect(t.notices.pending(target).map((n) => n.kind)).toEqual(['warning']);
  });

  it('an unknown group changes nothing; a second revoke keeps the first and reports false', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [t.chat(target)] }));
    const deps = { notices: t.notices, clock: t.clock, index: t.index };
    expect(await revokeAndWithdraw(t.store, 'nope', 'm', 'r', deps)).toEqual({ revoked: false, withdrawn: 0 });
    const groupId = res.groups[0]?.groupId ?? '';
    expect(await revokeAndWithdraw(t.store, groupId, 'first', 'r1', deps)).toMatchObject({ revoked: true });
    expect(await revokeAndWithdraw(t.store, groupId, 'second', 'r2', deps)).toEqual({ revoked: false, withdrawn: 0 });
    expect(t.store.rawSanctions()[0]?.revokedBy).toBe('first');
  });

  it('is atomic: a failure withdrawing leaves the sanction un-revoked and in the index', async () => {
    class FailWithdraw extends MemoryStore {
      override withdrawNoticeGroup(): never {
        throw new Error('disk full');
      }
    }
    const t = setup({ store: new FailWithdraw() });
    const { reportId, target } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [t.chat(target)] }));
    await expect(
      revokeAndWithdraw(t.store, res.groups[0]?.groupId ?? '', 'mod-b', 'x', { notices: t.notices, clock: t.clock, index: t.index }),
    ).rejects.toThrow('disk full');
    expect(t.store.rawSanctions()[0]?.revokedAt).toBeNull();
    expect(activeChat(t, target)).not.toBeNull();
    expect(t.notices.pending(target)).toHaveLength(1);
  });

  it('works without an index', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const res = okOf(await t.decide(reportId, { actions: [t.chat(target)] }));
    const out = await revokeAndWithdraw(t.store, res.groups[0]?.groupId ?? '', 'm', 'r', { notices: t.notices, clock: t.clock });
    expect(out.revoked).toBe(true);
  });
});

describe('decide: the kind of each group', () => {
  it('every group names the kind of the action that made it, in a mixed decision', async () => {
    const t = setup();
    const { reportId, target, bystander } = await t.table();
    const res = okOf(
      await t.decide(reportId, {
        actions: [
          t.chat(target),
          t.note(bystander),
          { subject: target, kind: 'ban', durationMs: 2 * DAY, rule: 2 },
          t.warn(target),
        ],
      }),
    );
    expect(res.replay).toBe(false);
    const stored = t.store.rawSanctions();
    expect(res.groups).toHaveLength(4);
    for (const g of res.groups) {
      // Cross-check against what was written under that group id.
      expect(stored.find((s) => s.groupId === g.groupId)?.kind, g.refCode).toBe(g.kind);
    }
    expect(res.groups.map((g) => [g.subject, g.kind]).sort()).toEqual(
      [
        [target, 'ban'],
        [target, 'chat'],
        [target, 'warning'],
        [bystander, 'note'],
      ].sort(),
    );
  });

  it('a replay returns the same kinds, also after the person was merged under another id', async () => {
    const t = setup();
    const { reportId, target, bystander } = await t.table('rk-m', 'tk-m');
    const alias = t.person(who('tk-m-other', 'acct-merge-kind'));
    t.person(who('tk-m', 'acct-merge-kind')); // merges the two subjects
    const canon = t.subjects.canonical(target);
    const other = canon === target ? alias : target;
    expect(t.subjects.canonical(other)).toBe(canon);
    const first = okOf(await t.decide(reportId, { actions: [t.warn(canon), t.chat(canon), t.note(bystander)] }));
    // The same decision, naming the person by their other id.
    const again = okOf(await t.decide(reportId, { actions: [t.warn(other), t.chat(other), t.note(bystander)] }));
    expect(again.replay).toBe(true);
    expect(again.groups).toEqual(first.groups);
    expect(again.groups.map((g) => g.kind).sort()).toEqual(['chat', 'note', 'warning']);
    for (const g of again.groups) expect(first.groups.find((f) => f.groupId === g.groupId)?.kind).toBe(g.kind);
  });

  it('a decision with no actions has no groups (control)', async () => {
    const t = setup();
    const { reportId } = await t.table();
    expect(okOf(await t.decide(reportId, { verdict: 'no_action' })).groups).toEqual([]);
  });
});

describe('decide: the duration cap', () => {
  it('a duration over 365 days is invalid and writes nothing; exactly 365 days is applied', async () => {
    const t = setup();
    const { reportId, target } = await t.table();
    const before = t.snapshot();
    for (const durationMs of [MAX_SANCTION_DURATION_MS + 1, 9e15, Number.MAX_SAFE_INTEGER]) {
      expect(await t.decide(reportId, { actions: [{ subject: target, kind: 'ban', durationMs, rule: 2 }] })).toEqual({ ok: false, error: 'invalid' });
    }
    expect(t.snapshot()).toEqual(before);
    const ok = okOf(await t.decide(reportId, { actions: [{ subject: target, kind: 'ban', durationMs: MAX_SANCTION_DURATION_MS, rule: 2 }] }));
    expect(ok.groups[0]?.kind).toBe('ban');
  });
});
