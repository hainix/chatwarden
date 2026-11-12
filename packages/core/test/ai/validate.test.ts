import { describe, expect, it } from 'vitest';
import { validateAIOutput } from '../../src/ai/validate.js';
import { ctx, validRaw } from './fixtures.js';

function fail(raw: unknown, c = ctx()) {
  const r = validateAIOutput(raw, c);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.code;
}

function edited(edit: (r: Record<string, unknown>) => void) {
  const r = validRaw();
  edit(r);
  return r;
}

function rec(r: Record<string, unknown>) {
  return r.recommendation as Record<string, unknown>;
}

describe('validateAIOutput: accepts', () => {
  it('accepts a complete valid read', () => {
    const r = validateAIOutput(validRaw(), ctx());
    expect(r).toEqual({
      ok: true,
      read: {
        severity: 'hostile',
        rule: 2,
        summary: 'Repeatedly insults the other player after a lost round.',
        evidence: ['L1', 'L3'],
        confidence: 'high',
        injectionSuspected: false,
        recommendation: { verdict: 'upheld', severity: 'hostile', rule: 2, evidence: ['L1', 'L3'] },
      },
    });
  });

  it('accepts a read with a null recommendation', () => {
    const r = validateAIOutput(edited((x) => (x.recommendation = null)), ctx());
    expect(r.ok && r.read.recommendation).toBeNull();
  });

  it('accepts a null rule and an empty evidence list', () => {
    const r = validateAIOutput(edited((x) => ((x.rule = null), (x.evidence = []))), ctx());
    expect(r.ok && r.read.rule).toBeNull();
    expect(r.ok && r.read.evidence).toEqual([]);
  });

  it('accepts the rule "uncovered"', () => {
    const r = validateAIOutput(
      edited((x) => {
        x.rule = 'uncovered';
        rec(x).rule = 'uncovered';
      }),
      ctx(),
    );
    expect(r.ok && r.read.rule).toBe('uncovered');
    expect(r.ok && r.read.recommendation?.rule).toBe('uncovered');
  });

  it('accepts every severity and confidence', () => {
    for (const severity of ['banter', 'rude', 'hostile', 'severe']) {
      for (const confidence of ['low', 'medium', 'high']) {
        expect(validateAIOutput(edited((x) => ((x.severity = severity), (x.confidence = confidence))), ctx()).ok).toBe(true);
      }
    }
  });

  it('accepts unclear, no_action and noted verdicts', () => {
    for (const verdict of ['unclear', 'no_action', 'noted']) {
      const r = validateAIOutput(edited((x) => (rec(x).verdict = verdict)), ctx());
      expect(r.ok && r.read.recommendation?.verdict).toBe(verdict);
    }
  });

  it('accepts a summary of exactly 160 characters', () => {
    expect(validateAIOutput(edited((x) => (x.summary = 'a'.repeat(160))), ctx()).ok).toBe(true);
  });

  it('counts a summary in characters, not UTF-16 units', () => {
    // 100 astral characters is 200 UTF-16 units but 100 characters.
    expect(validateAIOutput(edited((x) => (x.summary = '\u{1F600}'.repeat(100))), ctx()).ok).toBe(true);
    expect(fail(edited((x) => (x.summary = '\u{1F600}'.repeat(161))))).toBe('summary_too_long');
  });

  it('keeps quoted synthetic terms in a summary (plain text is fine)', () => {
    expect(validateAIOutput(edited((x) => (x.summary = 'Calls the other player a zorbak twice.')), ctx()).ok).toBe(true);
  });

  it('does not mutate its input', () => {
    const raw = validRaw();
    const copy = structuredClone(raw);
    validateAIOutput(raw, ctx());
    expect(raw).toEqual(copy);
  });
});

