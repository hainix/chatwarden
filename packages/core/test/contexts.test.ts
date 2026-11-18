import { describe, expect, it } from 'vitest';
import { CONTEXT_SECTIONS, MAX_CONTEXTS, ROOM_TAG_KEYS, effectiveOf, isContextName, isScopeLabel, overriddenSections, resolveContexts } from '../src/contexts.js';
import type { ContextSettings } from '../src/contexts.js';
import { applyPolicyLayer, defineProfile, POLICY_SECTIONS, PRESETS, ProfileError, resolveProfile } from '../src/profile.js';
import type { ModerationProfile, PolicyLayer } from '../src/profile.js';
import { contextsWorld, SEC } from './contextsWorld.js';
import { OWNER } from './reportingWorld.js';

// M1: contexts in the profile: the grammar, the sections, the merge and the precedence (code, stored layer, context, setPace).

const OFF = { slowModeMs: null, burst: null, duplicateWindowMs: null };
const withContexts = (contexts: unknown): ModerationProfile => ({ ...PRESETS.standard, contexts }) as ModerationProfile;

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}
const bad = (contexts: unknown): ProfileError => failure(() => defineProfile(withContexts(contexts)));

describe('defaults', () => {
  it('no contexts: cw.contexts.names() is empty, a room with no context tag uses the base', async () => {
    const w = await contextsWorld();
    expect(w.cw.contexts.names()).toEqual([]);
    const seat = w.player('R1');
    expect(w.cw.contexts.of('R1')).toBeNull();
    expect(w.cw.contexts.of('never-seen')).toBeNull();
    expect(w.cw.contexts.effective(null).pace).toEqual(OFF);
    expect(w.cw.contexts.effective(null).chat).toEqual({ phrases: null, minAccountAgeDays: null });
    expect(w.cw.chat.accept('R1', seat, 'hello')).toMatchObject({ deliver: { text: 'hello' } });
  });

  it('the presets resolve contexts to an empty object and CONTEXT_SECTIONS lists the chat-time sections, filters included', () => {
    for (const name of ['relaxed', 'standard', 'strict'] as const) expect(PRESETS[name].contexts).toEqual({});
    expect([...CONTEXT_SECTIONS]).toEqual(['profanity', 'pace', 'chat', 'filters']);
    expect([...ROOM_TAG_KEYS]).toEqual(['context', 'scope']);
  });

  it('a layer that names contexts is refused with the path layer.contexts, and contexts is not an editable section', () => {
    expect((POLICY_SECTIONS as readonly string[]).includes('contexts')).toBe(false);
    const base = defineProfile(withContexts({ kids: { label: 'Kids' } }));
    const err = failure(() => applyPolicyLayer(base, { contexts: { kids: { label: 'Mine' } } } as unknown as PolicyLayer));
    expect(err.path).toBe('layer.contexts');
  });

  it('applying a layer carries the declared contexts unchanged', () => {
    const base = defineProfile(withContexts({ kids: { label: 'Kids', pace: { slowModeMs: 3000 } } }));
    const eff = applyPolicyLayer(base, { pace: { duplicateWindowMs: 5000 } });
    expect(eff.contexts).toEqual(base.contexts);
    expect(eff.contexts['kids']).toEqual({ label: 'Kids', pace: { slowModeMs: 3000 } });
  });

  it('a resolved profile passes through defineProfile again (resolved contexts are valid input)', () => {
    const once = defineProfile(withContexts({ kids: { pace: { slowModeMs: 3000 }, chat: { minAccountAgeDays: 7 } } }));
    expect(defineProfile(once).contexts).toEqual(once.contexts);
  });

  it('resolved contexts are deep-frozen and share nothing with the input', () => {
    const input = { kids: { profanity: { add: ['snerp'] }, pace: { burst: { lines: 3, windowMs: 5000 } } } };
    const p = defineProfile(withContexts(input));
    expect(Object.isFrozen(p.contexts)).toBe(true);
    expect(Object.isFrozen(p.contexts['kids'])).toBe(true);
    expect(Object.isFrozen(p.contexts['kids']?.profanity?.add)).toBe(true);
    input.kids.profanity.add.push('glarn');
    expect(p.contexts['kids']?.profanity?.add).toEqual(['snerp']);
  });

  it('overrides on resolveProfile merge contexts key by key', () => {
    const p = resolveProfile(defineProfile(withContexts({ kids: { label: 'Kids', pace: { slowModeMs: 3000 } } })), { contexts: { kids: { chat: { minAccountAgeDays: 3 } }, ranked: { label: 'Ranked' } } });
    expect(Object.keys(p.contexts)).toEqual(['kids', 'ranked']);
    expect(p.contexts['kids']).toEqual({ label: 'Kids', pace: { slowModeMs: 3000 }, chat: { minAccountAgeDays: 3 } });
  });
});

