import { describe, expect, it } from 'vitest';
import { agreementOf, compareSteps } from '../../src/ai/agreement.js';
import type { HumanDecision } from '../../src/ai/agreement.js';
import type { AIRead } from '../../src/ai/types.js';

// agreementOf is pure: the stored read and what the human decided, never what a client says it did (design section 11).

const HOUR = 3_600_000;
const read = (rec: Partial<NonNullable<AIRead['recommendation']>> | null = {}, over: Partial<AIRead> = {}): AIRead => ({
  severity: 'hostile',
  rule: 3,
  summary: 'The reported player insulted others twice.',
  evidence: ['line-a', 'line-b'],
  confidence: 'high',
  injectionSuspected: false,
  recommendation: rec === null ? null : { verdict: 'upheld', severity: 'hostile', rule: 3, evidence: ['line-a'], ...rec },
  ...over,
});
const human = (over: Partial<HumanDecision> = {}): HumanDecision => ({
  verdict: 'upheld',
  rule: 3,
  lineIds: ['line-a'],
  step: { kind: 'chat', durationMs: 24 * HOUR },
  prefill: { kind: 'chat', durationMs: 24 * HOUR },
  oneClick: false,
  ...over,
});

describe('agree', () => {
  it('agree: upheld with upheld and the same rule', () => {
    expect(agreementOf(read(), human())).toEqual({
      agreement: 'agree',
      aiVerdict: 'upheld',
      detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false },
    });
  });

  it('agree with a milder step is outcome milder', () => {
    const a = agreementOf(read(), human({ step: { kind: 'chat', durationMs: HOUR } }));
    expect(a.agreement).toBe('agree');
    expect(a.detail.outcome).toBe('milder');
    expect(agreementOf(read(), human({ step: { kind: 'warning', durationMs: null } })).detail.outcome).toBe('milder');
    expect(agreementOf(read(), human({ step: { kind: 'note', durationMs: null } })).detail.outcome).toBe('milder');
  });

  it('agree with a harsher step is outcome harsher, and still an agree', () => {
    const a = agreementOf(read(), human({ step: { kind: 'ban', durationMs: 7 * 24 * HOUR } }));
    expect(a.agreement).toBe('agree');
    expect(a.detail.outcome).toBe('harsher');
    expect(agreementOf(read(), human({ step: { kind: 'chat', durationMs: 48 * HOUR } })).detail.outcome).toBe('harsher');
  });

  it('agree: no_action with no_action', () => {
    const r = read({ verdict: 'no_action', severity: 'banter', rule: null, evidence: [] });
    const a = agreementOf(r, human({ verdict: 'no_action', rule: null, lineIds: [], step: null, prefill: null }));
    expect(a).toEqual({
      agreement: 'agree',
      aiVerdict: 'no_action',
      detail: { verdict: true, rule: true, lines: 0, outcome: 'same', oneClick: false },
    });
  });

  it('for a no_action the rule means nothing: it is true whatever rule the AI named', () => {
    const r = read({ verdict: 'no_action', severity: 'banter', rule: 2, evidence: [] });
    expect(agreementOf(r, human({ verdict: 'no_action', rule: null, lineIds: [], step: null, prefill: null })).detail.rule).toBe(true);
    expect(agreementOf(r, human({ verdict: 'upheld', rule: 5 })).detail.rule).toBe(true);
  });

  it('upheld and noted are one class: a noted AI against an upheld human agrees, and the reverse', () => {
    expect(agreementOf(read({ verdict: 'noted' }), human()).agreement).toBe('agree');
    expect(agreementOf(read({ verdict: 'upheld' }), human({ verdict: 'noted', step: { kind: 'note', durationMs: null } })).agreement).toBe('agree');
    expect(agreementOf(read({ verdict: 'noted' }), human({ verdict: 'noted', step: { kind: 'note', durationMs: null } })).agreement).toBe('agree');
  });

  it('a rule mismatch with the same verdict is an agree with rule false in detail', () => {
    const a = agreementOf(read(), human({ rule: 5 }));
    expect(a.agreement).toBe('agree');
    expect(a.detail.rule).toBe(false);
    expect(a.detail.verdict).toBe(true);
  });

  it('uncovered matches uncovered; a named rule against none is a mismatch', () => {
    expect(agreementOf(read({ rule: 'uncovered' }), human({ rule: 'uncovered' })).detail.rule).toBe(true);
    expect(agreementOf(read({ rule: null }), human({ rule: 3 })).detail.rule).toBe(false);
    expect(agreementOf(read({ rule: 3 }), human({ rule: null })).detail.rule).toBe(false);
    expect(agreementOf(read({ rule: 'uncovered' }), human({ rule: 3 })).detail.rule).toBe(false);
  });

  it('counts the cited lines the human and the AI share', () => {
    expect(agreementOf(read({ evidence: ['line-a', 'line-b', 'line-c'] }), human({ lineIds: ['line-a', 'line-c', 'line-z'] })).detail.lines).toBe(2);
    expect(agreementOf(read({ evidence: ['line-a'] }), human({ lineIds: [] })).detail.lines).toBe(0);
    // A line listed twice counts once.
    expect(agreementOf(read({ evidence: ['line-a'] }), human({ lineIds: ['line-a', 'line-a'] })).detail.lines).toBe(1);
  });
});

