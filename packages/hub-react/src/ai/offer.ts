import { assertWithinCeilings } from '@chatwarden/core';
import { shapeOf, validate } from '../decision.js';
import type { AiFromState, FormSource, ValidationContext } from '../decision.js';
import type { RulesState } from '../case/useDecisionForm.js';
import { fromRecommendation } from './prefill.js';
import type { AiReadView } from '../types.js';

// The AI's pre-fill, built and judged. Loaded when a case has a recommendation (see load.ts); every function is pure, so each rule is
// tested alone. The ceilings are checked here again, on the hub's own numbers, whatever the server said.

/** The form for a read's recommendation, kept with the read it came from, or null when there is nothing the AI is sure enough to fill. */
export function prefillFrom(
  ctx: ValidationContext,
  rules: ReadonlyArray<{ number: number; title: string }>,
  read: AiReadView | null,
  reportRule: number | 'uncovered',
  uid: string,
): AiFromState | null {
  if (read === null || read.recommendation === null) return null;
  const made = fromRecommendation(ctx, rules, read, reportRule, uid);
  return made === null ? null : { ...made, readId: read.id, severity: read.recommendation.severity, shape: shapeOf(made.form) };
}

/** Why the AI's suggestion cannot be accepted right now, as a word the bar and the card turn into a sentence. */
export type AiWhy = 'claimed' | 'role' | 'rules' | 'stale' | 'step' | 'edited' | 'invalid';

/** Whether the AI's suggestion may be accepted with one key, and if not, why. */
export type AiGate = { ok: true } | { ok: false; why: AiWhy };

export interface GateInput {
  from: AiFromState;
  source: FormSource;
  read: AiReadView;
  ctx: ValidationContext;
  rulesState: RulesState;
  /** The role may apply sanctions at all. */
  mayApply: boolean;
  /** Another moderator holds the case. */
  heldByOther: boolean;
}

/**
 * The gates on accepting: the form is still the AI's, nobody else holds the case, the read is current, the rules are loaded and the role
 * can apply the step, the step is one the hub fills (checked again here), and the form passes the bar's own checks.
 */
export function gateOf(i: GateInput): AiGate {
  const { from } = i;
  if (i.source !== 'ai') return { ok: false, why: 'edited' };
  if (i.heldByOther) return { ok: false, why: 'claimed' };
  if (i.read.stale) return { ok: false, why: 'stale' };
  if (from.kind !== 'dismiss' && !i.ctx.canApply) return { ok: false, why: i.rulesState !== 'ok' && i.mayApply ? 'rules' : 'role' };
  if (from.kind === 'verdict') return { ok: false, why: 'step' };
  if (from.choice !== null) {
    try {
      assertWithinCeilings(from.choice, { cited: from.lines, ownRefs: new Set(i.ctx.ownLineIds[i.ctx.target] ?? []) });
    } catch {
      return { ok: false, why: 'step' };
    }
  }
  if (validate(from.form, i.ctx).count > 0) return { ok: false, why: 'invalid' };
  return { ok: true };
}

/** The echo a decision sends about the read it was shown. */
export type AiEcho = { readId: string; accepted: boolean; severity?: AiReadView['severity'] };