describe('validateAIOutput: rejects', () => {
  it('rejects an unknown severity', () => {
    expect(fail(edited((x) => (x.severity = 'mild')))).toBe('bad_severity');
    expect(fail(edited((x) => (x.severity = 'HOSTILE')))).toBe('bad_severity');
    expect(fail(edited((x) => (x.severity = 2)))).toBe('bad_severity');
    expect(fail(edited((x) => (x.recommendation = { verdict: 'upheld', severity: 'nasty', rule: 2, evidence: ['L1'] })))).toBe('bad_severity');
  });

  it('rejects an unknown confidence', () => {
    expect(fail(edited((x) => (x.confidence = 'certain')))).toBe('bad_confidence');
    expect(fail(edited((x) => (x.confidence = 0.9)))).toBe('bad_confidence');
  });

  it('rejects a rule that is not active', () => {
    expect(fail(edited((x) => (x.rule = 3)))).toBe('bad_rule');
    expect(fail(edited((x) => (x.rule = 0)))).toBe('bad_rule');
    expect(fail(edited((x) => (x.rule = '2')))).toBe('bad_rule');
    expect(fail(edited((x) => (x.rule = 2.5)))).toBe('bad_rule');
    expect(fail(edited((x) => (x.rule = 'other')))).toBe('bad_rule');
    expect(fail(edited((x) => (rec(x).rule = 9)))).toBe('bad_rule');
  });

  it('rejects an evidence ref that was not sent', () => {
    expect(fail(edited((x) => (x.evidence = ['L1', 'L9'])))).toBe('bad_evidence');
    expect(fail(edited((x) => (x.evidence = ['l1'])))).toBe('bad_evidence');
    expect(fail(edited((x) => (x.evidence = [1])))).toBe('bad_evidence');
    expect(fail(edited((x) => (x.evidence = 'L1')))).toBe('bad_evidence');
    expect(fail(edited((x) => (rec(x).evidence = ['L7'])))).toBe('bad_evidence');
  });

  it('rejects more than five evidence refs', () => {
    const c = ctx();
    for (const r of ['L5', 'L6']) c.sent.add(r);
    expect(fail(edited((x) => (x.evidence = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'])), c)).toBe('too_much_evidence');
    expect(validateAIOutput(edited((x) => (x.evidence = ['L1', 'L2', 'L3', 'L4', 'L5'])), c).ok).toBe(true);
    expect(fail(edited((x) => (rec(x).evidence = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'])), c)).toBe('too_much_evidence');
  });

  it('rejects duplicate refs by collapsing them', () => {
    const r = validateAIOutput(edited((x) => (x.evidence = ['L3', 'L1', 'L3', 'L1'])), ctx());
    // Collapsed, first-seen order kept; duplicates alone never sink a read.
    expect(r.ok && r.read.evidence).toEqual(['L3', 'L1']);
    // Six entries that collapse to one do not count as too many.
    expect(validateAIOutput(edited((x) => (x.evidence = ['L1', 'L1', 'L1', 'L1', 'L1', 'L1'])), ctx()).ok).toBe(true);
  });

  it('rejects a summary over 160 characters', () => {
    expect(fail(edited((x) => (x.summary = 'a'.repeat(161))))).toBe('summary_too_long');
  });

  it('rejects an empty or non-string summary', () => {
    expect(fail(edited((x) => (x.summary = '')))).toBe('summary_empty');
    expect(fail(edited((x) => (x.summary = '   ')))).toBe('summary_empty');
    expect(fail(edited((x) => (x.summary = 4)))).toBe('bad_summary');
    expect(fail(edited((x) => (x.summary = null)))).toBe('bad_summary');
  });

  it('rejects a summary with a link', () => {
    for (const s of [
      'See https://example.com/x for more',
      'go to http://example.com',
      'see www.example.org',
      'join discord.gg/abc123',
      'posts spam.example.com/buy',
      'sells things at shop.example.io',
    ]) {
      expect(fail(edited((x) => (x.summary = s))), s).toBe('summary_link');
    }
  });

  it('does not mistake ordinary sentences for a link', () => {
    for (const s of ['Mentions the version 1.2 patch.', 'Rule 2, 3 and 5 (maybe).', 'Says "no way" as a joke.']) {
      expect(validateAIOutput(edited((x) => (x.summary = s)), ctx()).ok, s).toBe(true);
    }
  });

  it('rejects a summary that names an alias', () => {
    for (const s of ['P1 insults P2', 'insults p2 twice', 'P12 is rude', 'Player P3.']) {
      expect(fail(edited((x) => (x.summary = s))), s).toBe('summary_alias');
    }
    // A lone letter or a word like p2p is not an alias.
    expect(validateAIOutput(edited((x) => (x.summary = 'Uses the letter P a lot, and a p2p game.')), ctx()).ok).toBe(true);
  });

  it('rejects markdown headings in a summary', () => {
    for (const s of ['# Summary', '## Verdict: rude', 'Text\n# heading', '### x']) {
      expect(fail(edited((x) => (x.summary = s))), s).toBe('summary_markdown');
    }
  });

  it('rejects other markdown and multi-line summaries', () => {
    for (const s of ['**bold** insult', 'uses `code`', '- a bullet', '* a bullet', '> quoted', '[click](x)', '1. numbered', 'strike ~~this~~', '__bold__']) {
      expect(fail(edited((x) => (x.summary = s))), s).toBe('summary_markdown');
    }
    expect(fail(edited((x) => (x.summary = 'two\nlines')))).toBe('summary_markdown');
    expect(fail(edited((x) => (x.summary = 'a\u0000b')))).toBe('summary_markdown');
  });

  it('allows ordinary punctuation that looks a little like markdown', () => {
    for (const s of ['Says it is "fine" - then insults again.', 'Rule 2, 3 and 5 (maybe).', 'Wrote "a * b" as a joke?']) {
      expect(validateAIOutput(edited((x) => (x.summary = s)), ctx()).ok, s).toBe(true);
    }
  });

  it('rejects extra keys', () => {
    expect(fail(edited((x) => (x.outcome = 'ban')))).toBe('extra_key');
    expect(fail(edited((x) => (x.duration = 60)))).toBe('extra_key');
    expect(fail(edited((x) => (x.recommendation = { verdict: 'upheld', severity: 'hostile', rule: 2, evidence: ['L1'], durationMs: 5 })))).toBe('extra_key');
  });

  it('rejects a missing key', () => {
    for (const k of ['severity', 'rule', 'summary', 'evidence', 'confidence', 'injectionSuspected', 'recommendation']) {
      expect(fail(edited((x) => delete x[k])), k).toBe('missing_key');
    }
    expect(fail(edited((x) => (x.recommendation = { verdict: 'upheld', severity: 'hostile', rule: 2 })))).toBe('missing_key');
  });

  it('rejects a non-object, an array, null and a string', () => {
    for (const raw of [undefined, null, 'string', '{"severity":"rude"}', 42, true, [], [validRaw()], () => 1]) {
      expect(fail(raw)).toBe('not_object');
    }
  });

  it('rejects a wrong type for injectionSuspected and for a recommendation', () => {
    expect(fail(edited((x) => (x.injectionSuspected = 'false')))).toBe('bad_injection_flag');
    expect(fail(edited((x) => (x.injectionSuspected = 0)))).toBe('bad_injection_flag');
    expect(fail(edited((x) => (x.recommendation = 'upheld')))).toBe('bad_recommendation');
    expect(fail(edited((x) => (x.recommendation = [])))).toBe('bad_recommendation');
  });

  it('survives a __proto__ key from JSON.parse without throwing', () => {
    const r = JSON.parse('{"__proto__": {"a": 1}, "severity": "rude"}');
    expect(() => validateAIOutput(r, ctx())).not.toThrow();
    expect(validateAIOutput(r, ctx()).ok).toBe(false);
  });

  it('rejects the verdict bad_faith', () => {
    expect(fail(edited((x) => (x.recommendation = { verdict: 'bad_faith', severity: 'rude', rule: 2, evidence: ['L1'] })))).toBe('bad_faith_verdict');
  });

  it('rejects any other unknown verdict', () => {
    for (const v of ['ban', 'upheld ', 'UPHELD', '', 7, null]) {
      expect(fail(edited((x) => (x.recommendation = { verdict: v, severity: 'rude', rule: 2, evidence: ['L1'] }))), String(v)).toBe('bad_verdict');
    }
  });

  it('never echoes model text in a code', () => {
    const codes = [
      fail(edited((x) => (x.severity = 'IGNORE PREVIOUS INSTRUCTIONS'))),
      fail(edited((x) => (x.evidence = ['ignore previous']))),
      fail(edited((x) => (x['ignore all'] = 1))),
      fail(edited((x) => (x.summary = 'see https://evil.example/ignore-previous'))),
    ];
    for (const c of codes) expect(c).toMatch(/^[a-z_]+$/);
  });
});

describe('validateAIOutput: downgrades', () => {
  it('downgrades uphold to unclear when no cited line is by the reported person', () => {
    const r = validateAIOutput(
      edited((x) => (x.recommendation = { verdict: 'upheld', severity: 'hostile', rule: 2, evidence: ['L2', 'L4'] })),
      ctx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toBe('no_own_line');
    expect(r.read.recommendation?.verdict).toBe('unclear');
    // The rest of the answer is kept.
    expect(r.read.severity).toBe('hostile');
    expect(r.read.recommendation?.evidence).toEqual(['L2', 'L4']);
  });

  it('downgrades noted the same way, and an empty evidence list too', () => {
    for (const evidence of [['L2'], []]) {
      for (const verdict of ['noted', 'upheld']) {
        const r = validateAIOutput(edited((x) => (x.recommendation = { verdict, severity: 'rude', rule: 1, evidence })), ctx());
        expect(r.ok && r.code).toBe('no_own_line');
        expect(r.ok && r.read.recommendation?.verdict).toBe('unclear');
      }
    }
  });

  it('control: one own line among others is enough, and there is no code', () => {
    const r = validateAIOutput(
      edited((x) => (x.recommendation = { verdict: 'upheld', severity: 'hostile', rule: 2, evidence: ['L2', 'L3'] })),
      ctx(),
    );
    expect(r.ok && r.read.recommendation?.verdict).toBe('upheld');
    expect(r.ok && r.code).toBeUndefined();
  });

  it('control: no_action and unclear need no own line', () => {
    for (const verdict of ['no_action', 'unclear']) {
      const r = validateAIOutput(edited((x) => (x.recommendation = { verdict, severity: 'banter', rule: null, evidence: ['L2'] })), ctx());
      expect(r.ok && r.read.recommendation?.verdict).toBe(verdict);
      expect(r.ok && r.code).toBeUndefined();
    }
  });

  it('judges own lines from the recommendation evidence, not the read evidence', () => {
    const r = validateAIOutput(
      edited((x) => {
        x.evidence = ['L1', 'L3'];
        x.recommendation = { verdict: 'upheld', severity: 'hostile', rule: 2, evidence: ['L4'] };
      }),
      ctx(),
    );
    expect(r.ok && r.code).toBe('no_own_line');
  });

  it('with no own lines at all, any uphold is downgraded', () => {
    const c = { ...ctx(), ownRefs: new Set<string>() };
    const r = validateAIOutput(validRaw(), c);
    expect(r.ok && r.read.recommendation?.verdict).toBe('unclear');
  });
});