describe('context names', () => {
  it("'kids' and 'a1_b-2' accepted; '', 'Kids', '1kids', 33 characters and 21 contexts refused with the path, never echoing a value", () => {
    expect(Object.keys(defineProfile(withContexts({ kids: {}, 'a1_b-2': {} })).contexts)).toEqual(['kids', 'a1_b-2']);
    for (const name of ['', 'Kids', '1kids', `k${'a'.repeat(32)}`, 'ki ds', 'ki.ds', '_kids', 'k\u00e9']) {
      const err = bad({ [name]: {} });
      expect(err.path, JSON.stringify(name)).toBe('profile.contexts');
      if (name !== '') expect(err.message).not.toContain(name);
    }
    expect(Object.keys(defineProfile(withContexts({ [`k${'a'.repeat(31)}`]: {} })).contexts)).toHaveLength(1);
    const many = (n: number): Record<string, object> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, {}]));
    expect(Object.keys(defineProfile(withContexts(many(MAX_CONTEXTS))).contexts)).toHaveLength(MAX_CONTEXTS);
    expect(bad(many(MAX_CONTEXTS + 1)).path).toBe('profile.contexts');
  });

  it('isContextName and isScopeLabel follow the grammar', () => {
    for (const ok of ['kids', 'a', 'a1_b-2', `a${'b'.repeat(31)}`]) expect(isContextName(ok), ok).toBe(true);
    for (const no of ['', 'Kids', '1a', `a${'b'.repeat(32)}`, 'a b', 5, null, undefined]) expect(isContextName(no), String(no)).toBe(false);
    for (const ok of ['creator:alice', '0abc', 'a.b_c-d:e']) expect(isScopeLabel(ok), ok).toBe(true);
    for (const no of ['', 'Creator', ':a', '-a', `a${'b'.repeat(64)}`, 'a b', 1]) expect(isScopeLabel(no), String(no)).toBe(false);
  });

  it('contexts must be a plain object, and each context one too', () => {
    expect(bad([]).path).toBe('profile.contexts');
    expect(bad('kids').path).toBe('profile.contexts');
    expect(bad({ kids: 'x' }).path).toBe('profile.contexts.kids');
    expect(bad({ kids: null }).path).toBe('profile.contexts.kids');
    expect(bad({ kids: [] }).path).toBe('profile.contexts.kids');
  });
});

