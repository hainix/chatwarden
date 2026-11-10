import { LADDER_TABLE } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import {
  DURATIONS,
  MAX_ACTIONS,
  addAction,
  choiceKey,
  dropTargetActions,
  durationOf,
  emptyForm,
  newDraft,
  presets,
  resolveDraft,
  serverVerdict,
  toInput,
  validate,
  withSuggestion,
} from '../src/decision.js';
import type { Draft, DecisionForm, ValidationContext } from '../src/decision.js';

// The decision form's rules, as pure functions: what it sends, and what it refuses before sending.

const T = 'target-ref-000000';
const R = 'reporter-ref-0000';
const O = 'other-ref-0000000';

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  target: T,
  people: [T, R, O],
  rules: [1, 2, 3, 4, 5, 6, 7],
  canApply: true,
  canPermanent: false,
  ownLineIds: { [T]: ['t1', 't2', 't3', 't4', 't5', 't6', 't7'], [R]: ['r1'], [O]: [] },
  ...over,
});

let n = 0;
const draft = (over: Partial<Draft> = {}): Draft => ({ ...newDraft(`d${++n}`, T, 3), what: 'warning:null', ...over });

const form = (over: Partial<DecisionForm> = {}): DecisionForm => ({ ...emptyForm(), verdict: 'fair', reason: 'Because.', ...over });

const problems = (f: DecisionForm, c = ctx()) => validate(f, c);

describe('presets', () => {
  it('are the ladder table cells once each, plus a note', () => {
    const keys = presets().map(choiceKey);
    const ladder = new Set(LADDER_TABLE.flatMap((r) => [r.lowMedium, r.high]).map((c) => choiceKey(c)));
    expect(new Set(keys)).toEqual(new Set([...ladder, 'note:null']));
    expect(keys).toHaveLength(new Set(keys).size);
  });
  it('run from the lightest to the heaviest, the note last', () => {
    const keys = presets().map(choiceKey);
    expect(keys[0]).toBe('warning:null');
    expect(keys.at(-1)).toBe('note:null');
    expect(keys).toContain('ban:null');
  });
  it('a warning and a note carry no duration', () => {
    for (const p of presets().filter((c) => c.kind === 'warning' || c.kind === 'note')) expect(p.durationMs).toBeNull();
  });
});

describe('durations', () => {
  it('are 1 hour, 24 hours, 7 days, 30 days and permanent', () => {
    expect(DURATIONS.map((d) => d.key)).toEqual(['1h', '24h', '7d', '30d', 'permanent']);
    expect(DURATIONS.map((d) => d.ms)).toEqual([3_600_000, 86_400_000, 604_800_000, 2_592_000_000, null]);
    expect(durationOf('7d')).toBe(604_800_000);
    expect(durationOf('permanent')).toBeNull();
  });
});

describe('resolveDraft', () => {
  it('is nothing until something is chosen', () => {
    expect(resolveDraft(draft({ what: '' }))).toBeNull();
  });
  it('reads a preset', () => {
    expect(resolveDraft(draft({ what: 'chat:86400000' }))).toEqual({ kind: 'chat', durationMs: 86_400_000 });
    expect(resolveDraft(draft({ what: 'ban:null' }))).toEqual({ kind: 'ban', durationMs: null });
    expect(resolveDraft(draft({ what: 'note:null' }))).toEqual({ kind: 'note', durationMs: null });
  });
  it('an unknown preset is nothing', () => {
    expect(resolveDraft(draft({ what: 'ban:12345' }))).toBeNull();
  });
  it('something else uses the chosen kind and length', () => {
    expect(resolveDraft(draft({ what: 'other', customKind: 'area', customDuration: '30d' }))).toEqual({ kind: 'area', durationMs: 2_592_000_000 });
  });
  it('something else as a warning or note has no duration whatever the length says', () => {
    expect(resolveDraft(draft({ what: 'other', customKind: 'warning', customDuration: '7d' }))).toEqual({ kind: 'warning', durationMs: null });
    expect(resolveDraft(draft({ what: 'other', customKind: 'note', customDuration: 'permanent' }))).toEqual({ kind: 'note', durationMs: null });
  });
});

