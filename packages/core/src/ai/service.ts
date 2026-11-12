import type { AuditRecordInput } from '../audit.js';
import type { Subscribe } from '../events.js';
import type { Suggestion } from '../ladder.js';
import { errorClass, safeWarn } from '../log.js';
import type { ResolvedProfile } from '../profile.js';
import { AI_DAILY_CALLS_DEFAULT } from '../profile.js';
import { suggestedRule } from '../reporting.js';
import type { CommunityRules, RuleRef } from '../rules.js';
import { CONDUCT_LEVELS } from '../types.js';
import type { AiReadRow } from '../types.js';
import type { AiOutcomeInsert, AiVerdict, Clock, ConductLevel, Logger, ReportRecord, SanctionKind, Store, SubjectId } from '../types.js';
import { agreementOf } from './agreement.js';
import type { StepLike } from './agreement.js';
import { Breaker } from './breaker.js';
import { CallWindow, startOfUtcDay, utcDayLabel } from './budget.js';
import { prepareCase } from './case.js';
import type { Prepared } from './case.js';
import { assertWithinCeilings, AICeilingError } from './ceilings.js';
import { actionsOnTarget, AI_EXAMPLES_MIN, pickExampleLines } from './casebook.js';
import type { AiOutcomeArgs } from './casebook.js';
import { aiPolicyText } from './prompt.js';
import { sha256Hex } from '../crypto.js';
import type { AIExampleInput, AIRead, ModerationAI } from './types.js';
import { isFinalRow, Meter, runRead } from './worker.js';
import type { AiStore, ReadEnd, WorkerEnv } from './worker.js';

// The AI service (design sections 4 and 6): listens for new reports and only enqueues; a small worker pool reads them off the ack
// path; a sweeper fills the gaps; the facade (`cw.ai`) answers the hub. Everything fails soft: any error here is logged by class and
// the caller gets what it would get with the AI off. This module never imports a sanction module: the AI advises, it cannot act.

/**
 * What the code decides about the AI. The adapter and the ceilings on level and spend are code, never the hub's.
 * @experimental
 */
export interface AiOptions {
  /** The model behind the reads. Runs on the server only. */
  adapter: ModerationAI;
  /** The highest level the hub may switch to. Default 2. */
  maxLevel?: 1 | 2;
  /** The most the AI may spend in a UTC day, in micro-dollars (1 = $0.000001). Default 1 000 000 ($1.00). Set in code: a hub cannot raise it. */
  dailyBudgetMicros?: number;
  /** The most calls in any minute. Default 30. */
  perMinuteCalls?: number;
  /** The most reads in flight at once. Default 2. */
  concurrency?: number;
  /** The hard deadline for one call, in milliseconds. Default 30 000. */
  timeoutMs?: number;
  /**
   * `'raw'` (default) sends a line the filter touched (blocked, or starred in the room) as typed: the model needs the words to judge
   * intent. `'mask'` sends it masked instead (a starred line as the room saw it, a blocked line as stars). Read the adapter's README
   * before leaving the default: the provider receives abusive text.
   */
  blockedLines?: 'raw' | 'mask';
  /** Reserved. No room tag, and no tag value, is ever sent to a provider in this release. */
  contextTags?: string[];
}

/** Where the AI stands, for Settings. */
export interface AiStatus {
  /** An adapter is configured. */
  available: boolean;
  /** The effective level: the lower of the hub's setting and `maxLevel`; 0 without an adapter. */
  level: 0 | 1 | 2;
  maxLevel: 0 | 1 | 2;
  state: 'ok' | 'paused_budget' | 'unavailable' | 'off';
  /** Today's spend (UTC), in micro-dollars, from the store. */
  spentMicros: number;
  capMicros: number;
  /** The owner's ceiling on calls in a UTC day (`profile.ai.dailyCalls`); `reads` is counted against it. */
  capCalls: number;
  /** The UTC day the spend is for, `YYYY-MM-DD`. */
  day: string;
  /** Calls made today (UTC), from the store. */
  reads: number;
  /** The share of input tokens the provider served from its cache, over the calls this process made; null before any. */
  cacheHitRate: number | null;
  /** Answers core refused, by validator code, since this process started. Codes only, never text. */
  invalid: Record<string, number>;
}

/** What the queue carries for a report: no summary, no line ids. */
export interface AiBrief {
  severity: ConductLevel;
  confidence: AIRead['confidence'];
  rule: number | 'uncovered' | null;
  /** The read was made from older rules or an older version of the case. */
  stale: boolean;
  injectionSuspected: boolean;
  /** Level 2 and a recommendation that is not `unclear`. */
  hasRecommendation: boolean;
}

/** The step the ladder gives for the AI's conduct level: what a one-click accept may fill. */
export interface SuggestionStep {
  kind: SanctionKind;
  durationMs: number | null;
  label: string;
}

