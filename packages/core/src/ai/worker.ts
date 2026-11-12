import type { AiCallUsage, AiErrorKind, AiReadRow, Clock, ReportRecord, Store } from '../types.js';
import { nextUtcMidnight, startOfUtcDay } from './budget.js';
import type { CallWindow } from './budget.js';
import type { Breaker } from './breaker.js';
import type { Prepared } from './case.js';
import { usedExampleIds } from './prompt.js';
import { validateAIOutput } from './validate.js';
import type { AbortSignalLike, AIExampleInput, AIRead, AIReadInput, AIReadResult, AISignal, AIUsage, ModerationAI } from './types.js';

// One read, start to finish (design section 4). The job reserves the right to call (one atomic write on the store, so two processes
// make one call), checks the budget, the breaker and the rate, calls the adapter under a deadline, validates the answer in core,
// maps line refs back to line ids and stores the result. Every outcome is written; nothing here can fail a report, a queue read or a
// decision, and nothing here can act on a person.

/** A call is allowed this long beyond its deadline before another process may take the read over. */
export const LEASE_SLACK_MS = 15_000;
/** How many calls a read gets in all (the first and two retries). */
export const MAX_ATTEMPTS = 3;
/** The wait after the first failed attempt, then after the second. */
export const RETRY_AFTER_MS: readonly number[] = [60_000, 600_000];
/** A job that lost a race for the breaker's probe or the call window tries again after this. */
const RACE_RETRY_MS = 60_000;
/** What one call is counted as costing while it is in flight, until a real cost is known: 0.1 cent. */
const DEFAULT_ESTIMATE_MICROS = 1000;

/** The store with the AI methods present (checked once, at creation). */
export type AiStore = Store &
  Required<
    Pick<
      Store,
      | 'reserveAiRead'
      | 'completeAiRead'
      | 'failAiRead'
      | 'loadAiRead'
      | 'loadAiReads'
      | 'loadAiReadById'
      | 'loadAiReadFor'
      | 'listAiRetries'
      | 'aiSpendSince'
      | 'insertAiOutcome'
      | 'loadAiOutcome'
      | 'markAiOutcome'
      | 'aiExamples'
      | 'aiTeachableCount'
      | 'aiStats'
    >
  >;

/** The counters of this process: calls in flight, the last cost, tokens for the cache hit rate, invalid answers by code. */
export class Meter {
  inflight = 0;
  lastCostMicros = 0;
  inputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  readonly invalid: Record<string, number> = Object.create(null) as Record<string, number>;

  estimate(): number {
    return Math.max(DEFAULT_ESTIMATE_MICROS, this.lastCostMicros);
  }

  usage(u: AiCallUsage): void {
    this.lastCostMicros = u.costMicros;
    this.inputTokens += u.inputTokens;
    this.cacheReadTokens += u.cacheReadTokens;
    this.cacheWriteTokens += u.cacheWriteTokens;
  }

  invalidCode(code: string): void {
    this.invalid[code] = (this.invalid[code] ?? 0) + 1;
  }

  /** The share of input tokens served from the provider's cache, or null before any call used tokens. */
  cacheHitRate(): number | null {
    const total = this.inputTokens + this.cacheReadTokens + this.cacheWriteTokens;
    return total === 0 ? null : this.cacheReadTokens / total;
  }
}

