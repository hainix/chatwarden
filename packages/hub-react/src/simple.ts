import { DURATIONS, REASON_MAX, emptyForm, initialForm, needsBanPermission, outcomeChoice, validate } from './decision.js';
import type { Choice, DecisionForm, ValidationContext } from './decision.js';
import { formatDuration, listOf } from './format.js';
import type { HubT } from './i18n.js';
import { lengthPhrase } from './labels.js';
import { LEGACY_REASON_ALIASES } from '@chatwarden/core';
import type { ReporterRecord, SanctionGroupView, SanctionKind, Suggestion } from './types.js';

// What Simple mode decides, as plain functions: the body one click sends, the body "No action needed" sends, when a reporter's
// record is worth a warning, and the record as one line. Nothing here touches the page, so every rule can be tested alone.
// The send itself is not here: both buttons hand a form to the same hold the decision bar uses.

/** What one click sends: the form (Fair, the suggested step, the rule, its title as the reason) and the facts the card states. */
export interface OneClick {
  form: DecisionForm;
  /** The suggested step. */
  choice: Choice;
  /** The rule it is under. */
  rule: number;
  /** How many of the person's own lines the player is shown (at most five); a note shows none. */
  lineCount: number;
}

/**
 * The decision one click makes, or null when the card must not offer one: the ladder suggests nothing, no active rule covers the
 * report, the role may not apply the step (sanctions, or a permanent ban), or the step has a length the server does not take.
 * It starts from the same form a case opens with (`initialForm`: the person's own lines, the report's rule), then sets the verdict
 * to Fair and the reason to the rule's title, and only offers it when the bar's own checks pass.
 */
export function oneClickOf(
  ctx: ValidationContext,
  rules: ReadonlyArray<{ number: number; title: string }>,
  outcome: Suggestion['outcome'],
  reportRule: number | 'uncovered',
  reportedLine: string | null,
  uid: string,
): OneClick | null {
  const choice = outcomeChoice(outcome);
  if (choice === null) return null;
  const start = initialForm(ctx, outcome, reportRule, reportedLine, uid);
  const action = start.actions.find((a) => a.person === ctx.target);
  if (action === undefined || !/^[1-9]\d*$/.test(action.rule)) return null;
  const rule = Number(action.rule);
  const title = (rules.find((r) => r.number === rule)?.title ?? '').trim().slice(0, REASON_MAX).trim();
  if (title === '') return null;
  const form: DecisionForm = { ...start, verdict: 'fair', reason: title };
  if (validate(form, ctx).count > 0) return null;
  return { form, choice, rule, lineCount: action.lineIds.length };
}

/**
 * The decision "Nothing wrong here" makes: the Not-a-problem verdict and no actions. With no reason (the default) none is sent and the
 * kit stores its standard one; a reason given is sent as written.
 */
export function noActionForm(reason = ''): DecisionForm {
  return { ...emptyForm(), verdict: 'not_a_problem', reason };
}

/** How many of the reporter's reports have been decided. A report still open is neither upheld nor not upheld, so it is not counted. */
export const reporterDecided = (record: ReporterRecord): number => record.actioned + record.dismissed;

/** True when the reporter's record is worth a warning: three or more decided reports, and fewer than a third of them upheld. */
export function reporterWarrants(record: ReporterRecord): boolean {
  const decided = reporterDecided(record);
  return decided >= 3 && record.actioned * 3 < decided;
}

/** The fewest decided reports before a reporter's reason accuracy is worth saying: fewer is noise. */
export const ACCURACY_MIN = 3;

/**
 * How often this reporter's reasons matched what was decided (a report counts when a rule the reason maps to was cited against the reported
 * person), or null when there are fewer than three decided reports to say it about, or the kit sends no counts (an older kit).
 */
export function reasonAccuracy(record: ReporterRecord): { matched: number; decided: number } | null {
  const decided = record.reasonDecided;
  const matched = record.reasonMatched;
  if (typeof decided !== 'number' || typeof matched !== 'number' || decided < ACCURACY_MIN) return null;
  return { matched: Math.min(matched, decided), decided };
}

/** Whether the rule a report breaks is clear from what the reporter said it was: one rule (preselect it), or not (ask which). */
export type RuleChoice = { kind: 'one'; rule: number } | { kind: 'ask'; mapped: number[] };

/**
 * The rule the reported reason points at. A reason that maps to exactly one rule still in force is clear and preselected (the moderator
 * can change it); no reason, a reason that maps to none or to several, or one the settings no longer list, asks which rule, leading with
 * the rules the reason usually means. A retired rule is not counted.
 */
