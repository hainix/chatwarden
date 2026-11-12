import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../src/audit.js';
import {
  applyPolicyLayer,
  changedSections,
  defineProfile,
  layerSections,
  POLICY_SECTIONS,
  PRESETS,
  ProfileError,
  resolveProfile,
  validateProfile,
  type ModerationProfile,
  type PolicyLayer,
} from '../src/profile.js';
import { OWNER, world } from './reportingWorld.js';

// The `pace` section: in the profile (code), in the layer (the owner's edits), through cw.policy and cw.profile.

const OFF = { slowModeMs: null, burst: null, duplicateWindowMs: null };
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

describe('pace in the profile', () => {
  it('the presets resolve pace to all null', () => {
    for (const name of ['relaxed', 'standard', 'strict'] as const) expect(PRESETS[name].pace).toEqual(OFF);
  });

  it('a profile written without pace resolves it to all null, and so does a 0.1.1-style custom profile', () => {
    const { pace: _drop, ...without } = PRESETS.standard as ModerationProfile & { pace?: unknown };
    void _drop;
    expect(defineProfile(without as ModerationProfile).pace).toEqual(OFF);
  });

  it('a code profile with pace resolves it, filling what is left out', () => {
    const p = resolveProfile('standard', { pace: { slowModeMs: 2000, burst: { lines: 5, windowMs: 10_000 } } });
    expect(p.pace).toEqual({ slowModeMs: 2000, burst: { lines: 5, windowMs: 10_000 }, duplicateWindowMs: null });
    expect(Object.isFrozen(p.pace)).toBe(true);
    expect(Object.isFrozen(p.pace.burst)).toBe(true);
    expect(PRESETS.standard.pace).toEqual(OFF);
  });

  it('overrides merge key by key onto the preset: one pace field keeps the others set in code', () => {
    const coded = defineProfile({ ...PRESETS.standard, pace: { slowModeMs: 1000, duplicateWindowMs: 5000 } });
    const p = resolveProfile(coded, { pace: { slowModeMs: 3000 } });
    expect(p.pace).toEqual({ slowModeMs: 3000, burst: null, duplicateWindowMs: 5000 });
  });

  it('a resolved profile passes validateProfile again (resolved pace is valid input)', () => {
    const p = resolveProfile('strict', { pace: { duplicateWindowMs: 20_000 } });
    expect(() => validateProfile(p)).not.toThrow();
    expect(defineProfile(p).pace).toEqual(p.pace);
  });

  it('a bad pace in code names profile.pace... and never echoes the value', () => {
    expect(failure(() => resolveProfile('standard', { pace: { slowModeMs: 12 } })).path).toBe('profile.pace.slowModeMs');
    expect(failure(() => resolveProfile('standard', { pace: { burst: { lines: 1, windowMs: 5000 } } })).path).toBe('profile.pace.burst.lines');
    expect(failure(() => resolveProfile('standard', { pace: { nope: 1 } as never })).path).toBe('profile.pace.nope');
    expect(failure(() => resolveProfile('standard', { pace: 5 as never })).path).toBe('profile.pace');
    expect(failure(() => resolveProfile('standard', { pace: { slowModeMs: 987654321 } })).message).not.toContain('987654321');
  });

  it('pace is a known top-level key but not a required one', () => {
    expect(() => validateProfile({ ...PRESETS.standard, pace: undefined })).not.toThrow();
  });
});

