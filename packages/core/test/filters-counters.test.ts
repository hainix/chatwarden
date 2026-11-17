import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterCounters, FilterHits, MemoryHitSink, summarizeHits, utcDay, type FilterHitSink, type HitRow } from '../src/filters/counters.js';
import type { Logger } from '../src/types.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const clock = (start = NOW) => {
  const c = { t: start, now: () => c.t };
  return c;
};
const row = (day: number, key: string, action: HitRow['action'], hits: number): HitRow => ({ day, key, action, hits });

describe('counters', () => {
  it('one increment per hit by day, key and action', () => {
    const c = clock();
    const counters = new FilterCounters(c);
    counters.add('link.unlisted', 'count');
    counters.add('link.unlisted', 'count');
    counters.add('link.unlisted', 'refuse');
    counters.add('phrase.ads', 'flag');
    const day = utcDay(NOW);
    expect(counters.drain()).toEqual([row(day, 'link.unlisted', 'count', 2), row(day, 'link.unlisted', 'refuse', 1), row(day, 'phrase.ads', 'flag', 1)]);
  });

  it('a new UTC day is a new row', () => {
    const c = clock(Math.floor(NOW / DAY) * DAY + DAY - 1000);
    const counters = new FilterCounters(c);
    counters.add('ratio.caps', 'count');
    c.t += 2000;
    counters.add('ratio.caps', 'count');
    const rows = counters.drain();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.day).toBe(rows[0]!.day + 1);
  });

  it('drain empties the counters; an empty drain is an empty list', () => {
    const counters = new FilterCounters(clock());
    expect(counters.drain()).toEqual([]);
    counters.add('link.deny', 'mask');
    expect(counters.size()).toBe(1);
    expect(counters.drain()).toHaveLength(1);
    expect(counters.size()).toBe(0);
    expect(counters.drain()).toEqual([]);
  });

  it('restore puts rows back, adding to what has been counted since', () => {
    const counters = new FilterCounters(clock());
    counters.add('link.deny', 'mask');
    const rows = counters.drain();
    counters.add('link.deny', 'mask');
    counters.restore(rows);
    expect(counters.drain()).toEqual([row(utcDay(NOW), 'link.deny', 'mask', 2)]);
  });

  it('flag_capped is a count of its own; an unknown action is ignored', () => {
    const counters = new FilterCounters(clock());
    counters.add('link.unlisted', 'flag_capped');
    counters.add('link.unlisted', 'bogus' as never);
    expect(counters.drain()).toEqual([row(utcDay(NOW), 'link.unlisted', 'flag_capped', 1)]);
  });

  it('a row holds no person, room or text: only day, key, action and hits', () => {
    const counters = new FilterCounters(clock());
    counters.add('personal_info.phone', 'refuse');
    expect(Object.keys(counters.drain()[0]!).sort()).toEqual(['action', 'day', 'hits', 'key']);
  });

  it('the number of distinct rows is bounded, and going over never throws', () => {
    const counters = new FilterCounters(clock());
    for (let i = 0; i < 20_000; i++) counters.add(`phrase.k${i}`, 'count');
    expect(counters.size()).toBeLessThanOrEqual(5000);
    counters.add('phrase.k0', 'count');
    expect(() => counters.drain()).not.toThrow();
  });

  it('a clock that throws counts into day 0 and never throws', () => {
    const counters = new FilterCounters({ now: () => { throw new Error('x'); } });
    expect(() => counters.add('link.deny', 'count')).not.toThrow();
  });
});

describe('summarize', () => {
  it('sums by key and action over the window, oldest day excluded', () => {
    const today = utcDay(NOW);
    const rows = [row(today, 'link.unlisted', 'count', 3), row(today, 'link.unlisted', 'refuse', 1), row(today - 6, 'link.unlisted', 'count', 2), row(today - 7, 'link.unlisted', 'count', 100), row(today, 'phrase.ads', 'flag', 4)];
    expect(summarizeHits(rows, today, 7)).toEqual({
      days: 7,
      keys: {
        'link.unlisted': { count: 5, flag: 0, mask: 0, refuse: 1, flag_capped: 0 },
        'phrase.ads': { count: 0, flag: 4, mask: 0, refuse: 0, flag_capped: 0 },
      },
    });
    expect(summarizeHits(rows, today, 30).keys['link.unlisted']!.count).toBe(105);
  });

  it('an empty window is an empty summary', () => {
    expect(summarizeHits([], utcDay(NOW), 7)).toEqual({ days: 7, keys: {} });
  });
});

