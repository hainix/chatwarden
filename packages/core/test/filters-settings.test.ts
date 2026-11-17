import { describe, expect, it } from 'vitest';
import {
  checkFilters,
  FILTER_ACTIONS,
  FILTER_LIMITS,
  FILTER_SUGGESTIONS,
  filterRulePaths,
  filtersActive,
  resolveFilters,
  type FilterSettings,
} from '../src/filters.js';
import { SHARED_HOSTING_SUFFIXES } from '../src/filters/lists.js';
import { PRESETS, ProfileError } from '../src/profile.js';

const OFF = { links: null, personalInfo: null, phrases: [], ratio: null, ignore: [], flagCapPerDay: 50 };

function fails(input: unknown): ProfileError {
  try {
    resolveFilters(input as FilterSettings);
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}
const pathOf = (input: unknown): string => fails(input).path;
const links = (extra: Record<string, unknown> = {}): unknown => ({ links: { action: 'flag', ...extra } });

describe('defaults', () => {
  it('filters absent resolves to every block off, flagCapPerDay 50, ignore empty', () => {
    expect(resolveFilters(undefined)).toEqual(OFF);
    expect(resolveFilters({})).toEqual(OFF);
    expect(filtersActive(resolveFilters(undefined))).toBe(false);
  });

  it('presets ship filters unset (and resolve to off)', () => {
    for (const name of ['relaxed', 'standard', 'strict'] as const) {
      expect(PRESETS[name].filters).toEqual(OFF);
    }
  });

  it('a block present is on with its defaults', () => {
    const r = resolveFilters({ links: { action: 'flag' }, personalInfo: { action: 'mask' }, ratio: { action: 'mask' }, phrases: [{ id: 'rmt', action: 'count', phrases: ['buy gold'] }] });
    expect(r.links).toEqual({ action: 'flag', rule: 4, allow: [], deny: [], unlisted: 'act', invites: true, shorteners: true, newAccountDays: null });
    expect(r.personalInfo).toEqual({ action: 'mask', rule: 2, kinds: ['phone', 'email', 'card', 'contact'], phone: 'formatted', address: null });
    expect(r.ratio).toEqual({ action: 'mask', rule: 4, caps: { minLetters: 12, maxPercent: 70 }, repeats: { maxRun: 6 }, emoji: { max: 8 }, mentions: { max: 3 } });
    expect(r.phrases).toEqual([{ id: 'rmt', label: 'rmt', action: 'count', rule: 4, phrases: ['buy gold'] }]);
    expect(filtersActive(r)).toBe(true);
  });

  it('null turns a block off; a ratio sub-check set to null is off', () => {
    expect(resolveFilters({ links: null, personalInfo: null, ratio: null })).toEqual(OFF);
    expect(resolveFilters({ ratio: { action: 'count', caps: null, emoji: null } }).ratio).toMatchObject({ caps: null, emoji: null, repeats: { maxRun: 6 }, mentions: { max: 3 } });
    expect(resolveFilters({ ratio: { action: 'count', caps: {} } }).ratio?.caps).toEqual({ minLetters: 12, maxPercent: 70 });
  });

  it('filtersActive is true for phrases alone and false for an empty list', () => {
    expect(filtersActive(resolveFilters({ phrases: [{ id: 'a', action: 'count', phrases: ['zorbak vlemmo'] }] }))).toBe(true);
    expect(filtersActive(resolveFilters({ phrases: [] }))).toBe(false);
  });
});

describe('actions and rules', () => {
  it('action is required on links, personalInfo, phrase rules and ratio', () => {
    expect(pathOf({ links: {} })).toBe('filters.links.action');
    expect(pathOf({ personalInfo: {} })).toBe('filters.personalInfo.action');
    expect(pathOf({ ratio: {} })).toBe('filters.ratio.action');
    expect(pathOf({ phrases: [{ id: 'a', phrases: ['zorbak vlemmo'] }] })).toBe('filters.phrases[0].action');
  });

  it('each of the four actions is accepted; an unknown one is refused with the path', () => {
    expect([...FILTER_ACTIONS]).toEqual(['count', 'flag', 'mask', 'refuse']);
    for (const action of FILTER_ACTIONS) {
      expect(resolveFilters({ links: { action }, ratio: { action }, personalInfo: { action }, phrases: [{ id: 'a', action, phrases: ['zorbak vlemmo'] }] }).links?.action).toBe(action);
    }
    for (const action of ['note', 'block', 'REFUSE', '', 3, null, undefined, {}]) {
      expect(pathOf({ links: { action } }), String(action)).toBe('filters.links.action');
    }
    expect(pathOf({ phrases: [{ id: 'a', action: 'note', phrases: ['zorbak vlemmo'] }] })).toBe('filters.phrases[0].action');
  });

  it('rule defaults: links 4, personalInfo 2, phrases 4, ratio 4', () => {
    const r = resolveFilters({ links: { action: 'count' }, personalInfo: { action: 'count' }, ratio: { action: 'count' }, phrases: [{ id: 'a', action: 'count', phrases: ['zorbak vlemmo'] }] });
    expect([r.links?.rule, r.personalInfo?.rule, r.phrases[0]?.rule, r.ratio?.rule]).toEqual([4, 2, 4, 4]);
  });

  it('a rule number must be a whole number from 1', () => {
    for (const rule of [0, -1, 1.5, '4', NaN, null, Infinity]) expect(pathOf({ links: { action: 'count', rule } }), String(rule)).toBe('filters.links.rule');
    expect(resolveFilters({ links: { action: 'count', rule: 7 } }).links?.rule).toBe(7);
  });

  it('filterRulePaths lists every rule the filters cite, with the path that names it', () => {
    const r = resolveFilters({
      links: { action: 'count', rule: 5 },
      personalInfo: { action: 'count' },
      ratio: { action: 'count', rule: 6 },
      phrases: [{ id: 'a', action: 'count', rule: 9, phrases: ['zorbak vlemmo'] }, { id: 'b', action: 'count', phrases: ['zorbak vlemmo'] }],
    });
    expect(filterRulePaths(r, 'filters')).toEqual([
      { path: 'filters.links.rule', rule: 5 },
      { path: 'filters.personalInfo.rule', rule: 2 },
      { path: 'filters.phrases[0].rule', rule: 9 },
      { path: 'filters.phrases[1].rule', rule: 4 },
      { path: 'filters.ratio.rule', rule: 6 },
    ]);
    expect(filterRulePaths(resolveFilters(undefined), 'filters')).toEqual([]);
  });
});

describe('domain entries', () => {
  it('are lowercased; a = prefix is accepted and kept', () => {
    const r = resolveFilters({ links: { action: 'count', allow: ['Example.COM', '=Cdn.Example.com'], deny: ['Zorbak-Gold.Example'] } });
    expect(r.links?.allow).toEqual(['example.com', '=cdn.example.com']);
    expect(r.links?.deny).toEqual(['zorbak-gold.example']);
  });

  it.each([
    ['a scheme', 'https://example.com'],
    ['a scheme without slashes', 'http:example.com'],
    ['a path', 'example.com/shop'],
    ['a space', 'example .com'],
    ['a trailing space', 'example.com '],
    ['a port', 'example.com:8080'],
    ['a wildcard', '*.example.com'],
    ['a trailing wildcard', 'example.*'],
    ['an empty entry', ''],
    ['only the = prefix', '='],
    ['a double =', '==example.com'],
    ['a single label (it would allow a whole top-level domain)', 'com'],
    ['an empty label', 'example..com'],
    ['a leading dot', '.example.com'],
    ['a trailing dot', 'example.com.'],
    ['an @', 'user@example.com'],
    ['a query', 'example.com?x=1'],
    ['a backslash', 'example.com\\x'],
    ['a label of 64 characters', `${'a'.repeat(64)}.com`],
    ['a host of 254 characters', `${'a.'.repeat(126)}com`],
    ['a number', 5],
    ['a null', null],
    ['an object', {}],
  ])('refused: %s', (_what, entry) => {
    expect(pathOf(links({ allow: [entry] }))).toBe('filters.links.allow[0]');
    expect(pathOf(links({ deny: ['example.org', entry] }))).toBe('filters.links.deny[1]');
  });

  it('a single label is fine when it is written exactly', () => {
    expect(resolveFilters({ links: { action: 'count', allow: ['=localhost'] } }).links?.allow).toEqual(['=localhost']);
  });

  it('an internationalised entry is kept as written (lowercased)', () => {
    expect(resolveFilters({ links: { action: 'count', allow: ['B\u{fc}cher.example'] } }).links?.allow).toEqual(['b\u{fc}cher.example']);
  });

  it('100 are accepted and 101 refused, on each list', () => {
    const list = (n: number): string[] => Array.from({ length: n }, (_, i) => `d${i}.example`);
    expect(resolveFilters({ links: { action: 'count', allow: list(100), deny: list(100).map((d) => `x${d}`) } }).links?.allow).toHaveLength(100);
    expect(pathOf(links({ allow: list(101) }))).toBe('filters.links.allow');
    expect(pathOf(links({ deny: list(101) }))).toBe('filters.links.deny');
    expect(FILTER_LIMITS.domains).toBe(100);
  });

  it('a list that is not a list is refused', () => {
    expect(pathOf(links({ allow: 'example.com' }))).toBe('filters.links.allow');
    expect(pathOf(links({ deny: {} }))).toBe('filters.links.deny');
  });

  it('a domain on both lists is refused, with or without the =', () => {
    expect(pathOf(links({ allow: ['example.com'], deny: ['example.com'] }))).toBe('filters.links.allow[0]');
    expect(pathOf(links({ allow: ['=example.com'], deny: ['example.com'] }))).toBe('filters.links.allow[0]');
    expect(pathOf(links({ allow: ['example.com'], deny: ['EXAMPLE.com'] }))).toBe('filters.links.allow[0]');
    expect(() => resolveFilters(links({ allow: ['example.com'], deny: ['sub.example.com'] }) as FilterSettings)).not.toThrow();
  });

  it('the refusal never echoes the entry', () => {
    expect(fails(links({ allow: ['https://zorbak-gold.example/vlemmo'] })).message).not.toContain('zorbak');
    expect(fails(links({ allow: ['github.io'] })).message).not.toContain('github');
  });
});

describe('allow and shared hosting', () => {
  it('github.io, vercel.app and the whole shared-hosting list are refused unless written =name.github.io', () => {
    expect(SHARED_HOSTING_SUFFIXES.length).toBeGreaterThanOrEqual(14);
    for (const suffix of SHARED_HOSTING_SUFFIXES) {
      expect(pathOf(links({ allow: ['fenrisk.example', suffix] })), suffix).toBe('filters.links.allow[1]');
      expect(pathOf(links({ allow: [suffix.toUpperCase()] })), suffix).toBe('filters.links.allow[0]');
      expect(() => resolveFilters(links({ allow: [`=snerp.${suffix}`] }) as FilterSettings), suffix).not.toThrow();
      expect(() => resolveFilters(links({ allow: [`snerp.${suffix}`] }) as FilterSettings), suffix).not.toThrow();
    }
  });

  it('example.com and cdn.example.com are accepted', () => {
    expect(resolveFilters({ links: { action: 'count', allow: ['example.com', 'cdn.example.com'] } }).links?.allow).toEqual(['example.com', 'cdn.example.com']);
  });

  it('a shared-hosting suffix is fine on the deny list', () => {
    expect(resolveFilters({ links: { action: 'count', deny: ['github.io'] } }).links?.deny).toEqual(['github.io']);
  });
});

describe('links options', () => {
  it('unlisted is act or allow; invites and shorteners are booleans', () => {
    expect(resolveFilters({ links: { action: 'count', unlisted: 'allow', invites: false, shorteners: false } }).links).toMatchObject({ unlisted: 'allow', invites: false, shorteners: false });
    expect(pathOf(links({ unlisted: 'deny' }))).toBe('filters.links.unlisted');
    expect(pathOf(links({ invites: 'yes' }))).toBe('filters.links.invites');
    expect(pathOf(links({ shorteners: 1 }))).toBe('filters.links.shorteners');
  });

  it('newAccountDays 1..365 or null', () => {
    expect(resolveFilters({ links: { action: 'count', newAccountDays: 1 } }).links?.newAccountDays).toBe(1);
    expect(resolveFilters({ links: { action: 'count', newAccountDays: 365 } }).links?.newAccountDays).toBe(365);
    expect(resolveFilters({ links: { action: 'count', newAccountDays: null } }).links?.newAccountDays).toBeNull();
    for (const v of [0, 366, 1.5, '2', NaN, -1]) expect(pathOf(links({ newAccountDays: v })), String(v)).toBe('filters.links.newAccountDays');
  });
});

describe('phrase rules', () => {
  const rule = (extra: Record<string, unknown> = {}) => ({ id: 'rmt', action: 'flag', phrases: ['buy gold'], ...extra });

  it('id grammar and uniqueness', () => {
    for (const id of ['a', 'rmt', 'a_b-c9', 'a'.repeat(32)]) expect(() => resolveFilters({ phrases: [rule({ id })] as never }), id).not.toThrow();
    for (const id of ['', 'A', '1a', '_a', 'a b', 'a.b', 'a'.repeat(33), 5, null, undefined]) {
      expect(pathOf({ phrases: [rule({ id })] }), String(id)).toBe('filters.phrases[0].id');
    }
    expect(pathOf({ phrases: [rule({ id: 'a' }), rule({ id: 'b' }), rule({ id: 'a' })] })).toBe('filters.phrases[2].id');
  });

  it('20 rules and 21 refused', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => rule({ id: `r${i}`, phrases: [`zorbak${'x'.repeat(i % 3)} vlemmo`] }));
    expect(resolveFilters({ phrases: many(20) as never }).phrases).toHaveLength(20);
    expect(pathOf({ phrases: many(21) })).toBe('filters.phrases');
  });

  it('100 patterns per rule and 500 in all; 101 and 501 refused', () => {
    const pats = (n: number, tag = 'a') => Array.from({ length: n }, (_, i) => `zorbak${tag}${i} vlemmo`);
    expect(resolveFilters({ phrases: [rule({ phrases: pats(100) })] as never }).phrases[0]?.phrases).toHaveLength(100);
    expect(pathOf({ phrases: [rule({ phrases: pats(101) })] })).toBe('filters.phrases[0].phrases');
    const five = Array.from({ length: 5 }, (_, i) => rule({ id: `r${i}`, phrases: pats(100, `t${i}`) }));
    expect(resolveFilters({ phrases: five as never }).phrases).toHaveLength(5);
    const six = [...five, rule({ id: 'r5', phrases: pats(1, 'z') })];
    expect(pathOf({ phrases: six })).toBe('filters.phrases[5].phrases');
    expect(FILTER_LIMITS.patternsTotal).toBe(500);
  });

  it('a label over 40 is refused; 40 accepted; empty or not text refused', () => {
    expect(resolveFilters({ phrases: [rule({ label: 'x'.repeat(40) })] as never }).phrases[0]?.label).toBe('x'.repeat(40));
    for (const label of ['x'.repeat(41), '', 5, null]) expect(pathOf({ phrases: [rule({ label })] }), String(label)).toBe('filters.phrases[0].label');
  });

  it('empty or missing phrases are refused', () => {
    expect(pathOf({ phrases: [rule({ phrases: [] })] })).toBe('filters.phrases[0].phrases');
    expect(pathOf({ phrases: [rule({ phrases: undefined })] })).toBe('filters.phrases[0].phrases');
    expect(pathOf({ phrases: [rule({ phrases: 'buy gold' })] })).toBe('filters.phrases[0].phrases');
  });

  it('a bad pattern is refused with its path and never echoed', () => {
    const e = fails({ phrases: [rule(), rule({ id: 'b', phrases: ['fine zorbak', '[zorbak]'] })] });
    expect(e.path).toBe('filters.phrases[1].phrases[1]');
    expect(e.message).not.toContain('zorbak');
  });

  it('phrases that is not a list, and a rule that is not an object, are refused', () => {
    expect(pathOf({ phrases: {} })).toBe('filters.phrases');
    expect(pathOf({ phrases: [5] })).toBe('filters.phrases[0]');
    expect(pathOf({ phrases: [[]] })).toBe('filters.phrases[0]');
    expect(pathOf({ phrases: [rule({ nope: 1 })] })).toBe('filters.phrases[0].nope');
  });
});

