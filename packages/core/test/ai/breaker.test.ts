import { describe, expect, it } from 'vitest';
import { Breaker, BREAKER_OPEN_MS, BREAKER_THRESHOLD } from '../../src/ai/breaker.js';

const clockAt = (t = 1_000_000) => {
  const c = { t, now: () => c.t };
  return c;
};

describe('the breaker', () => {
  it('starts closed and lets calls through', () => {
    const b = new Breaker(clockAt());
    expect(b.state()).toBe('closed');
    expect(b.gate()).toBe('go');
    expect(b.reopensAt()).toBeNull();
  });

  it('four failures leave it closed, the fifth opens it for five minutes', () => {
    const c = clockAt();
    const b = new Breaker(c);
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i += 1) b.failure();
    expect(b.state()).toBe('closed');
    b.failure();
    expect(b.state()).toBe('open');
    expect(b.reopensAt()).toBe(c.t + BREAKER_OPEN_MS);
    expect(b.gate()).toBe('no');
  });

  it('a success in between resets the count', () => {
    const b = new Breaker(clockAt());
    for (let i = 0; i < 4; i += 1) b.failure();
    b.success();
    for (let i = 0; i < 4; i += 1) b.failure();
    expect(b.state()).toBe('closed');
  });

  it('a fatal failure opens it at once', () => {
    const b = new Breaker(clockAt());
    b.failure(true);
    expect(b.state()).toBe('open');
    expect(b.gate()).toBe('no');
  });

  it('after five minutes exactly one probe is let through; the others are refused', () => {
    const c = clockAt();
    const b = new Breaker(c);
    b.failure(true);
    c.t += BREAKER_OPEN_MS - 1;
    expect(b.gate()).toBe('no');
    c.t += 1;
    expect(b.state()).toBe('half_open');
    expect(b.gate()).toBe('probe');
    expect(b.gate()).toBe('no');
    expect(b.gate()).toBe('no');
  });

  it('a successful probe closes it', () => {
    const c = clockAt();
    const b = new Breaker(c);
    b.failure(true);
    c.t += BREAKER_OPEN_MS;
    expect(b.gate()).toBe('probe');
    b.success();
    expect(b.state()).toBe('closed');
    expect(b.gate()).toBe('go');
  });

  it('a failed probe opens it for another five minutes, after one failure rather than five', () => {
    const c = clockAt();
    const b = new Breaker(c);
    b.failure(true);
    c.t += BREAKER_OPEN_MS;
    expect(b.gate()).toBe('probe');
    b.failure();
    expect(b.state()).toBe('open');
    expect(b.reopensAt()).toBe(c.t + BREAKER_OPEN_MS);
    expect(b.gate()).toBe('no');
  });

  it('a released probe lets the next ask be the probe', () => {
    const c = clockAt();
    const b = new Breaker(c);
    b.failure(true);
    c.t += BREAKER_OPEN_MS;
    expect(b.gate()).toBe('probe');
    b.release();
    expect(b.gate()).toBe('probe');
  });

  it('available says whether a call could go out, and takes nothing', () => {
    const c = clockAt();
    const b = new Breaker(c);
    expect(b.available()).toBe(true);
    b.failure(true);
    expect(b.available()).toBe(false);
    c.t += BREAKER_OPEN_MS;
    // Half-open with the probe free: yes, and asking again changes nothing.
    expect(b.available()).toBe(true);
    expect(b.available()).toBe(true);
    expect(b.gate()).toBe('probe');
    // The probe is out: no one else may go.
    expect(b.available()).toBe(false);
    b.release();
    expect(b.available()).toBe(true);
    b.success();
    expect(b.available()).toBe(true);
  });
});
