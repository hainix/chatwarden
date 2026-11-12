import type {
  AISignal,
  AiCallUsage,
  AiErrorKind,
  AiExampleRow,
  AiOutcomeInsert,
  AiOutcomeRow,
  AiReadDone,
  AiReadPending,
  AiReadRow,
  AiReserveResult,
  AiStatsRow,
  Store,
} from '@chatwarden/core';
import { MemoryStore, compare, newId } from './memoryStore.js';

// The in-memory store's AI methods (AI levels 1 and 2), kept apart from `MemoryStore` so a bundle that never calls `withMemoryAi` does not
// carry them. The state they work on (`aiReads`, `aiSpend`, `aiOutcomes`) and the purge of a report's reads stay in `MemoryStore`.

/** The signal counts a read stores: a copy of only the four fields, and null for none. */
function signalsOf(v: readonly AISignal[] | undefined): AISignal[] | null {
  const rows = (v ?? []).map((s) => ({ label: s.label, polarity: s.polarity, distinct: s.distinct, windowDays: s.windowDays }));
  return rows.length === 0 ? null : rows;
}

/** The Store methods `withMemoryAi` adds. */
export type MemoryAiMethods = Required<
  Pick<
    Store,
    | 'reserveAiRead'
    | 'completeAiRead'
    | 'failAiRead'
    | 'loadAiRead'
    | 'loadAiReadById'
    | 'loadAiReadFor'
    | 'loadAiReads'
    | 'listAiRetries'
    | 'aiSpendSince'
    | 'insertAiOutcome'
    | 'loadAiOutcome'
    | 'markAiOutcome'
    | 'aiExamples'
    | 'aiTeachableCount'
    | 'aiStats'
    | 'purgeAi'
  >
>;

/** A {@link MemoryStore} with the AI methods (what `withMemoryAi` returns). */
export type MemoryAiStore = MemoryStore & MemoryAiMethods;

/** The methods, on a class only so they can reach the store's own state. Never constructed: `withMemoryAi` copies them onto a store. */
class MemoryAi extends MemoryStore {
  // AI reads and the casebook (AI levels 1 and 2). Synchronous like claims; each write is journaled, so an undone transaction
  // undoes it. Rows go in and come out as copies.

  reserveAiRead(row: AiReadPending, leaseUntil: number, now: number, opts?: { retake?: boolean }): AiReserveResult {
    const existing = this.aiReads.find((r) => r.reportId === row.reportId && r.inputHash === row.inputHash);
    if (existing === undefined) {
      const fresh: AiReadRow = {
        id: newId(),
        reportId: row.reportId,
        inputHash: row.inputHash,
        status: 'pending',
        attempts: 1,
        retryAt: null,
        leaseUntil,
        errorKind: null,
        adapter: row.adapter,
        model: null,
        promptVersion: row.promptVersion,
        read: null,
        exampleIds: [],
        signals: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costMicros: 0,
        latencyMs: null,
        createdAt: now,
        retaken: false,
      };
      this.aiReads.push(fresh);
      this.undoWith(() => {
        this.aiReads = this.aiReads.filter((r) => r !== fresh);
      });
      this.openAttempt(fresh.id, 1, now);
      return { reserved: true, id: fresh.id, lease: 1 };
    }
    const lapsed = existing.status === 'pending' && existing.leaseUntil !== null && existing.leaseUntil <= now;
    const due = (existing.status === 'failed' || existing.status === 'skipped') && existing.retryAt !== null && existing.retryAt <= now;
    // An explicit retake (a moderator's read again) also takes a FINAL row (no retry time), once: it marks the row. Never an ok read,
    // a live lease, or a row still waiting for its own retry.
    // A skipped row made no call and gave its attempt back: an explicit ask takes it at once, without using the retake.
    const final = existing.status === 'declined' || existing.status === 'invalid' || (existing.status === 'failed' && existing.retryAt === null);
    const retaken = opts?.retake === true && final && !existing.retaken;
    const skipped = opts?.retake === true && existing.status === 'skipped';
    if (!lapsed && !due && !retaken && !skipped) return { reserved: false, existing: structuredClone(existing) };
    const before = { ...existing };
    if (retaken) existing.retaken = true;
    existing.status = 'pending';
    existing.attempts += 1;
    existing.retryAt = null;
    existing.leaseUntil = leaseUntil;
    existing.errorKind = null;
    this.undoWith(() => Object.assign(existing, before));
    this.openAttempt(existing.id, existing.attempts, now);
    return { reserved: true, id: existing.id, lease: existing.attempts };
  }