describe('pattern grammar through the settings', () => {
  const one = (p: unknown) => ({ phrases: [{ id: 'a', action: 'count', phrases: [p] }] });
  it.each([
    ['* zorbak', 'a * first token'],
    ['~ zorbak', 'a ~ first token'],
    ['to zorbak', 'a first word under 3 letters'],
    ['zorbak vlemmo quissel drakkuun fenrisk tarvo snerp', 'more than 6 tokens'],
    ['zorbak ~ ~ ~ vlemmo', 'more than 2 ~'],
    [`${'ab'.repeat(40)}c`, 'an 81 character pattern'],
    ['...', 'a pattern that folds to nothing'],
    ['[zorbak]', 'a regular-expression character class'],
    ['zorbak+', 'a plus'],
    ['(zorbak|vlemmo)', 'a group'],
    ['zorbak\\d', 'a backslash'],
    [5, 'a number'],
  ])('refused: %s (%s)', (pattern, _why) => {
    void _why;
    expect(pathOf(one(pattern))).toBe('filters.phrases[0].phrases[0]');
  });
  it.each(['zorbak', 'zorbak|vlemmo', 'zorbak*', 'zorbak * vlemmo', 'zorbak ~ vlemmo', 'zorbak ~ vlemmo ~ quissel', 'G0LD S@LLER'])('accepted: %s', (pattern) => {
    expect(() => resolveFilters(one(pattern) as FilterSettings)).not.toThrow();
  });
});

