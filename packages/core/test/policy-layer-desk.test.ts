import { describe, expect, it } from 'vitest';
import { resolveDesk } from '../src/desk.js';
import { DEFAULT_SAFETY_GUIDANCE, resolveSafety } from '../src/safety.js';
import { resolveRooms } from '../src/roomSettings.js';
import { applyPolicyLayer, changedSections, defineProfile, layerSections, POLICY_SECTIONS, PRESETS, ProfileError, resolveProfile, validateProfile } from '../src/profile.js';
import type { ModerationProfile, PolicyLayer } from '../src/profile.js';
import { OWNER, world } from './reportingWorld.js';

// The `desk`, `safety` and `rooms` sections: in the profile (code), in the layer (the owner's edits), through cw.policy and cw.profile.

const DESK_OFF = resolveDesk(undefined);
const SAFETY_OFF = resolveSafety(undefined);
const ROOMS_OFF = resolveRooms(undefined);
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

describe('the three sections in the profile', () => {
  it('presets ship all three sections unset (the defaults)', () => {
    for (const name of ['relaxed', 'standard', 'strict'] as const) {
      expect(PRESETS[name].desk).toEqual(DESK_OFF);
      expect(PRESETS[name].safety).toEqual(SAFETY_OFF);
      expect(PRESETS[name].rooms).toEqual(ROOMS_OFF);
    }
    expect(PRESETS.standard.safety.guidance).toBe(DEFAULT_SAFETY_GUIDANCE);
  });

  it('a profile written without them resolves to the defaults', () => {
    const { desk: _d, safety: _s, rooms: _r, ...without } = PRESETS.standard as ModerationProfile & Record<string, unknown>;
    void _d;
    void _s;
    void _r;
    const p = defineProfile(without as ModerationProfile);
    expect([p.desk, p.safety, p.rooms]).toEqual([DESK_OFF, SAFETY_OFF, ROOMS_OFF]);
  });

  it('a code profile that sets them resolves them, deep-frozen, and the preset is untouched', () => {
    const p = resolveProfile('standard', {
      desk: { workflow: true, surge: { enabled: true, reports: 8 } },
      safety: { contact: 'Ask Ann', resources: [{ label: 'Line', url: 'https://help.example.com' }] },
      rooms: { emergency: { slowModeMs: 2000 }, unknownAge: 'treat_as_new' },
    });
    expect(p.desk).toEqual({ workflow: true, insights: false, surge: { enabled: true, reports: 8, windowMinutes: 10, newAccountDays: 2 } });
    expect(p.safety.contact).toBe('Ask Ann');
    expect(p.safety.resources).toEqual([{ label: 'Line', detail: '', url: 'https://help.example.com' }]);
    expect(p.rooms.emergency).toEqual({ slowModeMs: 2000, newAccountDays: 7 });
    expect(Object.isFrozen(p.desk.surge)).toBe(true);
    expect(Object.isFrozen(p.safety.resources[0])).toBe(true);
    expect(PRESETS.standard.desk).toEqual(DESK_OFF);
  });

  it('a resolved profile passes validateProfile again', () => {
    const p = resolveProfile('strict', { desk: { insights: true }, safety: { guidance: 'Pass it on.' }, rooms: { probation: { enabled: true } } });
    expect(() => validateProfile(p)).not.toThrow();
    expect(defineProfile(p)).toEqual(p);
  });

  it('a bad value in code names profile.<section>... and never echoes it', () => {
    expect(failure(() => resolveProfile('standard', { rooms: { emergency: { slowModeMs: 5 } } })).path).toBe('profile.rooms.emergency.slowModeMs');
    expect(failure(() => resolveProfile('standard', { desk: { surge: { reports: 1 } } })).path).toBe('profile.desk.surge.reports');
    const err = failure(() => resolveProfile('standard', { safety: { resources: [{ label: 'x', url: 'http://zorbak.example' }] } }));
    expect(err.path).toBe('profile.safety.resources[0].url');
    expect(err.message).not.toContain('zorbak');
  });
});