  /** One call started: a ledger entry at `now`. */
  private openAttempt(readId: string, attempt: number, at: number): void {
    const entry = { readId, attempt, at, micros: 0 };
    this.aiSpend.push(entry);
    this.undoWith(() => {
      this.aiSpend = this.aiSpend.filter((e) => e !== entry);
    });
  }

  /** Add what a call cost to its row and to its ledger entry (journaled by the caller through `before`). */
  private addUsage(row: AiReadRow, u: AiCallUsage): void {
    const add = (a: number | null, b: number): number => (a ?? 0) + b;
    Object.assign(row, {
      model: u.model,
      inputTokens: add(row.inputTokens, u.inputTokens),
      outputTokens: add(row.outputTokens, u.outputTokens),
      cacheReadTokens: add(row.cacheReadTokens, u.cacheReadTokens),
      cacheWriteTokens: add(row.cacheWriteTokens, u.cacheWriteTokens),
      costMicros: row.costMicros + u.costMicros,
      latencyMs: u.latencyMs,
    });
    const entry = this.aiSpend.find((e) => e.readId === row.id && e.attempt === row.attempts);
    if (entry !== undefined) {
      entry.micros += u.costMicros;
      this.undoWith(() => {
        entry.micros -= u.costMicros;
      });
    }
  }

  /** A stale owner's call was still paid for: book its cost to its own attempt's ledger entry, once. Nothing else changes. */
  private bookStale(row: AiReadRow, lease: number, usage: AiCallUsage | undefined): void {
    if (usage === undefined || lease >= row.attempts) return;
    const entry = this.aiSpend.find((e) => e.readId === row.id && e.attempt === lease);
    if (entry === undefined || entry.micros !== 0) return;
    entry.micros = usage.costMicros;
    this.undoWith(() => {
      entry.micros = 0;
    });
  }

  completeAiRead(id: string, lease: number, result: AiReadDone): boolean {
    const row = this.aiReads.find((r) => r.id === id);
    if (row === undefined) return false;
    if (row.status !== 'pending' || row.attempts !== lease) {
      this.bookStale(row, lease, result);
      return false;
    }
    const before = { ...row };
    Object.assign(row, {
      status: 'ok',
      leaseUntil: null,
      retryAt: null,
      errorKind: null,
      read: structuredClone(result.read),
      exampleIds: [...(result.exampleIds ?? [])],
      signals: signalsOf(result.signals),
    });
    this.undoWith(() => Object.assign(row, before));
    this.addUsage(row, result);
    this.bump();
    return true;
  }

  failAiRead(
    id: string,
    lease: number,
    status: 'failed' | 'declined' | 'invalid' | 'skipped',
    errorKind: AiErrorKind,
    retryAt: number | null,
    usage?: AiCallUsage,
  ): boolean {
    const row = this.aiReads.find((r) => r.id === id);
    if (row === undefined) return false;
    if (row.status !== 'pending' || row.attempts !== lease) {
      this.bookStale(row, lease, usage);
      return false;
    }
    const before = { ...row };
    // A skipped read was never a call: the attempt is given back, so it does not use up the three-attempt budget.
    Object.assign(row, { status, errorKind, retryAt, leaseUntil: null, ...(status === 'skipped' ? { attempts: Math.max(0, row.attempts - 1) } : {}) });
    this.undoWith(() => Object.assign(row, before));
    if (usage !== undefined) this.addUsage(row, usage);
    if (status === 'skipped') {
      // A skipped read was never a call: its attempt leaves the ledger.
      const ledger = this.aiSpend;
      this.aiSpend = ledger.filter((e) => !(e.readId === id && e.attempt === lease));
      this.undoWith(() => {
        this.aiSpend = ledger;
      });
    }
    return true;
  }

  loadAiRead(reportId: string): AiReadRow | null {
    return newestOk(this.aiReads.filter((r) => r.reportId === reportId));
  }

  loadAiReadFor(reportId: string, inputHash: string): AiReadRow | null {
    const row = this.aiReads.find((r) => r.reportId === reportId && r.inputHash === inputHash);
    return row === undefined ? null : structuredClone(row);
  }

