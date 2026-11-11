// The words the demo uses for what the real kit says in the chat. Every refusal has its own wording, never a default. (Notices and
// the report dialog are player-react's words, and the moderator's are the hub's.)
import { describe, expect, it } from 'vitest';
import type { RefuseReason } from '../src/demo/engine';
import { durationWords, formatUntil, quietNote, refusalMessage } from '../src/demo/notice';

const at = (ms: number) => `T${ms}`;
const rule = (n: number) => `Community Rule ${n}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('durations', () => {
  it.each([
    [10 * MIN, '10 minutes'],
    [MIN, '1 minute'],
    [30 * MIN, '30 minutes'],
    [90 * MIN, '90 minutes'],
    [HOUR, '1 hour'],
    [6 * HOUR, '6 hours'],
    [DAY, '24 hours'],
    [7 * DAY, '7 days'],
    [30 * DAY, '30 days'],
    [20_000, '1 minute'],
    [7 * DAY + 3, '7 days'], // a notice is stamped a few ms after its timeout starts
    [30 * MIN - 2, '30 minutes'],
    [DAY - 1, '24 hours'],
    [2 * DAY, '2 days'],
    [47 * HOUR, '47 hours'],
  ])('%i ms is %s', (ms, words) => {
    expect(durationWords(ms)).toBe(words);
  });
});

describe('refusalMessage covers every RefuseReason', () => {
  const reasons: RefuseReason[] = ['empty', 'length', 'rate', 'gate', 'restricted', 'blocked', 'profanity'];
  it.each(reasons)('%s has a real message', (reason) => {
    const m = refusalMessage({ reason, until: 5_000, byModerator: true, rule: 2 }, 200, at, rule);
    expect(m.length).toBeGreaterThan(10);
    expect(m).not.toMatch(/undefined|not sent/i);
  });
  it('each reason says something different', () => {
    const all = reasons.map((reason) => refusalMessage({ reason, until: 5_000 }, 200, at, rule));
    expect(new Set(all).size).toBe(reasons.length);
  });
  it('rate states the real limit, length the real cap', () => {
    expect(refusalMessage({ reason: 'rate' }, 200, at, rule)).toMatch(/three lines every five seconds/i);
    expect(refusalMessage({ reason: 'length' }, 200, at, rule)).toMatch(/200 characters/);
  });
  it('gate and profanity are their own sentences', () => {
    expect(refusalMessage({ reason: 'gate' }, 200, at, rule)).toMatch(/cannot chat in this lobby/i);
    expect(refusalMessage({ reason: 'profanity' }, 200, at, rule)).toMatch(/language this lobby does not allow/i);
  });
  it('a timeout shows its end time, the rule and Reset as the way out; a moderator and the filter are told apart', () => {
    const mod = refusalMessage({ reason: 'restricted', until: 9_000, byModerator: true, rule: 2 }, 200, at, rule);
    expect(mod).toBe('A moderator has put you on a chat timeout until T9000 (Community Rule 2). Press Reset demo to start over.');
    const auto = refusalMessage({ reason: 'restricted', until: 9_000, byModerator: false, rule: 1 }, 200, at, rule);
    expect(auto).toMatch(/^The automatic filter has put you on a chat timeout until T9000 \(Community Rule 1\)/);
    expect(auto).toMatch(/Reset demo/);
    expect(refusalMessage({ reason: 'restricted', until: 9_000 }, 200, at, rule)).toMatch(/^The automatic filter/);
  });
  it('a restriction with no end is a ban, and a missing rule is simply left out', () => {
    expect(refusalMessage({ reason: 'restricted', until: null, byModerator: true }, 200, at, rule)).toBe(
      'A moderator has banned you from chat. Press Reset demo to start over.',
    );
  });
  it('an unknown reason fails loudly instead of saying something false', () => {
    expect(() => refusalMessage({ reason: 'mystery' as never }, 200, at, rule)).toThrow(/unhandled/);
  });
});

describe('formatUntil: one clock for every end time', () => {
  const tm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const wd = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: 'short' });
  const md = (ms: number) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const now = new Date(2026, 10, 10, 9, 0, 0).getTime(); // Tue 10 Nov, 09:00 local
  const H = 3_600_000;

  it('a 10 minute timeout is just the time', () => {
    expect(formatUntil(now + 10 * MIN, now)).toBe(tm(now + 10 * MIN));
  });
  it('up to 12 hours away on the same day is still just the time', () => {
    expect(formatUntil(now + 11 * H, now)).toBe(tm(now + 11 * H)); // 20:00 the same day
  });
  it('more than 12 hours away says the weekday, even on the same day', () => {
    const end = now + 13 * H; // 22:00 the same day
    expect(formatUntil(end, now)).toBe(`${wd(end)} ${tm(end)}`);
  });
  it('another calendar day says the weekday, even when close', () => {
    const late = new Date(2026, 10, 10, 23, 55, 0).getTime();
    const end = late + 10 * MIN; // 00:05 the next day
    expect(formatUntil(end, late)).toBe(`${wd(end)} ${tm(end)}`);
  });
  it('24 hours reads as tomorrow by weekday, never as "now"', () => {
    const end = now + 24 * H;
    expect(formatUntil(end, now)).toBe(`${wd(end)} ${tm(end)}`);
    expect(wd(end)).not.toBe(wd(now));
  });
  it('5 days 23 hours is a weekday; 7 days is a date (the weekday would repeat today)', () => {
    const near = now + 5 * 24 * H + 23 * H;
    expect(formatUntil(near, now)).toBe(`${wd(near)} ${tm(near)}`);
    const week = now + 7 * 24 * H;
    expect(formatUntil(week, now)).toBe(`${md(week)}, ${tm(week)}`);
    expect(formatUntil(week, now)).toContain('17');
  });
  it('is used by the refusal message', () => {
    const at = (ms: number) => formatUntil(ms, now);
    const end = now + 7 * 24 * H;
    expect(refusalMessage({ reason: 'restricted', until: end, byModerator: true }, 200, at, rule)).toContain(`until ${md(end)}, ${tm(end)}`);
  });
});

describe('quietNote: why a timed out scripted player goes silent', () => {
  it('names the player, the real length and Reset, for a long timeout', () => {
    expect(quietNote('Bo', 7 * DAY, 'he')).toBe('Bo is timed out for 7 days, so he stays quiet. Press Reset demo to replay.');
    expect(quietNote('Ada', 24 * HOUR, 'she')).toBe('Ada is timed out for 24 hours, so she stays quiet. Press Reset demo to replay.');
    expect(quietNote('Bo', 30 * MIN, 'he')).toMatch(/^Bo is timed out for 30 minutes/);
  });
  it('says nothing for a few minutes or less', () => {
    expect(quietNote('Bo', 5 * MIN, 'he')).toBeNull();
    expect(quietNote('Bo', MIN, 'he')).toBeNull();
    expect(quietNote('Bo', 6 * MIN, 'he')).not.toBeNull();
  });
});
