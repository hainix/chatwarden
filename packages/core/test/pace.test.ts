import { describe, expect, it } from 'vitest';
import { DUPLICATE_MIN_CHARS, DUPLICATE_RECENT, mergePace, PACE_KEYS_MAX, PACE_REASONS, PACE_SUGGESTIONS, resolvePace } from '../src/pace.js';
import type { PaceSettings, ResolvedPace } from '../src/pace.js';
import { ProfileError } from '../src/profile.js';

const OFF: ResolvedPace = { slowModeMs: null, burst: null, duplicateWindowMs: null };

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    return err as ProfileError;
  }
  throw new Error('expected a ProfileError');
}

describe('constants', () => {
  it('has the spec values', () => {
    expect(PACE_REASONS).toEqual(['slow_mode', 'flood', 'duplicate']);
    expect(DUPLICATE_MIN_CHARS).toBe(3);
    expect(DUPLICATE_RECENT).toBe(8);
    expect(PACE_KEYS_MAX).toBe(50_000);
  });
});

describe('resolvePace', () => {
  it('all unset resolves to all null', () => {
    expect(resolvePace(undefined)).toEqual(OFF);
    expect(resolvePace({})).toEqual(OFF);
  });

  it('null and absent are both off', () => {
    expect(resolvePace({ slowModeMs: null, burst: null, duplicateWindowMs: null })).toEqual(OFF);
    expect(resolvePace({ slowModeMs: undefined, burst: undefined, duplicateWindowMs: undefined })).toEqual(OFF);
    expect(resolvePace({ slowModeMs: 1000 })).toEqual({ ...OFF, slowModeMs: 1000 });
  });

  it('returns a fresh object each call and never the input', () => {
    const input: PaceSettings = { burst: { lines: 5, windowMs: 10_000 } };
    const a = resolvePace(input);
    const b = resolvePace(input);
    expect(a).not.toBe(b);
    expect(a.burst).not.toBe(input.burst);
    expect(a.burst).toEqual({ lines: 5, windowMs: 10_000 });
  });

  it('each field accepts its minimum and maximum', () => {
    expect(resolvePace({ slowModeMs: 500 }).slowModeMs).toBe(500);
    expect(resolvePace({ slowModeMs: 600_000 }).slowModeMs).toBe(600_000);
    expect(resolvePace({ burst: { lines: 2, windowMs: 1000 } }).burst).toEqual({ lines: 2, windowMs: 1000 });
    expect(resolvePace({ burst: { lines: 100, windowMs: 600_000 } }).burst).toEqual({ lines: 100, windowMs: 600_000 });
    expect(resolvePace({ duplicateWindowMs: 1000 }).duplicateWindowMs).toBe(1000);
    expect(resolvePace({ duplicateWindowMs: 3_600_000 }).duplicateWindowMs).toBe(3_600_000);
  });

  it.each<[PaceSettings, string]>([
    [{ slowModeMs: 499 }, 'pace.slowModeMs'],
    [{ slowModeMs: 600_001 }, 'pace.slowModeMs'],
    [{ slowModeMs: 0 }, 'pace.slowModeMs'],
    [{ burst: { lines: 1, windowMs: 10_000 } }, 'pace.burst.lines'],
    [{ burst: { lines: 101, windowMs: 10_000 } }, 'pace.burst.lines'],
    [{ burst: { lines: 5, windowMs: 999 } }, 'pace.burst.windowMs'],
    [{ burst: { lines: 5, windowMs: 600_001 } }, 'pace.burst.windowMs'],
    [{ duplicateWindowMs: 999 }, 'pace.duplicateWindowMs'],
    [{ duplicateWindowMs: 3_600_001 }, 'pace.duplicateWindowMs'],
  ])('each field rejects one below and one above, naming the path: %j -> %s', (input, path) => {
    expect(failure(() => resolvePace(input)).path).toBe(path);
  });

  it('rejects a fraction, NaN, Infinity, a string, a negative, a boolean and an array', () => {
    const bad: unknown[] = [1500.5, NaN, Infinity, -Infinity, '1500', -1500, true, false, [1500], {}, 10n, Number.MAX_SAFE_INTEGER + 2];
    for (const v of bad) {
      expect(failure(() => resolvePace({ slowModeMs: v } as never)).path, String(typeof v)).toBe('pace.slowModeMs');
      expect(failure(() => resolvePace({ duplicateWindowMs: v } as never)).path).toBe('pace.duplicateWindowMs');
      expect(failure(() => resolvePace({ burst: { lines: v, windowMs: 10_000 } } as never)).path).toBe('pace.burst.lines');
      expect(failure(() => resolvePace({ burst: { lines: 5, windowMs: v } } as never)).path).toBe('pace.burst.windowMs');
    }
  });

  it('rejects a burst that is not an object, or is missing a member', () => {
    for (const v of [5, 'x', true, [], [5, 10_000]]) expect(failure(() => resolvePace({ burst: v } as never)).path).toBe('pace.burst');
    expect(failure(() => resolvePace({ burst: { lines: 5 } } as never)).path).toBe('pace.burst.windowMs');
    expect(failure(() => resolvePace({ burst: { windowMs: 5000 } } as never)).path).toBe('pace.burst.lines');
    expect(failure(() => resolvePace({ burst: {} } as never)).path).toBe('pace.burst.lines');
  });

  it('rejects an unknown key such as pace.nope with its path', () => {
    expect(failure(() => resolvePace({ nope: 1 } as never)).path).toBe('pace.nope');
    expect(failure(() => resolvePace({ burst: { lines: 5, windowMs: 5000, nope: 1 } } as never)).path).toBe('pace.burst.nope');
  });

  it('rejects an input that is not a plain object', () => {
    for (const v of [5, 'x', true, [], null, () => 1]) expect(failure(() => resolvePace(v as never)).path).toBe('pace');
  });

  it('names the path from a caller-given prefix', () => {
    expect(failure(() => resolvePace({ burst: { lines: 1, windowMs: 5000 } }, 'profile.pace')).path).toBe('profile.pace.burst.lines');
  });

  it('a thrown message never contains the bad value', () => {
    const secret = 'quissel-1234567.891';
    for (const v of [secret, 1234567.891, -987654321, Symbol.for('x')] as unknown[]) {
      for (const make of [
        () => resolvePace({ slowModeMs: v } as never),
        () => resolvePace({ burst: { lines: v, windowMs: 5000 } } as never),
        () => resolvePace({ duplicateWindowMs: v } as never),
      ]) {
        const err = failure(make);
        expect(err.message).not.toContain('1234567');
        expect(err.message).not.toContain('987654321');
        expect(err.message).not.toContain('quissel');
        expect(err.reason).not.toContain('1234567');
      }
    }
  });
});