/** What the worker needs from the service around it. */
export interface WorkerEnv {
  readonly store: AiStore;
  readonly clock: Clock;
  readonly adapter: ModerationAI;
  readonly timeoutMs: number;
  readonly capMicros: number;
  readonly breaker: Breaker;
  readonly window: CallWindow;
  readonly meter: Meter;
  level(): number;
  /** The owner's most calls in a UTC day (`profile.ai.dailyCalls`), read live. */
  dailyCalls(): number;
  closed(): boolean;
  prepare(report: ReportRecord): Prepared;
  /** Casebook examples for this case, newest first; empty when there are none, learning is off or something fails. */
  examplesFor(report: ReportRecord, prepared: Prepared): AIExampleInput[];
  /** The signal counts about the reported person (`feeds.ai`): a snapshot for this read; empty when the feed is off or nothing qualifies. Fenced by the caller. */
  signalsFor(report: ReportRecord): AISignal[];
  /** The rules with an elevated or high revoke-on-appeal rate: a snapshot for this read; empty with appeals off or nothing to say. Fenced by the caller. */
  cautionsFor(): Array<{ rule: number; band: 'elevated' | 'high' }>;
  track(controller: Abortable): void;
  untrack(controller: Abortable): void;
  /** The `ai.read` audit row for a terminal outcome. Fenced by the caller. */
  auditRead(reportId: string): void;
  warn(event: string, detail?: Record<string, string | number | boolean>): void;
}

const errName = (err: unknown): string => {
  try {
    return err instanceof Error ? err.name : typeof err;
  } catch {
    return 'unknown';
  }
};

type CallKind = 'retryable' | 'fatal' | 'declined' | 'timeout';
const CALL_KINDS: readonly string[] = ['retryable', 'fatal', 'declined', 'timeout'];

/** The kind of an error an adapter threw. A copy of core's AIError is recognised by shape; anything else is retryable. */
function kindOf(err: unknown, ours: boolean): CallKind {
  try {
    const kind = (err as { name?: unknown; kind?: unknown } | null)?.kind;
    const name = (err as { name?: unknown } | null)?.name;
    if (name === 'AIError' && typeof kind === 'string' && CALL_KINDS.includes(kind)) return kind as CallKind;
  } catch {
    // A hostile error object: fall through.
  }
  return ours ? 'timeout' : 'retryable';
}

/** What the worker needs of an `AbortController` to give a call up. */
export interface Abortable {
  abort(): void;
}

/** `promise`, or a timeout error as soon as the signal aborts, whichever comes first. The loser is never left unhandled. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignalLike): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AIError', kind: 'timeout' }));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** The usage an adapter reported, made safe to store: a model name of at most 100 characters, whole non-negative numbers. */
function safeUsage(u: Partial<AIUsage> | undefined, latencyMs: number): AiCallUsage {
  return {
    model: typeof u?.model === 'string' && u.model !== '' ? u.model.slice(0, 100) : 'unknown',
    inputTokens: count(u?.inputTokens),
    outputTokens: count(u?.outputTokens),
    cacheReadTokens: count(u?.cacheReadTokens),
    cacheWriteTokens: count(u?.cacheWriteTokens),
    costMicros: typeof u?.costMicros === 'number' && Number.isFinite(u.costMicros) && u.costMicros > 0 ? Math.round(u.costMicros) : 0,
    latencyMs: Math.max(0, Math.floor(latencyMs)),
  };
}