describe('serverVerdict', () => {
  it('fair with a real action is upheld', () => {
    expect(serverVerdict(form({ actions: [draft({ what: 'chat:86400000' })] }))).toBe('upheld');
  });
  it('fair with only notes is noted', () => {
    expect(serverVerdict(form({ actions: [draft({ what: 'note:null' }), draft({ what: 'note:null', person: R })] }))).toBe('noted');
  });
  it('fair with a note and a sanction is upheld', () => {
    expect(serverVerdict(form({ actions: [draft({ what: 'note:null' }), draft({ what: 'warning:null', person: R })] }))).toBe('upheld');
  });
  it('fair with no action is upheld (the server allows it)', () => {
    expect(serverVerdict(form())).toBe('upheld');
  });
  it('a custom note counts as a note', () => {
    expect(serverVerdict(form({ actions: [draft({ what: 'other', customKind: 'note' })] }))).toBe('noted');
  });
  it('not a problem is no_action and bad faith is bad_faith', () => {
    expect(serverVerdict(form({ verdict: 'not_a_problem' }))).toBe('no_action');
    expect(serverVerdict(form({ verdict: 'bad_faith', evidence: 'x' }))).toBe('bad_faith');
  });
});

describe('toInput', () => {
  it('sends the verdict, the trimmed reason and each action with its rule', () => {
    const f = form({ reason: '  Said the thing again.  ', actions: [draft({ what: 'chat:86400000', rule: '3' })] });
    expect(toInput(f)).toEqual({
      verdict: 'upheld',
      reason: 'Said the thing again.',
      actions: [{ subject: T, kind: 'chat', durationMs: 86_400_000, rule: 3 }],
    });
  });
  it('sends evidence only for bad faith, trimmed', () => {
    const bad = toInput(form({ verdict: 'bad_faith', evidence: '  made it up  ' }));
    expect(bad).toMatchObject({ verdict: 'bad_faith', evidence: 'made it up' });
    expect(toInput(form({ verdict: 'not_a_problem', evidence: 'stale text' }))).not.toHaveProperty('evidence');
    expect(toInput(form({ verdict: 'fair', evidence: 'stale text' }))).not.toHaveProperty('evidence');
  });
  it('an uncovered rule sends the trimmed gap note; a numbered one never does', () => {
    const f = form({ actions: [draft({ rule: 'uncovered', gapNote: '  nothing about this  ' }), draft({ person: R, what: 'note:null', rule: '2', gapNote: 'left over' })] });
    const [a, b] = toInput(f).actions;
    expect(a).toMatchObject({ rule: 'uncovered', gapNote: 'nothing about this' });
    expect(b).not.toHaveProperty('gapNote');
    expect(b).toMatchObject({ rule: 2 });
  });
  it('sends the chosen lines of a notice-bearing action, and none for a note', () => {
    const f = form({ actions: [draft({ lineIds: ['t1', 't2'] }), draft({ what: 'note:null', person: R, lineIds: ['r1'] })] });
    const [a, b] = toInput(f).actions;
    expect(a).toMatchObject({ lineIds: ['t1', 't2'] });
    expect(b).not.toHaveProperty('lineIds');
  });
  it('omits lineIds when none is chosen', () => {
    expect(toInput(form({ actions: [draft()] })).actions[0]).not.toHaveProperty('lineIds');
  });
  it('a permanent length is null, not a number', () => {
    const f = form({ actions: [draft({ what: 'other', customKind: 'ban', customDuration: 'permanent' })] });
    expect(toInput(f).actions[0]).toMatchObject({ kind: 'ban', durationMs: null });
  });
  it('is the same for the same form (nothing random in the body)', () => {
    const f = form({ actions: [draft()] });
    expect(JSON.stringify(toInput(f))).toBe(JSON.stringify(toInput(f)));
  });
});

