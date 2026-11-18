import { describe, expect, it } from 'vitest';
import { appealReplacementEnd, planNotices } from '../src/noticeCopy.js';
import type { NoticeOp, PlanAction, PlanContext } from '../src/noticeCopy.js';

// planNotices (0.2.0): what an action sends to the player, from the form alone. Synthetic terms only. No store, no service.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  now: () => NOW,
  ruleLabel: (ref) => (ref === 'uncovered' ? 'Not covered by a rule yet' : `Community Rule ${ref}`),
  reporterFeedback: true,
  appeals: true,
  refCode: 'REF-PLACEHOLDER',
  ...over,
});
const act = (person: string, kind: PlanAction['kind'], over: Partial<PlanAction> = {}): PlanAction => ({
  person,
  kind,
  durationMs: kind === 'warning' || kind === 'note' ? null : DAY,
  rule: 2,
  lines: [],
  ...over,
});
type Decide = Extract<NoticeOp, { op: 'decide' }>;
const decide = (actions: PlanAction[], over: Partial<Decide> = {}): NoticeOp => ({ op: 'decide', verdict: 'upheld', target: 'P-bob', reporter: 'P-rep', actions, rename: null, ...over });
const kindsOf = (op: NoticeOp, c: PlanContext = ctx()): Array<[string, string]> => planNotices(op, c).notices.map((n) => [n.to, n.notice.kind]);

