import type { AIRead } from './types.js';

// The agreement of the confirming read (design 3 ruling 8, 4.2 check 4). Pure: two validated reads and the ids of the lines the reported person wrote in, a yes or no out.
// The service asks it before it proposes; the actor asks it again from the stored reads, because a proposal is only a hint.

/**
 * Whether the confirming read `second` agrees with the case's read `first`, so that the AI may go on: both recommend `upheld`, under the same rule and at the same conduct level,
 * the confirming read has confidence of at least `medium`, neither read suspects an injection, and the two cite at least one line in common that the reported person wrote
 * (`ownLineIds`: real line ids, as the reads store them). Anything else, a different verdict, rule or level, a missing recommendation, low confidence, an injection or no shared
 * line by the reported person, is no agreement. Two reads that are not `upheld` never agree: there is nothing to act on.
 * @experimental
 */
export function confirmAgrees(first: AIRead, second: AIRead, ownLineIds: ReadonlySet<string>): boolean {
  const a = first.recommendation;
  const b = second.recommendation;
  if (a === null || b === null) return false;
  if (a.verdict !== 'upheld' || b.verdict !== 'upheld') return false;
  if (a.rule !== b.rule || a.severity !== b.severity) return false;
  if (typeof a.rule !== 'number') return false;
  if (second.confidence === 'low') return false;
  if (first.injectionSuspected || second.injectionSuspected) return false;
  const theirs = new Set(b.evidence);
  return a.evidence.some((id) => theirs.has(id) && ownLineIds.has(id));
}