describe('validate: the reason and the verdict', () => {
  it('a complete fair decision with no action is fine', () => {
    expect(problems(form()).count).toBe(0);
  });
  it('needs a verdict', () => {
    expect(problems(form({ verdict: null })).verdict).toBeDefined();
  });
  it('needs a reason, trimmed', () => {
    expect(problems(form({ reason: '' })).reason?.key).toBe('hub.decide.error.reasonRequired');
    expect(problems(form({ reason: '   \n ' })).reason?.key).toBe('hub.decide.error.reasonRequired');
  });
  it('allows a reason of exactly 500 characters and refuses 501', () => {
    expect(problems(form({ reason: 'x'.repeat(500) })).reason).toBeUndefined();
    expect(problems(form({ reason: 'x'.repeat(501) })).reason?.key).toBe('hub.decide.error.reasonLong');
  });
  it('counts the reason after trimming', () => {
    expect(problems(form({ reason: `  ${'x'.repeat(500)}  ` })).reason).toBeUndefined();
  });
});

describe('validate: bad-faith evidence', () => {
  const bad = (evidence: string) => problems(form({ verdict: 'bad_faith', evidence }));
  it('is required', () => {
    expect(bad('').evidence?.key).toBe('hub.decide.error.evidenceRequired');
    expect(bad('   ').evidence?.key).toBe('hub.decide.error.evidenceRequired');
  });
  it('is 1 to 500 characters', () => {
    expect(bad('x').evidence).toBeUndefined();
    expect(bad('x'.repeat(500)).evidence).toBeUndefined();
    expect(bad('x'.repeat(501)).evidence?.key).toBe('hub.decide.error.evidenceLong');
  });
  it('is not asked for under another verdict, even if text is left in the box', () => {
    expect(problems(form({ verdict: 'not_a_problem', evidence: '' })).evidence).toBeUndefined();
    expect(problems(form({ verdict: 'not_a_problem', evidence: 'x'.repeat(900) })).evidence).toBeUndefined();
    expect(problems(form({ verdict: 'fair', evidence: '' })).evidence).toBeUndefined();
  });
});

describe('validate: who can be acted on', () => {
  it('fair may act on the reported person, the reporter and anyone else', () => {
    for (const person of [T, R, O]) expect(problems(form({ actions: [draft({ person })] })).count, person).toBe(0);
  });
  it('not a problem and bad faith may not act on the reported person', () => {
    for (const verdict of ['not_a_problem', 'bad_faith'] as const) {
      const p = problems(form({ verdict, evidence: 'e', actions: [draft({ uid: 'x', person: T })] }));
      expect(p.actions.x?.person?.key, verdict).toBe('hub.decide.error.targetNeedsFair');
    }
  });
  it('not a problem and bad faith may act on the reporter and others', () => {
    for (const verdict of ['not_a_problem', 'bad_faith'] as const) {
      for (const person of [R, O]) {
        expect(problems(form({ verdict, evidence: 'e', actions: [draft({ person })] })).count, `${verdict} ${person}`).toBe(0);
      }
    }
  });
  it('refuses a person the report does not name', () => {
    const d = draft({ uid: 'z', person: 'stranger-0000000' });
    expect(problems(form({ actions: [d] })).actions.z?.person?.key).toBe('hub.decide.error.personUnknown');
  });
});