/** A stored read as the case page shows it. */
export interface AiReadView {
  /** The read's id: what a decision echoes back. */
  id: string;
  severity: ConductLevel;
  rule: number | 'uncovered' | null;
  summary: string;
  /** Real line ids, at most 5. */
  evidenceLineIds: string[];
  confidence: AIRead['confidence'];
  /** From older rules, or from an older version of the case. */
  stale: boolean;
  injectionSuspected: boolean;
  model: string | null;
  /** When the read was started, epoch ms. */
  at: number;
  /** Level 2 only. */
  recommendation: null | {
    verdict: 'upheld' | 'noted' | 'no_action' | 'unclear';
    severity: ConductLevel;
    rule: number | 'uncovered' | null;
    evidenceLineIds: string[];
    /** `cw.suggest` for the AI's conduct level, now; null when it names no action. */
    step: SuggestionStep | null;
    /** `step` is within the ceilings (a warning, a note or a restriction of at most 24 hours, with a line by the reported person cited). */
    stepWithinCeiling: boolean;
  };
}

/** The casebook counts for one rule. */
export interface AiStatsRuleView {
  rule: number | 'uncovered' | null;
  decided: number;
  agree: number;
  override: number;
  none: number;
  falsePositives: number;
  /** Decisions that were a one-click accept of the AI's pre-fill. */
  oneClick: number;
}

/** The casebook, overall and per rule. */
export interface AiStatsView {
  since: number;
  decided: number;
  agree: number;
  override: number;
  none: number;
  falsePositives: number;
  oneClick: number;
  /** agree / (agree + override); null with neither. */
  agreementRate: number | null;
  /** falsePositives / (agree + override); null with neither. */
  falsePositiveRate: number | null;
  /** oneClick / (agree + override): how often a shown recommendation was accepted as it stood; null with none shown. */
  oneClickRate: number | null;
  rules: AiStatsRuleView[];
}

/** What `cw.ai.readAgain` answers. */
export type AiReadAgain =
  | AiReadView
  | 'pending'
  | 'budget'
  | 'off'
  | 'rate'
  /** The read for this input ended without an answer and a moderator already retook it once: there is nothing more to ask. */
  | 'final'
  /** The breaker is open or the call window is full: nothing can be called for `retryAfterMs`. */
  | { unavailable: { retryAfterMs: number } };

/**
 * `cw.ai`. Every method is safe to call at any time: with the AI off, without an adapter or with a failing provider or store it
 * answers as if there were no AI (null, an empty map, `'off'`), and never throws.
 * @experimental
 */
export interface AiFacade {
  /** The effective level now. */
  level(): 0 | 1 | 2;
  status(): AiStatus;
  /**
   * The newest finished read of a report as the case page shows it, or null. At level 0 nothing is read from the store. With
   * `open: true` (the case page) a report with no read, or a stale one, is queued for a (re)read.
   */
  read(reportId: string, opts?: { open?: boolean }): AiReadView | null;
  /**
   * "Read again": the stored read when the input has not changed (no call), else a call is queued and the answer is `'pending'`.
   * `'off'` at level 0 or for a report that is gone or decided, `'budget'` at the daily money or call cap, `'rate'` once `actor` has
   * asked 10 times in a minute (counted in this process; every answer below uses an ask), `{ unavailable }` while the breaker is open or
   * the call window is full, and `'final'` when the read for this input ended without an answer (declined, invalid twice, fatal, given
   * up) and an explicit ask has already retaken it once. The first explicit ask on such a row retakes it (`'pending'`): it is charged
   * to the spend and audited like any other read.
   */
  readAgain(reportId: string, actor: string): Promise<AiReadAgain>;
  /** The queue's brief of each report that has a read. Reports without one are absent. */
  briefs(reportIds: readonly string[]): Map<string, AiBrief>;
  /** The casebook counts for decisions at or after `since` (default: the last 30 days). */
  stats(q?: { since?: number }): AiStatsView;
  /**
   * The one function the appeals inbox calls when a decision is reversed (a granted appeal, a take-back): the report's casebook row can
   * never teach again, loses its example text, and counts as an AI false positive when the AI had recommended action. True when the
   * report has a row.
   */
  markReversed(reportId: string): boolean;
  /** A senior's "don't teach" mark on a decided case: the row can never teach again and loses its example text. True when the report has a row. */
  dontTeach(reportId: string): boolean;
  /** Resolves when no read is queued or running (tests, graceful shutdown). */
  idle(): Promise<void>;
  /** Run the sweeper once. The timer does this every 60 seconds. */
  sweep(): Promise<void>;
  /** Stop the sweeper and abort the calls in flight. `cw.close()` does this. */
  close(): void;
}

/** How often the sweeper runs. */
export const SWEEP_EVERY_MS = 60_000;
/** The most reports one sweep queues. */
export const SWEEP_BATCH = 20;
/** The most stale reads one idle sweep queues. */
export const STALE_PER_SWEEP = 5;
/** How many times one moderator may ask for a read again in a minute. */
export const READ_AGAIN_PER_MINUTE = 10;
/** The most reports the sweeper remembers as not to be queued (and the most final reads it remembers). */
export const PARKED_MAX = 2000;
/** How many recent open reports a sweep looks at. */
const SWEEP_SCAN = 200;
/** The audit trail takes an actor of at most 128 characters of `A-Za-z0-9_.:@+-`. */
const ACTOR_MAX = 128;
const PREPARED_CACHE_MAX = 500;
const STATS_DEFAULT_WINDOW_MS = 30 * 24 * 3_600_000;

