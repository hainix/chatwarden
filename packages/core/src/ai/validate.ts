import { CONDUCT_LEVELS } from '../types.js';
import type { ConductLevel } from '../types.js';
import type { AIRead } from './types.js';

// Core's own check of a model's answer (design section 8, layer 4). Hand-written: core keeps no dependency. It downgrades, it does
// not guess: a thing that cannot be trusted is `ok: false` with a fixed code (never the offending text), and an uphold or note
// with no line by the reported person is softened to `unclear`.

/** The facts about what was sent, which the answer is checked against. */
export interface AIValidationContext {
  /** Every line ref that was in the prompt. */
  sent: ReadonlySet<string>;
  /** The numbers of the rules that were active when the prompt was built. */
  activeRules: ReadonlySet<number>;
  /** The refs (a subset of `sent`) of lines written by the reported person. */
  ownRefs: ReadonlySet<string>;
}

/**
 * The result of {@link validateAIOutput}. `code` on an `ok` result says the read was softened (today only `no_own_line`).
 * @experimental
 */
export type AIValidation =
  | { ok: true; read: AIRead; code?: 'no_own_line' }
  | { ok: false; code: string };

const SUMMARY_MAX = 160;
const EVIDENCE_MAX = 5;
const READ_KEYS = ['severity', 'rule', 'summary', 'evidence', 'confidence', 'injectionSuspected', 'recommendation'] as const;
const REC_KEYS = ['verdict', 'severity', 'rule', 'evidence'] as const;
const VERDICTS = ['upheld', 'noted', 'no_action', 'unclear'] as const;
const CONFIDENCES = ['low', 'medium', 'high'] as const;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Fail = { ok: false; code: string };
const fail = (code: string): Fail => ({ ok: false, code });

/** Exactly these keys, own, no more and no fewer. */
function keysCode(o: Record<string, unknown>, expected: readonly string[]): string | null {
  const own = Object.keys(o);
  if (own.some((k) => !expected.includes(k))) return 'extra_key';
  if (expected.some((k) => !has(o, k))) return 'missing_key';
  return null;
}

function checkSeverity(v: unknown): v is ConductLevel {
  return typeof v === 'string' && (CONDUCT_LEVELS as readonly string[]).includes(v);
}

function checkRule(v: unknown, active: ReadonlySet<number>): v is number | 'uncovered' | null {
  if (v === null || v === 'uncovered') return true;
  return typeof v === 'number' && Number.isInteger(v) && active.has(v);
}

/** The refs, duplicates collapsed in first-seen order; a code when one was not sent or there are more than five. */
function checkEvidence(v: unknown, sent: ReadonlySet<string>): string[] | string {
  if (!Array.isArray(v)) return 'bad_evidence';
  const out: string[] = [];
  for (const ref of v as unknown[]) {
    if (typeof ref !== 'string' || !sent.has(ref)) return 'bad_evidence';
    if (!out.includes(ref)) out.push(ref);
  }
  return out.length > EVIDENCE_MAX ? 'too_much_evidence' : out;
}

// Domains are matched by a list of unambiguous endings, so "fine.Later" and "no.way" stay plain sentences.
const LINK = new RegExp(
  [
    String.raw`\b(?:https?|ftp)://`,
    String.raw`\bwww\.`,
    String.raw`\b(?:discord(?:app)?\.(?:gg|com)|invite\.gg|t\.me)\b`,
    String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|gg|app|dev|xyz|info|biz|link|club|shop|store|online|site)\b`,
  ].join('|'),
  'i',
);
const ALIAS = /\bP\d+\b/i;
const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const MARKDOWN = [
  /^\s*#{1,6}(?:\s|$)/, // a heading
  /^\s*(?:[-*+>]|\d+\.)\s/, // a list item, a quote
  /`/, // code
  /\*\*|__|~~/, // bold, underline, strike
  /\[[^\]]*\]\([^)]*\)/, // a markdown link
];

function checkSummary(v: unknown): string | { summary: string } {
  if (typeof v !== 'string') return 'bad_summary';
  const summary = v.trim();
  if (summary === '') return 'summary_empty';
  if ([...summary].length > SUMMARY_MAX) return 'summary_too_long';
  if (LINK.test(summary)) return 'summary_link';
  if (ALIAS.test(summary)) return 'summary_alias';
  if (hasControl(summary) || MARKDOWN.some((re) => re.test(summary))) return 'summary_markdown';
  return { summary };
}

/**
 * Validate a model's parsed JSON against the answer shape and against what was sent. Never throws and never echoes the text it
 * rejects: a failure is a fixed `code`. A recommendation to uphold or note whose cited lines include none by the reported person
 * is softened to `unclear` (`code: 'no_own_line'`, still `ok`). `bad_faith` is not a valid verdict.
 * @experimental
 */
export function validateAIOutput(raw: unknown, ctx: AIValidationContext): AIValidation {
  if (!isPlainObject(raw)) return fail('not_object');
  const shape = keysCode(raw, READ_KEYS);
  if (shape) return fail(shape);

  if (!checkSeverity(raw.severity)) return fail('bad_severity');
  if (!checkRule(raw.rule, ctx.activeRules)) return fail('bad_rule');
  const summary = checkSummary(raw.summary);
  if (typeof summary === 'string') return fail(summary);
  const evidence = checkEvidence(raw.evidence, ctx.sent);
  if (typeof evidence === 'string') return fail(evidence);
  if (typeof raw.confidence !== 'string' || !(CONFIDENCES as readonly string[]).includes(raw.confidence)) return fail('bad_confidence');
  if (typeof raw.injectionSuspected !== 'boolean') return fail('bad_injection_flag');

  let recommendation: AIRead['recommendation'] = null;
  let code: 'no_own_line' | undefined;
  const r = raw.recommendation;
  if (r !== null) {
    if (!isPlainObject(r)) return fail('bad_recommendation');
    const recShape = keysCode(r, REC_KEYS);
    if (recShape) return fail(recShape);
    if (r.verdict === 'bad_faith') return fail('bad_faith_verdict');
    if (typeof r.verdict !== 'string' || !(VERDICTS as readonly string[]).includes(r.verdict)) return fail('bad_verdict');
    if (!checkSeverity(r.severity)) return fail('bad_severity');
    if (!checkRule(r.rule, ctx.activeRules)) return fail('bad_rule');
    const recEvidence = checkEvidence(r.evidence, ctx.sent);
    if (typeof recEvidence === 'string') return fail(recEvidence);
    let verdict = r.verdict as (typeof VERDICTS)[number];
    if ((verdict === 'upheld' || verdict === 'noted') && !recEvidence.some((ref) => ctx.ownRefs.has(ref))) {
      verdict = 'unclear';
      code = 'no_own_line';
    }
    recommendation = { verdict, severity: r.severity, rule: r.rule, evidence: recEvidence };
  }

  const read: AIRead = {
    severity: raw.severity,
    rule: raw.rule,
    summary: summary.summary,
    evidence,
    confidence: raw.confidence as AIRead['confidence'],
    injectionSuspected: raw.injectionSuspected,
    recommendation,
  };
  return code ? { ok: true, read, code } : { ok: true, read };
}
