import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAppeals } from '@chatwarden/store-memory';
import type { OverturnInput } from '../src/types.js';
import { DAY, NOW, world } from './reportingWorld.js';

// `cw.terms.reviewFlags` (0.2.1): the terms whose automatic restrictions were overturned on appeal often enough that someone should look at the term. Read from the
// overturn rows, never from the strikes, so a purge of strikes does not change it. Staff only; a term id, never the term text.

async function kit(store: MemoryStore = withMemoryAppeals(new MemoryStore())) {
  const w = await world({}, store);
  const store2 = store as ReturnType<typeof withMemoryAppeals<MemoryStore>>;
  let n = 0;
  /** One overturned group of `termId` at `at` (a distinct group each call). */
  const overturn = (termId: string | null, at: number, over: Partial<OverturnInput> = {}): void => {
    n += 1;
    store2.recordOverturn({ groupId: `g${n}`, at, subject: 's_a', aliases: ['s_a'], source: 'auto_filter', termId, filterKey: null, reportId: null, strikes: null, ...over });
  };
  return { ...w, store: store2, overturn };
}

describe('which terms are flagged', () => {
  it('a term overturned in two groups inside 90 days is flagged with overturned 2 and the later lastAt; one overturn is not (default min 2)', async () => {
    const k = await kit();
    k.overturn('syn:zorbak', NOW - 10 * DAY);
    k.overturn('syn:zorbak', NOW - 2 * DAY);
    k.overturn('syn:vlemmo', NOW - 1 * DAY);
    expect(k.cw.terms.reviewFlags()).toEqual([{ termId: 'syn:zorbak', overturned: 2, lastAt: NOW - 2 * DAY }]);
    expect(k.cw.terms.reviewFlags({})).toEqual(k.cw.terms.reviewFlags());
  });

  it('min: 1 flags a single overturn; min 3 does not flag two', async () => {
    const k = await kit();
    k.overturn('syn:zorbak', NOW - DAY);
    k.overturn('syn:vlemmo', NOW - DAY);
    k.overturn('syn:vlemmo', NOW - DAY);
    expect(k.cw.terms.reviewFlags({ min: 1 }).map((r) => r.termId)).toEqual(['syn:vlemmo', 'syn:zorbak']);
    expect(k.cw.terms.reviewFlags({ min: 2 }).map((r) => r.termId)).toEqual(['syn:vlemmo']);
    expect(k.cw.terms.reviewFlags({ min: 3 })).toEqual([]);
  });

  it('the window: a row exactly at the start counts, one ms older does not; days narrows it', async () => {
    const k = await kit();
    const start = NOW - 90 * DAY;
    k.overturn('syn:edge', start);
    k.overturn('syn:edge', start - 1);
    k.overturn('syn:edge', start + 1);
    // one at the start and one after it: two inside; the one a ms older is out
    expect(k.cw.terms.reviewFlags()).toEqual([{ termId: 'syn:edge', overturned: 2, lastAt: start + 1 }]);
    expect(k.cw.terms.reviewFlags({ days: 30 })).toEqual([]);
    expect(k.cw.terms.reviewFlags({ days: 91, min: 3 })).toEqual([{ termId: 'syn:edge', overturned: 3, lastAt: start + 1 }]);
    // 1 day and 365 days are accepted
    expect(k.cw.terms.reviewFlags({ days: 1 })).toEqual([]);
    expect(k.cw.terms.reviewFlags({ days: 365, min: 1 })).toHaveLength(1);
  });

  it('rows with no term are not flagged, however many', async () => {
    const k = await kit();
    for (let i = 0; i < 5; i += 1) k.overturn(null, NOW - DAY, { filterKey: 'link.unlisted' });
    expect(k.cw.terms.reviewFlags({ min: 1 })).toEqual([]);
  });

  it('a term overturned only after its strikes were purged is still flagged (the flag reads the overturn rows, never the strikes)', async () => {
    const k = await kit();
    k.store.insertStrike({ id: 'k1', at: NOW - 100 * DAY, subject: 's_a', roomId: 'R', termId: 'syn:zorbak', rawLine: 'x' });
    expect(k.store.purgeStrikes(NOW - 30 * DAY)).toBe(1);
    expect(k.store.loadStrikes(0)).toEqual([]);
    k.overturn('syn:zorbak', NOW - DAY);
    k.overturn('syn:zorbak', NOW - 2 * DAY);
    expect(k.cw.terms.reviewFlags()).toEqual([{ termId: 'syn:zorbak', overturned: 2, lastAt: NOW - DAY }]);
  });

  it('follows the injected clock: the window moves with it', async () => {
    const k = await kit();
    k.overturn('syn:zorbak', NOW - 89 * DAY);
    k.overturn('syn:zorbak', NOW - 88 * DAY);
    expect(k.cw.terms.reviewFlags()).toHaveLength(1);
    k.clock.t = NOW + 2 * DAY;
    expect(k.cw.terms.reviewFlags()).toEqual([]);
  });
});

