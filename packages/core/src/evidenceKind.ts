// What a report, a decision and a player notice are about: chat, play or a name (0.2.2). Pure data and one check, so the notice words (`@chatwarden/core/notice-copy`) can use it
// without pulling in the reporting settings. {@link ReportReason.evidence} says it per reason; `reporting.ts` re-exports these names.

import type { RuleRef } from './rules.js';

/**
 * What a report is about, for the words and the lines a decision uses: `chat` (what a player wrote), `play` (how they played: leaving, throwing, cheating) or `name` (their name).
 * A reason says it, a decision may override it, and a notice carries it. Absent everywhere means "neutral": no chat line is attached on its own and the words name no conduct.
 */
export type EvidenceKind = 'chat' | 'play' | 'name';

/** Every evidence kind, in the order a settings screen lists them. */
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['chat', 'play', 'name'];

/** True for a well-formed evidence kind. */
export function isEvidenceKind(v: unknown): v is EvidenceKind {
  return v === 'chat' || v === 'play' || v === 'name';
}

/**
 * The evidence kind a Community Rule suggests when a report's reason gives none: CR 5 and 6 (cheating, throwing, leaving) are `play`, CR 7 (names) is `name`, every other rule none.
 * A rule is only a fallback: CR 2 can come from chat or from a name, and CR 6 from AFK or from chat, so the reason (or a decision) is the better source.
 */
export function evidenceOfRule(rule: RuleRef | null | undefined): EvidenceKind | undefined {
  if (rule === 5 || rule === 6) return 'play';
  if (rule === 7) return 'name';
  return undefined;
}
