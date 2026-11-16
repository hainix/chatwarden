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
      expect(held.store).toBe(store);
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

  it('requireAiStore hands back the same object and refuses a store without the AI methods', () => {
    const store = withMemoryAi(new MemoryStore());
    expect(requireAiStore(store)).toBe(store);
    expect(() => requireAiStore(new MemoryStore())).toThrow(/AI methods/);
  });
});