describe('plan: a decision', () => {
  it('one kind: its notice (rule label, end, reference placeholder, acknowledge flag) and then the reporter thank-you', () => {
    const plan = planNotices(decide([act('P-bob', 'chat', { lines: [{ text: 'you are a *****', day: '2027-01-15' }] })]), ctx());
    expect(plan.nothing).toBeNull();
    expect(plan.notices.map((n) => n.to)).toEqual(['P-bob', 'P-rep']);
    expect(plan.notices[0]?.notice).toMatchObject({
      kind: 'chat',
      rule: 2,
      ruleLabel: 'Community Rule 2',
      until: NOW + DAY,
      refCode: 'REF-PLACEHOLDER',
      excerpt: [{ text: 'you are a *****', day: '2027-01-15' }],
      createdAt: NOW,
      mustAcknowledge: false,
    });
    expect(plan.notices[1]?.notice).toMatchObject({ kind: 'report_outcome', rule: null, ruleLabel: null, until: null, refCode: null, excerpt: [] });
    expect(plan.effects).toEqual([{ code: 'chat_off', to: 'P-bob', until: NOW + DAY }]);
  });

  it.each([
    ['warning', null, null],
    ['chat', DAY, NOW + DAY],
    ['area', 2 * HOUR, NOW + 2 * HOUR],
    ['ban', null, null],
    ['ban', 30 * DAY, NOW + 30 * DAY],
  ] as const)('each kind alone: %s for %s ends %s', (kind, durationMs, until) => {
    const plan = planNotices(decide([act('P-bob', kind, { durationMs })]), ctx());
    expect(plan.notices[0]?.notice).toMatchObject({ kind, until, mustAcknowledge: kind === 'warning' });
    expect(plan.notices[1]?.notice.kind).toBe('report_outcome');
  });

  it('a warning has no end of its own even when a length is sent', () => {
    expect(planNotices(decide([act('P-bob', 'warning', { durationMs: HOUR })]), ctx()).notices[0]?.notice.until).toBeNull();
  });

  it('pairs of kinds on one person come out in the core order (by kind text), whatever order they were given', () => {
    const forward = kindsOf(decide([act('P-bob', 'warning'), act('P-bob', 'ban')]));
    const backward = kindsOf(decide([act('P-bob', 'ban'), act('P-bob', 'warning')]));
    expect(forward).toEqual([['P-bob', 'ban'], ['P-bob', 'warning'], ['P-rep', 'report_outcome']]);
    expect(backward).toEqual(forward);
    expect(kindsOf(decide([act('P-bob', 'chat'), act('P-bob', 'area')]))).toEqual([['P-bob', 'area'], ['P-bob', 'chat'], ['P-rep', 'report_outcome']]);
  });

  it('two people: by person, then kind, then the reporter', () => {
    const k = kindsOf(decide([act('P-zed', 'chat'), act('P-bob', 'warning'), act('P-bob', 'chat'), act('P-amy', 'ban')]));
    expect(k).toEqual([['P-amy', 'ban'], ['P-bob', 'chat'], ['P-bob', 'warning'], ['P-zed', 'chat'], ['P-rep', 'report_outcome']]);
  });

  it('a warning and a chat restriction both get a notice (warning plus chat)', () => {
    const plan = planNotices(decide([act('P-bob', 'warning'), act('P-bob', 'chat')]), ctx());
    expect(plan.notices.map((n) => n.notice.kind)).toEqual(['chat', 'warning', 'report_outcome']);
    expect(plan.effects).toEqual([{ code: 'chat_off', to: 'P-bob', until: NOW + DAY }, { code: 'warning_on_record', to: 'P-bob' }]);
  });

  it('note only: no notice, no thank-you, nothing = note', () => {
    expect(planNotices(decide([act('P-bob', 'note')]), ctx())).toEqual({ notices: [], effects: [], nothing: 'note' });
  });

  it('note plus warning: only the warning is sent, and the note adds nothing (not even a thank-you of its own)', () => {
    const plan = planNotices(decide([act('P-bob', 'note'), act('P-bob', 'warning')]), ctx());
    expect(plan.notices.map((n) => n.notice.kind)).toEqual(['warning', 'report_outcome']);
    expect(plan.nothing).toBeNull();
  });

  it('a note alone never thanks the reporter, even beside a note on another person', () => {
    const plan = planNotices(decide([act('P-bob', 'note'), act('P-amy', 'note')]), ctx());
    expect(plan.notices).toEqual([]);
    expect(plan.nothing).toBe('note');
  });

  it('a dismissal (no action) sends nothing to anyone', () => {
    expect(planNotices(decide([], { verdict: 'no_action' }), ctx())).toEqual({ notices: [], effects: [], nothing: 'dismissal' });
  });

  it('bad faith with no sanction sends nothing; bad faith with a sanction on the reporter sends that notice to them and no thank-you', () => {
    expect(planNotices(decide([], { verdict: 'bad_faith' }), ctx())).toEqual({ notices: [], effects: [], nothing: 'dismissal' });
    const plan = planNotices(decide([act('P-rep', 'chat')], { verdict: 'bad_faith' }), ctx());
    expect(plan.notices.map((n) => [n.to, n.notice.kind])).toEqual([['P-rep', 'chat']]);
    // The reporter is told (their own sanction notice is in the plan), so the plan never says they are not.
    expect(plan.effects).not.toContainEqual({ code: 'reporter_not_told' });
  });

  it('"the person who reported is not told" only when the reporter has no notice in the plan', () => {
    const told = { code: 'reporter_not_told' } as const;
    // Bad faith with a sanction on someone else: only that person is told, the reporter is not.
    expect(planNotices(decide([act('P-bob', 'chat')], { verdict: 'bad_faith' }), ctx()).effects).toContainEqual(told);
    // Bad faith with a sanction on the reporter, and with a note on the reporter (a note sends nothing): control for each side.
    expect(planNotices(decide([act('P-rep', 'ban')], { verdict: 'bad_faith' }), ctx()).effects).not.toContainEqual(told);
    expect(planNotices(decide([act('P-rep', 'note')], { verdict: 'bad_faith' }), ctx()).effects).not.toContainEqual(told);
    // Upheld with feedback off and a sanction on the reporter: their own sanction notice is in the plan.
    expect(planNotices(decide([act('P-rep', 'warning')]), ctx({ reporterFeedback: false })).effects).not.toContainEqual(told);
    // Upheld with feedback off and a sanction on the target: nobody tells the reporter.
    expect(planNotices(decide([act('P-bob', 'warning')]), ctx({ reporterFeedback: false })).effects).toContainEqual(told);
    // A rename alone tells only the target.
    expect(planNotices(decide([], { rename: { rule: 7 } }), ctx()).effects).toContainEqual(told);
    // Nothing sent at all adds no line.
    expect(planNotices(decide([], { verdict: 'no_action' }), ctx()).effects).not.toContainEqual(told);
  });

  it('upheld with a sanction on the reporter: the reporter gets the sanction notice and then the thank-you', () => {
    expect(kindsOf(decide([act('P-rep', 'warning')]))).toEqual([['P-rep', 'warning'], ['P-rep', 'report_outcome']]);
  });

  it('reporterFeedback off removes the thank-you and says the reporter is not told', () => {
    const plan = planNotices(decide([act('P-bob', 'chat')]), ctx({ reporterFeedback: false }));
    expect(plan.notices.map((n) => n.notice.kind)).toEqual(['chat']);
    expect(plan.effects).toContainEqual({ code: 'reporter_not_told' });
    expect(planNotices(decide([act('P-bob', 'chat')]), ctx()).effects).not.toContainEqual({ code: 'reporter_not_told' });
  });

  it('rename alone: the rename notice (rule label, no reference, no end, no lines), no thank-you, the reporter is not told', () => {
    const plan = planNotices(decide([], { rename: { rule: 7 } }), ctx());
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]).toMatchObject({ to: 'P-bob', notice: { kind: 'rename_required', rule: 7, ruleLabel: 'Community Rule 7', until: null, refCode: null, excerpt: [], mustAcknowledge: false } });
    expect(plan.effects).toEqual([{ code: 'rename_asked', to: 'P-bob', later: false }, { code: 'reporter_not_told' }]);
    expect(plan.nothing).toBeNull();
  });

  it.each(['warning', 'chat', 'area', 'ban'] as const)('rename plus a %s: the rename notice is last (after the thank-you), for the target', (kind) => {
    const plan = planNotices(decide([act('P-bob', kind)], { rename: { rule: 7 } }), ctx());
    expect(plan.notices.map((n) => n.notice.kind)).toEqual([kind, 'report_outcome', 'rename_required']);
    expect(plan.notices.at(-1)?.to).toBe('P-bob');
    expect(plan.effects).toContainEqual({ code: 'rename_asked', to: 'P-bob', later: kind === 'area' || kind === 'ban' });
  });

  it('rename plus a ban on someone else is not later for the target', () => {
    const plan = planNotices(decide([act('P-amy', 'ban')], { rename: { rule: 7 } }), ctx());
    expect(plan.effects).toContainEqual({ code: 'rename_asked', to: 'P-bob', later: false });
  });

  it('five lines are shown at most, in the order given; none is a notice with no lines', () => {
    const lines = Array.from({ length: 8 }, (_, i) => ({ text: `line ${i}`, day: '2027-01-15' }));
    expect(planNotices(decide([act('P-bob', 'chat', { lines })]), ctx()).notices[0]?.notice.excerpt.map((l) => l.text)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
    expect(planNotices(decide([act('P-bob', 'chat')]), ctx()).notices[0]?.notice.excerpt).toEqual([]);
  });

  it('an uncovered rule and an unknown one take the label the context gives', () => {
    const plan = planNotices(decide([act('P-bob', 'warning', { rule: 'uncovered' }), act('P-bob', 'chat', { rule: 99 })]), ctx());
    expect(plan.notices.slice(0, 2).map((n) => n.notice.ruleLabel)).toEqual(['Community Rule 99', 'Not covered by a rule yet']);
  });

  it('the plan reads the clock when called, so a later call moves the end', () => {
    let t = NOW;
    const c = ctx({ now: () => t });
    const op = decide([act('P-bob', 'chat')]);
    expect(planNotices(op, c).notices[0]?.notice.until).toBe(NOW + DAY);
    t += 5 * 60_000;
    expect(planNotices(op, c).notices[0]?.notice.until).toBe(NOW + 5 * 60_000 + DAY);
  });

  it('it does not change the op it was given', () => {
    const op = decide([act('P-bob', 'warning'), act('P-bob', 'ban')]);
    const copy = structuredClone(op);
    planNotices(op, ctx());
    expect(op).toEqual(copy);
  });
});

