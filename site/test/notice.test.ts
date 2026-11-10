// The words the demo uses for what the real kit says. Every kind, reason and refusal has its own wording, never a default.
import { describe, expect, it } from 'vitest';
import type { PlayerNotice, RefuseReason, ReportRefusal, Suggestion } from '../src/demo/engine';
import { DEFAULT_TIMEOUT_MS, durationWords, noticeEnd, noticeKindLabel, refusalMessage, reportRefusalMessage, shortDuration, timeoutMs } from '../src/demo/notice';

const at = (ms: number) => `T${ms}`;
const rule = (n: number) => `Community Rule ${n}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('noticeKindLabel', () => {
  const kinds: Array<[PlayerNotice['kind'] | 'note', string]> = [
    ['warning', 'Warning'],
    ['chat', 'Chat timeout'],
    ['area', 'Ban from public rooms'],
    ['ban', 'Full ban'],
    ['report_outcome', 'Action taken on your report'],
    ['note', 'Note'],
  ];
  it.each(kinds)('%s is named %s', (kind, label) => expect(noticeKindLabel(kind)).toBe(label));
  it('only a warning is called a Warning (never the default for an unknown kind)', () => {
    expect(kinds.filter(([, l]) => l === 'Warning')).toHaveLength(1);
    expect(() => noticeKindLabel('mystery' as never)).toThrow(/unhandled/);
  });
});

describe('durations', () => {
  it.each([
    [10 * MIN, '10 minutes', '10m'],
    [MIN, '1 minute', '1m'],
    [30 * MIN, '30 minutes', '30m'],
    [90 * MIN, '90 minutes', '90m'],
    [HOUR, '1 hour', '1h'],
    [6 * HOUR, '6 hours', '6h'],
    [DAY, '24 hours', '24h'],
    [7 * DAY, '7 days', '7d'],
    [30 * DAY, '30 days', '30d'],
    [20_000, '1 minute', '1m'],
    [7 * DAY + 3, '7 days', '7d'], // a notice is stamped a few ms after its timeout starts
    [30 * MIN - 2, '30 minutes', '30m'],
    [DAY - 1, '24 hours', '24h'],
    [2 * DAY, '2 days', '2d'],
    [47 * HOUR, '47 hours', '47h'],
  ])('%i ms is %s, short %s', (ms, words, short) => {
    expect(durationWords(ms)).toBe(words);
    expect(shortDuration(ms)).toBe(short);
  });
});

describe('timeoutMs: the Timeout button follows a chat suggestion', () => {
  const sug = (outcome: Suggestion['outcome']): Suggestion => ({ outcome, label: 'x', why: 'y', rule: 2 });
  it('uses the suggested length for a chat timeout', () => {
    expect(timeoutMs(sug({ kind: 'chat', durationMs: DAY }))).toBe(DAY);
    expect(timeoutMs(sug({ kind: 'chat', durationMs: 7 * DAY }))).toBe(7 * DAY);
  });
  it('is ten minutes for everything else', () => {
    for (const o of ['none', 'note', 'warning'] as const) expect(timeoutMs(sug(o))).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutMs(sug({ kind: 'area', durationMs: DAY }))).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutMs(sug({ kind: 'ban', durationMs: null }))).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutMs(sug({ kind: 'chat', durationMs: null }))).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutMs(null)).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe('noticeEnd', () => {
  const n = (kind: PlayerNotice['kind'], until: number | null, createdAt = 1_000) => ({ kind, until, createdAt });
  it('says how long a chat timeout lasts and when it ends', () => {
    expect(noticeEnd(n('chat', 1_000 + 30 * MIN), at)).toBe(`Chat is paused for 30 minutes, until T${1_000 + 30 * MIN}.`);
    expect(noticeEnd(n('chat', 1_000 + DAY), at)).toMatch(/^Chat is paused for 24 hours, until /);
  });
  it('names an area ban and a full ban truthfully', () => {
    expect(noticeEnd(n('area', 1_000 + 7 * DAY), at)).toMatch(/^Banned from public rooms for 7 days, until /);
    expect(noticeEnd(n('ban', 1_000 + 7 * DAY), at)).toMatch(/^Banned from the game for 7 days, until /);
    expect(noticeEnd(n('ban', null), at)).toBe('Banned from the game with no end date.');
  });
  it('has nothing to say for a warning or a report outcome', () => {
    expect(noticeEnd(n('warning', null), at)).toBe('');
    expect(noticeEnd(n('report_outcome', null), at)).toBe('');
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

describe('reportRefusalMessage covers every ReportRefusal, suspended included', () => {
  const all: ReportRefusal[] = ['off', 'not_player', 'self', 'suspended', 'rate', 'duplicate'];
  it.each(all)('%s has a real message', (why) => {
    const m = reportRefusalMessage(why, 'Bo');
    expect(m.length).toBeGreaterThan(10);
    expect(m).not.toMatch(/undefined|not filed/i);
  });
  it('are all different', () => {
    expect(new Set(all.map((w) => reportRefusalMessage(w, 'Bo'))).size).toBe(all.length);
  });
  it('suspended says why, and a duplicate names who', () => {
    expect(reportRefusalMessage('suspended', 'Bo')).toMatch(/paused.*bad faith/i);
    expect(reportRefusalMessage('duplicate', 'Bo')).toBe('You already reported Bo in this lobby.');
    expect(reportRefusalMessage('rate', 'Bo')).toBe('You are out of reports for today.');
  });
  it('an unknown refusal fails loudly', () => {
    expect(() => reportRefusalMessage('mystery' as never, 'Bo')).toThrow(/unhandled/);
  });
});
