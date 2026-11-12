import { describe, expect, it } from 'vitest';
import { MAX_SANCTION_DURATION_MS } from '../src/sanctions.js';
import {
  defineProfile,
  MAX_DURATION_MS,
  MAX_WINDOW_DAYS,
  PRESETS,
  ProfileError,
  resolveProfile,
  validateProfile,
  type ModerationProfile,
  type ProfileOverrides,
} from '../src/profile.js';
import { HISTORY_LOOKBACK_MS, LADDER_TABLE } from '../src/ladder.js';
import { defaultReporting } from '../src/reporting.js';
import { CONDUCT_LEVELS } from '../src/types.js';
import type { ConductLevel } from '../src/types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A deep, mutable copy for building bad profiles. */
function copy(p: ModerationProfile): Record<string, unknown> {
  return JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
}

/** Run `fn`, expect a ProfileError, return it. */
function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    expect(e).toBeInstanceOf(Error);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}

/** Apply `mutate` to a mutable copy of the relaxed preset, validate it, return the error. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

function invalid(mutate: (p: Loose) => void): ProfileError {
  const p = copy(PRESETS.relaxed);
  mutate(p);
  return failure(() => defineProfile(p as unknown as ModerationProfile));
}

describe('the presets equal the standards doc tables, cell by cell', () => {
  it('summaries are verbatim', () => {
    expect(PRESETS.relaxed.summary).toBe('Trash talk is part of the game. Harassment, threats and hate are not.');
    expect(PRESETS.standard.summary).toBe("Keep it friendly. Personal insults, harassment and hate aren't allowed.");
    expect(PRESETS.strict.summary).toBe('Be kind. No swearing, insults or bullying.');
  });

  it('ids and names', () => {
    expect(PRESETS.relaxed.id).toBe('relaxed');
    expect(PRESETS.standard.id).toBe('standard');
    expect(PRESETS.strict.id).toBe('strict');
    for (const p of Object.values(PRESETS)) expect(p.name.length).toBeGreaterThan(0);
  });

  it('first offense: relaxed', () => {
    expect(PRESETS.relaxed.firstOffense).toEqual({
      banter: 'none',
      rude: 'note',
      hostile: 'warning',
      severe: { kind: 'chat', durationMs: 7 * DAY },
    });
  });

  it('first offense: standard', () => {
    expect(PRESETS.standard.firstOffense).toEqual({
      banter: 'none',
      rude: 'warning',
      hostile: { kind: 'chat', durationMs: DAY },
      severe: { kind: 'chat', durationMs: 7 * DAY },
    });
  });

  it('first offense: strict (rude is a 1 hour chat restriction, severe a 7 day ban)', () => {
    expect(PRESETS.strict.firstOffense).toEqual({
      banter: 'none',
      rude: { kind: 'chat', durationMs: HOUR },
      hostile: { kind: 'chat', durationMs: DAY },
      severe: { kind: 'ban', durationMs: 7 * DAY },
    });
  });

  it('repeat rules', () => {
    expect(PRESETS.relaxed.repeat).toEqual({ windowDays: 30, notes: 2, distinctGames: true, outcome: 'warning' });
    expect(PRESETS.standard.repeat).toEqual({
      windowDays: 30,
      notes: 2,
      distinctGames: false,
      outcome: { kind: 'chat', durationMs: DAY },
    });
    expect(PRESETS.strict.repeat).toEqual({
      windowDays: 30,
      notes: 1,
      distinctGames: false,
      outcome: { kind: 'chat', durationMs: DAY },
    });
  });

  it('profanity modes and defaults', () => {
    expect(PRESETS.relaxed.profanity.mode).toBe('star');
    expect(PRESETS.standard.profanity.mode).toBe('star');
    expect(PRESETS.strict.profanity.mode).toBe('refuse');
    for (const p of Object.values(PRESETS)) {
      expect(p.profanity.style).toBe('full');
      expect(p.profanity.add).toEqual([]);
      expect(p.profanity.remove).toEqual([]);
      expect(p.profanity.only).toBeNull();
      expect(p.profanity.languages).toEqual(['en']);
    }
  });

  it('AI auto-act levels', () => {
    expect(PRESETS.relaxed.aiAutoAct).toEqual(['severe']);
    expect(PRESETS.standard.aiAutoAct).toEqual(['severe']);
    expect(PRESETS.strict.aiAutoAct).toEqual(['hostile', 'severe']);
  });

  it('every preset ships the K2 ladder table', () => {
    for (const p of Object.values(PRESETS)) expect(p.ladder).toEqual(LADDER_TABLE);
  });

  it('the starter-rules flavour matches the preset', () => {
    expect(PRESETS.relaxed.rules).toBe('relaxed');
    expect(PRESETS.standard.rules).toBe('standard');
    expect(PRESETS.strict.rules).toBe('strict');
  });

  it('the conduct table: meanings and corrected examples (relaxed and standard)', () => {
    for (const p of [PRESETS.relaxed, PRESETS.standard]) {
      expect(Object.keys(p.levels).sort()).toEqual([...CONDUCT_LEVELS].sort());
      expect(p.levels.banter.meaning).toBe(
        'Trash talk, salt, jokes about play, profanity not aimed at a person, a single mild insult',
      );
      expect(p.levels.banter.examples).toEqual(['ez', 'loser', "you're an idiot", "lol you're trash at this", 'damn it']);
      expect(p.levels.rude.meaning).toBe('Aggressive, profane abuse aimed at a player, isolated');
      expect(p.levels.rude.examples).toEqual(['go f— yourself']);
      expect(p.levels.hostile.meaning).toBe(
        'Sustained or repeated aggression: several insults, picking a fight, following someone across games',
      );
      expect(p.levels.hostile.examples).toEqual([
        'three insults in one game',
        'insulting the same player again next game',
      ]);
      expect(p.levels.severe.meaning).toBe(
        'Threats, hate or slurs, attacks on who someone is, sexual harassment, doxxing, serious harassment',
      );
      expect(p.levels.severe.examples).toEqual([
        'any slur',
        "I'll find you",
        'anything about race or religion as an attack',
      ]);
    }
  });

  it("relaxed and standard: 'loser' and \"you're an idiot\" are banter; rude is the doc's own wording", () => {
    for (const p of [PRESETS.relaxed, PRESETS.standard]) {
      expect(p.levels.banter.examples).toContain('loser');
      expect(p.levels.banter.examples).toContain("you're an idiot");
      expect(p.levels.rude.examples).toEqual(['go f\u2014 yourself']);
    }
  });

  it('strict reads mild insults as rude: its own banter and rude levels (R10)', () => {
    const l = PRESETS.strict.levels;
    expect(l.banter.examples).toEqual(['ez', 'gg', 'bad play', 'lol']);
    expect(l.banter.meaning).toBe('Friendly salt and jokes about play, with no insults and no swearing');
    expect(l.rude.meaning).toBe('Any insult or swearing aimed at a player, even once');
    expect(l.rude.examples).toEqual(['loser', "you're an idiot", 'go f\u2014 yourself']);
    for (const insult of l.rude.examples) expect(l.banter.examples).not.toContain(insult);
    expect(l.hostile).toEqual(PRESETS.relaxed.levels.hostile);
    expect(l.severe).toEqual(PRESETS.relaxed.levels.severe);
    // The strict guidelines and AI context agree with that reading.
    expect(PRESETS.strict.guidelines[0]!.examples).toEqual(['ez', 'gg', 'bad play', 'lol']);
    const rude = PRESETS.strict.guidelines[1]!;
    expect(rude.examples).toEqual(['loser', "you're an idiot", 'go f\u2014 yourself']);
    expect(rude.outcome).toBe(
      'First time: chat restricted for 1 hour. Repeated (any earlier note on the record): chat restricted for 24 hours.',
    );
    expect(PRESETS.strict.aiContext).toContain('"loser"');
    expect(PRESETS.strict.aiContext).toContain('as rude');
    expect(PRESETS.strict.aiContext).not.toContain('single mild insult as banter');
    // Swearing is only "not a violation" when it is not aimed at anyone.
    expect(PRESETS.strict.aiContext).toContain('swearing that is not aimed at anyone is stopped before it is sent and is not a violation');
    expect(PRESETS.strict.aiContext).not.toContain('is never a violation');
    const banter = PRESETS.strict.guidelines.find((g) => g.title === 'Banter');
    expect(banter?.description).toContain('Swearing that is not aimed at anyone is stopped before it is sent, and that is not a violation.');
  });

  it('every preset keeps the doc wording for hostile and severe', () => {
    for (const p of Object.values(PRESETS)) {
      expect(p.levels.hostile.examples).toEqual([
        'three insults in one game',
        'insulting the same player again next game',
      ]);
      expect(p.levels.severe.examples).toEqual([
        'any slur',
        "I'll find you",
        'anything about race or religion as an attack',
      ]);
    }
  });

  it('aiContext is a non-empty plain-language standard', () => {
    for (const p of Object.values(PRESETS)) expect(p.aiContext.length).toBeGreaterThan(40);
  });

  it('banter never punishes and AI never auto-acts on banter or rude, in every preset', () => {
    for (const p of Object.values(PRESETS)) {
      expect(p.firstOffense.banter).toBe('none');
      expect(p.aiAutoAct).not.toContain('banter');
      expect(p.aiAutoAct).not.toContain('rude');
    }
  });
});

describe('preset guidelines tiers', () => {
  it('relaxed has the five tiers in order', () => {
    const t = PRESETS.relaxed.guidelines;
    expect(t.map((x) => x.title)).toEqual([
      'Minor, isolated',
      'Aggressive but isolated',
      'Repeated hostility',
      'After a warning',
      'Severe',
    ]);
    expect(t.map((x) => x.covers)).toEqual([
      ['banter'],
      ['rude'],
      ['hostile', 'repeated'],
      ['after_warning'],
      ['severe'],
    ]);
  });

  it('standard and strict have four or five tiers', () => {
    expect(PRESETS.standard.guidelines.length).toBeGreaterThanOrEqual(4);
    expect(PRESETS.standard.guidelines.length).toBeLessThanOrEqual(5);
    expect(PRESETS.strict.guidelines.length).toBeGreaterThanOrEqual(4);
    expect(PRESETS.strict.guidelines.length).toBeLessThanOrEqual(5);
  });

  it('every level is covered exactly once, repeated and after_warning at most once, in every preset', () => {
    for (const p of Object.values(PRESETS)) {
      const covers = p.guidelines.flatMap((g) => g.covers);
      for (const level of CONDUCT_LEVELS) expect(covers.filter((c) => c === level)).toHaveLength(1);
      expect(covers.filter((c) => c === 'repeated').length).toBeLessThanOrEqual(1);
      expect(covers.filter((c) => c === 'after_warning').length).toBeLessThanOrEqual(1);
    }
  });

  it('the banter tier states no action; every tier has words', () => {
    for (const p of Object.values(PRESETS)) {
      for (const g of p.guidelines) {
        expect(g.title.length).toBeGreaterThan(0);
        expect(g.description.length).toBeGreaterThan(0);
        expect(g.outcome.length).toBeGreaterThan(0);
      }
    }
  });

  it('guideline examples are drawn from the doc wording only', () => {
    const allowed = new Set<string>([
      'ez',
      'loser',
      "you're an idiot",
      "lol you're trash at this",
      'damn it',
      'gg',
      'bad play',
      'lol',
      'go f\u2014 yourself',
      'three insults in one game',
      'insulting the same player again next game',
      'any slur',
      "I'll find you",
      'anything about race or religion as an attack',
    ]);
    for (const p of Object.values(PRESETS)) {
      for (const g of p.guidelines) for (const ex of g.examples) expect(allowed.has(ex)).toBe(true);
    }
  });
});

describe('presets validate', () => {
  it.each(['relaxed', 'standard', 'strict'] as const)('%s', (name) => {
    expect(() => validateProfile(PRESETS[name])).not.toThrow();
    expect(() => defineProfile(PRESETS[name])).not.toThrow();
    expect(() => resolveProfile(name)).not.toThrow();
  });

  it('PRESETS is deep frozen', () => {
    for (const p of Object.values(PRESETS)) {
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.firstOffense)).toBe(true);
      expect(Object.isFrozen(p.levels.banter.examples)).toBe(true);
      expect(Object.isFrozen(p.guidelines[0])).toBe(true);
      expect(Object.isFrozen(p.guidelines[0]!.covers)).toBe(true);
      expect(Object.isFrozen(p.ladder)).toBe(true);
      expect(Object.isFrozen(p.ladder[0]!.lowMedium)).toBe(true);
    }
  });
});

describe('resolveProfile: overrides', () => {
  it('no overrides returns an equal profile, by name or by object', () => {
    expect(resolveProfile('relaxed')).toEqual(PRESETS.relaxed);
    expect(resolveProfile(PRESETS.strict)).toEqual(PRESETS.strict);
    expect(resolveProfile('standard', {})).toEqual(PRESETS.standard);
  });

  it('a nested override keeps its siblings (Review Focus 1)', () => {
    const r = resolveProfile('relaxed', { firstOffense: { rude: 'warning' } });
    expect(r.firstOffense).toEqual({ ...PRESETS.relaxed.firstOffense, rude: 'warning' });
    expect(r.firstOffense.hostile).toBe('warning');
    expect(r.firstOffense.severe).toEqual({ kind: 'chat', durationMs: 7 * DAY });
    expect(r.repeat).toEqual(PRESETS.relaxed.repeat);
  });

  it('a deep override keeps siblings at every depth', () => {
    const r = resolveProfile('relaxed', { profanity: { mode: 'allow' }, repeat: { notes: 3 } });
    expect(r.profanity).toEqual({ ...PRESETS.relaxed.profanity, mode: 'allow' });
    expect(r.repeat).toEqual({ windowDays: 30, notes: 3, distinctGames: true, outcome: 'warning' });
    const lv = resolveProfile('relaxed', { levels: { rude: { examples: ['one'] } } });
    expect(lv.levels.rude.meaning).toBe(PRESETS.relaxed.levels.rude.meaning);
    expect(lv.levels.rude.examples).toEqual(['one']);
    expect(lv.levels.banter).toEqual(PRESETS.relaxed.levels.banter);
  });

  it('overriding an outcome object merges its fields; replacing it by a string replaces it', () => {
    const a = resolveProfile('relaxed', { firstOffense: { severe: { durationMs: DAY } } });
    expect(a.firstOffense.severe).toEqual({ kind: 'chat', durationMs: DAY });
    const b = resolveProfile('relaxed', { firstOffense: { severe: 'warning' } });
    expect(b.firstOffense.severe).toBe('warning');
    const c = resolveProfile('relaxed', { firstOffense: { hostile: { kind: 'ban', durationMs: 7 * DAY } } });
    expect(c.firstOffense.hostile).toEqual({ kind: 'ban', durationMs: 7 * DAY });
  });

  it('an array override replaces; it never concatenates', () => {
    const r = resolveProfile('strict', { aiAutoAct: ['severe'] });
    expect(r.aiAutoAct).toEqual(['severe']);
    const p = resolveProfile('relaxed', { profanity: { add: ['zorbak'] } });
    expect(p.profanity.add).toEqual(['zorbak']);
    const p2 = resolveProfile(resolveProfile('relaxed', { profanity: { add: ['zorbak'] } }), {
      profanity: { add: ['vlemmo'] },
    });
    expect(p2.profanity.add).toEqual(['vlemmo']);
    const empty = resolveProfile('strict', { aiAutoAct: [] });
    expect(empty.aiAutoAct).toEqual([]);
  });

  it('null is a value: profanity.only can be set to a list and back to null', () => {
    const withOnly = resolveProfile('relaxed', { profanity: { only: ['glarn'] } });
    expect(withOnly.profanity.only).toEqual(['glarn']);
    const back = resolveProfile(withOnly, { profanity: { only: null } });
    expect(back.profanity.only).toBeNull();
  });

  it('an undefined override is ignored, not a delete', () => {
    const r = resolveProfile('relaxed', { summary: undefined, repeat: { notes: undefined } });
    expect(r.summary).toBe(PRESETS.relaxed.summary);
    expect(r.repeat.notes).toBe(2);
  });

  it('a ladder override replaces the whole ladder', () => {
    const ladder = LADDER_TABLE.map((row) => ({ ...row }));
    ladder[0] = { step: 0, lowMedium: { kind: 'chat', durationMs: HOUR, label: 'Restrict chat 1 hour' }, high: row0High() };
    const r = resolveProfile('relaxed', { ladder });
    expect(r.ladder[0]!.lowMedium.durationMs).toBe(HOUR);
    expect(r.ladder[1]).toEqual(LADDER_TABLE[1]);
  });

  it('guidelines override replaces the tiers and is validated', () => {
    const tiers = [
      { title: 'Chill', description: 'd', examples: [], covers: ['banter', 'rude'] as ConductLevel[], outcome: 'None' },
      { title: 'Bad', description: 'd', examples: [], covers: ['hostile', 'severe'] as ConductLevel[], outcome: 'Act' },
    ];
    const r = resolveProfile('relaxed', { guidelines: tiers });
    expect(r.guidelines.map((g) => g.title)).toEqual(['Chill', 'Bad']);
  });

  it('does not mutate the preset or the overrides', () => {
    const overrides: ProfileOverrides = { profanity: { add: ['zorbak'] }, firstOffense: { rude: 'warning' } };
    const before = JSON.stringify(overrides);
    resolveProfile('relaxed', overrides);
    expect(JSON.stringify(overrides)).toBe(before);
    expect(PRESETS.relaxed.firstOffense.rude).toBe('note');
    expect(PRESETS.relaxed.profanity.add).toEqual([]);
  });

  it('the result does not share structure with the overrides', () => {
    const add = ['zorbak'];
    const r = resolveProfile('relaxed', { profanity: { add } });
    add.push('vlemmo');
    expect(r.profanity.add).toEqual(['zorbak']);
  });

  it('the result does not share structure with a profile passed as the base', () => {
    const base = defineProfile(copy(PRESETS.relaxed) as unknown as ModerationProfile);
    const r = resolveProfile(base);
    expect(r).not.toBe(base);
    expect(r.firstOffense).not.toBe(base.firstOffense);
  });

  it('an unknown preset name is a ProfileError', () => {
    const e = failure(() => resolveProfile('loose' as 'relaxed'));
    expect(e.path).toBe('preset');
    expect(e.message).not.toContain('loose');
  });

  it('validates the MERGED result', () => {
    const e = failure(() => resolveProfile('relaxed', { repeat: { windowDays: 0 } }));
    expect(e.path).toBe('profile.repeat.windowDays');
    expect(e.message).toBe(
      'profile.repeat.windowDays must be a whole number of days from 1 to 90: the record only reaches back 90 days',
    );
  });

  it('a prototype-pollution key is carried as an unknown key and rejected', () => {
    const overrides = JSON.parse('{"__proto__": {"polluted": true}}') as ProfileOverrides;
    const e = failure(() => resolveProfile('relaxed', overrides));
    expect(e.path).toBe('profile.__proto__');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

function row0High() {
  return LADDER_TABLE[0]!.high;
}

describe('the resolved profile is deep frozen', () => {
  it('cannot be mutated at any depth', () => {
    const r = resolveProfile('relaxed', { profanity: { add: ['zorbak'] } });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.firstOffense)).toBe(true);
    expect(Object.isFrozen(r.firstOffense.severe)).toBe(true);
    expect(Object.isFrozen(r.profanity.add)).toBe(true);
    expect(Object.isFrozen(r.ladder[0]!.high)).toBe(true);
    expect(Object.isFrozen(r.guidelines[0]!.examples)).toBe(true);
    expect(() => {
      (r as { summary: string }).summary = 'x';
    }).toThrow(TypeError);
    expect(() => {
      (r.firstOffense as Record<string, unknown>)['rude'] = 'ban';
    }).toThrow(TypeError);
    expect(() => {
      (r.profanity.add as string[]).push('x');
    }).toThrow(TypeError);
    expect(() => {
      (r.aiAutoAct as ConductLevel[]).push('banter');
    }).toThrow(TypeError);
    expect(() => {
      (r.levels.rude as { meaning: string }).meaning = 'x';
    }).toThrow(TypeError);
    expect(r.summary).toBe(PRESETS.relaxed.summary);
  });
});

describe('defineProfile', () => {
  const custom: ModerationProfile = {
    id: 'mygame',
    name: 'My Game',
    summary: 'Be good.',
    firstOffense: { banter: 'none', rude: 'warning', hostile: { kind: 'chat', durationMs: HOUR }, severe: 'warning' },
    repeat: { windowDays: 14, notes: 3, distinctGames: false, outcome: 'warning' },
    ladder: LADDER_TABLE,
    profanity: { mode: 'allow', style: 'grawlix', add: ['glarn'], remove: [], only: null, languages: ['en'] },
    aiContext: 'Be gentle with banter. Act only on clear threats.',
    aiAutoAct: [],
    rules: 'standard',
    durations: [HOUR, DAY],
    customDuration: false,
    levels: PRESETS.standard.levels,
    guidelines: [
      { title: 'All good', description: 'd', examples: ['ez'], covers: ['banter'], outcome: 'No action.' },
      { title: 'Not good', description: 'd', examples: [], covers: ['rude', 'hostile', 'severe'], outcome: 'Warning.' },
    ],
  };

  it('round-trips a custom profile', () => {
    const d = defineProfile(custom);
    // A profile with no reporting section gets the default reporting settings.
    expect(d).toEqual({ ...custom, reporting: defaultReporting(), ai: { level: 0, learn: true, dailyCalls: 5000 } });
    expect(d.id).toBe('mygame');
    expect(resolveProfile(d, { name: 'Renamed' }).name).toBe('Renamed');
    expect(resolveProfile(d)).toEqual(d);
  });

  it('returns a frozen copy, so a later edit of the input cannot change a validated profile', () => {
    const input = copy(custom) as unknown as ModerationProfile;
    const d = defineProfile(input);
    (input as { summary: string }).summary = 'changed';
    expect(d.summary).toBe('Be good.');
    expect(Object.isFrozen(d)).toBe(true);
  });

  it('a custom profile is validated just like a preset', () => {
    const bad = { ...custom, firstOffense: { ...custom.firstOffense, banter: 'warning' } } as unknown as ModerationProfile;
    expect(failure(() => defineProfile(bad)).path).toBe('profile.firstOffense.banter');
  });

  it('rejects non-objects', () => {
    expect(failure(() => defineProfile(null as unknown as ModerationProfile)).path).toBe('profile');
    expect(failure(() => defineProfile([] as unknown as ModerationProfile)).path).toBe('profile');
    expect(failure(() => defineProfile('relaxed' as unknown as ModerationProfile)).path).toBe('profile');
  });
});

describe('validation: unknown keys at any depth', () => {
  it('top level', () => {
    const e = invalid((p) => {
      p.colour = 'blue';
    });
    expect(e.path).toBe('profile.colour');
    expect(e.message).not.toContain('blue');
  });

  it('via resolveProfile overrides, with the nested path', () => {
    expect(failure(() => resolveProfile('relaxed', { firstOffense: { rudee: 'note' } } as never)).path).toBe(
      'profile.firstOffense.rudee',
    );
    expect(failure(() => resolveProfile('relaxed', { profanity: { modee: 'allow' } } as never)).path).toBe(
      'profile.profanity.modee',
    );
    expect(failure(() => resolveProfile('relaxed', { repeat: { days: 3 } } as never)).path).toBe(
      'profile.repeat.days',
    );
  });

  it('inside an outcome, a level, a ladder cell, a ladder row, a tier', () => {
    expect(invalid((p) => (p.firstOffense.severe = { kind: 'ban', durationMs: DAY, extra: 1 })).path).toBe(
      'profile.firstOffense.severe.extra',
    );
    expect(invalid((p) => (p.levels.rude.extra = 1)).path).toBe('profile.levels.rude.extra');
    expect(invalid((p) => (p.ladder[2].high.extra = 1)).path).toBe('profile.ladder[2].high.extra');
    expect(invalid((p) => (p.ladder[2].extra = 1)).path).toBe('profile.ladder[2].extra');
    expect(invalid((p) => (p.guidelines[1].extra = 1)).path).toBe('profile.guidelines[1].extra');
  });

  it("firstOffense.severe must act: 'none' and 'note' are refused", () => {
    for (const value of ['none', 'note']) {
      expect(invalid((p) => (p.firstOffense.severe = value)).path, value).toBe('profile.firstOffense.severe');
      expect(failure(() => resolveProfile('relaxed', { firstOffense: { severe: value as never } })).path, value).toBe(
        'profile.firstOffense.severe',
      );
    }
    for (const ok of ['warning', { kind: 'chat', durationMs: DAY }, { kind: 'area', durationMs: null }, { kind: 'ban', durationMs: DAY }] as const) {
      expect(resolveProfile('relaxed', { firstOffense: { severe: ok } }).firstOffense.severe).toEqual(ok);
    }
  });

  it('firstOffense.severe: the other levels may still be none or note', () => {
    const r = resolveProfile('relaxed', { firstOffense: { rude: 'none', hostile: 'note' } });
    expect(r.firstOffense.rude).toBe('none');
    expect(r.firstOffense.hostile).toBe('note');
  });

  it('unknown conduct level in firstOffense or levels', () => {
    expect(invalid((p) => (p.firstOffense.medium = 'note')).path).toBe('profile.firstOffense.medium');
    expect(invalid((p) => (p.levels.medium = { meaning: 'x', examples: [] })).path).toBe('profile.levels.medium');
  });
});

describe('validation: required fields', () => {
  it('a missing firstOffense level', () => {
    for (const level of CONDUCT_LEVELS) {
      const e = invalid((p) => delete p.firstOffense[level]);
      expect(e.path).toBe(`profile.firstOffense.${level}`);
    }
  });

  it('a missing conduct level in levels', () => {
    for (const level of CONDUCT_LEVELS) {
      const e = invalid((p) => delete p.levels[level]);
      expect(e.path).toBe(`profile.levels.${level}`);
    }
  });

  it('missing top-level fields', () => {
    for (const key of [
      'id',
      'name',
      'summary',
      'firstOffense',
      'repeat',
      'ladder',
      'profanity',
      'aiContext',
      'aiAutoAct',
      'rules',
      'levels',
      'guidelines',
    ]) {
      const e = invalid((p) => delete p[key]);
      expect(e.path).toBe(`profile.${key}`);
    }
  });

  it('empty or non-string id, name, summary, aiContext', () => {
    for (const key of ['id', 'name', 'summary', 'aiContext']) {
      expect(invalid((p) => (p[key] = '')).path).toBe(`profile.${key}`);
      expect(invalid((p) => (p[key] = '   ')).path).toBe(`profile.${key}`);
      expect(invalid((p) => (p[key] = 5)).path).toBe(`profile.${key}`);
    }
  });

  it('rules must be relaxed, standard or strict', () => {
    expect(invalid((p) => (p.rules = 'loose')).path).toBe('profile.rules');
    expect(invalid((p) => (p.rules = 3)).path).toBe('profile.rules');
  });

  it('levels: meaning is a string, examples are plain non-empty strings', () => {
    expect(invalid((p) => (p.levels.rude.meaning = '')).path).toBe('profile.levels.rude.meaning');
    expect(invalid((p) => (p.levels.rude.examples = 'x')).path).toBe('profile.levels.rude.examples');
    expect(invalid((p) => (p.levels.rude.examples = [3])).path).toBe('profile.levels.rude.examples[0]');
    expect(invalid((p) => (p.levels.rude.examples = ['ok', ''])).path).toBe('profile.levels.rude.examples[1]');
  });
});

describe('validation: banter never punishes (Review Focus 2)', () => {
  it.each(['note', 'warning'] as const)("firstOffense.banter = '%s' is an error", (v) => {
    const e = failure(() => resolveProfile('relaxed', { firstOffense: { banter: v } } as never));
    expect(e.path).toBe('profile.firstOffense.banter');
    expect(e.message).toContain('banter');
  });

  it('a chat restriction on banter is an error', () => {
    const e = failure(() =>
      resolveProfile('relaxed', { firstOffense: { banter: { kind: 'chat', durationMs: HOUR } } } as never),
    );
    expect(e.path).toBe('profile.firstOffense.banter');
  });

  it("banter 'none' stays valid", () => {
    expect(resolveProfile('relaxed', { firstOffense: { banter: 'none' } }).firstOffense.banter).toBe('none');
  });
});

describe('validation: aiAutoAct', () => {
  it('rude is an error', () => {
    const e = failure(() => resolveProfile('relaxed', { aiAutoAct: ['rude'] }));
    expect(e.path).toBe('profile.aiAutoAct[0]');
  });

  it('banter is an error', () => {
    const e = failure(() => resolveProfile('relaxed', { aiAutoAct: ['severe', 'banter'] }));
    expect(e.path).toBe('profile.aiAutoAct[1]');
  });

  it('unknown values and non-arrays are errors', () => {
    expect(invalid((p) => (p.aiAutoAct = ['high'])).path).toBe('profile.aiAutoAct[0]');
    expect(invalid((p) => (p.aiAutoAct = 'severe')).path).toBe('profile.aiAutoAct');
    expect(invalid((p) => (p.aiAutoAct = null)).path).toBe('profile.aiAutoAct');
  });

  it('hostile and severe, in any combination, are fine', () => {
    for (const set of [[], ['hostile'], ['severe'], ['hostile', 'severe'], ['severe', 'hostile']] as ConductLevel[][]) {
      expect(resolveProfile('relaxed', { aiAutoAct: set }).aiAutoAct).toEqual(set);
    }
  });
});

describe('validation: outcomes and durations', () => {
  it('rejects unknown outcome strings and kinds', () => {
    expect(invalid((p) => (p.firstOffense.rude = 'ban')).path).toBe('profile.firstOffense.rude');
    expect(invalid((p) => (p.firstOffense.rude = 'chat')).path).toBe('profile.firstOffense.rude');
    expect(invalid((p) => (p.firstOffense.rude = 7)).path).toBe('profile.firstOffense.rude');
    expect(invalid((p) => (p.firstOffense.rude = null)).path).toBe('profile.firstOffense.rude');
    expect(invalid((p) => (p.firstOffense.rude = { kind: 'warning', durationMs: null })).path).toBe(
      'profile.firstOffense.rude.kind',
    );
    expect(invalid((p) => (p.firstOffense.rude = { kind: 'mute', durationMs: DAY })).path).toBe(
      'profile.firstOffense.rude.kind',
    );
  });

  it('an object outcome needs a durationMs field', () => {
    expect(invalid((p) => (p.firstOffense.rude = { kind: 'chat' })).path).toBe('profile.firstOffense.rude.durationMs');
  });

  it('durations must be positive whole numbers or null', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', undefined]) {
      const e = invalid((p) => (p.firstOffense.rude = { kind: 'chat', durationMs: bad }));
      expect(e.path).toBe('profile.firstOffense.rude.durationMs');
    }
  });

  it('a permanent ban (null) and each kind are fine', () => {
    for (const kind of ['chat', 'area', 'ban'] as const) {
      const r = resolveProfile('relaxed', { firstOffense: { severe: { kind, durationMs: null } } });
      expect(r.firstOffense.severe).toEqual({ kind, durationMs: null });
    }
  });
});

describe('validation: the repeat rule', () => {
  it('windowDays and notes are whole numbers >= 1', () => {
    for (const bad of [0, -3, 2.5, '30', null, Number.NaN]) {
      expect(invalid((p) => (p.repeat.windowDays = bad)).path).toBe('profile.repeat.windowDays');
      expect(invalid((p) => (p.repeat.notes = bad)).path).toBe('profile.repeat.notes');
    }
  });

  it('boundaries: 1 passes', () => {
    const r = resolveProfile('relaxed', { repeat: { windowDays: 1, notes: 1 } });
    expect(r.repeat).toEqual({ windowDays: 1, notes: 1, distinctGames: true, outcome: 'warning' });
  });

  it('distinctGames must be a boolean', () => {
    expect(invalid((p) => (p.repeat.distinctGames = 'yes')).path).toBe('profile.repeat.distinctGames');
    expect(invalid((p) => (p.repeat.distinctGames = 1)).path).toBe('profile.repeat.distinctGames');
  });

  it("repeat.outcome: 'warning' and restrictions are valid, 'none' and 'note' are not (a repeat must escalate)", () => {
    const good = [
      'warning',
      { kind: 'chat', durationMs: DAY },
      { kind: 'area', durationMs: HOUR },
      { kind: 'ban', durationMs: null },
    ] as const;
    for (const outcome of good) {
      expect(resolveProfile('strict', { repeat: { outcome } }).repeat.outcome).toEqual(outcome);
    }
    for (const bad of ['none', 'note']) {
      const e = invalid((p) => (p.repeat.outcome = bad));
      expect(e.path).toBe('profile.repeat.outcome');
      expect(e.message).toContain('escalate');
    }
  });

  it('repeat.outcome failures land at the right path', () => {
    const at = (v: unknown) => invalid((p) => (p.repeat.outcome = v)).path;
    expect(invalid((p) => delete p.repeat.outcome).path).toBe('profile.repeat.outcome');
    expect(at('ban')).toBe('profile.repeat.outcome');
    expect(at(5)).toBe('profile.repeat.outcome');
    expect(at(null)).toBe('profile.repeat.outcome');
    expect(at({ kind: 'mute', durationMs: DAY })).toBe('profile.repeat.outcome.kind');
    expect(at({ kind: 'warning', durationMs: null })).toBe('profile.repeat.outcome.kind');
    expect(at({ kind: 'chat' })).toBe('profile.repeat.outcome.durationMs');
    expect(at({ kind: 'chat', durationMs: 0 })).toBe('profile.repeat.outcome.durationMs');
    expect(at({ kind: 'chat', durationMs: 1.5 })).toBe('profile.repeat.outcome.durationMs');
    expect(at({ kind: 'chat', durationMs: MAX_DURATION_MS + 1 })).toBe('profile.repeat.outcome.durationMs');
  });

  it('an override of repeat.outcome keeps its siblings', () => {
    const r = resolveProfile('relaxed', { repeat: { outcome: 'warning' } });
    expect(r.repeat).toEqual(PRESETS.relaxed.repeat);
    expect(r.repeat.notes).toBe(2);
    const std = resolveProfile('standard', { repeat: { outcome: { durationMs: HOUR } } });
    expect(std.repeat).toEqual({ ...PRESETS.standard.repeat, outcome: { kind: 'chat', durationMs: HOUR } });
  });

  it('windowDays is capped at the 90 day history lookback; 90 passes, 91 fails', () => {
    expect(MAX_WINDOW_DAYS).toBe(90);
    expect(MAX_WINDOW_DAYS * DAY).toBe(HISTORY_LOOKBACK_MS);
    expect(resolveProfile('relaxed', { repeat: { windowDays: 90 } }).repeat.windowDays).toBe(90);
    const e = invalid((p) => (p.repeat.windowDays = 91));
    expect(e.path).toBe('profile.repeat.windowDays');
    expect(e.message).toContain('90 days');
    expect(invalid((p) => (p.repeat.windowDays = 3650)).path).toBe('profile.repeat.windowDays');
    expect(invalid((p) => (p.repeat.windowDays = Number.MAX_SAFE_INTEGER)).path).toBe('profile.repeat.windowDays');
  });

  it('a window of 91 days is refused through resolveProfile and defineProfile alike', () => {
    expect(failure(() => resolveProfile('strict', { repeat: { windowDays: 91 } })).path).toBe('profile.repeat.windowDays');
    const custom = copy(PRESETS.standard);
    (custom['repeat'] as { windowDays: number }).windowDays = 91;
    expect(failure(() => defineProfile(custom as unknown as ModerationProfile)).path).toBe('profile.repeat.windowDays');
  });

  it('every durationMs is capped at 365 days; the boundary passes (outcomes and ladder cells)', () => {
    expect(MAX_DURATION_MS).toBe(365 * DAY);
    const ok = resolveProfile('relaxed', { firstOffense: { severe: { kind: 'ban', durationMs: MAX_DURATION_MS } } });
    expect(ok.firstOffense.severe).toEqual({ kind: 'ban', durationMs: MAX_DURATION_MS });
    const over = invalid((p) => (p.firstOffense.severe = { kind: 'ban', durationMs: MAX_DURATION_MS + 1 }));
    expect(over.path).toBe('profile.firstOffense.severe.durationMs');
    expect(invalid((p) => (p.ladder[2].high.durationMs = MAX_DURATION_MS + 1)).path).toBe(
      'profile.ladder[2].high.durationMs',
    );
    expect(invalid((p) => (p.ladder[2].high.durationMs = Number.MAX_SAFE_INTEGER)).path).toBe(
      'profile.ladder[2].high.durationMs',
    );
    const atCap = copy(PRESETS.relaxed) as { ladder: Array<{ high: { durationMs: number } }> };
    atCap.ladder[2]!.high.durationMs = MAX_DURATION_MS;
    expect(() => defineProfile(atCap as unknown as ModerationProfile)).not.toThrow();
  });

  it('the message names the unit', () => {
    expect(invalid((p) => (p.repeat.notes = 0)).message).toBe('profile.repeat.notes must be a whole number ≥ 1');
  });
});

describe('validation: the ladder', () => {
  it('must be an array of exactly six rows, steps 0..5 in order', () => {
    expect(invalid((p) => (p.ladder = 'x')).path).toBe('profile.ladder');
    expect(invalid((p) => p.ladder.pop()).path).toBe('profile.ladder');
    expect(invalid((p) => p.ladder.push(p.ladder[5])).path).toBe('profile.ladder');
    expect(invalid((p) => (p.ladder[3].step = 2)).path).toBe('profile.ladder[3].step');
    expect(invalid((p) => (p.ladder[3].step = '3')).path).toBe('profile.ladder[3].step');
    expect(invalid((p) => (p.ladder[0] = null)).path).toBe('profile.ladder[0]');
  });

  it('cells need a valid kind, duration and label', () => {
    expect(invalid((p) => (p.ladder[1].lowMedium.kind = 'mute')).path).toBe('profile.ladder[1].lowMedium.kind');
    expect(invalid((p) => (p.ladder[1].lowMedium.kind = 'note')).path).toBe('profile.ladder[1].lowMedium.kind');
    expect(invalid((p) => (p.ladder[1].high.durationMs = 0)).path).toBe('profile.ladder[1].high.durationMs');
    expect(invalid((p) => (p.ladder[1].high.durationMs = -5)).path).toBe('profile.ladder[1].high.durationMs');
    expect(invalid((p) => delete p.ladder[1].high.durationMs).path).toBe('profile.ladder[1].high.durationMs');
    expect(invalid((p) => (p.ladder[1].high.label = '')).path).toBe('profile.ladder[1].high.label');
    expect(invalid((p) => delete p.ladder[4].lowMedium).path).toBe('profile.ladder[4].lowMedium');
    expect(invalid((p) => delete p.ladder[4].high).path).toBe('profile.ladder[4].high');
  });

  it('a warning cell has no duration', () => {
    expect(invalid((p) => (p.ladder[1].high = { kind: 'warning', durationMs: DAY, label: 'Warning' })).path).toBe(
      'profile.ladder[1].high.durationMs',
    );
  });

  it('a custom, valid ladder is accepted', () => {
    const ladder = LADDER_TABLE.map((r) => ({
      step: r.step,
      lowMedium: { kind: 'ban' as const, durationMs: null, label: 'Ban' },
      high: { kind: 'ban' as const, durationMs: null, label: 'Ban' },
    }));
    expect(resolveProfile('strict', { ladder }).ladder[0]!.lowMedium.kind).toBe('ban');
  });
});

describe('validation: profanity', () => {
  it('mode and style enums', () => {
    expect(invalid((p) => (p.profanity.mode = 'block')).path).toBe('profile.profanity.mode');
    expect(invalid((p) => (p.profanity.mode = 1)).path).toBe('profile.profanity.mode');
    expect(invalid((p) => (p.profanity.style = 'stars')).path).toBe('profile.profanity.style');
    for (const mode of ['allow', 'star', 'refuse'] as const) {
      expect(resolveProfile('relaxed', { profanity: { mode } }).profanity.mode).toBe(mode);
    }
    for (const style of ['full', 'keepFirst', 'grawlix'] as const) {
      expect(resolveProfile('relaxed', { profanity: { style } }).profanity.style).toBe(style);
    }
  });

  it('missing profanity fields', () => {
    for (const key of ['mode', 'style', 'add', 'remove', 'only', 'languages']) {
      expect(invalid((p) => delete p.profanity[key]).path).toBe(`profile.profanity.${key}`);
    }
  });

  it('word lists: arrays of plain strings, 1..40 chars, no whitespace', () => {
    for (const key of ['add', 'remove', 'only']) {
      expect(invalid((p) => (p.profanity[key] = 'word')).path).toBe(`profile.profanity.${key}`);
      expect(invalid((p) => (p.profanity[key] = [3])).path).toBe(`profile.profanity.${key}[0]`);
      expect(invalid((p) => (p.profanity[key] = ['ok', ''])).path).toBe(`profile.profanity.${key}[1]`);
      expect(invalid((p) => (p.profanity[key] = ['a b'])).path).toBe(`profile.profanity.${key}[0]`);
      expect(invalid((p) => (p.profanity[key] = ['a\tb'])).path).toBe(`profile.profanity.${key}[0]`);
      expect(invalid((p) => (p.profanity[key] = ['a\nb'])).path).toBe(`profile.profanity.${key}[0]`);
      expect(invalid((p) => (p.profanity[key] = ['x'.repeat(41)])).path).toBe(`profile.profanity.${key}[0]`);
      expect(invalid((p) => (p.profanity[key] = [{}])).path).toBe(`profile.profanity.${key}[0]`);
    }
  });

  it('boundaries: 1 and 40 characters pass', () => {
    const r = resolveProfile('relaxed', { profanity: { add: ['x', 'y'.repeat(40)], only: ['z'] } });
    expect(r.profanity.add).toEqual(['x', 'y'.repeat(40)]);
  });

  it('only may be null but add and remove may not', () => {
    expect(resolveProfile('relaxed', { profanity: { only: null } }).profanity.only).toBeNull();
    expect(invalid((p) => (p.profanity.add = null)).path).toBe('profile.profanity.add');
    expect(invalid((p) => (p.profanity.remove = null)).path).toBe('profile.profanity.remove');
  });

  it('languages is an array of plain words', () => {
    expect(invalid((p) => (p.profanity.languages = 'en')).path).toBe('profile.profanity.languages');
    expect(invalid((p) => (p.profanity.languages = [''])).path).toBe('profile.profanity.languages[0]');
    expect(resolveProfile('relaxed', { profanity: { languages: [] } }).profanity.languages).toEqual([]);
  });

  it('errors never echo a rejected word', () => {
    const e = failure(() => resolveProfile('relaxed', { profanity: { add: ['quissel drakkuun'] } }));
    expect(e.path).toBe('profile.profanity.add[0]');
    expect(e.message).not.toContain('quissel');
    expect(e.message).not.toContain('drakkuun');
  });
});

const tier = (covers: unknown[], over: Record<string, unknown> = {}) => ({
  title: 'T',
  description: 'D',
  examples: [],
  covers,
  outcome: 'Something',
  ...over,
});

describe('validation: guidelines tiers', () => {
  it('every conduct level must be covered', () => {
    for (const level of CONDUCT_LEVELS) {
      const e = invalid((p) => {
        p.guidelines = [tier(CONDUCT_LEVELS.filter((l) => l !== level), { outcome: 'None' })];
      });
      expect(e.path).toBe('profile.guidelines');
      expect(e.message).toContain(level);
    }
  });

  it('no level may be covered twice, across tiers or within one', () => {
    const across = invalid((p) => p.guidelines.push(tier(['rude'])));
    expect(across.path).toBe('profile.guidelines[5].covers[0]');
    const within = invalid((p) => (p.guidelines[1].covers = ['rude', 'rude']));
    expect(within.path).toBe('profile.guidelines[1].covers[1]');
  });

  it('repeated and after_warning are optional and may appear at most once each', () => {
    const g = [tier(['banter', 'rude', 'hostile', 'severe'], { outcome: 'None' })];
    expect(resolveProfile('relaxed', { guidelines: g as never }).guidelines).toHaveLength(1);
    const g2 = [tier(['banter', 'rude', 'hostile', 'severe', 'repeated'], { outcome: 'None' })];
    expect(resolveProfile('relaxed', { guidelines: g2 as never }).guidelines).toHaveLength(1);
  });

  it('a second repeated, or a second after_warning, is an error', () => {
    expect(invalid((p) => p.guidelines.push(tier(['repeated']))).path).toBe('profile.guidelines[5].covers[0]');
    expect(invalid((p) => p.guidelines.push(tier(['after_warning']))).path).toBe('profile.guidelines[5].covers[0]');
  });

  it('unknown cover values are errors', () => {
    expect(invalid((p) => (p.guidelines[0].covers = ['banter', 'medium'])).path).toBe(
      'profile.guidelines[0].covers[1]',
    );
    expect(invalid((p) => (p.guidelines[0].covers = [])).path).toBe('profile.guidelines[0].covers');
    expect(invalid((p) => (p.guidelines[0].covers = 'banter')).path).toBe('profile.guidelines[0].covers');
  });

  it('tier fields: title, description, outcome are non-empty strings; examples an array of strings', () => {
    expect(invalid((p) => (p.guidelines[2].title = '')).path).toBe('profile.guidelines[2].title');
    expect(invalid((p) => (p.guidelines[2].description = '')).path).toBe('profile.guidelines[2].description');
    expect(invalid((p) => (p.guidelines[2].outcome = '')).path).toBe('profile.guidelines[2].outcome');
    expect(invalid((p) => (p.guidelines[2].outcome = 4)).path).toBe('profile.guidelines[2].outcome');
    expect(invalid((p) => (p.guidelines[2].examples = 'x')).path).toBe('profile.guidelines[2].examples');
    expect(invalid((p) => (p.guidelines[2].examples = [1])).path).toBe('profile.guidelines[2].examples[0]');
    expect(invalid((p) => (p.guidelines[2] = 'x')).path).toBe('profile.guidelines[2]');
    expect(invalid((p) => (p.guidelines = {})).path).toBe('profile.guidelines');
  });

  it('outcome is free text: any non-empty string is accepted, on any tier', () => {
    for (const outcome of ['None', 'No action.', 'Whatever the team wants to say', 'A ban for a week']) {
      for (const i of [0, 3]) {
        const r = resolveProfile('relaxed', {
          guidelines: PRESETS.relaxed.guidelines.map((g, j) => (j === i ? { ...g, outcome } : g)),
        });
        expect(r.guidelines[i]!.outcome).toBe(outcome);
      }
    }
  });
});

describe('errors never echo values that could be chat text', () => {
  it('a bad value in any text field stays out of the message', () => {
    const secret = 'zorbak-xyzzy-sentinel';
    const probes: Array<(p: Loose) => void> = [
      (p) => (p.firstOffense.rude = secret),
      (p) => (p.firstOffense.rude = { kind: secret, durationMs: DAY }),
      (p) => (p.firstOffense.rude = { kind: 'chat', durationMs: secret }),
      (p) => (p.aiAutoAct = [secret]),
      (p) => (p.repeat.notes = secret),
      (p) => (p.repeat.windowDays = secret),
      (p) => (p.profanity.mode = secret),
      (p) => (p.profanity.style = secret),
      (p) => (p.profanity.add = [secret + ' x']),
      (p) => (p.profanity.only = [secret.repeat(5)]),
      (p) => (p.rules = secret),
      (p) => (p.guidelines[0].covers = [secret]),
      (p) => (p.ladder[0].lowMedium.kind = secret),
      (p) => (p.ladder[0].step = secret),
      (p) => (p.levels.rude.examples = [secret, 5]),
      (p) => (p.id = 7),
    ];
    for (const probe of probes) {
      const e = invalid(probe);
      expect(e.message).not.toContain(secret);
      expect(e.message).not.toContain('sentinel');
      expect(e.message.startsWith(e.path)).toBe(true);
    }
  });
});

describe('ProfileError', () => {
  it('is an Error with a name and a path', () => {
    const e = new ProfileError('profile.x', 'is wrong');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ProfileError');
    expect(e.path).toBe('profile.x');
    expect(e.message).toBe('profile.x is wrong');
  });
});

describe('areaRules and severeRules (K3a Task 4)', () => {
  it('every preset carries the K2 defaults: areaRules [5, 6], severeRules [1]', () => {
    for (const p of Object.values(PRESETS)) {
      expect(p.areaRules).toEqual([5, 6]);
      expect(p.severeRules).toEqual([1]);
    }
  });

  it('overrides replace the array whole and keep the siblings', () => {
    const p = resolveProfile('relaxed', { areaRules: [7], severeRules: [2, 3] });
    expect(p.areaRules).toEqual([7]);
    expect(p.severeRules).toEqual([2, 3]);
    expect(p.repeat).toEqual(PRESETS.relaxed.repeat);
    expect(PRESETS.relaxed.areaRules).toEqual([5, 6]);
  });

  it('an empty list is allowed and switches the swap or the severe column off', () => {
    const p = resolveProfile('standard', { areaRules: [], severeRules: [] });
    expect(p.areaRules).toEqual([]);
    expect(p.severeRules).toEqual([]);
  });

  it('duplicates are removed, keeping the first of each in order', () => {
    expect(resolveProfile('relaxed', { areaRules: [6, 5, 6, 5] }).areaRules).toEqual([6, 5]);
    expect(resolveProfile('relaxed', { severeRules: [1, 1, 1] }).severeRules).toEqual([1]);
    const custom = copy(PRESETS.relaxed);
    custom['areaRules'] = [5, 5, 6];
    expect(defineProfile(custom as unknown as ModerationProfile).areaRules).toEqual([5, 6]);
  });

  it('both fields are optional on a custom profile', () => {
    const custom = copy(PRESETS.strict);
    delete custom['areaRules'];
    delete custom['severeRules'];
    const p = defineProfile(custom as unknown as ModerationProfile);
    expect(p.areaRules).toBeUndefined();
    expect(p.severeRules).toBeUndefined();
  });

  it('anything but a whole number from 1 up is an error at the item path', () => {
    for (const field of ['areaRules', 'severeRules'] as const) {
      for (const bad of [0, -1, 1.5, '5', null, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
        const e = invalid((p) => (p[field] = [5, bad]));
        expect(e.path).toBe(`profile.${field}[1]`);
        expect(e.message.startsWith(e.path)).toBe(true);
      }
    }
  });

  it('a non-list is an error at the field path; an unknown rule key is still rejected', () => {
    for (const field of ['areaRules', 'severeRules'] as const) {
      for (const bad of ['5', 5, null, { 0: 5 }]) expect(invalid((p) => (p[field] = bad)).path).toBe(`profile.${field}`);
    }
    expect(failure(() => resolveProfile('relaxed', { areaRule: [5] } as never)).path).toBe('profile.areaRule');
  });

  it('the error never echoes the value', () => {
    const e = invalid((p) => (p.areaRules = ['sentinel-secret-text']));
    expect(e.message).not.toContain('sentinel');
  });

  it('the resolved arrays are frozen', () => {
    const p = resolveProfile('relaxed', { areaRules: [5] });
    expect(Object.isFrozen(p.areaRules)).toBe(true);
    expect(Object.isFrozen(p.severeRules)).toBe(true);
  });
});

describe('outcome durations are capped at 365 days (what decide accepts)', () => {
  const YEAR = 365 * DAY;
  it('MAX_DURATION_MS is the sanction cap, one source of truth', () => {
    expect(MAX_DURATION_MS).toBe(YEAR);
    expect(MAX_DURATION_MS).toBe(MAX_SANCTION_DURATION_MS);
  });

  it('an outcome, a repeat outcome and a ladder cell at exactly 365 days are accepted', () => {
    const p = resolveProfile('relaxed', { firstOffense: { severe: { kind: 'ban', durationMs: YEAR } } });
    expect(p.firstOffense.severe).toEqual({ kind: 'ban', durationMs: YEAR });
    const atCap = copy(PRESETS.relaxed) as { ladder: Array<{ high: { durationMs: number } }>; repeat: { outcome: unknown } };
    atCap.ladder[2]!.high.durationMs = YEAR;
    atCap.repeat.outcome = { kind: 'chat', durationMs: YEAR } as never;
    expect(() => defineProfile(atCap as unknown as ModerationProfile)).not.toThrow();
  });

  it('365 days + 1 ms is refused, with the path of the outcome, repeat outcome and ladder cell', () => {
    expect(invalid((p) => (p.firstOffense.severe = { kind: 'ban', durationMs: YEAR + 1 })).path).toBe('profile.firstOffense.severe.durationMs');
    expect(invalid((p) => (p.repeat.outcome = { kind: 'chat', durationMs: YEAR + 1 })).path).toBe('profile.repeat.outcome.durationMs');
    expect(invalid((p) => (p.ladder[2].high.durationMs = YEAR + 1)).path).toBe('profile.ladder[2].high.durationMs');
    expect(invalid((p) => (p.ladder[2].high.durationMs = 2 * YEAR)).path).toBe('profile.ladder[2].high.durationMs');
  });

  it('the message names the 365 day limit and never the value', () => {
    const err = invalid((p) => (p.firstOffense.severe = { kind: 'ban', durationMs: YEAR + 12345 }));
    expect(err.message).toContain('365 days');
    expect(err.message).not.toContain('12345');
  });

  it('no preset names a duration decide would refuse', () => {
    for (const preset of Object.values(PRESETS)) {
      for (const outcome of Object.values(preset.firstOffense)) {
        if (typeof outcome === 'object' && outcome !== null && 'durationMs' in outcome && outcome.durationMs !== null) {
          expect(outcome.durationMs).toBeLessThanOrEqual(YEAR);
        }
      }
    }
  });
});
