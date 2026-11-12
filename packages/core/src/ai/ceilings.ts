import type { SanctionKind } from '../types.js';

// The ceilings (design section 8). They hold in code, not by convention: the AI module cannot write a sanction at all (an ESLint
// rule forbids importing the sanction modules), and anything that pre-fills a step for a human, or one day acts, passes through
// `assertWithinCeilings`.

/**
 * The longest step the one-key accept may pre-fill, and the longest a later level 3 may take: 24 hours.
 * @experimental
 */
export const AI_MAX_PREFILL_MS = 24 * 3_600_000;

/**
 * The kinds an AI step may ever be: a note, a warning or a chat restriction. Never a ban and never an area ban.
 * @experimental
 */
export const AI_MAX_KIND: ReadonlySet<SanctionKind> = new Set<SanctionKind>(['note', 'warning', 'chat']);

/**
 * Thrown by `assertWithinCeilings`. `code` is a fixed string, never echoed text.
 * @experimental
 */
export class AICeilingError extends Error {
  readonly code: 'ceiling_kind' | 'ceiling_duration' | 'ceiling_evidence';
  constructor(code: AICeilingError['code'], message: string) {
    super(message);
    this.name = 'AICeilingError';
    this.code = code;
  }
}

/**
 * Throws when a step an AI proposes would break a ceiling: a kind outside {@link AI_MAX_KIND} (a ban, an area ban), a chat
 * restriction that is open-ended or longer than {@link AI_MAX_PREFILL_MS}, or evidence with no line by the reported person.
 * `evidence.cited` is the refs the AI cited; `evidence.ownRefs` the refs of lines the reported person wrote.
 * @experimental
 */
export function assertWithinCeilings(
  step: { kind: SanctionKind; durationMs: number | null },
  evidence: { cited: readonly string[]; ownRefs: ReadonlySet<string> },
): void {
  if (!AI_MAX_KIND.has(step.kind)) throw new AICeilingError('ceiling_kind', `kind ${String(step.kind)} is beyond what the AI may do`);
  if (step.kind === 'chat') {
    const d = step.durationMs;
    if (d === null || !Number.isFinite(d) || d <= 0 || d > AI_MAX_PREFILL_MS) {
      throw new AICeilingError('ceiling_duration', 'duration is beyond what the AI may do (24 hours at most)');
    }
  }
  if (!evidence.cited.some((ref) => evidence.ownRefs.has(ref))) {
    throw new AICeilingError('ceiling_evidence', 'no cited evidence line is by the reported person');
  }
}

/**
 * Whether the AI may act on this person. Always true now; level 3 will back it with a "do not automate" mark. Called on every
 * path that could ever act. Reads and drafts are advice, so they are produced either way.
 * @experimental
 */
export function automationAllowed(person: string): boolean {
  void person;
  return true;
}
