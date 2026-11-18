import { describe, expect, it } from 'vitest';
import { filtersActive, FILTER_SUGGESTIONS } from '../src/filters.js';
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

// The `filters` section: in the profile (code), in the layer (the owner's edits), through cw.policy and cw.profile.

const OFF = { links: null, personalInfo: null, phrases: [], ratio: null, ignore: [], flagCapPerDay: 50 };
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
const bad = (layer: unknown, b: ModerationProfile = base()): ProfileError => failure(() => applyPolicyLayer(b, layer as PolicyLayer));

describe('filters in the profile', () => {
  it('the presets resolve filters to off', () => {
    for (const name of ['relaxed', 'standard', 'strict'] as const) expect(PRESETS[name].filters).toEqual(OFF);
  });

  it('a profile written without filters resolves it to off', () => {
    const { filters: _drop, ...without } = PRESETS.standard as ModerationProfile & { filters?: unknown };
    void _drop;
    expect(defineProfile(without as ModerationProfile).filters).toEqual(OFF);
  });

  it('a code profile with filters resolves it, deep-frozen, and the preset is untouched', () => {
    const p = resolveProfile('standard', { filters: { links: { action: 'flag', allow: ['example.com'] } } });
    expect(p.filters.links).toMatchObject({ action: 'flag', rule: 4, allow: ['example.com'] });
    expect(Object.isFrozen(p.filters)).toBe(true);
    expect(Object.isFrozen(p.filters.links?.allow)).toBe(true);
    expect(PRESETS.standard.filters).toEqual(OFF);
  });

  it('a resolved profile passes validateProfile again (resolved filters are valid input)', () => {
    const p = resolveProfile('strict', { filters: { links: { action: 'refuse', newAccountDays: 2 }, ratio: { action: 'mask' }, phrases: [{ id: 'a', action: 'flag', phrases: ['buy gold'] }] } });
    expect(() => validateProfile(p)).not.toThrow();
    expect(defineProfile(p).filters).toEqual(p.filters);
  });

  it('a bad filters setting in code names profile.filters... and never echoes the value', () => {
    expect(failure(() => resolveProfile('standard', { filters: { links: { action: 'nope' as never } } })).path).toBe('profile.filters.links.action');
    expect(failure(() => resolveProfile('standard', { filters: { links: { action: 'count', allow: ['https://x.example'] } } })).path).toBe('profile.filters.links.allow[0]');
    expect(failure(() => resolveProfile('standard', { filters: 5 as never })).path).toBe('profile.filters');
    expect(failure(() => resolveProfile('standard', { filters: { flagCapPerDay: 98765 } })).message).not.toContain('98765');
  });

  it('filters is a known top-level key and not a required one', () => {
    expect(() => validateProfile({ ...PRESETS.standard, filters: undefined })).not.toThrow();
  });

  it('an override merges key by key onto a code profile (the deep merge of resolveProfile)', () => {
    const coded = defineProfile({ ...PRESETS.standard, filters: { links: { action: 'flag' }, flagCapPerDay: 10 } });
    const p = resolveProfile(coded, { filters: { flagCapPerDay: 12 } });
    expect(p.filters.flagCapPerDay).toBe(12);
    expect(p.filters.links?.action).toBe('flag');
  });
});

