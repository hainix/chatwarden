import { describe, expect, it } from 'vitest';
import {
  applyPolicyLayer,
  changedSections,
  defineProfile,
  POLICY_SECTIONS,
  PRESETS,
  ProfileError,
  resolveProfile,
  validateProfile,
} from '../src/profile.js';
import type { ModerationProfile, PolicyLayer, ResolvedProfile } from '../src/profile.js';
import {
  canonicalReasonId,
  DEFAULT_REPORT_REASONS,
  DEFAULT_REPORT_THANKS,
  defaultReporting,
  findReason,
  legacyCategoryOf,
  playerReporting,
  reasonLabel,
  reasonOfCategory,
  suggestedRule,
} from '../src/reporting.js';
import type { ReportReason, ReportReasonInput, ResolvedReporting } from '../src/reporting.js';
import { defineRules, starterRules } from '../src/rules.js';

// The `reporting` section of the profile: flow, reasons, thank-you. Defaults, validation tables, the policy layer, and the
// lookups the report service and the routes use.

const base = PRESETS.standard;
const reasonsOf = (p: ResolvedProfile): ReportReason[] => p.reporting.reasons;
const withReporting = (reporting: unknown): Record<string, unknown> => ({ ...(JSON.parse(JSON.stringify(base)) as Record<string, unknown>), reporting });
const bad = (reporting: unknown, path: string): void => {
  let caught: unknown;
  try {
    validateProfile(withReporting(reporting));
  } catch (err) {
    caught = err;
  }
  expect(caught, path).toBeInstanceOf(ProfileError);
  expect((caught as ProfileError).path).toBe(path);
};
const r = (id: string, over: Partial<ReportReasonInput> = {}): ReportReasonInput => ({ id, label: `Label ${id}`, ...over });
const other = (): ReportReasonInput => r('other', { label: 'Something else' });

describe('defaults', () => {
  it('every preset resolves to one_tap, the ten default reasons and the thank-you', () => {
    for (const name of ['relaxed', 'standard', 'strict'] as const) {
      const p = PRESETS[name];
      expect(p.reporting.flow).toBe('one_tap');
      expect(p.reporting.thanks).toBe("Thanks for the report. We'll look into it.");
      expect(p.reporting.reasons.map((x) => x.id)).toEqual([
        'harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info', 'cheating', 'griefing', 'afk', 'other',
      ]);
    }
  });

  it('the default reasons have the briefed labels, groups, rules, notes and are all on', () => {
    const table = DEFAULT_REPORT_REASONS.map((x) => [x.id, x.label, x.group, x.rules, x.asksNote, x.enabled]);
    expect(table).toEqual([
      ['harassment', 'Insults or harassment', 'Chat', [2], false, true],
      ['hate', 'Hate', 'Chat', [1], false, true],
      ['sexual', 'Sexual content', 'Chat', [3], false, true],
      ['threat', 'Threats', 'Chat', [2], false, true],
      ['spam', 'Spam or ads', 'Chat', [4], false, true],
      ['personal_info', 'Sharing personal info', 'Chat', [2], false, true],
      ['cheating', 'Cheating', 'Gameplay', [5], false, true],
      ['griefing', 'Throwing or griefing', 'Gameplay', [6], false, true],
      ['afk', 'Leaving or AFK', 'Gameplay', [6], false, true],
      ['other', 'Something else', '', [], true, true],
    ]);
    for (const x of DEFAULT_REPORT_REASONS) expect(x.hint.length).toBeGreaterThan(0);
  });

  it('every default rule number is an active starter rule, in all three flavours', () => {
    for (const flavour of ['relaxed', 'standard', 'strict'] as const) {
      const rules = defineRules(starterRules(flavour));
      for (const x of DEFAULT_REPORT_REASONS) for (const n of x.rules) expect(rules.isCitable(n), `${flavour} ${x.id} ${n}`).toBe(true);
    }
  });

  it('DEFAULT_REPORT_THANKS is the briefed copy and defaultReporting() is a fresh unfrozen copy each call', () => {
    expect(DEFAULT_REPORT_THANKS).toBe("Thanks for the report. We'll look into it.");
    const a = defaultReporting();
    const b = defaultReporting();
    a.reasons[0]!.label = 'changed';
    a.reasons[0]!.rules.push(9);
    expect(b.reasons[0]!.label).toBe('Insults or harassment');
    expect(b.reasons[0]!.rules).toEqual([2]);
    expect(Object.isFrozen(a)).toBe(false);
    expect(Object.isFrozen(DEFAULT_REPORT_REASONS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_REPORT_REASONS[0])).toBe(true);
    expect(Object.isFrozen(DEFAULT_REPORT_REASONS[0]!.rules)).toBe(true);
  });

  it('a resolved profile is deep-frozen, reporting included', () => {
    const p = resolveProfile('standard');
    expect(Object.isFrozen(p.reporting)).toBe(true);
    expect(Object.isFrozen(p.reporting.reasons)).toBe(true);
    expect(Object.isFrozen(p.reporting.reasons[0])).toBe(true);
    expect(Object.isFrozen(p.reporting.reasons[0]!.rules)).toBe(true);
  });
});

