import { describe, expect, it } from 'vitest';
import { createFakeClock } from '../src/testing/clock.js';

describe('createFakeClock', () => {
  it('starts at 1_800_000_000_000', () => {
    expect(createFakeClock().now()).toBe(1_800_000_000_000);
  });

  it('starts where it is told', () => {
    expect(createFakeClock(5).now()).toBe(5);
    expect(createFakeClock(0).now()).toBe(0);
  });

  it('a start that is not a finite non-negative number is a RangeError', () => {
    for (const start of [NaN, Infinity, -1, '5', null] as unknown[]) expect(() => createFakeClock(start as number), String(start)).toThrow(RangeError);
  });

  it('set is exact, forwards and back', () => {
    const clock = createFakeClock();
    clock.set(42);
    expect(clock.now()).toBe(42);
    clock.set(1_900_000_000_123);
    expect(clock.now()).toBe(1_900_000_000_123);
    clock.set(7);
    expect(clock.now()).toBe(7);
    for (const bad of [NaN, Infinity, -1, '5'] as unknown[]) expect(() => clock.set(bad as number)).toThrow(RangeError);
    expect(clock.now()).toBe(7);
  });

  it('advance moves forward and returns the time', () => {
    const clock = createFakeClock(1000);
    expect(clock.advance(500)).toBe(1500);
    expect(clock.advance('2s')).toBe(3500);
    expect(clock.advance('1h')).toBe(3_603_500);
    expect(clock.advance(0)).toBe(3_603_500);
    expect(clock.now()).toBe(3_603_500);
  });

  it('advance by a negative or invalid value throws and moves nothing', () => {
    const clock = createFakeClock(1000);
    for (const bad of [-1, '-1s', NaN, Infinity, '5x', ''] as unknown[]) {
      expect(() => clock.advance(bad as number), String(bad)).toThrow(RangeError);
      expect(clock.now()).toBe(1000);
    }
  });

  it('now() is what the kit reads: a function that works detached from the clock object', () => {
    const clock = createFakeClock(10);
    const { now } = clock;
    clock.advance(5);
    expect(now()).toBe(15);
  });

  it('two clocks share nothing', () => {
    const a = createFakeClock();
    const b = createFakeClock();
    a.advance('1d');
    expect(b.now()).toBe(1_800_000_000_000);
  });
});