describe('what a context may hold', () => {
  it('unknown keys inside a context are refused with their path (a closed key and a bad value)', () => {
    expect(bad({ kids: { ladder: [] } }).path).toBe('profile.contexts.kids.ladder');
    expect(bad({ kids: { durations: [1] } }).path).toBe('profile.contexts.kids.durations');
    expect(bad({ kids: { pace: { slowModeMs: 1 } } }).path).toBe('profile.contexts.kids.pace.slowModeMs');
    expect(bad({ kids: { pace: { nope: 1 } } }).path).toBe('profile.contexts.kids.pace.nope');
    expect(bad({ kids: { profanity: { nope: 1 } } }).path).toBe('profile.contexts.kids.profanity.nope');
    expect(bad({ kids: { chat: { nope: 1 } } }).path).toBe('profile.contexts.kids.chat.nope');
    expect(bad({ kids: { filters: { nope: 1 } } }).path).toContain('profile.contexts.kids.filters');
    const err = bad({ kids: { pace: { slowModeMs: 123456789012 } } });
    expect(err.message).not.toContain('123456789012');
  });

  it('label is 1 to 40 characters; the name is the label when none is given', () => {
    expect(defineProfile(withContexts({ kids: {} })).contexts['kids']?.label).toBe('kids');
    expect(defineProfile(withContexts({ kids: { label: 'K' } })).contexts['kids']?.label).toBe('K');
    expect(defineProfile(withContexts({ kids: { label: 'x'.repeat(40) } })).contexts['kids']?.label).toHaveLength(40);
    for (const label of ['', '   ', 'x'.repeat(41), 5, null]) expect(bad({ kids: { label } }).path, String(label)).toBe('profile.contexts.kids.label');
  });

  it('minAccountAgeDays 1 and 365 accepted, 0, 366, 2.5, NaN, a string refused; null is no rule', () => {
    for (const ok of [1, 365, null]) expect(defineProfile(withContexts({ kids: { chat: { minAccountAgeDays: ok } } })).contexts['kids']?.chat?.minAccountAgeDays).toBe(ok);
    for (const no of [0, 366, 2.5, Number.NaN, Infinity, -1, '7', true]) expect(bad({ kids: { chat: { minAccountAgeDays: no } } }).path, String(no)).toBe('profile.contexts.kids.chat.minAccountAgeDays');
  });

  it('phrases must be a well-formed id or null', () => {
    for (const ok of ['junior', 'a', 'book_1-b', null]) expect(defineProfile(withContexts({ kids: { chat: { phrases: ok } } })).contexts['kids']?.chat?.phrases).toBe(ok);
    for (const no of ['', 'Junior', '1junior', 'a b', 'a'.repeat(33), 7, {}]) expect(bad({ kids: { chat: { phrases: no } } }).path, String(no)).toBe('profile.contexts.kids.chat.phrases');
  });

  it('profanity: mode and style are checked, word lists hold single words, only may be null', () => {
    const ok = { mode: 'refuse', style: 'grawlix', add: ['snerp'], remove: ['glarn'], only: null, languages: ['en'] };
    expect(defineProfile(withContexts({ kids: { profanity: ok } })).contexts['kids']?.profanity).toEqual(ok);
    expect(bad({ kids: { profanity: { mode: 'ban' } } }).path).toBe('profile.contexts.kids.profanity.mode');
    expect(bad({ kids: { profanity: { style: 'x' } } }).path).toBe('profile.contexts.kids.profanity.style');
    expect(bad({ kids: { profanity: { add: ['two words'] } } }).path).toBe('profile.contexts.kids.profanity.add[0]');
    expect(bad({ kids: { profanity: { remove: 'x' } } }).path).toBe('profile.contexts.kids.profanity.remove');
    expect(bad({ kids: { profanity: { only: [''] } } }).path).toBe('profile.contexts.kids.profanity.only[0]');
    expect(bad({ kids: { profanity: { languages: [5] } } }).path).toBe('profile.contexts.kids.profanity.languages[0]');
  });

  it('filters are checked like the profile filters, and a block that is off by null is allowed', () => {
    const p = defineProfile(withContexts({ kids: { filters: { links: { action: 'refuse' }, personalInfo: null } } }));
    expect(p.contexts['kids']?.filters).toEqual({ links: { action: 'refuse' }, personalInfo: null });
    expect(bad({ kids: { filters: { links: { action: 'shout' } } } }).path).toBe('profile.contexts.kids.filters.links.action');
  });

  it('overriddenSections lists the sections a context sets, in CONTEXT_SECTIONS order, never a value', () => {
    const r = resolveContexts({ a: { filters: { links: null }, pace: { slowModeMs: 1000 } }, b: {}, c: { chat: {}, profanity: { mode: 'allow' } } });
    expect(overriddenSections(r['a']!)).toEqual(['pace', 'filters']);
    expect(overriddenSections(r['b']!)).toEqual([]);
    expect(overriddenSections(r['c']!)).toEqual(['profanity', 'chat']);
  });
});

