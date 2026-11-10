import { LADDER_TABLE } from '@chatwarden/core';
import type { HubParams, HubText } from './i18n.js';
import type { DecideInput, DecisionAction, SanctionKind, Suggestion } from './types.js';

// The decision form as plain data and pure functions: what it holds, what it refuses before sending, and the body it sends.
// The rules here mirror the server's (core `decide`, http `parseDecision`) so the form never offers what the server refuses.
// The server stays the judge: a refusal it still gives is shown, not hidden.

/** At most this many actions in one decision (the server's limit). */
export const MAX_ACTIONS = 20;
/** The longest reason, evidence note and gap note, after trimming. */
export const REASON_MAX = 500;
export const EVIDENCE_MAX = 500;
export const GAP_NOTE_MAX = 500;
/** At most this many of a person's own lines in one notice. */
export const LINES_MAX = 5;

/** The lengths the form offers for "Something else". */
export const DURATIONS = [
  { key: '1h', ms: 3_600_000 },
  { key: '24h', ms: 86_400_000 },
  { key: '7d', ms: 604_800_000 },
  { key: '30d', ms: 2_592_000_000 },
  { key: 'permanent', ms: null },
] as const;
export type DurationKey = (typeof DURATIONS)[number]['key'];

export const durationOf = (key: DurationKey): number | null => DURATIONS.find((d) => d.key === key)?.ms ?? null;

/** The kinds "Something else" offers, in the order shown. */
export const CUSTOM_KINDS: readonly SanctionKind[] = ['chat', 'area', 'ban', 'warning', 'note'];

/** A kind has no length when it is only a record: a warning or a note. */
export const hasLength = (kind: SanctionKind): boolean => kind !== 'warning' && kind !== 'note';

/** What an action does: its kind and length (null: permanent, or no length for a warning or note). */
export interface Choice {
  kind: SanctionKind;
  durationMs: number | null;
}

/** A stable text for a choice, used as the value of the "What happens" menu: `chat:86400000`, `ban:null`. */
export const choiceKey = (c: Choice): string => `${c.kind}:${c.durationMs === null ? 'null' : c.durationMs}`;

const KIND_RANK: Record<SanctionKind, number> = { warning: 0, chat: 1, area: 2, ban: 3, note: 4 };

/**
 * The ready-made choices: every action the ladder table can suggest, once each, lightest first, then a note. They come from
 * core's `LADDER_TABLE`, so the menu and the suggestion cannot drift apart.
 */
export function presets(): Choice[] {
  const seen = new Map<string, Choice>();
  for (const row of LADDER_TABLE) {
    for (const cell of [row.lowMedium, row.high]) {
      const choice: Choice = { kind: cell.kind, durationMs: cell.durationMs };
      seen.set(choiceKey(choice), choice);
    }
  }
  const sorted = [...seen.values()].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity));
  return [...sorted, { kind: 'note', durationMs: null }];
}

/** One action being set up. All text fields are what the person typed or picked, not yet checked. */
export interface Draft {
  uid: string;
  /** The staff ref of the person it is about. */
  person: string;
  /** `''` nothing chosen yet, `'other'` for "Something else", otherwise a {@link choiceKey} of a preset. */
  what: string;
  customKind: SanctionKind;
  customDuration: DurationKey;
  /** `''` nothing chosen, `'uncovered'` for "No rule covers this", else a rule number as text. */
  rule: string;
  gapNote: string;
  lineIds: string[];
}

export type UiVerdict = 'fair' | 'not_a_problem' | 'bad_faith';

export interface DecisionForm {
  verdict: UiVerdict | null;
  evidence: string;
  reason: string;
  actions: Draft[];
}

export const emptyForm = (): DecisionForm => ({ verdict: null, evidence: '', reason: '', actions: [] });

/** A new action for `person`; `rule` is the rule to start from (the report's), or `''`. */
export function newDraft(uid: string, person: string, rule: number | ''): Draft {
  return { uid, person, what: '', customKind: 'chat', customDuration: '24h', rule: rule === '' ? '' : String(rule), gapNote: '', lineIds: [] };
}

/** What a draft does, or null while nothing is chosen. */
export function resolveDraft(d: Draft): Choice | null {
  if (d.what === '') return null;
  if (d.what === 'other') return { kind: d.customKind, durationMs: hasLength(d.customKind) ? durationOf(d.customDuration) : null };
  return presets().find((x) => choiceKey(x) === d.what) ?? null;
}

