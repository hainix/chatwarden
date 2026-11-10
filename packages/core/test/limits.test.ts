import { describe, expect, it } from 'vitest';
import { LIMITS_DEFAULTS, resolveLimits } from '../src/limits.js';
import { MAX_DURATION_MS, ProfileError } from '../src/profile.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('LIMITS_DEFAULTS and resolveLimits()', () => {
  it('the defaults are exactly the K1/K2 values', () => {
    expect(LIMITS_DEFAULTS).toEqual({
      chatMaxLength: 200,
      chatRate: { count: 3, windowMs: 5_000 },
      strikes: { count: 3, windowMs: 3_600_000, firstMs: 1_800_000, repeatMs: 86_400_000, repeatLookbackMs: 604_800_000 },
      reports: { perDay: 10, suspendAfter: 3, suspendWindowMs: 2_592_000_000 },
      reporterFeedback: true,
    });
  });

  it('nothing, undefined and {} all give the defaults', () => {
    expect(resolveLimits()).toEqual(LIMITS_DEFAULTS);
    expect(resolveLimits(undefined)).toEqual(LIMITS_DEFAULTS);
    expect(resolveLimits({})).toEqual(LIMITS_DEFAULTS);
    expect(resolveLimits({ strikes: {} })).toEqual(LIMITS_DEFAULTS);
  });

  it('the result is deep-frozen and shares nothing with the defaults or the input', () => {
    const input = { chatRate: { count: 1 } };
    const out = resolveLimits(input);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.chatRate)).toBe(true);
    expect(Object.isFrozen(out.strikes)).toBe(true);
    expect(Object.isFrozen(out.reports)).toBe(true);
    expect(Object.isFrozen(LIMITS_DEFAULTS)).toBe(true);
    expect(out.chatRate).not.toBe(input.chatRate);
    expect(out.strikes).not.toBe(LIMITS_DEFAULTS.strikes);
    input.chatRate.count = 99;
    expect(out.chatRate.count).toBe(1);
  });

  it('a nested override keeps its siblings', () => {
    const out = resolveLimits({ strikes: { count: 2 }, chatRate: { windowMs: 1_000 }, reports: { perDay: 3 } });
    expect(out.strikes).toEqual({ ...LIMITS_DEFAULTS.strikes, count: 2 });
    expect(out.chatRate).toEqual({ count: 3, windowMs: 1_000 });
    expect(out.reports).toEqual({ ...LIMITS_DEFAULTS.reports, perDay: 3 });
    expect(out.chatMaxLength).toBe(200);
    expect(out.reporterFeedback).toBe(true);
  });

  it('every top level value can be overridden', () => {
    const out = resolveLimits({ chatMaxLength: 50, reporterFeedback: false });
    expect(out.chatMaxLength).toBe(50);
    expect(out.reporterFeedback).toBe(false);
  });

  it('an undefined value means "not given"', () => {
    expect(resolveLimits({ chatMaxLength: undefined, strikes: { count: undefined } })).toEqual(LIMITS_DEFAULTS);
  });

  it('accepts the smallest values (1) and the longest duration', () => {
    const out = resolveLimits({
      chatMaxLength: 1,
      chatRate: { count: 1, windowMs: 1 },
      strikes: { count: 1, windowMs: 1, firstMs: 1, repeatMs: MAX_DURATION_MS, repeatLookbackMs: 1 },
      reports: { perDay: 1, suspendAfter: 1, suspendWindowMs: MAX_DURATION_MS },
    });
    expect(out.reports.suspendWindowMs).toBe(MAX_DURATION_MS);
    expect(out.chatMaxLength).toBe(1);
  });
});

