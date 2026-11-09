import { describe, expect, it } from 'vitest';
import { slidingWindow } from '../src/rateLimit.js';

function setup(limit = 3, windowMs = 5000) {
  const clock = { t: 1_000_000, now: () => clock.t };
  return { clock, limiter: slidingWindow({ limit, windowMs, clock }) };
}

describe('slidingWindow', () => {
  it('admits `limit` hits then refuses the next', () => {
    const { limiter } = setup();
    expect([1, 2, 3].map(() => limiter.check('k'))).toEqual([true, true, true]);
    expect(limiter.check('k')).toBe(false);
  });

  it('a refused hit is not recorded (it does not extend the lock-out)', () => {
    const { clock, limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.check('k');
    clock.t += 4999;
    expect(limiter.check('k')).toBe(false);
    clock.t += 1; // exactly windowMs after the first three
    expect(limiter.check('k')).toBe(true);
  });

  it('a hit exactly windowMs old has left the window; one ms younger has not', () => {
    const { clock, limiter } = setup(1, 5000);
    expect(limiter.check('k')).toBe(true);
    clock.t += 4999;
    expect(limiter.check('k')).toBe(false);
    clock.t += 1;
    expect(limiter.check('k')).toBe(true);
  });

  it('slides: old hits fall out one at a time', () => {
    const { clock, limiter } = setup(3, 5000);
    limiter.check('k'); // t0
    clock.t += 2000;
    limiter.check('k'); // t0+2000
    limiter.check('k'); // t0+2000
    expect(limiter.check('k')).toBe(false);
    clock.t += 3000; // t0+5000: only the first has left
    expect(limiter.check('k')).toBe(true);
    expect(limiter.check('k')).toBe(false);
  });

  it('keys are independent', () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.check('a');
    expect(limiter.check('a')).toBe(false);
    expect(limiter.check('b')).toBe(true);
  });

  it('forgets keys that went quiet, so memory stays bounded under churn', () => {
    const { clock, limiter } = setup();
    for (let i = 0; i < 5000; i++) {
      limiter.check(`k${i}`);
      clock.t += 100;
    }
    // Only keys active inside the window (50 of them) plus a bounded sweep backlog may remain.
    expect(limiter.size()).toBeLessThan(500);
  });

  it('a swept key starts fresh', () => {
    const { clock, limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.check('old');
    clock.t += 10_000;
    for (let i = 0; i < 1000; i++) limiter.check(`n${i}`);
    expect(limiter.check('old')).toBe(true);
  });
});
