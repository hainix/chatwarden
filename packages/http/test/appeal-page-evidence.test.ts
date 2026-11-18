import { describe, expect, it } from 'vitest';
import type { AppealCase } from '@chatwarden/core';
import { noticeWordsFor } from '@chatwarden/core/notice-locales';
import { renderAppealPage } from '../src/appealPage.js';
import type { AppealPageView } from '../src/appealPage.js';

// The appeal page words follow the notice's evidence kind (0.2.2, audit P1, P2, P5, P11).

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const caseOf = (notice: Record<string, unknown>, over: Partial<AppealCase> = {}): AppealCase => ({
  notice: { kind: 'warning', rule: 6, ruleLabel: 'Community Rule 6: No throwing', until: null, refCode: 'M-ABCDE', createdAt: NOW, excerpt: [], ...notice } as unknown as AppealCase['notice'],
  canAppeal: true,
  appeal: null,
  standing: null,
  expiresAt: NOW + 30 * 24 * HOUR,
  emailsOutcome: false,
  contact: null,
  statementMax: 1000,
  ...over,
});
const page = (locale: string, c: AppealCase): string =>
  renderAppealPage({ state: 'case', locale, words: noticeWordsFor(locale).words, token: 'abc.def', case: c, now: NOW } as AppealPageView);

describe('the appeal page', () => {
  it('a warning for play says how you played, and names no message', () => {
    const html = page('en', caseOf({ evidence: 'play' }));
    expect(html).toContain('A moderator gave you a warning for how you played.');
    expect(html).not.toMatch(/something you wrote|Your messages/);
  });
  it('a warning with no kind is neutral', () => {
    const html = page('en', caseOf({}));
    expect(html).toContain('A moderator gave you a warning for breaking a community rule.');
    expect(html).not.toMatch(/something you wrote/);
  });
  it('a chat warning keeps "something you wrote" and the chat label for its lines', () => {
    const html = page('en', caseOf({ evidence: 'chat', excerpt: [{ text: 'hello there', day: '2027-01-14' }] }));
    expect(html).toContain('something you wrote');
    expect(html).toContain('Your messages that led to this');
  });
  it('lines a moderator added to a neutral notice are labelled "What led to this"', () => {
    const html = page('en', caseOf({ excerpt: [{ text: 'hello there', day: '2027-01-14' }] }));
    expect(html).toContain('What led to this');
    expect(html).not.toContain('Your messages');
  });
  it('in Spanish and Portuguese the play warning does not say "something you wrote"', () => {
    expect(page('es', caseOf({ evidence: 'play' }))).not.toMatch(/escribiste/);
    expect(page('pt', caseOf({ evidence: 'play' }))).not.toMatch(/escreveu/);
    expect(page('es', caseOf({ evidence: 'chat' }))).toMatch(/escribiste/);
  });
  it('a decided appeal shows the neutral reason', () => {
    const c = caseOf({ evidence: 'play' }, { canAppeal: false, appeal: { status: 'upheld', reason: 'rule_applies', createdAt: NOW } as unknown as AppealCase['appeal'] });
    const html = page('en', c);
    expect(html).toContain('The rule applies to what happened.');
    expect(html).not.toContain('what was said');
  });
});
