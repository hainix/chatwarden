import { describe, expect, it } from 'vitest';
import {
  applyPolicyLayer,
  changedSections,
  layerSections,
  POLICY_SECTIONS,
  PRESETS,
  ProfileError,
  resolveProfile,
  type ModerationProfile,
  type PolicyLayer,
} from '../src/profile.js';
import { MemoryStore, withMemoryAppeals, withMemoryNames } from '@chatwarden/store-memory';
import { OWNER, world } from './reportingWorld.js';

// The `appeals` and `names` sections in the layer (the owner's edits), through cw.policy and cw.profile.

const APPEALS_OFF = { enabled: false, perPlayerPerWeek: 3, allowSelfReview: false };
const NAMES_OFF = { profanity: false, keepBlocked: false, renames: false, maskInHub: true };
const base = (): ModerationProfile => PRESETS.standard;

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}
const bad = (layer: unknown): ProfileError => failure(() => applyPolicyLayer(base(), layer as PolicyLayer));

describe('appeals and names in the layer', () => {
  it('POLICY_SECTIONS appends appeals then names, after the 0.1.8 sections', () => {
    expect([...POLICY_SECTIONS].slice(-4)).toEqual(['pace', 'signals', 'appeals', 'names']);
  });

  it('a layer beats the code profile, which beats the defaults', () => {
    const coded = resolveProfile('standard', { appeals: { enabled: true, perPlayerPerWeek: 5 }, names: { profanity: true } });
    expect(coded.appeals).toEqual({ enabled: true, perPlayerPerWeek: 5, allowSelfReview: false });
    const p = applyPolicyLayer(coded, { appeals: { perPlayerPerWeek: 2, allowSelfReview: true }, names: { profanity: false, maskInHub: false } });
    expect(p.appeals).toEqual({ enabled: true, perPlayerPerWeek: 2, allowSelfReview: true });
    expect(p.names).toEqual({ profanity: false, keepBlocked: false, renames: false, maskInHub: false });
    // the defaults, with no code profile value and no layer
    expect(applyPolicyLayer(base(), {}).appeals).toEqual(APPEALS_OFF);
    expect(applyPolicyLayer(base(), {}).names).toEqual(NAMES_OFF);
  });

  it('an empty layer section changes nothing', () => {
    const coded = resolveProfile('standard', { appeals: { enabled: true }, names: { renames: true } });
    const p = applyPolicyLayer(coded, { appeals: {}, names: {} });
    expect(p.appeals).toEqual(coded.appeals);
    expect(p.names).toEqual(coded.names);
  });

  it('a layer section that is not an object is refused at layer.appeals / layer.names', () => {
    for (const v of [5, 'x', null, [], true]) {
      expect(bad({ appeals: v }).path).toBe('layer.appeals');
      expect(bad({ names: v }).path).toBe('layer.names');
    }
  });

  it.each([
    [{ appeals: { perPlayerPerWeek: 0 } }, 'layer.appeals.perPlayerPerWeek'],
    [{ appeals: { perPlayerPerWeek: 21 } }, 'layer.appeals.perPlayerPerWeek'],
    [{ appeals: { perPlayerPerWeek: 2.5 } }, 'layer.appeals.perPlayerPerWeek'],
    [{ appeals: { perPlayerPerWeek: '3' } }, 'layer.appeals.perPlayerPerWeek'],
    [{ appeals: { enabled: 'yes' } }, 'layer.appeals.enabled'],
    [{ appeals: { nope: 1 } }, 'layer.appeals.nope'],
    [{ names: { renames: 1 } }, 'layer.names.renames'],
    [{ names: { maskInHub: null } }, 'layer.names.maskInHub'],
    [{ names: { nope: true } }, 'layer.names.nope'],
  ])('refuses %j with path %s', (layer, path) => {
    expect(bad(layer).path).toBe(path);
  });

  it('the error never echoes the value', () => {
    expect(bad({ appeals: { perPlayerPerWeek: 987654 } }).message).not.toContain('987654');
  });

  it('the base is not changed by applying a layer', () => {
    const before = JSON.stringify(base());
    applyPolicyLayer(base(), { appeals: { enabled: true }, names: { renames: true } });
    expect(JSON.stringify(base())).toBe(before);
  });

  it('changedSections lists the sections; layerSections lists them in POLICY_SECTIONS order', () => {
    expect(changedSections({}, { appeals: { enabled: true } })).toEqual(['appeals']);
    expect(changedSections({}, { names: { renames: true } })).toEqual(['names']);
    expect(changedSections({ appeals: { enabled: true } }, { appeals: { enabled: true } })).toEqual([]);
    expect(changedSections({ appeals: { enabled: true } }, { appeals: { enabled: false } })).toEqual(['appeals']);
    expect(changedSections({ names: { renames: true } }, {})).toEqual(['names']);
    expect(changedSections({ pace: { slowModeMs: 2000 } }, { pace: { slowModeMs: 3000 }, names: { renames: true }, appeals: { enabled: true }, ai: { level: 1 } })).toEqual(['ai', 'pace', 'appeals', 'names']);
    expect(layerSections({ names: {}, appeals: {}, durations: [3_600_000], pace: {} })).toEqual(['durations', 'pace', 'appeals', 'names']);
  });
});

