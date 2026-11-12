import { assertWithinCeilings } from '@chatwarden/core';
import { LINES_MAX, REASON_MAX, draftFor, emptyForm, newDraft } from '../decision.js';
import type { AiPrefill, Choice, Draft, DecisionForm, ValidationContext } from '../decision.js';
import type { AiReadView } from '../types.js';

// Filling a form from the AI's recommendation. It lives here, not in decision.ts, so that it is in the chunk that is loaded with the AI's
// pre-fill and not in the first load every moderator pays for.

/**
 * The form a level 2 case opens with, from the AI's recommendation, or null when the AI is not sure (`unclear`), cites no line by the
 * reported person, or names no rule that can be cited. A sibling of {@link initialForm}. The ceilings hold here, not on the server's word:
 * the AI's step is filled only when it is a warning, a note or a chat restriction of 24 hours or less (`AI_MAX_PREFILL_MS`) and the role
 * may apply it; whatever `stepWithinCeiling` says. A step that is left out is kept in `held` and the form says "Fair" and cites the rule
 * with the rule's title as the reason, so the ladder's step is one explicit click away.
 */
export function fromRecommendation(
  ctx: ValidationContext,
  rules: ReadonlyArray<{ number: number; title: string }>,
  read: AiReadView,
  reportRule: number | 'uncovered',
  uid: string,
): AiPrefill | null {
  const rec = read.recommendation;
  if (rec === null || rec.verdict === 'unclear') return null;
  if (rec.verdict === 'no_action') return { form: { ...emptyForm(), verdict: 'not_a_problem' }, kind: 'dismiss', choice: null, held: null, rule: '', lines: [] };
  const own = ctx.ownLineIds[ctx.target] ?? [];
  const lines = rec.evidenceLineIds.filter((id) => own.includes(id)).slice(0, LINES_MAX);
  // A recommendation to uphold or note rests on a line the reported person wrote.
  if (lines.length === 0) return null;
  const named = typeof rec.rule === 'number' ? rec.rule : reportRule;
  const rule = typeof named === 'number' && ctx.rules.includes(named) ? named : '';
  if (rule === '') return null;
  const title = (rules.find((r) => r.number === rule)?.title ?? '').trim().slice(0, REASON_MAX).trim();
  const base: DecisionForm = { ...emptyForm(), verdict: 'fair', reason: title };
  const step = rec.step === null ? (rec.verdict === 'noted' ? { kind: 'note' as const, durationMs: null } : null) : rec.step;
  const choice: Choice | null = step === null ? null : { kind: step.kind, durationMs: step.durationMs };
  const fields = choice === null ? null : draftFor(choice);
  let fits = false;
  if (choice !== null && fields !== null && rec.stepWithinCeiling === true && ctx.canApply) {
    try {
      assertWithinCeilings(choice, { cited: lines, ownRefs: new Set(own) });
      fits = true;
    } catch {
      fits = false;
    }
  }
  if (choice === null || fields === null || !fits) return { form: base, kind: 'verdict', choice: null, held: choice, rule, lines };
  const action: Draft = { ...newDraft(uid, ctx.target, rule), ...fields, lineIds: choice.kind === 'note' ? [] : lines };
  return { form: { ...base, actions: [action] }, kind: 'step', choice, held: null, rule, lines };
}
