// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@chatwarden/core';
import { ACTION_LABEL, policyAuditKey } from '../src/auditLabel.js';
import { en } from '../src/i18n.js';

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

describe('ACTION_LABEL', () => {
  it('the hub labels the three new actions', () => {
    expect(ACTION_LABEL['ai.read']).toBe('hub.audit.label.ai.read');
    expect(ACTION_LABEL['ai.rerun']).toBe('hub.audit.label.ai.rerun');
    expect(ACTION_LABEL['ai.outcome']).toBe('hub.audit.label.ai.outcome');
    expect(en['hub.audit.label.ai.read']).toBe('The AI read a report');
    expect(en['hub.audit.label.ai.rerun']).toBe('Asked the AI to read a report again');
    expect(en['hub.audit.label.ai.outcome']).toBe('Recorded a decision against the AI read');
  });

  it('the hub labels the three actions of the appeals and names release, in plain words', () => {
    expect(ACTION_LABEL['appeal.view']).toBe('hub.audit.label.appeal.view');
    expect(ACTION_LABEL['appeal.decide']).toBe('hub.audit.label.appeal.decide');
    expect(ACTION_LABEL['name.rename_required']).toBe('hub.audit.label.name.renameRequired');
    expect(en['hub.audit.label.appeal.view']).toBe('Viewed appeals');
    expect(en['hub.audit.label.appeal.decide']).toBe('Decided an appeal');
    expect(en['hub.audit.label.name.renameRequired']).toBe('Asked a player to choose a new name');
    // the words never carry the statement or a reason, and never a raw action name
    for (const key of ['hub.audit.label.appeal.view', 'hub.audit.label.appeal.decide', 'hub.audit.label.name.renameRequired'] as const) {
      expect(en[key]).not.toMatch(/appeal\.|name\./);
    }
  });

  it('the hub labels person.automation in plain words, without the code or an action name', () => {
    expect(ACTION_LABEL['person.automation']).toBe('hub.audit.label.person.automation');
    expect(en['hub.audit.label.person.automation']).toBe('Changed the "do not automate" mark on a person');
    expect(en['hub.audit.label.person.automation']).not.toMatch(/person\./);
  });

  it('an appeal target has words of its own', () => {
    expect(en['hub.audit.target.appeal']).toBe('Appeal {tag}');
  });

  it('hub: both community actions have a label in the audit list and words for a screen reader, in plain words', () => {
    expect(ACTION_LABEL['term.share']).toBe('hub.audit.label.term.share');
    expect(ACTION_LABEL['community.apply']).toBe('hub.audit.label.community.apply');
    expect(en['hub.audit.label.term.share']).toBe('Offered a term to the community list');
    expect(en['hub.audit.label.community.apply']).toBe('Applied a community list release');
    expect(ACTION_LABEL['term.report']).toBe('hub.audit.label.term.report');
    expect(en['hub.audit.label.term.report']).toBe('Reported a problem with a community term');
    expect(en['hub.audit.label.term.report']).not.toBe(en['hub.audit.label.term.share']);
    expect(en['hub.audit.target.release']).toBe('Release {version}');
    // the words never carry a raw action name and never a term
    for (const key of ['hub.audit.label.term.share', 'hub.audit.label.term.report', 'hub.audit.label.community.apply', 'hub.audit.target.release'] as const) {
      expect(en[key]).not.toMatch(/term\.share|term\.report|community\.apply/);
      expect(en[key]).not.toMatch(/zorbak|vlemmo|quissel/);
    }
  });

  it('every action the kit records has plain words', () => {
    for (const action of AUDIT_ACTIONS) {
      const key = ACTION_LABEL[action];
      const words = (en as Record<string, string>)[key];
      expect(words, action).toBeTypeOf('string');
      expect((words ?? '').length, action).toBeGreaterThan(5);
      // A label is words, never the raw action name.
      expect(words, action).not.toBe(action);
    }
  });

  it('keeps the labels it had', () => {
    expect(ACTION_LABEL['report.dismiss_case']).toBe('hub.audit.label.report.dismissCase');
    expect(ACTION_LABEL['policy.update']).toBe('hub.audit.label.policy.update');
    expect(ACTION_LABEL.suggest).toBe('hub.audit.label.suggest');
  });
});

describe('the privacy and legal-hold audit actions (0.2.0)', () => {
  const SIX = ['privacy.find', 'privacy.export', 'privacy.erase', 'legal.hold', 'legal.release', 'legal.bundle'] as const;

  it('each of the six has a label key, and its text is in the catalog', () => {
    for (const action of SIX) {
      expect(AUDIT_ACTIONS, action).toContain(action);
      const key = ACTION_LABEL[action];
      expect(key, action).toMatch(/^hub\.audit\.label\.(privacy|legal)\./);
      expect((en as Record<string, string>)[key], key).toBeTruthy();
    }
  });

  it('the words say what was done, in plain terms, with no claim of compliance', () => {
    const text = SIX.map((a) => (en as Record<string, string>)[ACTION_LABEL[a]] as string);
    expect(text).toEqual([
      'Looked up a person for a privacy request',
      'Exported the data held about a person',
      'Erased the data held about a person',
      'Held a report for legal reasons',
      'Released a legal hold',
      'Downloaded the evidence bundle of a report',
    ]);
    for (const t of text) expect(t).not.toMatch(/complian|lawful|GDPR/i);
  });

  it('every action the kit records has a label (a new action is a compile error until it has a word)', () => {
    for (const action of AUDIT_ACTIONS) expect(ACTION_LABEL[action], action).toBeTruthy();
  });
});