describe('the sections in the layer', () => {
  it('the editable sections append desk, safety, rooms after the earlier ones', () => {
    const s = [...POLICY_SECTIONS];
    expect(s.slice(0, 14)).toEqual(['durations', 'customDuration', 'ladder', 'firstOffense', 'repeat', 'areaRules', 'severeRules', 'guidelines', 'reporting', 'ai', 'pace', 'signals', 'appeals', 'names']);
    const at = s.indexOf('desk');
    expect(at).toBeGreaterThan(13);
    expect(s.slice(at, at + 3)).toEqual(['desk', 'safety', 'rooms']);
  });

  it('a layer beats the code profile, which beats the defaults', () => {
    const code = resolveProfile('standard', { desk: { workflow: true, surge: { reports: 8 } }, rooms: { defaultModeMs: 120_000 } });
    expect(code.desk.surge.reports).toBe(8);
    const effective = applyPolicyLayer(code, { desk: { surge: { reports: 20 } }, rooms: { emergency: { newAccountDays: 3 } }, safety: { contact: 'Bea' } });
    expect(effective.desk.surge.reports).toBe(20);
    expect(effective.desk.workflow).toBe(true);
    expect(effective.rooms.emergency).toEqual({ slowModeMs: 30_000, newAccountDays: 3 });
    expect(effective.rooms.defaultModeMs).toBe(120_000);
    expect(effective.safety.contact).toBe('Bea');
    expect(effective.safety.guidance).toBe(DEFAULT_SAFETY_GUIDANCE);
    expect(Object.isFrozen(effective.desk)).toBe(true);
    expect(code.desk.surge.reports).toBe(8);
  });

  it('a layer resources list replaces the whole list', () => {
    const code = resolveProfile('standard', { safety: { resources: [{ label: 'One' }, { label: 'Two' }] } });
    const effective = applyPolicyLayer(code, { safety: { resources: [{ label: 'Three' }] } });
    expect(effective.safety.resources.map((r) => r.label)).toEqual(['Three']);
  });

  it.each([
    [{ desk: { surge: { reports: 2 } } }, 'layer.desk.surge.reports'],
    [{ desk: { nope: 1 } }, 'layer.desk.nope'],
    [{ desk: 'on' }, 'layer.desk'],
    [{ safety: { contact: 'x'.repeat(301) } }, 'layer.safety.contact'],
    [{ safety: { resources: [{ label: 'x', url: 'javascript:alert(1)' }] } }, 'layer.safety.resources[0].url'],
    [{ rooms: { emergency: { slowModeMs: 999 } } }, 'layer.rooms.emergency.slowModeMs'],
    [{ rooms: { unknownAge: 'maybe' } }, 'layer.rooms.unknownAge'],
  ])('refuses %j with path %s', (layer, path) => {
    expect(bad(layer).path).toBe(path);
  });

  it('layerSections and changedSections list the sections', () => {
    expect(layerSections({ rooms: {}, desk: {}, customDuration: true })).toEqual(['customDuration', 'desk', 'rooms']);
    expect(changedSections({ desk: { workflow: true } }, { desk: { workflow: true }, safety: { contact: 'x' } })).toEqual(['safety']);
    expect(changedSections({}, { rooms: { defaultModeMs: 60_000 }, desk: { insights: true } })).toEqual(['desk', 'rooms']);
    expect(changedSections({ desk: { insights: true } }, {})).toEqual(['desk']);
  });
});

