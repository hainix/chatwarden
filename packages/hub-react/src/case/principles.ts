import type { GuidelineTier } from '@chatwarden/core';
import type { ConductLevel, TeamNote } from '../types.js';

// What the case's "Principles for this case" disclosure shows, decided here without a page: which principle matches the report's conduct level, which team notes belong to the case's
// Community Rule, and which level the case is read at. Pure.

/** The first principle whose levels include `level`, or null when none does (a code profile always covers every level; a layer must). */
export function tierForLevel(tiers: readonly GuidelineTier[], level: ConductLevel): GuidelineTier | null {
  return tiers.find((t) => (t.covers as readonly string[]).includes(level)) ?? null;
}

/**
 * The team notes tied to the case's Community Rule, in the order they were written. A note with no rule is for no case in particular; `'uncovered'`, a rule the list does not have and a rule
 * that was retired give none.
 */
export function notesForRule(notes: readonly TeamNote[], rule: number | 'uncovered', rules: ReadonlyArray<{ number: number; retired?: boolean }>): TeamNote[] {
  if (rule === 'uncovered') return [];
  const known = rules.find((r) => r.number === rule);
  if (known === undefined || known.retired === true) return [];
  return notes.filter((n) => n.rule === rule);
}

/** The level a case is read at: the one the moderator picked, else the AI read's, else `hostile` (the ladder's own default). */
export function caseLevel(picked: ConductLevel | null, aiSeverity: ConductLevel | undefined): ConductLevel {
  return picked ?? aiSeverity ?? 'hostile';
}