  loadAiReadById(id: string): AiReadRow | null {
    const row = this.aiReads.find((r) => r.id === id);
    return row === undefined ? null : structuredClone(row);
  }

  loadAiReads(reportIds: readonly string[]): AiReadRow[] {
    const wanted = [...new Set(reportIds)].slice(0, 200);
    const out: AiReadRow[] = [];
    for (const reportId of wanted) {
      const row = this.loadAiRead(reportId);
      if (row !== null) out.push(row);
    }
    return out;
  }

  listAiRetries(now: number, limit: number | undefined): AiReadRow[] {
    // Reads of reports that have been decided are dead: nobody will read them, so they are not listed.
    const decided = new Set(this.reports.filter((p) => p.status !== 'open').map((p) => p.id));
    return this.aiReads
      .filter(
        (r) =>
          !decided.has(r.reportId) &&
          (((r.status === 'failed' || r.status === 'skipped') && r.retryAt !== null && r.retryAt <= now) ||
            (r.status === 'pending' && r.leaseUntil !== null && r.leaseUntil <= now)),
      )
      .sort((a, b) => a.createdAt - b.createdAt || compare(a.id, b.id))
      .slice(0, pageSize(limit, RETRIES_DEFAULT_LIMIT))
      .map((r) => structuredClone(r));
  }

  aiSpendSince(since: number): { micros: number; calls: number } {
    let micros = 0;
    let calls = 0;
    for (const e of this.aiSpend) {
      if (e.at < since) continue;
      micros += e.micros;
      calls += 1;
    }
    return { micros, calls };
  }

  insertAiOutcome(row: AiOutcomeInsert): boolean {
    if (this.aiOutcomes.has(row.reportId)) return false;
    // A bad-faith row can never teach, so its chat text is not kept.
    this.aiOutcomes.set(row.reportId, { ...structuredClone(row), example: row.badFaith ? null : structuredClone(row.example), reversed: false, dontTeach: false });
    this.undoWith(() => this.aiOutcomes.delete(row.reportId));
    return true;
  }

  loadAiOutcome(reportId: string): AiOutcomeRow | null {
    const row = this.aiOutcomes.get(reportId);
    return row === undefined ? null : structuredClone(row);
  }

  markAiOutcome(reportId: string, patch: { reversed?: true; dontTeach?: true }): boolean {
    const row = this.aiOutcomes.get(reportId);
    if (row === undefined) return false;
    const before = { reversed: row.reversed, dontTeach: row.dontTeach, example: row.example };
    if (patch.reversed === true) row.reversed = true;
    if (patch.dontTeach === true) row.dontTeach = true;
    // A row that can no longer teach does not keep its chat text.
    if (row.reversed || row.dontTeach) row.example = null;
    this.undoWith(() => Object.assign(row, before));
    this.bump();
    return true;
  }

  aiExamples(rule: string, severity: string, limit: number | undefined, since: number): AiExampleRow[] {
    const n = pageSize(limit, EXAMPLES_DEFAULT_LIMIT);
    const out: AiExampleRow[] = [];
    for (const r of [...this.aiOutcomes.values()].sort((a, b) => b.decidedAt - a.decidedAt || compare(b.reportId, a.reportId))) {
      if (out.length >= n) break;
      if (r.rule !== rule || r.severity !== severity || !teachable(r, since)) continue;
      out.push({ reportId: r.reportId, decidedAt: r.decidedAt, agreement: r.agreement as 'agree' | 'override', example: structuredClone(r.example!) });
    }
    return out;
  }

  aiTeachableCount(since: number): number {
    let n = 0;
    for (const r of this.aiOutcomes.values()) if (teachable(r, since)) n += 1;
    return n;
  }