describe('cw.policy and the three sections', () => {
  it('start at the defaults in effective and base', async () => {
    const { cw } = await world();
    expect([cw.profile.desk, cw.profile.safety, cw.profile.rooms]).toEqual([DESK_OFF, SAFETY_OFF, ROOMS_OFF]);
    expect(cw.policy.get().base.desk).toEqual(DESK_OFF);
  });

  it('a layer beats the code profile and applies at once, reporting the sections', async () => {
    const { cw } = await world({ overrides: { desk: { surge: { reports: 8 } } } });
    const res = cw.policy.save({ desk: { workflow: true }, rooms: { defaultModeMs: 90_000 }, safety: { contact: 'Ann' } }, { version: 0, ...OWNER });
    expect(res).toEqual({ ok: true, version: 1, changed: ['desk', 'safety', 'rooms'] });
    expect(cw.profile.desk).toEqual({ workflow: true, insights: false, surge: { enabled: false, reports: 8, windowMinutes: 10, newAccountDays: 2 } });
    expect(cw.profile.rooms.defaultModeMs).toBe(90_000);
    expect(cw.policy.get().base.desk.workflow).toBe(false);
  });

  it('a saved layer survives a second kit over the same store', async () => {
    const { cw, store } = await world();
    cw.policy.save({ rooms: { unknownAge: 'treat_as_new' } }, { version: 0, ...OWNER });
    const { cw: other } = await world({}, store);
    expect(other.profile.rooms.unknownAge).toBe('treat_as_new');
  });

  it('reset("desk"), reset("safety") and reset("rooms") restore the base', async () => {
    const { cw } = await world({ overrides: { rooms: { defaultModeMs: 120_000 } } });
    cw.policy.save({ desk: { insights: true }, safety: { contact: 'Ann' }, rooms: { defaultModeMs: 60_000 }, customDuration: false }, { version: 0, ...OWNER });
    expect(cw.profile.rooms.defaultModeMs).toBe(60_000);
    expect(cw.policy.reset('desk')).toMatchObject({ ok: true, changed: ['desk'] });
    expect(cw.profile.desk).toEqual(DESK_OFF);
    expect(cw.policy.reset('safety')).toMatchObject({ ok: true, changed: ['safety'] });
    expect(cw.profile.safety).toEqual(SAFETY_OFF);
    expect(cw.policy.reset('rooms')).toMatchObject({ ok: true, changed: ['rooms'] });
    expect(cw.profile.rooms.defaultModeMs).toBe(120_000);
    expect(cw.profile.customDuration).toBe(false);
    expect(cw.policy.reset('rooms')).toMatchObject({ ok: true, changed: [] });
  });

  it('a bad layer is refused with its path and writes nothing', async () => {
    const { cw } = await world();
    expect(cw.policy.save({ rooms: { emergency: { slowModeMs: 5 } } } as never, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path: 'layer.rooms.emergency.slowModeMs' });
    expect(cw.policy.preview({ desk: { surge: { reports: 1 } } } as never)).toEqual({ ok: false, error: 'invalid', path: 'layer.desk.surge.reports' });
    expect(cw.policy.get().version).toBe(0);
    expect(cw.profile.rooms).toEqual(ROOMS_OFF);
  });

  it('a save audits policy.update with sections only and no values', async () => {
    const { cw } = await world();
    const res = cw.policy.save({ safety: { contact: 'Call quissel at the vlemmo desk' }, desk: { workflow: true } }, { version: 0, ...OWNER });
    expect(res).toMatchObject({ ok: true, changed: ['desk', 'safety'] });
    expect(cw.audit.record({ actor: 'owner_ann', role: 'owner', action: 'policy.update', detail: { sections: ['desk', 'safety'], reason: 'safety line' } })).toBe(true);
    const row = cw.audit.list({ limit: 1 }).items[0];
    expect(row?.detail).toEqual({ sections: ['desk', 'safety'], reason: 'safety line' });
    expect(JSON.stringify(row)).not.toContain('quissel');
  });

  it('policyJson and agentBrief carry none of the three (they are runtime settings, and contact is staff only)', async () => {
    const { cw } = await world();
    const brief = cw.documents.agentBrief();
    const json = JSON.stringify(cw.documents.policyJson());
    cw.policy.save({ safety: { contact: 'SECRET-CONTACT', guidance: 'SECRET-GUIDANCE' }, desk: { workflow: true } }, { version: 0, ...OWNER });
    const after = JSON.stringify(cw.documents.policyJson());
    expect(after).toBe(json);
    expect(after).not.toMatch(/SECRET|"desk"|"safety"|"rooms"/);
    expect(cw.documents.agentBrief()).toBe(brief);
  });
});