describe('cw.policy and the appeals and names sections', () => {
  it('starts off in effective and base', async () => {
    const { cw } = await world();
    expect(cw.profile.appeals).toEqual(APPEALS_OFF);
    expect(cw.profile.names).toEqual(NAMES_OFF);
    expect(cw.policy.get().base.appeals).toEqual(APPEALS_OFF);
    expect(cw.policy.get().effective.names).toEqual(NAMES_OFF);
  });

  it('a layer beats the code profile and applies at once, reporting the sections', async () => {
    const { cw } = await world({ overrides: { appeals: { perPlayerPerWeek: 4 }, names: { profanity: true } } }, withMemoryAppeals(new MemoryStore()));
    const res = cw.policy.save({ appeals: { enabled: true }, names: { keepBlocked: true } }, { version: 0, ...OWNER });
    expect(res).toEqual({ ok: true, version: 1, changed: ['appeals', 'names'] });
    expect(cw.profile.appeals).toEqual({ enabled: true, perPlayerPerWeek: 4, allowSelfReview: false });
    expect(cw.profile.names).toEqual({ ...NAMES_OFF, profanity: true, keepBlocked: true });
    expect(cw.policy.get().base.appeals.enabled).toBe(false);
    expect(cw.policy.get().layer.appeals).toEqual({ enabled: true });
  });

  it('reset("appeals") and reset("names") restore the base and leave the other sections', async () => {
    const { cw } = await world({ overrides: { appeals: { perPlayerPerWeek: 4 }, names: { renames: true } } });
    cw.policy.save({ appeals: { perPlayerPerWeek: 9 }, names: { renames: false }, customDuration: false }, { version: 0, ...OWNER });
    expect(cw.profile.appeals.perPlayerPerWeek).toBe(9);
    expect(cw.profile.names.renames).toBe(false);
    expect(cw.policy.reset('appeals')).toMatchObject({ ok: true, changed: ['appeals'] });
    expect(cw.profile.appeals.perPlayerPerWeek).toBe(4);
    expect(cw.profile.names.renames).toBe(false);
    expect(cw.policy.reset('names')).toMatchObject({ ok: true, changed: ['names'] });
    expect(cw.profile.names.renames).toBe(true);
    expect(cw.profile.customDuration).toBe(false);
    expect(cw.policy.reset('appeals')).toMatchObject({ ok: true, changed: [] });
  });

  it.each([
    [{ appeals: { perPlayerPerWeek: 0 } }, 'layer.appeals.perPlayerPerWeek'],
    [{ names: { nope: true } }, 'layer.names.nope'],
  ])('refuses %j with path %s and writes nothing', async (layer, path) => {
    const { cw } = await world();
    expect(cw.policy.save(layer as never, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path });
    expect(cw.policy.get().version).toBe(0);
    expect(cw.profile.appeals).toEqual(APPEALS_OFF);
  });

  it('a saved layer survives a second kit over the same store (another process)', async () => {
    // The second kit starts with appeals on, so its store must carry the appeal methods (the startup check refuses one without).
    const { cw, store } = await world({}, withMemoryNames(withMemoryAppeals(new MemoryStore())));
    cw.policy.save({ appeals: { enabled: true }, names: { renames: true } }, { version: 0, ...OWNER });
    const { cw: other } = await world({}, store);
    expect(other.profile.appeals.enabled).toBe(true);
    expect(other.profile.names.renames).toBe(true);
  });

  it('a save audits policy.update with sections ["appeals"] and no values', async () => {
    const { cw } = await world();
    const res = cw.policy.save({ appeals: { perPlayerPerWeek: 17 } }, { version: 0, ...OWNER });
    expect(res).toMatchObject({ ok: true, changed: ['appeals'] });
    expect(cw.audit.record({ actor: 'owner_ann', role: 'owner', action: 'policy.update', detail: { sections: ['appeals'], reason: 'tuning' } })).toBe(true);
    const row = cw.audit.list({ limit: 1 }).items[0];
    expect(row?.detail).toEqual({ sections: ['appeals'], reason: 'tuning' });
    expect(JSON.stringify(row)).not.toMatch(/\b17\b/);
    expect(cw.audit.record({ actor: 'owner_ann', role: 'owner', action: 'policy.update', detail: { sections: ['names'], reason: 'tuning' } })).toBe(true);
    expect(cw.audit.record({ actor: 'owner_ann', role: 'owner', action: 'policy.reset', detail: { sections: ['appeals', 'names'], reason: 'back' } })).toBe(true);
  });

  it('agentBrief and policyJson are unchanged by an appeals or names layer', async () => {
    const { cw } = await world({}, withMemoryAppeals(new MemoryStore()));
    const brief = cw.documents.agentBrief();
    const json = JSON.stringify(cw.documents.policyJson());
    cw.policy.save({ appeals: { enabled: true, perPlayerPerWeek: 6 }, names: { profanity: true, renames: true, maskInHub: false } }, { version: 0, ...OWNER });
    expect(cw.profile.appeals.enabled).toBe(true);
    expect(cw.documents.agentBrief()).toBe(brief);
    expect(JSON.stringify(cw.documents.policyJson())).toBe(json);
    expect(brief).not.toMatch(/appeal|rename/i);
  });
});

