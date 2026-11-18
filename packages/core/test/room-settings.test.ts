import { describe, expect, it } from 'vitest';
import { resolveRooms } from '../src/roomSettings.js';
import { ProfileError } from '../src/profileError.js';

// The `rooms` settings: how long a lock or emergency lasts, what emergency adds, probation for new accounts, and unknown ages.

const DEFAULTS = {
  defaultModeMs: 1_800_000,
  emergency: { slowModeMs: 30_000, newAccountDays: 7 },
  probation: { enabled: false, ageDays: 2, slowModeMs: 5000 },
  unknownAge: 'allow',
};

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}

describe('resolveRooms', () => {
  it('defaults: 30 minutes; emergency 30 s and 7 days; probation off at 2 days and 5 s; unknownAge allow', () => {
    expect(resolveRooms(undefined)).toEqual(DEFAULTS);
    expect(resolveRooms({})).toEqual(DEFAULTS);
    expect(resolveRooms({ emergency: {}, probation: {} })).toEqual(DEFAULTS);
  });

  it('a partial setting fills the rest and shares nothing with the input', () => {
    const input = { emergency: { slowModeMs: 2000 }, probation: { enabled: true } };
    const r = resolveRooms(input);
    expect(r.emergency).toEqual({ slowModeMs: 2000, newAccountDays: 7 });
    expect(r.probation).toEqual({ enabled: true, ageDays: 2, slowModeMs: 5000 });
    expect(r.emergency).not.toBe(resolveRooms(input).emergency);
  });

  it('a resolved rooms is valid input again', () => {
    const once = resolveRooms({ defaultModeMs: 60_000, unknownAge: 'treat_as_new', emergency: { slowModeMs: 1000, newAccountDays: 0 }, probation: { enabled: true, ageDays: 30, slowModeMs: 500 } });
    expect(resolveRooms(once)).toEqual(once);
  });

  it.each([
    ['defaultModeMs', 60_000, 86_400_000],
    ['emergency.slowModeMs', 1000, 600_000],
    ['emergency.newAccountDays', 0, 30],
    ['probation.ageDays', 1, 30],
    ['probation.slowModeMs', 500, 600_000],
  ] as const)('%s: both edges accepted, one outside refused with the path', (key, lo, hi) => {
    const set = (v: number): unknown => {
      const [a, b] = key.split('.') as [string, string | undefined];
      return b === undefined ? { [a]: v } : { [a]: { [b]: v } };
    };
    for (const v of [lo, hi]) expect(() => resolveRooms(set(v) as never), `${key} ${v}`).not.toThrow();
    for (const v of [lo - 1, hi + 1]) expect(failure(() => resolveRooms(set(v) as never)).path, `${key} ${v}`).toBe(`rooms.${key}`);
  });

  it.each([2.5, Number.NaN, Infinity, '1000', null, true])('emergency.slowModeMs %j is refused with the path', (v) => {
    expect(failure(() => resolveRooms({ emergency: { slowModeMs: v as never } })).path).toBe('rooms.emergency.slowModeMs');
  });

  it('unknownAge is allow or treat_as_new; probation.enabled a boolean', () => {
    expect(resolveRooms({ unknownAge: 'treat_as_new' }).unknownAge).toBe('treat_as_new');
    expect(failure(() => resolveRooms({ unknownAge: 'deny' as never })).path).toBe('rooms.unknownAge');
    expect(failure(() => resolveRooms({ unknownAge: null as never })).path).toBe('rooms.unknownAge');
    expect(failure(() => resolveRooms({ probation: { enabled: 'yes' as never } })).path).toBe('rooms.probation.enabled');
  });

  it('unknown keys and non-objects are refused with their path', () => {
    expect(failure(() => resolveRooms({ nope: 1 } as never)).path).toBe('rooms.nope');
    expect(failure(() => resolveRooms({ emergency: { nope: 1 } } as never)).path).toBe('rooms.emergency.nope');
    expect(failure(() => resolveRooms({ probation: [] } as never)).path).toBe('rooms.probation');
    expect(failure(() => resolveRooms('x' as never)).path).toBe('rooms');
    expect(failure(() => resolveRooms({ emergency: { slowModeMs: 5 } }, 'layer.rooms')).path).toBe('layer.rooms.emergency.slowModeMs');
  });

  it('never echoes a refused value', () => {
    expect(failure(() => resolveRooms({ defaultModeMs: 123456789012 })).message).not.toContain('123456789012');
    expect(failure(() => resolveRooms({ unknownAge: 'zorbak' as never })).message).not.toContain('zorbak');
  });
});
