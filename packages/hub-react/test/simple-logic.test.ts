// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { REASON_MAX, toInput, validate } from '../src/decision.js';
import type { ValidationContext } from '../src/decision.js';
import { createT, en } from '../src/i18n.js';
import { noActionForm, oneClickOf, ownLinesOf, recordLine, recordSteps, reporterWarrants, stepLabel } from '../src/simple.js';
import type { SanctionGroupView, Suggestion } from '../src/types.js';

// Simple mode's two pure decisions: what one click sends, and when a reporter's record is worth a warning. Every variant of the
// rule is here, so a change to either shows up as a red test, not as a surprised moderator.

const TARGET = 'target-ref';
const RULES = [
  { number: 1, title: 'Treat others with respect' },
  { number: 4, title: 'No spam, flooding or advertising' },
  { number: 7, title: '  Keep it clean  ' },
];
const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  target: TARGET,
  people: [TARGET, 'reporter-ref'],
  rules: RULES.map((r) => r.number),
  canApply: true,
  canPermanent: false,
  ownLineIds: { [TARGET]: ['2', '4'] },
  ...over,
});
const DAY = 86_400_000;
const chat24: Suggestion['outcome'] = { kind: 'chat', durationMs: DAY };

describe('oneClickOf: the one-click body', () => {
  it('is Fair, the suggested step, the rule, the rule title as the reason, and the person\'s own lines', () => {
    const one = oneClickOf(ctx(), RULES, chat24, 4, '2', 'a1');
    expect(one).not.toBeNull();
    expect(toInput(one!.form)).toEqual({
      verdict: 'upheld',
      reason: 'No spam, flooding or advertising',
      actions: [{ subject: TARGET, kind: 'chat', durationMs: DAY, rule: 4, lineIds: ['2', '4'] }],
    });
    expect(one!.rule).toBe(4);
    expect(one!.lineCount).toBe(2);
    expect(one!.choice).toEqual({ kind: 'chat', durationMs: DAY });
    expect(one!.form.verdict).toBe('fair');
  });

  it('passes the same checks the decision bar does, so the server is never sent what the bar would refuse', () => {
    const one = oneClickOf(ctx(), RULES, chat24, 4, '2', 'a1');
    expect(validate(one!.form, ctx()).count).toBe(0);
  });

  it('trims the title, so the reason has no stray spaces', () => {
    expect(toInput(oneClickOf(ctx(), RULES, chat24, 7, '2', 'a1')!.form).reason).toBe('Keep it clean');
  });

  it('cuts a title longer than a reason may be to the limit', () => {
    const long = [{ number: 1, title: 'x'.repeat(REASON_MAX + 80) }];
    const one = oneClickOf(ctx({ rules: [1] }), long, chat24, 1, '2', 'a1');
    expect(one).not.toBeNull();
    expect(one!.form.reason).toHaveLength(REASON_MAX);
    expect(validate(one!.form, ctx({ rules: [1] })).count).toBe(0);
  });

  it('shows at most five of the person\'s lines, the reported one always among them', () => {
    const ids = ['1', '2', '3', '4', '5', '6', '7'];
    const one = oneClickOf(ctx({ ownLineIds: { [TARGET]: ids } }), RULES, chat24, 4, '2', 'a1');
    expect(one!.lineCount).toBe(5);
    const sent = toInput(one!.form).actions[0]!.lineIds!;
    expect(sent).toHaveLength(5);
    expect(sent).toContain('2');
    expect(sent).toEqual(['2', '4', '5', '6', '7']);
  });

  it('sends no lines when the person wrote none, and says so with a count of zero', () => {
    const one = oneClickOf(ctx({ ownLineIds: {} }), RULES, chat24, 4, null, 'a1');
    expect(one!.lineCount).toBe(0);
    expect(toInput(one!.form).actions[0]).not.toHaveProperty('lineIds');
  });

  const steps: Array<[string, Suggestion['outcome'], { kind: string; durationMs: number | null }]> = [
    ['a warning', 'warning', { kind: 'warning', durationMs: null }],
    ['a ban of 7 days', { kind: 'ban', durationMs: 7 * DAY }, { kind: 'ban', durationMs: 7 * DAY }],
    ['an area restriction', { kind: 'area', durationMs: DAY }, { kind: 'area', durationMs: DAY }],
  ];
  it.each(steps)('takes %s from the ladder', (_name, outcome, choice) => {
    const one = oneClickOf(ctx(), RULES, outcome, 4, '2', 'a1');
    expect(one!.choice).toEqual(choice);
    expect(toInput(one!.form).actions[0]).toMatchObject({ kind: choice.kind, durationMs: choice.durationMs });
  });

  it('a note carries no lines (it tells the player nothing) and is marked private', () => {
    const one = oneClickOf(ctx(), RULES, 'note', 4, '2', 'a1');
    expect(one!.choice.kind).toBe('note');
    expect(one!.lineCount).toBe(0);
    expect(one!.form.verdict).toBe('fair');
    expect(toInput(one!.form).verdict).toBe('noted');
  });

  it.each([
    ['the ladder suggests nothing', 'none' as const, 4 as number | 'uncovered', ctx()],
    ['no rule covers the report', chat24, 'uncovered' as const, ctx()],
    ['the report\'s rule has been retired', chat24, 9, ctx()],
    ['the role cannot apply sanctions', chat24, 4, ctx({ canApply: false })],
    ['the step is a permanent ban and the role may not make one', { kind: 'ban', durationMs: null } as Suggestion['outcome'], 4, ctx()],
    ['the step has a length the server does not take', { kind: 'chat', durationMs: 400 * DAY } as Suggestion['outcome'], 4, ctx()],
  ])('gives nothing when %s', (_name, outcome, rule, c) => {
    expect(oneClickOf(c, RULES, outcome, rule, '2', 'a1')).toBeNull();
  });

  it('gives a permanent ban to a role that may make one', () => {
    const one = oneClickOf(ctx({ canPermanent: true }), RULES, { kind: 'ban', durationMs: null }, 4, '2', 'a1');
    expect(toInput(one!.form).actions[0]).toMatchObject({ kind: 'ban', durationMs: null });
  });

  it('gives nothing when the rule has no title to use as the reason', () => {
    expect(oneClickOf(ctx(), [{ number: 4, title: '   ' }], chat24, 4, '2', 'a1')).toBeNull();
  });
});

