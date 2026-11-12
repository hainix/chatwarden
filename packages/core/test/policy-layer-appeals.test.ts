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
    const { cw } = await world({ overrides: { appeals: { perPlayerPerWeek: 4 }, names: { profanity: true } } });
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
    expect(JSON.stringify(row)).not.toContain('17');
    expect(cw.audit.record({ actor: 'owner_ann', role: 'owner', action: 'policy.update', detail: { sections: ['names'], reason: 'tuning' } })).toBe(true);
    expect(cw.audit.record({ actor: 'owner_ann', role: 'owner', action: 'policy.reset', detail: { sections: ['appeals', 'names'], reason: 'back' } })).toBe(true);
  });

  it('agentBrief and policyJson are unchanged by an appeals or names layer', async () => {
    const { cw } = await world();
    const brief = cw.documents.agentBrief();
    const json = JSON.stringify(cw.documents.policyJson());
    cw.policy.save({ appeals: { enabled: true, perPlayerPerWeek: 6 }, names: { profanity: true, renames: true, maskInHub: false } }, { version: 0, ...OWNER });
    expect(cw.profile.appeals.enabled).toBe(true);
    expect(cw.documents.agentBrief()).toBe(brief);
    expect(JSON.stringify(cw.documents.policyJson())).toBe(json);
    expect(brief).not.toMatch(/appeal|rename/i);
  });
});
