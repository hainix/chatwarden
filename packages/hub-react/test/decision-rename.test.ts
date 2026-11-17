// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { dropTargetActions, emptyForm, newDraft, renameStartRule, toInput, validate } from '../src/decision.js';
import type { DecisionForm, Draft, ValidationContext } from '../src/decision.js';
import { shapeOf } from '../src/case/useQuickActions.js';

// The decision form's "Ask for a new name" (0.2.0) as plain data: what the checks refuse, the body, what a verdict change takes away.

const TARGET = 'P-target';
const OTHER = 'P-other';
const ctx: ValidationContext = { target: TARGET, people: [TARGET, OTHER], rules: [1, 2, 7], canApply: true, canPermanent: true, ownLineIds: {} };
const action = (over: Partial<Draft> = {}): Draft => ({ ...newDraft('a1', TARGET, 2), what: 'warning:null', ...over });
const form = (over: Partial<DecisionForm> = {}): DecisionForm => ({ ...emptyForm(), verdict: 'fair', reason: 'A name against the rules.', ...over });

describe('validate', () => {
  it('accepts fair with a numbered rule in force, alone or beside an action on the reported person', () => {
    expect(validate(form({ rename: { rule: '7' } }), ctx).count).toBe(0);
    expect(validate(form({ rename: { rule: '7' }, actions: [action()] }), ctx).count).toBe(0);
  });

  it('needs a rule: empty, not a number and "uncovered" are refused with the rule problem', () => {
    for (const rule of ['', 'uncovered', 'x', '0', '-1']) expect(validate(form({ rename: { rule } }), ctx).rename, rule).toEqual({ key: 'hub.decide.error.ruleRequired' });
  });

  it('a rule that is not in force is refused', () => {
    expect(validate(form({ rename: { rule: '9' } }), ctx).rename).toEqual({ key: 'hub.decide.error.ruleUnknown' });
  });

  it('needs the verdict fair: not a problem and bad faith refuse it', () => {
    for (const verdict of ['not_a_problem', 'bad_faith'] as const) {
      const found = validate(form({ verdict, evidence: 'proof', rename: { rule: '7' } }), ctx);
      expect(found.rename, verdict).toEqual({ key: 'hub.decide.error.renameNeedsFair' });
    }
  });

  it('only the reported person: an action on anyone else refuses it', () => {
    const found = validate(form({ rename: { rule: '7' }, actions: [action(), action({ uid: 'a2', person: OTHER })] }), ctx);
    expect(found.rename).toEqual({ key: 'hub.decide.error.renameOnlyReported' });
  });

  it('counts as one problem, and no rename is no problem', () => {
    expect(validate(form({ rename: { rule: '' } }), ctx).count).toBe(1);
    expect(validate(form(), ctx).rename).toBeUndefined();
  });
});

describe('toInput', () => {
  it('sends rename: { rule } as a number when ticked, and nothing otherwise', () => {
    expect(toInput(form({ rename: { rule: '7' } })).rename).toEqual({ rule: 7 });
    expect(Object.keys(toInput(form()))).not.toContain('rename');
  });

  it('rename alone is an upheld verdict with no actions; with a warning it carries the action too', () => {
    expect(toInput(form({ rename: { rule: '7' } }))).toMatchObject({ verdict: 'upheld', actions: [], rename: { rule: 7 } });
    expect(toInput(form({ rename: { rule: '7' }, actions: [action()] }))).toMatchObject({ verdict: 'upheld', actions: [{ kind: 'warning' }], rename: { rule: 7 } });
  });

  it('a note-only decision stays "noted" and carries the rename', () => {
    expect(toInput(form({ rename: { rule: '7' }, actions: [action({ what: 'note:null' })] }))).toMatchObject({ verdict: 'noted', rename: { rule: 7 } });
  });
});

describe('dropTargetActions', () => {
  it('takes the request off with the actions on the reported person, and says it did', () => {
    const result = dropTargetActions(form({ verdict: 'not_a_problem', rename: { rule: '7' }, actions: [action(), action({ uid: 'a2', person: OTHER })] }), TARGET);
    expect(result.dropped).toBe(1);
    expect(result.renameCleared).toBe(true);
    expect(result.form.rename).toBeNull();
    expect(result.form.actions.map((a) => a.person)).toEqual([OTHER]);
  });

  it('clears the request even when there is no action to drop', () => {
    const result = dropTargetActions(form({ rename: { rule: '7' } }), TARGET);
    expect(result).toMatchObject({ dropped: 0, renameCleared: true });
    expect(result.form.rename).toBeNull();
  });

  it('a form with neither is returned as it was', () => {
    const f = form({ actions: [action({ person: OTHER })] });
    const result = dropTargetActions(f, TARGET);
    expect(result.form).toBe(f);
    expect(result.renameCleared).toBe(false);
  });
});

describe('renameStartRule', () => {
  it('starts on the first action\'s rule, else the report\'s, else empty', () => {
    expect(renameStartRule(form({ actions: [action({ rule: '1' })] }), ctx, 7)).toBe('1');
    expect(renameStartRule(form(), ctx, 7)).toBe('7');
    expect(renameStartRule(form(), ctx, 99)).toBe('');
    expect(renameStartRule(form(), ctx, 'uncovered')).toBe('');
    // An action with no rule yet, or "No rule covers this", is passed over.
    expect(renameStartRule(form({ actions: [action({ rule: '' }), action({ uid: 'a2', rule: 'uncovered' })] }), ctx, 2)).toBe('2');
  });
});

describe('shapeOf (the AI echo\'s notion of "changed")', () => {
  it('differs when the request is ticked, so an accepted pre-fill with a rename added is an edit', () => {
    expect(shapeOf(form())).not.toBe(shapeOf(form({ rename: { rule: '7' } })));
    expect(shapeOf(form({ rename: { rule: '7' } }))).toBe(shapeOf(form({ rename: { rule: '7' } })));
  });
});
