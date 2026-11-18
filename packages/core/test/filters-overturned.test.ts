import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAppeals } from '@chatwarden/store-memory';
import type { OverturnInput } from '../src/types.js';
import { DAY, NOW, world } from './reportingWorld.js';

// `cw.filters.overturned` (0.2.1): per filter key, how many decisions that came from one of its reports were overturned on appeal. Read from the overturn rows. A key
// with none is absent, and the answer is an object with no prototype, so a key such as `__proto__` is only a key.

async function kit() {
  const store = withMemoryAppeals(new MemoryStore());
  const w = await world({}, store);
  let n = 0;
  const overturn = (filterKey: string | null, at: number, over: Partial<OverturnInput> = {}): void => {
    n += 1;
    store.recordOverturn({ groupId: `g${n}`, at, subject: 's_a', aliases: ['s_a'], source: 'moderator', termId: null, filterKey, reportId: null, strikes: null, ...over });
  };
  return { ...w, store, overturn };
}

describe('cw.filters.overturned', () => {
  it('counts per filter key over 90 days by default; a key with none is absent; days 7 and 30 narrow it; other values are a RangeError', async () => {
    const k = await kit();
    k.overturn('link.unlisted', NOW - DAY);
    k.overturn('link.unlisted', NOW - 20 * DAY);
    k.overturn('link.unlisted', NOW - 80 * DAY);
    k.overturn('caps.shout', NOW - 5 * DAY);
    k.overturn('old.key', NOW - 91 * DAY);
    k.overturn(null, NOW - DAY, { termId: 'syn:zorbak' });
    expect({ ...k.cw.filters.overturned() }).toEqual({ 'link.unlisted': 3, 'caps.shout': 1 });
    expect({ ...k.cw.filters.overturned({}) }).toEqual({ ...k.cw.filters.overturned() });
    expect({ ...k.cw.filters.overturned({ days: 90 }) }).toEqual({ 'link.unlisted': 3, 'caps.shout': 1 });
    expect({ ...k.cw.filters.overturned({ days: 30 }) }).toEqual({ 'link.unlisted': 2, 'caps.shout': 1 });
    expect({ ...k.cw.filters.overturned({ days: 7 }) }).toEqual({ 'link.unlisted': 1, 'caps.shout': 1 });
    expect(Object.keys(k.cw.filters.overturned({ days: 7 })).sort()).toEqual(['caps.shout', 'link.unlisted']);
    for (const days of [0, 1, 14, 60, 91, 365, 7.5, '7', null, Number.NaN]) {
      expect(() => k.cw.filters.overturned({ days } as never), String(days)).toThrow(RangeError);
    }
    expect(() => k.cw.filters.overturned({ days: 7 })).not.toThrow();
  });

  it('the window includes a row exactly at its start and leaves out one a millisecond older', async () => {
    const k = await kit();
    k.overturn('edge.key', NOW - 7 * DAY);
    k.overturn('edge.key', NOW - 7 * DAY - 1);
    expect({ ...k.cw.filters.overturned({ days: 7 }) }).toEqual({ 'edge.key': 1 });
  });

  it('is an object with no prototype: a key named __proto__ is just a key', async () => {
    const k = await kit();
    k.overturn('__proto__', NOW - DAY);
    k.overturn('constructor', NOW - DAY);
    k.overturn('toString', NOW - DAY);
    const got = k.cw.filters.overturned();
    expect(Object.getPrototypeOf(got)).toBeNull();
    expect(Object.keys(got).sort()).toEqual(['__proto__', 'constructor', 'toString']);
    expect(got['__proto__']).toBe(1);
    expect(got['constructor']).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(got, 'valueOf')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keys with a zero count are absent, even when a store reports one', async () => {
    const k = await kit();
    (k.store as unknown as { overturnedFilterCounts: () => Array<{ filterKey: string; overturned: number }> }).overturnedFilterCounts = () => [
      { filterKey: 'a.key', overturned: 0 },
      { filterKey: 'b.key', overturned: 2 },
    ];
    expect({ ...k.cw.filters.overturned() }).toEqual({ 'b.key': 2 });
  });

  it('is empty for a store without the method, and for an empty store', async () => {
    const k = await kit();
    expect({ ...k.cw.filters.overturned() }).toEqual({});
    (k.store as unknown as { overturnedFilterCounts?: unknown }).overturnedFilterCounts = undefined;
    expect({ ...k.cw.filters.overturned({ days: 30 }) }).toEqual({});
    expect(Object.getPrototypeOf(k.cw.filters.overturned())).toBeNull();
  });

  it('counts groups, not appeals or strikes: two overturns of one filter key in one day are 2', async () => {
    const k = await kit();
    k.overturn('link.unlisted', NOW - 10);
    k.overturn('link.unlisted', NOW - 5);
    expect({ ...k.cw.filters.overturned({ days: 7 }) }).toEqual({ 'link.unlisted': 2 });
  });
});