describe('filters in the layer', () => {
  it('POLICY_SECTIONS appends filters last of the first fifteen', () => {
    expect(POLICY_SECTIONS.includes('filters')).toBe(true);
    expect(POLICY_SECTIONS.indexOf('filters')).toBeGreaterThan(POLICY_SECTIONS.indexOf('names'));
    expect(new Set(POLICY_SECTIONS).size).toBe(POLICY_SECTIONS.length);
  });

  it('a layer beats the code profile, which beats the defaults', () => {
    expect(applyPolicyLayer(base(), {}).filters).toEqual(OFF);
    const coded = resolveProfile('standard', { filters: { links: { action: 'flag', allow: ['example.com'] }, flagCapPerDay: 10 } });
    expect(coded.filters.flagCapPerDay).toBe(10);
    const p = applyPolicyLayer(coded, { filters: { flagCapPerDay: 30, personalInfo: { action: 'mask' } } });
    expect(p.filters.flagCapPerDay).toBe(30);
    expect(p.filters.personalInfo?.action).toBe('mask');
    expect(p.filters.links).toEqual(coded.filters.links);
  });

  it('null in a layer turns a code block off', () => {
    const coded = resolveProfile('standard', { filters: { links: { action: 'flag' }, ratio: { action: 'count' } } });
    const p = applyPolicyLayer(coded, { filters: { links: null } });
    expect(p.filters.links).toBeNull();
    expect(p.filters.ratio?.action).toBe('count');
  });

  it('a layer links replaces the code links whole, never member by member', () => {
    const coded = resolveProfile('standard', { filters: { links: { action: 'flag', allow: ['example.com'], deny: ['zorbak.example'], newAccountDays: 3 } } });
    const p = applyPolicyLayer(coded, { filters: { links: { action: 'refuse', allow: ['cdn.example'] } } });
    expect(p.filters.links).toEqual({ action: 'refuse', rule: 4, allow: ['cdn.example'], deny: [], unlisted: 'act', invites: true, shorteners: true, newAccountDays: null });
    expect(bad({ filters: { links: { allow: ['cdn.example'] } } }, coded).path).toBe('layer.filters.links.action');
  });

  it('phrases in a layer replace the code list whole', () => {
    const coded = resolveProfile('standard', { filters: { phrases: [{ id: 'a', action: 'count', phrases: ['zorbak vlemmo'] }, { id: 'b', action: 'count', phrases: ['quissel drakkuun'] }] } });
    expect(applyPolicyLayer(coded, { filters: { phrases: [{ id: 'c', action: 'flag', phrases: ['fenrisk tarvo'] }] } }).filters.phrases.map((x) => x.id)).toEqual(['c']);
    expect(applyPolicyLayer(coded, { filters: { phrases: [] } }).filters.phrases).toEqual([]);
  });

  it('an empty filters layer changes nothing', () => {
    const coded = resolveProfile('standard', { filters: { links: { action: 'flag' } } });
    expect(applyPolicyLayer(coded, { filters: {} }).filters).toEqual(coded.filters);
  });

  it.each([
    [{ links: { action: 'count', allow: ['github.io'] } }, 'layer.filters.links.allow[0]'],
    [{ links: { action: 'count', allow: ['example.com'], deny: ['example.com'] } }, 'layer.filters.links.allow[0]'],
    [{ nope: 1 }, 'layer.filters.nope'],
    [{ ratio: { action: 'mask', caps: { minLetters: 7 } } }, 'layer.filters.ratio.caps.minLetters'],
    [{ phrases: [{ id: 'a', action: 'count', phrases: ['*'] }] }, 'layer.filters.phrases[0].phrases[0]'],
    [{ flagCapPerDay: 501 }, 'layer.filters.flagCapPerDay'],
  ])('refuses %j with path %s', (filters, path) => {
    expect(bad({ filters }).path).toBe(path);
  });

  it('a layer filters that is not an object is refused at layer.filters', () => {
    for (const v of [5, 'x', null, [], true]) expect(bad({ filters: v }).path).toBe('layer.filters');
  });

  it('the base is not changed by applying a layer', () => {
    const before = JSON.stringify(base());
    applyPolicyLayer(base(), { filters: { links: { action: 'refuse' } } });
    expect(JSON.stringify(base())).toBe(before);
  });

  it('changedSections lists filters; layerSections lists it in POLICY_SECTIONS order', () => {
    const f1 = { links: { action: 'flag' as const } };
    const f2 = { links: { action: 'refuse' as const } };
    expect(changedSections({}, { filters: f1 })).toEqual(['filters']);
    expect(changedSections({ filters: f1 }, { filters: { links: { action: 'flag' } } })).toEqual([]);
    expect(changedSections({ filters: f1 }, { filters: f2 })).toEqual(['filters']);
    expect(changedSections({ filters: f1 }, {})).toEqual(['filters']);
    expect(changedSections({ ai: { level: 1 } }, { ai: { level: 2 }, filters: f1, durations: [3_600_000] })).toEqual(['durations', 'ai', 'filters']);
    expect(layerSections({ filters: {}, durations: [3_600_000], names: {} })).toEqual(['durations', 'names', 'filters']);
  });
});