const DEFAULTS = { maxLevel: 2, dailyBudgetMicros: 1_000_000, perMinuteCalls: 30, concurrency: 2, timeoutMs: 30_000 } as const;

/** The audit actor for the AI: `ai:` and the adapter's id with every character the trail refuses made an underscore, cut to fit. */
export function aiActorOf(adapterId: string): string {
  const id = String(adapterId).replace(/[^A-Za-z0-9_.:@+-]/gu, '_').slice(0, ACTOR_MAX - 'ai:'.length);
  return `ai:${id === '' ? 'adapter' : id}`;
}

const REQUIRED_STORE_METHODS = [
  'reserveAiRead',
  'completeAiRead',
  'failAiRead',
  'loadAiRead',
  'loadAiReads',
  'loadAiReadById',
  'loadAiReadFor',
  'listAiRetries',
  'aiSpendSince',
  'insertAiOutcome',
  'loadAiOutcome',
  'markAiOutcome',
  'aiExamples',
  'aiTeachableCount',
  'aiStats',
] as const;

/** The store, typed with its AI methods; throws a plain error when it has not got them. */
export function requireAiStore(store: Store): AiStore {
  const missing = REQUIRED_STORE_METHODS.filter((m) => typeof (store as unknown as Record<string, unknown>)[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(`createChatwarden: the AI needs a store with the AI methods (${missing.join(', ')}); use the memory or SQLite store, or leave the "ai" option out`);
  }
  return store as AiStore;
}

/** Check the AI option and the store before anything is started: throws a plain error for a bad option or a store without the AI methods. */
export function checkAiSetup(store: Store, options: AiOptions): void {
  checkOptions(options);
  requireAiStore(store);
}

function checkOptions(o: AiOptions): Required<Omit<AiOptions, 'adapter' | 'contextTags'>> & { contextTags: string[] } {
  const a: unknown = o?.adapter;
  if (typeof a !== 'object' || a === null || typeof (a as ModerationAI).id !== 'string' || (a as ModerationAI).id === '' || typeof (a as ModerationAI).read !== 'function') {
    throw new TypeError('createChatwarden: ai.adapter must be a ModerationAI ({ id, read })');
  }
  const maxLevel = o.maxLevel ?? DEFAULTS.maxLevel;
  if (maxLevel !== 1 && maxLevel !== 2) throw new RangeError('createChatwarden: ai.maxLevel must be 1 or 2');
  const whole = (v: unknown, name: string, min: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < min) throw new RangeError(`createChatwarden: ai.${name} must be a whole number of at least ${min}`);
    return v;
  };
  const dailyBudgetMicros = whole(o.dailyBudgetMicros ?? DEFAULTS.dailyBudgetMicros, 'dailyBudgetMicros', 0);
  const perMinuteCalls = whole(o.perMinuteCalls ?? DEFAULTS.perMinuteCalls, 'perMinuteCalls', 1);
  const concurrency = whole(o.concurrency ?? DEFAULTS.concurrency, 'concurrency', 1);
  const timeoutMs = whole(o.timeoutMs ?? DEFAULTS.timeoutMs, 'timeoutMs', 1);
  const blockedLines = o.blockedLines ?? 'raw';
  if (blockedLines !== 'raw' && blockedLines !== 'mask') throw new RangeError("createChatwarden: ai.blockedLines must be 'raw' or 'mask'");
  const contextTags = o.contextTags ?? [];
  if (!Array.isArray(contextTags) || contextTags.some((t) => typeof t !== 'string')) throw new TypeError('createChatwarden: ai.contextTags must be a list of strings');
  return { maxLevel, dailyBudgetMicros, perMinuteCalls, concurrency, timeoutMs, blockedLines, contextTags: [...contextTags] };
}

/** What the service needs from the kit around it. */
export interface AiServiceDeps {
  options: AiOptions;
  store: Store;
  clock: Clock;
  logger: Logger | undefined;
  /** The profile in force now (never kept across calls). */
  profile: () => ResolvedProfile;
  rules: CommunityRules;
  /** `cw.suggest`. */
  suggest: (subject: SubjectId, level: ConductLevel | null, rule: RuleRef, ctx: { roomId: string | null }) => Suggestion;
  subscribe: Subscribe;
  /** `cw.audit.record`. */
  audit: (input: AuditRecordInput) => boolean;
  /** How long the text of a casebook example is kept (`retention.aiExamplesMs`); 0 keeps none. */
  exampleRetentionMs: () => number;
}

