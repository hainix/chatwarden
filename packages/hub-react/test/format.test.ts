import { describe, expect, it } from 'vitest';
import { absoluteTime, formatDuration, personTag, relativeTime, waitTone } from '../src/format.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('personTag', () => {
  it('is the first 8 characters of a ref, never more', () => {
    expect(personTag('abcdefghijklmnop')).toBe('abcdefgh');
    expect(personTag('abcdefgh')).toBe('abcdefgh');
    expect(personTag('abc')).toBe('abc');
    expect(personTag('')).toBe('');
  });
  it('cuts a long canonical id however it is written', () => {
    expect(personTag('a'.repeat(64))).toHaveLength(8);
    expect(personTag('sub_0123456789abcdef').length).toBeLessThanOrEqual(8);
  });
  it('counts characters, not UTF-16 halves', () => {
    expect(Array.from(personTag('😀😀😀😀😀😀😀😀😀😀')).length).toBe(8);
  });
});

describe('relativeTime', () => {
  it('says "now" inside a minute and uses the largest unit after that', () => {
    expect(relativeTime(NOW - 20_000, NOW, 'en')).toBe('now');
    expect(relativeTime(NOW - 5 * MIN, NOW, 'en')).toBe('5 minutes ago');
    expect(relativeTime(NOW - 90 * MIN, NOW, 'en')).toBe('2 hours ago');
    expect(relativeTime(NOW - 3 * DAY, NOW, 'en')).toBe('3 days ago');
  });
  it('never reads clock skew as the future', () => {
    expect(relativeTime(NOW + 10 * MIN, NOW, 'en')).toBe('now');
  });
  it('follows the locale', () => {
    expect(relativeTime(NOW - 5 * MIN, NOW, 'de')).toBe('vor 5 Minuten');
  });
  it('survives an unknown locale', () => {
    expect(relativeTime(NOW - 5 * MIN, NOW, 'not a locale')).toMatch(/5/);
  });
});

describe('absoluteTime', () => {
  it('is a readable date and time in the locale', () => {
    const text = absoluteTime(NOW, 'en', 'UTC');
    expect(text).toMatch(/2027/);
    expect(text).toMatch(/:/);
  });
});

describe('formatDuration', () => {
  it('uses the largest whole unit up to days', () => {
    expect(formatDuration(30_000, 'en')).toBe('<1m');
    expect(formatDuration(5 * MIN, 'en')).toBe('5m');
    expect(formatDuration(59 * MIN + 59_000, 'en')).toBe('59m');
    expect(formatDuration(2 * HOUR + 14 * MIN, 'en')).toBe('2h');
    expect(formatDuration(47 * HOUR, 'en')).toBe('47h');
    expect(formatDuration(3 * DAY, 'en')).toBe('3d');
  });
  it('clamps a negative wait to under a minute', () => {
    expect(formatDuration(-5 * MIN, 'en')).toBe('<1m');
  });
});

describe('waitTone', () => {
  it('is fresh under an hour, aging under a day, stale after', () => {
    expect(waitTone(0)).toBe('fresh');
    expect(waitTone(59 * MIN)).toBe('fresh');
    expect(waitTone(HOUR)).toBe('aging');
    expect(waitTone(23 * HOUR)).toBe('aging');
    expect(waitTone(DAY)).toBe('stale');
    expect(waitTone(10 * DAY)).toBe('stale');
    expect(waitTone(-1)).toBe('fresh');
  });
});
