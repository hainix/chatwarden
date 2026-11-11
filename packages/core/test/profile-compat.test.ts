import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import { agentBrief, codeOfConduct, moderatorGuide, policyJson } from '../src/documents.js';
import { LADDER_TABLE } from '../src/ladder.js';
import {
  applyPolicyLayer,
  DEFAULT_DURATIONS,
  defineProfile,
  PRESETS,
  ProfileError,
  resolveProfile,
  validateProfile,
} from '../src/profile.js';
import type { ModerationProfile, PolicyState, ProfileInput, ResolvedProfile } from '../src/index.js';
import { defineRules, starterRules } from '../src/rules.js';
import type { RawWho } from '../src/types.js';

// A profile written for 0.1.1: it has no `durations` and no `customDuration`. It must keep type-checking (this file is compiled by
// `tsc -b packages/core/tsconfig.test.json`) and keep working at runtime through every entry point that takes a profile.

const HOUR = 3_600_000;

const legacy: ModerationProfile = {
  id: 'legacy',
  name: 'Legacy',
  summary: 'Be good.',
  firstOffense: { banter: 'none', rude: 'warning', hostile: { kind: 'chat', durationMs: HOUR }, severe: 'warning' },
  repeat: { windowDays: 14, notes: 3, distinctGames: false, outcome: 'warning' },
  ladder: LADDER_TABLE,
  profanity: { mode: 'allow', style: 'grawlix', add: [], remove: [], only: null, languages: ['en'] },
  aiContext: 'Be gentle with banter. Act only on clear threats.',
  aiAutoAct: [],
  rules: 'standard',
  levels: PRESETS.standard.levels,
  guidelines: [
    { title: 'All good', description: 'd', examples: ['ez'], covers: ['banter'], outcome: 'No action.' },
    { title: 'Not good', description: 'd', examples: [], covers: ['rude', 'hostile', 'severe'], outcome: 'Warning.' },
  ],
};

const rules = defineRules(starterRules('standard'));
const copyOf = (p: ModerationProfile): Record<string, unknown> => JSON.parse(JSON.stringify(p)) as Record<string, unknown>;

describe('a 0.1.1-shaped profile at runtime', () => {
  it('passes validateProfile', () => {
    expect(() => validateProfile(copyOf(legacy))).not.toThrow();
  });

  it('validateProfile still checks the two new keys when they are present', () => {
    const bad = { ...copyOf(legacy), durations: [2, 1] };
    expect(() => validateProfile(bad)).toThrow(ProfileError);
    expect(() => validateProfile({ ...copyOf(legacy), customDuration: 'yes' })).toThrow(ProfileError);
    expect(() => validateProfile({ ...copyOf(legacy), durations: [HOUR], customDuration: false })).not.toThrow();
  });

  it('works in every document function, which read the defaults', () => {
    const policy = { profile: legacy, rules };
    expect(codeOfConduct(policy, { format: 'markdown', gameName: 'Quissel Quest' })).toContain('Quissel Quest');
    expect(moderatorGuide(policy, { format: 'text' })).toContain('Legacy');
    expect(agentBrief(policy)).toContain('Legacy');
    const json = policyJson(policy);
    expect(json.profile.durations).toEqual([...DEFAULT_DURATIONS]);
    expect(json.profile.customDuration).toBe(true);
  });

  it('does not change the profile it was given', () => {
    policyJson({ profile: legacy, rules });
    moderatorGuide({ profile: legacy, rules }, { format: 'markdown' });
    expect(Object.keys(legacy)).not.toContain('durations');
    expect(Object.keys(legacy)).not.toContain('customDuration');
  });

  it('documents read the profile once per call (a getter is not called twice)', () => {
    let reads = 0;
    const policy = {
      get profile(): ModerationProfile {
        reads += 1;
        return legacy;
      },
      rules,
    };
    moderatorGuide(policy, { format: 'markdown' });
    expect(reads).toBe(1);
    reads = 0;
    agentBrief(policy);
    expect(reads).toBe(1);
    reads = 0;
    codeOfConduct(policy, { format: 'text', gameName: 'G' });
    expect(reads).toBe(1);
    reads = 0;
    policyJson(policy);
    expect(reads).toBe(1);
  });

  it('works in defineProfile, resolveProfile and createChatwarden, filling the defaults', async () => {
    expect(defineProfile(legacy).durations).toEqual([...DEFAULT_DURATIONS]);
    expect(resolveProfile(legacy, { name: 'Renamed' }).customDuration).toBe(true);
    const cw = await createChatwarden({
      store: new MemoryStore(),
      secret: 'compat-secret',
      platform: { identify: (ctx) => ctx as RawWho },
      retention: false,
      logger: { warn: () => undefined },
      profile: legacy,
    });
    expect(cw.profile.id).toBe('legacy');
    expect(cw.profile.durations).toEqual([...DEFAULT_DURATIONS]);
    expect(cw.profile.customDuration).toBe(true);
    expect(cw.policy.get().base.durations).toEqual([...DEFAULT_DURATIONS]);
  });
});

describe('the profile types', () => {
  it('ModerationProfile is the input (two fields optional); ResolvedProfile is the output (both required)', () => {
    const resolved: ResolvedProfile = defineProfile(legacy);
    const durations: number[] = resolved.durations;
    const custom: boolean = resolved.customDuration;
    // A resolved profile is accepted wherever a profile is.
    const back: ModerationProfile = resolved;
    // @ts-expect-error a 0.1.1 literal is not a resolved profile: the two fields are missing
    const notResolved: ResolvedProfile = legacy;
    expect([durations.length, custom, back.id, notResolved.id]).toEqual([7, true, 'legacy', 'legacy']);
  });

  it('what the kit returns is a ResolvedProfile', async () => {
    const a: ResolvedProfile = resolveProfile('standard');
    const b: ResolvedProfile = applyPolicyLayer(PRESETS.standard, {});
    const c: ResolvedProfile = PRESETS.relaxed;
    const cw = await createChatwarden({ store: new MemoryStore(), secret: 'compat-secret', platform: { identify: (ctx) => ctx as RawWho }, retention: false, logger: { warn: () => undefined } });
    const d: ResolvedProfile = cw.profile;
    const state: PolicyState = cw.policy.get();
    const e: ResolvedProfile = state.effective;
    const f: ResolvedProfile = state.base;
    const g: number[] = cw.profile.durations;
    expect([a, b, c, d, e, f].every((p) => Array.isArray(p.durations))).toBe(true);
    expect(g.length).toBe(7);
  });

  it('ProfileInput is a deprecated alias of ModerationProfile', () => {
    const input: ProfileInput = legacy;
    const same: ModerationProfile = input;
    expect(same.id).toBe('legacy');
  });
});
