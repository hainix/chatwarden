import { useCallback, useMemo } from 'react';
import { useHub } from '../context.js';
import { createT } from '../i18n.js';
import type { HubParams, HubText } from '../i18n.js';

// The words of the AI's parts (the strip, its menu, the pre-fill bar, the Settings section). They live apart from the hub's catalog on
// purpose: every part that uses them is loaded when first needed, and a catalog that rode in the first load would be paid for by every
// moderator, AI or not. The hub's own `t` is asked first, so an adopter who supplies these keys (their own words, or a translation) is
// used; only a key it does not know falls back to the English here. `loadAiWords()` hands an adopter this catalog to spread.
//
// Plural forms add the CLDR category as the last segment, as in the hub's catalog (`.one`, `.other`).

/** @experimental */
export const aiEn = {
  'hub.ai.tag': 'AI',
  'hub.ai.tick': 'Cited by the AI',
  'hub.ai.chip': 'AI read:',
  'hub.ai.cites.one': 'AI cited {count} line',
  'hub.ai.cites.other': 'AI cited {count} lines',
  'hub.ai.pending': 'The AI is reading this case.',
  'hub.ai.rereading': 'Reading again',
  'hub.ai.waiting': 'The AI has not answered yet.',
  'hub.ai.checkAgain': 'Check again',

  'hub.ai.details': 'AI details',
  'hub.ai.details.model': 'Model',
  'hub.ai.details.model.none': 'Not recorded',
  'hub.ai.details.read': 'Read',
  'hub.ai.details.confidence': 'Confidence',
  'hub.ai.confidence.low': 'Low',
  'hub.ai.confidence.medium': 'Medium',
  'hub.ai.confidence.high': 'High',
  'hub.ai.details.context.one': 'Context included: {count} signal count',
  'hub.ai.details.context.other': 'Context included: {count} signal counts',
  'hub.ai.details.stale': 'This read was made from older rules or an older version of the case.',
  'hub.ai.details.injection': 'A line in the chat tried to give the AI instructions. It was read as chat and not followed.',
  'hub.ai.readAgain': 'Read again',
  'hub.ai.readAgain.ready': 'Nothing has changed since this read, so it stands.',
  'hub.ai.readAgain.failed': 'Could not ask for a new read.',
  'hub.ai.hide': 'Hide the AI on this case',
  'hub.ai.hidden': 'The AI is hidden on this case.',
  'hub.ai.show': 'Show',
  'hub.ai.error.final': 'The AI has nothing more to add to this case.',
  'hub.ai.error.budget': 'The AI has reached its limit for today.',
  'hub.ai.error.unavailable': 'The AI is not available right now.',
  'hub.ai.error.off': 'The AI is off.',

  'hub.ai.bar.label': 'AI suggestion',
  'hub.ai.bar.suggested': 'Suggested by AI',
  'hub.ai.bar.edited': 'Edited',
  'hub.ai.bar.unsure': 'The AI was not sure, so this is the usual starting point.',
  'hub.ai.accept.with': 'Accept AI suggestion: {step}',
  'hub.ai.accept.dismiss': 'Accept AI suggestion: no action needed',
  'hub.ai.edit': 'Edit',
  'hub.ai.suggest.title': 'The AI suggests',
  'hub.ai.why.claimed': 'Another moderator has this case, so it cannot be accepted.',
  'hub.ai.why.role': 'Your role cannot apply this step.',
  'hub.ai.why.rules': 'The rules have not loaded yet.',
  'hub.ai.why.stale': 'This read is out of date. A new one is on its way.',
  'hub.ai.why.step': "The AI never fills a ban, an area ban or a step over 24 hours. The ladder's step is yours to add.",
  'hub.ai.why.nostep': 'The AI named no step to fill. Choose one yourself.',
  'hub.ai.why.invalid': 'This suggestion needs a change before it can be sent.',
  'hub.ai.shortcuts.accept': 'Accept the AI suggestion',
  'hub.ai.shortcuts.edit': 'Edit the AI suggestion',

  'hub.settings.ai.title': 'AI',
  'hub.settings.ai.intro': 'The AI reads reports and, if you let it, suggests a decision. It never decides: a moderator does.',
  'hub.settings.ai.unsupported': 'This setup cannot save settings, so the AI stays as it is.',
  'hub.settings.ai.saved': 'AI settings saved.',
  'hub.settings.ai.what': 'the AI status',
  'hub.settings.ai.level.legend': 'What the AI does',
  'hub.settings.ai.level.off': 'Off',
  'hub.settings.ai.level.off.hint': 'The AI is not used. No report is read.',
  'hub.settings.ai.level.read': 'Read',
  'hub.settings.ai.level.read.hint': 'An AI read of each report: how serious, which rule, a one-line summary and the evidence lines. It ranks the queue. People decide.',
  'hub.settings.ai.level.recommend': 'Recommend',
  'hub.settings.ai.level.recommend.hint': 'It proposes the whole decision, pre-filled and marked as an AI suggestion. A moderator confirms or edits it in one click.',
  'hub.settings.ai.level.max': 'Your server allows up to {level}.',
  'hub.settings.ai.status.label': 'Status',
  'hub.settings.ai.status.working': 'Working',
  'hub.settings.ai.status.off': 'Off',
  'hub.settings.ai.status.paused': 'Paused: daily limit reached, resumes 00:00 UTC',
  'hub.settings.ai.status.unavailable': 'Unavailable',
  'hub.settings.ai.status.unavailable.hint': 'The provider is not answering. Reports are read when it is back, and nothing else changes.',
  'hub.settings.ai.status.notSetUp': 'Not set up on this server',
  'hub.settings.ai.status.notSetUp.hint': 'The AI is set up in your server code, with a provider adapter. See the AI section of the Chatwarden docs.',
  'hub.settings.ai.advanced': 'Advanced',
  'hub.settings.ai.learn': 'Learn from our decisions',
  'hub.settings.ai.learn.hint': 'Your own decisions are shown to the AI as examples. Off sends no examples; examples already kept are deleted after 180 days.',
  'hub.settings.ai.signals': 'Signal counts about the reported player (for example how many other players muted them) are sent as background: a label, a number of players and a number of days, nothing else. Report counts, reporter accuracy and history are never sent.',
  'hub.settings.ai.reads': 'Reads today: {count} of {max}',
  'hub.settings.ai.spend': 'Spent today: {spent} of {cap}',
  'hub.settings.ai.cache': 'Cache hit rate',
  'hub.settings.ai.cache.none': 'No reads yet.',
  'hub.settings.ai.agreement': 'Agreement with moderators',
  'hub.settings.ai.oneClick': 'Accepted in one click',
  'hub.settings.ai.rate.none': 'Not enough decisions yet.',
  'hub.settings.ai.rules': 'By rule',
  'hub.settings.ai.rules.none': 'No decisions yet.',
  'hub.settings.ai.rules.appeals': 'Granted appeals will appear here once appeals exist.',
  'hub.settings.ai.col.rule': 'Rule',
  'hub.settings.ai.col.decided': 'Decided',
  'hub.settings.ai.col.agree': 'Agreed',
  'hub.settings.ai.col.override': 'Changed',
  'hub.settings.ai.col.falsePositives': 'False positives',
  'hub.settings.ai.readonly': 'The daily spending limit and the adapter are set in your server code. A hub cannot raise them.',

  // Where the AI may act (Settings > AI > Advanced): the gate table, read-only. Release 1 of AI levels 3 and 4: nothing acts.
  'hub.settings.ai.gates.title': 'Where the AI may act',
  'hub.settings.ai.gates.what': 'the gate table',
  'hub.settings.ai.gates.notAvailable': 'Acting is not available in this version.',
  'hub.settings.ai.gates.intro': 'This shows where the AI could act once it can, and what each rule still needs. Nothing here changes a setting.',
  'hub.settings.ai.gates.none': 'Nothing to show yet. Turn the AI on and choose the conduct levels it may act on.',
  'hub.settings.ai.gates.old': 'This server does not have the gate view yet.',
  'hub.settings.ai.gates.noAppeals': 'Appeals are off, so no cell can open: the appeals checks are not available.',
  'hub.settings.ai.gates.table': 'Gates for each rule and conduct level',
  'hub.settings.ai.gates.col.cell': 'Rule and level',
  'hub.settings.ai.gates.col.status': 'Status',
  'hub.settings.ai.gates.gate.volume': 'Volume',
  'hub.settings.ai.gates.gate.breadth': 'Breadth',
  'hub.settings.ai.gates.gate.agreement': 'Agreement',
  'hub.settings.ai.gates.gate.override': 'Overrides',
  'hub.settings.ai.gates.gate.recency': 'Recent',
  'hub.settings.ai.gates.gate.appeals_rule': 'Appeals on the rule',
  'hub.settings.ai.gates.gate.appeals_acts': 'Appeals on AI actions',
  'hub.settings.ai.gates.gate.keep': 'After acting',
  'hub.settings.ai.gates.status.open': 'Gates met',
  'hub.settings.ai.gates.status.closed': 'Not yet',
  'hub.settings.ai.gates.status.excluded': 'Left to people',
  'hub.settings.ai.gates.met': 'Met',
  'hub.settings.ai.gates.unmet': 'Not met',
  'hub.settings.ai.gates.na': 'Not available',
  'hub.settings.ai.gates.noData': 'No decisions yet',
  'hub.settings.ai.gates.volume': '{value} of {need} decisions',
  'hub.settings.ai.gates.breadth': '{value} moderators, needs {need} over {days} days',
  'hub.settings.ai.gates.atLeast': '{value}, needs at least {need}',
  'hub.settings.ai.gates.atMost': '{value}, needs at most {need}',
  'hub.settings.ai.gates.below': '{value}, needs below {need}',
  'hub.settings.ai.gates.recent': '{value} lately, needs {need} decisions at {rate} or more',
  'hub.settings.ai.gates.recent.none': 'No recent decisions, needs {need} at {rate} or more',
  'hub.settings.ai.gates.rule.none': 'No rate yet (fewer than {min} sanctions), needs below {need}',
  'hub.settings.ai.gates.acts.none': 'None undone on appeal in {days} days',
  'hub.settings.ai.gates.acts.ago': 'Undone on appeal {days} days ago, needs none in {need} days',
  'hub.settings.ai.gates.keep.over': 'Undo rate is likely above {need} (lower bound {value})',
  'hub.settings.ai.gates.keep.within': 'Undo rate is within {need} (lower bound {value})',
  'hub.settings.ai.gates.keep.none': 'Applies once enough of its actions are reviewed',
  'hub.settings.ai.gates.reach': 'For a clean record: {step}',
  'hub.settings.ai.gates.reach.person': 'a person decides',
  'hub.settings.ai.gates.cooling.undo': 'Paused until {date}: an action was undone as not a violation.',
  'hub.settings.ai.gates.cooling.appeal': 'Paused until {date}: an action was revoked on appeal.',
  'hub.settings.ai.gates.never.title': 'Never acted on by the AI ({count})',
  'hub.settings.ai.gates.never.list': 'Never acted on by the AI',
  'hub.settings.ai.gates.never.item': '{cell}: the usual step is {step}, which is more than the AI will ever do.',
  'hub.settings.ai.gates.never.nostep': '{cell}: the ladder gives no step for a clean record, so a person decides.',

  // The Person page: "Do not automate".
  'hub.ai.person.automation.more': 'More',
  'hub.ai.person.automation.title': 'Do not automate',
  'hub.ai.person.automation.hint': 'The AI never acts on this person. It still reads and drafts for them; people decide.',
  'hub.ai.person.automation.reason': 'Reason',
  'hub.ai.person.automation.code.vulnerable': 'A vulnerable person',
  'hub.ai.person.automation.code.under_review': 'Under review',
  'hub.ai.person.automation.code.staff': 'A member of staff',
  'hub.ai.person.automation.code.sensitive_case': 'A sensitive case',
  'hub.ai.person.automation.code.else': 'Another reason',
  'hub.ai.person.automation.mark': 'Do not automate this person',
  'hub.ai.person.automation.allow': 'Allow the AI again',
  'hub.ai.person.automation.marked': 'Do not automate: the AI never acts on this person. Reason: {reason}.',
  'hub.ai.person.automation.set': 'The AI will not act on this person.',
  'hub.ai.person.automation.cleared': 'The AI may act on this person again.',
  'hub.ai.person.automation.failed': 'Could not change the mark.',
} as const;

type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
type BaseKey<K extends string> = K extends `${infer B}.${PluralForm}` ? B : K;

/** Every key the AI's parts may ask for, with the plural suffix taken off. */
export type AiText = BaseKey<keyof typeof aiEn>;

/** The `t` of the AI's parts: the hub's words first, then the English here. */
export type AiT = (key: AiText | HubText, params?: HubParams) => string;

/**
 * The words of the AI's parts. The hub's `t` is asked first (an adopter's own words or translation win); a key it has no text for comes
 * back as the key itself, and only then the English of {@link aiEn} is used.
 */
export function useAiT(): AiT {
  const { t, locale } = useHub();
  const own = useMemo(() => createT(aiEn, locale), [locale]);
  return useCallback<AiT>(
    (key, params) => {
      const said = t(key as HubText, params);
      return said === key ? own(key as HubText, params) : said;
    },
    [t, own],
  );
}
