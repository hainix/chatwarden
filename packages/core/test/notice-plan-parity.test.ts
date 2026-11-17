import { describe, expect, it } from 'vitest';
import { CommunityRules, STARTER_RULES } from '../src/rules.js';
import type { RuleRef } from '../src/rules.js';
import { appealReplacementEnd, planNotices } from '../src/noticeCopy.js';
import type { NoticeOp, PlanAction, PlanContext } from '../src/noticeCopy.js';
import type { Matcher, RawWho, SanctionKind } from '../src/types.js';
import type { PlayerNotice } from '../src/notices.js';
import { appealsKit } from './appealsWorld.js';
import { DAY, HOUR, world } from './reportingWorld.js';

// Review Focus 2: the plan agrees with the services. The real services run over a matrix, and what they write for each person
// (kind, order, recipient, rule label, end, excerpt text and day, acknowledge flag) equals what the plan says they will write.
// Synthetic terms only.

const matcher: Matcher = {
  match: (t) => (/zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null),
  spans: (t) => {
    const out: Array<{ start: number; end: number; termId: string }> = [];
    for (const m of t.matchAll(/zorbak/gi)) out.push({ start: m.index, end: m.index + m[0].length, termId: 'syn:zorbak' });
    return out;
  },
};
const rules = new CommunityRules([...STARTER_RULES, { number: 9, title: 'Old rule', text: 'No longer applies.', retired: true }]);

type Who = 'target' | 'reporter' | 'third';
interface Step {
  who: Who;
  kind: SanctionKind;
  durationMs?: number | null;
  rule?: RuleRef;
  lines?: number;
}
interface Case {
  name: string;
  verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith';
  steps: Step[];
  rename?: number;
  feedback?: boolean;
}

const KEY: Record<Who, string> = { target: 'key-target-tarvo', reporter: 'key-reporter-glarn', third: 'key-third-snerp' };
const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
const isMessage = (n: PlayerNotice): boolean => ['report_outcome', 'rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked'].includes(n.kind);

/** What a notice shows once the parts a plan cannot know (its id, its real reference) are set aside. */
const shape = (n: PlayerNotice) => ({
  kind: n.kind,
  rule: n.rule,
  ruleLabel: n.ruleLabel,
  until: n.until,
  hasRef: n.refCode !== null,
  excerpt: n.excerpt,
  createdAt: n.createdAt,
  mustAcknowledge: n.mustAcknowledge,
});

