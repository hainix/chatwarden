import type { DocumentPolicy } from '../documents.js';
import { reasonLabel } from '../reporting.js';
import type { ReportReason } from '../reporting.js';
import type { ReportRecord } from '../types.js';
import { inputHash } from './hash.js';
import { looksLikeInjection } from './injection.js';
import { chooseLines } from './lines.js';
import type { ChosenLines } from './lines.js';
import { buildAIInput } from './prompt.js';
import type { AIExampleInput, AIReadInput } from './types.js';

// One report, made ready for a read: the lines chosen and redacted, the prompt rendered, the input hash for this adapter, and the
// facts the answer is checked against. Pure. The hash leaves the casebook examples out (ruling A3), so the same case always has the
// same hash whatever the casebook holds; `build` renders the input again with examples for the call itself.

/** A report ready to be read (or to be compared with a stored read). */
export interface Prepared {
  /** The input without casebook examples: what the hash is of. */
  input: AIReadInput;
  chosen: ChosenLines;
  /** `inputHash(input, adapterId)`. */
  hash: string;
  /** A line or the note looks like an instruction to the AI (the tripwire). */
  injection: boolean;
  /** Every line ref that is in the prompt. */
  refs: ReadonlySet<string>;
  /** The numbers of the rules that were active when the prompt was built. */
  activeRules: ReadonlySet<number>;
  /** The refs of the lines the reported person wrote. */
  ownRefs: ReadonlySet<string>;
  /** The real line id behind each ref. Never handed to an adapter. */
  idOf: ReadonlyMap<string, string>;
  /** The real ids of the lines the reported person wrote (among the chosen). */
  ownLineIds: ReadonlySet<string>;
  /** The same input with casebook examples in it (at most two are used). The hash does not change. */
  build(examples: readonly AIExampleInput[]): AIReadInput;
}

export interface PrepareArgs {
  report: ReportRecord;
  policy: DocumentPolicy;
  reasons: readonly ReportReason[];
  adapterId: string;
  /** `blockedLines: 'mask'`: send a line the filter touched masked, not raw. */
  mask: boolean;
}

export function prepareCase(args: PrepareArgs): Prepared {
  const { report, policy } = args;
  const chosen = chooseLines(report, { mask: args.mask });
  const reasonId = report.reportedReason ?? null;
  const reason = reasonId === null ? null : { id: reasonId, label: reasonLabel(args.reasons, reasonId) ?? reasonId };
  const build = (examples: readonly AIExampleInput[]): AIReadInput => buildAIInput({ policy, reason, chosen, examples });
  const input = build([]);

  // The tripwire reads what the players typed (the raw text), whatever is sent.
  const rawOf = new Map(report.excerpt.map((l) => [l.lineId, l.raw]));
  const injection =
    (report.note !== null && looksLikeInjection(report.note)) ||
    chosen.lines.some((l) => looksLikeInjection(rawOf.get(l.lineId) ?? l.text));

  return {
    input,
    chosen,
    hash: inputHash(input, args.adapterId),
    injection,
    refs: new Set(chosen.lines.map((l) => l.ref)),
    activeRules: new Set(input.rules.map((r) => r.number)),
    ownRefs: new Set(chosen.lines.filter((l) => l.byReported).map((l) => l.ref)),
    idOf: new Map(chosen.lines.map((l) => [l.ref, l.lineId])),
    ownLineIds: new Set(chosen.lines.filter((l) => l.byReported).map((l) => l.lineId)),
    build,
  };
}