describe('the merge', () => {
  const base = defineProfile({ ...PRESETS.standard, pace: { slowModeMs: 2000, burst: { lines: 6, windowMs: 10_000 } }, profanity: { ...PRESETS.standard.profanity, add: ['snerp', 'glarn'], remove: ['tarvo'], only: null, languages: ['en'], mode: 'star', style: 'full' } });

  it('profanity override merges: mode set, style inherited; add replaces the base array whole; remove and only the same', () => {
    const eff = (p: ContextSettings) => effectiveOf({ ...base, contexts: resolveContexts({ c: p }) }, 'c').profanity;
    expect(eff({ profanity: { mode: 'refuse' } })).toEqual({ ...base.profanity, mode: 'refuse' });
    expect(eff({ profanity: { add: ['vlemmo'] } }).add).toEqual(['vlemmo']);
    expect(eff({ profanity: { remove: [] } }).remove).toEqual([]);
    expect(eff({ profanity: { only: ['quissel'] } }).only).toEqual(['quissel']);
    expect(eff({ profanity: { only: null } }).only).toBeNull();
    expect(eff({ profanity: { mode: 'allow' } }).style).toBe('full');
    expect(eff({ profanity: { languages: ['en', 'es'] } }).languages).toEqual(['en', 'es']);
  });

  it('pace override: slowModeMs set, burst inherited; null turns a base check off', () => {
    const eff = (p: ContextSettings) => effectiveOf({ ...base, contexts: resolveContexts({ c: p }) }, 'c').pace;
    expect(eff({ pace: { slowModeMs: 3000 } })).toEqual({ slowModeMs: 3000, burst: { lines: 6, windowMs: 10_000 }, duplicateWindowMs: null });
    expect(eff({ pace: { slowModeMs: null } })).toEqual({ slowModeMs: null, burst: { lines: 6, windowMs: 10_000 }, duplicateWindowMs: null });
    expect(eff({ pace: { burst: null } }).burst).toBeNull();
    expect(eff({ pace: { burst: { lines: 2, windowMs: 1000 } } }).burst).toEqual({ lines: 2, windowMs: 1000 });
    expect(eff({})).toEqual({ ...OFF, slowModeMs: 2000, burst: { lines: 6, windowMs: 10_000 } });
  });

  it('filters merge with mergeFilters: a block that is given replaces whole, null turns it off, the rest inherits', () => {
    const withFilters = defineProfile({ ...PRESETS.standard, filters: { links: { action: 'flag' }, personalInfo: { action: 'mask' } } });
    const eff = (f: ContextSettings['filters']) => effectiveOf({ ...withFilters, contexts: resolveContexts({ c: { filters: f } }) }, 'c').filters;
    expect(eff({ links: { action: 'refuse' } }).links?.action).toBe('refuse');
    expect(eff({ links: { action: 'refuse' } }).personalInfo?.action).toBe('mask');
    expect(eff({ links: null }).links).toBeNull();
    expect(eff({}).links?.action).toBe('flag');
  });

  it('cw.contexts.effective returns frozen values that share nothing with the profile; an unknown name throws ProfileError', async () => {
    const w = await contextsWorld({ kids: { pace: { slowModeMs: 3000 }, chat: { minAccountAgeDays: 7 } } });
    const eff = w.cw.contexts.effective('kids');
    expect(eff.pace.slowModeMs).toBe(3000);
    expect(eff.chat).toEqual({ phrases: null, minAccountAgeDays: 7 });
    expect(Object.isFrozen(eff) && Object.isFrozen(eff.pace) && Object.isFrozen(eff.profanity) && Object.isFrozen(eff.filters)).toBe(true);
    const live = w.cw.profile.contexts['kids'];
    expect(eff.pace).not.toBe(w.cw.profile.pace);
    expect(eff.profanity).not.toBe(w.cw.profile.profanity);
    expect(eff.filters).not.toBe(w.cw.profile.filters);
    expect(live?.pace).not.toBe(eff.pace);
    expect(w.cw.contexts.effective('kids')).toEqual(eff);
    expect(w.cw.contexts.effective(null).pace).toEqual(OFF);
    expect(failure(() => w.cw.contexts.effective('nope')).path).toBe('context');
    expect(() => w.cw.contexts.effective('__proto__')).toThrow(ProfileError);
    expect(() => w.cw.contexts.effective('toString')).toThrow(ProfileError);
  });

  it('the context names come in declaration order', async () => {
    const w = await contextsWorld({ zed: {}, alpha: {}, mid: {} });
    expect(w.cw.contexts.names()).toEqual(['zed', 'alpha', 'mid']);
  });
});

