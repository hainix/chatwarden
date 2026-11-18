import { isOriginReport } from '../types.js';
import type { ReportRecord, SanctionKind } from '../types.js';
import type { AiActingMode } from './acting.js';
import type { AiActCaps } from './caps.js';
import { assertWithinCeilings, AICeilingError, AI_ACT_KINDS, stepWithinActCeilings } from './ceilings.js';
import type { AiGateName } from './gates.js';
import type { AiActRefusal } from './types.js';

// The act planner (design 4.1, 4.2): pure. Facts in, the first refusal out, in the order of the table in design 4.2. The AI module runs it on the cheap facts it can read (to save
// model calls) and the actor runs the very same function on every fact it reads again from the store, so the order and the codes are written once. Nothing here reads a store, a
// clock, a signal, a report count or a flag: a fact is a yes or a no that the caller worked out, and the planner never learns where it came from.

/** A report older than this is never acted on (design 4.2 check 2): 24 hours. */
export const AI_ACT_MAX_AGE_MS = 24 * 3_600_000;

/**
 * When the AI may first act on a report made at `createdAt`: after the hold, which closes the reporter's follow-up window so the AI never acts on half a report.
 */
export function dueAt(createdAt: number, holdMs: number): number {
  return createdAt + holdMs;
}

/**
 * A keyed hash of an input, as a hex string: the kit's secret is the key, so nobody outside can tell which reports are held back. Injected; the kit passes an HMAC.
 */
export type HoldbackHasher = (input: string) => string;

/**
 * Whether this report is in the holdback (design 3 ruling 7): a fixed `share` of eligible cases a person decides as at level 2, chosen deterministically from the report id and the
 * kit's secret, so the same report is held back (or not) on every call, in every process and after a restart, and nobody can steer which ones. About `share` of any large set of ids.
 * A `share` of 0 or less holds back none, 1 or more all (the band, 10% to 50%, is held by `ai.act.caps`, not here).
 */
export function isHeldBack(reportId: string, hasher: HoldbackHasher, share: number): boolean {
  if (!(share > 0)) return false;
  if (share >= 1) return true;
  const hex = hasher(`ai-holdback:${reportId}`).slice(0, 8);
  const n = Number.parseInt(hex, 16);
  if (!Number.isFinite(n)) return false;
  return n / 0x1_0000_0000 < share;
}

/** A ladder step as a kind and a length: what the AI would apply. */
export interface ActStep {
  kind: SanctionKind;
  durationMs: number | null;
}

/**
 * Which ceiling a step breaks, or null (design 4.2 check 7): the kind first (a ban, an area ban, a note and no step at all are not a kind the AI may act with), then the length
 * (a warning has none, a chat restriction is more than 0 and at most 24 hours), then the cited line by the reported person. The last is `assertWithinCeilings`, the one function the
 * level 2 pre-fill calls too, so "never beyond 24 hours, never a ban, never without a line by the reported person" is one piece of code used twice.
 */
export function actCeiling(step: ActStep | null, cited: readonly string[], own: ReadonlySet<string>): 'ceiling_kind' | 'ceiling_duration' | 'ceiling_evidence' | null {
  if (step === null || !(AI_ACT_KINDS as readonly string[]).includes(step.kind)) return 'ceiling_kind';
  if (!stepWithinActCeilings(step)) return 'ceiling_duration';
  try {
    assertWithinCeilings(step, { cited, ownRefs: own });
  } catch (err) {
    if (err instanceof AICeilingError) return err.code;
    throw err;
  }
  return null;
}

/** A report nobody filed (the watch release's, or one with no reporter). Level 3 never acts on one (design 4.2 check 10). */
export function isSystemReport(report: Pick<ReportRecord, 'reporterSubject'> & { origin?: ReportRecord['origin'] }): boolean {
  return isOriginReport(report) || report.reporterSubject === '';
}

/** What the caps read (design 4.2 check 11): the actions in the last hour and the UTC day, and the unreviewed ones. */
export interface CapUse {
  /** Actions (or, in shadow, would-have-acted) in the last hour. */
  hour: number;
  /** The same since the UTC midnight. */
  day: number;
  /** Actions waiting for a person to review them. */
  unreviewed: number;
  /** When the oldest of them acted, or null with none. */
  oldestUnreviewedAt: number | null;
}

/**
 * The blast-radius caps and review debt (ruling 10): the first of `cap_hour` (the hour already holds `perHour` actions), `cap_day`, `review_debt` (more than `reviewDebtMax`
 * unreviewed, or the oldest older than `reviewWithinMs`) that holds, else null. At the number is the limit: the 11th in an hour is the one refused, and 25 unreviewed is not yet debt.
 */