describe('validate: what happens', () => {
  it('needs a choice', () => {
    const d = draft({ uid: 'w', what: '' });
    expect(problems(form({ actions: [d] })).actions.w?.what?.key).toBe('hub.decide.error.whatRequired');
  });
  it('refuses a permanent ban without the senior permission, and allows it with', () => {
    const d = draft({ uid: 'p', what: 'ban:null' });
    expect(problems(form({ actions: [d] }), ctx({ canPermanent: false })).actions.p?.what?.key).toBe('hub.decide.error.permanent');
    expect(problems(form({ actions: [d] }), ctx({ canPermanent: true })).count).toBe(0);
  });
  it('treats a custom permanent length the same way, for any kind', () => {
    for (const customKind of ['chat', 'area', 'ban'] as const) {
      const d = draft({ uid: 'p', what: 'other', customKind, customDuration: 'permanent' });
      expect(problems(form({ actions: [d] }), ctx({ canPermanent: false })).actions.p?.what?.key, customKind).toBe('hub.decide.error.permanent');
      expect(problems(form({ actions: [d] }), ctx({ canPermanent: true })).count, customKind).toBe(0);
    }
  });
  it('a warning and a note are never "permanent": they have no length', () => {
    for (const customKind of ['warning', 'note'] as const) {
      const d = draft({ what: 'other', customKind, customDuration: 'permanent' });
      expect(problems(form({ actions: [d] }), ctx({ canPermanent: false })).count, customKind).toBe(0);
    }
  });
  it('refuses the same kind twice for one person, once per extra', () => {
    const a = draft({ uid: 'a', what: 'chat:86400000' });
    const b = draft({ uid: 'b', what: 'other', customKind: 'chat', customDuration: '7d' });
    const p = problems(form({ actions: [a, b] }));
    expect(p.actions.a?.what).toBeUndefined();
    expect(p.actions.b?.what?.key).toBe('hub.decide.error.duplicate');
  });
  it('allows two different kinds for one person, and the same kind for two people', () => {
    expect(problems(form({ actions: [draft({ what: 'warning:null' }), draft({ what: 'chat:86400000' })] })).count).toBe(0);
    expect(problems(form({ actions: [draft({ what: 'warning:null', person: T }), draft({ what: 'warning:null', person: R })] })).count).toBe(0);
  });
  it('refuses any action when the role cannot apply sanctions', () => {
    expect(problems(form({ actions: [draft()] }), ctx({ canApply: false })).list?.key).toBe('hub.decide.error.cannotApply');
    expect(problems(form(), ctx({ canApply: false })).count).toBe(0);
  });
  it('refuses more than 20 actions', () => {
    const many = Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => draft({ what: 'note:null', person: `person-${String(i).padStart(9, '0')}` }));
    const c = ctx({ people: many.map((d) => d.person), ownLineIds: {} });
    expect(problems(form({ actions: many }), c).list?.key).toBe('hub.decide.error.tooMany');
    expect(problems(form({ actions: many.slice(0, MAX_ACTIONS) }), c).list).toBeUndefined();
  });
});

describe('validate: the rule', () => {
  it('needs a rule', () => {
    expect(problems(form({ actions: [draft({ uid: 'r', rule: '' })] })).actions.r?.rule?.key).toBe('hub.decide.error.ruleRequired');
  });
  it('a numbered rule must be one the server will accept (active)', () => {
    expect(problems(form({ actions: [draft({ uid: 'r', rule: '99' })] })).actions.r?.rule?.key).toBe('hub.decide.error.ruleUnknown');
    expect(problems(form({ actions: [draft({ uid: 'r', rule: '3' })] })).count).toBe(0);
    expect(problems(form({ actions: [draft({ uid: 'r', rule: '3' })] }), ctx({ rules: [1, 2] })).actions.r?.rule?.key).toBe('hub.decide.error.ruleUnknown');
  });
  it('no rule covers this needs a gap note', () => {
    for (const gapNote of ['', '   ']) {
      expect(problems(form({ actions: [draft({ uid: 'g', rule: 'uncovered', gapNote })] })).actions.g?.gapNote?.key).toBe('hub.decide.error.gapRequired');
    }
  });
  it('a gap note is 1 to 500 characters after trimming', () => {
    expect(problems(form({ actions: [draft({ rule: 'uncovered', gapNote: 'x' })] })).count).toBe(0);
    expect(problems(form({ actions: [draft({ rule: 'uncovered', gapNote: ` ${'x'.repeat(500)} ` })] })).count).toBe(0);
    expect(problems(form({ actions: [draft({ uid: 'g', rule: 'uncovered', gapNote: 'x'.repeat(501) })] })).actions.g?.gapNote?.key).toBe('hub.decide.error.gapLong');
  });
  it('a gap note left over from "no rule covers this" is not checked once a rule is chosen', () => {
    expect(problems(form({ actions: [draft({ rule: '2', gapNote: 'x'.repeat(900) })] })).count).toBe(0);
  });
});

describe('validate: lines to show the player', () => {
  it('allows up to five of the person\'s own lines', () => {
    expect(problems(form({ actions: [draft({ lineIds: ['t1', 't2', 't3', 't4', 't5'] })] })).count).toBe(0);
  });
  it('refuses six', () => {
    expect(problems(form({ actions: [draft({ uid: 'l', lineIds: ['t1', 't2', 't3', 't4', 't5', 't6'] })] })).actions.l?.lines?.key).toBe('hub.decide.error.linesMany');
  });
  it('refuses a line that is not the person\'s own', () => {
    expect(problems(form({ actions: [draft({ uid: 'l', person: R, lineIds: ['t1'] })] })).actions.l?.lines?.key).toBe('hub.decide.error.linesForeign');
  });
  it('a note shows the player nothing, so its lines are not checked', () => {
    expect(problems(form({ actions: [draft({ what: 'note:null', lineIds: ['nonsense'] })] })).count).toBe(0);
  });
});