describe('plan: a direct sanction, a note, a rename, a revoke, a dismissal', () => {
  it('a direct restriction sends no notice and says what the player does see: chat off until the end', () => {
    expect(planNotices({ op: 'sanction', kind: 'chat', durationMs: DAY }, ctx())).toEqual({ notices: [], effects: [{ code: 'chat_off', to: 'player', until: NOW + DAY }], nothing: 'direct' });
    expect(planNotices({ op: 'sanction', kind: 'chat', durationMs: null }, ctx()).effects).toEqual([{ code: 'chat_off', to: 'player', until: null }]);
  });

  it('area and ban are direct too; a warning is on the record for staff only', () => {
    expect(planNotices({ op: 'sanction', kind: 'area', durationMs: HOUR }, ctx())).toMatchObject({ nothing: 'direct', effects: [{ code: 'area_off', until: NOW + HOUR }] });
    expect(planNotices({ op: 'sanction', kind: 'ban', durationMs: null }, ctx())).toMatchObject({ nothing: 'direct', effects: [{ code: 'banned', until: null }] });
    expect(planNotices({ op: 'sanction', kind: 'warning', durationMs: null }, ctx())).toMatchObject({ nothing: 'direct', effects: [{ code: 'warning_staff_only' }] });
  });

  it('a note (as a sanction or as the note form) sends nothing and says it is for the team', () => {
    expect(planNotices({ op: 'sanction', kind: 'note', durationMs: null }, ctx())).toEqual({ notices: [], effects: [], nothing: 'note' });
    expect(planNotices({ op: 'note' }, ctx())).toEqual({ notices: [], effects: [], nothing: 'note' });
  });

  it('a rename: the rename notice and its effect', () => {
    const plan = planNotices({ op: 'rename', rule: 7 }, ctx());
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]?.notice).toMatchObject({ kind: 'rename_required', rule: 7, ruleLabel: 'Community Rule 7', refCode: null, until: null });
    expect(plan.effects).toEqual([{ code: 'rename_asked', to: 'player', later: false }]);
    expect(plan.nothing).toBeNull();
  });

  it.each(['warning', 'chat', 'area', 'ban'] as const)('revoke %s makes no notice and says what lifts, and that an appeal is closed only with appeals on', (kind) => {
    const on = planNotices({ op: 'revoke', kind }, ctx());
    expect(on.notices).toEqual([]);
    expect(on.nothing).toBeNull();
    expect(on.effects).toEqual([{ code: 'lifts', kind, to: 'player' }, { code: 'appeal_closed' }]);
    expect(planNotices({ op: 'revoke', kind }, ctx({ appeals: false })).effects).toEqual([{ code: 'lifts', kind, to: 'player' }]);
  });

  it('revoke of a note changes nothing for the player', () => {
    expect(planNotices({ op: 'revoke', kind: 'note' }, ctx())).toEqual({ notices: [], effects: [], nothing: 'note' });
  });

  it('a one-click dismissal sends nothing to anyone', () => {
    expect(planNotices({ op: 'dismiss' }, ctx())).toEqual({ notices: [], effects: [], nothing: 'dismissal' });
  });

  it('a named person is the recipient', () => {
    expect(planNotices({ op: 'rename', rule: 7, person: 'P-bob' }, ctx()).notices[0]?.to).toBe('P-bob');
    expect(planNotices({ op: 'revoke', kind: 'ban', person: 'P-bob' }, ctx()).effects[0]).toEqual({ code: 'lifts', kind: 'ban', to: 'P-bob' });
  });
});