/** The facade when no AI is configured: always off, never touches the store. */
export function createInertAi(): AiFacade {
  const status: AiStatus = { available: false, level: 0, maxLevel: 0, state: 'off', spentMicros: 0, capMicros: 0, capCalls: 0, day: '', reads: 0, cacheHitRate: null, invalid: {} };
  return {
    level: () => 0,
    status: () => ({ ...status, invalid: {} }),
    read: () => null,
    readAgain: () => Promise.resolve('off'),
    briefs: () => new Map(),
    stats: (q) => emptyStats(q?.since ?? 0),
    markReversed: () => false,
    dontTeach: () => false,
    idle: () => Promise.resolve(),
    sweep: () => Promise.resolve(),
    close: () => undefined,
  };
}

const emptyStats = (since: number): AiStatsView => ({ since, decided: 0, agree: 0, override: 0, none: 0, falsePositives: 0, oneClick: 0, agreementRate: null, falsePositiveRate: null, oneClickRate: null, rules: [] });

const ruleOfText = (rule: string | null): number | 'uncovered' | null => (rule === null ? null : /^\d+$/.test(rule) ? Number(rule) : rule === 'uncovered' ? 'uncovered' : null);

/** A suggestion's outcome as a step: a note, a warning or a restriction; none is no step. */
function stepOf(s: Suggestion): SuggestionStep | null {
  const o = s.outcome;
  if (o === 'none') return null;
  if (o === 'note' || o === 'warning') return { kind: o, durationMs: null, label: s.label };
  return { kind: o.kind, durationMs: o.durationMs, label: s.label };
}

export class AiService implements AiFacade {
  protected readonly store: AiStore;
  protected readonly clock: Clock;
  protected readonly adapter: ModerationAI;
  protected readonly actor: string;
  protected readonly opts: ReturnType<typeof checkOptions>;
  protected readonly meter = new Meter();
  protected readonly breaker: Breaker;
  protected readonly window: CallWindow;

  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly running = new Map<string, { dirty: boolean }>();
  private readonly parked = new Map<string, number>();
  private readonly retakes = new Set<string>();
  private readonly controllers = new Set<{ abort(): void }>();
  private readonly cache = new Map<string, Prepared>();
  private readonly asked = new Map<string, number[]>();
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private waiters: Array<() => void> = [];
  private lastStable = '';
  private stableKey = '';
  private isClosed = false;

  protected readonly deps: AiServiceDeps;