describe('appeals over a store without the appeal methods', () => {
  const WARN = 'chatwarden.appeals_unsupported_store';

  /** A plain MemoryStore (no appeal methods) that already holds a layer turning appeals on. */
  const storeWithLayerOn = (): MemoryStore => {
    const store = new MemoryStore();
    expect(store.savePolicyLayer({ appeals: { enabled: true } }, 0)).toBe(1);
    return store;
  };
  const warnings = (logged: Array<[string, unknown]>): Array<[string, unknown]> => logged.filter(([event]) => event === WARN);

  it('layer on, store lacks methods: boots, appeals off, warns once', async () => {
    const { cw, logged } = await world({}, storeWithLayerOn());
    expect(cw.profile.appeals.enabled).toBe(false);
    expect(cw.policy.get().effective.appeals.enabled).toBe(false);
    // the owner's stored edit is kept as it is, so the setting is back the day the store can keep appeals
    expect(cw.policy.get().layer.appeals).toEqual({ enabled: true });
    expect(cw.policy.get().layerError).toBeUndefined();
    expect(warnings(logged)).toEqual([[WARN, {}]]);
    // reads keep working and keep it quiet
    for (let i = 0; i < 5; i += 1) cw.policy.get();
    expect(warnings(logged)).toHaveLength(1);
  });

  it('layer on, store lacks methods: the other sections of the layer still apply', async () => {
    const store = new MemoryStore();
    store.savePolicyLayer({ appeals: { enabled: true, perPlayerPerWeek: 7 }, names: { keepBlocked: true } }, 0);
    const { cw } = await world({}, store);
    expect(cw.profile.appeals).toEqual({ enabled: false, perPlayerPerWeek: 7, allowSelfReview: false });
    expect(cw.profile.names.keepBlocked).toBe(true);
  });

  it('layer on, store lacks methods: the appeal routes answer as off (the service is not enabled)', async () => {
    const { cw } = await world({}, storeWithLayerOn());
    expect(cw.appeals.enabled()).toBe(false);
  });

  it('layer on, store has the methods: appeals are on and nothing is warned (control)', async () => {
    const { cw, logged } = await world({}, withMemoryAppeals(storeWithLayerOn()));
    expect(cw.profile.appeals.enabled).toBe(true);
    expect(warnings(logged)).toEqual([]);
  });

  it('no layer, store lacks methods: boots off and says nothing (control)', async () => {
    const { cw, logged } = await world({}, new MemoryStore());
    expect(cw.profile.appeals.enabled).toBe(false);
    expect(warnings(logged)).toEqual([]);
  });

  it('code profile on, store lacks methods: throws', async () => {
    await expect(world({ overrides: { appeals: { enabled: true } } }, new MemoryStore())).rejects.toThrow(/appeals are enabled/);
    await expect(world({ profile: 'standard', overrides: { appeals: { enabled: true } } }, storeWithLayerOn())).rejects.toThrow(/appeals are enabled/);
  });

  it('code profile on, layer turns it off, store lacks methods: still throws (the code asked for it)', async () => {
    const store = new MemoryStore();
    store.savePolicyLayer({ appeals: { enabled: false } }, 0);
    await expect(world({ overrides: { appeals: { enabled: true } } }, store)).rejects.toThrow(/appeals are enabled/);
  });

  it('save of appeals.enabled true on such a store is refused with that path and writes nothing', async () => {
    const { cw, store } = await world({}, new MemoryStore());
    const res = cw.policy.save({ appeals: { enabled: true } }, { version: 0, ...OWNER });
    expect(res).toEqual({ ok: false, error: 'invalid', path: 'layer.appeals.enabled' });
    expect(store.loadPolicyLayer?.()).toBeNull();
    expect(cw.policy.get().version).toBe(0);
    expect(cw.profile.appeals.enabled).toBe(false);
  });

  it('the refused save keeps the layer already stored, and its version', async () => {
    const { cw, store } = await world({}, new MemoryStore());
    expect(cw.policy.save({ names: { keepBlocked: true } }, { version: 0, ...OWNER })).toMatchObject({ ok: true, version: 1 });
    const res = cw.policy.save({ names: { keepBlocked: true }, appeals: { enabled: true, perPlayerPerWeek: 4 } }, { version: 1, ...OWNER });
    expect(res).toEqual({ ok: false, error: 'invalid', path: 'layer.appeals.enabled' });
    expect(store.loadPolicyLayer?.()).toEqual({ layer: { names: { keepBlocked: true } }, version: 1 });
  });

  it('on such a store a save that leaves appeals off, or sets other appeal fields, still succeeds', async () => {
    const { cw } = await world({}, new MemoryStore());
    expect(cw.policy.save({ appeals: { enabled: false, perPlayerPerWeek: 5 } }, { version: 0, ...OWNER })).toMatchObject({ ok: true, changed: ['appeals'] });
    expect(cw.policy.save({ appeals: { perPlayerPerWeek: 6 } }, { version: 1, ...OWNER })).toMatchObject({ ok: true, changed: ['appeals'] });
    expect(cw.profile.appeals.enabled).toBe(false);
  });

  it('on such a store a layer that is stored on from before can be saved off, and reset works', async () => {
    const { cw } = await world({}, storeWithLayerOn());
    expect(cw.policy.save({ appeals: { enabled: false } }, { version: 1, ...OWNER })).toMatchObject({ ok: true, version: 2 });
    expect(cw.policy.reset('appeals', { version: 2 })).toMatchObject({ ok: true, changed: ['appeals'] });
  });

  it('the refusal is one of the usual invalid answers: a wrong version is still reported first as its own path', async () => {
    const { cw } = await world({}, new MemoryStore());
    expect(cw.policy.save({ appeals: { enabled: true } }, { version: -1, ...OWNER })).toEqual({ ok: false, error: 'invalid', path: 'version' });
    expect(cw.policy.save({ appeals: { enabled: 'yes' } } as never, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path: 'layer.appeals.enabled' });
  });

  it('the same save on a store with the methods succeeds (control)', async () => {
    const { cw, store } = await world({}, withMemoryAppeals(new MemoryStore()));
    const res = cw.policy.save({ appeals: { enabled: true } }, { version: 0, ...OWNER });
    expect(res).toEqual({ ok: true, version: 1, changed: ['appeals'] });
    expect(store.loadPolicyLayer?.()).toEqual({ layer: { appeals: { enabled: true } }, version: 1 });
    expect(cw.profile.appeals.enabled).toBe(true);
  });

  it('preview of a layer that turns appeals on is unaffected (it reads nothing about appeals)', async () => {
    const { cw } = await world({}, new MemoryStore());
    expect(cw.policy.preview({ appeals: { enabled: true } }).ok).toBe(true);
  });
});
