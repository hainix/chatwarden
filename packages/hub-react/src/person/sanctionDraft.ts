import { DURATIONS, hasLength, resolveDraft, validate } from '../decision.js';
import type { DecisionForm, Problem } from '../decision.js';
import { lengthValue } from '../policy/length.js';
import type { LengthPolicy } from '../policy/lengths.js';
import type { LengthUnit } from '../policy/length.js';
import type { SanctionInput, SanctionKind } from '../types.js';

// The direct-sanction form (a sanction or a note from the person page) as plain data and pure functions. It asks the decision
// form's own checks, through a one-action decision, so the two cannot disagree about a rule, a length or a permanent ban.

export type SanctionMode = 'sanction' | 'note';

/** What the person typed or picked, not yet checked. */
export interface SanctionDraft {
  /** `''` until one is chosen: nothing is pre-selected, so nothing is sent by accident. A note is always `note`. */
  kind: SanctionKind | '';
  /** A length from the profile (see `lengthValue`), `permanent`, or `custom` with the number and unit below. */
  duration: string;
  customAmount?: string;
  customUnit?: LengthUnit;
  /** `''` nothing chosen, `'uncovered'` for "No rule covers this", else a rule number as text. */
  rule: string;
  gapNote: string;
  /** The reason; for a note, the note itself. */
  reason: string;
  includeIp: boolean;
}

export interface SanctionContext {
  /** The numbers of the rules that may be cited (active ones). */
  rules: readonly number[];
  /** `can['sanctions.apply']`. */
  canApply: boolean;
  /** `can['sanctions.apply.ban_permanent']`. */
  canPermanent: boolean;
}

export interface SanctionProblems {
  kind?: Problem;
  /** The custom length typed is not one the kit takes. */
  length?: Problem;
  rule?: Problem;
  gapNote?: Problem;
  reason?: Problem;
  /** About the whole form: the role may not apply sanctions at all. */
  list?: Problem;
  count: number;
}

export const emptySanction = (mode: SanctionMode): SanctionDraft => ({
  kind: mode === 'note' ? 'note' : '',
  duration: '24h',
  rule: '',
  gapNote: '',
  reason: '',
  includeIp: false,
});

/**
 * The lengths a kind offers, shortest first: the profile's own list (else the four the form always had), then permanent, then "custom"
 * when the profile allows it. A warning, a note, or nothing chosen has none. Only a permanent ban needs the senior permission.
 */
export function durationChoices(kind: SanctionKind | '', canPermanent: boolean, lengths?: LengthPolicy): string[] {
  if (kind === '' || !hasLength(kind)) return [];
  if (lengths === undefined) return DURATIONS.filter((d) => d.ms !== null || kind !== 'ban' || canPermanent).map((d) => d.key);
  return [...lengths.durations.map(lengthValue), ...(kind !== 'ban' || canPermanent ? ['permanent'] : []), ...(lengths.custom ? ['custom'] : [])];
}

const SUBJECT = 'subject';

/** The decision form's draft for this: one action on one person. */
function asDecision(d: SanctionDraft, mode: SanctionMode): DecisionForm {
  const kind: SanctionKind | '' = mode === 'note' ? 'note' : d.kind;
  return {
    verdict: 'fair',
    evidence: '',
    reason: d.reason,
    actions: [
      {
        uid: 'a',
        person: SUBJECT,
        what: kind === '' ? '' : 'other',
        customKind: kind === '' ? 'chat' : kind,
        customDuration: d.duration,
        ...(d.customAmount === undefined ? {} : { customAmount: d.customAmount }),
        ...(d.customUnit === undefined ? {} : { customUnit: d.customUnit }),
        rule: d.rule,
        gapNote: d.gapNote,
        lineIds: [],
      },
    ],
  };
}

/** Everything the server would refuse, found before sending. */
export function sanctionProblems(d: SanctionDraft, mode: SanctionMode, ctx: SanctionContext): SanctionProblems {
  const found = validate(asDecision(d, mode), {
    target: SUBJECT,
    people: [SUBJECT],
    rules: ctx.rules,
    canApply: ctx.canApply,
    canPermanent: ctx.canPermanent,
    ownLineIds: {},
  });
  const action = found.actions.a ?? {};
  const out: SanctionProblems = { count: 0 };
  if (action.what !== undefined) out.kind = action.what;
  if (action.length !== undefined) out.length = action.length;
  if (action.rule !== undefined) out.rule = action.rule;
  if (action.gapNote !== undefined) out.gapNote = action.gapNote;
  if (found.reason !== undefined) {
    // The decision form says "reason"; a note is the moderator's own words, so it says "note".
    out.reason =
      mode === 'sanction' ? found.reason : { ...found.reason, key: found.reason.key === 'hub.decide.error.reasonRequired' ? 'hub.person.note.error.required' : 'hub.person.note.error.long' };
  }
  if (found.list !== undefined) out.list = found.list;
  out.count = [out.kind, out.length, out.rule, out.gapNote, out.reason, out.list].filter((x) => x !== undefined).length;
  return out;
}

/**
 * The body for `POST /sanctions`. Call it on a draft that has no problems. A warning or note has no length and never the IP; a
 * numbered rule never carries a gap note. `takeOver` is added only when asked for.
 */
export function toSanctionInput(subject: string, d: SanctionDraft, mode: SanctionMode, options: { takeOver?: boolean } = {}): SanctionInput {
  const choice = resolveDraft(asDecision(d, mode).actions[0] as DecisionForm['actions'][number]);
  const kind = (choice?.kind ?? 'note') as SanctionKind;
  const uncovered = d.rule === 'uncovered';
  const input: SanctionInput = {
    subject,
    kind,
    durationMs: hasLength(kind) ? (choice?.durationMs ?? null) : null,
    rule: uncovered ? 'uncovered' : Number(d.rule),
    reason: d.reason.trim(),
    includeIp: hasLength(kind) && d.includeIp,
  };
  if (uncovered) input.gapNote = d.gapNote.trim();
  if (options.takeOver === true) input.takeOver = true;
  return input;
}
