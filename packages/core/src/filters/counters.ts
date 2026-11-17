import { errorClass, ThrottledWarn } from '../log.js';
import type { Clock, Logger } from '../types.js';

// What the filters did, counted: one row per (UTC day, key, applied action). No person, no room and no text is in a row; the counts are for
// tuning a rule, not for evidence. Increments are held in memory and written every 30 seconds and on close, so the chat path never waits on
// a write and a crash loses at most 30 seconds of counts.

const DAY_MS = 86_400_000;
/** How often the held counts are written. */
export const FILTER_FLUSH_MS = 30_000;
/** The most distinct (day, key, action) rows held between two flushes; a row over this is dropped, never an error. */
export const FILTER_COUNTER_ROWS_MAX = 5000;

/** What a count is filed under: the action the owner set, or `flag_capped` when the daily cap turned a flag into a count. */
export const HIT_ACTIONS = ['count', 'flag', 'mask', 'refuse', 'flag_capped'] as const;
export type HitAction = (typeof HIT_ACTIONS)[number];

export interface HitRow {
  /** The UTC day number: epoch ms divided by one day, rounded down. */
  day: number;
  key: string;
  action: HitAction;
  hits: number;
}

/** Where the rows go: the store (F5) or memory. `list` returns the rows of days `from` to `to` inclusive. */
export interface FilterHitSink {
  add(rows: readonly HitRow[]): void | Promise<void>;
  list(from: number, to: number): HitRow[] | Promise<HitRow[]>;
}

export const utcDay = (ms: number): number => Math.floor(ms / DAY_MS);

const rowKey = (day: number, key: string, action: string): string => `${day}\u0000${key}\u0000${action}`;

/** The held counts. */
export class FilterCounters {
  private readonly rows = new Map<string, HitRow>();

  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Count one hit of `key` under `action`, today (UTC). An unknown action is ignored; a full table drops new rows. Never throws. */
  add(key: string, action: HitAction): void {
    if (!(HIT_ACTIONS as readonly string[]).includes(action)) return;
    let day: number;
    try {
      day = utcDay(this.clock.now());
    } catch {
      day = 0;
    }
    this.merge({ day, key, action, hits: 1 });
  }

  private merge(row: HitRow): void {
    const k = rowKey(row.day, row.key, row.action);
    const held = this.rows.get(k);
    if (held !== undefined) held.hits += row.hits;
    else if (this.rows.size < FILTER_COUNTER_ROWS_MAX) this.rows.set(k, { ...row });
  }

  /** The held rows, emptied. */
  drain(): HitRow[] {
    const out = [...this.rows.values()];
    this.rows.clear();
    return out;
  }

  /** Put rows back (a flush failed), adding to what has been counted since. */
  restore(rows: readonly HitRow[]): void {
    for (const r of rows) this.merge(r);
  }

  size(): number {
    return this.rows.size;
  }
}

/** A sink in memory: what a kit without a store method for the counts uses, and what the tests use. */
export class MemoryHitSink implements FilterHitSink {
  private readonly rows = new Map<string, HitRow>();

  add(rows: readonly HitRow[]): void {
    for (const r of rows) {
      const k = rowKey(r.day, r.key, r.action);
      const held = this.rows.get(k);
      if (held !== undefined) held.hits += r.hits;
      else this.rows.set(k, { ...r });
    }
  }

  list(from: number, to: number): HitRow[] {
    return [...this.rows.values()].filter((r) => r.day >= from && r.day <= to).map((r) => ({ ...r })).sort((a, b) => a.day - b.day || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || (a.action < b.action ? -1 : 1));
  }
}

export interface FilterKeyCounts {
  count: number;
  flag: number;
  mask: number;
  refuse: number;
  flag_capped: number;
}

/**
 * What `cw.filters.stats` returns: per key, the counts by applied action over the last `days` UTC days (today included).
 * @experimental
 */
export interface FilterStats {
  days: number;
  keys: Record<string, FilterKeyCounts>;
}

/** Sum rows into stats over `days` days ending on `today`. Keys come back in order. */
export function summarizeHits(rows: readonly HitRow[], today: number, days: number): FilterStats {
  const from = today - days + 1;
  const keys: Record<string, FilterKeyCounts> = {};
  for (const r of rows) {
    if (r.day < from || r.day > today) continue;
    const c = (keys[r.key] ??= { count: 0, flag: 0, mask: 0, refuse: 0, flag_capped: 0 });
    c[r.action] += r.hits;
  }
  const sorted: Record<string, FilterKeyCounts> = {};
  for (const k of Object.keys(keys).sort()) sorted[k] = keys[k]!;
  return { days, keys: sorted };
}

export interface FilterHitsDeps {
  clock: Clock;
  logger: Logger | undefined;
  sink: FilterHitSink;
  /** Default 30 000. */
  intervalMs?: number;
}

/** The counters, their flush to a sink, the 30 second timer, and the stats read. Owned by the facade. */
export class FilterHits {
  private readonly counters: FilterCounters;
  private readonly warn: ThrottledWarn;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  /** The flush in progress: a second call waits for it, so a row is never written twice. */
  private flushing: Promise<void> = Promise.resolve();

  private readonly deps: FilterHitsDeps;

  constructor(deps: FilterHitsDeps) {
    this.deps = deps;
    this.counters = new FilterCounters(deps.clock);
    this.warn = new ThrottledWarn(deps.logger, deps.clock);
  }

  /** Count one hit. The first count starts the timer (a kit whose filters never act never has one); after `close` it does not. */
  count(hit: { key: string; action: HitAction }): void {
    this.counters.add(hit.key, hit.action);
    if (this.timer === undefined && !this.closed) this.start();
  }

  /** Start the timer; it never keeps the process alive. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.flush(), this.deps.intervalMs ?? FILTER_FLUSH_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Write what is held. A failing sink is logged by class and the rows are kept for the next flush. Never throws. */
  flush(): Promise<void> {
    const next = this.flushing.then(() => this.flushOnce());
    this.flushing = next;
    return next;
  }

  private async flushOnce(): Promise<void> {
    const rows = this.counters.drain();
    if (rows.length === 0) return;
    try {
      await this.deps.sink.add(rows);
    } catch (err) {
      this.counters.restore(rows);
      this.warn.warn('chatwarden.filter_flush_failed', { error: errorClass(err) });
    }
  }

  /** This process's counts are written first, then the window is read. A failing read is the caller's. */
  async stats(days: 7 | 30): Promise<FilterStats> {
    await this.flush();
    const today = utcDay(this.deps.clock.now());
    const rows = await this.deps.sink.list(today - days + 1, today);
    return summarizeHits(rows, today, days);
  }

  /** Stop the timer and write what is held. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}
