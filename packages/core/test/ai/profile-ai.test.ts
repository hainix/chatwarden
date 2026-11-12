import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../../src/chatwarden.js';
import { agentBrief, policyJson } from '../../src/documents.js';
import { checkRetentionFloors, purge, RETENTION_DEFAULTS } from '../../src/retention.js';
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
} from '../../src/profile.js';
import type { ModerationProfile, PresetName } from '../../src/profile.js';
import { defineRules, starterRules } from '../../src/rules.js';
import { OWNER, world } from '../reportingWorld.js';

const DAY = 86_400_000;
const NAMES: PresetName[] = ['relaxed', 'standard', 'strict'];

function pathOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProfileError) return err.path;
    throw err;
  }
  throw new Error('expected a ProfileError');
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProfileError) return err.reason;
    throw err;
  }
  throw new Error('expected a ProfileError');
}

describe('the ai section of a profile', () => {
  it('the presets default ai.level to 0', () => {
    for (const n of NAMES) {
      expect(PRESETS[n].ai).toEqual({ level: 0, learn: true });
      expect(Object.isFrozen(PRESETS[n].ai)).toBe(true);
    }
  });

  it('a profile written before 0.1.6 (no ai) gets the default', () => {
    const { ai: _ai, ...without } = PRESETS.standard as ModerationProfile & { ai?: unknown };
    void _ai;
    expect(defineProfile(without as ModerationProfile).ai).toEqual({ level: 0, learn: true });
    expect(resolveProfile('relaxed').ai).toEqual({ level: 0, learn: true });
  });

  it('a profile may set the level and learn, each alone', () => {
    expect(defineProfile({ ...PRESETS.standard, ai: { level: 2, learn: false } }).ai).toEqual({ level: 2, learn: false });
    expect(defineProfile({ ...PRESETS.standard, ai: { level: 1 } }).ai).toEqual({ level: 1, learn: true });
    expect(defineProfile({ ...PRESETS.standard, ai: { learn: false } }).ai).toEqual({ level: 0, learn: false });
    expect(resolveProfile('strict', { ai: { level: 1 } }).ai).toEqual({ level: 1, learn: true });
  });

  it('validateProfile accepts the section as written', () => {
    expect(() => validateProfile({ ...PRESETS.standard, ai: { level: 2, learn: true } })).not.toThrow();
    expect(() => validateProfile({ ...PRESETS.standard, ai: {} })).not.toThrow();
  });

  it('level 3 and 4 are refused with a path', () => {
    for (const level of [3, 4]) {
      expect(pathOf(() => defineProfile({ ...PRESETS.standard, ai: { level } } as never))).toBe('profile.ai.level');
      expect(reasonOf(() => defineProfile({ ...PRESETS.standard, ai: { level } } as never))).toMatch(/not available yet/);
      expect(pathOf(() => applyPolicyLayer(PRESETS.standard, { ai: { level } } as never))).toBe('layer.ai.level');
    }
  });

  it.each([5, -1, 0.5, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY, true, [], {}])('a level of %j is refused', (level) => {
    expect(pathOf(() => defineProfile({ ...PRESETS.standard, ai: { level } } as never))).toBe('profile.ai.level');
  });

  it.each(['yes', 1, 0, null, [], {}, 'true'])('learn must be a boolean: %j is refused', (learn) => {
    expect(pathOf(() => defineProfile({ ...PRESETS.standard, ai: { learn } } as never))).toBe('profile.ai.learn');
    expect(pathOf(() => applyPolicyLayer(PRESETS.standard, { ai: { learn } } as never))).toBe('layer.ai.learn');
  });

  it('refuses an unknown key and a non-object', () => {
    expect(pathOf(() => defineProfile({ ...PRESETS.standard, ai: { level: 1, maxLevel: 2 } } as never))).toBe('profile.ai.maxLevel');
    expect(pathOf(() => defineProfile({ ...PRESETS.standard, ai: 'on' } as never))).toBe('profile.ai');
    expect(pathOf(() => defineProfile({ ...PRESETS.standard, ai: null } as never))).toBe('profile.ai');
    expect(pathOf(() => defineProfile({ ...PRESETS.standard, ai: [1] } as never))).toBe('profile.ai');
  });

  it('the error never echoes the value', () => {
    const reason = reasonOf(() => defineProfile({ ...PRESETS.standard, ai: { learn: 'secret-vlemmo' } } as never));
    expect(reason).not.toContain('vlemmo');
  });
});

