// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The AI's code is fetched on demand through one seam (`aiLoaders`). A failed fetch leaves the hub as it is without the AI and is NOT
// remembered: the next time the hub looks (a refresh of the queue), it tries again.

type Load = typeof import('../src/ai/load.js');
type Core = Awaited<ReturnType<Load['aiLoaders']['core']>>;
const fakeCore = { marker: 'core' } as unknown as Core;

/** A fresh copy of the module (it keeps what it fetched). */
async function fresh(): Promise<Load> {
  vi.resetModules();
  return import('../src/ai/load.js');
}

beforeEach(() => vi.resetModules());

describe('ensureAi', () => {
  it('fetches once and keeps what it got, however many ask, together or after', async () => {
    const m = await fresh();
    let calls = 0;
    m.aiLoaders.core = async () => {
      calls += 1;
      return fakeCore;
    };
    const [a, b] = await Promise.all([m.ensureAi(), m.ensureAi()]);
    expect(a).toBe(fakeCore);
    expect(b).toBe(fakeCore);
    expect(await m.ensureAi()).toBe(fakeCore);
    expect(calls).toBe(1);
  });

  it('a failed fetch gives null, and does not throw', async () => {
    const m = await fresh();
    m.aiLoaders.core = () => Promise.reject(new Error('offline'));
    await expect(m.ensureAi()).resolves.toBeNull();
  });

  it('a failed fetch is tried again on the next ask, and then kept', async () => {
    const m = await fresh();
    let calls = 0;
    m.aiLoaders.core = async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return fakeCore;
    };
    expect(await m.ensureAi()).toBeNull();
    expect(await m.ensureAi()).toBe(fakeCore);
    expect(await m.ensureAi()).toBe(fakeCore);
    expect(calls).toBe(2);
  });

  it('askers that were waiting together on a failure all get null, and the one after them fetches', async () => {
    const m = await fresh();
    let calls = 0;
    m.aiLoaders.core = async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return fakeCore;
    };
    const together = await Promise.all([m.ensureAi(), m.ensureAi(), m.ensureAi()]);
    expect(together).toEqual([null, null, null]);
    expect(calls).toBe(1);
    expect(await m.ensureAi()).toBe(fakeCore);
  });

  it('exports only what the hub uses: the seam and ensureAi', async () => {
    const m = await fresh();
    expect(Object.keys(m).sort()).toEqual(['aiLoaders', 'ensureAi']);
  });
});

describe('the queue\'s ranking loader', () => {
  it('a refresh after a failed fetch loads the ranking, and the list is ranked from then on', async () => {
    const load = await fresh();
    const queue = await import('../src/queue.js');
    let calls = 0;
    load.aiLoaders.core = async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      await import('../src/ai/rank.js');
      return fakeCore;
    };
    queue.setRankLoader(load.ensureAi);
    await queue.loadRanker();
    expect(queue.hasRanker()).toBe(false);
    await queue.loadRanker();
    expect(queue.hasRanker()).toBe(true);
    expect(calls).toBe(2);
  });

  it('with no loader set it fetches the ranking alone (headless adopters)', async () => {
    const queue = await fresh().then(() => import('../src/queue.js'));
    expect(queue.hasRanker()).toBe(false);
    await queue.loadRanker();
    expect(queue.hasRanker()).toBe(true);
  });

  // The module's own call to setRanker is a side effect of evaluating it, which a bundler that trusts `sideEffects` may drop: the loaders install
  // the ranking themselves, so the order never depends on module evaluation.
  it('loadRanker installs the ranking itself, even when the module was already evaluated', async () => {
    const queue = await fresh().then(() => import('../src/queue.js'));
    await import('../src/ai/rank.js');
    queue.setRanker(null);
    expect(queue.hasRanker()).toBe(false);
    await queue.loadRanker();
    expect(queue.hasRanker()).toBe(true);
  });

  it('loadAiRank installs the ranking too', async () => {
    const queue = await fresh().then(() => import('../src/queue.js'));
    await import('../src/ai/rank.js');
    queue.setRanker(null);
    const rank = await queue.loadAiRank();
    expect(typeof rank.priorityScore).toBe('function');
    expect(queue.hasRanker()).toBe(true);
  });

  it('a loader that gave nothing (the fetch failed) installs nothing', async () => {
    const queue = await fresh().then(() => import('../src/queue.js'));
    await import('../src/ai/rank.js');
    queue.setRanker(null);
    queue.setRankLoader(() => Promise.resolve(null));
    await queue.loadRanker();
    expect(queue.hasRanker()).toBe(false);
  });
});
