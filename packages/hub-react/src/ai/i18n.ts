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
  'hub.ai.cites.one': 'AI cited {count} line',
  'hub.ai.cites.other': 'AI cited {count} lines',
  'hub.ai.pending': 'The AI is reading this case.',
  'hub.ai.rereading': 'Reading again',

  'hub.ai.details': 'AI details',
  'hub.ai.details.model': 'Model',
  'hub.ai.details.model.none': 'Not recorded',
  'hub.ai.details.read': 'Read',
  'hub.ai.details.confidence': 'Confidence',
  'hub.ai.confidence.low': 'Low',
  'hub.ai.confidence.medium': 'Medium',
  'hub.ai.confidence.high': 'High',
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