describe('ratio numbers', () => {
  const ratio = (extra: Record<string, unknown>): unknown => ({ ratio: { action: 'count', ...extra } });
  it.each([
    ['caps', 'minLetters', 8, 200, 'filters.ratio.caps.minLetters'],
    ['caps', 'maxPercent', 50, 100, 'filters.ratio.caps.maxPercent'],
    ['repeats', 'maxRun', 3, 50, 'filters.ratio.repeats.maxRun'],
    ['emoji', 'max', 1, 50, 'filters.ratio.emoji.max'],
    ['mentions', 'max', 1, 20, 'filters.ratio.mentions.max'],
  ])('%s.%s: %i..%i, each edge accepted and the next refused', (block, key, lo, hi, path) => {
    const at = (v: unknown) => ratio({ [block]: { [key]: v } });
    expect(() => resolveFilters(at(lo) as FilterSettings)).not.toThrow();
    expect(() => resolveFilters(at(hi) as FilterSettings)).not.toThrow();
    expect(pathOf(at(lo - 1))).toBe(path);
    expect(pathOf(at(hi + 1))).toBe(path);
    for (const v of [NaN, 2.5, '8', null, Infinity, -1, {}]) expect(pathOf(at(v)), String(v)).toBe(path);
  });

  it('a ratio sub-block that is not an object or null is refused; an unknown member is refused', () => {
    expect(pathOf(ratio({ caps: 5 }))).toBe('filters.ratio.caps');
    expect(pathOf(ratio({ caps: [] }))).toBe('filters.ratio.caps');
    expect(pathOf(ratio({ caps: { nope: 1 } }))).toBe('filters.ratio.caps.nope');
    expect(pathOf(ratio({ words: {} }))).toBe('filters.ratio.words');
  });
});