describe('plan: an appeal decision', () => {
  const original = { kind: 'ban' as const, startsAt: NOW - 2 * DAY, endsAt: null as number | null, rule: 3 as number | null, refCode: 'CW-ORIGINAL' };
  const appeal = (outcome: 'uphold' | 'reduce' | 'revoke', over: Record<string, unknown> = {}): NoticeOp => ({ op: 'appeal', outcome, original, ...over }) as NoticeOp;

  it('keep: one notice with the original rule and reference, and the sanction stays', () => {
    const plan = planNotices(appeal('uphold'), ctx());
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]?.notice).toMatchObject({ kind: 'appeal_upheld', rule: 3, ruleLabel: 'Community Rule 3', refCode: 'CW-ORIGINAL', until: null, excerpt: [] });
    expect(plan.effects).toEqual([{ code: 'sanction_stays' }]);
  });

  it('remove: the removed notice, the original withdrawn and what lifts', () => {
    const plan = planNotices(appeal('revoke'), ctx());
    expect(plan.notices.map((n) => n.notice.kind)).toEqual(['appeal_revoked']);
    expect(plan.notices[0]?.notice.refCode).toBe('CW-ORIGINAL');
    expect(plan.effects).toEqual([{ code: 'removed_withdrawn' }, { code: 'lifts', kind: 'ban', to: 'player' }]);
  });

  it('lighter: the replacement notice first (a new reference, no lines), then appeal_reduced', () => {
    const plan = planNotices(appeal('reduce', { to: { kind: 'chat', durationMs: 12 * HOUR } }), ctx());
    expect(plan.notices.map((n) => n.notice.kind)).toEqual(['chat', 'appeal_reduced']);
    expect(plan.notices[0]?.notice).toMatchObject({ rule: 3, until: NOW - 2 * DAY + 12 * HOUR, refCode: 'REF-PLACEHOLDER', excerpt: [] });
    expect(plan.notices[1]?.notice).toMatchObject({ refCode: 'CW-ORIGINAL', until: null });
  });

  it('lighter, already over: the replacement ends in the past and the effects say it ran its course', () => {
    const plan = planNotices(appeal('reduce', { to: { kind: 'chat', durationMs: HOUR } }), ctx());
    expect(plan.notices[0]?.notice.until).toBe(NOW - 2 * DAY + HOUR);
    expect(plan.effects).toContainEqual({ code: 'ran_its_course', to: 'player' });
    const fresh = appeal('reduce', { original: { ...original, startsAt: NOW - HOUR }, to: { kind: 'chat', durationMs: 12 * HOUR } });
    expect(planNotices(fresh, ctx()).effects.some((e) => e.code === 'ran_its_course')).toBe(false);
  });

  it('lighter to a warning: a warning with no end and an Acknowledge, and no new-end line', () => {
    const plan = planNotices(appeal('reduce', { to: { kind: 'warning', durationMs: null } }), ctx());
    expect(plan.notices[0]?.notice).toMatchObject({ kind: 'warning', until: null, mustAcknowledge: true });
    expect(plan.effects).toEqual([{ code: 'first_withdrawn' }]);
  });

  it('the new end never goes past the original end; a permanent choice keeps it', () => {
    const timed = { ...original, kind: 'area' as const, endsAt: NOW + DAY };
    const longer = planNotices({ op: 'appeal', outcome: 'reduce', original: timed, to: { kind: 'chat', durationMs: 30 * DAY } }, ctx());
    expect(longer.notices[0]?.notice.until).toBe(NOW + DAY);
    const keep = planNotices({ op: 'appeal', outcome: 'reduce', original: timed, to: { kind: 'chat', durationMs: null } }, ctx());
    expect(keep.notices[0]?.notice.until).toBe(NOW + DAY);
  });

  it('a reduction that is not lighter, or has no target, is an empty plan', () => {
    expect(planNotices(appeal('reduce', { to: { kind: 'ban', durationMs: null } }), ctx())).toEqual({ notices: [], effects: [], nothing: null });
    expect(planNotices(appeal('reduce'), ctx()).notices).toEqual([]);
    expect(planNotices({ op: 'appeal', outcome: 'reduce', original: { ...original, kind: 'warning' }, to: { kind: 'warning', durationMs: null } }, ctx()).notices).toEqual([]);
  });

  it('a sanction with no rule gives notices with no rule label', () => {
    const plan = planNotices({ op: 'appeal', outcome: 'uphold', original: { ...original, rule: null } }, ctx());
    expect(plan.notices[0]?.notice).toMatchObject({ rule: null, ruleLabel: null });
  });
});