async function run(c: Case) {
  const w = await world({
    matcher,
    rules,
    limits: { reporterFeedback: c.feedback ?? true },
    overrides: { names: { renames: true } },
  });
  const { cw, clock } = w;
  const room = 'room-parity';
  cw.rooms.seat(room, 'p1', { clientKey: KEY.reporter }, 'Rep');
  cw.rooms.seat(room, 'p2', { clientKey: KEY.target }, 'Tgt');
  cw.rooms.seat(room, 'p3', { clientKey: KEY.third }, 'Thr');
  const seats: Record<Who, string> = { reporter: 'p1', target: 'p2', third: 'p3' };
  // Every person writes lines, a blocked one among them, so an excerpt has masked text.
  for (const who of ['target', 'reporter', 'third'] as const) {
    for (const text of ['hello there', 'you play like a zorbak', 'good game', 'another line', 'fifth line', 'sixth line']) {
      cw.chat.accept(room, seats[who], text);
      clock.t += 1000;
    }
  }
  const res = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
  if (!res.ok) throw new Error(`refused ${res.refused}`);
  const report = cw.reports.get(res.reportId);
  if (report === null) throw new Error('no report');
  const ref: Record<Who, string> = {
    target: report.targetPerson,
    reporter: report.reporterPerson,
    third: cw.rooms.subjectAt(room, 'p3') as string,
  };
  const own = (who: Who): string[] => report.ownLineIds[ref[who]] ?? [];
  const lineById = new Map(report.excerpt.map((l) => [l.lineId, l]));
  const pickLines = (who: Who, n: number) => own(who).slice(0, n);
  clock.t += 5000;

  const ctx: PlanContext = { now: clock.now, ruleLabel: (r) => cw.rules.label(r), reporterFeedback: c.feedback ?? true, appeals: false, refCode: 'WILL-BE-MADE' };
  const actions: PlanAction[] = c.steps.map((s) => ({
    person: ref[s.who],
    kind: s.kind,
    durationMs: s.kind === 'warning' || s.kind === 'note' ? null : s.durationMs === undefined ? DAY : s.durationMs,
    rule: s.rule ?? 2,
    lines: pickLines(s.who, s.lines ?? 0).map((id) => {
      const line = lineById.get(id);
      if (line === undefined) throw new Error('no line');
      return { text: cw.notices.lineText(line), day: dayOf(line.ts) };
    }),
  }));
  const op: NoticeOp = { op: 'decide', verdict: c.verdict, target: ref.target, reporter: ref.reporter, actions, rename: c.rename === undefined ? null : { rule: c.rename } };
  const plan = planNotices(op, ctx);

  const decided = await cw.decide({
    reportId: res.reportId,
    verdict: c.verdict,
    actor: 'mod_ann',
    reason: 'private reason',
    ...(c.verdict === 'bad_faith' ? { evidence: 'a pattern of false reports' } : {}),
    actions: c.steps.map((s, i) => ({
      subject: ref[s.who],
      kind: s.kind,
      durationMs: actions[i]?.durationMs ?? null,
      rule: s.rule ?? 2,
      lineIds: pickLines(s.who, s.lines ?? 0),
      ...(s.rule === 'uncovered' ? { gapNote: 'a private gap note' } : {}),
    })),
  } as never);
  if (!decided.ok) throw new Error(`decide refused: ${decided.error}`);
  if (c.rename !== undefined) {
    const asked = cw.names.requireRename({ subject: ref.target, actor: 'mod_ann', reason: 'the name breaks the rules', rule: c.rename });
    if (!asked.ok) throw new Error(`rename refused: ${asked.error}`);
  }
  const real = (who: Who): PlayerNotice[] => cw.notices.pending({ clientKey: KEY[who] } as RawWho);
  return { plan, ref, real };
}