describe('validate: counts', () => {
  it('counts every problem so the summary can say how many', () => {
    const p = problems(form({ verdict: null, reason: '', actions: [draft({ what: '', rule: '' })] }));
    expect(p.count).toBe(4);
  });
});

describe('addAction and dropTargetActions', () => {
  it('adds an action for the reported person under "fair", with the report\'s rule', () => {
    const f = addAction(form(), ctx(), 5, 'u1');
    expect(f.actions).toHaveLength(1);
    expect(f.actions[0]).toMatchObject({ uid: 'u1', person: T, rule: '5', what: '' });
  });
  it('adds an action for the reporter under a dismissal (never the reported person)', () => {
    expect(addAction(form({ verdict: 'not_a_problem' }), ctx(), 5, 'u1').actions[0]?.person).toBe(R);
    expect(addAction(form({ verdict: 'bad_faith' }), ctx(), 5, 'u1').actions[0]?.person).toBe(R);
  });
  it('leaves the rule unchosen when the report\'s rule is not citable or is uncovered', () => {
    expect(addAction(form(), ctx(), 'uncovered', 'u1').actions[0]?.rule).toBe('');
    expect(addAction(form(), ctx({ rules: [1] }), 5, 'u1').actions[0]?.rule).toBe('');
  });
  it('stops at 20 actions', () => {
    let f = form();
    for (let i = 0; i < 25; i += 1) f = addAction(f, ctx(), 1, `u${i}`);
    expect(f.actions).toHaveLength(MAX_ACTIONS);
  });
  it('dropping the reported person\'s actions keeps the rest and says how many went', () => {
    const f = form({ actions: [draft({ person: T }), draft({ person: R }), draft({ person: T, what: 'chat:86400000' })] });
    const out = dropTargetActions(f, T);
    expect(out.dropped).toBe(2);
    expect(out.form.actions.map((a) => a.person)).toEqual([R]);
  });
  it('dropping nothing returns the same form', () => {
    const f = form({ actions: [draft({ person: R })] });
    expect(dropTargetActions(f, T)).toEqual({ form: f, dropped: 0 });
  });
});

describe('withSuggestion', () => {
  it('turns a suggested outcome into an action for the reported person', () => {
    const cases: Array<[Parameters<typeof withSuggestion>[2], string]> = [
      ['warning', 'warning:null'],
      ['note', 'note:null'],
      [{ kind: 'chat', durationMs: 86_400_000 }, 'chat:86400000'],
      [{ kind: 'ban', durationMs: 604_800_000 }, 'ban:604800000'],
    ];
    for (const [outcome, what] of cases) {
      const f = withSuggestion(form(), ctx(), outcome, 2, 'u1');
      expect(f?.actions[0], what).toMatchObject({ person: T, what, rule: '2' });
    }
  });
  it('an area ban is a "something else" action at the suggested length', () => {
    const f = withSuggestion(form(), ctx(), { kind: 'area', durationMs: 604_800_000 }, 2, 'u1');
    expect(f?.actions[0]).toMatchObject({ what: 'other', customKind: 'area', customDuration: '7d' });
  });
  it('"none" adds nothing', () => {
    expect(withSuggestion(form(), ctx(), 'none', 2, 'u1')).toBeNull();
  });
  it('a length the form cannot offer adds nothing', () => {
    expect(withSuggestion(form(), ctx(), { kind: 'area', durationMs: 12_345 }, 2, 'u1')).toBeNull();
  });
  it('reuses the reported person\'s existing action of that kind instead of adding a duplicate', () => {
    const first = withSuggestion(form(), ctx(), 'warning', 2, 'u1')!;
    const second = withSuggestion(first, ctx(), 'warning', 2, 'u2')!;
    expect(second.actions).toHaveLength(1);
  });
});