describe('pace in the layer', () => {
  it('POLICY_SECTIONS appends pace after ai', () => {
    expect([...POLICY_SECTIONS].slice(-5, -3)).toEqual(['ai', 'pace']);
  });

  it('a layer pace beats the code profile, field by field', () => {
    const coded = resolveProfile('standard', { pace: { slowModeMs: 1000, burst: { lines: 6, windowMs: 10_000 } } });
    const p = applyPolicyLayer(coded, { pace: { slowModeMs: 4000, duplicateWindowMs: 8000 } });
    expect(p.pace).toEqual({ slowModeMs: 4000, burst: { lines: 6, windowMs: 10_000 }, duplicateWindowMs: 8000 });
  });

  it('null in a layer turns a code setting off', () => {
    const coded = resolveProfile('standard', { pace: { slowModeMs: 1000, burst: { lines: 6, windowMs: 10_000 } } });
    expect(applyPolicyLayer(coded, { pace: { slowModeMs: null, burst: null } }).pace).toEqual(OFF);
  });

  it('a layer burst replaces the code burst whole, never member by member', () => {
    const coded = resolveProfile('standard', { pace: { burst: { lines: 6, windowMs: 10_000 } } });
    expect(applyPolicyLayer(coded, { pace: { burst: { lines: 3, windowMs: 4000 } } }).pace.burst).toEqual({ lines: 3, windowMs: 4000 });
    expect(bad({ pace: { burst: { lines: 3 } } }).path).toBe('layer.pace.burst.windowMs');
    expect(failure(() => applyPolicyLayer(coded, { pace: { burst: { lines: 3 } } } as never)).path).toBe('layer.pace.burst.windowMs');
  });

  it('an empty pace layer changes nothing', () => {
    const coded = resolveProfile('standard', { pace: { slowModeMs: 1000 } });
    expect(applyPolicyLayer(coded, { pace: {} }).pace).toEqual(coded.pace);
  });

  it('a layer touching pace.nope is refused with its path', () => {
    expect(bad({ pace: { nope: 1 } }).path).toBe('layer.pace.nope');
    expect(bad({ pace: { burst: { lines: 5, windowMs: 5000, nope: 1 } } }).path).toBe('layer.pace.burst.nope');
  });

  it('a layer with pace.burst.lines 1 is refused with layer.pace.burst.lines', () => {
    expect(bad({ pace: { burst: { lines: 1, windowMs: 5000 } } }).path).toBe('layer.pace.burst.lines');
  });

  it.each([
    [{ slowModeMs: 499 }, 'layer.pace.slowModeMs'],
    [{ slowModeMs: 1500.5 }, 'layer.pace.slowModeMs'],
    [{ slowModeMs: '2000' }, 'layer.pace.slowModeMs'],
    [{ burst: { lines: 5, windowMs: 999 } }, 'layer.pace.burst.windowMs'],
    [{ burst: 5 }, 'layer.pace.burst'],
    [{ duplicateWindowMs: 3_600_001 }, 'layer.pace.duplicateWindowMs'],
  ])('refuses %j with path %s', (pace, path) => {
    expect(bad({ pace }).path).toBe(path);
  });

  it('a layer pace that is not an object is refused at layer.pace', () => {
    for (const v of [5, 'x', null, [], true]) expect(bad({ pace: v }).path).toBe('layer.pace');
  });

  it('the error never echoes the value', () => {
    expect(bad({ pace: { slowModeMs: 987654321 } }).message).not.toContain('987654321');
  });

  it('the base is not changed by applying a layer', () => {
    const before = JSON.stringify(base());
    applyPolicyLayer(base(), { pace: { slowModeMs: 2000 } });
    expect(JSON.stringify(base())).toBe(before);
  });

  it('changedSections lists pace; layerSections lists pace in POLICY_SECTIONS order', () => {
    expect(changedSections({}, { pace: { slowModeMs: 2000 } })).toEqual(['pace']);
    expect(changedSections({ pace: { slowModeMs: 2000 } }, { pace: { slowModeMs: 2000 } })).toEqual([]);
    expect(changedSections({ pace: { slowModeMs: 2000 } }, { pace: { slowModeMs: 3000 } })).toEqual(['pace']);
    expect(changedSections({ pace: { burst: { lines: 5, windowMs: 5000 } } }, {})).toEqual(['pace']);
    expect(changedSections({ ai: { level: 1 } }, { ai: { level: 2 }, pace: { slowModeMs: 2000 }, durations: [3_600_000] })).toEqual(['durations', 'ai', 'pace']);
    expect(layerSections({ pace: {}, durations: [3_600_000], ai: { level: 1 } })).toEqual(['durations', 'ai', 'pace']);
    expect(layerSections({ pace: {} })).toEqual(['pace']);
  });
});