const MATRIX: Case[] = [
  { name: 'fair, a warning', verdict: 'upheld', steps: [{ who: 'target', kind: 'warning' }] },
  { name: 'fair, chat', verdict: 'upheld', steps: [{ who: 'target', kind: 'chat' }] },
  { name: 'fair, area', verdict: 'upheld', steps: [{ who: 'target', kind: 'area', durationMs: 2 * HOUR }] },
  { name: 'fair, a permanent ban', verdict: 'upheld', steps: [{ who: 'target', kind: 'ban', durationMs: null }] },
  { name: 'fair, a timed ban', verdict: 'upheld', steps: [{ who: 'target', kind: 'ban', durationMs: 7 * DAY }] },
  { name: 'warning plus chat', verdict: 'upheld', steps: [{ who: 'target', kind: 'warning' }, { who: 'target', kind: 'chat' }] },
  { name: 'warning plus ban', verdict: 'upheld', steps: [{ who: 'target', kind: 'ban' }, { who: 'target', kind: 'warning' }] },
  { name: 'chat plus area', verdict: 'upheld', steps: [{ who: 'target', kind: 'chat' }, { who: 'target', kind: 'area' }] },
  { name: 'two people', verdict: 'upheld', steps: [{ who: 'third', kind: 'chat' }, { who: 'target', kind: 'warning' }, { who: 'target', kind: 'chat' }] },
  { name: 'note only', verdict: 'noted', steps: [{ who: 'target', kind: 'note' }] },
  { name: 'note plus warning', verdict: 'upheld', steps: [{ who: 'target', kind: 'note' }, { who: 'target', kind: 'warning' }] },
  { name: 'a note on two people', verdict: 'upheld', steps: [{ who: 'target', kind: 'note' }, { who: 'third', kind: 'note' }] },
  { name: 'dismissal', verdict: 'no_action', steps: [] },
  { name: 'dismissal with a note on the reporter', verdict: 'no_action', steps: [{ who: 'reporter', kind: 'note' }] },
  { name: 'bad faith, no sanction', verdict: 'bad_faith', steps: [] },
  { name: 'bad faith, a sanction on the reporter', verdict: 'bad_faith', steps: [{ who: 'reporter', kind: 'chat' }] },
  { name: 'bad faith, a warning on the reporter', verdict: 'bad_faith', steps: [{ who: 'reporter', kind: 'warning' }] },
  { name: 'upheld with a sanction on the reporter', verdict: 'upheld', steps: [{ who: 'reporter', kind: 'warning' }] },
  { name: 'reporterFeedback off', verdict: 'upheld', steps: [{ who: 'target', kind: 'chat' }], feedback: false },
  { name: 'reporterFeedback off, a note plus a warning', verdict: 'upheld', steps: [{ who: 'target', kind: 'note' }, { who: 'target', kind: 'warning' }], feedback: false },
  { name: 'an uncovered rule', verdict: 'upheld', steps: [{ who: 'target', kind: 'chat', rule: 'uncovered' }] },
  { name: 'zero lines', verdict: 'upheld', steps: [{ who: 'target', kind: 'chat', lines: 0 }] },
  { name: 'one line', verdict: 'upheld', steps: [{ who: 'target', kind: 'chat', lines: 1 }] },
  { name: 'two lines, one blocked', verdict: 'upheld', steps: [{ who: 'target', kind: 'warning', lines: 2 }] },
  { name: 'five lines', verdict: 'upheld', steps: [{ who: 'target', kind: 'ban', lines: 5 }] },
  { name: 'lines on two people', verdict: 'upheld', steps: [{ who: 'target', kind: 'chat', lines: 3 }, { who: 'third', kind: 'warning', lines: 2 }] },
  { name: 'rename alone', verdict: 'upheld', steps: [], rename: 7 },
  { name: 'rename plus a warning', verdict: 'upheld', steps: [{ who: 'target', kind: 'warning' }], rename: 7 },
  { name: 'rename plus chat', verdict: 'upheld', steps: [{ who: 'target', kind: 'chat' }], rename: 7 },
  { name: 'rename plus area', verdict: 'upheld', steps: [{ who: 'target', kind: 'area' }], rename: 7 },
  { name: 'rename plus a ban', verdict: 'upheld', steps: [{ who: 'target', kind: 'ban' }], rename: 7 },
  { name: 'rename plus a ban, feedback off', verdict: 'upheld', steps: [{ who: 'target', kind: 'ban' }], rename: 7, feedback: false },
  { name: 'rename plus a note', verdict: 'upheld', steps: [{ who: 'target', kind: 'note' }], rename: 7 },
];

describe('for the whole matrix, the notices cw.notices.pending returns for each person equal the plan', () => {
  it.each(MATRIX.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const { plan, ref, real } = await run(c);
    for (const who of ['target', 'reporter', 'third'] as const) {
      const planned = plan.notices.filter((n) => n.to === ref[who]).map((n) => shape(n.notice));
      const actual = real(who).map(shape);
      expect(actual, `${c.name}: ${who}`).toEqual(planned);
    }
  });

  it('the plan names exactly the people the services wrote notices for (nobody else is told)', async () => {
    for (const c of MATRIX) {
      const { plan, ref, real } = await run(c);
      const told = (['target', 'reporter', 'third'] as const).filter((who) => real(who).length > 0).map((who) => ref[who]);
      expect([...new Set(plan.notices.map((n) => n.to))].sort(), c.name).toEqual([...told].sort());
    }
  });

  it('a sanction notice has a real reference and the plan has a placeholder for it; a message notice has none in either', async () => {
    const { plan, real } = await run({ name: 'x', verdict: 'upheld', steps: [{ who: 'target', kind: 'chat' }], rename: 7 });
    for (const n of real('target')) expect(n.refCode !== null, n.kind).toBe(!isMessage(n));
    for (const n of plan.notices.filter((p) => p.to === plan.notices[0]?.to)) expect(n.notice.refCode !== null, n.notice.kind).toBe(!isMessage(n.notice));
  });

  it('the plan names no notice for a person when the services wrote none: a dismissal and a note (nothing is set)', async () => {
    for (const c of MATRIX.filter((m) => m.name === 'dismissal' || m.name === 'bad faith, no sanction')) {
      const { plan, real } = await run(c);
      expect(plan.notices).toEqual([]);
      expect(plan.nothing).toBe('dismissal');
      expect([...real('target'), ...real('reporter'), ...real('third')]).toEqual([]);
    }
    const note = await run({ name: 'n', verdict: 'noted', steps: [{ who: 'target', kind: 'note' }] });
    expect(note.plan.nothing).toBe('note');
    expect(note.real('target')).toEqual([]);
  });

  it('the effects name the same ends as the notices', async () => {
    const { plan, real, ref } = await run({ name: 'x', verdict: 'upheld', steps: [{ who: 'target', kind: 'ban', durationMs: 3 * DAY }, { who: 'target', kind: 'warning' }], rename: 7 });
    const ban = real('target').find((n) => n.kind === 'ban');
    expect(plan.effects).toContainEqual({ code: 'banned', to: ref.target, until: ban?.until });
    expect(plan.effects).toContainEqual({ code: 'warning_on_record', to: ref.target });
    expect(plan.effects).toContainEqual({ code: 'rename_asked', to: ref.target, later: true });
  });
});