export function capsOk(use: CapUse, caps: Pick<AiActCaps, 'perHour' | 'perDay' | 'reviewDebtMax' | 'reviewWithinMs'>, now: number): 'cap_hour' | 'cap_day' | 'review_debt' | null {
  if (use.hour >= caps.perHour) return 'cap_hour';
  if (use.day >= caps.perDay) return 'cap_day';
  if (use.unreviewed > caps.reviewDebtMax) return 'review_debt';
  if (use.oldestUnreviewedAt !== null && now - use.oldestUnreviewedAt > caps.reviewWithinMs) return 'review_debt';
  return null;
}

/**
 * The facts of design 4.2, one for each check. The first three groups are always known; every other fact is optional, and a check whose fact is absent is skipped (the AI module
 * knows only some of them before it spends a call; the actor knows all). A fact is what the caller worked out from the store, never a number a client supplied.
 */
export interface ActFacts {
  /** 1. The acting state now, read fresh from the store, and whether in-kit appeals are enabled. */
  mode: AiActingMode;
  paused: boolean;
  appealsEnabled: boolean;
  /** 2. The report, and 10: whether it is a system report (one nobody filed). */
  report: { open: boolean; badFaith: boolean; ageMs: number; claimed: boolean; system: boolean };
  /** 3. The read is `ok`, current, not injection-suspected, high confidence and recommends `upheld`, and is the one proposed. */
  readUsable?: boolean;
  /** 4. The confirming read agrees (`confirmAgrees`). */
  confirmAgrees?: boolean;
  /** 5. The rule is a number, active, not excluded, and the conduct level is in `profile.aiAutoAct`. */
  cellAllowed?: boolean;
  /** 6. The first gate that does not hold, or a cooling latch's gate; null when the cell is open. */
  gateFailed?: AiGateName | null;
  /** 7. The ladder's step is a warning or a chat restriction of at most 24 hours with a line by the reported person cited; else which ceiling it breaks. */
  ceiling?: 'ceiling_kind' | 'ceiling_duration' | 'ceiling_evidence' | null;
  /** 8. Every cited line is in the report's stored excerpt. */
  evidenceInExcerpt?: boolean;
  /** 9. `automationAllowed(person)`: false for a person marked "do not automate" and for a store that cannot say. */
  automationAllowed?: boolean;
  /** 9. An open appeal on the person, an AI action on them in the last 24 hours, or one undone as "not a violation" in 30 days. */
  personProtected?: boolean;
  /** 10. The reporter is a habitual false reporter, or carries a bad-faith mark. */
  reporterHabitual?: boolean;
  /** 11. Caps and review debt. */
  caps?: CapUse;
  /** 12. The report is in the 20% holdback. */
  heldBack?: boolean;
}

/**
 * The first refusal for these facts, in the order of design 4.2, or null when every known check holds. The codes are closed; none carries text.
 */
export function preFilter(f: ActFacts, caps: Pick<AiActCaps, 'perHour' | 'perDay' | 'reviewDebtMax' | 'reviewWithinMs' | 'holdMs'>, now: number): AiActRefusal | null {
  // 1. Acting is on (or shadow), not paused, and appeals exist.
  if (f.mode === 'off') return 'acting_off';
  if (f.paused) return 'paused';
  if (!f.appealsEnabled) return 'no_appeals';
  // 2. The report: open (a bad-faith report is closed, and a hard stop either way), at most 24 hours old, at least the hold old, and not held by a person.
  if (!f.report.open || f.report.badFaith) return 'not_open';
  if (f.report.ageMs > AI_ACT_MAX_AGE_MS) return 'too_old';
  if (f.report.ageMs < caps.holdMs) return 'too_new';
  if (f.report.claimed) return 'claimed';
  if (f.readUsable === false) return 'read_not_usable';
  if (f.confirmAgrees === false) return 'confirm_disagrees';
  if (f.cellAllowed === false) return 'cell_not_allowed';
  if (f.gateFailed !== undefined && f.gateFailed !== null) return `gate_failed:${f.gateFailed}`;
  if (f.ceiling !== undefined && f.ceiling !== null) return f.ceiling;
  if (f.evidenceInExcerpt === false) return 'evidence_missing';
  if (f.automationAllowed === false) return 'do_not_automate';
  if (f.personProtected === true) return 'person_protected';
  if (f.reporterHabitual === true) return 'reporter_habitual';
  if (f.report.system) return 'system_report';
  if (f.caps !== undefined) {
    const refusal = capsOk(f.caps, caps, now);
    if (refusal !== null) return refusal;
  }
  if (f.heldBack === true) return 'held_back';
  return null;
}

/** The same function under the name the actor uses: it is given every fact. */
export const evaluateChecks = preFilter;
