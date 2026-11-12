import { AIError } from './types.js';
import type { AbortSignalLike, AIRead, AIReadInput, AIReadResult, AIUsage, ModerationAI } from './types.js';

// A scripted ModerationAI for tests and the demo. No network, no key. A script is a function, or a queue of steps used one per call;
// when the queue runs dry the fake reads the case by a simple rule (see `fakeRead`), so a test only scripts what it cares about.

/** One scripted call: an answer (with optional usage), a thrown error, a call that never returns, or the default answer with this usage. */
export type FakeStep =
  | { output: unknown; usage?: Partial<AIUsage> }
  | { error: AIError }
  | { hang: true }
  | { usage: Partial<AIUsage> };

/** What a function script is given. `call` counts from 1. */
export interface FakeCallContext {
  call: number;
  signal: AbortSignalLike;
}

export type FakeScript = readonly FakeStep[] | ((input: AIReadInput, ctx: FakeCallContext) => FakeStep | Promise<FakeStep>);

/** The fake adapter, with what it was asked kept for the test to look at. */
export interface FakeModerationAI extends ModerationAI {
  /** Every input it was called with, oldest first. */
  readonly calls: AIReadInput[];
  /** The abort signal of each call. */
  readonly signals: AbortSignalLike[];
  readonly callCount: number;
  /** Add a step to the end of the queue (a queue script only). */
  push(...steps: FakeStep[]): void;
}

/** Usage of a fake call unless a step says otherwise: 1 000 micro-dollars. */
export const FAKE_USAGE: AIUsage = Object.freeze({
  model: 'fake-1',
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicros: 1000,
});

/**
 * A valid answer for `input`, by a simple rule: nothing by P1 means banter and no action; otherwise P1 was rude, citing the first
 * line P1 wrote, with a recommendation to uphold under the first active rule. Overrides replace fields.
 */
export function fakeRead(input: AIReadInput, over: Partial<AIRead> = {}): AIRead {
  const own = input.lines.filter((l) => l.who === 'P1').map((l) => l.ref);
  const rule: number | 'uncovered' = input.rules[0]?.number ?? 'uncovered';
  const base: AIRead =
    own.length === 0
      ? {
          severity: 'banter',
          rule: null,
          summary: 'Nothing in the lines breaks a rule.',
          evidence: [],
          confidence: 'medium',
          injectionSuspected: false,
          recommendation: { verdict: 'no_action', severity: 'banter', rule: null, evidence: [] },
        }
      : {
          severity: 'rude',
          rule,
          summary: 'The reported player was rude in chat.',
          evidence: [own[0] as string],
          confidence: 'medium',
          injectionSuspected: false,
          recommendation: { verdict: 'upheld', severity: 'rude', rule, evidence: [own[0] as string] },
        };
  return { ...base, ...over };
}

/** The adapter id is what the audit trail shows, so it keeps to the audit actor's characters. */
export function createFakeModerationAI(script: FakeScript = [], opts: { id?: string } = {}): FakeModerationAI {
  const queue: FakeStep[] = typeof script === 'function' ? [] : [...script];
  const calls: AIReadInput[] = [];
  const signals: AbortSignalLike[] = [];
  return {
    id: opts.id ?? 'fake:model',
    calls,
    signals,
    get callCount() {
      return calls.length;
    },
    push: (...steps) => void queue.push(...steps),
    async read(input, options): Promise<AIReadResult> {
      calls.push(input);
      signals.push(options.signal);
      const call = calls.length;
      const step: FakeStep | undefined = typeof script === 'function' ? await script(input, { call, signal: options.signal }) : queue.shift();
      if (step !== undefined && 'error' in step) throw step.error;
      if (step !== undefined && 'hang' in step) {
        // Never answers; settles only when the caller gives up, as a real client does on abort.
        return await new Promise<AIReadResult>((_, reject) => {
          const stop = (): void => reject(new AIError('timeout', 'aborted'));
          if (options.signal.aborted) stop();
          else options.signal.addEventListener('abort', stop, { once: true });
        });
      }
      const usage: AIUsage = { ...FAKE_USAGE, ...(step !== undefined && 'usage' in step ? step.usage : {}) };
      const output = step !== undefined && 'output' in step ? step.output : fakeRead(input);
      return { output, usage };
    },
  };
}