export function ruleChoiceOf(
  reason: string | null,
  reasons: ReadonlyArray<{ id: string; rules: readonly number[] }>,
  active: readonly number[],
): RuleChoice {
  // An exact id wins; an old category id reads as the reason that replaced it (as the kit does).
  const alias = reason !== null && Object.hasOwn(LEGACY_REASON_ALIASES, reason) ? LEGACY_REASON_ALIASES[reason] : undefined;
  const found = reason === null || reason === '' ? undefined : (reasons.find((r) => r.id === reason) ?? reasons.find((r) => r.id === alias));
  const mapped = [...new Set((found?.rules ?? []).filter((n) => active.includes(n)))].sort((a, b) => a - b);
  const only = mapped[0];
  return mapped.length === 1 && only !== undefined ? { kind: 'one', rule: only } : { kind: 'ask', mapped };
}

/** The lines one person wrote, in order. */
export function ownLinesOf<L extends { person: string | null }>(lines: readonly L[], person: string): L[] {
  return lines.filter((l) => l.person === person);
}

/** Whether the role can be offered the primary button's step at all (used to word the card when it cannot). */
export const needsSenior = (choice: Choice | null, canPermanent: boolean): boolean => choice !== null && needsBanPermission(choice) && !canPermanent;

/** Steps a person has on record, newest first; a revoked one is not a step. */
export function recordSteps(sanctions: readonly SanctionGroupView[]): SanctionGroupView[] {
  return sanctions.filter((s) => s.revokedAt === null).sort((a, b) => b.startsAt - a.startsAt);
}

/** How many steps the record line names before it says "and N more". */
export const RECORD_NAMED = 3;

const LENGTH_ADJECTIVE = {
  '1h': 'hub.simple.record.length.hour',
  '24h': 'hub.simple.record.length.day',
  '7d': 'hub.simple.record.length.week',
  '30d': 'hub.simple.record.length.month',
  permanent: 'hub.simple.record.length.permanent',
} as const;
const TIMED_STEP: Partial<Record<SanctionKind, 'hub.simple.record.step.chat' | 'hub.simple.record.step.area' | 'hub.simple.record.step.ban'>> = {
  chat: 'hub.simple.record.step.chat',
  area: 'hub.simple.record.step.area',
  ban: 'hub.simple.record.step.ban',
};

/** One step in plain words: "a warning", "a 7-day chat restriction, still in force". */
export function stepPhrase(t: HubT, locale: string, s: SanctionGroupView): string {
  if (s.kind === 'warning') return t('hub.simple.record.step.warning');
  if (s.kind === 'note') return t('hub.simple.record.step.note');
  const ms = s.endsAt === null ? null : s.endsAt - s.startsAt;
  const known = DURATIONS.find((d) => d.ms === ms);
  const length = known === undefined ? formatDuration(ms ?? 0, locale) : t(LENGTH_ADJECTIVE[known.key]);
  const key = TIMED_STEP[s.kind] ?? 'hub.simple.record.step.chat';
  const words = t(key, { length });
  return s.active && s.revokedAt === null ? t('hub.simple.record.inForce', { step: words }) : words;
}

/** A person's record in one line: "Nothing in the last 90 days.", or "2 past steps: a warning, a 24-hour chat restriction." */
export function recordLine(t: HubT, locale: string, sanctions: readonly SanctionGroupView[]): string {
  const steps = recordSteps(sanctions);
  if (steps.length === 0) return t('hub.simple.record.none');
  const named = steps.slice(0, RECORD_NAMED).map((s) => stepPhrase(t, locale, s));
  const rest = steps.length - named.length;
  const list = listOf(rest > 0 ? [...named, t('hub.simple.record.more', { count: rest })] : named, locale);
  return t('hub.simple.record.some', { count: steps.length, list });
}

const STEP_VERB = {
  chat: 'hub.simple.apply.chat',
  area: 'hub.simple.apply.area',
  ban: 'hub.simple.apply.ban',
} as const;

/** The primary button's words, named after the step: "Restrict chat, 24 hours", "Ban, permanent", "Send a warning". */
export function stepLabel(t: HubT, locale: string, choice: Choice): string {
  if (choice.kind === 'warning') return t('hub.simple.apply.warning');
  if (choice.kind === 'note') return t('hub.simple.apply.note');
  return t(STEP_VERB[choice.kind], { length: lengthPhrase(t, locale, choice.durationMs) });
}