describe('FilterHits (the flush, the timer, stats and close)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (sink: FilterHitSink = new MemoryHitSink(), logger?: Logger) => {
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = logger ?? { warn: (e, d) => void logs.push([e, d]) };
    const c = clock();
    const hits = new FilterHits({ clock: c, logger: log, sink });
    return { hits, logs, c, sink };
  };

  it('the timer flushes every 30 seconds', async () => {
    const added: HitRow[][] = [];
    const sink: FilterHitSink = { add: (rows) => void added.push([...rows]), list: () => [] };
    const { hits } = make(sink);
    hits.start();
    hits.count({ key: 'link.unlisted', action: 'count' });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(added).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(added).toHaveLength(1);
    expect(added[0]).toEqual([row(utcDay(NOW), 'link.unlisted', 'count', 1)]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(added).toHaveLength(1);
    await hits.close();
  });

  it('close flushes what is pending and stops the timer', async () => {
    const added: HitRow[][] = [];
    const sink: FilterHitSink = { add: (rows) => void added.push([...rows]), list: () => [] };
    const { hits } = make(sink);
    hits.start();
    hits.count({ key: 'link.deny', action: 'refuse' });
    await hits.close();
    expect(added).toHaveLength(1);
    hits.count({ key: 'link.deny', action: 'refuse' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(added).toHaveLength(1);
  });

  it('the timer never keeps the process alive (unref)', () => {
    const { hits } = make();
    hits.start();
    expect(vi.getTimerCount()).toBe(1);
    void hits.close();
  });

  it('nothing pending is not a sink call', async () => {
    const add = vi.fn();
    const { hits } = make({ add, list: () => [] });
    await hits.flush();
    expect(add).not.toHaveBeenCalled();
  });

  it('stats flushes this process first, then reads the window', async () => {
    const { hits } = make();
    hits.count({ key: 'link.unlisted', action: 'count' });
    hits.count({ key: 'link.unlisted', action: 'flag_capped' });
    const stats = await hits.stats(7);
    expect(stats).toEqual({ days: 7, keys: { 'link.unlisted': { count: 1, flag: 0, mask: 0, refuse: 0, flag_capped: 1 } } });
    hits.count({ key: 'link.unlisted', action: 'count' });
    expect((await hits.stats(30)).keys['link.unlisted']!.count).toBe(2);
  });

  it('a failing flush is logged by class, keeps the counts and retries on the next flush', async () => {
    let fail = true;
    const stored: HitRow[] = [];
    const sink: FilterHitSink = {
      add: (rows) => {
        if (fail) throw new RangeError('disk gone: zorbak.com');
        stored.push(...rows);
      },
      list: () => stored,
    };
    const { hits, logs } = make(sink);
    hits.count({ key: 'link.unlisted', action: 'count' });
    await expect(hits.flush()).resolves.toBeUndefined();
    expect(logs).toEqual([['chatwarden.filter_flush_failed', { error: 'RangeError' }]]);
    expect(stored).toEqual([]);
    hits.count({ key: 'link.unlisted', action: 'count' });
    fail = false;
    await hits.flush();
    expect(stored).toEqual([row(utcDay(NOW), 'link.unlisted', 'count', 2)]);
    expect(JSON.stringify(logs)).not.toContain('zorbak');
  });

  it('a sink that rejects is handled the same way', async () => {
    let fail = true;
    const stored: HitRow[] = [];
    const sink: FilterHitSink = {
      add: async (rows) => {
        if (fail) throw new TypeError('x');
        stored.push(...rows);
      },
      list: () => stored,
    };
    const { hits, logs } = make(sink);
    hits.count({ key: 'phrase.ads', action: 'flag' });
    await hits.flush();
    expect(logs.map((l) => l[0])).toEqual(['chatwarden.filter_flush_failed']);
    fail = false;
    await hits.flush();
    expect(stored).toHaveLength(1);
  });

  it('a failing timer flush is logged at most once a minute', async () => {
    const sink: FilterHitSink = {
      add: () => {
        throw new Error('x');
      },
      list: () => [],
    };
    const { hits, logs } = make(sink);
    hits.start();
    hits.count({ key: 'link.unlisted', action: 'count' });
    // The fake timers move their own clock, not the injected one: the throttle reads the injected one.
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(logs.length).toBe(1);
    await hits.close();
  });

  it('two flushes at once do not count a row twice', async () => {
    const stored: HitRow[] = [];
    const sink: FilterHitSink = {
      add: async (rows) => {
        await Promise.resolve();
        stored.push(...rows);
      },
      list: () => stored,
    };
    const { hits } = make(sink);
    hits.count({ key: 'link.unlisted', action: 'count' });
    await Promise.all([hits.flush(), hits.flush(), hits.flush()]);
    expect(stored.reduce((n, r) => n + r.hits, 0)).toBe(1);
  });

  it('the memory sink adds up rows with the same day, key and action', async () => {
    const sink = new MemoryHitSink();
    await sink.add([row(1, 'a', 'count', 2)]);
    await sink.add([row(1, 'a', 'count', 3), row(2, 'a', 'count', 1)]);
    expect(await sink.list(1, 2)).toEqual([row(1, 'a', 'count', 5), row(2, 'a', 'count', 1)]);
    expect(await sink.list(2, 2)).toEqual([row(2, 'a', 'count', 1)]);
  });
});