describe('precedence: the profile in code, the stored layer, the context, setPace', () => {
  const contexts = { slow: { pace: { slowModeMs: 3000 } }, plain: { label: 'Plain' } };

  it('a hub layer change to the base pace reaches a context that does not override pace and does not move one that does', async () => {
    const w = await contextsWorld(contexts);
    w.player('A', { tags: { context: 'slow' } });
    w.player('B', { tags: { context: 'plain' } });
    w.player('C');
    expect(w.cw.rooms.pace('B').slowModeMs).toBeNull();
    const saved = w.cw.policy.save({ pace: { slowModeMs: 9000, duplicateWindowMs: 5000 } }, { version: 0, ...OWNER });
    expect(saved.ok).toBe(true);
    expect(w.cw.rooms.pace('B')).toEqual({ slowModeMs: 9000, burst: null, duplicateWindowMs: 5000 });
    expect(w.cw.rooms.pace('C').slowModeMs).toBe(9000);
    // the context's own slow mode wins for what it sets, and it still inherits what it does not set
    expect(w.cw.rooms.pace('A')).toEqual({ slowModeMs: 3000, burst: null, duplicateWindowMs: 5000 });
  });

  it('setPace beats the context; close drops the override but a room opened again with the tag runs the context', async () => {
    const w = await contextsWorld(contexts);
    w.player('A', { tags: { context: 'slow' } });
    w.cw.rooms.setPace('A', { slowModeMs: 600_000 });
    expect(w.cw.rooms.pace('A').slowModeMs).toBe(600_000);
    w.cw.rooms.setPace('A', null);
    expect(w.cw.rooms.pace('A').slowModeMs).toBe(3000);
    w.cw.rooms.setPace('A', { slowModeMs: 1000 });
    w.cw.rooms.close('A');
    expect(w.cw.rooms.pace('A').slowModeMs).toBeNull();
    w.player('A', { tags: { context: 'slow' } });
    expect(w.cw.rooms.pace('A').slowModeMs).toBe(3000);
  });

  it('the merged context pace is not rebuilt per line, and a layer change builds it again', async () => {
    const w = await contextsWorld(contexts);
    w.player('A', { tags: { context: 'slow' } });
    const first = w.cw.rooms.pace('A');
    expect(w.cw.rooms.pace('A')).toBe(first);
    w.cw.policy.save({ pace: { duplicateWindowMs: 4000 } }, { version: 0, ...OWNER });
    const second = w.cw.rooms.pace('A');
    expect(second).not.toBe(first);
    expect(second.duplicateWindowMs).toBe(4000);
  });

  it('emergency raises the slow mode over the context pace, never lowers it', async () => {
    const w = await contextsWorld({ slow: { pace: { slowModeMs: 600_000 } } });
    w.player('A', { tags: { context: 'slow' } });
    w.cw.rooms.setMode('A', 'emergency');
    expect(w.cw.rooms.pace('A').slowModeMs).toBe(600_000);
  });

  it('the pacer holds nothing for a room whose context turns every check off', async () => {
    const w = await contextsWorld({ open: { pace: { slowModeMs: null, burst: null, duplicateWindowMs: null } } }, {}, { pace: { slowModeMs: 5000 } });
    const a = w.player('A', { tags: { context: 'open' } });
    const b = w.player('B');
    expect(w.cw.rooms.pace('A')).toEqual(OFF);
    for (let i = 0; i < 2; i += 1) {
      expect(w.cw.chat.accept('A', a, `line ${i}`)).toHaveProperty('deliver');
      w.clock.t += SEC;
    }
    w.clock.t += 10 * SEC;
    expect(w.cw.chat.accept('B', b, 'one')).toHaveProperty('deliver');
    expect(w.cw.chat.accept('B', b, 'two')).toMatchObject({ refuse: { reason: 'slow_mode' } });
  });
});
