import type { AiOutcomeDetail, AiVerdict, SanctionKind } from '../types.js';
import type { AIRead } from './types.js';

// Agree or override (design section 11). Pure: it compares the stored read with what the human decided and nothing else. What a client
// says it did (the `accepted` echo) is kept as the one-click fact and never decides anything.

/** A step as a person would take it: a kind and a length (null for a warning, a note or a permanent one). */
export interface StepLike {
  kind: SanctionKind;
  durationMs: number | null;
}

/** What the human decided about the reported person, as the server sees it. */
export interface HumanDecision {
  verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith';
  /** The Community Rule the human cited against the reported person, or null (a dismissal). */
  rule: number | 'uncovered' | null;
  /** The ids of the reported person's lines the human cited. */
  lineIds: readonly string[];
  /** The strongest step the human took against the reported person, or null. */
  step: StepLike | null;
  /** The step the ladder gives for the AI's conduct level: what the pre-fill would have been; null when there was none. */
  prefill: StepLike | null;
  /** How many actions the decision took on people other than the reported person (the reporter, a bystander); absent means none. */
  others?: number;
  /** The client says the moderator accepted the pre-fill in one click. A claim: the server counts it only when the decision is the pre-fill (see {@link agreementOf}). */
  oneClick: boolean;
}

/** The result: the class of agreement, the AI's verdict in the casebook's three classes, and the finer facts. */
export interface Agreement {
  agreement: 'agree' | 'override' | 'none';
  /** What the AI recommended, or null when no recommendation was shown (level 1, `unclear`, or no read). */
  aiVerdict: AiVerdict | null;
  detail: AiOutcomeDetail;
}

const KIND_RANK: Record<SanctionKind, number> = { note: 1, warning: 2, chat: 3, area: 4, ban: 5 };

/** How long a step lasts for ordering: no length for a note or warning, and a permanent restriction or ban beyond any length. */
function lengthOf(s: StepLike): number {
  if (s.kind === 'note' || s.kind === 'warning') return 0;
  return s.durationMs === null ? Number.POSITIVE_INFINITY : s.durationMs;
}

/**
 * Order two steps by how heavy they are: none, a note, a warning, a chat restriction, a ban from public rooms, a full ban; within a
 * kind, by length (permanent last). Negative when `a` is milder than `b`, zero when equal, positive when `a` is harsher.
 */
export function compareSteps(a: StepLike | null, b: StepLike | null): number {
  const kindA = a === null ? 0 : (KIND_RANK[a.kind] ?? 0);
  const kindB = b === null ? 0 : (KIND_RANK[b.kind] ?? 0);
  if (kindA !== kindB) return kindA < kindB ? -1 : 1;
  if (a === null || b === null) return 0;
  const x = lengthOf(a);
  const y = lengthOf(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const NO_DETAIL: AiOutcomeDetail = { verdict: false, rule: false, lines: 0, outcome: 'none', oneClick: false };

/**
 * The decision is the pre-fill as it stood: the same kind of step, no longer than the pre-fill (a moderator may trim a length and it is
 * still their one click), or both without a step (a dismissal accepted as one).
 */
function stepAccepted(step: StepLike | null, prefill: StepLike | null): boolean {
  if (step === null || prefill === null) return step === null && prefill === null;
  if (step.kind !== prefill.kind) return false;
  if (step.durationMs === prefill.durationMs) return true;
  return step.durationMs !== null && prefill.durationMs !== null && step.durationMs <= prefill.durationMs;
}

/**
 * Compare the AI's recommendation in `read` with `decision`. `level` is the AI level in force: below 2 the recommendation was not
 * shown, so there is nothing to agree with (`none`). `upheld` and `noted` are one class (the AI wanted to act, or to record);
 * `no_action` is the other; a `bad_faith` verdict is always an override of a recommendation (the AI can never call a report bad faith).
 * A rule that differs is not a disagreement: it is `rule: false` in the detail (and for a `no_action` the rule means nothing: `true`).
 * `detail.oneClick` is the server's verdict, not the client's claim: true only when the client said so AND the decision is an
 * agreement that equals the pre-fill (the same verdict, the same rule, the same kind of step and no longer) and the decision takes no
 * action on anyone else: a decision that also sanctions the reporter or a bystander is the moderator's own, not the AI's one key.
 */
export function agreementOf(read: AIRead | null, decision: HumanDecision, level: 0 | 1 | 2 = 2): Agreement {
  const rec = read?.recommendation ?? null;
  if (level < 2 || rec === null || rec.verdict === 'unclear') {
    return { agreement: 'none', aiVerdict: null, detail: { ...NO_DETAIL } };
  }
  const aiVerdict: AiVerdict = rec.verdict;
  const aiActs = aiVerdict === 'upheld' || aiVerdict === 'noted';
  const humanActs = decision.verdict === 'upheld' || decision.verdict === 'noted';
  const same = decision.verdict !== 'bad_faith' && aiActs === humanActs;
  const cited = new Set(rec.evidence);
  const lines = new Set(decision.lineIds.filter((id) => cited.has(id))).size;
  const cmp = compareSteps(decision.step, decision.prefill);
  const ruleMatches = aiVerdict === 'no_action' || rec.rule === decision.rule;
  return {
    agreement: same ? 'agree' : 'override',
    aiVerdict,
    detail: {
      verdict: same,
      rule: ruleMatches,
      lines,
      outcome: cmp === 0 ? 'same' : cmp < 0 ? 'milder' : 'harsher',
      oneClick: decision.oneClick && same && rec.verdict === decision.verdict && ruleMatches && (decision.others ?? 0) === 0 && stepAccepted(decision.step, decision.prefill),
    },
  };
}
