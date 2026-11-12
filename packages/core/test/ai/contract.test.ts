import { describe, expect, expectTypeOf, it } from 'vitest';
import { AI_PROMPT_VERSION, AIError } from '../../src/ai/types.js';
import type { AIRead, AIReadInput, AIReadResult, AIUsage, ModerationAI } from '../../src/ai/types.js';
import { automationAllowed } from '../../src/ai/ceilings.js';
import type { ConductLevel } from '../../src/types.js';
import * as core from '../../src/index.js';

describe('the AI contract', () => {
  it('has prompt version 1', () => {
    expect(AI_PROMPT_VERSION).toBe(1);
  });

  it('AIError carries a kind and is an Error', () => {
    for (const kind of ['retryable', 'fatal', 'declined', 'timeout'] as const) {
      const e = new AIError(kind, 'boom');
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(AIError);
      expect(e.kind).toBe(kind);
      expect(e.message).toBe('boom');
      expect(e.name).toBe('AIError');
    }
  });

  it('AIError defaults its message to the kind', () => {
    expect(new AIError('fatal').message).toBe('fatal');
  });

  it('automationAllowed returns true for any person', () => {
    expect(automationAllowed('subject-1')).toBe(true);
    expect(automationAllowed('')).toBe(true);
  });

  it('is exported from the package index', () => {
    expect(core.AI_PROMPT_VERSION).toBe(1);
    expect(core.AIError).toBe(AIError);
    expect(typeof core.validateAIOutput).toBe('function');
    expect(typeof core.assertWithinCeilings).toBe('function');
    expect(typeof core.automationAllowed).toBe('function');
    expect(core.AI_MAX_PREFILL_MS).toBe(24 * 3_600_000);
    expect(typeof core.AI_OUTPUT_SCHEMA).toBe('object');
  });

  it('a fake adapter can be written against the interface', async () => {
    const ai: ModerationAI = {
      id: 'fake:one',
      read: async (_input: AIReadInput, options: { signal: AbortSignal }) => {
        void options.signal;
        const usage: AIUsage = { model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 3 };
        return { output: {}, usage };
      },
    };
    const res = await ai.read({} as AIReadInput, { signal: new AbortController().signal });
    expect(res.usage.costMicros).toBe(3);
  });

  it('a result type cannot carry an outcome', () => {
    type Rec = NonNullable<AIRead['recommendation']>;
    // The recommendation names a verdict, a level, a rule and evidence. Never a kind, a duration or an outcome.
    expectTypeOf<keyof Rec>().toEqualTypeOf<'verdict' | 'severity' | 'rule' | 'evidence'>();
    expectTypeOf<keyof AIRead>().toEqualTypeOf<
      'severity' | 'rule' | 'summary' | 'evidence' | 'confidence' | 'injectionSuspected' | 'recommendation'
    >();
    expectTypeOf<keyof AIReadResult>().toEqualTypeOf<'output' | 'usage'>();
    expectTypeOf<Rec['verdict']>().toEqualTypeOf<'upheld' | 'noted' | 'no_action' | 'unclear'>();
    expectTypeOf<Rec['severity']>().toEqualTypeOf<ConductLevel>();
    expectTypeOf<'bad_faith'>().not.toExtend<Rec['verdict']>();
    expectTypeOf<AIRead['confidence']>().toEqualTypeOf<'low' | 'medium' | 'high'>();
    expectTypeOf<AIError['kind']>().toEqualTypeOf<'retryable' | 'fatal' | 'declined' | 'timeout'>();
  });
});
