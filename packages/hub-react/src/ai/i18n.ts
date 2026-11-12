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
