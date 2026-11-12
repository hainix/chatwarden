// Shared builders for the AI contract tests. Synthetic terms only.

/** A raw model answer that passes validation against `ctx()`. A fresh object each call, so a test may edit it. */
export function validRaw(): Record<string, unknown> {
  return {
    severity: 'hostile',
    rule: 2,
    summary: 'Repeatedly insults the other player after a lost round.',
    evidence: ['L1', 'L3'],
    confidence: 'high',
    injectionSuspected: false,
    recommendation: { verdict: 'upheld', severity: 'hostile', rule: 2, evidence: ['L1', 'L3'] },
  };
}

/** L1..L4 were sent; L1 and L3 are by the reported person; rules 1, 2 and 5 are active. */
export function ctx() {
  return {
    sent: new Set(['L1', 'L2', 'L3', 'L4']),
    activeRules: new Set([1, 2, 5]),
    ownRefs: new Set(['L1', 'L3']),
  };
}