describe('cw.policy and the pace section', () => {
  it('starts off in effective and base', async () => {
    const { cw } = await world();
    expect(cw.profile.pace).toEqual(OFF);
    expect(cw.policy.get().base.pace).toEqual(OFF);
    expect(cw.policy.get().effective.pace).toEqual(OFF);
  });

  it('a code profile with pace resolves it', async () => {
    const { cw } = await world({ overrides: { pace: { slowModeMs: 2000 } } });
    expect(cw.profile.pace).toEqual({ ...OFF, slowModeMs: 2000 });
  });

  it('a layer pace beats the code profile and applies at once, reporting the section', async () => {
    const { cw } = await world({ overrides: { pace: { slowModeMs: 2000, duplicateWindowMs: 9000 } } });
    const res = cw.policy.save({ pace: { slowModeMs: 5000, burst: { lines: 4, windowMs: 8000 } } }, { version: 0, ...OWNER });
    expect(res).toEqual({ ok: true, version: 1, changed: ['pace'] });
    expect(cw.profile.pace).toEqual({ slowModeMs: 5000, burst: { lines: 4, windowMs: 8000 }, duplicateWindowMs: 9000 });
    expect(cw.policy.get().base.pace).toEqual({ ...OFF, slowModeMs: 2000, duplicateWindowMs: 9000 });
    expect(cw.policy.get().layer.pace).toEqual({ slowModeMs: 5000, burst: { lines: 4, windowMs: 8000 } });
  });

  it('a saved layer survives a second kit over the same store (another process)', async () => {
    const { cw, store } = await world();
    cw.policy.save({ pace: { slowModeMs: 3000 } }, { version: 0, ...OWNER });
    const { cw: other } = await world({}, store);
    expect(other.profile.pace.slowModeMs).toBe(3000);
  });

  it('reset("pace") restores the base and leaves the other sections', async () => {
    const { cw } = await world({ overrides: { pace: { slowModeMs: 2000 } } });
    cw.policy.save({ pace: { slowModeMs: 9000 }, customDuration: false }, { version: 0, ...OWNER });
    expect(cw.profile.pace.slowModeMs).toBe(9000);
    expect(cw.policy.reset('pace')).toMatchObject({ ok: true, changed: ['pace'] });
    expect(cw.profile.pace.slowModeMs).toBe(2000);
    expect(cw.profile.customDuration).toBe(false);
    expect(cw.policy.reset('pace')).toMatchObject({ ok: true, changed: [] });
  });

  it('an edit of only another section does not touch pace', async () => {
    const { cw } = await world({ overrides: { pace: { slowModeMs: 2000 } } });
    cw.policy.save({ customDuration: false }, { version: 0, ...OWNER });
    expect(cw.profile.pace.slowModeMs).toBe(2000);
  });

  it.each([
    [{ nope: 1 }, 'layer.pace.nope'],
    [{ burst: { lines: 1, windowMs: 5000 } }, 'layer.pace.burst.lines'],
    [{ slowModeMs: 1 }, 'layer.pace.slowModeMs'],
  ])('refuses %j with path %s and writes nothing', async (pace, path) => {
    const { cw } = await world();
    expect(cw.policy.save({ pace } as never, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path });
    expect(cw.policy.get().version).toBe(0);
    expect(cw.profile.pace).toEqual(OFF);
  });

  it('a stored layer that is no longer valid is ignored whole, as every layer error is, and pace reads from code', async () => {
    const { cw, store } = await world({ overrides: { pace: { slowModeMs: 2000 } } });
    store.savePolicyLayer?.({ pace: { slowModeMs: 1 } } as never, 0);
    const { cw: other, logged } = await world({ overrides: { pace: { slowModeMs: 2000 } } }, store);
    expect(other.profile.pace.slowModeMs).toBe(2000);
    expect(logged.some(([event]) => event === 'chatwarden.policy_layer_invalid')).toBe(true);
    void cw;
  });

  it('a save of only pace is audited policy.update with sections ["pace"] and no values', async () => {
    const { cw } = await world();
    const res = cw.policy.save({ pace: { slowModeMs: 123456 } }, { version: 0, ...OWNER });
    expect(res).toMatchObject({ ok: true, changed: ['pace'] });
    expect(cw.audit.record({ actor: 'owner_ann', role: 'owner', action: 'policy.update', detail: { sections: ['pace'], reason: 'quiet room' } })).toBe(true);
    const row = cw.audit.list({ limit: 1 }).items[0];
    expect(row?.detail).toEqual({ sections: ['pace'], reason: 'quiet room' });
    expect(JSON.stringify(row)).not.toContain('123456');
  });

  it('agentBrief and policyJson are unchanged by a pace layer', async () => {
    const { cw } = await world();
    const brief = cw.documents.agentBrief();
    const json = JSON.stringify(cw.documents.policyJson());
    cw.policy.save({ pace: { slowModeMs: 2000, burst: { lines: 5, windowMs: 10_000 }, duplicateWindowMs: 15_000 } }, { version: 0, ...OWNER });
    expect(cw.profile.pace.slowModeMs).toBe(2000);
    expect(cw.documents.agentBrief()).toBe(brief);
    expect(JSON.stringify(cw.documents.policyJson())).toBe(json);
    expect(brief).not.toMatch(/slow mode|slowMode|burst/i);
  });

  it('AUDIT_ACTIONS is unchanged', () => {
    expect(AUDIT_ACTIONS).toHaveLength(26);
    expect(AUDIT_ACTIONS.slice(-3)).toEqual(['ai.read', 'ai.rerun', 'ai.outcome']);
    expect([...AUDIT_ACTIONS].filter((a) => /pace|flood|signal/.test(a))).toEqual([]);
  });
});