describe('noActionForm: the "No action needed" body', () => {
  it('is the Not-a-problem verdict, the given reason and no actions', () => {
    expect(toInput(noActionForm('No rule was broken'))).toEqual({ verdict: 'no_action', reason: 'No rule was broken', actions: [] });
  });
  it('passes the checks of the bar', () => {
    expect(validate(noActionForm('No rule was broken'), ctx()).count).toBe(0);
  });
});

describe("reporterWarrants: when a reporter's record is worth a warning", () => {
  // Only decided reports count: open ones are neither upheld nor not upheld.
  const rec = (open: number, actioned: number, dismissed: number) => ({ reports: open + actioned + dismissed, open, actioned, dismissed, badFaith: 0, suspendedUntil: null });
  const table: Array<[number, number, number, boolean]> = [
    // open, upheld, not upheld, warning
    [0, 0, 0, false],
    [3, 0, 0, false],
    [9, 0, 0, false],
    [0, 0, 2, false],
    [0, 0, 3, true],
    [0, 1, 2, false],
    [0, 2, 1, false],
    [0, 3, 0, false],
    [0, 1, 3, true],
    [0, 2, 2, false],
    [5, 0, 2, false],
    [5, 0, 3, true],
    [2, 1, 3, true],
    [2, 2, 2, false],
    [0, 10, 20, false],
    [0, 9, 21, true],
    [0, 33, 67, true],
    [0, 34, 66, false],
    [40, 33, 67, true],
  ];
  it.each(table)('%i open, %i upheld, %i not upheld: warning %s', (open, upheld, notUpheld, expected) => {
    expect(reporterWarrants(rec(open, upheld, notUpheld))).toBe(expected);
  });
});

describe('ownLinesOf', () => {
  const lines = [
    { id: '1', person: 'a' },
    { id: '2', person: TARGET },
    { id: '3', person: null },
    { id: '4', person: TARGET },
  ];
  it('keeps the person\'s lines in order', () => {
    expect(ownLinesOf(lines, TARGET).map((l) => l.id)).toEqual(['2', '4']);
  });
  it('is empty for a person with none', () => {
    expect(ownLinesOf(lines, 'nobody')).toEqual([]);
  });
});

