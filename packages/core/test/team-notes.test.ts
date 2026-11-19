import { describe, expect, it } from 'vitest';
import { checkTeamNoteRules, resolveTeamNotes, TEAM_NOTE_MAX, TEAM_NOTES_MAX } from '../src/teamNotes.js';
import type { TeamNote } from '../src/teamNotes.js';
import { defineProfile, PRESETS, ProfileError, resolveProfile, validateProfile } from '../src/profile.js';
import type { ModerationProfile } from '../src/profile.js';
import { moderatorGuide, policyJson } from '../src/documents.js';
import { defineRules, starterRules } from '../src/rules.js';

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}

const bad = (input: unknown): ProfileError => failure(() => resolveTeamNotes(input as TeamNote[]));

describe('resolveTeamNotes', () => {
  it('undefined and [] are []', () => {
    expect(resolveTeamNotes(undefined)).toEqual([]);
    expect(resolveTeamNotes([])).toEqual([]);
  });

  it('the caps are 30 notes of 500 characters', () => {
    expect(TEAM_NOTES_MAX).toBe(30);
    expect(TEAM_NOTE_MAX).toBe(500);
  });

  it('trims and strips control, bidi and zero-width characters', () => {
    const [n] = resolveTeamNotes([{ text: '  weigh distinct tables\u202e over raw counts\u200b  ' }]);
    expect(n).toEqual({ text: 'weigh distinct tables over raw counts' });
    expect(resolveTeamNotes([{ text: 'a\u0007b' }])[0]?.text).toBe('ab');
  });

  it('a newline becomes one space', () => {
    expect(resolveTeamNotes([{ text: 'first line\nsecond line' }])[0]?.text).toBe('first line second line');
    expect(resolveTeamNotes([{ text: 'first line \r\n  second line' }])[0]?.text).toBe('first line second line');
  });

  it('500 characters pass, 501 are refused and never cut', () => {
    expect(resolveTeamNotes([{ text: 'x'.repeat(500) }])[0]?.text).toHaveLength(500);
    const e = bad([{ text: 'x'.repeat(501) }]);
    expect(e.path).toBe('teamNotes[0].text');
    expect(e.reason).toContain('500');
  });

  it('500 astral characters pass (code points), 501 are refused', () => {
    const smile = '\u{1F600}';
    expect(Array.from(resolveTeamNotes([{ text: smile.repeat(500) }])[0]?.text ?? '')).toHaveLength(500);
    expect(bad([{ text: smile.repeat(501) }]).path).toBe('teamNotes[0].text');
  });

  it('invisible-only and whitespace-only text is refused', () => {
    expect(bad([{ text: '\u200b\u202e ' }]).path).toBe('teamNotes[0].text');
    expect(bad([{ text: '   ' }]).path).toBe('teamNotes[0].text');
    expect(bad([{ text: '' }]).path).toBe('teamNotes[0].text');
  });

  it('30 notes pass, 31 are refused at path teamNotes', () => {
    const many = (n: number): TeamNote[] => Array.from({ length: n }, (_, i) => ({ text: `note ${i}` }));
    expect(resolveTeamNotes(many(30))).toHaveLength(30);
    expect(bad(many(31)).path).toBe('teamNotes');
  });

  it('a non-list, a string entry, a non-object, an extra key and a non-string text are refused with their paths', () => {
    expect(bad('a note').path).toBe('teamNotes');
    expect(bad({ text: 'x' }).path).toBe('teamNotes');
    expect(bad(null).path).toBe('teamNotes');
    expect(bad(['a note']).path).toBe('teamNotes[0]');
    expect(bad([3]).path).toBe('teamNotes[0]');
    expect(bad([null]).path).toBe('teamNotes[0]');
    expect(bad([[{ text: 'x' }]]).path).toBe('teamNotes[0]');
    expect(bad([{ text: 'ok' }, { text: 'x', other: 1 }]).path).toBe('teamNotes[1].other');
    expect(bad([{ text: 7 }]).path).toBe('teamNotes[0].text');
    expect(bad([{}]).path).toBe('teamNotes[0].text');
    expect(bad([{ text: null }]).path).toBe('teamNotes[0].text');
  });

  it('a custom path is used', () => {
    expect(failure(() => resolveTeamNotes([{ text: '' }], 'profile.teamNotes')).path).toBe('profile.teamNotes[0].text');
  });

  it('rule: 3 is kept; no rule gives no rule key', () => {
    const [a, b] = resolveTeamNotes([{ text: 'cite', rule: 3 }, { text: 'plain' }]);
    expect(a).toEqual({ text: 'cite', rule: 3 });
    expect(b).toEqual({ text: 'plain' });
    expect(Object.hasOwn(b ?? {}, 'rule')).toBe(false);
    expect(resolveTeamNotes([{ text: 'x', rule: undefined }])[0]).toEqual({ text: 'x' });
    expect(Object.hasOwn(resolveTeamNotes([{ text: 'x', rule: undefined }])[0] ?? {}, 'rule')).toBe(false);
  });

  it('0, -1, 1.5, "3", NaN, Infinity and null are refused at teamNotes[i].rule', () => {
    for (const rule of [0, -1, 1.5, '3', Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(bad([{ text: 'ok' }, { text: 'x', rule }]).path).toBe('teamNotes[1].rule');
    }
    expect(resolveTeamNotes([{ text: 'x', rule: 1 }])[0]?.rule).toBe(1);
  });

  it('returns a fresh array and fresh notes', () => {
    const input: TeamNote[] = [{ text: 'x', rule: 2 }];
    const out = resolveTeamNotes(input);
    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(input[0]);
  });

  it('the message never contains the note text', () => {
    const e = bad([{ text: 'zorbak private words', rule: 0 }]);
    expect(e.path).toBe('teamNotes[0].rule');
    expect(e.message).not.toContain('zorbak');
    expect(e.reason).not.toContain('zorbak');
    const e2 = bad([{ text: 'zorbak private words '.repeat(40) }]);
    expect(e2.message).not.toContain('zorbak');
  });
});

describe('teamNotes on profiles', () => {
  it('every preset resolves teamNotes to [] and the result is frozen', () => {
    for (const name of ['relaxed', 'standard', 'strict'] as const) {
      for (const p of [resolveProfile(name), defineProfile(PRESETS[name])]) {
        expect(p.teamNotes).toEqual([]);
        expect(Object.isFrozen(p.teamNotes)).toBe(true);
      }
    }
  });

  it('resolveProfile(preset, { teamNotes }) replaces the list whole and freezes the notes', () => {
    const first = resolveProfile('standard', { teamNotes: [{ text: 'one' }, { text: 'two', rule: 2 }] });
    expect(first.teamNotes).toEqual([{ text: 'one' }, { text: 'two', rule: 2 }]);
    expect(Object.isFrozen(first.teamNotes[1])).toBe(true);
    const base: ModerationProfile = { ...PRESETS.standard, teamNotes: [{ text: 'a' }, { text: 'b' }] };
    expect(resolveProfile(base, { teamNotes: [{ text: 'c' }] }).teamNotes).toEqual([{ text: 'c' }]);
    expect(resolveProfile(base, {}).teamNotes).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('validateProfile refuses a bad note at profile.teamNotes[0].text', () => {
    const p = { ...PRESETS.standard, teamNotes: [{ text: '' }] };
    expect(failure(() => validateProfile(p)).path).toBe('profile.teamNotes[0].text');
    expect(failure(() => resolveProfile('standard', { teamNotes: [{ text: '\u200b' }] })).path).toBe('profile.teamNotes[0].text');
    expect(failure(() => defineProfile({ ...PRESETS.standard, teamNotes: 'x' as unknown as TeamNote[] })).path).toBe('profile.teamNotes');
  });

  it('a 0.2.1 profile (no teamNotes) resolves, and documents built from it get []', () => {
    const { teamNotes: _gone, ...old } = { ...PRESETS.standard, teamNotes: [] as TeamNote[] };
    void _gone;
    expect(Object.hasOwn(old, 'teamNotes')).toBe(false);
    const resolved = defineProfile(old as ModerationProfile);
    expect(resolved.teamNotes).toEqual([]);
    const rules = defineRules(starterRules('standard'));
    const policy = { profile: old as ModerationProfile, rules };
    expect(policyJson(policy)).toBeDefined();
    expect(moderatorGuide(policy, { format: 'text' })).not.toContain('Team notes');
  });
});

describe('checkTeamNoteRules', () => {
  const exists = (n: number): boolean => n !== 99;

  it('an active rule and a retired rule pass (the check only asks whether the rule exists)', () => {
    expect(() => checkTeamNoteRules([{ text: 'a', rule: 1 }, { text: 'b', rule: 5 }], exists, 'teamNotes')).not.toThrow();
  });

  it('a missing rule fails at <path>[i].rule', () => {
    const e = failure(() => checkTeamNoteRules([{ text: 'a', rule: 1 }, { text: 'zorbak', rule: 99 }], exists, 'layer.teamNotes'));
    expect(e.path).toBe('layer.teamNotes[1].rule');
    expect(e.reason).toBe('must be the number of a Community Rule');
    expect(e.message).not.toContain('zorbak');
  });

  it('a note with no rule is skipped', () => {
    expect(() => checkTeamNoteRules([{ text: 'a' }], () => false, 'teamNotes')).not.toThrow();
    expect(() => checkTeamNoteRules([], () => false, 'teamNotes')).not.toThrow();
  });

  it('works with a real registry: a retired rule is found, a missing one is not', () => {
    const rules = defineRules(starterRules('standard'));
    const ruleExists = (n: number): boolean => rules.get(n) !== undefined;
    expect(() => checkTeamNoteRules([{ text: 'a', rule: 1 }], ruleExists, 'x')).not.toThrow();
    expect(failure(() => checkTeamNoteRules([{ text: 'a', rule: 9999 }], ruleExists, 'x')).path).toBe('x[0].rule');
  });
});