describe('cw.policy and the filters section', () => {
  it('starts off in effective and base', async () => {
    const { cw } = await world();
    expect(cw.profile.filters).toEqual(OFF);
    expect(cw.policy.get().base.filters).toEqual(OFF);
    expect(filtersActive(cw.policy.get().effective.filters)).toBe(false);
  });

  it('a layer filters beats the code profile and applies at once, reporting the section', async () => {
    const { cw } = await world({ overrides: { filters: { links: { action: 'flag' }, flagCapPerDay: 10 } } });
    const res = cw.policy.save({ filters: { links: { action: 'refuse', allow: ['example.com'] } } }, { version: 0, ...OWNER });
    expect(res).toEqual({ ok: true, version: 1, changed: ['filters'] });
    expect(cw.profile.filters.links?.action).toBe('refuse');
    expect(cw.profile.filters.flagCapPerDay).toBe(10);
    expect(cw.policy.get().base.filters.links?.action).toBe('flag');
    expect(cw.policy.get().layer.filters).toEqual({ links: { action: 'refuse', allow: ['example.com'] } });
  });

  it('a saved layer survives a second kit over the same store (another process)', async () => {
    const { cw, store } = await world();
    cw.policy.save({ filters: { flagCapPerDay: 7 } }, { version: 0, ...OWNER });
    const { cw: other } = await world({}, store);
    expect(other.profile.filters.flagCapPerDay).toBe(7);
  });

  it('reset("filters") restores the base and leaves the other sections', async () => {
    const { cw } = await world({ overrides: { filters: { flagCapPerDay: 10 } } });
    cw.policy.save({ filters: { flagCapPerDay: 99 }, customDuration: false }, { version: 0, ...OWNER });
    expect(cw.profile.filters.flagCapPerDay).toBe(99);
    expect(cw.policy.reset('filters')).toMatchObject({ ok: true, changed: ['filters'] });
    expect(cw.profile.filters.flagCapPerDay).toBe(10);
    expect(cw.profile.customDuration).toBe(false);
    expect(cw.policy.reset('filters')).toMatchObject({ ok: true, changed: [] });
  });

  it('an edit of only another section does not touch filters', async () => {
    const { cw } = await world({ overrides: { filters: { flagCapPerDay: 10 } } });
    cw.policy.save({ customDuration: false }, { version: 0, ...OWNER });
    expect(cw.profile.filters.flagCapPerDay).toBe(10);
  });

  it.each([
    [{ nope: 1 }, 'layer.filters.nope'],
    [{ links: { action: 'count', allow: ['vercel.app'] } }, 'layer.filters.links.allow[0]'],
    [{ flagCapPerDay: 0 }, 'layer.filters.flagCapPerDay'],
  ])('refuses %j with path %s and writes nothing', async (filters, path) => {
    const { cw } = await world();
    expect(cw.policy.save({ filters } as never, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path });
    expect(cw.policy.get().version).toBe(0);
    expect(cw.profile.filters).toEqual(OFF);
  });

  it('a rule that is not an active Community Rule is refused naming filters.links.rule, and nothing is written', async () => {
    const { cw } = await world();
    expect(cw.policy.save({ filters: { links: { action: 'count', rule: 9999 } } }, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path: 'layer.filters.links.rule' });
    expect(cw.policy.save({ filters: { personalInfo: { action: 'count', rule: 9999 } } }, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path: 'layer.filters.personalInfo.rule' });
    expect(cw.policy.save({ filters: { ratio: { action: 'count', rule: 9999 } } }, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path: 'layer.filters.ratio.rule' });
    expect(cw.policy.save({ filters: { phrases: [{ id: 'a', action: 'count', rule: 9999, phrases: ['zorbak vlemmo'] }] } }, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path: 'layer.filters.phrases[0].rule' });
    expect(cw.policy.get().version).toBe(0);
    // The default rules 4 and 2 are active Community Rules of the starter set, and so is rule 1.
    expect(cw.policy.save({ filters: { links: { action: 'count', rule: 1 }, personalInfo: { action: 'count' } } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
  });

  it('the preview refuses an inactive rule the same way and saves nothing', async () => {
    const { cw } = await world();
    expect(cw.policy.preview({ filters: { links: { action: 'count', rule: 9999 } } })).toEqual({ ok: false, error: 'invalid', path: 'layer.filters.links.rule' });
    expect(cw.policy.preview({ filters: { links: { action: 'count' } } })).toMatchObject({ ok: true });
    expect(cw.policy.get().version).toBe(0);
  });

  it('a code profile that cites an inactive rule is refused when the kit is made', async () => {
    await expect(world({ overrides: { filters: { links: { action: 'count', rule: 9999 } } } })).rejects.toMatchObject({ name: 'ProfileError', path: 'profile.filters.links.rule' });
  });

  it('a stored layer that is no longer valid is ignored whole, as every layer error is, and filters read from code', async () => {
    const { store } = await world({ overrides: { filters: { flagCapPerDay: 10 } } });
    store.savePolicyLayer?.({ filters: { flagCapPerDay: 0 } } as never, 0);
    const { cw: other, logged } = await world({ overrides: { filters: { flagCapPerDay: 10 } } }, store);
    expect(other.profile.filters.flagCapPerDay).toBe(10);
    expect(logged.some(([event]) => event === 'chatwarden.policy_layer_invalid')).toBe(true);
  });

  it('a rule switched off later does not stop the chat path or the load: only the next save fails', async () => {
    const { store } = await world();
    store.savePolicyLayer?.({ filters: { links: { action: 'count', rule: 9999 } } } as never, 0);
    const { cw } = await world({}, store);
    expect(cw.profile.filters.links?.rule).toBe(9999);
    expect(cw.policy.save({ filters: { links: { action: 'count', rule: 9999 } } }, { version: 1, ...OWNER })).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('agentBrief and policyJson are unchanged by an unset filters and by a saved one', async () => {
    const { cw } = await world();
    const brief = cw.documents.agentBrief();
    const json = JSON.stringify(cw.documents.policyJson());
    expect(json).not.toContain('filters');
    cw.policy.save({ filters: { links: { action: 'refuse', allow: ['example.com'] }, phrases: [{ id: 'a', action: 'count', phrases: ['zorbak vlemmo'] }] } }, { version: 0, ...OWNER });
    expect(cw.profile.filters.links?.action).toBe('refuse');
    expect(cw.documents.agentBrief()).toBe(brief);
    expect(JSON.stringify(cw.documents.policyJson())).toBe(json);
  });

  it('suggestions are never applied by themselves', async () => {
    const { cw } = await world();
    expect(Object.keys(FILTER_SUGGESTIONS)).toContain('standard');
    expect(filtersActive(cw.profile.filters)).toBe(false);
    expect(cw.policy.save({ filters: FILTER_SUGGESTIONS.standard }, { version: 0, ...OWNER })).toMatchObject({ ok: true, changed: ['filters'] });
    expect(cw.profile.filters.links?.action).toBe('flag');
  });

  it('a save of only filters is audited policy.update with sections ["filters"] and no values', async () => {
    const { cw } = await world();
    const res = cw.policy.save({ filters: { phrases: [{ id: 'a', action: 'count', phrases: ['quissel drakkuun'] }] } }, { version: 0, ...OWNER });
    expect(res).toMatchObject({ ok: true, changed: ['filters'] });
    expect(cw.audit.record({ actor: 'owner_ann', role: 'owner', action: 'policy.update', detail: { sections: ['filters'], reason: 'ads' } })).toBe(true);
    const row = cw.audit.list({ limit: 1 }).items[0];
    expect(row?.detail).toEqual({ sections: ['filters'], reason: 'ads' });
    expect(JSON.stringify(row)).not.toContain('quissel');
  });
});