describe('override', () => {
  it('override: upheld against no_action', () => {
    const a = agreementOf(read({ verdict: 'no_action', severity: 'banter', rule: null, evidence: [] }), human());
    expect(a.agreement).toBe('override');
    expect(a.aiVerdict).toBe('no_action');
    expect(a.detail.verdict).toBe(false);
  });

  it('override: no_action against upheld', () => {
    const a = agreementOf(read(), human({ verdict: 'no_action', rule: null, lineIds: [], step: null }));
    expect(a.agreement).toBe('override');
    expect(a.aiVerdict).toBe('upheld');
  });

  it('override: noted against no_action, and no_action against noted', () => {
    expect(agreementOf(read({ verdict: 'noted' }), human({ verdict: 'no_action', step: null })).agreement).toBe('override');
    expect(agreementOf(read({ verdict: 'no_action' }), human({ verdict: 'noted', step: { kind: 'note', durationMs: null } })).agreement).toBe('override');
  });

  it('override: bad_faith, whatever the AI recommended', () => {
    for (const verdict of ['upheld', 'noted', 'no_action'] as const) {
      const a = agreementOf(read({ verdict }), human({ verdict: 'bad_faith', step: null, rule: null }));
      expect(a.agreement).toBe('override');
    }
  });
});

describe('none', () => {
  it('none at level 1: the recommendation was not shown', () => {
    const a = agreementOf(read(), human({ oneClick: true }), 1);
    expect(a).toEqual({
      agreement: 'none',
      aiVerdict: null,
      detail: { verdict: false, rule: false, lines: 0, outcome: 'none', oneClick: false },
    });
  });

  it('none when the recommendation was unclear', () => {
    const a = agreementOf(read({ verdict: 'unclear' }), human());
    expect(a.agreement).toBe('none');
    expect(a.aiVerdict).toBeNull();
  });

  it('none when the read has no recommendation', () => {
    expect(agreementOf(read(null), human()).agreement).toBe('none');
  });

  it('none when no read exists', () => {
    expect(agreementOf(null, human()).agreement).toBe('none');
    expect(agreementOf(null, human({ verdict: 'bad_faith' })).agreement).toBe('none');
  });

  it('none at level 0', () => {
    expect(agreementOf(read(), human(), 0).agreement).toBe('none');
  });
});