describe('personalInfo', () => {
  const pi = (extra: Record<string, unknown>): unknown => ({ personalInfo: { action: 'count', ...extra } });
  it('kinds are a subset of phone, email, card and contact', () => {
    expect(resolveFilters(pi({ kinds: ['email'] }) as FilterSettings).personalInfo?.kinds).toEqual(['email']);
    expect(resolveFilters(pi({ kinds: ['card', 'phone'] }) as FilterSettings).personalInfo?.kinds).toEqual(['card', 'phone']);
    expect(pathOf(pi({ kinds: ['address'] }))).toBe('filters.personalInfo.kinds[0]');
    expect(pathOf(pi({ kinds: ['email', 'ssn'] }))).toBe('filters.personalInfo.kinds[1]');
    expect(pathOf(pi({ kinds: [] }))).toBe('filters.personalInfo.kinds');
    expect(pathOf(pi({ kinds: 'email' }))).toBe('filters.personalInfo.kinds');
    expect(pathOf(pi({ kinds: ['email', 'email'] }))).toBe('filters.personalInfo.kinds[1]');
  });

  it('phone is formatted or any', () => {
    expect(resolveFilters(pi({ phone: 'any' }) as FilterSettings).personalInfo?.phone).toBe('any');
    expect(pathOf(pi({ phone: 'loose' }))).toBe('filters.personalInfo.phone');
  });

  it("address is 'count' or 'flag' only; 'refuse' or 'mask' is refused", () => {
    expect(resolveFilters(pi({ address: 'count' }) as FilterSettings).personalInfo?.address).toBe('count');
    expect(resolveFilters(pi({ address: 'flag' }) as FilterSettings).personalInfo?.address).toBe('flag');
    expect(resolveFilters(pi({ address: null }) as FilterSettings).personalInfo?.address).toBeNull();
    for (const v of ['refuse', 'mask', true, 'on']) expect(pathOf(pi({ address: v })), String(v)).toBe('filters.personalInfo.address');
  });
});

