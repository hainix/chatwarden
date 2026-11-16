import { describe, expect, it } from 'vitest';
import { durationMs } from '../src/testing/duration.js';

describe('durationMs', () => {
  it('every unit', () => {
    expect(durationMs('250ms')).toBe(250);
    expect(durationMs('5s')).toBe(5_000);
    expect(durationMs('30m')).toBe(1_800_000);
    expect(durationMs('2h')).toBe(7_200_000);
    expect(durationMs('7d')).toBe(604_800_000);
  });

  it('a number is milliseconds, and 0 is allowed', () => {
    expect(durationMs(0)).toBe(0);
    expect(durationMs(1)).toBe(1);
    expect(durationMs(86_400_000)).toBe(86_400_000);
    expect(durationMs('0s')).toBe(0);
    expect(durationMs('0ms')).toBe(0);
  });

  it("'1.5s' is 1500, and a fraction of a millisecond rounds to a whole one", () => {
    expect(durationMs('1.5s')).toBe(1500);
    expect(durationMs('0.5m')).toBe(30_000);
    expect(durationMs('0.25h')).toBe(900_000);
    expect(durationMs('1.5ms')).toBe(2);
    expect(Number.isInteger(durationMs('0.0004s'))).toBe(true);
  });

  it("'-1s', '5x', '', ' 5s', NaN, Infinity, 1e400 are RangeErrors that do not echo the value", () => {
    const bad: unknown[] = ['-1s', '5x', '', ' 5s', '5s ', '5 s', 's', '5', '1e3s', '+5s', '5S', '5sec', '.5s', '5.s', '0x10s', NaN, Infinity, -Infinity, Number('1e400'), -1, '99999999999999999999d', Number.MAX_VALUE, null, undefined, {}, [], true, 5n];
    for (const value of bad) {
      let error: unknown;
      try {
        durationMs(value as never);
      } catch (e) {
        error = e;
      }
      expect(error, String(value)).toBeInstanceOf(RangeError);
      const message = (error as RangeError).message;
      // The message is fixed text: it never contains what was passed.
      if (typeof value === 'string' && value.length > 1) expect(message).not.toContain(value);
      expect(message).toMatch(/250ms|10s|30m|2h|7d/);
      expect(message.length).toBeLessThan(160);
    }
  });

  it('a fractional number of milliseconds is a whole one', () => {
    expect(durationMs(1.4)).toBe(1);
    expect(durationMs(2.6)).toBe(3);
  });
});