describe('reporterFeedback off removes the thank-you in both', () => {
  it('on and off, for the same decision', async () => {
    const on = await run({ name: 'on', verdict: 'upheld', steps: [{ who: 'target', kind: 'warning' }] });
    const off = await run({ name: 'off', verdict: 'upheld', steps: [{ who: 'target', kind: 'warning' }], feedback: false });
    expect(on.plan.notices.some((n) => n.notice.kind === 'report_outcome')).toBe(true);
    expect(on.real('reporter').map((n) => n.kind)).toEqual(['report_outcome']);
    expect(off.plan.notices.some((n) => n.notice.kind === 'report_outcome')).toBe(false);
    expect(off.real('reporter')).toEqual([]);
  });
});

describe('an uncovered, a retired and an unknown rule label the same in both', () => {
  it('uncovered: the decision and the plan say the same', async () => {
    const { plan, real } = await run({ name: 'x', verdict: 'upheld', steps: [{ who: 'target', kind: 'chat', rule: 'uncovered' }] });
    expect(real('target')[0]?.ruleLabel).toBe('Not covered by a rule yet');
    expect(plan.notices[0]?.notice.ruleLabel).toBe(real('target')[0]?.ruleLabel);
  });

  it('retired and unknown: the context label is the service label (a retired rule keeps its title, an unknown number has none)', async () => {
    const w = await world({ rules });
    const ctx: PlanContext = { now: w.clock.now, ruleLabel: (r) => w.cw.rules.label(r), reporterFeedback: true, appeals: true, refCode: 'x' };
    const plan = planNotices({ op: 'decide', verdict: 'upheld', target: 'a', reporter: 'b', actions: [{ person: 'a', kind: 'warning', durationMs: null, rule: 9, lines: [] }, { person: 'a', kind: 'chat', durationMs: DAY, rule: 99, lines: [] }], rename: null }, ctx);
    expect(plan.notices.slice(0, 2).map((n) => n.notice.ruleLabel)).toEqual([w.cw.rules.label(99), w.cw.rules.label(9)]);
    expect(w.cw.rules.label(9)).toContain('Old rule');
    expect(w.cw.rules.label(99)).toBe('Community Rule 99');
  });
});

