import { MAX_AI_CONTEXT } from '@chatwarden/core';
import type { PolicyState } from '../types.js';
import type { Problems } from './panels.js';
import { charsOf } from './reporting.js';

// The draft of the "The AI's standard" panel (Settings > Advanced): the plain-language standard the AI read weighs reports against (the `aiContext` section). What was typed, what the kit
// would refuse, and the section a save carries. Pure.

export { MAX_AI_CONTEXT };

export interface StandardDraft {
  text: string;
}

/** The kit's standard in force (an older kit that does not say has none). */
const inForce = (state: PolicyState): string => state.effective.aiContext ?? '';

/** The draft the settings in force make. */
export const standardDraftOf = (state: PolicyState): StandardDraft => ({ text: inForce(state) });

/** What the kit would refuse: an empty standard, or one over the cap. The field key is `standard`. */
export function standardProblems(d: StandardDraft): Problems {
  const text = d.text.trim();
  if (text === '') return { standard: { key: 'hub.settings.standard.error.empty' } };
  if (charsOf(text) > MAX_AI_CONTEXT) return { standard: { key: 'hub.settings.standard.error.long', params: { max: MAX_AI_CONTEXT } } };
  return {};
}

/** The section a save carries: the trimmed text, or null when it equals the profile in code (the section then follows the code). */
export function standardSection(d: StandardDraft, state: PolicyState): string | null {
  const text = d.text.trim();
  return text === (state.base.aiContext ?? '').trim() ? null : text;
}

/** Whether the draft means something different from what is in force. */
export const standardDirty = (d: StandardDraft, state: PolicyState): boolean => d.text.trim() !== inForce(state).trim();

/** The field a refusal of the kit names. */
export const standardFieldKey = (path: string): string | null => (path === 'layer.aiContext' ? 'standard' : null);

/** The field to put the focus on first after a blocked save. */
export const firstStandardField = (_d: StandardDraft, problems: Problems): string | null => (problems['standard'] === undefined ? null : 'standard');