const COUNT_FIELDS: Array<[string, (v: unknown) => object]> = [
  ['limits.chatMaxLength', (v) => ({ chatMaxLength: v })],
  ['limits.chatRate.count', (v) => ({ chatRate: { count: v } })],
  ['limits.strikes.count', (v) => ({ strikes: { count: v } })],
  ['limits.reports.perDay', (v) => ({ reports: { perDay: v } })],
  ['limits.reports.suspendAfter', (v) => ({ reports: { suspendAfter: v } })],
];
const DURATION_FIELDS: Array<[string, (v: unknown) => object]> = [
  ['limits.chatRate.windowMs', (v) => ({ chatRate: { windowMs: v } })],
  ['limits.strikes.windowMs', (v) => ({ strikes: { windowMs: v } })],
  ['limits.strikes.firstMs', (v) => ({ strikes: { firstMs: v } })],
  ['limits.strikes.repeatMs', (v) => ({ strikes: { repeatMs: v } })],
  ['limits.strikes.repeatLookbackMs', (v) => ({ strikes: { repeatLookbackMs: v } })],
  ['limits.reports.suspendWindowMs', (v) => ({ reports: { suspendWindowMs: v } })],
];

const BAD_NUMBERS: unknown[] = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, '5', null, true, {}];

function failure(input: unknown): ProfileError {
  try {
    resolveLimits(input as never);
  } catch (err) {
    if (err instanceof ProfileError) return err;
    throw err;
  }
  throw new Error('expected resolveLimits to throw');
}

describe('resolveLimits() validation', () => {
  for (const [path, build] of [...COUNT_FIELDS, ...DURATION_FIELDS]) {
    it.each(BAD_NUMBERS)(`${path} refuses %j and names the field`, (bad) => {
      const err = failure(build(bad));
      expect(err.path).toBe(path);
      expect(err.message).toMatch(new RegExp(`^${path.replaceAll('.', '\\.')} must be`));
    });
  }

  for (const [path, build] of DURATION_FIELDS) {
    it(`${path} refuses a duration over 365 days`, () => {
      expect(failure(build(MAX_DURATION_MS + 1)).path).toBe(path);
    });
  }

  it.each([0, 1, 'yes', null, {}])('reporterFeedback refuses %j', (bad) => {
    const err = failure({ reporterFeedback: bad });
    expect(err.path).toBe('limits.reporterFeedback');
    expect(err.message).toContain('true or false');
  });

  it('an unknown key is refused, at the top and nested, naming the path', () => {
    expect(failure({ chatLength: 50 }).path).toBe('limits.chatLength');
    expect(failure({ strikes: { limit: 2 } }).path).toBe('limits.strikes.limit');
    expect(failure({ reports: { perHour: 2 } }).path).toBe('limits.reports.perHour');
    expect(failure({ chatRate: { max: 1 } }).path).toBe('limits.chatRate.max');
    expect(failure({ chatRate: { max: 1 } }).message).toMatch(/is not a known setting$/);
  });

  it.each([null, 5, 'x', [1]])('a nested group that is %j is refused', (bad) => {
    expect(failure({ strikes: bad }).path).toBe('limits.strikes');
    expect(failure({ reports: bad }).path).toBe('limits.reports');
    expect(failure({ chatRate: bad }).path).toBe('limits.chatRate');
  });

  it.each([null, 5, 'x', [1]])('limits that is %j is refused', (bad) => {
    expect(failure(bad).path).toBe('limits');
  });

  it('the error never echoes the bad value', () => {
    expect(failure({ chatMaxLength: 'SECRETVALUE' }).message).not.toContain('SECRETVALUE');
    expect(failure({ strikes: { nope: 'SECRETVALUE' } }).message).not.toContain('SECRETVALUE');
  });

  it('spot-check the defaults are sane multiples of time', () => {
    expect(LIMITS_DEFAULTS.reports.suspendWindowMs).toBe(30 * DAY);
    expect(LIMITS_DEFAULTS.strikes.repeatLookbackMs).toBe(7 * DAY);
  });
});

describe('resolveLimits() durations are capped at 365 days', () => {
  const YEAR = 365 * DAY;
  for (const [path, build] of DURATION_FIELDS) {
    it(`${path}: exactly 365 days is accepted, 365 days + 1 ms is refused`, () => {
      expect(() => resolveLimits(build(YEAR) as never)).not.toThrow();
      expect(failure(build(YEAR + 1)).path).toBe(path);
    });
  }
});