describe('the order', () => {
  it('overturned descending, then lastAt descending, then termId', async () => {
    const k = await kit();
    for (let i = 0; i < 3; i += 1) k.overturn('syn:a-three', NOW - DAY - i);
    for (const [term, last] of [['syn:b-two', 300], ['syn:c-two', 200], ['syn:d-two', 200]] as const) {
      k.overturn(term, NOW - DAY * 3);
      k.overturn(term, NOW - last);
    }
    expect(k.cw.terms.reviewFlags().map((r) => [r.termId, r.overturned])).toEqual([
      ['syn:a-three', 3],
      ['syn:c-two', 2],
      ['syn:d-two', 2],
      ['syn:b-two', 2],
    ]);
  });

  it('a result is a copy: changing it changes nothing the next read returns, and it holds a term id, never text', async () => {
    const k = await kit();
    k.overturn('syn:zorbak', NOW - DAY);
    k.overturn('syn:zorbak', NOW - DAY);
    const first = k.cw.terms.reviewFlags();
    expect(Object.keys(first[0] ?? {}).sort()).toEqual(['lastAt', 'overturned', 'termId']);
    first[0]!.overturned = 99;
    first.length = 0;
    expect(k.cw.terms.reviewFlags()).toEqual([{ termId: 'syn:zorbak', overturned: 2, lastAt: NOW - DAY }]);
  });
});

describe('what is refused', () => {
  it('days outside 1..365, a fraction, a string, NaN or null; min 0, 1001, a fraction, a string or null: RangeError naming terms.reviewFlags', async () => {
    const k = await kit();
    const bad: Array<{ days?: unknown; min?: unknown }> = [
      { days: 0 }, { days: 366 }, { days: -1 }, { days: 1.5 }, { days: '7' }, { days: Number.NaN }, { days: Number.POSITIVE_INFINITY }, { days: null },
      { min: 0 }, { min: 1001 }, { min: -1 }, { min: 2.5 }, { min: '2' }, { min: Number.NaN }, { min: null },
    ];
    for (const q of bad) {
      expect(() => k.cw.terms.reviewFlags(q as never), JSON.stringify(q)).toThrow(RangeError);
      expect(() => k.cw.terms.reviewFlags(q as never), JSON.stringify(q)).toThrow(/^terms\.reviewFlags: /);
    }
    // the edges are accepted
    for (const q of [{ days: 1 }, { days: 365 }, { min: 1 }, { min: 1000 }, { days: 365, min: 1000 }]) expect(() => k.cw.terms.reviewFlags(q)).not.toThrow();
  });

  it('an empty store method (a store without overturnedTermCounts) gives []', async () => {
    const base = new MemoryStore();
    const k = await kit(base as never);
    expect(k.cw.terms.reviewFlags()).toEqual([]);
    const bare = await world({}, withMemoryAppeals(new MemoryStore()));
    (bare.store as unknown as { overturnedTermCounts?: unknown }).overturnedTermCounts = undefined;
    expect(bare.cw.terms.reviewFlags({ min: 1 })).toEqual([]);
  });

  it('a store that throws on the read is the caller\'s: it is not swallowed', async () => {
    const k = await kit();
    (k.store as unknown as { overturnedTermCounts: () => never }).overturnedTermCounts = () => {
      throw new Error('store boom');
    };
    expect(() => k.cw.terms.reviewFlags()).toThrow('store boom');
  });
});
