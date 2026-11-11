import { describe, expect, it } from 'vitest';
import type { AuditRow, PolicyLayer, Store } from '@chatwarden/core';

// The contract of the stored policy layer (K4 Task 7f): `loadPolicyLayer` and `savePolicyLayer`, the optional methods that
// make the moderation profile editable, and the detail the policy audit rows carry. One suite, run against every Store.
// The methods are optional on the interface (a custom store may leave them out); every store in this repo implements them.

interface WithPolicy {
  loadPolicyLayer(): { layer: PolicyLayer; version: number } | null;
  savePolicyLayer(layer: PolicyLayer, expectedVersion: number): number | null;
}

const policy = (s: Store): WithPolicy => {
  if (s.loadPolicyLayer === undefined || s.savePolicyLayer === undefined) throw new Error('this store has no policy layer methods');
  return s as unknown as WithPolicy;
};

const LAYER: PolicyLayer = { durations: [3_600_000, 21_600_000], repeat: { notes: 3 }, firstOffense: { rude: { kind: 'chat', durationMs: 3_600_000 } } };

export function policyContract(name: string, make: () => Store): void {
  describe(`policy layer contract: ${name}`, () => {
    it('has both methods', () => {
      const s = make();
      expect(typeof s.loadPolicyLayer).toBe('function');
      expect(typeof s.savePolicyLayer).toBe('function');
    });

    it('a fresh store has no layer', () => {
      expect(policy(make()).loadPolicyLayer()).toBeNull();
    });

    it('the first save needs version 0 and answers version 1', () => {
      const s = policy(make());
      expect(s.savePolicyLayer(LAYER, 0)).toBe(1);
      expect(s.loadPolicyLayer()).toEqual({ layer: LAYER, version: 1 });
    });

    it('versions climb by one, and a save replaces the whole layer', () => {
      const s = policy(make());
      expect(s.savePolicyLayer(LAYER, 0)).toBe(1);
      expect(s.savePolicyLayer({ customDuration: false }, 1)).toBe(2);
      expect(s.savePolicyLayer({}, 2)).toBe(3);
      expect(s.loadPolicyLayer()).toEqual({ layer: {}, version: 3 });
    });

    it('a stale expected version is null and changes nothing', () => {
      const s = policy(make());
      s.savePolicyLayer(LAYER, 0);
      expect(s.savePolicyLayer({ customDuration: false }, 0)).toBeNull();
      expect(s.savePolicyLayer({ customDuration: false }, 2)).toBeNull();
      expect(s.savePolicyLayer({ customDuration: false }, -1)).toBeNull();
      expect(s.loadPolicyLayer()).toEqual({ layer: LAYER, version: 1 });
    });

    it('version 0 cannot be used once a layer exists, and a non-zero version cannot create one', () => {
      const empty = policy(make());
      expect(empty.savePolicyLayer(LAYER, 1)).toBeNull();
      expect(empty.loadPolicyLayer()).toBeNull();
      const used = policy(make());
      used.savePolicyLayer({}, 0);
      expect(used.savePolicyLayer(LAYER, 0)).toBeNull();
    });

    it('hands back copies: changing what was read or what was saved never changes the store', () => {
      const s = policy(make());
      const given: PolicyLayer = { durations: [3_600_000] };
      s.savePolicyLayer(given, 0);
      (given.durations as number[]).push(7);
      const read = s.loadPolicyLayer();
      (read?.layer.durations as number[]).push(9);
      expect(s.loadPolicyLayer()?.layer).toEqual({ durations: [3_600_000] });
    });

    it('keeps nested values, nulls, empty lists and unicode exactly', () => {
      const s = policy(make());
      const layer: PolicyLayer = {
        firstOffense: { severe: { kind: 'ban', durationMs: null } },
        areaRules: [],
        guidelines: [null, { outcome: 'Un avertissement, puis étape suivante — 100% "quoted" \\ back' }],
      };
      s.savePolicyLayer(layer, 0);
      expect(s.loadPolicyLayer()?.layer).toEqual(layer);
    });

    it('a save inside a transaction that throws is undone, version included', () => {
      const s = make();
      const p = policy(s);
      p.savePolicyLayer(LAYER, 0);
      expect(() =>
        s.transaction(() => {
          expect(p.savePolicyLayer({ customDuration: false }, 1)).toBe(2);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(p.loadPolicyLayer()).toEqual({ layer: LAYER, version: 1 });
      expect(p.savePolicyLayer({ customDuration: false }, 1)).toBe(2);
    });

    it('does not move the change token (a profile edit is not a queue change)', () => {
      const s = make();
      const before = s.changeToken();
      policy(s).savePolicyLayer(LAYER, 0);
      expect(s.changeToken()).toBe(before);
    });

    it('two stores are independent', () => {
      const a = policy(make());
      const b = policy(make());
      a.savePolicyLayer(LAYER, 0);
      expect(b.loadPolicyLayer()).toBeNull();
    });
  });

  describe(`policy audit detail contract: ${name}`, () => {
    const base: AuditRow = { id: 'p1', at: 10, actor: 'owner_ann', role: 'owner', action: 'policy.update', target: null };

    it('round-trips the detail of a policy row', () => {
      const s = make();
      const r: AuditRow = { ...base, detail: { sections: ['durations', 'ladder'], reason: 'Add 6 and 12 hour options' } };
      s.insertAudit(r);
      expect(s.listAudit({ limit: 5 })).toEqual([r]);
    });

    it('a detail with no reason round-trips without one', () => {
      const s = make();
      const r: AuditRow = { ...base, action: 'policy.reset', detail: { sections: [] } };
      s.insertAudit(r);
      const [got] = s.listAudit({ limit: 5 });
      expect(got).toEqual(r);
      expect(Object.keys(got?.detail ?? {})).toEqual(['sections']);
    });

    it('a row without a detail reads without the key', () => {
      const s = make();
      s.insertAudit({ ...base, id: 'p2', action: 'policy.view' });
      const [got] = s.listAudit({ limit: 5 });
      expect(Object.keys(got ?? {})).not.toContain('detail');
    });

    it('the action filter finds the new actions', () => {
      const s = make();
      s.insertAudit({ ...base, detail: { sections: [] } });
      s.insertAudit({ ...base, id: 'p3', action: 'policy.reset', detail: { sections: ['ladder'] } });
      expect(s.listAudit({ limit: 5, action: 'policy.reset' }).map((r) => r.id)).toEqual(['p3']);
      expect(s.listAudit({ limit: 5, action: 'policy.update' }).map((r) => r.id)).toEqual(['p1']);
    });

    it('keeps a reason with quotes, newlines and unicode exactly', () => {
      const s = make();
      const reason = 'He said "stop"\nthen left — café \\ ok';
      s.insertAudit({ ...base, detail: { sections: ['repeat'], reason } });
      expect(s.listAudit({ limit: 1 })[0]?.detail?.reason).toBe(reason);
    });
  });
}