describe('mergePace', () => {
  const base: ResolvedPace = { slowModeMs: 2000, burst: { lines: 6, windowMs: 10_000 }, duplicateWindowMs: 15_000 };

  it('absent inherits, null turns off, a value sets', () => {
    expect(mergePace(base, {})).toEqual(base);
    expect(mergePace(base, { slowModeMs: null })).toEqual({ ...base, slowModeMs: null });
    expect(mergePace(base, { burst: null })).toEqual({ ...base, burst: null });
    expect(mergePace(base, { duplicateWindowMs: null })).toEqual({ ...base, duplicateWindowMs: null });
    expect(mergePace(base, { slowModeMs: 3000 })).toEqual({ ...base, slowModeMs: 3000 });
    expect(mergePace(OFF, { duplicateWindowMs: 5000 })).toEqual({ ...OFF, duplicateWindowMs: 5000 });
    expect(mergePace(base, { slowModeMs: undefined })).toEqual(base);
  });

  it('an override of {} changes nothing', () => {
    expect(mergePace(base, {})).toEqual(base);
    expect(mergePace(OFF, {})).toEqual(OFF);
  });

  it('burst merges whole, not by member', () => {
    const out = mergePace(base, { burst: { lines: 3, windowMs: 4000 } });
    expect(out.burst).toEqual({ lines: 3, windowMs: 4000 });
    // A half burst is a mistake, not "keep the other member".
    expect(failure(() => mergePace(base, { burst: { lines: 3 } } as never)).path).toBe('pace.burst.windowMs');
  });

  it('does not change or alias its inputs', () => {
    const copy = JSON.parse(JSON.stringify(base)) as ResolvedPace;
    const over: PaceSettings = { burst: { lines: 3, windowMs: 4000 } };
    const out = mergePace(base, over);
    expect(base).toEqual(copy);
    expect(out.burst).not.toBe(over.burst);
    expect(mergePace(base, {}).burst).not.toBe(base.burst);
  });

  it('validates the override with the field path and never echoes it', () => {
    expect(failure(() => mergePace(base, { slowModeMs: 1 })).path).toBe('pace.slowModeMs');
    expect(failure(() => mergePace(base, { nope: 1 } as never)).path).toBe('pace.nope');
    expect(failure(() => mergePace(base, { slowModeMs: 987654 } as never)).message).not.toContain('987654');
  });
});

describe('PACE_SUGGESTIONS', () => {
  it('matches the spec table for relaxed, standard and strict, each passing resolvePace', () => {
    expect(PACE_SUGGESTIONS).toEqual({
      relaxed: { slowModeMs: null, burst: { lines: 10, windowMs: 10_000 }, duplicateWindowMs: 10_000 },
      standard: { slowModeMs: null, burst: { lines: 6, windowMs: 10_000 }, duplicateWindowMs: 15_000 },
      strict: { slowModeMs: 2000, burst: { lines: 5, windowMs: 10_000 }, duplicateWindowMs: 30_000 },
    });
    for (const name of ['relaxed', 'standard', 'strict'] as const) {
      expect(resolvePace(PACE_SUGGESTIONS[name])).toEqual(PACE_SUGGESTIONS[name]);
    }
  });

  it('is frozen, all the way down', () => {
    expect(Object.isFrozen(PACE_SUGGESTIONS)).toBe(true);
    for (const name of ['relaxed', 'standard', 'strict'] as const) {
      expect(Object.isFrozen(PACE_SUGGESTIONS[name])).toBe(true);
      expect(Object.isFrozen(PACE_SUGGESTIONS[name].burst)).toBe(true);
    }
    expect(() => {
      (PACE_SUGGESTIONS.relaxed as { slowModeMs: number | null }).slowModeMs = 5;
    }).toThrow();
  });
});