describe('a direct sanction, a rename and a revoke', () => {
  it('a direct sanction writes no notice (the plan says none and what the player does see: chat is off)', async () => {
    const w = await world({ matcher });
    const t = w.table();
    const subject = t.target;
    const plan = planNotices({ op: 'sanction', kind: 'chat', durationMs: DAY }, { now: w.clock.now, ruleLabel: (r) => w.cw.rules.label(r), reporterFeedback: true, appeals: true, refCode: 'x' });
    await w.cw.sanctions.apply({ kind: 'chat', subject, includeIp: false, durationMs: DAY, reason: 'private', actor: 'mod_ann', source: 'moderator', automated: false, rule: 2 });
    expect(plan.notices).toEqual([]);
    expect(plan.nothing).toBe('direct');
    expect(w.cw.notices.pending({ clientKey: 'key-target-1' })).toEqual([]);
    expect(w.cw.chat.accept(t.room, 'p2', 'hello')).toHaveProperty('refuse');
    expect(plan.effects).toEqual([{ code: 'chat_off', to: 'player', until: w.clock.now() + DAY }]);
  });

  it('a rename writes the one notice the plan says, with that rule label', async () => {
    const w = await world({ overrides: { names: { renames: true } } });
    const t = w.table();
    const plan = planNotices({ op: 'rename', rule: 7 }, { now: w.clock.now, ruleLabel: (r) => w.cw.rules.label(r), reporterFeedback: true, appeals: true, refCode: 'x' });
    expect(w.cw.names.requireRename({ subject: t.target, actor: 'mod_ann', reason: 'the name breaks the rules', rule: 7 }).ok).toBe(true);
    const pending = w.cw.notices.pending({ clientKey: 'key-target-1' });
    expect(pending.map(shape)).toEqual(plan.notices.map((n) => shape(n.notice)));
  });

  it.each(['chat', 'area', 'ban', 'warning'] as const)('revoke %s: the notice is withdrawn, the plan says none is sent and what lifts', async (kind) => {
    const k = await appealsKit({}, {});
    const s = await k.sanction({ kind, durationMs: kind === 'warning' ? null : 6 * HOUR });
    const plan = planNotices({ op: 'revoke', kind }, { now: k.clock.now, ruleLabel: (r) => k.cw.rules.label(r), reporterFeedback: true, appeals: true, refCode: 'x' });
    expect(k.cw.notices.pending(s.who).map((n) => n.kind)).toEqual([kind]);
    await k.cw.sanctions.revoke(s.groupId, 'mod_bea', 'private');
    expect(k.cw.notices.pending(s.who)).toEqual([]);
    expect(k.cw.notices.record(s.who)).toEqual([]);
    expect(plan.notices).toEqual([]);
    expect(plan.effects[0]).toEqual({ code: 'lifts', kind, to: 'player' });
    if (kind === 'chat') expect(k.cw.chat.accept(s.room, 'p2', 'hello again')).toHaveProperty('deliver');
  });
});

describe('an appeal decision: the notices cw.notices.pending returns equal the plan', () => {
  type Sub = NonNullable<Parameters<Awaited<ReturnType<typeof appealsKit>>['sanction']>[0]>;
  type Lighter = { kind: 'warning' | 'chat' | 'area' | 'ban'; durationMs: number | null };
  const cases: Array<{ name: string; sub: Sub; outcome: 'uphold' | 'reduce' | 'revoke'; to?: Lighter; wait?: number }> = [
    { name: 'keep', sub: { kind: 'ban', durationMs: null }, outcome: 'uphold' },
    { name: 'keep a timed chat restriction', sub: { kind: 'chat', durationMs: 6 * HOUR }, outcome: 'uphold' },
    { name: 'remove', sub: { kind: 'chat', durationMs: 6 * HOUR }, outcome: 'revoke' },
    { name: 'remove a permanent ban', sub: { kind: 'ban', durationMs: null, rule: 3 }, outcome: 'revoke' },
    { name: 'remove a warning', sub: { kind: 'warning' }, outcome: 'revoke' },
    { name: 'lighter: ban to chat', sub: { kind: 'ban', durationMs: null, rule: 3 }, outcome: 'reduce', to: { kind: 'chat', durationMs: 12 * HOUR }, wait: 2 * DAY },
    { name: 'lighter: a permanent ban to a permanent chat restriction', sub: { kind: 'ban', durationMs: null }, outcome: 'reduce', to: { kind: 'chat', durationMs: null } },
    { name: 'lighter: shorter, same kind', sub: { kind: 'chat', durationMs: 6 * HOUR }, outcome: 'reduce', to: { kind: 'chat', durationMs: 2 * HOUR } },
    { name: 'lighter: to a warning', sub: { kind: 'area', durationMs: DAY }, outcome: 'reduce', to: { kind: 'warning', durationMs: null } },
    { name: 'lighter, already over', sub: { kind: 'ban', durationMs: null }, outcome: 'reduce', to: { kind: 'chat', durationMs: HOUR }, wait: 2 * DAY },
    { name: 'lighter, longer than the original end', sub: { kind: 'ban', durationMs: DAY }, outcome: 'reduce', to: { kind: 'area', durationMs: 30 * DAY } },
  ];

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const s = await k.sanction(c.sub);
    const filed = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'It was not me.' });
    if (!filed.ok) throw new Error('filing refused');
    const row = k.store.rawSanctions().find((r) => r.groupId === s.groupId && r.targetType === 'subject');
    if (row === undefined) throw new Error('no sanction row');
    if (c.wait !== undefined) k.clock.t += c.wait;
    const original = { kind: row.kind as SanctionKind, startsAt: row.startsAt, endsAt: row.endsAt ?? null, rule: (c.sub.rule ?? 2) as RuleRef, refCode: s.refCode };
    const plan = planNotices(
      { op: 'appeal', outcome: c.outcome, original, ...(c.to === undefined ? {} : { to: c.to }) },
      { now: k.clock.now, ruleLabel: (r) => k.cw.rules.label(r), reporterFeedback: true, appeals: true, refCode: 'WILL-BE-MADE' },
    );
    const res = await k.cw.appeals.decide({ appealId: filed.appeal.id, outcome: c.outcome, actor: 'mod_bea', reason: 'private appeal reason', ...(c.to === undefined ? {} : { to: c.to }) });
    expect(res.ok).toBe(true);
    // The original notice is the one the appeal was filed from: not part of what the decision wrote.
    const wrote = k.cw.notices.pending(s.who).filter((n) => n.id !== s.noticeId);
    expect(wrote.map(shape)).toEqual(plan.notices.map((n) => shape(n.notice)));
    if (c.outcome !== 'uphold') expect(k.store.rawNotices().find((n) => n.id === s.noticeId)?.withdrawnAt).not.toBeNull();
  });
});

