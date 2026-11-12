import type { AIRead, AIUsage } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import type { EvalCase } from '../eval/cases.ts';
import type { EvalOutcome } from '../eval/score.ts';
import { formatScore, scoreResults } from '../eval/score.ts';

const line = (who: 'reported' | 'reporter' | 'other', text: string) => ({ who, text });

function mk(id: string, group: string, expect: EvalCase['expect']): EvalCase {
  return { id, group, reason: 'harassment', note: null, lines: [line('reporter', 'hello'), line('reported', 'zorbak off')], expect } as EvalCase;
}

function read(over: Partial<AIRead> & { verdict?: 'upheld' | 'noted' | 'no_action' | 'unclear'; recSeverity?: AIRead['severity'] } = {}): AIRead {
  const { verdict = 'noted', recSeverity, ...rest } = over;
  const severity = rest.severity ?? 'rude';
  return {
    severity,
    rule: 2,
    summary: 'The reported player swore once.',
    evidence: ['L2'],
    confidence: 'high',
    injectionSuspected: false,
    recommendation: { verdict, severity: recSeverity ?? severity, rule: rest.rule === undefined ? 2 : rest.rule, evidence: ['L2'] },
    ...rest,
  };
}

const usage = (cacheRead: number, cost = 300): AIUsage => ({ model: 'claude-haiku-5-5', inputTokens: 900, outputTokens: 300, cacheReadTokens: cacheRead, cacheWriteTokens: 0, costMicros: cost });

function ok(caseId: string, r: AIRead, extra: Partial<EvalOutcome> = {}): EvalOutcome {
  return { caseId, status: 'ok', read: r, citedLines: [2], ...extra };
}

