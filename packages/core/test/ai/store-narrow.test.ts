import { describe, expect, expectTypeOf, it } from 'vitest';
import { MemoryStore, withMemoryAi } from '@chatwarden/store-memory';
import { requireAiStore } from '../../src/ai/service.js';
import type { AiStore } from '../../src/ai/worker.js';
import type { Store } from '../../src/types.js';
import { createFakeModerationAI } from '../../src/ai/fake.js';
import { AiService } from '../../src/ai/service.js';
import { PRESETS } from '../../src/profile.js';
import { defineRules, starterRules } from '../../src/rules.js';

// The AI module is handed `AiStore`, not the whole Store (design 6.1). A type-level test (checked by `npm run typecheck`, which builds core's tests):
// none of the writers of a sanction, a decision, a notice, a strike or a mute is a property of it, so the AI module cannot reach one even before the
// lint rule looks. The runtime half proves narrowing costs nothing: the same object, with the AI methods and the two report reads it needs.

describe('AiStore', () => {
  it('has none of the sanction, decision, notice, strike or mute writers', () => {
    expectTypeOf<AiStore>().not.toHaveProperty('insertSanctionGroup');
    expectTypeOf<AiStore>().not.toHaveProperty('revokeSanctionGroup');
    expectTypeOf<AiStore>().not.toHaveProperty('closeReport');
    expectTypeOf<AiStore>().not.toHaveProperty('insertDecision');
    expectTypeOf<AiStore>().not.toHaveProperty('insertNotice');
    expectTypeOf<AiStore>().not.toHaveProperty('withdrawNotice');
    expectTypeOf<AiStore>().not.toHaveProperty('withdrawNoticeGroup');
    expectTypeOf<AiStore>().not.toHaveProperty('insertStrike');
    expectTypeOf<AiStore>().not.toHaveProperty('upsertMute');
    expectTypeOf<AiStore>().not.toHaveProperty('deleteMute');
    expectTypeOf<AiStore>().not.toHaveProperty('pruneMutes');
    expectTypeOf<AiStore>().not.toHaveProperty('closeGap');
    expectTypeOf<AiStore>().not.toHaveProperty('decideAppeal');
    expectTypeOf<AiStore>().not.toHaveProperty('transaction');
    expect(true).toBe(true);
  });

  it('has none of the other writers the lint list names either (policy layers, claims, acks, appeals, new reports, the purges)', () => {
    expectTypeOf<AiStore>().not.toHaveProperty('savePolicyLayer');
    expectTypeOf<AiStore>().not.toHaveProperty('claimCase');
    expectTypeOf<AiStore>().not.toHaveProperty('releaseClaim');
    expectTypeOf<AiStore>().not.toHaveProperty('ackNotice');
    expectTypeOf<AiStore>().not.toHaveProperty('insertAppeal');
    expectTypeOf<AiStore>().not.toHaveProperty('closeAppealsForGroup');
    expectTypeOf<AiStore>().not.toHaveProperty('closeOrphanAppeals');
    expectTypeOf<AiStore>().not.toHaveProperty('insertReport');
    expectTypeOf<AiStore>().not.toHaveProperty('addReportDetail');
    expectTypeOf<AiStore>().not.toHaveProperty('purgeReports');
    expectTypeOf<AiStore>().not.toHaveProperty('purgeSanctions');
    expectTypeOf<AiStore>().not.toHaveProperty('purgeNotices');
    expectTypeOf<AiStore>().not.toHaveProperty('purgeMutes');
    expectTypeOf<AiStore>().not.toHaveProperty('purgeStrikes');
    expect(true).toBe(true);
  });

  it('the service keeps no handle on the full Store: its dependencies carry no store, only the narrow one it reads through', () => {
    const store = withMemoryAi(new MemoryStore());
    const base = PRESETS.strict;
    const service = new AiService({
      options: { adapter: createFakeModerationAI([]) },
      store,
      clock: { now: () => 1 },
      logger: undefined,
      profile: () => base as never,
      rules: defineRules(starterRules('standard')),
      suggest: () => ({ outcome: 'none', label: '', why: '' }),
      subscribe: () => () => undefined,
      audit: () => true,
      exampleRetentionMs: () => 0,
    });
    try {
      const held = service as unknown as { deps: Record<string, unknown>; store: unknown };
      expect('store' in held.deps).toBe(false);
      expect(held.store).not.toBe(store);
      expect(Object.isFrozen(held.store)).toBe(true);
      // nothing the service holds is a writer of the full store through another name
      for (const v of Object.values(held.deps)) expect(v).not.toBe(store);
    } finally {
      service.close();
    }
  });

  it('still has the AI methods and the reads the module uses (a control: the narrowing did not break the service)', () => {
    expectTypeOf<AiStore>().toHaveProperty('reserveAiRead');
    expectTypeOf<AiStore>().toHaveProperty('insertAiOutcome');
    expectTypeOf<AiStore>().toHaveProperty('markAiOutcome');
    expectTypeOf<AiStore>().toHaveProperty('loadReport');
    expectTypeOf<AiStore>().toHaveProperty('listReports');
    expect(true).toBe(true);
  });

  it('the full Store has the writers (the control that makes the test above mean something)', () => {
    expectTypeOf<Store>().toHaveProperty('insertSanctionGroup');
    expectTypeOf<Store>().toHaveProperty('closeReport');
    expect(true).toBe(true);
  });

  it('requireAiStore hands back a frozen object with only the AI methods and the report reads, and refuses a store without the AI methods', () => {
    const store = withMemoryAi(new MemoryStore());
    const narrow = requireAiStore(store);
    expect(narrow).not.toBe(store);
    expect(Object.isFrozen(narrow)).toBe(true);
    expect(Object.getPrototypeOf(narrow)).toBe(Object.prototype);
    expect(() => requireAiStore(new MemoryStore())).toThrow(/AI methods/);
  });

  it('the runtime object holds exactly the AI store methods, loadReport, listReports, loadClaims, aiGateRows, the acting state and the action rows (enumerated, not sampled)', () => {
    const narrow = requireAiStore(withMemoryAi(new MemoryStore())) as unknown as Record<string, unknown>;
    expect(Object.keys(narrow).sort()).toEqual(
      [
        'reserveAiRead', 'completeAiRead', 'failAiRead', 'loadAiRead', 'loadAiReads', 'loadAiReadById', 'loadAiReadFor', 'listAiRetries',
        'aiSpendSince', 'insertAiOutcome', 'loadAiOutcome', 'markAiOutcome', 'aiExamples', 'aiTeachableCount', 'aiStats',
        'loadReport', 'listReports', 'loadClaims', 'aiGateRows', 'aiActingState',
        'insertAiAction', 'loadAiAction', 'transitionAiAction', 'dueAiActions', 'listAiActions', 'aiActionCounts', 'aiActedCount', 'aiActionsOnSubjects', 'aiUnreviewed',
      ].sort(),
    );
    for (const v of Object.values(narrow)) expect(typeof v).toBe('function');
  });

  it('the action methods write action rows and nothing else: every other list and map of the store keeps its size', () => {
    const store = withMemoryAi(new MemoryStore());
    const narrow = requireAiStore(store);
    const sizes = (): string =>
      JSON.stringify(
        Object.entries(store as unknown as Record<string, unknown>)
          .filter(([k, v]) => k !== 'actionRows' && (Array.isArray(v) || v instanceof Map || v instanceof Set))
          .map(([k, v]) => [k, Array.isArray(v) ? v.length : (v as Map<unknown, unknown>).size]),
      );
    const before = sizes();
    expect(before.length).toBeGreaterThan(20);
    const row = {
      id: 'a1', reportId: 'r1', readId: 'x', confirmReadId: null, rule: '2', severity: 'hostile' as const, state: 'queued' as const, refusedCode: null, notBefore: 1, createdAt: 1, groupId: null,
      kind: null, durationMs: null, actedAt: null, reviewDueAt: null, reviewedAt: null, reviewedBy: null, undoCode: null, undoNote: null, adapter: null, promptVersion: null,
    };
    expect(narrow.insertAiAction?.(row)).toBe(true);
    expect(narrow.transitionAiAction?.('a1', ['queued'], { confirmReadId: 'c1' })).toBe(true);
    expect(narrow.transitionAiAction?.('a1', ['queued'], { state: 'refused', refusedCode: 'cap_hour' })).toBe(true);
    expect(narrow.dueAiActions?.(10, 5)).toEqual([]);
    expect(narrow.listAiActions?.({ limit: 5 })).toHaveLength(1);
    expect(sizes()).toBe(before);
  });

  it('the switch of acting is not in it: no setAiActingState by type, by name or at runtime (only the acting facade has a handle on it)', () => {
    expectTypeOf<AiStore>().not.toHaveProperty('setAiActingState');
    const store = withMemoryAi(new MemoryStore());
    const narrow = requireAiStore(store) as unknown as Record<string, unknown>;
    expect('setAiActingState' in narrow).toBe(false);
    expect(narrow['setAiActingState']).toBeUndefined();
    expect(Reflect.has(narrow, 'setAiActingState')).toBe(false);
    // the AI module can still read where acting stands
    expect(typeof narrow['aiActingState']).toBe('function');
    // and the store itself has it (a control)
    expect(typeof (store as unknown as Record<string, unknown>)['setAiActingState']).toBe('function');
  });

  it('the AI path may only refuse a queued row or record its confirming read: by type, and at runtime a forged patch throws and the row is untouched', () => {
    const store = withMemoryAi(new MemoryStore());
    const narrow = requireAiStore(store);
    const row = {
      id: 'a1', reportId: 'r1', readId: 'x', confirmReadId: null, rule: '2', severity: 'hostile' as const, state: 'queued' as const, refusedCode: null, notBefore: 1, createdAt: 1, groupId: null,
      kind: null, durationMs: null, actedAt: null, reviewDueAt: null, reviewedAt: null, reviewedBy: null, undoCode: null, undoNote: null, adapter: null, promptVersion: null,
    };
    expect(narrow.insertAiAction?.(row)).toBe(true);
    type Patch = Parameters<NonNullable<AiStore['transitionAiAction']>>[2];
    expectTypeOf<{ state: 'refused'; refusedCode: string }>().toExtend<Patch>();
    expectTypeOf<{ confirmReadId: string }>().toExtend<Patch>();
    expectTypeOf<{ state: 'shadow' }>().not.toExtend<Patch>();
    expectTypeOf<{ state: 'active'; kind: 'chat' }>().not.toExtend<Patch>();
    expectTypeOf<{ state: 'confirmed'; reviewedBy: 'x' }>().not.toExtend<Patch>();
    expectTypeOf<{ kind: 'ban' }>().not.toExtend<Patch>();
    const forged: unknown[] = [
      { state: 'shadow' },
      { state: 'active' },
      { state: 'confirmed', reviewedAt: 5, reviewedBy: 'x' },
      { state: 'refused' },
      { state: 'refused', refusedCode: 'x', kind: 'ban' },
      { confirmReadId: 'c1', kind: 'chat' },
      { kind: 'ban', durationMs: 1 },
      { reviewedAt: 1 },
      { undoCode: 'not_a_violation' },
      { groupId: 'g1' },
      {},
    ];
    for (const patch of forged) expect(() => narrow.transitionAiAction?.('a1', ['queued'], patch as never), JSON.stringify(patch)).toThrow(/may only/);
    // from any state but queued is refused too
    expect(() => narrow.transitionAiAction?.('a1', ['queued', 'shadow'] as never, { confirmReadId: 'c1' })).toThrow(/may only/);
    expect(() => narrow.transitionAiAction?.('a1', ['shadow'] as never, { state: 'refused', refusedCode: 'x' })).toThrow(/may only/);
    expect(store.loadAiAction('r1')).toEqual(row);
    // the two allowed shapes work
    expect(narrow.transitionAiAction?.('a1', ['queued'], { confirmReadId: 'c1' })).toBe(true);
    expect(narrow.transitionAiAction?.('a1', ['queued'], { state: 'refused', refusedCode: 'cap_hour' })).toBe(true);
    expect(store.loadAiAction('r1')).toMatchObject({ state: 'refused', refusedCode: 'cap_hour', confirmReadId: 'c1', kind: null });
  });

  it('no writer is reachable: not by name, not by a cast and a computed key, not by Reflect, a spread or the prototype chain', () => {
    const store = withMemoryAi(new MemoryStore());
    const narrow = requireAiStore(store);
    const writers = ['insertSanctionGroup', 'revokeSanctionGroup', 'closeReport', 'insertDecision', 'insertNotice', 'withdrawNotice', 'withdrawNoticeGroup', 'insertStrike', 'upsertMute', 'deleteMute', 'pruneMutes', 'closeGap', 'decideAppeal', 'transaction', 'savePolicyLayer', 'claimCase', 'insertReport', 'purgeSanctions'];
    const loose = narrow as unknown as Record<string, unknown>;
    const concat = (a: string, b: string): string => a + b;
    for (const w of writers) {
      expect(w in narrow, w).toBe(false);
      expect(loose[w], w).toBeUndefined();
      expect(loose[concat(w.slice(0, 3), w.slice(3))], w).toBeUndefined();
      expect(Reflect.get(narrow, w), w).toBeUndefined();
      expect(Reflect.has(narrow, w), w).toBe(false);
      expect({ ...narrow }[w], w).toBeUndefined();
    }
    // the store really has them (a control: the checks above would pass vacuously on a store without them)
    expect(typeof (store as unknown as Record<string, unknown>).insertSanctionGroup).toBe('function');
    expect(typeof (store as unknown as Record<string, unknown>).closeReport).toBe('function');
  });

  it('the object cannot be given a writer afterwards (frozen), and its methods call through to the real store', () => {
    const store = withMemoryAi(new MemoryStore());
    const narrow = requireAiStore(store) as unknown as Record<string, unknown>;
    expect(() => {
      narrow.insertSanctionGroup = () => undefined;
    }).toThrow(TypeError);
    expect('insertSanctionGroup' in narrow).toBe(false);
    // detached from the object, a method still runs against the store (called through), and reads what the store holds
    const { loadReport, aiTeachableCount } = requireAiStore(store);
    expect(loadReport('nope')).toBeNull();
    expect(aiTeachableCount(0)).toBe(0);
  });

  it('a store without the acting-state methods gets no such key (acting is then unsupported, the rest of the AI works)', () => {
    const full = withMemoryAi(new MemoryStore());
    const bare = new Proxy(full, { get: (t, k, r) => (k === 'aiActingState' || k === 'setAiActingState' ? undefined : Reflect.get(t, k, r)) });
    const narrow = requireAiStore(bare);
    expect('aiActingState' in narrow).toBe(false);
    expect('setAiActingState' in narrow).toBe(false);
    expect(typeof narrow.loadAiRead).toBe('function');
  });

  it('a store without aiGateRows gets no aiGateRows key (the service already treats it as optional)', () => {
    const full = withMemoryAi(new MemoryStore());
    const bare = new Proxy(full, { get: (t, k, r) => (k === 'aiGateRows' ? undefined : Reflect.get(t, k, r)) });
    const narrow = requireAiStore(bare);
    expect('aiGateRows' in narrow).toBe(false);
    expect(typeof narrow.loadReport).toBe('function');
  });
});