describe('appealReplacementEnd equals what the appeals service writes and is never later than the original end', () => {
  const cases: Array<[string, SanctionKind, number | null, { kind: 'warning' | 'chat' | 'area' | 'ban'; durationMs: number | null }]> = [
    ['shorter', 'ban', DAY, { kind: 'chat', durationMs: 2 * HOUR }],
    ['longer than the original', 'ban', DAY, { kind: 'area', durationMs: 30 * DAY }],
    ['the same length', 'ban', DAY, { kind: 'area', durationMs: DAY }],
    ['permanent original', 'ban', null, { kind: 'chat', durationMs: 3 * HOUR }],
    ['permanent choice of a timed original', 'ban', DAY, { kind: 'area', durationMs: null }],
  ];
  it.each(cases)('%s', async (_name, kind, durationMs, to) => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const s = await k.sanction({ kind: kind as 'ban', durationMs });
    const filed = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'It was not me.' });
    if (!filed.ok) throw new Error('filing refused');
    const row = k.store.rawSanctions().find((r) => r.groupId === s.groupId && r.targetType === 'subject');
    if (row === undefined) throw new Error('no row');
    const res = await k.cw.appeals.decide({ appealId: filed.appeal.id, outcome: 'reduce', actor: 'mod_bea', reason: 'private appeal reason', to });
    expect(res.ok).toBe(true);
    const group = (res as { replacementGroupId: string }).replacementGroupId;
    const written = k.store.rawSanctions().find((r) => r.groupId === group && r.targetType === 'subject');
    const end = appealReplacementEnd({ startsAt: row.startsAt, endsAt: row.endsAt ?? null }, to);
    expect(written?.endsAt ?? null).toBe(end);
    if (row.endsAt !== null && end !== null) expect(end).toBeLessThanOrEqual(row.endsAt);
    if (row.endsAt !== null) expect(end).not.toBeNull();
  });

  it('is never later than the original end, over a grid of lengths', () => {
    for (const original of [1000, 5000, 1_000_000]) {
      for (const length of [1, 999, 1000, 4000, 5000, 999_999, 5_000_000]) {
        const end = appealReplacementEnd({ startsAt: 0, endsAt: original }, { durationMs: length });
        expect(end).not.toBeNull();
        expect(end as number).toBeLessThanOrEqual(original);
        expect(end as number).toBeLessThanOrEqual(length);
      }
    }
  });
});
