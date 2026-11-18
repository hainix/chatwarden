import type { ActionRecord, Suggestion } from '../ladder.js';
import { sampleRecords } from '../ladder.js';
import type { ModerationProfile } from '../profile.js';
import type { RuleRef } from '../rules.js';
import type { ConductLevel, SanctionKind } from '../types.js';
import { stepWithinActCeilings } from './ceilings.js';

// The reach preview (design 5.5, ruling 3): what step the ladder gives for a cell on a clean record, after one warning, after a 24 hour restriction
// and after a 7 day ban, and whether that step is one the AI may ever apply on its own. It is the honest answer to "will level 3 ever do anything
// on my ladder": with the shipped presets most cells say no. Pure over an injected `suggest` (the ladder's), with no store and no clock.

/** The ladder's `suggest`, as the preview calls it. */
export type ReachSuggest = (profile: ModerationProfile, records: readonly ActionRecord[], level: ConductLevel | null, rule: RuleRef, now: number) => Suggestion;

/**
 * One row of the preview. `step` is what the ladder gives (null for none); `withinCeilings` says the AI could apply it: a warning, or a chat
 * restriction of 24 hours or less. A step beyond that is shown so the owner sees why the AI would leave the case to a person.
 */
export interface AiReach {
  record: 'clean' | 'oneWarning' | 'chat24h' | 'ban7d';
  step: { kind: SanctionKind; durationMs: number | null; label: string } | null;
  withinCeilings: boolean;
}

const RECORDS = ['clean', 'oneWarning', 'chat24h', 'ban7d'] as const;
/** Any fixed instant: the samples are relative to it, so the answer depends on the profile and the rule alone. */
const REACH_NOW = 1_700_000_000_000;

/**
 * The four rows for the cell (`ruleNumber`, `level`), in a fixed order. A `suggest` that throws gives a row with no step that is not within the
 * ceilings; this never throws.
 */
export function reachOf(profile: ModerationProfile, ruleNumber: number, level: ConductLevel, suggest: ReachSuggest): AiReach[] {
  const samples = sampleRecords(REACH_NOW);
  return RECORDS.map((record): AiReach => {
    try {
      const s = suggest(profile, samples[record], level, ruleNumber, REACH_NOW);
      const o = s.outcome;
      if (o === 'none') return { record, step: null, withinCeilings: false };
      const step = o === 'note' || o === 'warning' ? { kind: o, durationMs: null, label: s.label } : { kind: o.kind, durationMs: o.durationMs, label: s.label };
      return { record, step, withinCeilings: stepWithinActCeilings(step) };
    } catch {
      return { record, step: null, withinCeilings: false };
    }
  });
}