/** The verdict the server is sent. "Fair" is `noted` when every action is a note (and there is one), else `upheld`. */
export function serverVerdict(form: DecisionForm): DecideInput['verdict'] {
  if (form.verdict === 'not_a_problem') return 'no_action';
  if (form.verdict === 'bad_faith') return 'bad_faith';
  const choices = form.actions.map(resolveDraft);
  return choices.length > 0 && choices.every((c) => c?.kind === 'note') ? 'noted' : 'upheld';
}

/** The body for `POST /reports/:id/decide`. Call it on a form that has passed {@link validate}. */
export function toInput(form: DecisionForm): DecideInput {
  const actions = form.actions.map((d): DecisionAction => {
    const choice = resolveDraft(d) as Choice;
    const uncovered = d.rule === 'uncovered';
    const action: DecisionAction = { subject: d.person, kind: choice.kind, durationMs: choice.durationMs, rule: uncovered ? 'uncovered' : Number(d.rule) };
    if (uncovered) action.gapNote = d.gapNote.trim();
    if (choice.kind !== 'note' && d.lineIds.length > 0) action.lineIds = [...d.lineIds];
    return action;
  });
  const input: DecideInput = { verdict: serverVerdict(form), reason: form.reason.trim(), actions };
  if (form.verdict === 'bad_faith') input.evidence = form.evidence.trim();
  return input;
}

/** What the checks need to know about the report and the signed-in role. */
export interface ValidationContext {
  /** The reported person. */
  target: string;
  /** Everyone the report names (the people an action may be about). */
  people: readonly string[];
  /** The numbers of the rules that may be cited (active ones). */
  rules: readonly number[];
  /** `can['sanctions.apply']`. */
  canApply: boolean;
  /** `can['sanctions.apply.ban_permanent']`. */
  canPermanent: boolean;
  /** For each person, the ids of the lines they wrote themselves. */
  ownLineIds: Readonly<Record<string, readonly string[]>>;
}

/** A refusal as a catalog key, with the values it needs. */
export interface Problem {
  key: HubText;
  params?: HubParams;
}

export interface ActionProblems {
  person?: Problem;
  what?: Problem;
  rule?: Problem;
  gapNote?: Problem;
  lines?: Problem;
}

export interface Problems {
  verdict?: Problem;
  evidence?: Problem;
  reason?: Problem;
  /** About the list of actions as a whole. */
  list?: Problem;
  /** By draft `uid`; a draft with no problem has no entry. */
  actions: Record<string, ActionProblems>;
  count: number;
}

const problem = (key: HubText, params?: HubParams): Problem => (params === undefined ? { key } : { key, params });

/** Everything the server would refuse (and a little it would not, like a rule that is not chosen), found before sending. */
export function validate(form: DecisionForm, ctx: ValidationContext): Problems {
  const out: Problems = { actions: {}, count: 0 };

  if (form.verdict === null) out.verdict = problem('hub.decide.error.verdictRequired');
  if (form.verdict === 'bad_faith') {
    const evidence = form.evidence.trim();
    if (evidence === '') out.evidence = problem('hub.decide.error.evidenceRequired');
    else if (evidence.length > EVIDENCE_MAX) out.evidence = problem('hub.decide.error.evidenceLong', { max: EVIDENCE_MAX });
  }
  const reason = form.reason.trim();
  if (reason === '') out.reason = problem('hub.decide.error.reasonRequired');
  else if (reason.length > REASON_MAX) out.reason = problem('hub.decide.error.reasonLong', { max: REASON_MAX });

  if (form.actions.length > MAX_ACTIONS) out.list = problem('hub.decide.error.tooMany', { max: MAX_ACTIONS });
  else if (form.actions.length > 0 && !ctx.canApply) out.list = problem('hub.decide.error.cannotApply');

  const dismissal = form.verdict === 'not_a_problem' || form.verdict === 'bad_faith';
  const used = new Set<string>();
  for (const d of form.actions) {
    const found: ActionProblems = {};
    if (!ctx.people.includes(d.person)) found.person = problem('hub.decide.error.personUnknown');
    else if (dismissal && d.person === ctx.target) found.person = problem('hub.decide.error.targetNeedsFair');

    const choice = resolveDraft(d);
    if (choice === null) found.what = problem('hub.decide.error.whatRequired');
    else if (choice.durationMs === null && hasLength(choice.kind) && !ctx.canPermanent) found.what = problem('hub.decide.error.permanent');
    if (choice !== null && found.what === undefined) {
      const key = `${d.person}\u0000${choice.kind}`;
      if (used.has(key)) found.what = problem('hub.decide.error.duplicate');
      used.add(key);
    }

    if (d.rule === '') found.rule = problem('hub.decide.error.ruleRequired');
    else if (d.rule === 'uncovered') {
      const gap = d.gapNote.trim();
      if (gap === '') found.gapNote = problem('hub.decide.error.gapRequired');
      else if (gap.length > GAP_NOTE_MAX) found.gapNote = problem('hub.decide.error.gapLong', { max: GAP_NOTE_MAX });
    } else if (!ctx.rules.includes(Number(d.rule))) found.rule = problem('hub.decide.error.ruleUnknown');

    // A note tells the player nothing, so its lines are not sent and not checked.
    if (choice?.kind !== 'note' && d.lineIds.length > 0) {
      const own = ctx.ownLineIds[d.person] ?? [];
      if (d.lineIds.length > LINES_MAX) found.lines = problem('hub.decide.error.linesMany', { max: LINES_MAX });
      else if (d.lineIds.some((id) => !own.includes(id))) found.lines = problem('hub.decide.error.linesForeign');
    }

    if (Object.keys(found).length > 0) out.actions[d.uid] = found;
  }

  out.count =
    [out.verdict, out.evidence, out.reason, out.list].filter((x) => x !== undefined).length +
    Object.values(out.actions).reduce((sum, a) => sum + Object.keys(a).length, 0);
  return out;
}

