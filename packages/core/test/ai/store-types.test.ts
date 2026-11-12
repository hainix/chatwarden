import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAi } from '@chatwarden/store-memory';
import { purge, RETENTION_DEFAULTS } from '../../src/retention.js';
import type { PurgeResult } from '../../src/retention.js';
import type { Store } from '../../src/types.js';

// The optional AI methods of the Store (design section 5) as the core sees them: a store without them is still a Store, and
// `purge` drives them (and only them) when they exist. The behaviour of the methods is the shared contract suite's.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const AI_METHODS = [
  'reserveAiRead',
  'completeAiRead',
  'failAiRead',
  'loadAiRead',
  'loadAiReads',
  'listAiRetries',
  'aiSpendSince',
  'insertAiOutcome',
  'loadAiOutcome',
  'markAiOutcome',
  'aiExamples',
  'aiTeachableCount',
  'aiStats',
  'loadAiReadById',
  'loadAiReadFor',
  'purgeAi',
] as const;

/** A store the way a custom adapter written before the AI looks: every AI method is absent. */
function withoutAi(): Store {
  const store = withMemoryAi(new MemoryStore());
  for (const m of AI_METHODS) Object.defineProperty(store, m, { value: undefined });
  return store;
}

describe('the AI Store methods are optional', () => {
  it('a store without them is still a valid Store (this is a compile-time check as much as a runtime one)', () => {
    const custom: Store = withoutAi();
    for (const m of AI_METHODS) expect(custom[m]).toBeUndefined();
  });

  it('the first-party memory store has all of them', () => {
    const store: Store = withMemoryAi(new MemoryStore());
    for (const m of AI_METHODS) expect(typeof store[m]).toBe('function');
  });
});

describe('purge and the AI rows', () => {
  it('a store without AI methods purges as before, with 0 AI rows', async () => {
    const res: PurgeResult = await purge(withoutAi(), NOW);
    expect(res).toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 0, audit: 0, webhookKeys: 0, aiReads: 0, aiOutcomes: 0, signals: 0, appeals: 0, appealStatements: 0, blockedNames: 0, appealsClosed: 0 });
  });

  it('passes the three cutoffs: reads with the report window, outcomes and examples with their own', async () => {
    const store = withMemoryAi(new MemoryStore());
    const seen: number[][] = [];
    store.purgeAi = (a, b, c) => {
      seen.push([a, b, c]);
      return { reads: 4, outcomes: 2 };
    };
    const res = await purge(store, NOW);
    expect(seen).toEqual([[NOW - RETENTION_DEFAULTS.reportsMs, NOW - 365 * DAY, NOW - 180 * DAY]]);
    expect(res).toMatchObject({ aiReads: 4, aiOutcomes: 2 });
  });

  it('honours a custom policy field by field', async () => {
    const store = withMemoryAi(new MemoryStore());
    const seen: number[][] = [];
    store.purgeAi = (a, b, c) => {
      seen.push([a, b, c]);
      return { reads: 0, outcomes: 0 };
    };
    await purge(store, NOW, { reportsMs: 10 * DAY, aiOutcomesMs: 100 * DAY, aiExamplesMs: 0 });
    expect(seen).toEqual([[NOW - 10 * DAY, NOW - 100 * DAY, NOW]]);
    await purge(store, NOW, { aiExamplesMs: 7 * DAY });
    expect(seen[1]).toEqual([NOW - 90 * DAY, NOW - 365 * DAY, NOW - 7 * DAY]);
  });

  it('runs inside the one purge transaction: a failure in the AI purge undoes the report purge', async () => {
    const store = withMemoryAi(new MemoryStore());
    store.insertReport({
      id: 'old',
      createdAt: NOW - 200 * DAY,
      roomId: 'R',
      tags: {},
      reporterSubject: 's_a',
      reporterSeat: 'p1',
      reporterHandle: 'A',
      targetSubject: 's_b',
      targetSeat: 'p2',
      targetHandle: 'B',
      category: 'harassment',
      note: null,
      lineId: null,
      excerpt: [],
      people: [],
      status: 'open',
    });
    store.purgeAi = () => {
      throw new Error('boom');
    };
    await expect(purge(store, NOW)).rejects.toThrow('boom');
    expect(store.loadReport('old')).not.toBeNull();
  });

  it('does not call the AI purge when the windows are invalid', async () => {
    const store = withMemoryAi(new MemoryStore());
    let calls = 0;
    store.purgeAi = () => {
      calls += 1;
      return { reads: 0, outcomes: 0 };
    };
    await expect(purge(store, NOW, { aiExamplesMs: -1 })).rejects.toThrow(/invalid aiExamplesMs/);
    await expect(purge(store, Number.NaN)).rejects.toThrow('purge: invalid now');
    expect(calls).toBe(0);
  });

  it('the real memory store reports 0 and 0 on an empty store (control)', async () => {
    const res = await purge(withMemoryAi(new MemoryStore()), NOW);
    expect(res.aiReads).toBe(0);
    expect(res.aiOutcomes).toBe(0);
  });
});