describe('appealReplacementEnd', () => {
  const o = (endsAt: number | null) => ({ startsAt: 1000, endsAt });
  it('is min(original end, start + length)', () => {
    expect(appealReplacementEnd(o(5000), { durationMs: 2000 })).toBe(3000);
    expect(appealReplacementEnd(o(5000), { durationMs: 9000 })).toBe(5000);
    expect(appealReplacementEnd(o(5000), { durationMs: 4000 })).toBe(5000);
  });
  it('a permanent original takes the chosen length; a permanent choice keeps the original end', () => {
    expect(appealReplacementEnd(o(null), { durationMs: 2000 })).toBe(3000);
    expect(appealReplacementEnd(o(5000), { durationMs: null })).toBe(5000);
    expect(appealReplacementEnd(o(null), { durationMs: null })).toBeNull();
  });
});

describe('planNotices never throws for a malformed op; it returns an empty plan with nothing set', () => {
  const empty = { notices: [], effects: [], nothing: null };
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'decide'],
    ['an unknown op', { op: 'zorbak' }],
    ['no op field', {}],
    ['decide with no actions list', { op: 'decide', verdict: 'upheld', target: 'a', reporter: 'b' }],
    ['decide with a bad verdict', { op: 'decide', verdict: 'vlemmo', target: 'a', reporter: 'b', actions: [], rename: null }],
    ['decide with a bad kind', { op: 'decide', verdict: 'upheld', target: 'a', reporter: 'b', actions: [{ person: 'a', kind: 'quissel', durationMs: null, rule: 1, lines: [] }], rename: null }],
    ['decide with a bad length', { op: 'decide', verdict: 'upheld', target: 'a', reporter: 'b', actions: [{ person: 'a', kind: 'chat', durationMs: Number.NaN, rule: 1, lines: [] }], rename: null }],
    ['decide with a null action', { op: 'decide', verdict: 'upheld', target: 'a', reporter: 'b', actions: [null], rename: null }],
    ['decide with a bad rename', { op: 'decide', verdict: 'upheld', target: 'a', reporter: 'b', actions: [], rename: { rule: 'x' } }],
    ['a rename with no rule', { op: 'rename' }],
    ['a revoke of a bad kind', { op: 'revoke', kind: 'drakkuun' }],
    ['a sanction of a bad kind', { op: 'sanction', kind: 'fenrisk', durationMs: 1 }],
    ['an appeal with no original', { op: 'appeal', outcome: 'uphold' }],
    ['an appeal with a bad outcome', { op: 'appeal', outcome: 'tarvo', original: { kind: 'ban', startsAt: 0, endsAt: null, rule: 1, refCode: 'x' } }],
  ])('%s', (_name, op) => {
    expect(planNotices(op as never, ctx())).toEqual(empty);
  });

  it('a throwing rule label or clock is an empty plan too', () => {
    const op = decide([act('P-bob', 'chat')]);
    expect(
      planNotices(
        op,
        ctx({
          ruleLabel: () => {
            throw new Error('boom');
          },
        }),
      ),
    ).toEqual(empty);
    expect(
      planNotices(
        op,
        ctx({
          now: () => {
            throw new Error('boom');
          },
        }),
      ),
    ).toEqual(empty);
  });

  it('a getter that throws on the op is an empty plan', () => {
    const op = {
      get op(): string {
        throw new Error('boom');
      },
    };
    expect(planNotices(op as never, ctx())).toEqual(empty);
  });
});
