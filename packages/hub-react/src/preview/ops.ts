import type { NoticeOp, PlanAction, PlanLine } from '@chatwarden/core/notice-copy';
import { evidenceOfRule } from '@chatwarden/core';
import type { EvidenceKind } from '@chatwarden/core';
import { hasLength, resolveDraft, serverVerdict } from '../decision.js';
import type { DecisionForm } from '../decision.js';
import type { SanctionGroupView, SanctionKind } from '../types.js';

/** The most lines a notice shows (core's own cap). */
const SHOWN_LINES_MAX = 5;

// The ops the panel is asked about, built from the forms' own state. Small and eager (the panel's code is a lazy chunk, these are not): they carry only
// what `planNotices` accepts, so a reason, a gap note or a reference typed into a form cannot reach the panel (design 7). Core's types are imported as types only.

/** A direct sanction from the Person page: nothing until a kind is chosen. `choice` is the kind and the length the form resolved, or null. */
export function sanctionOp(choice: { kind: SanctionKind; durationMs: number | null } | null): NoticeOp | null {
  if (choice === null) return null;
  return choice.kind === 'note' ? { op: 'note' } : { op: 'sanction', kind: choice.kind, durationMs: hasLength(choice.kind) ? choice.durationMs : null };
}

/**
 * The lines the player is shown for one action: in the report's order (`order`, the excerpt's line ids), not the order they were ticked in, because that is the order
 * the notice is written in. A line the report does not hold, a repeat and a line with no masked text are left out; at most five.
 */
function linesInOrder(lineIds: readonly string[], o: { lineOf: (lineId: string) => PlanLine | null; order: readonly string[] }): PlanLine[] {
  const ticked = new Set(lineIds);
  return o.order
    .filter((id) => ticked.has(id))
    .map(o.lineOf)
    .filter((l): l is PlanLine => l !== null)
    .slice(0, SHOWN_LINES_MAX);
}

/**
 * What a case decision sends, from the decision form: the verdict the server would be sent, each action that is complete enough to say what it sends (a kind and length
 * chosen, a rule cited), the lines the player is shown (`lineOf` answers the server's masked text for a line, or null: a line with no masked text is never shown), and the
 * rename when its rule is chosen. A problem elsewhere in the form never blanks it: it is what the valid part would send. Null while nothing is chosen.
 */
export function decideOp(form: DecisionForm, o: { target: string; reporter: string; lineOf: (lineId: string) => PlanLine | null; order: readonly string[]; evidence?: EvidenceKind | undefined }): NoticeOp | null {
  const dismissal = form.verdict === 'not_a_problem' || form.verdict === 'bad_faith';
  if (form.verdict === null && form.actions.length === 0 && form.rename === null) return null;
  const actions: PlanAction[] = [];
  for (const d of form.actions) {
    const choice = resolveDraft(d);
    const rule = d.rule === 'uncovered' ? 'uncovered' : /^[1-9]\d*$/.test(d.rule) ? Number(d.rule) : null;
    if (choice === null || rule === null) continue;
    const lines = choice.kind === 'note' ? [] : linesInOrder(d.lineIds, o);
    actions.push({ person: d.person, kind: choice.kind, durationMs: hasLength(choice.kind) ? choice.durationMs : null, rule, lines });
  }
  const rename = !dismissal && form.rename !== null && /^[1-9]\d*$/.test(form.rename.rule) ? { rule: Number(form.rename.rule) } : null;
  // What the notice is about, as the server will word it: the moderator's own word, else the report's, else the rule's (CR 5 and 6 play, CR 7 name).
  const first = actions[0]?.rule;
  // The moderator's "chat" counts only when a line goes with it (the request carries it only then, see `toInput`).
  const own = form.evidenceKind === 'chat' && !actions.some((a) => a.lines.length > 0) ? undefined : form.evidenceKind;
  const evidenceKind = own ?? o.evidence ?? (typeof first === 'number' ? evidenceOfRule(first) : undefined);
  return { op: 'decide', verdict: serverVerdict(form), target: o.target, reporter: o.reporter, actions, rename, ...(evidenceKind === undefined ? {} : { evidenceKind }) };
}

/** The rename the Person page asks for, once a numbered rule is chosen. */
export function renameOp(rule: string): NoticeOp | null {
  return /^[1-9]\d*$/.test(rule) ? { op: 'rename', rule: Number(rule) } : null;
}

/** Revoking one sanction in force: what lifts for the player. */
export function revokeOp(s: Pick<SanctionGroupView, 'kind'>): NoticeOp {
  return { op: 'revoke', kind: s.kind };
}