describe('the ai section of a policy layer', () => {
  it('is an editable section, after reporting', () => {
    expect([...POLICY_SECTIONS]).toEqual([
      'durations', 'customDuration', 'ladder', 'firstOffense', 'repeat', 'areaRules', 'severeRules', 'guidelines', 'reporting', 'ai',
    ]);
  });

  it('a layer may set level 1 and 2', () => {
    for (const level of [1, 2] as const) {
      const p = applyPolicyLayer(PRESETS.standard, { ai: { level } });
      expect(p.ai).toEqual({ level, learn: true });
    }
    expect(applyPolicyLayer(PRESETS.standard, { ai: { level: 0 } }).ai.level).toBe(0);
  });

  it('a layer merges key by key: learn alone keeps the base level', () => {
    const base = resolveProfile('standard', { ai: { level: 1 } });
    expect(applyPolicyLayer(base, { ai: { learn: false } }).ai).toEqual({ level: 1, learn: false });
    expect(applyPolicyLayer(base, {}).ai).toEqual({ level: 1, learn: true });
  });

  it('changes nothing else in the profile', () => {
    const p = applyPolicyLayer(PRESETS.standard, { ai: { level: 2 } });
    expect({ ...p, ai: undefined }).toEqual({ ...PRESETS.standard, ai: undefined });
  });

  it('layerSections and changedSections know it', () => {
    expect(layerSections({ ai: { level: 1 }, durations: [3_600_000] })).toEqual(['durations', 'ai']);
    expect(changedSections({}, { ai: { level: 1 } })).toEqual(['ai']);
    expect(changedSections({ ai: { level: 1 } }, { ai: { level: 1 } })).toEqual([]);
    expect(changedSections({ ai: { level: 1 } }, { ai: { level: 2 } })).toEqual(['ai']);
    expect(changedSections({ ai: { level: 1 } }, {})).toEqual(['ai']);
  });

  it('a layer may not carry a key outside the section', () => {
    expect(pathOf(() => applyPolicyLayer(PRESETS.standard, { ai: { level: 1 }, aiContext: 'x' } as never))).toBe('layer.aiContext');
    expect(pathOf(() => applyPolicyLayer(PRESETS.standard, { ai: { adapter: 'x' } } as never))).toBe('layer.ai.adapter');
  });
});

describe('cw.policy and the ai section', () => {
  it('starts off', async () => {
    const { cw } = await world();
    expect(cw.profile.ai).toEqual({ level: 0, learn: true });
    expect(cw.policy.get().base.ai).toEqual({ level: 0, learn: true });
  });

  it('a layer may set level 1 and 2, and cw.profile follows at once', async () => {
    const { cw } = await world();
    expect(cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER })).toEqual({ ok: true, version: 1, changed: ['ai'] });
    expect(cw.profile.ai.level).toBe(1);
    expect(cw.policy.save({ ai: { level: 2, learn: false } }, { version: 1, ...OWNER })).toEqual({ ok: true, version: 2, changed: ['ai'] });
    expect(cw.profile.ai).toEqual({ level: 2, learn: false });
    expect(cw.policy.get().base.ai.level).toBe(0);
  });

  it('level 3 and 4 are refused with a path and write nothing', async () => {
    const { cw } = await world();
    for (const level of [3, 4]) {
      expect(cw.policy.save({ ai: { level } } as never, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path: 'layer.ai.level' });
    }
    expect(cw.policy.get().version).toBe(0);
    expect(cw.profile.ai.level).toBe(0);
  });

  it('learn must be a boolean', async () => {
    const { cw } = await world();
    expect(cw.policy.save({ ai: { learn: 'yes' } } as never, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path: 'layer.ai.learn' });
  });

  it('reset("ai") returns to the base and leaves the other sections', async () => {
    const { cw } = await world();
    cw.policy.save({ ai: { level: 2 }, durations: [3_600_000] }, { version: 0, ...OWNER });
    expect(cw.policy.reset('ai')).toEqual({ ok: true, version: 2, changed: ['ai'] });
    expect(cw.profile.ai.level).toBe(0);
    expect(cw.profile.durations).toEqual([3_600_000]);
    expect(cw.policy.get().layer).toEqual({ durations: [3_600_000] });
    // Nothing left to reset is a no-op.
    expect(cw.policy.reset('ai')).toEqual({ ok: true, version: 2, changed: [] });
  });

  it('a layer saved by another process is seen by a second kit over the same store', async () => {
    const { cw, store } = await world();
    cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER });
    const { cw: other } = await world({}, store);
    expect(other.profile.ai.level).toBe(1);
  });

  it('a save of only ai is audited with sections ["ai"]', async () => {
    const { cw } = await world();
    const saved = cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER });
    expect(saved).toMatchObject({ ok: true, changed: ['ai'] });
    if (!saved.ok) return;
    expect(cw.audit.record({ actor: OWNER.actor, role: 'owner', action: 'policy.update', detail: { sections: saved.changed, reason: OWNER.reason } })).toBe(true);
    const row = cw.audit.list({ limit: 1 }).items[0];
    expect(row).toMatchObject({ action: 'policy.update', detail: { sections: ['ai'], reason: OWNER.reason } });
    // The row carries the section name and the reason, never the values.
    expect(JSON.stringify(row)).not.toContain('level');
    // And a reset of the section is audited the same way.
    const reset = cw.policy.reset('ai');
    expect(reset).toMatchObject({ ok: true, changed: ['ai'] });
    expect(cw.audit.record({ actor: OWNER.actor, role: 'owner', action: 'policy.reset', detail: { sections: ['ai'] } })).toBe(true);
  });

  it('preview with an ai layer still works and changes no suggestion', async () => {
    const { cw } = await world();
    const a = cw.policy.preview({});
    const b = cw.policy.preview({ ai: { level: 2 } });
    expect(b).toEqual(a);
    expect(cw.policy.preview({ ai: { level: 3 } } as never)).toEqual({ ok: false, error: 'invalid', path: 'layer.ai.level' });
  });
});