/** The rule to start a new action from: the report's own rule when it can be cited. */
const startRule = (ctx: ValidationContext, reportRule: number | 'uncovered'): number | '' =>
  typeof reportRule === 'number' && ctx.rules.includes(reportRule) ? reportRule : '';

/** Adds an empty action: for the reported person under "fair", else for the reporter. Does nothing at the limit. */
export function addAction(form: DecisionForm, ctx: ValidationContext, reportRule: number | 'uncovered', uid: string): DecisionForm {
  if (form.actions.length >= MAX_ACTIONS) return form;
  const dismissal = form.verdict === 'not_a_problem' || form.verdict === 'bad_faith';
  const person = dismissal ? (ctx.people.find((x) => x !== ctx.target) ?? ctx.target) : ctx.target;
  return { ...form, actions: [...form.actions, newDraft(uid, person, startRule(ctx, reportRule))] };
}

/** A change of verdict: drops the actions on the reported person when the new verdict may not act on them. */
export function dropTargetActions(form: DecisionForm, target: string): { form: DecisionForm; dropped: number } {
  const kept = form.actions.filter((a) => a.person !== target);
  const dropped = form.actions.length - kept.length;
  return dropped === 0 ? { form, dropped } : { form: { ...form, actions: kept }, dropped };
}

/** The draft fields that say `choice`, or null when the form has no way to say it. */
function draftFor(choice: Choice): Pick<Draft, 'what' | 'customKind' | 'customDuration'> | null {
  const key = choiceKey(choice);
  if (presets().some((x) => choiceKey(x) === key)) return { what: key, customKind: 'chat', customDuration: '24h' };
  const length = DURATIONS.find((d) => d.ms === choice.durationMs);
  if (!hasLength(choice.kind) || length === undefined) return null;
  return { what: 'other', customKind: choice.kind, customDuration: length.key };
}

/** The choice a suggestion's outcome stands for, or null for "no action". */
export function outcomeChoice(outcome: Suggestion['outcome']): Choice | null {
  if (outcome === 'none') return null;
  if (outcome === 'note') return { kind: 'note', durationMs: null };
  if (outcome === 'warning') return { kind: 'warning', durationMs: null };
  return { kind: outcome.kind, durationMs: outcome.durationMs };
}

/**
 * The form with the ladder's suggestion as the reported person's action under "fair". An action of the same kind they already
 * have is changed, not doubled. Null when there is nothing to add (no action suggested, or a length the form cannot offer).
 */
export function withSuggestion(
  form: DecisionForm,
  ctx: ValidationContext,
  outcome: Suggestion['outcome'],
  reportRule: number | 'uncovered',
  uid: string,
): DecisionForm | null {
  const choice = outcomeChoice(outcome);
  if (choice === null) return null;
  const fields = draftFor(choice);
  if (fields === null) return null;
  const base: DecisionForm = { ...form, verdict: 'fair' };
  const same = base.actions.find((a) => a.person === ctx.target && resolveDraft(a)?.kind === choice.kind);
  if (same !== undefined) return { ...base, actions: base.actions.map((a) => (a === same ? { ...a, ...fields } : a)) };
  if (base.actions.length >= MAX_ACTIONS) return null;
  return { ...base, actions: [...base.actions, { ...newDraft(uid, ctx.target, startRule(ctx, reportRule)), ...fields }] };
}