  constructor(deps: AiServiceDeps) {
    this.deps = deps;
    this.store = requireAiStore(deps.store);
    this.clock = deps.clock;
    this.opts = checkOptions(deps.options);
    this.adapter = deps.options.adapter;
    this.actor = aiActorOf(this.adapter.id);
    this.breaker = new Breaker(deps.clock);
    this.window = new CallWindow(this.opts.perMinuteCalls);
    // Only enqueue: no await, no store read, so the player's ack never waits for the AI.
    this.unsubscribe = deps.subscribe('report.created', (e) => {
      this.enqueue(e.reportId);
    });
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  // --- the facade ------------------------------------------------------------------------------------------------------------

  level(): 0 | 1 | 2 {
    try {
      return Math.min(this.deps.profile().ai.level, this.opts.maxLevel) as 0 | 1 | 2;
    } catch (err) {
      this.warn('ai.level_failed', err);
      return 0;
    }
  }

  status(): AiStatus {
    const level = this.level();
    let spent = { micros: 0, calls: 0 };
    try {
      spent = this.store.aiSpendSince(startOfUtcDay(this.clock.now()));
    } catch (err) {
      this.warn('ai.status_failed', err);
    }
    const cap = this.opts.dailyBudgetMicros;
    const capCalls = this.dailyCalls();
    let state: AiStatus['state'] = 'ok';
    if (level === 0) state = 'off';
    else if (this.breaker.state() !== 'closed') state = 'unavailable';
    else if (spent.micros >= cap || spent.calls >= capCalls) state = 'paused_budget';
    return {
      available: true,
      level,
      maxLevel: this.opts.maxLevel,
      state,
      spentMicros: spent.micros,
      capMicros: cap,
      capCalls,
      day: utcDayLabel(this.clock.now()),
      reads: spent.calls,
      cacheHitRate: this.meter.cacheHitRate(),
      invalid: { ...this.meter.invalid },
    };
  }

  read(reportId: string, o?: { open?: boolean }): AiReadView | null {
    try {
      const level = this.level();
      if (level === 0 || typeof reportId !== 'string') return null;
      const report = this.store.loadReport(reportId);
      if (report === null) return null;
      const row = this.store.loadAiRead(reportId);
      const open = o?.open === true && report.status === 'open';
      if (row === null || row.read === null) {
        if (open) this.enqueue(reportId);
        return null;
      }
      const prepared = this.prepare(report);
      const view = this.view(row, report, prepared, level);
      if (open && view.stale) this.enqueue(reportId);
      return view;
    } catch (err) {
      this.warn('ai.read_view_failed', err);
      return null;
    }
  }

  readAgain(reportId: string, actor: string): Promise<AiReadAgain> {
    try {
      const level = this.level();
      if (level === 0 || typeof reportId !== 'string') return Promise.resolve('off');
      const report = this.store.loadReport(reportId);
      if (report === null || report.status !== 'open') return Promise.resolve('off');
      if (!this.allowAsk(actor)) return Promise.resolve('rate');
      const prepared = this.prepare(report);
      const row = this.store.loadAiRead(reportId);
      if (row !== null && row.read !== null && row.inputHash === prepared.hash) return Promise.resolve(this.view(row, report, prepared, level));
      const own = this.store.loadAiReadFor(reportId, prepared.hash);
      const now = this.clock.now();
      const today = this.store.aiSpendSince(startOfUtcDay(now));
      if (today.micros >= this.opts.dailyBudgetMicros || today.calls >= this.dailyCalls()) return Promise.resolve('budget');
      // Nothing can be called now: say so, with the wait, rather than queue a job that cannot run.
      if (!this.breaker.available()) {
        const reopens = this.breaker.reopensAt() ?? now;
        return Promise.resolve({ unavailable: { retryAfterMs: Math.max(1000, reopens - now) } });
      }
      if (!this.window.peek(now)) return Promise.resolve({ unavailable: { retryAfterMs: Math.max(1000, this.window.nextFree(now) - now) } });
      // A moderator's explicit ask retakes a FINAL row (one that ended without an answer and will not be tried again by itself) once;
      // the store keeps that on the row, so asking again has nothing left to try, whichever process or restart comes between. A row
      // still waiting for its own retry is not retaken: the ask just makes sure it is queued, and the call waits for its time.
      if (own !== null && isFinalRow(own)) {
        if (own.retaken) return Promise.resolve('final');
        this.retakes.add(reportId);
      } else if (own?.status === 'skipped') {
        // A skipped read made no call: the ask takes it now instead of at its retry time (the caps were checked above).
        this.retakes.add(reportId);
      }
      this.enqueue(reportId, { force: true });
      return Promise.resolve('pending');
    } catch (err) {
      this.warn('ai.read_again_failed', err);
      return Promise.resolve('off');
    }
  }

  /** A sliding minute per actor. Held in memory: it guards the provider's bill from one eager hand, not a security boundary. */
  private allowAsk(actor: string): boolean {
    const now = this.clock.now();
    const key = String(actor);
    const recent = (this.asked.get(key) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= READ_AGAIN_PER_MINUTE) {
      this.asked.set(key, recent);
      return false;
    }
    recent.push(now);
    this.asked.set(key, recent);
    if (this.asked.size > 1000) this.asked.delete(this.asked.keys().next().value as string);
    return true;
  }

  briefs(reportIds: readonly string[]): Map<string, AiBrief> {
    const out = new Map<string, AiBrief>();
    try {
      const level = this.level();
      if (level === 0 || !Array.isArray(reportIds) || reportIds.length === 0) return out;
      for (const row of this.store.loadAiReads(reportIds)) {
        const read = row.read;
        if (read === null) continue;
        const report = this.store.loadReport(row.reportId);
        if (report === null) continue;
        const rec = read.recommendation;
        out.set(row.reportId, {
          severity: read.severity,
          confidence: read.confidence,
          rule: read.rule,
          stale: this.prepare(report).hash !== row.inputHash,
          injectionSuspected: read.injectionSuspected,
          hasRecommendation: level >= 2 && rec !== null && rec.verdict !== 'unclear',
        });
      }
    } catch (err) {
      this.warn('ai.briefs_failed', err);
      return new Map();
    }
    return out;
  }

  stats(q?: { since?: number }): AiStatsView {
    const since = typeof q?.since === 'number' && Number.isFinite(q.since) ? q.since : this.clock.now() - STATS_DEFAULT_WINDOW_MS;
    try {
      const rows = this.store.aiStats(since);
      const view = emptyStats(since);
      for (const r of rows) {
        view.decided += r.decided;
        view.agree += r.agree;
        view.override += r.override;
        view.none += r.none;
        view.falsePositives += r.falsePositives;
        view.oneClick += r.oneClick;
        view.rules.push({ rule: ruleOfText(r.rule), decided: r.decided, agree: r.agree, override: r.override, none: r.none, falsePositives: r.falsePositives, oneClick: r.oneClick });
      }
      const shown = view.agree + view.override;
      view.agreementRate = shown === 0 ? null : view.agree / shown;
      view.falsePositiveRate = shown === 0 ? null : view.falsePositives / shown;
      view.oneClickRate = shown === 0 ? null : view.oneClick / shown;
      return view;
    } catch (err) {
      this.warn('ai.stats_failed', err);
      return emptyStats(since);
    }
  }

  markReversed(reportId: string): boolean {
    return this.mark(reportId, { reversed: true });
  }

  dontTeach(reportId: string): boolean {
    return this.mark(reportId, { dontTeach: true });
  }

  private mark(reportId: string, patch: { reversed?: true; dontTeach?: true }): boolean {
    try {
      return typeof reportId === 'string' && this.store.markAiOutcome(reportId, patch);
    } catch (err) {
      this.warn('ai.mark_failed', err);
      return false;
    }
  }

  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => void this.waiters.push(resolve));
  }

  close(): void {
    this.isClosed = true;
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    if (this.pumpTimer !== undefined) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.queue.length = 0;
    this.queued.clear();
    for (const c of this.controllers) c.abort();
    this.settleIdle();
  }

  // --- the queue -------------------------------------------------------------------------------------------------------------

  /**
   * Put a report on the queue. Synchronous and cheap: no store read, no await. Does nothing at level 0. `force` is for a case that
   * changed or was asked for (it forgets any wait the sweeper was keeping).
   */
  enqueue(reportId: string, o?: { force?: boolean }): boolean {
    try {
      if (this.isClosed || typeof reportId !== 'string' || this.level() === 0) return false;
      if (o?.force === true) this.parked.delete(reportId);
      const job = this.running.get(reportId);
      if (job !== undefined) {
        // A change arrived while it was being read: read once more when this one ends.
        job.dirty = true;
        return false;
      }
      if (this.queued.has(reportId)) return false;
      this.queued.add(reportId);
      this.queue.push(reportId);
      this.schedulePump();
      return true;
    } catch (err) {
      this.warn('ai.enqueue_failed', err);
      return false;
    }
  }

  /** The reporter's follow-up changed the case: read it again once. Called by the facade's `reports.addDetail`. */
  caseChanged(reportId: string): void {
    this.enqueue(reportId, { force: true });
  }

  private schedulePump(): void {
    if (this.pumpTimer !== undefined || this.isClosed) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      this.pump();
    }, 0);
    (this.pumpTimer as { unref?: () => void }).unref?.();
  }

  private pump(): void {
    while (!this.isClosed && this.running.size < this.opts.concurrency && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      this.queued.delete(id);
      this.running.set(id, { dirty: false });
      void this.runOne(id);
    }
    this.settleIdle();
  }

  private async runOne(id: string): Promise<void> {
    try {
      const retake = this.retakes.delete(id);
      const end: ReadEnd = await runRead(this.env(), id, retake ? { retake: true } : undefined);
      if (end.park !== null) this.park(id, end.park);
      else this.parked.delete(id);
    } catch (err) {
      this.warn('ai.job_failed', err);
    } finally {
      const job = this.running.get(id);
      this.running.delete(id);
      if (job?.dirty === true && !this.isClosed) this.enqueue(id, { force: true });
      this.pump();
    }
  }

  /** Remember not to queue `reportId` before `until`. Bounded: the oldest entry goes when the list is full. */
  private park(reportId: string, until: number): void {
    this.parked.delete(reportId);
    if (this.parked.size >= PARKED_MAX) this.parked.delete(this.parked.keys().next().value as string);
    this.parked.set(reportId, until);
  }

  /** How many reports the sweeper is holding back (tests). */
  parkedSize(): number {
    return this.parked.size;
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && this.running.size === 0 && this.pumpTimer === undefined;
  }

  private settleIdle(): void {
    if (!this.isIdle()) return;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  // --- the sweeper -----------------------------------------------------------------------------------------------------------

  async sweep(): Promise<void> {
    try {
      if (this.isClosed || this.level() === 0 || !this.breaker.available()) return;
      const now = this.clock.now();
      const quiet = this.isIdle();
      let added = 0;
      const room = (): number => SWEEP_BATCH - added;

      // 1. Reads whose retry has come, and reads whose owner died.
      for (const row of this.store.listAiRetries(now, 200)) {
        if (room() <= 0) break;
        const report = this.store.loadReport(row.reportId);
        if (report === null || report.status !== 'open' || this.prepare(report).hash !== row.inputHash) continue;
        if (this.enqueue(row.reportId, { force: true })) added += 1;
      }

      // 2. Open reports with no usable read, newest first.
      const page = this.store.listReports({ status: 'open', limit: SWEEP_SCAN });
      const ids = page.map((r) => r.id);
      const read = new Map(this.store.loadAiReads(ids).map((r) => [r.reportId, r]));
      // Forget what is held back for reports that are decided or no longer open: the list only keeps the live ones.
      const open = new Set(ids);
      for (const id of [...this.parked.keys()]) if (!open.has(id)) this.parked.delete(id);
      for (const report of page) {
        if (room() <= 0) break;
        if (read.has(report.id) || this.isParked(report.id, now)) continue;
        if (this.enqueue(report.id)) added += 1;
      }

      // 3. When there is nothing new, bring a few stale reads up to date (rules or case changed), at the pace of the budget.
      if (added === 0 && quiet) {
        let stale = 0;
        for (const report of page) {
          if (stale >= STALE_PER_SWEEP) break;
          const row = read.get(report.id);
          if (row === undefined || this.isParked(report.id, now)) continue;
          if (this.prepare(report).hash !== row.inputHash && this.enqueue(report.id)) stale += 1;
        }
      }
    } catch (err) {
      this.warn('ai.sweep_failed', err);
    }
  }

  private isParked(reportId: string, now: number): boolean {
    const until = this.parked.get(reportId);
    return until !== undefined && until > now;
  }

  // --- views -----------------------------------------------------------------------------------------------------------------

  /** A report made ready for a read, cached by what it is made from. */
  protected prepare(report: ReportRecord): Prepared {
    const profile = this.deps.profile();
    const policy = { profile, rules: this.deps.rules };
    const stable = aiPolicyText(policy);
    if (stable !== this.lastStable) {
      // The rules, the level meanings or the standard changed: what was waiting for a retry may now read differently.
      this.lastStable = stable;
      this.stableKey = sha256Hex(stable);
      this.parked.clear();
    }
    const reasons = profile.reporting.reasons;
    const label = report.reportedReason === null || report.reportedReason === undefined ? '' : (reasons.find((r) => r.id === report.reportedReason)?.label ?? '');
    const key = [report.id, report.detailAt ?? 0, this.stableKey, label].join('|');
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const made = prepareCase({ report, policy, reasons, adapterId: this.adapter.id, mask: this.opts.blockedLines === 'mask' });
    if (this.cache.size >= PREPARED_CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, made);
    return made;
  }

  private view(row: { id: string; read: AIRead | null; inputHash: string; model: string | null; createdAt: number }, report: ReportRecord, prepared: Prepared, level: number): AiReadView {
    const read = row.read as AIRead;
    const rec = read.recommendation;
    return {
      id: row.id,
      severity: read.severity,
      rule: read.rule,
      summary: read.summary,
      evidenceLineIds: [...read.evidence],
      confidence: read.confidence,
      stale: row.inputHash !== prepared.hash,
      injectionSuspected: read.injectionSuspected,
      model: row.model,
      at: row.createdAt,
      recommendation: level >= 2 && rec !== null ? { verdict: rec.verdict, severity: rec.severity, rule: rec.rule, evidenceLineIds: [...rec.evidence], ...this.stepFor(report, prepared, rec) } : null,
    };
  }

  /** The step the ladder gives for the recommendation, and whether it is within the ceilings. */
  private stepFor(report: ReportRecord, prepared: Prepared, rec: NonNullable<AIRead['recommendation']>): { step: SuggestionStep | null; stepWithinCeiling: boolean } {
    if (rec.verdict === 'no_action' || rec.verdict === 'unclear') return { step: null, stepWithinCeiling: true };
    try {
      const profile = this.deps.profile();
      const ruleRef = typeof rec.rule === 'number' ? rec.rule : suggestedRule(profile.reporting.reasons, report.reportedReason ?? null, this.deps.rules);
      const step =
        rec.verdict === 'noted'
          ? ({ kind: 'note', durationMs: null, label: 'Note' } satisfies SuggestionStep)
          : stepOf(this.deps.suggest(report.targetSubject, rec.severity, ruleRef, { roomId: report.roomId === '' ? null : report.roomId }));
      if (step === null) return { step: null, stepWithinCeiling: true };
      try {
        assertWithinCeilings(step, { cited: rec.evidence, ownRefs: prepared.ownLineIds });
        return { step, stepWithinCeiling: true };
      } catch (err) {
        if (!(err instanceof AICeilingError)) throw err;
        return { step, stepWithinCeiling: false };
      }
    } catch (err) {
      this.warn('ai.step_failed', err);
      return { step: null, stepWithinCeiling: false };
    }
  }

  // --- the worker's environment ----------------------------------------------------------------------------------------------

  private env(): WorkerEnv {
    return {
      store: this.store,
      clock: this.clock,
      adapter: this.adapter,
      timeoutMs: this.opts.timeoutMs,
      capMicros: this.opts.dailyBudgetMicros,
      breaker: this.breaker,
      window: this.window,
      meter: this.meter,
      level: () => this.level(),
      dailyCalls: () => this.dailyCalls(),
      closed: () => this.isClosed,
      prepare: (report) => this.prepare(report),
      examplesFor: (report, prepared) => this.examplesFor(report, prepared),
      track: (c) => void this.controllers.add(c),
      untrack: (c) => void this.controllers.delete(c),
      auditRead: (reportId) => {
        try {
          this.deps.audit({ actor: this.actor, role: null, action: 'ai.read', target: { type: 'report', ref: reportId } });
        } catch (err) {
          this.warn('ai.audit_failed', err);
        }
      },
      warn: (event, detail) => safeWarn(this.deps.logger, event, detail),
    };
  }

  /**
   * Casebook examples for a read: none unless learning is on, example text is kept at all, the case names a reason that maps to a rule,
   * and at least 30 teachable decisions exist. Then the two newest of that rule at the conduct level the AI gave this report before
   * (or, for a first read, at any level), newest first. Each is pseudonymised already; the row's report id is its id.
   */
  protected examplesFor(report: ReportRecord, prepared: Prepared): AIExampleInput[] {
    void prepared;
    const profile = this.deps.profile();
    const keepMs = this.deps.exampleRetentionMs();
    if (!profile.ai.learn || !(keepMs > 0)) return [];
    const rule = suggestedRule(profile.reporting.reasons, report.reportedReason ?? null, this.deps.rules);
    if (typeof rule !== 'number') return [];
    const since = this.clock.now() - keepMs;
    if (this.store.aiTeachableCount(since) < AI_EXAMPLES_MIN) return [];
    const known = this.store.loadAiRead(report.id)?.read?.severity;
    const levels: readonly ConductLevel[] = known === undefined ? CONDUCT_LEVELS : [known];
    return levels
      .flatMap((level) => this.store.aiExamples(String(rule), level, 2, since))
      .sort((a, b) => b.decidedAt - a.decidedAt || (a.reportId < b.reportId ? 1 : -1))
      .slice(0, 2)
      .map((row): AIExampleInput => ({ ...row.example, id: row.reportId }));
  }

  // --- the casebook ----------------------------------------------------------------------------------------------------------

  /**
   * The casebook row for a decision (the hook `DecisionService` calls inside its transaction), computed here from the stored read and
   * the decision. The server always records it when a read exists at level 1 or 2, whichever way the decision came (the hub, `cw.decide`,
   * a webhook, a bulk dismissal); the echo, when there is one, only names the read the moderator saw, says whether they clicked accept
   * (kept only when the decision is the pre-fill) and gives the conduct level of their form (kept only when it fits the verdict).
   * With no echo there is no example text. Null at level 0 and when the report has no read. Fenced by the caller.
   */
  outcomeOf(args: AiOutcomeArgs): AiOutcomeInsert | null {
    const level = this.level();
    if (level === 0) return null;
    const { report, verdict, ai } = args;
    // The read the moderator saw when the echo names one of this report's finished reads, else the newest.
    const named = ai.readId === null ? null : this.store.loadAiReadById(ai.readId);
    const row: AiReadRow | null = named !== null && named.reportId === report.id && named.status === 'ok' && named.read !== null ? named : this.store.loadAiRead(report.id);
    if (row === null) return null;
    const read = row.read;
    const rec = read?.recommendation ?? null;
    const own = actionsOnTarget(args.actions, args.target);

    // What the ladder would have pre-filled for the AI's conduct level: the step the human's is compared with.
    let prefill: StepLike | null = null;
    if (level >= 2 && rec !== null && (rec.verdict === 'upheld' || rec.verdict === 'noted')) {
      const step = this.stepFor(report, this.prepare(report), rec).step;
      prefill = step === null ? null : { kind: step.kind, durationMs: step.durationMs };
    }
    const verdictClass: AiVerdict = verdict === 'bad_faith' ? 'no_action' : verdict;
    const result = agreementOf(
      read,
      { verdict, rule: own.rule, lineIds: own.lineIds, step: own.step, prefill, others: own.others, oneClick: ai.accepted },
      level,
    );

    // The conduct level the human settled on: their form's when it fits the verdict (a dismissal carries none; an action is not
    // banter), else the AI's on an agreement, else banter for a dismissal.
    const claimed = verdict === 'upheld' || verdict === 'noted' ? (ai.severity !== null && ai.severity !== 'banter' ? ai.severity : null) : null;
    const severity: ConductLevel | null =
      claimed ?? (result.agreement === 'agree' && rec !== null ? rec.severity : verdict === 'no_action' ? 'banter' : null);
    const badFaith = verdict === 'bad_faith';
    // The row is filed under the rule the human cited; a dismissal cites none, so it goes under the rule the AI cited (that is where its
    // false positive belongs), else the rule of the reporter's reason.
    const reasonRule = suggestedRule(this.deps.profile().reporting.reasons, report.reportedReason ?? null, this.deps.rules);
    const filedUnder: number | 'uncovered' | null = own.rule ?? rec?.rule ?? read?.rule ?? (typeof reasonRule === 'number' ? reasonRule : null);

    const profile = this.deps.profile();
    const teachable =
      ai.readId !== null &&
      (result.agreement === 'agree' || result.agreement === 'override') &&
      !badFaith &&
      profile.ai.learn &&
      this.deps.exampleRetentionMs() > 0 &&
      severity !== null &&
      own.rule !== null;
    let example: AiOutcomeInsert['example'] = null;
    if (teachable && severity !== null && own.rule !== null) {
      const cited = new Set([...own.lineIds, ...(rec?.evidence ?? []), ...(read?.evidence ?? [])]);
      const lines = pickExampleLines(this.prepare(report).chosen, cited);
      if (lines.length > 0) example = { rule: own.rule, severity, verdict: verdictClass, lines };
    }

    return {
      reportId: report.id,
      readId: row.id,
      decidedAt: args.now,
      level,
      verdict: verdictClass,
      rule: filedUnder === null ? null : String(filedUnder),
      severity,
      aiVerdict: result.aiVerdict,
      agreement: result.agreement,
      detail: result.detail,
      badFaith,
      example,
    };
  }

  /** The owner's most calls in a UTC day, read live from the profile. */
  private dailyCalls(): number {
    try {
      return this.deps.profile().ai.dailyCalls;
    } catch (err) {
      this.warn('ai.level_failed', err);
      return AI_DAILY_CALLS_DEFAULT;
    }
  }

  protected warn(event: string, err: unknown): void {
    safeWarn(this.deps.logger, event, { error: errorClass(err) });
  }
}

