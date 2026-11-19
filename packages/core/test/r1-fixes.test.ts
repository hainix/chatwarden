import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import { agentBrief, codeOfConduct, moderatorGuide } from '../src/documents.js';
import type { DocumentPolicy } from '../src/documents.js';
import { applyPolicyLayer, defineProfile, PRESETS, ProfileError, validateProfile } from '../src/profile.js';
import type { GuidelineCover, GuidelineTier, ModerationProfile, PolicyLayer } from '../src/profile.js';
import { CREATOR_TEAM_NOTE } from '../src/recommend.js';
import { defineRules, starterRules } from '../src/rules.js';
import type { RawWho } from '../src/types.js';

// Review R1 fixes (chunk 4b): I1 the whole form places all six covers, M1 the creator apply keeps the notes in force, M3 tier text loses invisible characters
// before any document, M4 the doc comment of clean(). (M5 is in store-memory/test/setup-contract-skip.test.ts.)

const BASE = PRESETS.relaxed;
const COVERS: GuidelineCover[] = ['banter', 'rude', 'hostile', 'severe', 'repeated', 'after_warning'];
const tier = (title: string, covers: GuidelineCover[], over: Partial<GuidelineTier> = {}): GuidelineTier => ({
  title,
  description: 'How we read it.',
  examples: ['ez'],
  covers,
  outcome: 'A human decides.',
  ...over,
});

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}
const bad = (layer: unknown): ProfileError => failure(() => applyPolicyLayer(BASE, layer as PolicyLayer));

describe('I1: the whole form places every cover exactly once', () => {
  for (const missing of COVERS) {
    it(`a layer that leaves ${missing} uncovered is refused at layer.guidelines and names it`, () => {
      const e = bad({ guidelines: { tiers: [tier('All', COVERS.filter((c) => c !== missing))] } });
      expect(e.path).toBe('layer.guidelines');
      expect(e.reason).toContain(missing);
    });
  }

  it('the review case: repeated and after_warning left out', () => {
    const e = bad({ guidelines: { tiers: [tier('Four', ['banter', 'rude', 'hostile', 'severe'])] } });
    expect(e.path).toBe('layer.guidelines');
    expect(e.reason).toMatch(/repeated/);
    expect(e.reason).toMatch(/after_warning/);
  });

  it('1 tier of all six, 2 tiers and 6 tiers of one cover are accepted', () => {
    const six = COVERS.map((c) => tier(c, [c]));
    for (const tiers of [[tier('All', COVERS)], [tier('A', COVERS.slice(0, 3)), tier('B', COVERS.slice(3))], six]) {
      expect(applyPolicyLayer(BASE, { guidelines: { tiers } } as PolicyLayer).guidelines).toHaveLength(tiers.length);
    }
  });

  it('no tier, and seven tiers, are refused (1 to 6)', () => {
    expect(bad({ guidelines: { tiers: [] } }).path).toBe('layer.guidelines');
    const seven = [...COVERS.map((c) => tier(c, [c])), tier('Extra', ['rude'])];
    expect(bad({ guidelines: { tiers: seven } }).path).toBe('layer.guidelines[6].covers[0]');
  });

  it('a duplicate cover is still refused at its own path', () => {
    expect(bad({ guidelines: { tiers: [tier('A', COVERS), tier('B', ['rude'])] } }).path).toBe('layer.guidelines[1].covers[0]');
  });

  it('controls: a code profile with four covers still validates (0.2.1 stays additive), and so does a positional layer', () => {
    const old: ModerationProfile = {
      ...PRESETS.standard,
      guidelines: [tier('Light', ['banter', 'rude']), tier('Heavy', ['hostile', 'severe'])] as unknown as ModerationProfile['guidelines'],
    };
    expect(() => validateProfile(old)).not.toThrow();
    expect(() => defineProfile(old)).not.toThrow();
    expect(applyPolicyLayer(BASE, { guidelines: [null, { outcome: 'x' }] } as unknown as PolicyLayer).guidelines[1]?.outcome).toBe('x');
  });
});

const rules = defineRules(starterRules('standard'));
const docsOf = (profile: ModerationProfile): string[] => {
  const policy: DocumentPolicy = { profile, rules };
  return [codeOfConduct(policy, { format: 'text', gameName: 'Test Game' }), moderatorGuide(policy, { format: 'markdown' }), agentBrief(policy)];
};

