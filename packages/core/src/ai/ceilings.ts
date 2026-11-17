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
 * The kinds an AI step may ever be: a note, a warning or a chat restriction. Never a ban and never an area ban. A frozen list.
 * @experimental
 */
export const AI_MAX_KIND: readonly SanctionKind[] = Object.freeze(['note', 'warning', 'chat'] as const);

/** True for a kind in {@link AI_MAX_KIND}. Anything else (a ban, an area ban, a prototype key, a non-string) is false. */
export function isAllowedKind(kind: unknown): kind is SanctionKind {
  return typeof kind === 'string' && AI_MAX_KIND.includes(kind as SanctionKind);
}

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
 * restriction with no length, any length (any kind, a warning or note included) that is not a finite number above 0 and at most
 * {@link AI_MAX_PREFILL_MS}, or evidence with no line by the reported person.
 * `evidence.cited` is the refs the AI cited; `evidence.ownRefs` the refs of lines the reported person wrote.
 * @experimental
 */
export function assertWithinCeilings(
  step: { kind: SanctionKind; durationMs: number | null },
  evidence: { cited: readonly string[]; ownRefs: ReadonlySet<string> },
): void {
  if (!isAllowedKind(step.kind)) throw new AICeilingError('ceiling_kind', 'this kind is beyond what the AI may do');
  // No kind may carry more than 24 hours, a warning or note included; a chat restriction must carry a length.
  const d: unknown = step.durationMs;
  const lengthOk = typeof d === 'number' && Number.isFinite(d) && d > 0 && d <= AI_MAX_PREFILL_MS;
  if (!(d === null && step.kind !== 'chat') && !lengthOk) {
    throw new AICeilingError('ceiling_duration', 'duration is beyond what the AI may do (24 hours at most)');
  }
  if (!evidence.cited.some((ref) => evidence.ownRefs.has(ref))) {
    throw new AICeilingError('ceiling_evidence', 'no cited evidence line is by the reported person');
  }
}

/**
 * The kinds the AI may ever ACT with at level 3: a warning or a chat restriction. Narrower than {@link AI_MAX_KIND}: no automatic note (two notes
 * make a repeat, so a note would quietly raise the next step against a player), and never a ban or an area ban. A frozen list, not an option.
 * @experimental
 */
export const AI_ACT_KINDS: readonly SanctionKind[] = Object.freeze(['warning', 'chat'] as const);

/**
 * Whether a ladder step is one the AI may ever apply on its own: a warning (no length) or a chat restriction of more than 0 and at most 24 hours.
 * A note, a ban, an area ban, a permanent restriction, a step with a wrong shape and no step at all are not. Pure; the actor repeats the whole check
 * (`assertWithinCeilings`) on the step it computes itself.
 * @experimental
 */
export function stepWithinActCeilings(step: { kind: SanctionKind; durationMs: number | null } | null): boolean {
  if (typeof step !== 'object' || step === null) return false;
  const kind: unknown = step.kind;
  const d: unknown = step.durationMs;
  if (kind === 'warning') return d === null;
  if (kind === 'chat') return typeof d === 'number' && Number.isFinite(d) && d > 0 && d <= AI_MAX_PREFILL_MS;
  return false;
}

/**
 * Whether the AI may act on this person: false for a person a senior marked "do not automate" (design 6.4, ruling 17). `lookup` is the mark's answer
 * (`cw.people.automation.get(person).allowed`), injected so this module imports no store and no writer; without one, as before, every person is allowed.
 * A lookup that throws, or answers anything but `true`, means NOT allowed (fail closed). Called on every path that could ever act. Reads and drafts are
 * advice, so they are produced either way.
 * @experimental
 */
export function automationAllowed(person: string, lookup?: (person: string) => boolean): boolean {
  if (lookup === undefined) return true;
  try {
    return lookup(person) === true;
  } catch {
    return false;
  }
}