describe('a profile without reporting (0.1.1) or with part of it', () => {
  it('validateProfile accepts a profile with no reporting key', () => {
    const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    delete copy['reporting'];
    expect(() => validateProfile(copy)).not.toThrow();
  });

  it('defineProfile of a profile with no reporting gets the defaults', () => {
    const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    delete copy['reporting'];
    expect(defineProfile(copy as unknown as ModerationProfile).reporting).toEqual(defaultReporting());
  });

  it('an empty reporting object, or one with only a flow or only thanks, is filled', () => {
    expect(resolveProfile('standard', { reporting: {} }).reporting).toEqual(defaultReporting());
    expect(resolveProfile('standard', { reporting: { flow: 'reason_required' } }).reporting).toEqual({ ...defaultReporting(), flow: 'reason_required' });
    expect(resolveProfile('standard', { reporting: { thanks: 'Got it.' } }).reporting).toEqual({ ...defaultReporting(), thanks: 'Got it.' });
  });

  it('a reason given as { id, label } is filled: no hint, no group, no rules, no note, enabled', () => {
    const p = resolveProfile('standard', { reporting: { reasons: [r('lag'), other()] } });
    expect(p.reporting.reasons[0]).toEqual({ id: 'lag', label: 'Label lag', hint: '', group: '', rules: [], asksNote: false, enabled: true });
  });

  it('overriding one reporting key keeps the others (objects merge, the reasons list replaces)', () => {
    const p = resolveProfile('standard', { reporting: { flow: 'reason_first' } });
    expect(p.reporting.flow).toBe('reason_first');
    expect(p.reporting.reasons).toEqual(base.reporting.reasons);
    const q = resolveProfile('standard', { reporting: { reasons: [r('lag'), other()] } });
    expect(q.reporting.reasons.map((x) => x.id)).toEqual(['lag', 'other']);
    expect(q.reporting.flow).toBe('one_tap');
  });

  it('the input is not mutated and the result shares nothing with it', () => {
    const input = { reporting: { reasons: [r('lag', { rules: [4, 4] }), other()] } };
    const snapshot = JSON.stringify(input);
    const p = resolveProfile('standard', input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(p.reporting.reasons[0]!.rules).toEqual([4]);
    expect(p.reporting.reasons[0]).not.toBe(input.reporting.reasons[0]);
  });

  it('a layer-less applyPolicyLayer keeps the base reporting', () => {
    expect(applyPolicyLayer(base, {}).reporting).toEqual(base.reporting);
  });
});

describe('validation: the flow and the thank-you', () => {
  it.each(['one_tap', 'reason_first', 'reason_required'] as const)('flow %s is valid', (flow) => {
    expect(resolveProfile('standard', { reporting: { flow } }).reporting.flow).toBe(flow);
  });
  it.each([['pick'], [''], ['ONE_TAP'], [null], [1], [true], [{}], [['one_tap']]])('flow %j is refused', (flow) => {
    bad({ flow }, 'profile.reporting.flow');
  });
  it('thanks: 1 to 300 characters of text; blank, long and non-text are refused', () => {
    expect(resolveProfile('standard', { reporting: { thanks: 'x' } }).reporting.thanks).toBe('x');
    expect(resolveProfile('standard', { reporting: { thanks: 'x'.repeat(300) } }).reporting.thanks).toHaveLength(300);
    for (const thanks of ['', '   ', '\n', 'x'.repeat(301), null, 7, {}]) bad({ thanks }, 'profile.reporting.thanks');
  });
  it('an unknown key in reporting is refused with its path', () => {
    bad({ flow: 'one_tap', colour: 'red' }, 'profile.reporting.colour');
  });
  it('reporting itself must be an object', () => {
    for (const v of ['one_tap', 5, null, [], true]) bad(v, 'profile.reporting');
  });
});

describe('validation: the reasons list', () => {
  const list = (n: number): ReportReasonInput[] => [...Array.from({ length: n - 1 }, (_, i) => r(`reason${i}`)), other()];

  it('1 to 20 reasons: just other is valid, 20 is valid, 21 is refused, an empty list is refused', () => {
    expect(resolveProfile('standard', { reporting: { reasons: [other()] } }).reporting.reasons).toHaveLength(1);
    expect(resolveProfile('standard', { reporting: { reasons: list(20) } }).reporting.reasons).toHaveLength(20);
    bad({ reasons: list(21) }, 'profile.reporting.reasons');
    bad({ reasons: [] }, 'profile.reporting.reasons');
  });
  it('the list must be a list', () => {
    for (const reasons of ['harassment', 5, null, {}]) bad({ reasons }, 'profile.reporting.reasons');
  });
  it('each reason must be an object with an id and a label, and nothing else is known', () => {
    bad({ reasons: [other(), 'spam'] }, 'profile.reporting.reasons[1]');
    bad({ reasons: [other(), null] }, 'profile.reporting.reasons[1]');
    bad({ reasons: [other(), { label: 'No id' }] }, 'profile.reporting.reasons[1].id');
    bad({ reasons: [other(), { id: 'lag' }] }, 'profile.reporting.reasons[1].label');
    bad({ reasons: [other(), { id: 'lag', label: 'Lag', color: 'red' }] }, 'profile.reporting.reasons[1].color');
  });

  it.each(['a', 'spam', 'personal_info', 'toxic-chat', 'x1', '1st', 'a'.repeat(32), 'a_b_c', 'a-b_c'])('id %s is a valid slug', (id) => {
    expect(resolveProfile('standard', { reporting: { reasons: [r(id), other()] } }).reporting.reasons[0]!.id).toBe(id);
  });
  it.each(['', ' ', 'Spam', 'SPAM', 'two words', 'a'.repeat(33), '_a', 'a_', 'a__b', '-a', 'a-', 'a--b', 'ünï', 'a.b', 'a/b', '../x', 'none', 'a\n', 'dröp'])('id %j is refused', (id) => {
    bad({ reasons: [r(id), other()] }, 'profile.reporting.reasons[0].id');
  });
  it('ids must be strings', () => {
    for (const id of [1, null, undefined, {}, ['spam']]) {
      bad({ reasons: [{ id, label: 'x' }, other()] }, 'profile.reporting.reasons[0].id');
    }
  });
  it('ids are unique: the path names the second one', () => {
    bad({ reasons: [r('lag'), r('lag'), other()] }, 'profile.reporting.reasons[1].id');
    bad({ reasons: [r('other'), other()] }, 'profile.reporting.reasons[1].id');
  });
  it('ids that look like object keys are ordinary slugs (and a prototype key is not special)', () => {
    const p = resolveProfile('standard', { reporting: { reasons: [r('constructor'), r('tostring'), r('proto'), other()] } });
    expect(findReason(p.reporting.reasons, 'constructor')?.id).toBe('constructor');
    expect(findReason(p.reporting.reasons, 'valueOf')).toBeUndefined();
    expect(findReason(p.reporting.reasons, '__proto__')).toBeUndefined();
  });

  it('labels: 1 to 60 characters; blank, long and non-text are refused', () => {
    expect(resolveProfile('standard', { reporting: { reasons: [r('a', { label: 'x'.repeat(60) }), other()] } }).reporting.reasons[0]!.label).toHaveLength(60);
    for (const label of ['', '  ', 'x'.repeat(61), null, 3, {}]) bad({ reasons: [{ id: 'a', label }, other()] }, 'profile.reporting.reasons[0].label');
  });
  it('hints: 0 to 160 characters of text', () => {
    expect(resolveProfile('standard', { reporting: { reasons: [r('a', { hint: '' }), r('b', { hint: 'x'.repeat(160) }), other()] } }).reporting.reasons[1]!.hint).toHaveLength(160);
    for (const hint of ['x'.repeat(161), null, 3, {}]) bad({ reasons: [r('a', { hint } as never), other()] }, 'profile.reporting.reasons[0].hint');
  });
  it('groups: 0 to 40 characters of text; an empty group means no heading', () => {
    const p = resolveProfile('standard', { reporting: { reasons: [r('a', { group: '' }), r('b', { group: 'Chat' }), r('c', { group: 'x'.repeat(40) }), other()] } });
    expect(p.reporting.reasons.map((x) => x.group.length > 0)).toEqual([false, true, true, false]);
    for (const group of ['x'.repeat(41), null, 3]) bad({ reasons: [r('a', { group } as never), other()] }, 'profile.reporting.reasons[0].group');
  });
  it('asksNote and enabled must be true or false', () => {
    for (const asksNote of ['yes', 1, null, 0]) bad({ reasons: [r('a', { asksNote } as never), other()] }, 'profile.reporting.reasons[0].asksNote');
    for (const enabled of ['yes', 1, null, 0]) bad({ reasons: [r('a', { enabled } as never), other()] }, 'profile.reporting.reasons[0].enabled');
  });

  it('rules: whole rule numbers from 1, at most 20, repeats removed, order kept; [] is fine', () => {
    const ok = (rules: number[]) => resolveProfile('standard', { reporting: { reasons: [r('a', { rules }), other()] } }).reporting.reasons[0]!.rules;
    expect(ok([])).toEqual([]);
    expect(ok([3, 1, 3, 2])).toEqual([3, 1, 2]);
    expect(ok(Array.from({ length: 20 }, (_, i) => i + 1))).toHaveLength(20);
    bad({ reasons: [r('a', { rules: Array.from({ length: 21 }, (_, i) => i + 1) }), other()] }, 'profile.reporting.reasons[0].rules');
    bad({ reasons: [r('a', { rules: Array(5000).fill(1) as number[] }), other()] }, 'profile.reporting.reasons[0].rules');
    for (const [i, v] of [0, -1, 1.5, NaN, Infinity, '2', null, {}].entries()) {
      bad({ reasons: [r('a', { rules: [1, v as number] }), other()] }, 'profile.reporting.reasons[0].rules[1]');
      void i;
    }
    bad({ reasons: [r('a', { rules: 'two' as never }), other()] }, 'profile.reporting.reasons[0].rules');
  });

  it('at least one reason must be enabled; other must be there and on', () => {
    bad({ reasons: [r('lag', { enabled: false }), r('other', { enabled: false })] }, 'profile.reporting.reasons');
    bad({ reasons: [r('lag')] }, 'profile.reporting.reasons');
    bad({ reasons: [r('lag'), r('other', { enabled: false })] }, 'profile.reporting.reasons[1].enabled');
    expect(resolveProfile('standard', { reporting: { reasons: [r('lag', { enabled: false }), other()] } }).reporting.reasons[0]!.enabled).toBe(false);
  });
  it('other can be relabelled, re-grouped, re-hinted, given rules and a note setting', () => {
    const p = resolveProfile('standard', {
      reporting: { reasons: [r('other', { label: 'Anything else', hint: 'Tell us', group: 'More', rules: [8], asksNote: false })] },
    });
    expect(p.reporting.reasons[0]).toEqual({ id: 'other', label: 'Anything else', hint: 'Tell us', group: 'More', rules: [8], asksNote: false, enabled: true });
  });
  it('a reason may be switched off and the others reordered freely', () => {
    const p = resolveProfile('standard', { reporting: { reasons: [other(), r('b', { enabled: false }), r('a')] } });
    expect(p.reporting.reasons.map((x) => [x.id, x.enabled])).toEqual([['other', true], ['b', false], ['a', true]]);
  });
});

describe('the policy layer carries reporting', () => {
  it("'reporting' is an editable section, listed before 'ai'", () => {
    expect(POLICY_SECTIONS.at(-2)).toBe('reporting');
    expect(POLICY_SECTIONS.at(-1)).toBe('ai');
    expect(POLICY_SECTIONS).toContain('reporting');
  });

  it('a layer with a flow only changes the flow; the reasons and the thank-you stay the base', () => {
    const eff = applyPolicyLayer(base, { reporting: { flow: 'reason_required' } });
    expect(eff.reporting.flow).toBe('reason_required');
    expect(eff.reporting.reasons).toEqual(base.reporting.reasons);
    expect(eff.reporting.thanks).toBe(base.reporting.thanks);
  });

  it('a layer with reasons replaces the list whole; thanks replaces the copy', () => {
    const eff = applyPolicyLayer(base, { reporting: { reasons: [r('lag', { rules: [4] }), other()], thanks: 'Thank you!' } });
    expect(eff.reporting.reasons.map((x) => x.id)).toEqual(['lag', 'other']);
    expect(eff.reporting.thanks).toBe('Thank you!');
  });

  it('an invalid reporting layer is refused with a layer path', () => {
    const attempt = (layer: unknown): string => {
      try {
        applyPolicyLayer(base, layer as PolicyLayer);
      } catch (err) {
        return (err as ProfileError).path;
      }
      return 'no error';
    };
    expect(attempt({ reporting: { flow: 'pick' } })).toBe('layer.reporting.flow');
    expect(attempt({ reporting: { reasons: [] } })).toBe('layer.reporting.reasons');
    expect(attempt({ reporting: { reasons: [r('Bad Id'), other()] } })).toBe('layer.reporting.reasons[0].id');
    expect(attempt({ reporting: { reasons: [r('a')] } })).toBe('layer.reporting.reasons');
    expect(attempt({ reporting: 'x' })).toBe('layer.reporting');
    expect(attempt({ reporting: { flow: 'one_tap', extra: 1 } })).toBe('layer.reporting.extra');
  });

  it('changedSections sees a reporting edit and nothing else', () => {
    expect(changedSections({}, { reporting: { flow: 'reason_first' } })).toEqual(['reporting']);
    expect(changedSections({ reporting: { flow: 'reason_first' } }, { reporting: { flow: 'reason_first' } })).toEqual([]);
    expect(changedSections({ reporting: { flow: 'reason_first' } }, { reporting: { flow: 'one_tap' } })).toEqual(['reporting']);
    expect(changedSections({ reporting: { reasons: [other()] } }, { reporting: { reasons: [other()] }, durations: [1] })).toEqual(['durations']);
  });

  it('a layer reason with a flow of a code override on top keeps both (code overrides, then layer)', () => {
    const codeBase = resolveProfile('standard', { reporting: { thanks: 'From code.', flow: 'reason_first' } });
    const eff = applyPolicyLayer(codeBase, { reporting: { flow: 'reason_required' } });
    expect(eff.reporting.thanks).toBe('From code.');
    expect(eff.reporting.flow).toBe('reason_required');
  });
});

describe('lookups', () => {
  const reasons = reasonsOf(base);

  it('findReason: exact id, old alias, disabled reasons too, and nothing for an unknown id', () => {
    expect(findReason(reasons, 'hate')?.id).toBe('hate');
    expect(findReason(reasons, 'disruption')?.id).toBe('griefing');
    expect(findReason(reasons, 'nope')).toBeUndefined();
    expect(findReason(reasons, '')).toBeUndefined();
    const off = resolveProfile('standard', { reporting: { reasons: [r('lag', { enabled: false }), other()] } }).reporting.reasons;
    expect(findReason(off, 'lag')?.enabled).toBe(false);
  });
  it('an exact id beats an alias: a studio reason called disruption stays itself', () => {
    const own = resolveProfile('standard', { reporting: { reasons: [r('disruption'), r('griefing'), other()] } }).reporting.reasons;
    expect(findReason(own, 'disruption')?.id).toBe('disruption');
    expect(canonicalReasonId(own, 'disruption')).toBe('disruption');
  });
  it('an alias with no target in the list is unknown', () => {
    const none = resolveProfile('standard', { reporting: { reasons: [r('lag'), other()] } }).reporting.reasons;
    expect(findReason(none, 'disruption')).toBeUndefined();
  });
  it('canonicalReasonId and reasonLabel', () => {
    expect(canonicalReasonId(reasons, 'disruption')).toBe('griefing');
    expect(canonicalReasonId(reasons, 'spam')).toBe('spam');
    expect(canonicalReasonId(reasons, 'gone')).toBe('gone');
    expect(reasonLabel(reasons, 'disruption')).toBe('Throwing or griefing');
    expect(reasonLabel(reasons, 'hate')).toBe('Hate');
    expect(reasonLabel(reasons, null)).toBeNull();
    expect(reasonLabel(reasons, 'gone')).toBeNull();
  });
  it('reasonOfCategory and legacyCategoryOf', () => {
    expect(['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'].map(reasonOfCategory)).toEqual(['harassment', 'hate', 'cheating', 'spam', 'griefing', 'other']);
    const table = ['harassment', 'hate', 'cheating', 'spam', 'other', 'griefing', 'afk', 'disruption', 'threat', 'sexual', 'personal_info', 'lag', null, ''].map((x) => legacyCategoryOf(x));
    expect(table).toEqual(['harassment', 'hate', 'cheating', 'spam', 'other', 'disruption', 'disruption', 'disruption', 'harassment', 'other', 'other', 'other', 'other', 'other']);
  });
  it('legacyCategoryOf maps every default reason to one of the six old categories', () => {
    const six = ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'];
    for (const x of DEFAULT_REPORT_REASONS) expect(six).toContain(legacyCategoryOf(x.id));
  });

  it('suggestedRule: the first citable rule of the reason, else uncovered', () => {
    const rules = defineRules(starterRules('standard'));
    expect(suggestedRule(reasons, 'hate', rules)).toBe(1);
    expect(suggestedRule(reasons, 'disruption', rules)).toBe(6);
    expect(suggestedRule(reasons, 'other', rules)).toBe('uncovered');
    expect(suggestedRule(reasons, null, rules)).toBe('uncovered');
    expect(suggestedRule(reasons, 'gone', rules)).toBe('uncovered');
    const multi = resolveProfile('standard', { reporting: { reasons: [r('a', { rules: [99, 3, 2] }), r('b', { rules: [99] }), other()] } }).reporting.reasons;
    expect(suggestedRule(multi, 'a', rules)).toBe(3);
    expect(suggestedRule(multi, 'b', rules)).toBe('uncovered');
    const retired = defineRules(starterRules('standard').map((x) => (x.number === 1 ? { ...x, retired: true } : x)));
    expect(suggestedRule(reasons, 'hate', retired)).toBe('uncovered');
  });
});

describe('playerReporting: what a player may read', () => {
  const sample: ResolvedReporting = {
    flow: 'reason_first',
    thanks: 'Thank you.',
    reasons: [
      { id: 'a', label: 'A', hint: 'hint a', group: 'G', rules: [1, 2], asksNote: true, enabled: true },
      { id: 'b', label: 'B', hint: '', group: '', rules: [3], asksNote: false, enabled: false },
      { id: 'other', label: 'Else', hint: 'h', group: '', rules: [], asksNote: true, enabled: true },
    ],
  };

  it('lists enabled reasons in order with exactly id, label, hint, group, asksNote', () => {
    const p = playerReporting(sample);
    expect(p).toEqual({
      flow: 'reason_first',
      thanks: 'Thank you.',
      reasons: [
        { id: 'a', label: 'A', hint: 'hint a', group: 'G', asksNote: true },
        { id: 'other', label: 'Else', hint: 'h', group: '', asksNote: true },
      ],
    });
    for (const x of p.reasons) expect(Object.keys(x).sort()).toEqual(['asksNote', 'group', 'hint', 'id', 'label']);
    expect(Object.keys(p).sort()).toEqual(['flow', 'reasons', 'thanks']);
  });
  it('shows no rule mapping and no enabled flag anywhere', () => {
    expect(JSON.stringify(playerReporting(sample))).not.toMatch(/rules|enabled/);
  });
  it('a field added to a reason later does not leak', () => {
    const extended = { ...sample, reasons: sample.reasons.map((x) => ({ ...x, staffOnly: 'secret-cw-77' })) } as ResolvedReporting;
    expect(JSON.stringify(playerReporting(extended))).not.toContain('secret-cw-77');
  });
  it('the result shares nothing with the settings', () => {
    const p = playerReporting(sample);
    p.reasons[0]!.label = 'changed';
    expect(sample.reasons[0]!.label).toBe('A');
  });
});

// ---- type-level: compiled by `tsc -b packages/core/tsconfig.test.json` ---------------------------------------------------

describe('types', () => {
  it('a 0.1.1 profile literal (no reporting) still type-checks as a ModerationProfile', () => {
    const legacy: ModerationProfile = { ...(base as ModerationProfile) };
    delete legacy.reporting;
    expect(legacy.reporting).toBeUndefined();
  });
  it('the input type takes partial settings; the resolved type has everything', () => {
    const input: ModerationProfile['reporting'] = { reasons: [{ id: 'lag', label: 'Lag' }] };
    expect(input?.flow).toBeUndefined();
    const resolved: ResolvedProfile = base;
    const flow: 'one_tap' | 'reason_first' | 'reason_required' = resolved.reporting.flow;
    const thanks: string = resolved.reporting.thanks;
    expect([flow, thanks]).toBeDefined();
    // @ts-expect-error a ResolvedProfile's reporting is required, so a profile without it is not one
    const notResolved: ResolvedProfile = { ...base, reporting: undefined };
    expect(notResolved).toBeDefined();
  });
});
