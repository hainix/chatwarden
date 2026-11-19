import { describe, expect, it } from 'vitest';
import { agentBrief, codeOfConduct, moderatorGuide, policyJson } from '../src/documents.js';
import type { DocumentFormat, DocumentPolicy } from '../src/documents.js';
import { defineProfile, PRESETS } from '../src/profile.js';
import type { GuidelineTier, ModerationProfile } from '../src/profile.js';
import { defineRules, starterRules } from '../src/rules.js';
import type { CommunityRule } from '../src/rules.js';
import type { TeamNote } from '../src/teamNotes.js';

const FORMATS: DocumentFormat[] = ['markdown', 'html', 'text'];

function rulesWithRetired(): CommunityRule[] {
  return starterRules('standard').map((r) => (r.number === 5 ? { ...r, retired: true } : r));
}

function policyOf(teamNotes?: TeamNote[], over: Partial<ModerationProfile> = {}): DocumentPolicy {
  const profile: ModerationProfile = { ...PRESETS.standard, ...over, ...(teamNotes === undefined ? {} : { teamNotes }) };
  return { profile, rules: defineRules(rulesWithRetired()) };
}

const custom: GuidelineTier[] = [
  {
    title: 'Light touch',
    description: 'zorbak-private-description we read this one gently.',
    examples: ['ez', 'vlemmo'],
    covers: ['banter', 'rude'],
    outcome: 'quissel-private-outcome a quiet note.',
  },
  {
    title: 'Heavy hand',
    description: 'drakkuun-private-description acted on straight away.',
    examples: ['fenrisk'],
    covers: ['hostile', 'severe', 'repeated', 'after_warning'],
    outcome: 'tarvo-private-outcome a ban.',
  },
];

describe('the moderator guide', () => {
  it('has a Team notes section after the tiers with items, "(CR 3)" and "(CR 3, retired)"', () => {
    const policy = policyOf([{ text: 'weigh distinct tables over raw counts', rule: 3 }, { text: 'the old gambling rule', rule: 5 }, { text: 'no rule here' }]);
    for (const format of FORMATS) {
      const g = moderatorGuide(policy, { format });
      expect(g, format).toContain('Team notes');
      expect(g, format).toContain('Working notes for the moderation team. Players never see them.');
      expect(g, format).toContain('weigh distinct tables over raw counts (CR 3)');
      expect(g, format).toContain('the old gambling rule (CR 5, retired)');
      expect(g, format).toContain('no rule here');
      expect(g, format).not.toContain('no rule here (CR');
      const lastTier = g.indexOf('Severe');
      expect(g.indexOf('Team notes'), format).toBeGreaterThan(lastTier);
      expect(g.indexOf('Team notes'), format).toBeLessThan(g.indexOf('First offense'));
    }
  });

  it('a note citing a rule the registry lacks still lists with its number', () => {
    expect(moderatorGuide(policyOf([{ text: 'orphan', rule: 99 }]), { format: 'text' })).toContain('orphan (CR 99)');
  });

  it('is absent with no notes', () => {
    for (const format of FORMATS) expect(moderatorGuide(policyOf([]), { format })).not.toContain('Team notes');
  });

  it("the whole guide for a preset with no notes equals today's output (no field, and an empty list, give the same text)", () => {
    for (const format of FORMATS) {
      const a = moderatorGuide(policyOf(undefined), { format });
      const b = moderatorGuide(policyOf([]), { format });
      const noKey = { ...policyOf().profile } as Partial<ModerationProfile>;
      delete noKey.teamNotes;
      const c = moderatorGuide({ profile: noKey as ModerationProfile, rules: policyOf().rules }, { format });
      expect(b).toBe(a);
      expect(c).toBe(a);
    }
  });

  it('html escapes <b>x</b> in a note; text format is plain', () => {
    const policy = policyOf([{ text: 'use <b>x</b> carefully' }]);
    const html = moderatorGuide(policy, { format: 'html' });
    expect(html).toContain('use &lt;b&gt;x&lt;/b&gt; carefully');
    expect(html).not.toContain('<b>x</b>');
    const text = moderatorGuide(policy, { format: 'text' });
    expect(text).toContain('use <b>x</b> carefully');
    expect(text).not.toContain('&lt;');
  });

  it('a note with a newline is one item', () => {
    const g = moderatorGuide(policyOf([{ text: 'first part\nsecond part' }]), { format: 'text' });
    expect(g).toContain('first part second part');
  });

  it('a custom whole-form tier shows in the guide and the brief', () => {
    const policy = policyOf(undefined, { guidelines: custom });
    const g = moderatorGuide(policy, { format: 'text' });
    expect(g).toContain('Light touch');
    expect(g).toContain('Heavy hand');
    expect(g).toContain('quissel-private-outcome');
    expect(agentBrief(policy)).toContain('- Light touch (covers: banter, rude): ');
    expect(agentBrief(policy)).toContain('Heavy hand');
  });
});