describe('the documents do not carry the ai section', () => {
  const policyAt = (name: PresetName, level: 0 | 1 | 2) => {
    const profile = resolveProfile(name, { ai: { level, learn: level !== 1 } });
    return { profile, rules: defineRules(starterRules(profile.rules)) };
  };

  it('agentBrief is unchanged', () => {
    for (const n of NAMES) {
      const base = agentBrief(policyAt(n, 0));
      expect(agentBrief(policyAt(n, 1))).toBe(base);
      expect(agentBrief(policyAt(n, 2))).toBe(base);
      expect(base).not.toMatch(/\bai\.level\b|learn/i);
    }
  });

  it('policyJson is unchanged: no ai key, whatever the level', () => {
    for (const n of NAMES) {
      const base = policyJson(policyAt(n, 0));
      expect(Object.hasOwn(base.profile, 'ai')).toBe(false);
      expect(policyJson(policyAt(n, 2))).toEqual(base);
      // It still reads back through defineProfile.
      expect(defineProfile(JSON.parse(JSON.stringify(base)).profile as ModerationProfile)).toEqual(PRESETS[n]);
    }
  });
});

describe('retention fields for the AI', () => {
  it('has the defaults: outcomes 365 days, examples 180 days', () => {
    expect(RETENTION_DEFAULTS.aiOutcomesMs).toBe(365 * DAY);
    expect(RETENTION_DEFAULTS.aiExamplesMs).toBe(180 * DAY);
    expect(RETENTION_DEFAULTS.reportsMs).toBe(90 * DAY); // a read goes with its report
  });

  it('defaults satisfy the floors', () => {
    expect(() => checkRetentionFloors({ ...RETENTION_DEFAULTS }, 30 * DAY)).not.toThrow();
    expect(() => checkRetentionFloors({}, 30 * DAY)).not.toThrow();
  });

  it('retention: aiOutcomesMs below 90 days throws a ProfileError naming the field', () => {
    for (const ms of [0, 1, 89 * DAY, 90 * DAY - 1]) {
      expect(pathOf(() => checkRetentionFloors({ aiOutcomesMs: ms }, 30 * DAY))).toBe('retention.aiOutcomesMs');
    }
    expect(() => checkRetentionFloors({ aiOutcomesMs: 90 * DAY }, 30 * DAY)).not.toThrow();
    expect(() => checkRetentionFloors({ aiOutcomesMs: 5 * 365 * DAY }, 30 * DAY)).not.toThrow();
  });

  it('aiExamplesMs may be 0 (keep no text at all) but not negative', () => {
    expect(() => checkRetentionFloors({ aiExamplesMs: 0 }, 30 * DAY)).not.toThrow();
    expect(() => checkRetentionFloors({ aiExamplesMs: 1 }, 30 * DAY)).not.toThrow();
    expect(pathOf(() => checkRetentionFloors({ aiExamplesMs: -1 }, 30 * DAY))).toBe('retention.aiExamplesMs');
  });

  it('both must be finite numbers', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '90', null]) {
      expect(pathOf(() => checkRetentionFloors({ aiOutcomesMs: bad } as never, 30 * DAY))).toBe('retention.aiOutcomesMs');
      expect(pathOf(() => checkRetentionFloors({ aiExamplesMs: bad } as never, 30 * DAY))).toBe('retention.aiExamplesMs');
    }
  });

  it('createChatwarden refuses a retention below the floor, and accepts the new fields', async () => {
    const make = (retention: object) =>
      createChatwarden({ store: new MemoryStore(), secret: 'ai-retention', platform: { identify: (c) => c as never }, retention: retention as never });
    await expect(make({ aiOutcomesMs: 1 })).rejects.toThrow(ProfileError);
    const cw = await make({ aiOutcomesMs: 100 * DAY, aiExamplesMs: 0, everyMs: 3_600_000 });
    await expect(cw.purge({ aiOutcomesMs: 1 })).rejects.toThrow(ProfileError);
    await expect(cw.purge({ aiOutcomesMs: 100 * DAY, aiExamplesMs: 0 })).resolves.toBeTypeOf('object');
    await cw.close();
  });

  it('purge of a store with no AI methods still works', async () => {
    const store = new MemoryStore();
    const res = await purge(store, 1_800_000_000_000);
    expect(res).toMatchObject({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 0, audit: 0, webhookKeys: 0 });
    const res2 = await purge(store, 1_800_000_000_000, { aiOutcomesMs: 100 * DAY, aiExamplesMs: 0 });
    expect(res2.reports).toBe(0);
  });

  it('purge still checks the new windows', async () => {
    const store = new MemoryStore();
    await expect(purge(store, 1, { aiExamplesMs: -1 })).rejects.toThrow(/invalid aiExamplesMs/);
    await expect(purge(store, 1, { aiOutcomesMs: Number.NaN })).rejects.toThrow(/invalid aiOutcomesMs/);
  });
});