describe('M3: layer-edited tier text loses bidi, zero-width and control characters before any document', () => {
  const dirty = (s: string): string => `${s.slice(0, 2)}\u202e\u200b\u2066${s.slice(2)}\u0007`;
  const invisible = (doc: string): boolean => ['\u202e', '\u200b', '\u2066', '\u0007'].some((c) => doc.includes(c));
  const profile: ModerationProfile = {
    ...BASE,
    guidelines: [
      tier(dirty('zorbak title'), ['banter', 'rude'], {
        description: dirty('vlemmo description'),
        examples: [dirty('quissel example'), dirty('drakkuun example')],
        outcome: dirty('fenrisk outcome'),
      }),
      tier('Plain', ['hostile', 'severe', 'repeated', 'after_warning']),
    ],
  };

  it('every document shows the words and none of the invisible characters', () => {
    for (const doc of docsOf(profile)) expect(invisible(doc), doc.slice(0, 40)).toBe(false);
    const [conduct] = docsOf(profile);
    expect(conduct).toContain('zorbak title');
    expect(conduct).toContain('quissel example');
  });

  it('the moderator guide and the agent brief show the description and outcome clean too', () => {
    const [, guide, brief] = docsOf(profile);
    expect(guide).toContain('vlemmo description');
    expect(guide).toContain('fenrisk outcome');
    expect(brief).toContain('zorbak title');
  });

  it('a layer saved through applyPolicyLayer reaches the documents clean', () => {
    const resolved = applyPolicyLayer(BASE, { guidelines: { tiers: [tier(dirty('zorbak title'), COVERS)] } } as PolicyLayer);
    for (const doc of docsOf(resolved)) expect(invisible(doc), doc.slice(0, 40)).toBe(false);
    expect(docsOf(resolved)[0]).toContain('zorbak title');
  });

  it('control: plain text is unchanged, and an emoji variation selector survives', () => {
    const [conduct] = docsOf({ ...BASE, guidelines: [tier('Heart \u2764\ufe0f', COVERS)] });
    expect(conduct).toContain('Heart \u2764\ufe0f');
  });
});

describe('M4: clean() has its doc comment back', () => {
  it('the comment sits directly above function clean, and noteSuffix keeps its own', () => {
    const src = readFileSync(new URL('../src/documents.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/\/\*\* A value from outside this file[^\n]*\*\/\nfunction clean\(/);
    expect(src).toMatch(/\/\*\* ` \(CR 3\)`[^\n]*\*\/\nfunction noteSuffix\(/);
  });
});

describe('M1: a creator apply appends to the team notes in force', () => {
  const who = { clientKey: 'k' } as RawWho;
  const make = async (profile: ModerationProfile) =>
    createChatwarden({ store: new MemoryStore(), secret: 's', platform: { identify: () => who }, clock: { now: () => 1_800_000_000_000 }, retention: false, profile });
  const BY = { actor: 'owner_ann', reason: 'setup' };

  it('code-profile notes A and B survive, then the creator note follows', async () => {
    const cw = await make({ ...PRESETS.standard, teamNotes: [{ text: 'note A' }, { text: 'note B', rule: 2 }] });
    expect(cw.policy.applyRecommendation('creator', { version: 0, ...BY })).toMatchObject({ ok: true });
    expect(cw.policy.get().effective.teamNotes).toEqual([{ text: 'note A' }, { text: 'note B', rule: 2 }, { text: CREATOR_TEAM_NOTE }]);
    expect(cw.policy.get().layer.teamNotes).toEqual([{ text: 'note A' }, { text: 'note B', rule: 2 }, { text: CREATOR_TEAM_NOTE }]);
  });

  it('a second apply adds no duplicate, and a code profile that already holds the note gets none added', async () => {
    const cw = await make({ ...PRESETS.standard, teamNotes: [{ text: 'note A' }] });
    cw.policy.applyRecommendation('creator', { version: 0, ...BY });
    cw.policy.applyRecommendation('creator', { version: 1, ...BY });
    expect(cw.policy.get().effective.teamNotes).toEqual([{ text: 'note A' }, { text: CREATOR_TEAM_NOTE }]);
    const held = await make({ ...PRESETS.standard, teamNotes: [{ text: CREATOR_TEAM_NOTE }] });
    held.policy.applyRecommendation('creator', { version: 0, ...BY });
    expect(held.policy.get().effective.teamNotes).toEqual([{ text: CREATOR_TEAM_NOTE }]);
  });

  it("a layer that sets its own notes wins over the code profile (the notes in force are the layer's)", async () => {
    const cw = await make({ ...PRESETS.standard, teamNotes: [{ text: 'code note' }] });
    cw.policy.save({ teamNotes: [{ text: 'layer note' }] }, { version: 0, ...BY });
    cw.policy.applyRecommendation('creator', { version: 1, ...BY });
    expect(cw.policy.get().effective.teamNotes).toEqual([{ text: 'layer note' }, { text: CREATOR_TEAM_NOTE }]);
  });

  it('control: another game leaves the code-profile notes alone', async () => {
    const cw = await make({ ...PRESETS.standard, teamNotes: [{ text: 'note A' }] });
    cw.policy.applyRecommendation('kids', { version: 0, ...BY });
    expect(cw.policy.get().effective.teamNotes).toEqual([{ text: 'note A' }]);
  });
});
