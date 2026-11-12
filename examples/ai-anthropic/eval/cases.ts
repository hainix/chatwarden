import { readFileSync } from 'node:fs';
import { buildAIInput, chooseLines, DEFAULT_REPORT_REASONS, defineRules, PRESETS, redactReportNote, starterRules } from '@chatwarden/core';
import type { AIReadInput, AIValidationContext, ChosenLines, ConductLevel, DocumentPolicy, ReportRecord } from '@chatwarden/core';

// The eval set: the case shape, the loader and the bridge to core. A case is turned into a stored report and then run through the
// real core pipeline (line choice, redaction, aliasing, prompt), so the eval sees exactly what a live read would send.

export const CASE_GROUPS: readonly string[] = [
  'banter',
  'rude',
  'hostile',
  'severe-slur',
  'threat',
  'complaint',
  'others-only',
  'note',
  'no-reason',
  'long-room',
  'injection',
  'unspaced',
];

export interface EvalLine {
  who: 'reported' | 'reporter' | 'other';
  text: string;
  /** The word filter stopped it (the text is still sent, as in a live read). */
  blocked?: boolean;
}

export interface EvalExpect {
  /** One level, or a band of acceptable levels. */
  severity: ConductLevel | ConductLevel[];
  /** A starter rule number or `uncovered`; absent means the rule is not scored. */
  rule?: number | 'uncovered';
  verdict: 'upheld' | 'noted' | 'no_action' | 'unclear';
  /** 1-based numbers into `lines` that the read must cite. */
  mustCite?: number[];
  /** 1-based numbers into `lines` that the read must not cite. */
  mustNotCite?: number[];
  /** A line or the note tries to instruct the AI, so `injectionSuspected` is expected. */
  injection?: boolean;
}

export interface EvalCase {
  id: string;
  group: string;
  /** A reporting reason id (such as `harassment`), or null when the reporter gave none. */
  reason: string | null;
  note: string | null;
  /** Starter rules and profile flavour; default `standard`. */
  rules?: 'relaxed' | 'standard' | 'strict';
  lines: EvalLine[];
  /** 1-based number of the line the reporter pointed at. */
  pointedAt?: number;
  expect: EvalExpect;
}

export function loadCases(): EvalCase[] {
  return JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')) as EvalCase[];
}

const BASE_TS = 1_700_000_000_000;
const SEAT = { reported: 'seat-reported', reporter: 'seat-reporter', other: 'seat-other' } as const;
const lineId = (n: number): string => `ln-${n}`;

/** A case as the stored report the kit would hold. Every id in it carries a marker the tests look for in the prompt. */
export function caseToReport(c: EvalCase): ReportRecord {
  return {
    id: `report-${c.id}`,
    createdAt: BASE_TS + c.lines.length * 4000,
    roomId: 'room-eval',
    tags: {},
    reporterSubject: 'subject-reporter',
    reporterSeat: SEAT.reporter,
    reporterHandle: 'handle-reporter',
    targetSubject: 'subject-reported',
    targetSeat: SEAT.reported,
    targetHandle: 'handle-reported',
    category: 'other',
    reportedReason: c.reason,
    note: c.note,
    lineId: c.pointedAt === undefined ? null : lineId(c.pointedAt),
    excerpt: c.lines.map((l, i) => ({
      lineId: lineId(i + 1),
      ts: BASE_TS + i * 4000,
      seatId: SEAT[l.who],
      handle: `handle-${l.who}`,
      raw: l.text,
      delivered: l.blocked === true ? null : l.text,
      blocked: l.blocked === true,
      audience: null,
      p: null,
    })),
    people: [],
    status: 'open',
    badFaith: false,
    actionedAt: null,
    actionedBy: null,
    modNote: null,
    badFaithEvidence: null,
  };
}

export function policyFor(c: EvalCase): DocumentPolicy {
  const flavour = c.rules ?? 'standard';
  return { profile: PRESETS[flavour], rules: defineRules(starterRules(flavour)) };
}

export interface Prepared {
  report: ReportRecord;
  chosen: ChosenLines;
  input: AIReadInput;
  ctx: AIValidationContext;
  /** The 1-based case line number behind a prompt ref, or null. */
  lineNumber(ref: string): number | null;
  /** The prompt ref of a 1-based case line number, or null when the line was left out. */
  refOf(n: number): string | null;
}

/** Run a case through core: choose and redact the lines, render the prompt, and build what validation needs. */
export function prepare(c: EvalCase): Prepared {
  const report = caseToReport(c);
  const policy = policyFor(c);
  const chosen = chooseLines(report);
  const reasonRow = c.reason === null ? null : DEFAULT_REPORT_REASONS.find((r) => r.id === c.reason);
  if (reasonRow === undefined) throw new Error(`case ${c.id}: unknown reason ${String(c.reason)}`);
  const input = buildAIInput({
    policy,
    reason: reasonRow === null ? null : { id: reasonRow.id, label: reasonRow.label },
    note: redactReportNote(report),
    chosen,
  });
  const byRef = new Map(chosen.lines.map((l) => [l.ref, Number(l.lineId.slice('ln-'.length))]));
  return {
    report,
    chosen,
    input,
    ctx: {
      sent: new Set(chosen.lines.map((l) => l.ref)),
      activeRules: new Set(policy.rules.active().map((r) => r.number)),
      ownRefs: new Set(chosen.lines.filter((l) => l.byReported).map((l) => l.ref)),
    },
    lineNumber: (ref) => byRef.get(ref) ?? null,
    refOf: (n) => chosen.lines.find((l) => l.lineId === lineId(n))?.ref ?? null,
  };
}