describe('the agent brief', () => {
  it('lists "Team notes:" lines, one line per note, after the Guidelines lines', () => {
    const brief = agentBrief(policyOf([{ text: 'weigh distinct tables', rule: 3 }, { text: 'two\nlines', rule: 5 }, { text: 'plain' }]));
    expect(brief).toContain('\nTeam notes:\n- weigh distinct tables (CR 3)\n- two lines (CR 5, retired)\n- plain\n');
    expect(brief.indexOf('Team notes:')).toBeGreaterThan(brief.indexOf('Guidelines:'));
    expect(brief.indexOf('Team notes:')).toBeLessThan(brief.indexOf('Profanity:'));
  });

  it('is absent when none, and the brief is the same with no field and with an empty list', () => {
    expect(agentBrief(policyOf([]))).not.toContain('Team notes');
    expect(agentBrief(policyOf(undefined))).toBe(agentBrief(policyOf([])));
  });
});

describe('the player code of conduct', () => {
  const doc = (policy: DocumentPolicy, format: DocumentFormat): string => codeOfConduct(policy, { format, gameName: 'Test Game' });

  it('is byte-identical with and without notes in markdown, html and text', () => {
    const notes: TeamNote[] = [{ text: 'a secret staff note about zorbak', rule: 3 }, { text: 'another' }];
    for (const format of FORMATS) {
      expect(doc(policyOf(notes), format), format).toBe(doc(policyOf([]), format));
      expect(doc(policyOf(notes), format), format).not.toContain('zorbak');
    }
  });

  it("none of a custom tier's description or outcome appears in it; its title and examples do (control)", () => {
    for (const format of FORMATS) {
      const d = doc(policyOf(undefined, { guidelines: custom }), format);
      expect(d, format).toContain('Light touch');
      expect(d, format).toContain('Heavy hand');
      expect(d, format).toContain('vlemmo');
      expect(d, format).toContain('fenrisk');
      for (const hidden of ['zorbak-private-description', 'quissel-private-outcome', 'drakkuun-private-description', 'tarvo-private-outcome']) expect(d, `${format} ${hidden}`).not.toContain(hidden);
    }
  });
});

describe('policyJson', () => {
  it('has no teamNotes key and defineProfile(policyJson().profile) is valid', () => {
    const json = policyJson(policyOf([{ text: 'staff only zorbak', rule: 3 }]));
    expect(Object.hasOwn(json.profile, 'teamNotes')).toBe(false);
    expect(JSON.stringify(json)).not.toContain('zorbak');
    const back = defineProfile(json.profile as ModerationProfile);
    expect(back.teamNotes).toEqual([]);
  });

  it('a profile with no notes also has no key, and the document is the same shape as before', () => {
    expect(Object.hasOwn(policyJson(policyOf()).profile, 'teamNotes')).toBe(false);
    expect(Object.keys(policyJson(policyOf())).sort()).toEqual(['profile', 'rules', 'version']);
  });
});
