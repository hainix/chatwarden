import { describe, expect, it } from 'vitest';
import {
  canonicalReasonId,
  DEFAULT_REPORT_REASONS,
  defaultReporting,
  findReason,
  legacyCategoryOf,
  playerReporting,
  reasonLabel,
  reasonOfCategory,
  suggestedRule,
} from '../src/reporting.js';
import { defineRules, starterRules } from '../src/rules.js';
import { OWNER, world } from './reportingWorld.js';

// The `name` default reason (0.2.0): an offensive or inappropriate player name, under Chat, citing CR 7.

const FLAVOURS = ['relaxed', 'standard', 'strict'] as const;
const ids = () => DEFAULT_REPORT_REASONS.map((r) => r.id);

describe('the name reason', () => {
  it('name is a default reason: label, hint, group Chat, rules [7], no note, enabled, after personal_info', () => {
    const name = DEFAULT_REPORT_REASONS.find((r) => r.id === 'name');
    expect(name).toEqual({
      id: 'name',
      label: 'Inappropriate name',
      hint: 'An offensive or inappropriate player name',
      group: 'Chat',
      rules: [7],
      asksNote: false,
      enabled: true,
      urgent: false,
      thanks: null,
      showResources: false,
    });
    expect(ids().indexOf('name')).toBe(6);
    expect(ids().indexOf('name')).toBe(ids().indexOf('personal_info') + 1);
    expect(ids()[ids().indexOf('name') + 1]).toBe('welfare');
  });

  it('the defaults are 12 (welfare, switched off, is the new one) and the list stays frozen', () => {
    expect(DEFAULT_REPORT_REASONS).toHaveLength(12);
    expect(ids()).toEqual(['harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info', 'name', 'welfare', 'cheating', 'griefing', 'afk', 'other']);
    expect(Object.isFrozen(DEFAULT_REPORT_REASONS)).toBe(true);
    const name = DEFAULT_REPORT_REASONS[6]!;
    expect(Object.isFrozen(name)).toBe(true);
    expect(Object.isFrozen(name.rules)).toBe(true);
    expect(() => (name.rules as number[]).push(1)).toThrow();
    expect(defaultReporting().reasons).toHaveLength(12);
    expect(defaultReporting().reasons[6]!.rules).toEqual([7]);
  });

  it.each(FLAVOURS)('CR 7 is "No offensive names" in %s', (flavour) => {
    expect(starterRules(flavour)[6]).toMatchObject({ number: 7, title: 'No offensive names' });
    expect(defineRules(starterRules(flavour)).isCitable(7)).toBe(true);
  });

  it('suggestedRule is 7 for name and uncovered when rule 7 is retired or the list has no such reason', () => {
    const reasons = defaultReporting().reasons;
    const rules = defineRules(starterRules('standard'));
    expect(suggestedRule(reasons, 'name', rules)).toBe(7);
    expect(suggestedRule(reasons, 'personal_info', rules)).toBe(2);
    expect(suggestedRule(reasons, 'name', { isCitable: (n) => n !== 7 })).toBe('uncovered');
    expect(suggestedRule(reasons.filter((r) => r.id !== 'name'), 'name', rules)).toBe('uncovered');
  });

  it("legacyCategoryOf('name') is other and reasonOfCategory leaves it alone", () => {
    expect(legacyCategoryOf('name')).toBe('other');
    expect(reasonOfCategory('name')).toBe('name');
  });

  it('canonicalReasonId and reasonLabel find it', () => {
    const reasons = defaultReporting().reasons;
    expect(canonicalReasonId(reasons, 'name')).toBe('name');
    expect(findReason(reasons, 'name')?.id).toBe('name');
    expect(reasonLabel(reasons, 'name')).toBe('Inappropriate name');
    expect(reasonLabel(reasons.filter((r) => r.id !== 'name'), 'name')).toBeNull();
  });

  it('players read it under Chat with no rule mapping', () => {
    const p = playerReporting(defaultReporting());
    expect(p.reasons.find((r) => r.id === 'name')).toEqual({
      id: 'name',
      label: 'Inappropriate name',
      hint: 'An offensive or inappropriate player name',
      group: 'Chat',
      asksNote: false,
      thanks: null,
      showResources: false,
    });
  });

  it('a profile with a reasons list of its own does not gain name; reset restores the defaults including name', async () => {
    const { cw } = await world();
    const own = [{ id: 'lag', label: 'Lag switching', group: 'Gameplay', rules: [5] }, { id: 'other', label: 'Something else' }];
    expect(cw.policy.save({ reporting: { reasons: own } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect(cw.profile.reporting.reasons.map((r) => r.id)).toEqual(['lag', 'other']);
    expect(cw.policy.reset('reporting')).toMatchObject({ ok: true, changed: ['reporting'] });
    expect(cw.profile.reporting.reasons).toHaveLength(12);
    expect(cw.profile.reporting.reasons.map((r) => r.id)).toContain('name');
  });

  it('a fresh profile has name in every preset', async () => {
    const { cw } = await world();
    expect(cw.profile.reporting.reasons[6]).toMatchObject({ id: 'name', rules: [7], enabled: true });
  });
});
