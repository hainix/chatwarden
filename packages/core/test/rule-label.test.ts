import { describe, expect, it } from 'vitest';
import { communityRuleLabel } from '../src/noticeCopy.js';
import { CommunityRules, defineRules, STARTER_RULES, starterRules } from '../src/rules.js';

// communityRuleLabel is the one place "Community Rule 2: Title" is built; CommunityRules.label calls it, the hub calls it with the titles
// it read from the server.

const rule = (number: number, over: Partial<{ title: string; retired: boolean }> = {}) => ({ number, title: `Title ${number}`, text: `Text ${number}.`, ...over });

describe('communityRuleLabel', () => {
  it('names a numbered rule with its title, a number alone without one, and "uncovered" in plain words', () => {
    expect(communityRuleLabel(3, 'Title 3')).toBe('Community Rule 3: Title 3');
    expect(communityRuleLabel(99)).toBe('Community Rule 99');
    expect(communityRuleLabel('uncovered')).toBe('Not covered by a rule yet');
    expect(communityRuleLabel('uncovered', 'ignored')).toBe('Not covered by a rule yet');
  });

  it('keeps a title exactly as given (no trimming, no markup change)', () => {
    expect(communityRuleLabel(1, 'No <b>x</b>: really')).toBe('Community Rule 1: No <b>x</b>: really');
  });
});

describe('communityRuleLabel equals CommunityRules.label', () => {
  const rules = new CommunityRules([rule(1), rule(2, { retired: true }), rule(3)]);
  const titleOf = (n: number) => rules.all().find((r) => r.number === n)?.title;

  it.each([
    ['numbered', 1],
    ['numbered, later', 3],
    ['retired', 2],
    ['unknown', 99],
    ['uncovered', 'uncovered' as const],
  ])('%s', (_name, ref) => {
    expect(communityRuleLabel(ref, ref === 'uncovered' ? undefined : titleOf(ref))).toBe(rules.label(ref));
  });

  it('every starter rule in every flavour', () => {
    for (const flavour of ['relaxed', 'standard', 'strict'] as const) {
      const r = defineRules(starterRules(flavour));
      for (const x of r.all()) expect(communityRuleLabel(x.number, x.title), `${flavour} ${x.number}`).toBe(r.label(x.number));
      expect(communityRuleLabel('uncovered')).toBe(r.label('uncovered'));
      expect(communityRuleLabel(0)).toBe(r.label(0));
    }
    expect(new CommunityRules(STARTER_RULES).label(7)).toBe('Community Rule 7: No offensive names');
  });
});