/** Until when the sweeper should leave a report alone, given the row a reserve found: null (nothing to wait for) for a finished read. */
export function parkOf(row: AiReadRow, now: number): number | null {
  switch (row.status) {
    case 'ok':
      return null;
    case 'pending':
      return row.leaseUntil ?? now + RACE_RETRY_MS;
    case 'failed':
    case 'skipped':
      return row.retryAt ?? Number.POSITIVE_INFINITY;
    default:
      // declined, invalid: final for this input.
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * A row that ended without an answer and will not be tried again by itself (declined, invalid twice, fatal, given up): the only kind of
 * row a moderator's explicit "read again" may retake, once (the row's `retaken` marker). A row waiting for its own retry is not final, and
 * neither is a skipped one: it made no call and gave its attempt back, so an explicit ask simply takes it (no marker).
 */
export function isFinalRow(row: AiReadRow): boolean {
  return row.status === 'declined' || row.status === 'invalid' || (row.status === 'failed' && row.retryAt === null);
}

/** How a job ended. `park` is the time (epoch ms, possibly Infinity) before which the sweeper should not queue the report again, or null when there is nothing to wait for. */
export interface ReadEnd {
  park: number | null;
}

const NOTHING: ReadEnd = { park: null };

/**
 * Read one report. `opts.retake` is a moderator's explicit ask: a FINAL row (see {@link isFinalRow}) that has not been retaken is taken over once
 * more (and the call is charged and audited like any other). Throws only on a store failure; the caller fences it.
 */
export async function runRead(env: WorkerEnv, reportId: string, opts?: { retake?: boolean }): Promise<ReadEnd> {
  if (env.level() === 0 || env.closed()) return NOTHING;
  const report = env.store.loadReport(reportId);
  if (report === null || report.status !== 'open') return NOTHING;

  // Cheap refusals first, before anything is written: an unavailable breaker (open, or half-open with its probe out) or a full
  // minute leaves no row behind.
  const now = env.clock.now();
  if (!env.breaker.available() || !env.window.peek(now)) return NOTHING;

  const prepared = env.prepare(report);
  const reserved = env.store.reserveAiRead(
    { reportId, inputHash: prepared.hash, promptVersion: prepared.input.promptVersion, adapter: env.adapter.id },
    now + env.timeoutMs + LEASE_SLACK_MS,
    now,
    opts?.retake === true ? { retake: true } : undefined,
  );
  if (!reserved.reserved) {
    return { park: parkOf(reserved.existing, now) };
  }
  const { id, lease } = reserved;

  // The daily caps. Money: what is stored for today, plus what the calls in flight here are estimated to cost. Calls: the owner's
  // ceiling, which holds even for an adapter that reports no cost (the count includes this reservation).
  const today = env.store.aiSpendSince(startOfUtcDay(now));
  if (today.micros + env.meter.inflight * env.meter.estimate() >= env.capMicros || today.calls > env.dailyCalls()) {
    const resume = nextUtcMidnight(now);
    env.store.failAiRead(id, lease, 'skipped', 'budget', resume);
    return { park: resume };
  }

  const gate = env.breaker.gate();
  if (gate === 'no' || !env.window.tryTake(now)) {
    if (gate === 'probe') env.breaker.release();
    const again = now + RACE_RETRY_MS;
    env.store.failAiRead(id, lease, 'skipped', 'retryable', again);
    return { park: again };
  }

  let examples: AIExampleInput[] = [];
  try {
    examples = env.examplesFor(report, prepared);
  } catch (err) {
    env.warn('ai.examples_failed', { error: errName(err) });
  }
  let signals: AISignal[] = [];
  try {
    signals = env.signalsFor(report);
  } catch (err) {
    env.warn('ai.signals_failed', { error: errName(err) });
  }
  let cautions: Array<{ rule: number; band: 'elevated' | 'high' }> = [];
  try {
    cautions = env.cautionsFor();
  } catch (err) {
    env.warn('ai.cautions_failed', { error: errName(err) });
  }
  let input: AIReadInput = prepared.input;
  let exampleIds: string[] = [];
  try {
    if (examples.length > 0 || signals.length > 0 || cautions.length > 0) {
      input = prepared.build(examples, signals, cautions);
      exampleIds = usedExampleIds(examples);
    }
  } catch (err) {
    env.warn('ai.examples_failed', { error: errName(err) });
  }

  // The call, under a hard deadline.
  const controller = new AbortController();
  env.track(controller);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, env.timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  env.meter.inflight += 1;
  const startedAt = env.clock.now();
  let result: AIReadResult | undefined;
  let thrown: unknown;
  let failed = false;
  try {
    result = await raceAbort(Promise.resolve(env.adapter.read(input, { signal: controller.signal })), controller.signal);
  } catch (err) {
    failed = true;
    thrown = err;
  } finally {
    clearTimeout(timer);
    env.untrack(controller);
    env.meter.inflight -= 1;
  }
  // The service is closing: the store may already be going away. The lease runs out and the read is taken up later.
  if (env.closed()) return NOTHING;
  const latency = env.clock.now() - startedAt;

  if (failed) return settleFailure(env, { id, lease, reportId, hash: prepared.hash, kind: kindOf(thrown, timedOut) });

  const usage = safeUsage((result as { usage?: Partial<AIUsage> } | null)?.usage, latency);
  env.meter.usage(usage);

  let verdict: ReturnType<typeof validateAIOutput>;
  try {
    verdict = validateAIOutput((result as { output?: unknown } | null)?.output, {
      sent: prepared.refs,
      activeRules: prepared.activeRules,
      ownRefs: prepared.ownRefs,
    });
  } catch {
    verdict = { ok: false, code: 'unreadable' };
  }
  if (!verdict.ok) {
    // Paid for, and counted in the spend, although there is no read. A model's malformed or truncated answer is not deterministic,
    // so the first one is tried again once (a minute later); a second is final.
    env.meter.invalidCode(verdict.code);
    env.breaker.success();
    if (lease < 2) {
      const retryAt = env.clock.now() + (RETRY_AFTER_MS[0] ?? RACE_RETRY_MS);
      env.store.failAiRead(id, lease, 'failed', 'invalid', retryAt, usage);
      return { park: retryAt };
    }
    if (env.store.failAiRead(id, lease, 'invalid', 'invalid', null, usage)) env.auditRead(reportId);
    return { park: Number.POSITIVE_INFINITY };
  }

  const toIds = (refs: readonly string[]): string[] => refs.flatMap((ref) => {
    const lineId = prepared.idOf.get(ref);
    return lineId === undefined ? [] : [lineId];
  });
  const injected = verdict.read.injectionSuspected || prepared.injection;
  const rec = verdict.read.recommendation;
  const read: AIRead = {
    ...verdict.read,
    evidence: toIds(verdict.read.evidence),
    // A line that tried to instruct the AI makes the whole read low confidence, whatever the model said.
    confidence: injected ? 'low' : verdict.read.confidence,
    injectionSuspected: injected,
    recommendation: rec === null ? null : { ...rec, evidence: toIds(rec.evidence) },
  };
  env.breaker.success();
  const stored = env.store.completeAiRead(id, lease, { ...usage, read, exampleIds, signals: input.signals ?? [] });
  if (!stored) {
    env.warn('ai.read_superseded');
    return NOTHING;
  }
  env.auditRead(reportId);
  return NOTHING;
}

/** An adapter failure: retry on the schedule, or give up (and say so once). */
function settleFailure(env: WorkerEnv, f: { id: string; lease: number; reportId: string; hash: string; kind: CallKind }): ReadEnd {
  const { id, lease, reportId, kind } = f;
  const final: ReadEnd = { park: Number.POSITIVE_INFINITY };
  if (kind === 'declined') {
    // A refusal is an answer: stored, not retried, and the provider is up.
    env.breaker.success();
    if (env.store.failAiRead(id, lease, 'declined', 'declined', null)) env.auditRead(reportId);
    return final;
  }
  const errorKind: AiErrorKind = kind;
  if (kind === 'fatal') {
    env.breaker.failure(true);
    if (env.store.failAiRead(id, lease, 'failed', errorKind, null)) env.auditRead(reportId);
    return final;
  }
  env.breaker.failure();
  if (lease >= MAX_ATTEMPTS) {
    // Three calls in all: given up.
    if (env.store.failAiRead(id, lease, 'failed', errorKind, null)) env.auditRead(reportId);
    return final;
  }
  const retryAt = env.clock.now() + (RETRY_AFTER_MS[lease - 1] ?? RETRY_AFTER_MS[RETRY_AFTER_MS.length - 1] ?? RACE_RETRY_MS);
  env.store.failAiRead(id, lease, 'failed', errorKind, retryAt);
  return { park: retryAt };
}
