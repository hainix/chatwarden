// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { APPEAL_WORDS } from '@chatwarden/core/notice-locales';
import { createT, en } from '../src/i18n.js';
import { es } from '../src/locales/es.js';
import { pt } from '../src/locales/pt.js';
import { placeholders } from './locales.helpers.js';

// The hub's new words for the appeals landing release (0.2.1): the fixed reason, "What caused this", the term review flag, the filter overturned count and the
// three link, contact and email settings. Each key is in English and in the two machine drafts, and the nine reason sentences read exactly as the person is shown them.

const FAMILIES = {
  reasonCode: [
    'hub.appeals.reasonCode.legend',
    'hub.appeals.reasonCode.uphold.rule_applies',
    'hub.appeals.reasonCode.uphold.evidence_clear',
    'hub.appeals.reasonCode.uphold.context_considered',
    'hub.appeals.reasonCode.reduce.first_offence',
    'hub.appeals.reasonCode.reduce.lighter_fits',
    'hub.appeals.reasonCode.reduce.context_considered',
    'hub.appeals.reasonCode.revoke.mistake',
    'hub.appeals.reasonCode.revoke.not_a_violation',
    'hub.appeals.reasonCode.revoke.context_considered',
  ],
  cause: [
    'hub.appeals.cause.title',
    'hub.appeals.cause.term.one',
    'hub.appeals.cause.term.other',
    'hub.appeals.cause.term.word',
    'hub.appeals.cause.term.unknown',
    'hub.appeals.cause.term.show',
    'hub.appeals.cause.term.hide',
    'hub.appeals.cause.term.open',
    'hub.appeals.cause.filter',
    'hub.appeals.cause.filter.open',
    'hub.appeals.cause.report.human',
    'hub.appeals.cause.report.ai',
    'hub.appeals.cause.report.open',
    'hub.appeals.cause.other.coop',
    'hub.appeals.cause.other.api',
  ],
  fail: ['hub.appeals.fail.reason'],
  termFlag: ['hub.terms.flag.one', 'hub.terms.flag.other', 'hub.terms.flag.review', 'hub.terms.flag.review.label'],
  filterCount: ['hub.settings.filters.hits.overturned'],
  settings: [
    'hub.settings.appeals.where',
    'hub.settings.appeals.link.label',
    'hub.settings.appeals.link.hint',
    'hub.settings.appeals.link.days.one',
    'hub.settings.appeals.link.days.other',
    'hub.settings.appeals.link.custom',
    'hub.settings.appeals.contact.label',
    'hub.settings.appeals.contact.hint',
    'hub.settings.appeals.contact.error',
    'hub.settings.appeals.emails.label',
    'hub.settings.appeals.emails.hint',
  ],
} as const;
const ALL = Object.values(FAMILIES).flat();

describe('the new appeals words', () => {
  it('counts the keys by family', () => {
    expect(Object.fromEntries(Object.entries(FAMILIES).map(([k, v]) => [k, v.length]))).toEqual({ reasonCode: 10, cause: 15, fail: 1, termFlag: 4, filterCount: 1, settings: 11 });
  });

  it.each(ALL)('%s is in English, Spanish and Portuguese, with the same placeholders', (key) => {
    const english = (en as Record<string, string>)[key];
    expect(typeof english, `${key} (en)`).toBe('string');
    for (const [name, catalog] of [['es', es], ['pt', pt]] as const) {
      const text = (catalog as Record<string, string>)[key];
      expect(typeof text, `${key} (${name})`).toBe('string');
      expect(text, `${key} (${name}) is not English`).not.toBe(english);
      expect(placeholders(text as string)).toEqual(placeholders(english as string));
    }
  });

  it('the nine English reason labels are the sentences the person is shown (spec 5.2), and core\'s own words', () => {
    const shown: Record<string, string> = {
      'hub.appeals.reasonCode.uphold.rule_applies': 'The rule applies to what was said.',
      'hub.appeals.reasonCode.uphold.evidence_clear': 'The chat record shows the rule was broken.',
      'hub.appeals.reasonCode.uphold.context_considered': 'We looked at the whole conversation, and the decision stands.',
      'hub.appeals.reasonCode.reduce.first_offence': 'We lightened it because this was a first offence.',
      'hub.appeals.reasonCode.reduce.lighter_fits': 'A lighter action fits what happened.',
      'hub.appeals.reasonCode.reduce.context_considered': 'We looked at the whole conversation and lightened it.',
      'hub.appeals.reasonCode.revoke.mistake': 'This was our mistake. We are sorry.',
      'hub.appeals.reasonCode.revoke.not_a_violation': 'What was said does not break the rules.',
      'hub.appeals.reasonCode.revoke.context_considered': 'We looked at the whole conversation and lifted it.',
    };
    const OUTCOME = { uphold: 'upheld', reduce: 'reduced', revoke: 'revoked' } as const;
    const core = APPEAL_WORDS as Record<string, string>;
    for (const [key, sentence] of Object.entries(shown)) {
      expect((en as Record<string, string>)[key]).toBe(sentence);
      const [, , , outcome, code] = key.split('.') as [string, string, string, keyof typeof OUTCOME, string];
      expect(core[`player.appeal.reason.${OUTCOME[outcome]}.${code}`]).toBe(sentence);
    }
    expect(Object.keys(shown)).toHaveLength(9);
  });

  it('the legend and the cause words read as briefed', () => {
    const t = createT(en as never, 'en');
    expect(t('hub.appeals.reasonCode.legend' as never)).toBe('What the person is shown as the reason');
    expect(t('hub.appeals.cause.title' as never)).toBe('What caused this');
    expect(t('hub.appeals.cause.term' as never, { count: 3 })).toBe('An automatic restriction from the slur list, after 3 blocked messages.');
    expect(t('hub.appeals.cause.term' as never, { count: 1 })).toBe('An automatic restriction from the slur list, after 1 blocked message.');
    expect(t('hub.terms.flag' as never, { count: 3 })).toBe('Overturned on appeal 3 times in 90 days');
    expect(t('hub.settings.filters.hits.overturned' as never, { count: 2 })).toBe('Overturned on appeal (90 days): 2');
  });
});
