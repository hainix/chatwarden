import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { APPEAL_STATEMENT_MAX, resolveAppeals } from '../src/appeals.js';
import { createChatwarden } from '../src/chatwarden.js';
import { defineProfile, PRESETS, ProfileError, resolveProfile, validateProfile } from '../src/profile.js';

// The `appeals` settings: in the profile (code), resolved with every field filled, refused with a path and never the value.

const DEFAULTS = { enabled: false, perPlayerPerWeek: 3, allowSelfReview: false };
const NAME_DEFAULTS = { profanity: false, keepBlocked: false, renames: false, maskInHub: true };

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}

describe('appeals settings', () => {
  it('defaults: appeals off, perPlayerPerWeek 3, allowSelfReview false', () => {
    expect(resolveAppeals(undefined)).toEqual(DEFAULTS);
    expect(resolveAppeals({})).toEqual(DEFAULTS);
    expect(resolveProfile('standard').appeals).toEqual(DEFAULTS);
  });

  it('the statement cap is 1000 characters', () => {
    expect(APPEAL_STATEMENT_MAX).toBe(1000);
  });

  it('every field set is read back; a field left out keeps its default', () => {
    expect(resolveAppeals({ enabled: true })).toEqual({ ...DEFAULTS, enabled: true });
    expect(resolveAppeals({ perPlayerPerWeek: 7 })).toEqual({ ...DEFAULTS, perPlayerPerWeek: 7 });
    expect(resolveAppeals({ enabled: true, perPlayerPerWeek: 5, allowSelfReview: true })).toEqual({ enabled: true, perPlayerPerWeek: 5, allowSelfReview: true });
    expect(resolveAppeals({ enabled: undefined, perPlayerPerWeek: undefined })).toEqual(DEFAULTS);
  });

  it('perPlayerPerWeek 1 and 20 accepted; 0, 21, 2.5, NaN, a string refused with the path', () => {
    expect(resolveAppeals({ perPlayerPerWeek: 1 }).perPlayerPerWeek).toBe(1);
    expect(resolveAppeals({ perPlayerPerWeek: 20 }).perPlayerPerWeek).toBe(20);
    for (const v of [0, 21, 2.5, Number.NaN, Infinity, -1, '3', null, true, 1e21]) {
      expect(failure(() => resolveAppeals({ perPlayerPerWeek: v as never })).path, String(v)).toBe('appeals.perPlayerPerWeek');
    }
  });

  it('non-boolean flags refused', () => {
    for (const v of [1, 0, 'true', null, {}, []]) {
      expect(failure(() => resolveAppeals({ enabled: v as never })).path).toBe('appeals.enabled');
      expect(failure(() => resolveAppeals({ allowSelfReview: v as never })).path).toBe('appeals.allowSelfReview');
    }
  });

  it('unknown keys refused with their path', () => {
    expect(failure(() => resolveAppeals({ nope: 1 } as never)).path).toBe('appeals.nope');
    expect(failure(() => resolveAppeals({ enabled: true, perDay: 2 } as never)).path).toBe('appeals.perDay');
  });

  it('a section that is not an object is refused at appeals', () => {
    for (const v of [5, 'x', null, [], true]) expect(failure(() => resolveAppeals(v as never)).path).toBe('appeals');
  });

  it('a path argument names the settings in the error', () => {
    expect(failure(() => resolveAppeals({ perPlayerPerWeek: 0 }, 'profile.appeals')).path).toBe('profile.appeals.perPlayerPerWeek');
  });

  it('the error never echoes the value', () => {
    expect(failure(() => resolveAppeals({ perPlayerPerWeek: 987654 })).message).not.toContain('987654');
    expect(failure(() => resolveAppeals({ enabled: 'secret-value' as never })).message).not.toContain('secret-value');
  });

  it('each value is read once, so a getter cannot pass a check and then return something else', () => {
    let reads = 0;
    const sneaky = {
      get perPlayerPerWeek(): number {
        reads += 1;
        return reads === 1 ? 5 : 500;
      },
    };
    expect(resolveAppeals(sneaky).perPlayerPerWeek).toBe(5);
    expect(reads).toBe(1);
  });

  it('the result is a new object that shares nothing with the input', () => {
    const input = { enabled: true };
    expect(resolveAppeals(input)).not.toBe(input);
    expect(resolveAppeals(undefined)).not.toBe(resolveAppeals(undefined));
  });
});

describe('appeals in the profile', () => {
  it('presets ship appeals unset, and resolve to the defaults', () => {
    for (const name of ['relaxed', 'standard', 'strict'] as const) expect(PRESETS[name].appeals).toEqual(DEFAULTS);
  });

  it('a code profile with appeals resolves it, frozen, and overrides merge key by key', () => {
    const p = resolveProfile('standard', { appeals: { enabled: true, perPlayerPerWeek: 5 } });
    expect(p.appeals).toEqual({ enabled: true, perPlayerPerWeek: 5, allowSelfReview: false });
    expect(Object.isFrozen(p.appeals)).toBe(true);
    const coded = defineProfile({ ...PRESETS.standard, appeals: { enabled: true, allowSelfReview: true } });
    expect(resolveProfile(coded, { appeals: { perPlayerPerWeek: 9 } }).appeals).toEqual({ enabled: true, perPlayerPerWeek: 9, allowSelfReview: true });
    expect(PRESETS.standard.appeals).toEqual(DEFAULTS);
  });

  it('a profile written without appeals resolves it to the defaults', () => {
    const { appeals: _a, ...without } = PRESETS.standard as typeof PRESETS.standard & { appeals?: unknown };
    void _a;
    expect(defineProfile(without as never).appeals).toEqual(DEFAULTS);
  });

  it('a resolved profile passes validateProfile again', () => {
    const p = resolveProfile('strict', { appeals: { enabled: true } });
    expect(() => validateProfile(p)).not.toThrow();
    expect(defineProfile(p).appeals).toEqual(p.appeals);
  });

  it('a bad appeals in code names profile.appeals... and never echoes the value', () => {
    expect(failure(() => resolveProfile('standard', { appeals: { perPlayerPerWeek: 0 } })).path).toBe('profile.appeals.perPlayerPerWeek');
    expect(failure(() => resolveProfile('standard', { appeals: { nope: 1 } as never })).path).toBe('profile.appeals.nope');
    expect(failure(() => resolveProfile('standard', { appeals: 5 as never })).path).toBe('profile.appeals');
    expect(failure(() => resolveProfile('standard', { appeals: { perPlayerPerWeek: 987654 } })).message).not.toContain('987654');
  });

  it('appeals is a known top-level key but not a required one', () => {
    expect(() => validateProfile({ ...PRESETS.standard, appeals: undefined })).not.toThrow();
  });

  it('with both unset cw.profile equals the 0.1.7 profile apart from the two new resolved fields', async () => {
    const cw = await createChatwarden({
      store: new MemoryStore(),
      secret: 's',
      platform: { identify: (ctx) => ctx as never },
      clock: { now: () => 1_800_000_000_000 },
      retention: false,
    });
    const { appeals, names, ...rest } = cw.profile as unknown as Record<string, unknown>;
    expect(appeals).toEqual(DEFAULTS);
    expect(names).toEqual(NAME_DEFAULTS);
    const { appeals: _a, names: _n, ...base } = resolveProfile('standard') as unknown as Record<string, unknown>;
    void _a;
    void _n;
    expect(rest).toEqual(base);
  });
});
