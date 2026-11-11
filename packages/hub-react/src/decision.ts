import { LADDER_TABLE } from '@chatwarden/core';
import type { LadderRow } from '@chatwarden/core';
import type { HubParams, HubText } from './i18n.js';
import { MAX_LENGTH_MS, resolveLength } from './policy/length.js';
import type { LengthUnit } from './policy/length.js';
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

/** The longest sanction the server takes: 365 days. */
export const MAX_DURATION_MS = MAX_LENGTH_MS;

/** What the menu is built from: the adopter's ladder and outcomes (`GET /policy` `profile`). Anything missing falls back to core's table. */
export interface PresetSource {
  ladder?: readonly LadderRow[];
  firstOffense?: Readonly<Record<string, Suggestion['outcome'] | undefined>>;
  repeat?: { outcome: Suggestion['outcome'] };
}

/**
 * The ready-made choices: every action the adopter's ladder (else core's `LADDER_TABLE`) can suggest, plus what a first offence
 * and a repeat can suggest, once each, lightest first, then a note. `extra` choices (the ladder's current suggestion, so it can
 * always be taken) are added when they are not there yet.
 */
export function presets(source: PresetSource = {}, extra: readonly Choice[] = []): Choice[] {
  const seen = new Map<string, Choice>();
  const put = (choice: Choice | null): void => {
    if (choice !== null && parseChoiceKey(choiceKey(choice)) !== null) seen.set(choiceKey(choice), choice);
  };
  for (const row of source.ladder ?? LADDER_TABLE) {
    for (const cell of [row.lowMedium, row.high]) put({ kind: cell.kind, durationMs: cell.durationMs });
  }
  if (source.ladder !== undefined || source.firstOffense !== undefined || source.repeat !== undefined) {
    for (const outcome of Object.values(source.firstOffense ?? {})) if (outcome !== undefined) put(outcomeChoice(outcome));
    if (source.repeat !== undefined) put(outcomeChoice(source.repeat.outcome));
  }
  for (const choice of extra) put(choice);
  seen.delete('note:null');
  const sorted = [...seen.values()].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity));
  return [...sorted, { kind: 'note', durationMs: null }];
}

/** The choice a {@link choiceKey} stands for, or null when it is not one the server could take (unknown kind, a length on a warning, 0 or over 365 days). */
export function parseChoiceKey(key: string): Choice | null {
  const m = /^(warning|chat|area|ban|note):(null|[1-9]\d{0,12})$/.exec(key);
  if (m === null) return null;
  const kind = m[1] as SanctionKind;
  if (m[2] === 'null') return { kind, durationMs: null };
  if (!hasLength(kind)) return null;
  const durationMs = Number(m[2]);
  return durationMs <= MAX_DURATION_MS ? { kind, durationMs } : null;
}

/** Whether a choice is the permanent ban: the one action that needs `sanctions.apply.ban_permanent` (the server's rule; a permanent chat or area restriction follows `sanctions.apply`). */
export const needsBanPermission = (c: Choice): boolean => c.kind === 'ban' && c.durationMs === null;

/** One action being set up. All text fields are what the person typed or picked, not yet checked. */
export interface Draft {
  uid: string;
  /** The staff ref of the person it is about. */
  person: string;
  /** `''` nothing chosen yet, `'other'` for "Something else", otherwise a {@link choiceKey} of a preset. */
  what: string;
  customKind: SanctionKind;
  /** The length of a "Something else" action: a length from the profile (see `lengthValue`), `permanent`, or `custom` with the number and unit below. */
  customDuration: string;
  customAmount?: string;
  customUnit?: LengthUnit;
  /** `''` nothing chosen, `'uncovered'` for "No rule covers this", else a rule number as text. */
  rule: string;
  gapNote: string;
  lineIds: string[];
}

export type UiVerdict = 'fair' | 'not_a_problem' | 'bad_faith';

/** @experimental */
export interface DecisionForm {
  verdict: UiVerdict | null;
  evidence: string;
  reason: string;
  actions: Draft[];
}

/** @experimental */
export const emptyForm = (): DecisionForm => ({ verdict: null, evidence: '', reason: '', actions: [] });

/** A new action for `person`; `rule` is the rule to start from (the report's), or `''`. */
export function newDraft(uid: string, person: string, rule: number | ''): Draft {
  return { uid, person, what: '', customKind: 'chat', customDuration: '24h', rule: rule === '' ? '' : String(rule), gapNote: '', lineIds: [] };
}

/** What the length of a "Something else" action says: its milliseconds (null: permanent), or why it says nothing yet. */
export const lengthOfDraft = (d: Draft): ReturnType<typeof resolveLength> => resolveLength({ value: d.customDuration, amount: d.customAmount ?? '', unit: d.customUnit ?? 'hours' });

