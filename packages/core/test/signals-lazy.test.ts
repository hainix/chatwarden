import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, withMemorySignals } from '@chatwarden/store-memory';
import type { RawWho } from '../src/types.js';

// The signal service is loaded on demand: `createChatwarden` imports it (a dynamic import, so a bundler can leave it out of a build that has no
// signal store) only for a store that keeps signals. A store without the three methods gets an inert `cw.signals` and never loads it.

const state = vi.hoisted(() => ({ loads: 0 }));

const KINDS = { muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const } };

async function kit(store: MemoryStore, overrides: Record<string, unknown> = {}) {
  const { createChatwarden } = await import('../src/chatwarden.js');
  const logged: string[] = [];
  const cw = await createChatwarden({
    store,
    secret: 'lazy-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    retention: false,
    logger: { warn: (e) => void logged.push(e) },
    overrides: overrides as never,
  });
  return { cw, logged };
}

beforeEach(() => {
  vi.resetModules();
  state.loads = 0;
  // Registered afresh for every test, so the factory runs (and the counter moves) whenever the module is asked for in that test.
  vi.doMock('../src/signalService.js', async () => {
    state.loads += 1;
    return await vi.importActual('../src/signalService.js');
  });
});

describe('the signal service is loaded on demand', () => {
  it('a plain in-memory store (no signal methods) never loads it, and cw.signals is inert', async () => {
    const { cw, logged } = await kit(new MemoryStore());
    expect(state.loads).toBe(0);
    cw.rooms.seat('r', 'a', { clientKey: 'k' }, 'A');
    const subject = cw.rooms.subjectAt('r', 'a')!;
    expect(cw.signals.record({ kind: 'flood_triggered', subject })).toBe(false);
    expect(cw.signals.record({ kind: 'flood_triggered', subject })).toBe(false);
    expect(logged.filter((e) => e === 'chatwarden.signals_store_unsupported')).toHaveLength(1);
    expect(cw.signals.counts(subject)).toEqual([]);
    expect(cw.signals.forRecord(subject)).toEqual([]);
    expect(cw.signals.boosted([subject])).toEqual(new Set());
    expect(cw.signals.kinds().map((k) => k.kind)).toEqual(['flood_triggered']);
    expect(state.loads).toBe(0);
  });

  it('the inert answer also holds for suggest and take-next: no hits, no boost, no read', async () => {
    const { cw } = await kit(new MemoryStore());
    cw.rooms.seat('r', 'a', { clientKey: 'k' }, 'A');
    const subject = cw.rooms.subjectAt('r', 'a')!;
    expect(cw.suggest(subject, 'rude', 2)).not.toHaveProperty('signals');
    expect(cw.cases.next('mod-a', { signalBoost: true })).toBeNull();
    expect(state.loads).toBe(0);
  });

  it('a store with the signal methods loads it once, and cw.signals records and counts', async () => {
    const { cw } = await kit(withMemorySignals(new MemoryStore()), { signals: { kinds: KINDS } });
    expect(state.loads).toBe(1);
    cw.rooms.seat('r', 'a', { clientKey: 'k-a' }, 'A');
    cw.rooms.seat('r', 'b', { clientKey: 'k-b' }, 'B');
    const subject = cw.rooms.subjectAt('r', 'a')!;
    expect(cw.signals.record({ kind: 'muted_by_player', subject, by: { clientKey: 'k-b' } })).toBe(true);
    expect(cw.signals.counts(subject)).toMatchObject([{ kind: 'muted_by_player', distinct: 1 }]);
  });

  it('a store with the methods and nothing declared (pacing only) loads it too, so flood_triggered is recorded', async () => {
    const { cw } = await kit(withMemorySignals(new MemoryStore()));
    expect(state.loads).toBe(1);
    cw.rooms.seat('r', 'a', { clientKey: 'k-a' }, 'A');
    expect(cw.signals.record({ kind: 'flood_triggered', subject: cw.rooms.subjectAt('r', 'a')! })).toBe(true);
  });

  it('declaring kinds over a store without the methods is refused before anything is loaded', async () => {
    await expect(kit(new MemoryStore(), { signals: { kinds: KINDS } })).rejects.toThrow(/signal methods/);
    expect(state.loads).toBe(0);
  });

  it('a store with only some of the methods counts as having none (the kit needs all three)', async () => {
    const store = new MemoryStore();
    Object.defineProperty(store, 'insertSignal', { value: () => true });
    const { cw } = await kit(store);
    expect(state.loads).toBe(0);
    expect(cw.signals.counts('s_x')).toEqual([]);
  });
});
