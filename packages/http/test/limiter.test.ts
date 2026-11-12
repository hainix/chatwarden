import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkLimit, Limiter, MAX_LIMITER_KEYS } from '../src/limiter.js';

describe('Limiter', () => {
  it('allows max hits per window per key, then says how long to wait', () => {
    const l = new Limiter({ max: 3, windowMs: 10_000 });
    expect([l.hit('a', 0), l.hit('a', 1), l.hit('a', 2)]).toEqual([0, 0, 0]);
    expect(l.hit('a', 3000)).toBe(7000);
    expect(l.hit('a', 9999)).toBe(1);
    expect(l.hit('a', 10_000)).toBe(0); // the window reopened
    expect(l.hit('a', 10_001)).toBe(0);
  });

  it('keys are independent', () => {
    const l = new Limiter({ max: 1, windowMs: 1000 });
    expect(l.hit('a', 0)).toBe(0);
    expect(l.hit('b', 0)).toBe(0);
    expect(l.hit('a', 1)).toBeGreaterThan(0);
    expect(l.hit('b', 1)).toBeGreaterThan(0);
  });

  it('never holds more than MAX_LIMITER_KEYS keys: the oldest live key goes', () => {
    expect(MAX_LIMITER_KEYS).toBe(10_000);
    const l = new Limiter({ max: 1, windowMs: 1_000_000 });
    for (let i = 0; i < MAX_LIMITER_KEYS + 50; i += 1) l.hit(`k${i}`, i);
    // the very first keys were evicted, so they start fresh; a recent one is still limited
    expect(l.hit('k0', MAX_LIMITER_KEYS + 100)).toBe(0);
    expect(l.hit(`k${MAX_LIMITER_KEYS + 49}`, MAX_LIMITER_KEYS + 101)).toBeGreaterThan(0);
  });

  it('expired windows are swept', () => {
    const l = new Limiter({ max: 1, windowMs: 100 });
    for (let i = 0; i < 500; i += 1) l.hit(`k${i}`, 0);
    l.hit('later', 1000);
    expect(l.hit('k3', 1001)).toBe(0);
  });
});

describe('checkLimit', () => {
  it('returns the fallback for undefined and a copy of a valid limit', () => {
    const fallback = { max: 5, windowMs: 1000 };
    expect(checkLimit(undefined, fallback, 'x')).toBe(fallback);
    const given = { max: 2, windowMs: 50 };
    const out = checkLimit(given, fallback, 'x');
    expect(out).toEqual(given);
    expect(out).not.toBe(given);
  });

  it('refuses anything that is not a positive whole max and windowMs, naming the option and never the value', () => {
    const bad: unknown[] = [null, 5, 'vlemmo', [], {}, { max: 0, windowMs: 1 }, { max: 1, windowMs: 0 }, { max: 1.5, windowMs: 10 }, { max: 1, windowMs: Number.NaN }, { max: '3', windowMs: 10 }, { max: 1 }, { windowMs: 1 }, { max: Infinity, windowMs: 1 }];
    for (const value of bad) {
      let message = '';
      try {
        checkLimit(value, { max: 1, windowMs: 1 }, 'chatRoutes: actionRateLimit');
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
        message = (err as Error).message;
      }
      expect(message).toBe('chatRoutes: actionRateLimit needs a positive whole max and windowMs');
    }
  });
});

describe('the limiter is browser-safe', () => {
  it('imports nothing', () => {
    const text = readFileSync(new URL('../src/limiter.ts', import.meta.url), 'utf8').replaceAll(/\/\/.*$/gm, '').replaceAll(/\/\*[\s\S]*?\*\//g, '');
    expect(text).not.toMatch(/^\s*import\b/m);
    expect(text).not.toMatch(/node:/);
  });
});
