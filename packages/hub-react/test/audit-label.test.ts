// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { policyAuditKey } from '../src/auditLabel.js';

// A settings change is one audit action for two screens; its words follow the sections the row says it changed.

describe('policyAuditKey', () => {
  it.each([
    ['policy.update', ['reporting'], 'hub.audit.label.policy.update.reporting'],
    ['policy.reset', ['reporting'], 'hub.audit.label.policy.reset.reporting'],
    ['policy.update', ['ladder'], 'hub.audit.label.policy.update.ladder'],
    ['policy.update', ['durations', 'customDuration'], 'hub.audit.label.policy.update.ladder'],
    ['policy.reset', ['areaRules', 'severeRules', 'guidelines'], 'hub.audit.label.policy.reset.ladder'],
    ['policy.update', ['ladder', 'reporting'], 'hub.audit.label.policy.update'],
    ['policy.reset', ['durations', 'reporting'], 'hub.audit.label.policy.reset'],
  ] as const)('%s of %j reads as %s', (action, sections, key) => {
    expect(policyAuditKey(action, { sections: [...sections], reason: 'x' })).toBe(key);
  });

  it.each([
    ['no detail', undefined],
    ['an empty list', { sections: [], reason: 'x' }],
    ['a list that is not a list', { sections: 'reporting', reason: 'x' }],
    ['an object with no sections', { reason: 'x' }],
    ['null', null],
    ['a string', 'reporting'],
  ])('%s falls back to the general words', (_n, detail) => {
    expect(policyAuditKey('policy.update', detail)).toBe('hub.audit.label.policy.update');
    expect(policyAuditKey('policy.reset', detail)).toBe('hub.audit.label.policy.reset');
  });

  it('a section a newer kit adds is not guessed at: the general words', () => {
    expect(policyAuditKey('policy.update', { sections: ['profanity'] })).toBe('hub.audit.label.policy.update');
    expect(policyAuditKey('policy.update', { sections: ['reporting', 'profanity'] })).toBe('hub.audit.label.policy.update');
  });

  it('is only for the two settings actions', () => {
    expect(policyAuditKey('report.view', { sections: ['reporting'] })).toBeNull();
  });
});