describe('the small settings', () => {
  it('flagCapPerDay 1..500', () => {
    expect(resolveFilters({ flagCapPerDay: 1 }).flagCapPerDay).toBe(1);
    expect(resolveFilters({ flagCapPerDay: 500 }).flagCapPerDay).toBe(500);
    for (const v of [0, 501, 2.5, '50', NaN, null]) expect(pathOf({ flagCapPerDay: v }), String(v)).toBe('filters.flagCapPerDay');
  });

  it('ignore: 50 entries of 1..60 characters, lowercased', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `Phrase ${i}`);
    const r = resolveFilters({ ignore: fifty });
    expect(r.ignore).toHaveLength(50);
    expect(r.ignore[0]).toBe('phrase 0');
    expect(pathOf({ ignore: [...fifty, 'x'] })).toBe('filters.ignore');
    expect(resolveFilters({ ignore: ['x'.repeat(60)] }).ignore[0]).toHaveLength(60);
    for (const bad of ['', '   ', 'x'.repeat(61), 5, null]) expect(pathOf({ ignore: ['ok', bad] }), String(bad)).toBe('filters.ignore[1]');
    expect(pathOf({ ignore: 'x' })).toBe('filters.ignore');
  });
});

describe('shape', () => {
  it('unknown keys are refused with their path, at every level', () => {
    expect(pathOf({ nope: 1 })).toBe('filters.nope');
    expect(pathOf({ links: { action: 'count', nope: 1 } })).toBe('filters.links.nope');
    expect(pathOf({ personalInfo: { action: 'count', nope: 1 } })).toBe('filters.personalInfo.nope');
    expect(pathOf({ ratio: { action: 'count', nope: 1 } })).toBe('filters.ratio.nope');
  });

  it('non-plain objects and arrays where objects belong are refused', () => {
    for (const v of [5, 'x', [], true, new Date(), new Map(), null]) {
      if (v === null) continue;
      expect(pathOf(v), String(v)).toBe('filters');
    }
    for (const v of [5, 'x', [], true, new Date()]) {
      expect(pathOf({ links: v }), String(v)).toBe('filters.links');
      expect(pathOf({ personalInfo: v })).toBe('filters.personalInfo');
      expect(pathOf({ ratio: v })).toBe('filters.ratio');
    }
    class Settings {
      links = { action: 'count' };
    }
    expect(pathOf(new Settings())).toBe('filters');
  });

  it('getters are read once, so what is validated is what is used', () => {
    let reads = 0;
    const input = {
      get links() {
        reads++;
        return reads === 1 ? { action: 'count' } : { action: 'bogus' };
      },
    };
    const r = resolveFilters(input as never);
    expect(r.links?.action).toBe('count');
    expect(reads).toBe(1);
  });

  it('a null-prototype object is accepted; an inherited key is not read', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o['flagCapPerDay'] = 7;
    expect(resolveFilters(o as never).flagCapPerDay).toBe(7);
    const child = Object.create({ flagCapPerDay: 9 }) as Record<string, unknown>;
    expect(() => resolveFilters(child as never)).toThrow(ProfileError);
  });

  it('the result shares nothing with the input', () => {
    const allow = ['example.com'];
    const input = { links: { action: 'count', allow } } as FilterSettings;
    const r = resolveFilters(input);
    allow.push('evil.example');
    expect(r.links?.allow).toEqual(['example.com']);
    expect(input.links?.allow).toHaveLength(2);
    expect(checkFilters(input).links).not.toBe(input.links);
  });

  it('an error path can be prefixed for a profile or a layer', () => {
    try {
      resolveFilters({ links: { action: 'bad' as never } }, 'profile.filters');
    } catch (e) {
      expect((e as ProfileError).path).toBe('profile.filters.links.action');
      return;
    }
    throw new Error('expected a ProfileError');
  });

  it('checkFilters returns only what was given', () => {
    expect(checkFilters({ flagCapPerDay: 9 })).toEqual({ flagCapPerDay: 9 });
    expect(checkFilters({ links: null })).toEqual({ links: null });
    expect(checkFilters({})).toEqual({});
  });
});

