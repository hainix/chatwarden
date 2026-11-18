import { describe, expect, it } from 'vitest';
import type { SetupState, Store } from '@chatwarden/core';

// The contract of the stored setup state (0.2.2): `getSetupState` and `saveSetupState`, the optional pair that remembers the first-run panel was
// dismissed. One suite, run against every Store. The methods are optional on the interface (a custom store may leave them out); every store in this
// repo implements them.

interface WithSetup {
  getSetupState(): SetupState | null;
  saveSetupState(state: SetupState): void;
}

const setup = (s: Store): WithSetup => {
  if (s.getSetupState === undefined || s.saveSetupState === undefined) throw new Error('this store has no setup state methods');
  return s as unknown as WithSetup;
};

export function setupContract(name: string, make: () => Store): void {
  describe(`setup state contract: ${name}`, () => {
    it('has both methods', () => {
      const s = make();
      expect(typeof s.getSetupState).toBe('function');
      expect(typeof s.saveSetupState).toBe('function');
    });

    it('a fresh store has no setup state', () => {
      expect(setup(make()).getSetupState()).toBeNull();
    });

    it('save then read gives { dismissedAt: 5 } and { dismissedAt: null }', () => {
      const s = setup(make());
      s.saveSetupState({ dismissedAt: 5 });
      expect(s.getSetupState()).toEqual({ dismissedAt: 5 });
      const t = setup(make());
      t.saveSetupState({ dismissedAt: null });
      expect(t.getSetupState()).toEqual({ dismissedAt: null });
    });

    it('keeps a large timestamp exactly', () => {
      const s = setup(make());
      s.saveSetupState({ dismissedAt: 1_800_000_000_123 });
      expect(s.getSetupState()).toEqual({ dismissedAt: 1_800_000_000_123 });
    });

    it('a second save replaces', () => {
      const s = setup(make());
      s.saveSetupState({ dismissedAt: 5 });
      s.saveSetupState({ dismissedAt: 9 });
      expect(s.getSetupState()).toEqual({ dismissedAt: 9 });
      s.saveSetupState({ dismissedAt: null });
      expect(s.getSetupState()).toEqual({ dismissedAt: null });
    });

    it('hands back copies: changing what was read or what was saved never changes the store', () => {
      const s = setup(make());
      const given: SetupState = { dismissedAt: 7 };
      s.saveSetupState(given);
      given.dismissedAt = 99;
      const read = s.getSetupState();
      expect(read).toEqual({ dismissedAt: 7 });
      (read as SetupState).dismissedAt = 123;
      expect(s.getSetupState()).toEqual({ dismissedAt: 7 });
    });

    it('a save inside a transaction that throws is undone', () => {
      const s = make();
      const p = setup(s);
      p.saveSetupState({ dismissedAt: 5 });
      expect(() =>
        s.transaction(() => {
          p.saveSetupState({ dismissedAt: 9 });
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(p.getSetupState()).toEqual({ dismissedAt: 5 });
      const fresh = make();
      expect(() =>
        fresh.transaction(() => {
          setup(fresh).saveSetupState({ dismissedAt: 1 });
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(setup(fresh).getSetupState()).toBeNull();
    });

    it('does not move the change token (it is not a queue change)', () => {
      const s = make();
      const before = s.changeToken();
      setup(s).saveSetupState({ dismissedAt: 5 });
      expect(s.changeToken()).toBe(before);
    });

    it('does not touch the policy layer, and the layer does not touch it', () => {
      const s = make();
      setup(s).saveSetupState({ dismissedAt: 5 });
      expect(s.loadPolicyLayer?.()).toBeNull();
      s.savePolicyLayer?.({ customDuration: false }, 0);
      expect(setup(s).getSetupState()).toEqual({ dismissedAt: 5 });
    });

    it('two stores are independent', () => {
      const a = setup(make());
      const b = setup(make());
      a.saveSetupState({ dismissedAt: 5 });
      expect(b.getSetupState()).toBeNull();
    });
  });
}