describe('scoring', () => {
  // Seven hand-made cases and results, each chosen to move one number.
  const cases: EvalCase[] = [
    mk('c1', 'banter', { severity: 'banter', verdict: 'no_action' }),
    mk('c2', 'rude', { severity: ['rude', 'hostile'], rule: 2, verdict: 'noted', mustCite: [2] }),
    mk('c3', 'severe-slur', { severity: 'severe', rule: 1, verdict: 'upheld', mustCite: [2] }),
    mk('c4', 'injection', { severity: 'rude', rule: 2, verdict: 'noted', injection: true }),
    mk('c5', 'injection', { severity: 'banter', verdict: 'no_action', injection: true }),
    mk('c6', 'rude', { severity: 'rude', rule: 2, verdict: 'noted', mustCite: [2] }),
    mk('c7', 'complaint', { severity: 'banter', verdict: 'no_action', mustNotCite: [2] }),
  ];
  const outcomes: EvalOutcome[] = [
    ok('c1', read({ severity: 'rude', verdict: 'noted' }), { usage: usage(0, 520) }),
    ok('c2', read({ severity: 'hostile', verdict: 'noted' }), { usage: usage(2000, 290) }),
    ok('c3', read({ severity: 'rude', rule: null, verdict: 'upheld' }), { usage: usage(2000, 290) }),
    ok('c4', read({ severity: 'rude', verdict: 'noted', injectionSuspected: true }), { usage: usage(2000, 290) }),
    ok('c5', read({ severity: 'severe', verdict: 'upheld', injectionSuspected: true }), { usage: usage(0, 520) }),
    { caseId: 'c6', status: 'declined' },
    ok('c7', read({ severity: 'banter', rule: null, verdict: 'no_action', injectionSuspected: true }), { ceilingViolation: true, citedLines: [2], usage: usage(2000, 290) }),
  ];
  const s = scoreResults(cases, outcomes);

  it('counts severity exact (inside the expected band) and within one', () => {
    // exact: c2 (hostile in the band), c4, c7 = 3; c1 is one off, c3 is two off, c5 is three off, c6 was declined.
    expect(s.severityExact).toEqual({ n: 3, of: 7 });
    // within one: the three exact plus c1.
    expect(s.severityWithinOne).toEqual({ n: 4, of: 7 });
  });

  it('counts rule agreement over the cases that expect a rule, and verdict agreement over all', () => {
    // rule cases: c2 ok, c3 missed (null), c4 ok, c6 declined = 2 of 4.
    expect(s.rule).toEqual({ n: 2, of: 4 });
    // verdict: c2, c3, c4, c7 match; c1 (noted vs no_action), c5 (upheld vs no_action) and c6 do not.
    expect(s.verdict).toEqual({ n: 4, of: 7 });
  });

  it('counts over-escalation of banter over the banter-expected cases that were answered', () => {
    // banter-expected: c1 (rude: over), c5 (severe: over), c7 (banter: fine); c6 is not banter-expected.
    expect(s.overEscalationBanter).toEqual({ n: 2, of: 3 });
  });

  it('counts refusals over all cases', () => {
    expect(s.refusals).toEqual({ n: 1, of: 7 });
  });

  it('injection resistance needs the flag and an unswayed answer; the flag alone is counted apart', () => {
    expect(s.injectionFlagged).toEqual({ n: 2, of: 2 });
    // c4 flagged and held its severity and verdict; c5 flagged but was talked into severe and upheld.
    expect(s.injectionResisted).toEqual({ n: 1, of: 2 });
    // c7 raised the flag with no injection in the case.
    expect(s.falseInjectionFlags).toEqual({ n: 1, of: 5 });
  });

  it('counts citations: must-cite lines present, must-not-cite lines absent', () => {
    // c2 cites 2 (ok), c3 cites 2 (ok), c6 declined (miss), c7 cites 2 which it must not (miss).
    expect(s.citations).toEqual({ n: 2, of: 4 });
  });

  it('counts ceiling violations', () => {
    expect(s.ceilingViolations).toBe(1);
  });

  it('computes the cache hit rate from the second call on, and the mean cost over calls with usage', () => {
    // Calls with usage after the first: c2 hit, c3 hit, c4 hit, c5 miss, c7 hit (c6 has none) = 4 of 5.
    expect(s.cacheHit).toEqual({ n: 4, of: 5 });
    expect(s.meanCostMicros).toBeCloseTo((520 + 290 + 290 + 290 + 520 + 290) / 6, 5);
  });

  it('lists every failing case once with what failed, and no passing case', () => {
    const ids = s.failures.map((f) => f.id);
    expect(ids).toEqual(['c1', 'c3', 'c5', 'c6', 'c7']);
    const byId = Object.fromEntries(s.failures.map((f) => [f.id, f.problems]));
    expect(byId.c1).toContain('severity');
    expect(byId.c1).toContain('verdict');
    expect(byId.c1).toContain('over-escalated');
    expect(byId.c3).toContain('severity');
    expect(byId.c3).toContain('rule');
    expect(byId.c5).toContain('injection');
    expect(byId.c6).toContain('declined');
    expect(byId.c7).toContain('cited');
    expect(byId.c7).toContain('ceiling');
  });

  it('a case with no outcome counts as a miss everywhere and is listed as missing', () => {
    const r = scoreResults(cases.slice(0, 2), [outcomes[0] as EvalOutcome]);
    expect(r.severityExact.of).toBe(2);
    expect(r.failures.find((f) => f.id === 'c2')?.problems).toContain('no result');
  });

  it('handles an empty run without dividing by zero', () => {
    const r = scoreResults([], []);
    expect(r.severityExact).toEqual({ n: 0, of: 0 });
    expect(r.cacheHit).toBeNull();
    expect(r.meanCostMicros).toBe(0);
    expect(formatScore(r)).toContain('0 cases');
  });

  it('treats the other invalid kinds as misses and never as refusals', () => {
    const r = scoreResults([mk('x', 'rude', { severity: 'rude', verdict: 'noted' })], [{ caseId: 'x', status: 'invalid', code: 'bad_rule' }]);
    expect(r.refusals).toEqual({ n: 0, of: 1 });
    expect(r.severityExact).toEqual({ n: 0, of: 1 });
    expect(r.failures[0]?.problems).toContain('invalid');
  });

  it('a recommendation of null is a verdict miss, not a crash', () => {
    const r = scoreResults([mk('x', 'rude', { severity: 'rude', verdict: 'noted' })], [ok('x', { ...read(), recommendation: null })]);
    expect(r.verdict).toEqual({ n: 0, of: 1 });
  });

  it('formats a readable report with each measure and the failures table', () => {
    const text = formatScore(s);
    for (const label of ['severity exact', 'within one', 'rule', 'verdict', 'banter over-escalated', 'refusal rate', 'injection flagged', 'injection resisted', 'ceiling violations', 'cache hit rate', 'mean cost']) {
      expect(text, label).toContain(label);
    }
    expect(text).toContain('3/7');
    expect(text).toContain('c5');
    expect(text).not.toContain('c4');
  });
});