describe('suggestions', () => {
  it('FILTER_SUGGESTIONS validate and resolve; none is applied by default', () => {
    expect(Object.keys(FILTER_SUGGESTIONS).sort()).toEqual(['relaxed', 'rmt', 'standard', 'strict']);
    for (const [name, s] of Object.entries(FILTER_SUGGESTIONS)) {
      expect(() => resolveFilters(s as FilterSettings), name).not.toThrow();
      expect(Object.isFrozen(s), name).toBe(true);
    }
    expect(FILTER_SUGGESTIONS.relaxed).toEqual({});
    expect(resolveFilters(FILTER_SUGGESTIONS.standard).links?.action).toBe('flag');
    expect(resolveFilters(FILTER_SUGGESTIONS.standard).personalInfo?.action).toBe('mask');
    expect(resolveFilters(FILTER_SUGGESTIONS.strict).links).toMatchObject({ action: 'refuse', newAccountDays: 2 });
    expect(resolveFilters(FILTER_SUGGESTIONS.strict).ratio?.action).toBe('mask');
    expect(resolveFilters(FILTER_SUGGESTIONS.rmt).phrases[0]).toMatchObject({ id: 'rmt', action: 'flag' });
    expect(filtersActive(resolveFilters(undefined))).toBe(false);
    expect(PRESETS.strict.filters).toEqual(OFF);
  });
});