describe('what it does not use', () => {
  it('a forged accepted flag does not change agreement (it is only the one-click fact)', () => {
    const a = agreementOf(read(), human({ oneClick: false }));
    const b = agreementOf(read(), human({ oneClick: true }));
    expect(b.agreement).toBe(a.agreement);
    expect(b.detail).toEqual({ ...a.detail, oneClick: true });
    const c = agreementOf(read({ verdict: 'no_action' }), human({ oneClick: true }));
    expect(c.agreement).toBe('override');
    expect(c.detail.oneClick).toBe(false);
  });

  describe('oneClick is the server verdict on whether the pre-fill was accepted as it stood', () => {
    const accept = (h: Partial<HumanDecision>, r: AIRead = read(), level: 0 | 1 | 2 = 2) => agreementOf(r, human({ oneClick: true, ...h }), level).detail.oneClick;

    it('true: the same verdict, rule, kind and length', () => {
      expect(accept({})).toBe(true);
    });
    it('true: the same kind with a shorter length (the moderator trimmed it)', () => {
      expect(accept({ step: { kind: 'chat', durationMs: HOUR } })).toBe(true);
    });
    it('false: a longer length', () => {
      expect(accept({ step: { kind: 'chat', durationMs: 48 * HOUR } })).toBe(false);
    });
    it('false: another kind, milder or harsher', () => {
      expect(accept({ step: { kind: 'warning', durationMs: null } })).toBe(false);
      expect(accept({ step: { kind: 'ban', durationMs: HOUR } })).toBe(false);
    });
    it('false: another rule', () => {
      expect(accept({ rule: 5 })).toBe(false);
    });
    it('false: noted against an upheld pre-fill, though both are agreements', () => {
      expect(accept({ verdict: 'noted', step: { kind: 'note', durationMs: null } })).toBe(false);
    });
    it('true: a no_action accepted as a no_action', () => {
      const r = read({ verdict: 'no_action', severity: 'banter', rule: null, evidence: [] });
      expect(accept({ verdict: 'no_action', rule: null, lineIds: [], step: null, prefill: null }, r)).toBe(true);
    });
    it('false: accepted on an override, a none, and below level 2', () => {
      expect(accept({ verdict: 'no_action', rule: null, step: null })).toBe(false);
      expect(accept({}, read({ verdict: 'unclear' }))).toBe(false);
      expect(accept({}, read(null))).toBe(false);
      expect(accept({}, read(), 1)).toBe(false);
    });
    it('false when the client did not claim it, even for the same decision', () => {
      expect(agreementOf(read(), human({ oneClick: false })).detail.oneClick).toBe(false);
    });
  });

  it('is pure: the inputs are not changed and the same inputs give the same answer', () => {
    const r = read();
    const h = human();
    const before = JSON.stringify([r, h]);
    const first = agreementOf(r, h);
    const second = agreementOf(r, h);
    expect(JSON.stringify([r, h])).toBe(before);
    expect(second).toEqual(first);
  });

  it('with no pre-fill the step is compared with nothing', () => {
    expect(agreementOf(read(), human({ prefill: null, step: { kind: 'chat', durationMs: HOUR } })).detail.outcome).toBe('harsher');
    expect(agreementOf(read({ verdict: 'no_action' }), human({ verdict: 'no_action', step: null, prefill: null })).detail.outcome).toBe('same');
  });
});

describe('comparing steps', () => {
  it('orders none < note < warning < chat by length < area < ban by length < permanent', () => {
    const ladder = [
      null,
      { kind: 'note' as const, durationMs: null },
      { kind: 'warning' as const, durationMs: null },
      { kind: 'chat' as const, durationMs: HOUR },
      { kind: 'chat' as const, durationMs: 24 * HOUR },
      { kind: 'area' as const, durationMs: HOUR },
      { kind: 'ban' as const, durationMs: HOUR },
      { kind: 'ban' as const, durationMs: 30 * 24 * HOUR },
      { kind: 'ban' as const, durationMs: null },
    ];
    for (let i = 0; i < ladder.length; i += 1) {
      for (let j = 0; j < ladder.length; j += 1) {
        expect(Math.sign(compareSteps(ladder[i] ?? null, ladder[j] ?? null))).toBe(Math.sign(i - j));
      }
    }
  });
});
