import type { ConductLevel } from '../types.js';

// The provider-free AI contract (design 2026-11-11, section 3). Core defines the shapes, the prompt, the redaction, the validation
// and the ceilings; an adapter only sends the rendered prompt to a model and returns what came back. Nothing here imports a
// provider SDK, `fetch` or a sanction module: the AI reads and advises, it never acts.

/**
 * The prompt version. Bumped when the prompt or the output schema changes; part of the input hash, so a bump makes every stored
 * read stale. 2 added the full-stop spacing line; 3 added the stable paragraph about signal counts; 4 added the stable paragraph about
 * appeal cautions and corrective examples.
 * @experimental
 */
export const AI_PROMPT_VERSION = 4;

/**
 * One signal count about the reported person (P1), as the model is shown it: the adopter's own short label, whether it counts for or
 * against, how many DIFFERENT players, and over how many days. Nothing else about a signal ever leaves the process.
 * @experimental
 */
export interface AISignal {
  label: string;
  polarity: 'negative' | 'positive';
  distinct: number;
  windowDays: number;
}

/**
 * One speaker in a read: an alias (`P1` is the reported person, `P2` the reporter, the rest `P3...` in order of first appearance)
 * and the part they play. No identifier ever travels with it.
 * @experimental
 */
export interface AIPerson {
  alias: string;
  role: 'reported' | 'reporter' | 'other';
}

/**
 * A pseudonymised casebook example: a decided case, as aliases and redacted lines only (at most 6), with the human's final
 * verdict as its label. It sits in the variable part of the prompt.
 * @experimental
 */
export interface AIExample {
  /**
   * `'corrective'` for a decision a second moderator found wrong on appeal (revoked): shown with fixed wording, as an example of what is
   * NOT a violation. Absent (or `'standard'`) for every other example, and then the example reads exactly as before.
   */
  kind?: 'standard' | 'corrective';
  rule: number | 'uncovered' | null;
  severity: ConductLevel;
  /** What the human settled on. */
  verdict: 'upheld' | 'noted' | 'no_action';
  lines: Array<{ who: string; text: string }>;
}

/**
 * A casebook example as the store hands it over: the {@link AIExample} and its row id. The id never reaches the provider; the read
 * stores the ids of the examples it used (`AIStoredRead.exampleIds`).
 * @experimental
 */
export type AIExampleInput = AIExample & { id: string };

/**
 * Everything an adapter may use to read one report. The lines and the note are already redacted and carry aliases and refs
 * only; no identifier is in here.
 * @experimental
 */
export interface AIReadInput {
  /** Bumped when the prompt or schema changes; part of the cache key and of the invalidation hash. */
  promptVersion: number;
  /** The structured facts, for an adapter that wants to render its own prompt. */
  report: { reason: { id: string; label: string } | null; note: string | null };
  /** `P1` reported, `P2` reporter, `P3...` the rest. */
  people: AIPerson[];
  /** `L1...Ln`, redacted, in time order. */
  lines: Array<{ ref: string; secondsIn: number; who: string; text: string; blocked: boolean; filtered: boolean }>;
  /** The ref the reporter pointed at, or null. */
  reportedLine: string | null;
  /** True when lines were left out of the 40 kept. */
  truncated: boolean;
  /** Active rules only, in number order. */
  rules: Array<{ number: number; title: string; text: string }>;
  levels: Array<{ level: ConductLevel; meaning: string; examples: string[] }>;
  /** `profile.aiContext`. */
  standard: string;
  /** Casebook, at most 2, pseudonymised. */
  examples: AIExample[];
  /**
   * Counts of signals about P1 (`feeds.ai`), a snapshot taken when the read is made; absent with the feed off or nothing to say. Rendered as
   * the last row of `prompt.variable`; the input hash leaves it out.
   */
  signals?: AISignal[];
  /**
   * The rules under which moderators' decisions were often reversed on appeal (the revoke-only rate at the `elevated` or `high` band, over
   * 90 days): rule numbers and bands only, never a number or a person. A snapshot taken when the read is made, rendered as the row after
   * the signal counts; the input hash leaves it out. Absent when appeals are off or no rule qualifies.
   */
  cautions?: Array<{ rule: number; band: 'elevated' | 'high' }>;
  /** The same content rendered by core. An adapter should use it as is. */
  prompt: { stable: string; variable: string; schema: object };
}

/**
 * A read as it is stored: the validated answer plus the ids of the casebook examples that were in its prompt. The examples are not part
 * of the input hash (a growing casebook must not make every stored read look stale), so the read records which ones it saw.
 * @experimental
 */
export interface AIStoredRead extends AIRead {
  exampleIds: string[];
}

/**
 * What an adapter returns. No outcome, no sanction: `output` is the model's JSON, which core validates.
 * @experimental
 */
export interface AIReadResult {
  /** Parsed JSON as the model produced it. Core validates it; the adapter does not need to. */
  output: unknown;
  usage: AIUsage;
}

/**
 * What one call cost. Core only sums it.
 * @experimental
 */
export interface AIUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Integer micro-dollars (1 = $0.000001), computed by the adapter from its own price table. */
  costMicros: number;
}

/**
 * The part of an `AbortSignal` that core and an adapter use, written out so core's published declarations need no DOM or Node lib: a real
 * `AbortSignal` is one. It says whether the call was given up on, and tells a listener once when it is.
 * @experimental
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * Implemented outside core. Runs on the server only. No method may hold or return a credential.
 * @experimental
 */
export interface ModerationAI {
  /** Stable label for audit and logs, e.g. `anthropic:claude-haiku-5-5`. Never a key. */
  readonly id: string;
  read(input: AIReadInput, options: { signal: AbortSignalLike }): Promise<AIReadResult>;
}

/**
 * What an adapter throws. Core never inspects a provider error type.
 * `declined` means the provider refused to answer.
 * @experimental
 */
export class AIError extends Error {
  readonly kind: 'retryable' | 'fatal' | 'declined' | 'timeout';
  constructor(kind: AIError['kind'], message?: string) {
    super(message ?? kind);
    this.name = 'AIError';
    this.kind = kind;
  }
}

/**
 * The validated output core stores and the hub shows. The recommendation never carries an outcome (no kind, no duration): the
 * hub asks the ladder for one. It can never be `bad_faith`.
 * @experimental
 */
export interface AIRead {
  /** banter | rude | hostile | severe, as the profile defines them. */
  severity: ConductLevel;
  /** The Community Rule it falls under. */
  rule: number | 'uncovered' | null;
  /** One line, at most 160 characters, plain text. */
  summary: string;
  /** Line refs, at most 5. */
  evidence: string[];
  confidence: 'low' | 'medium' | 'high';
  /** A line tried to instruct the AI. */
  injectionSuspected: boolean;
  /** Exposed at level 2 only; always computed. */
  recommendation: null | {
    verdict: 'upheld' | 'noted' | 'no_action' | 'unclear';
    severity: ConductLevel;
    rule: number | 'uncovered' | null;
    evidence: string[];
  };
}
