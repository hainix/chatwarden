import { describe, expect, it } from 'vitest';
import { resolveNames } from '../src/names.js';
import { defineProfile, PRESETS, ProfileError, resolveProfile, validateProfile } from '../src/profile.js';

// The `names` settings: in the profile (code), resolved with every field filled, refused with a path and never the value.

const DEFAULTS = { profanity: false, keepBlocked: false, renames: false, maskInHub: true };

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}

describe('names settings', () => {
  it('defaults: profanity, keepBlocked and renames off and maskInHub on', () => {
    expect(resolveNames(undefined)).toEqual(DEFAULTS);
    expect(resolveNames({})).toEqual(DEFAULTS);
    expect(resolveProfile('standard').names).toEqual(DEFAULTS);
  });

  it('each flag set is read back, true or false; the others keep their default', () => {
    expect(resolveNames({ profanity: true })).toEqual({ ...DEFAULTS, profanity: true });
    expect(resolveNames({ keepBlocked: true })).toEqual({ ...DEFAULTS, keepBlocked: true });
    expect(resolveNames({ renames: true })).toEqual({ ...DEFAULTS, renames: true });
    expect(resolveNames({ maskInHub: false })).toEqual({ ...DEFAULTS, maskInHub: false });
    expect(resolveNames({ profanity: true, keepBlocked: true, renames: true, maskInHub: false })).toEqual({ profanity: true, keepBlocked: true, renames: true, maskInHub: false });
    expect(resolveNames({ maskInHub: undefined })).toEqual(DEFAULTS);
  });

  it('non-boolean flags refused with their path', () => {
    for (const key of ['profanity', 'keepBlocked', 'renames', 'maskInHub'] as const) {
      for (const v of [1, 0, 'true', null, {}, []]) expect(failure(() => resolveNames({ [key]: v } as never)).path, `${key} ${String(v)}`).toBe(`names.${key}`);
    }
  });

  it('unknown keys refused with their path', () => {
    expect(failure(() => resolveNames({ nope: true } as never)).path).toBe('names.nope');
    expect(failure(() => resolveNames({ renames: true, mask: true } as never)).path).toBe('names.mask');
  });

  it('a section that is not an object is refused at names', () => {
    for (const v of [5, 'x', null, [], true]) expect(failure(() => resolveNames(v as never)).path).toBe('names');
  });

  it('a path argument names the settings in the error, and the error never echoes the value', () => {
    const err = failure(() => resolveNames({ renames: 'secret-value' as never }, 'profile.names'));
    expect(err.path).toBe('profile.names.renames');
    expect(err.message).not.toContain('secret-value');
  });

  it('the result is a new object', () => {
    const input = { renames: true };
    expect(resolveNames(input)).not.toBe(input);
    expect(resolveNames(undefined)).not.toBe(resolveNames(undefined));
  });
});

describe('names in the profile', () => {
  it('presets ship names unset, and resolve to the defaults', () => {
    for (const name of ['relaxed', 'standard', 'strict'] as const) expect(PRESETS[name].names).toEqual(DEFAULTS);
  });

  it('a code profile with names resolves it, frozen; overrides merge key by key', () => {
    const p = resolveProfile('standard', { names: { renames: true } });
    expect(p.names).toEqual({ ...DEFAULTS, renames: true });
    expect(Object.isFrozen(p.names)).toBe(true);
    const coded = defineProfile({ ...PRESETS.standard, names: { profanity: true, maskInHub: false } });
    expect(resolveProfile(coded, { names: { keepBlocked: true } }).names).toEqual({ profanity: true, keepBlocked: true, renames: false, maskInHub: false });
  });

  it('a profile written without names resolves it to the defaults', () => {
    const { names: _n, ...without } = PRESETS.standard as typeof PRESETS.standard & { names?: unknown };
    void _n;
    expect(defineProfile(without as never).names).toEqual(DEFAULTS);
  });

  it('a resolved profile passes validateProfile again', () => {
    const p = resolveProfile('relaxed', { names: { profanity: true } });
    expect(() => validateProfile(p)).not.toThrow();
    expect(defineProfile(p).names).toEqual(p.names);
  });

  it('a bad names in code names profile.names...', () => {
    expect(failure(() => resolveProfile('standard', { names: { renames: 'yes' as never } })).path).toBe('profile.names.renames');
    expect(failure(() => resolveProfile('standard', { names: { nope: 1 } as never })).path).toBe('profile.names.nope');
    expect(failure(() => resolveProfile('standard', { names: 5 as never })).path).toBe('profile.names');
  });

  it('names is a known top-level key but not a required one', () => {
    expect(() => validateProfile({ ...PRESETS.standard, names: undefined })).not.toThrow();
  });
});