  aiStats(since: number): AiStatsRow[] {
    const by = new Map<string | null, AiStatsRow>();
    for (const r of this.aiOutcomes.values()) {
      if (r.decidedAt < since) continue;
      const row = by.get(r.rule) ?? { rule: r.rule, decided: 0, agree: 0, override: 0, none: 0, falsePositives: 0, oneClick: 0 };
      row.decided += 1;
      row[r.agreement] += 1;
      // A one-click is an agreement accepted as it stood; a flag on any other row is not counted.
      if (r.detail.oneClick && r.agreement === 'agree') row.oneClick += 1;
      if ((r.aiVerdict === 'upheld' || r.aiVerdict === 'noted') && (r.verdict === 'no_action' || r.reversed)) row.falsePositives += 1;
      by.set(r.rule, row);
    }
    return [...by.values()].sort((a, b) => ruleRank(a.rule) - ruleRank(b.rule) || ruleOrder(a.rule, b.rule));
  }

  purgeAi(readsBefore: number, outcomesBefore: number, examplesBefore: number): { reads: number; outcomes: number } {
    const reads = this.aiReads;
    const outcomes = new Map(this.aiOutcomes);
    const keptReads = reads.filter((r) => r.createdAt >= readsBefore);
    const ledger = this.aiSpend;
    this.aiSpend = ledger.filter((e) => e.at >= readsBefore);
    const stripped: Array<[AiOutcomeRow, AiOutcomeRow['example']]> = [];
    let gone = 0;
    for (const [id, r] of outcomes) {
      if (r.decidedAt < outcomesBefore) {
        this.aiOutcomes.delete(id);
        gone += 1;
      } else if (r.decidedAt < examplesBefore && r.example !== null) {
        stripped.push([r, r.example]);
        r.example = null;
      }
    }
    this.aiReads = keptReads;
    this.undoWith(() => {
      this.aiReads = reads;
      this.aiSpend = ledger;
      this.aiOutcomes = outcomes;
      for (const [r, example] of stripped) r.example = example;
    });
    return { reads: reads.length - keptReads.length, outcomes: gone };
  }
}

/** The page sizes used when a limit is omitted, not finite or below 1. Local copies of core's: this package links no runtime core code. */
const EXAMPLES_DEFAULT_LIMIT = 2;
const RETRIES_DEFAULT_LIMIT = 20;

/** A page size: the limit floored and capped at 200, or `fallback` when it is omitted, not finite or below 1. */
function pageSize(limit: number | undefined, fallback: number): number {
  return limit !== undefined && Number.isFinite(limit) && limit >= 1 ? Math.min(200, Math.floor(limit)) : fallback;
}

/** The newest `ok` row (`createdAt`, then `id`, both descending), as a copy; null when there is none. */
function newestOk(rows: readonly AiReadRow[]): AiReadRow | null {
  let best: AiReadRow | null = null;
  for (const r of rows) {
    if (r.status !== 'ok') continue;
    if (best === null || r.createdAt > best.createdAt || (r.createdAt === best.createdAt && compare(r.id, best.id) > 0)) best = r;
  }
  return best === null ? null : structuredClone(best);
}

/** An outcome that may teach: it has an example, the AI recommended something, and it is not reversed, marked or bad faith. */
function teachable(r: AiOutcomeRow, since: number): boolean {
  return r.decidedAt >= since && r.example !== null && r.agreement !== 'none' && !r.reversed && !r.dontTeach && !r.badFaith;
}

/** Numbered rules first (by number), then `uncovered`, then any other text, then no rule: the order of `aiStats`. */
function ruleRank(rule: string | null): number {
  if (rule === null) return 3;
  if (/^\d+$/.test(rule)) return 0;
  return rule === 'uncovered' ? 1 : 2;
}
function ruleOrder(a: string | null, b: string | null): number {
  if (a === null || b === null) return 0;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) - Number(b);
  return compare(a, b);
}

/**
 * Give a {@link MemoryStore} the optional AI methods (`reserveAiRead`, `loadAiOutcome`, `aiStats`, ...), so `createChatwarden({ ai })` can use
 * it. Returns the same store. `createMemoryStore()` does not carry them, so an app that never turns the AI on does not bundle them. A method the
 * store already has (a subclass's override) is left as it is, and calling this twice changes nothing.
 * @experimental
 */
export function withMemoryAi<S extends MemoryStore>(store: S): S & MemoryAiMethods {
  const target = store as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(MemoryAi.prototype)) {
    if (name === 'constructor' || typeof target[name] === 'function') continue;
    Object.defineProperty(target, name, { value: (MemoryAi.prototype as unknown as Record<string, unknown>)[name], writable: true, configurable: true, enumerable: false });
  }
  return store as S & MemoryAiMethods;
}
