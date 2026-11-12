import { AIError, validateAIOutput } from '@chatwarden/core';
import type { ModerationAI } from '@chatwarden/core';
import { prepare } from './cases.ts';
import type { EvalCase } from './cases.ts';
import type { EvalOutcome } from './score.ts';

/**
 * One case through the real core pipeline and an adapter: choose and redact the lines, render the prompt, call the adapter, validate
 * the answer. Never throws; every failure is an outcome the score counts.
 */
export async function runCase(ai: ModerationAI, c: EvalCase, signal: AbortSignal): Promise<EvalOutcome> {
  const p = prepare(c);
  try {
    const result = await ai.read(p.input, { signal });
    const v = validateAIOutput(result.output, p.ctx);
    if (!v.ok) return { caseId: c.id, status: 'invalid', code: v.code, usage: result.usage, ceilingViolation: v.code === 'bad_faith_verdict' };
    const refs = [...v.read.evidence, ...(v.read.recommendation?.evidence ?? [])];
    const cited = [...new Set(refs.map((r) => p.lineNumber(r)).filter((n): n is number => n !== null))];
    // `no_own_line`: the model upheld or noted without citing a line by the reported person. Core softened it, but it broke the ceiling.
    return { caseId: c.id, status: 'ok', read: v.read, citedLines: cited, usage: result.usage, ceilingViolation: v.code === 'no_own_line' };
  } catch (e) {
    const kind = e instanceof AIError ? e.kind : 'retryable';
    return { caseId: c.id, status: kind === 'declined' ? 'declined' : 'failed', code: kind };
  }
}
