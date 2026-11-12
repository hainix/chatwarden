import type { RuleRef } from '../rules.js';
import type { AiOutcomeInsert, ConductLevel, ReportRecord, SanctionKind, SubjectId } from '../types.js';
import { compareSteps } from './agreement.js';
import type { StepLike } from './agreement.js';
import type { ChosenLines } from './lines.js';
import { redactText } from './redact.js';

// The casebook's pure parts (design section 11): which lines of a decided case become a pseudonymised example, and what the human
// did to the reported person. The service puts them together with the store; nothing here reads a store or acts on anyone.

/** How many teachable decisions must exist before any example is shown to the model. */
export const AI_EXAMPLES_MIN = 30;
/** The most lines in one example. */
export const EXAMPLE_LINES_MAX = 6;

/**
 * Up to six lines of the case, as aliases and redacted text: first the lines the human or the AI cited, then the rest of what the
 * reported person wrote, then the other lines, the newest first within each group; shown in time order. The text goes through the
 * same redaction as a read (it is idempotent on text that already went through it). No handle, seat, id or line id is returned.
 */
export function pickExampleLines(chosen: ChosenLines, cited: ReadonlySet<string>): Array<{ who: string; text: string }> {
  const lines = chosen.lines;
  const ranked = lines
    .map((l, i) => ({ i, rank: (cited.has(l.lineId) ? 0 : l.byReported ? 1 : 2) * 1000 + (lines.length - i) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, EXAMPLE_LINES_MAX)
    .map((e) => e.i)
    .sort((a, b) => a - b);
  return ranked.map((i) => {
    const line = lines[i] as ChosenLines['lines'][number];
    return { who: line.who, text: redactText(line.text, [], () => null) };
  });
}

/** One action the decision took, as the casebook needs it. */
export interface TakenAction {
  subject: string;
  kind: SanctionKind;
  durationMs: number | null;
  rule: number | 'uncovered';
  lineIds: readonly string[];
}

/**
 * What the human did to the reported person: their strongest step, the rule it cited and the lines they showed. A decision that
 * acted on nobody but others (the reporter, a bystander) did nothing to the reported person; `others` counts the actions on those others.
 */
export function actionsOnTarget(actions: readonly TakenAction[], target: string): { step: StepLike | null; rule: number | 'uncovered' | null; lineIds: string[]; others: number } {
  const own = actions.filter((a) => a.subject === target);
  const others = actions.length - own.length;
  if (own.length === 0) return { step: null, rule: null, lineIds: [], others };
  let strongest = own[0] as TakenAction;
  for (const a of own) if (compareSteps(a, strongest) > 0) strongest = a;
  return {
    step: { kind: strongest.kind, durationMs: strongest.durationMs },
    rule: strongest.rule,
    lineIds: [...new Set(own.flatMap((a) => a.lineIds))],
    others,
  };
}

/** What the casebook is told about a decision that is about to commit (see `DecisionServiceDeps.aiOutcome`). */
export interface AiOutcomeArgs {
  report: ReportRecord;
  /** The canonical subject the report is about. */
  target: SubjectId;
  verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith';
  actions: ReadonlyArray<{ subject: SubjectId; kind: SanctionKind; durationMs: number | null; rule: RuleRef; lineIds: readonly string[] }>;
  /** The echo of the decision, or all-empty (`readId` null, not accepted, no severity) when it carried none. */
  ai: { readId: string | null; accepted: boolean; severity: ConductLevel | null };
  now: number;
}

/** Computes the casebook row for a decision, from the stored read and the decision. Returns null for none. */
export type AiOutcomeHook = (args: AiOutcomeArgs) => AiOutcomeInsert | null;