/** What a draft does, or null while nothing is chosen (or its own length is not valid yet: a bad length is never read as permanent). */
export function resolveDraft(d: Draft): Choice | null {
  if (d.what === '') return null;
  if (d.what === 'other') {
    if (!hasLength(d.customKind)) return { kind: d.customKind, durationMs: null };
    const length = lengthOfDraft(d);
    return length.ok ? { kind: d.customKind, durationMs: length.ms } : null;
  }
  return parseChoiceKey(d.what);
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
  /** `can['sanctions.apply.ban_permanent']`: only a permanent ban needs it. */
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
  /** The custom length typed for "Something else" is not a length the kit takes. */
  length?: Problem;
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

    const badLength = d.what === 'other' && hasLength(d.customKind) ? lengthOfDraft(d) : null;
    const choice = resolveDraft(d);
    if (badLength !== null && !badLength.ok) found.length = badLength.problem;
    else if (choice === null) found.what = problem('hub.decide.error.whatRequired');
    else if (needsBanPermission(choice) && !ctx.canPermanent) found.what = problem('hub.decide.error.permanent');
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

/** The draft fields that say `choice`, or null when the form cannot say it (a length over 365 days). */
function draftFor(choice: Choice): Pick<Draft, 'what' | 'customKind' | 'customDuration'> | null {
  const key = choiceKey(choice);
  return parseChoiceKey(key) === null ? null : { what: key, customKind: 'chat', customDuration: '24h' };
}

/** The choice a suggestion's outcome stands for, or null for "no action". */
export function outcomeChoice(outcome: Suggestion['outcome']): Choice | null {
  if (outcome === 'none') return null;
  if (outcome === 'note') return { kind: 'note', durationMs: null };
  if (outcome === 'warning') return { kind: 'warning', durationMs: null };
  return { kind: outcome.kind, durationMs: outcome.durationMs };
}

/** Why a suggestion cannot be added as an action: there is none, the decision is full, or its length is not one the server takes. */
export type NotAdded = 'none' | 'limit' | 'unsupported';

/** Why {@link withSuggestion} would return null, or null when it would add (or change) an action. */
export function whyNotAdded(form: DecisionForm, ctx: ValidationContext, outcome: Suggestion['outcome']): NotAdded | null {
  const choice = outcomeChoice(outcome);
  if (choice === null) return 'none';
  if (draftFor(choice) === null) return 'unsupported';
  const same = form.actions.some((a) => a.person === ctx.target && resolveDraft(a)?.kind === choice.kind);
  return !same && form.actions.length >= MAX_ACTIONS ? 'limit' : null;
}

/**
 * The form with the ladder's suggestion as the reported person's action. An action of the same kind they already have is
 * changed, not doubled. The verdict is left alone, except that an unset one becomes "fair" (the only verdict that may act on
 * the reported person). Null when there is nothing to add: see {@link whyNotAdded}.
 */
export function withSuggestion(
  form: DecisionForm,
  ctx: ValidationContext,
  outcome: Suggestion['outcome'],
  reportRule: number | 'uncovered',
  uid: string,
  lineIds: readonly string[] = [],
): DecisionForm | null {
  if (whyNotAdded(form, ctx, outcome) !== null) return null;
  const choice = outcomeChoice(outcome) as Choice;
  const fields = draftFor(choice) as NonNullable<ReturnType<typeof draftFor>>;
  const base: DecisionForm = form.verdict === null ? { ...form, verdict: 'fair' } : form;
  const lines = choice.kind === 'note' ? [] : [...lineIds];
  const same = base.actions.find((a) => a.person === ctx.target && resolveDraft(a)?.kind === choice.kind);
  if (same !== undefined) return { ...base, actions: base.actions.map((a) => (a === same ? { ...a, ...fields } : a)) };
  return { ...base, actions: [...base.actions, { ...newDraft(uid, ctx.target, startRule(ctx, reportRule)), ...fields, lineIds: lines }] };
}

/**
 * Which of the person's own lines the player is shown by default: at most {@link LINES_MAX}, in the order they were said. The
 * reported line is always among them when it is theirs; the rest are their latest.
 */
export function defaultLines(own: readonly string[], reported: string | null): string[] {
  if (own.length <= LINES_MAX) return [...own];
  const keep = new Set(own.slice(-LINES_MAX));
  if (reported !== null && own.includes(reported) && !keep.has(reported)) {
    keep.delete(own.slice(-LINES_MAX)[0] as string);
    keep.add(reported);
  }
  return own.filter((id) => keep.has(id));
}

/**
 * The form a case opens with: nothing decided, and the ladder's suggestion ready as the reported person's action (their own lines
 * chosen, the report's rule filled in). A suggestion that is "no action", that the role may not apply (no `sanctions.apply`, or a
 * permanent ban without the senior permission), or that has no representable length, leaves the action list empty.
 */
export function initialForm(ctx: ValidationContext, outcome: Suggestion['outcome'], reportRule: number | 'uncovered', reportedLine: string | null, uid: string): DecisionForm {
  const choice = outcomeChoice(outcome);
  if (choice === null || !ctx.canApply || (needsBanPermission(choice) && !ctx.canPermanent)) return emptyForm();
  const lines = defaultLines(ctx.ownLineIds[ctx.target] ?? [], reportedLine);
  const form = withSuggestion(emptyForm(), ctx, outcome, reportRule, uid, lines);
  return form === null ? emptyForm() : { ...form, verdict: null };
}