describe('the record in one line (pure)', () => {
  const t = createT(en, 'en');
  const H = 3_600_000;
  let n = 0;
  const step = (over: Partial<SanctionGroupView> & { kind: SanctionGroupView['kind'] }): SanctionGroupView => ({
    groupId: `g${++n}`,
    refCode: `R${n}`,
    rule: 1,
    startsAt: 1_000_000 + n,
    endsAt: null,
    reason: 'x',
    actor: 'ann',
    source: 'moderator',
    automated: false,
    active: false,
    pending: false,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    ...over,
  });

  it('says nothing in the last 90 days for an empty record, and for only revoked steps', () => {
    expect(recordLine(t, 'en', [])).toBe('Nothing in the last 90 days.');
    expect(recordLine(t, 'en', [step({ kind: 'warning', revokedAt: 5, revokedBy: 'x', revokeReason: 'y' })])).toBe('Nothing in the last 90 days.');
  });

  it('orders newest first and drops revoked ones', () => {
    const a = step({ kind: 'warning', startsAt: 10 });
    const b = step({ kind: 'note', startsAt: 30 });
    const c = step({ kind: 'warning', startsAt: 20, revokedAt: 25 });
    expect(recordSteps([a, b, c]).map((s) => s.groupId)).toEqual([b.groupId, a.groupId]);
  });

  it.each([
    [{ kind: 'warning' as const }, '1 past step: a warning.'],
    [{ kind: 'note' as const, active: true }, '1 past step: a note.'],
    [{ kind: 'warning' as const, active: true }, '1 past step: a warning.'],
    [{ kind: 'chat' as const, startsAt: 0, endsAt: 24 * H }, '1 past step: a 24-hour chat restriction.'],
    [{ kind: 'chat' as const, startsAt: 0, endsAt: 24 * H, active: true }, '1 past step: a 24-hour chat restriction, still in force.'],
    [{ kind: 'chat' as const, startsAt: 0, endsAt: H, active: true }, '1 past step: a 1-hour chat restriction, still in force.'],
    [{ kind: 'chat' as const, startsAt: 0, endsAt: 7 * 24 * H, active: true }, '1 past step: a 7-day chat restriction, still in force.'],
    [{ kind: 'area' as const, startsAt: 0, endsAt: 30 * 24 * H }, '1 past step: a 30-day area restriction.'],
    [{ kind: 'ban' as const, startsAt: 0, endsAt: null, active: true }, '1 past step: a permanent ban, still in force.'],
    [{ kind: 'ban' as const, startsAt: 0, endsAt: 7 * 24 * H }, '1 past step: a 7-day ban.'],
    [{ kind: 'chat' as const, startsAt: 0, endsAt: 3 * H }, '1 past step: a 3h chat restriction.'],
  ])('%j reads "%s"', (over, expected) => {
    expect(recordLine(t, 'en', [step(over)])).toBe(expected);
  });

  it('two steps read as a plain list, three with commas, more than three end in "and N more"', () => {
    const w = (startsAt: number) => step({ kind: 'warning', startsAt });
    expect(recordLine(t, 'en', [w(1), step({ kind: 'note', startsAt: 2 })])).toBe('2 past steps: a note and a warning.');
    expect(recordLine(t, 'en', [w(1), w(2), w(3)])).toBe('3 past steps: a warning, a warning, and a warning.');
    expect(recordLine(t, 'en', [w(1), w(2), w(3), w(4)])).toBe('4 past steps: a warning, a warning, a warning, and 1 more.');
    expect(recordLine(t, 'en', [w(1), w(2), w(3), w(4), w(5), w(6)])).toBe('6 past steps: a warning, a warning, a warning, and 3 more.');
  });

  it('counts only what stands in the "N past steps"', () => {
    expect(recordLine(t, 'en', [step({ kind: 'warning' }), step({ kind: 'warning', revokedAt: 9 })])).toBe('1 past step: a warning.');
  });
});

describe('stepLabel: the words on the primary button', () => {
  const t = createT(en, 'en');
  it.each([
    [{ kind: 'chat' as const, durationMs: 24 * 3_600_000 }, 'Restrict chat, 24 hours'],
    [{ kind: 'chat' as const, durationMs: 7 * 86_400_000 }, 'Restrict chat, 7 days'],
    [{ kind: 'chat' as const, durationMs: 3_600_000 }, 'Restrict chat, 1 hour'],
    [{ kind: 'chat' as const, durationMs: null }, 'Restrict chat, permanent'],
    [{ kind: 'area' as const, durationMs: 86_400_000 }, 'Restrict area, 24 hours'],
    [{ kind: 'ban' as const, durationMs: 30 * 86_400_000 }, 'Ban, 30 days'],
    [{ kind: 'ban' as const, durationMs: null }, 'Ban, permanent'],
    [{ kind: 'warning' as const, durationMs: null }, 'Send a warning'],
    [{ kind: 'note' as const, durationMs: null }, 'Add a note'],
  ])('%j is "%s"', (choice, expected) => {
    expect(stepLabel(t, 'en', choice)).toBe(expected);
  });
});
