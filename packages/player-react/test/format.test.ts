import { describe, expect, it } from 'vitest';
import { dayText, timeLeft, untilText } from '../src/format.js';
import { DAY, HOUR, MINUTE, T0 } from './world.js';

describe('dayText', () => {
  it('writes a UTC day as the locale writes a date, in UTC whatever the viewer time zone', () => {
    expect(dayText('2027-01-15', 'en')).toBe('Jan 15, 2027');
    expect(dayText('2027-01-01', 'en')).toBe('Jan 1, 2027');
    expect(dayText('2027-12-31', 'en')).toBe('Dec 31, 2027');
  });
  it('follows the locale', () => {
    expect(dayText('2027-01-15', 'de')).toBe('15.01.2027');
  });
  it('gives a value that is not a day back as it came, never "Invalid Date"', () => {
    for (const bad of ['', 'soon', '2027-13-45', '2027-1-5', '<b>x</b>']) expect(dayText(bad, 'en')).toBe(bad);
  });
  it('survives a locale the runtime does not know', () => {
    expect(dayText('2027-01-15', 'not a locale')).toBe('Jan 15, 2027');
  });
});

describe('untilText', () => {
  const at = Date.UTC(2027, 0, 15, 20, 30);
  it('writes a date and time in the locale and the given zone', () => {
    expect(untilText(at, 'en', 'UTC')).toBe('Jan 15, 2027, 8:30 PM');
    expect(untilText(at, 'en', 'America/New_York')).toBe('Jan 15, 2027, 3:30 PM');
    expect(untilText(at, 'de', 'UTC')).toMatch(/15\.01\.2027/);
  });
  it('survives a locale the runtime does not know and a zone it does not know', () => {
    expect(untilText(at, 'not a locale', 'UTC')).toBe('Jan 15, 2027, 8:30 PM');
    expect(() => untilText(at, 'en', 'Not/AZone')).not.toThrow();
  });
});

describe('timeLeft', () => {
  const now = T0;
  it('says how long is left in the largest whole unit: minutes, hours, days', () => {
    expect(timeLeft(now + 5 * MINUTE, now, 'en')).toBe('in 5 minutes');
    expect(timeLeft(now + 90 * MINUTE, now, 'en')).toBe('in 2 hours');
    expect(timeLeft(now + 3 * HOUR, now, 'en')).toBe('in 3 hours');
    expect(timeLeft(now + 2 * DAY, now, 'en')).toBe('in 2 days');
    expect(timeLeft(now + 40 * DAY, now, 'en')).toBe('in 40 days');
  });
  it('rounds a part of a minute up to a minute, so a live restriction never reads "in 0 minutes"', () => {
    expect(timeLeft(now + 1000, now, 'en')).toBe('in 1 minute');
    expect(timeLeft(now + 59_000, now, 'en')).toBe('in 1 minute');
  });
  it('says nothing for a time that has passed (or is now)', () => {
    expect(timeLeft(now, now, 'en')).toBeNull();
    expect(timeLeft(now - 1, now, 'en')).toBeNull();
    expect(timeLeft(now - DAY, now, 'en')).toBeNull();
  });
  it('follows the locale', () => {
    expect(timeLeft(now + 2 * DAY, now, 'de')).toBe('in 2 Tagen');
  });
});
