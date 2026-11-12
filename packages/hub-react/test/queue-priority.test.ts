import type { ReportSummary } from '@chatwarden/http/admin';
import { describe, expect, it } from 'vitest';
import { priorityScore, RANK_WEIGHTS } from '../src/ai/rank.js';
import { groupQueue } from '../src/queue.js';
import type { QueueGroup, RankSignals } from '../src/queue.js';
import type { AiBrief } from '../src/types.js';

// The `priority` sort: wait + volume + ai + reporter (design section 9). A weight, never a filter. Every row of the design's table is
// one test here, with the variants around it.

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

let seq = 0;
function report(over: Partial<ReportSummary> = {}): ReportSummary {
  seq += 1;
  return {
    id: over.id ?? `r${String(seq).padStart(4, '0')}`,
    createdAt: NOW,
    roomId: 'room-a',
    tags: {},
    category: 'harassment',
    reportedReason: 'harassment',
    reportedReasonLabel: 'Insults or harassment',
    status: 'open',
    badFaith: false,
    targetPerson: 'person-a',
    reporterPerson: 'rep-1',
    actionedAt: null,
    actionedBy: null,
    targetHandle: null,
    reporterHandle: null,
    claim: null,
    viewing: [],
    ...over,
  };
}

const brief = (severity: AiBrief['severity'], confidence: AiBrief['confidence'], over: Partial<AiBrief> = {}): AiBrief => ({
  severity,
  confidence,
  rule: 1,
  stale: false,
  injectionSuspected: false,
  hasRecommendation: false,
  ...over,
});

/** One open report about `person`, waiting `waitedMs`, with an AI brief (or none). */
const row = (person: string, waitedMs: number, ai: AiBrief | null | undefined, over: Partial<ReportSummary> = {}): ReportSummary =>
  report({ targetPerson: person, createdAt: NOW - waitedMs, ...(ai === undefined ? {} : { ai }), ...over });

const order = (items: ReportSummary[], signals?: RankSignals): string[] =>
  groupQueue(items, { sort: 'priority', now: NOW, ...(signals === undefined ? {} : { signals }) }).map((g) => g.person);

const score = (items: ReportSummary[], person: string, signals = {}): number => {
  const g = groupQueue(items, { sort: 'latest', now: NOW }).find((x) => x.person === person) as QueueGroup;
  return priorityScore(g, NOW, signals);
};

describe('the weights', () => {
  it('are a frozen object with the design values', () => {
    expect(Object.isFrozen(RANK_WEIGHTS)).toBe(true);
    expect(RANK_WEIGHTS.severity).toEqual({ banter: 0, rude: 1, hostile: 2.5, severe: 5 });
    expect(RANK_WEIGHTS.confidence).toEqual({ low: 0.4, medium: 0.7, high: 1 });
    expect(RANK_WEIGHTS.neutral).toBe(1.2);
    expect(RANK_WEIGHTS.stale).toBe(0.7);
    expect(RANK_WEIGHTS.waitMax).toBe(2);
    expect(RANK_WEIGHTS.waitHours).toBe(24);
    expect(RANK_WEIGHTS.volumeMax).toBe(0.5);
    expect(RANK_WEIGHTS.reporterClamp).toBe(0.5);
  });

  it('are deeply frozen: nobody can bend a table at run time', () => {
    expect(Object.isFrozen(RANK_WEIGHTS.severity)).toBe(true);
    expect(Object.isFrozen(RANK_WEIGHTS.confidence)).toBe(true);
    expect(() => {
      (RANK_WEIGHTS.severity as Record<string, number>).severe = 0;
    }).toThrow();
  });
});

describe('the score table', () => {
  it('banter high confidence ranks below an unread fresh case', () => {
    const items = [row('banter', 0, brief('banter', 'high')), row('unread', 0, null)];
    expect(order(items)).toEqual(['unread', 'banter']);
    expect(score(items, 'banter')).toBe(0);
    expect(score(items, 'unread')).toBe(1.2);
  });

  it('severe low confidence ranks above an unread fresh case', () => {
    const items = [row('unread', 0, null), row('severe', 0, brief('severe', 'low'))];
    expect(order(items)).toEqual(['severe', 'unread']);
    expect(score(items, 'severe')).toBeCloseTo(2, 10);
  });

  it('severe high beats hostile high', () => {
    const items = [row('hostile', 0, brief('hostile', 'high')), row('severe', 0, brief('severe', 'high'))];
    expect(order(items)).toEqual(['severe', 'hostile']);
    expect(score(items, 'severe')).toBe(5);
    expect(score(items, 'hostile')).toBe(2.5);
  });

  it('hostile high does not outrank an unread case by much, rude low sits below it', () => {
    const items = [row('rude', 0, brief('rude', 'low')), row('unread', 0, null), row('hostile', 0, brief('hostile', 'high'))];
    expect(order(items)).toEqual(['hostile', 'unread', 'rude']);
  });

  it('a 24 hour old banter outranks a fresh unread case', () => {
    const items = [row('unread', 0, null), row('old-banter', 24 * HOUR, brief('banter', 'high'))];
    expect(order(items)).toEqual(['old-banter', 'unread']);
    expect(score(items, 'old-banter')).toBe(2);
  });

  it('the wait term stops at 24 hours: a week old banter scores the same as a day old one', () => {
    const items = [row('day', 24 * HOUR, brief('banter', 'high')), row('week', 168 * HOUR, brief('banter', 'high'))];
    expect(score(items, 'day')).toBe(score(items, 'week'));
  });

  it('wait never reorders two reads of equal weight except by age', () => {
    const items = [
      row('young', 1 * HOUR, brief('hostile', 'medium')),
      row('older', 5 * HOUR, brief('hostile', 'medium')),
      row('oldest', 9 * HOUR, brief('hostile', 'medium')),
    ];
    expect(order(items)).toEqual(['oldest', 'older', 'young']);
    // And the same without the wait: tied, so the person ref decides.
    const tied = [row('b', 0, brief('rude', 'high')), row('a', 0, brief('rude', 'high'))];
    expect(order(tied)).toEqual(['a', 'b']);
  });

  it('stale weighs 0.7', () => {
    const items = [row('fresh', 0, brief('hostile', 'high')), row('stale', 0, brief('hostile', 'high', { stale: true }))];
    expect(score(items, 'fresh')).toBe(2.5);
    expect(score(items, 'stale')).toBeCloseTo(1.75, 10);
    expect(order(items)).toEqual(['fresh', 'stale']);
  });

  it('injection suspected cannot lower a case', () => {
    // A banter read that a line tried to instruct is raised to the neutral weight, never below it.
    const flagged = [row('flag', 0, brief('banter', 'high', { injectionSuspected: true })), row('plain', 0, brief('banter', 'high'))];
    expect(score(flagged, 'flag')).toBe(1.2);
    expect(score(flagged, 'plain')).toBe(0);
    // A severe read stays severe: the flag raises at most.
    const severe = [row('sev', 0, brief('severe', 'high', { injectionSuspected: true }))];
    expect(score(severe, 'sev')).toBe(5);
    // A stale low read that is flagged: the larger of the two.
    const stale = [row('s', 0, brief('rude', 'low', { stale: true, injectionSuspected: true }))];
    expect(score(stale, 's')).toBe(1.2);
  });

  it('the worst read among a person\'s reports is used', () => {
    const items = [
      row('mixed', 0, brief('banter', 'high'), { createdAt: NOW - 3 * MIN }),
      row('mixed', 0, brief('severe', 'high'), { createdAt: NOW - 2 * MIN }),
      row('mixed', 0, brief('rude', 'high'), { createdAt: NOW - 1 * MIN }),
      row('solo', 0, brief('hostile', 'high')),
    ];
    const g = groupQueue(items, { sort: 'priority', now: NOW }).find((x) => x.person === 'mixed') as QueueGroup;
    expect(g.ai).toMatchObject({ severity: 'severe', confidence: 'high' });
    expect(order(items)[0]).toBe('mixed');
  });

  it('a person with an unread report and a banter read is not sunk below an unread case', () => {
    const items = [row('half', 0, brief('banter', 'high'), { createdAt: NOW - 1 }), row('half', 0, null, { createdAt: NOW - 2 }), row('unread', 0, null)];
    const g = groupQueue(items, { sort: 'priority', now: NOW }).find((x) => x.person === 'half') as QueueGroup;
    // The chip shows the one read there is.
    expect(g.ai).toMatchObject({ severity: 'banter' });
    // But the unread report keeps the person at the neutral weight (volume adds a little for the second report).
    expect(priorityScore(g, NOW, {})).toBeGreaterThanOrEqual(1.2);
  });

  it('volume adds up to half a point for four extra open reports', () => {
    const base = [row('x', 0, null)];
    const five = [0, 1, 2, 3, 4].map((i) => row('y', 0, null, { reporterPerson: `r${i}` }));
    const nine = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => row('z', 0, null, { reporterPerson: `r${i}` }));
    expect(score(base, 'x')).toBe(1.2);
    expect(score(five, 'y')).toBeCloseTo(1.7, 10);
    expect(score(nine, 'z')).toBeCloseTo(1.7, 10);
  });

  it('decided reports weigh nothing: only open ones count for the read and the volume', () => {
    const items = [row('p', 0, brief('severe', 'high'), { status: 'actioned' }), row('p', 0, null)];
    const g = groupQueue(items, { sort: 'priority', now: NOW })[0] as QueueGroup;
    expect(g.ai).toBeNull();
    expect(priorityScore(g, NOW, {})).toBe(1.2);
  });
});

describe('the reporter seam', () => {
  const items = (): ReportSummary[] => [row('a', 0, brief('rude', 'high')), row('b', 0, brief('rude', 'high'))];

  it('the reporter signal is clamped to plus or minus 0.5', () => {
    const [a] = groupQueue(items(), { sort: 'latest', now: NOW }) as [QueueGroup];
    expect(priorityScore(a, NOW, { reporter: () => 9 })).toBeCloseTo(1.5, 10);
    expect(priorityScore(a, NOW, { reporter: () => -9 })).toBeCloseTo(0.5, 10);
    expect(priorityScore(a, NOW, { reporter: () => 0.25 })).toBeCloseTo(1.25, 10);
    expect(priorityScore(a, NOW, { reporter: () => -0.25 })).toBeCloseTo(0.75, 10);
  });

  it('it can reorder a close call but never overrides severity by more than half a point', () => {
    const close = [row('rude-trusted', 0, brief('rude', 'high')), row('rude-habitual', 0, brief('rude', 'high'))];
    const signal = (g: QueueGroup): number => (g.person === 'rude-habitual' ? -0.5 : 0.5);
    expect(order(close, { reporter: signal })).toEqual(['rude-trusted', 'rude-habitual']);
    const far = [row('banter-trusted', 0, brief('rude', 'low')), row('hostile-habitual', 0, brief('hostile', 'high'))];
    const s2 = (g: QueueGroup): number => (g.person === 'hostile-habitual' ? -100 : 100);
    expect(order(far, { reporter: s2 })).toEqual(['hostile-habitual', 'banter-trusted']);
  });

  it('a signal that returns NaN or Infinity is ignored', () => {
    const [a] = groupQueue(items(), { sort: 'latest', now: NOW }) as [QueueGroup];
    const base = priorityScore(a, NOW, {});
    expect(priorityScore(a, NOW, { reporter: () => NaN })).toBe(base);
    expect(priorityScore(a, NOW, { reporter: () => Infinity })).toBe(base);
    expect(priorityScore(a, NOW, { reporter: () => -Infinity })).toBe(base);
  });

  it('a signal that throws or returns something that is not a number is ignored', () => {
    const [a] = groupQueue(items(), { sort: 'latest', now: NOW }) as [QueueGroup];
    const base = priorityScore(a, NOW, {});
    expect(priorityScore(a, NOW, { reporter: () => { throw new Error('boom'); } })).toBe(base);
    expect(priorityScore(a, NOW, { reporter: (() => '0.4') as unknown as () => number })).toBe(base);
    expect(priorityScore(a, NOW, { reporter: (() => null) as unknown as () => number })).toBe(base);
  });

  it('no signals gives the same order as without', () => {
    const many = [
      row('a', 3 * HOUR, brief('rude', 'medium')),
      row('b', 1 * HOUR, brief('hostile', 'low')),
      row('c', 7 * HOUR, null),
      row('d', 2 * HOUR, brief('banter', 'high')),
    ];
    const none = groupQueue(many, { sort: 'priority', now: NOW }).map((g) => g.person);
    expect(groupQueue(many, { sort: 'priority', now: NOW, signals: {} }).map((g) => g.person)).toEqual(none);
    expect(groupQueue(many, { sort: 'priority', now: NOW, signals: { reporter: () => 0 } }).map((g) => g.person)).toEqual(none);
  });

  it('is given the group, so it can read what the group carries', () => {
    const seen: string[] = [];
    groupQueue(items(), { sort: 'priority', now: NOW, signals: { reporter: (g) => (seen.push(g.person), 0) } });
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});

describe('the sort itself', () => {
  it('ties break by person ref, as before', () => {
    const items = [row('zed', 0, null), row('amy', 0, null), row('mid', 0, null)];
    expect(order(items)).toEqual(['amy', 'mid', 'zed']);
  });

  it('is pure: the input is not changed and the order does not depend on arrival order', () => {
    const a = [row('a', 2 * HOUR, brief('rude', 'high')), row('b', 1 * HOUR, brief('hostile', 'high')), row('c', 0, null)];
    const copy = JSON.stringify(a);
    const forward = order(a);
    expect(JSON.stringify(a)).toBe(copy);
    expect(order([...a].reverse())).toEqual(forward);
  });

  it('works without a now: it measures the wait from the newest report in the list', () => {
    const items = [row('old', 24 * HOUR, brief('banter', 'high')), row('new', 0, null)];
    const noNow = groupQueue(items, { sort: 'priority' }).map((g) => g.person);
    expect(noNow).toEqual(['old', 'new']);
  });

  it('rankDown still moves a habitual-only case after the others', () => {
    const habitual = { decided: 10, unfounded: 9, falseRate: 0.9, habitual: true };
    const items = [row('hab', 0, brief('severe', 'high'), { reporterAccuracy: habitual }), row('plain', 0, brief('banter', 'high'))];
    expect(groupQueue(items, { sort: 'priority', now: NOW, rankDown: { now: NOW } }).map((g) => g.person)).toEqual(['plain', 'hab']);
  });

  it('existing sorts are unchanged', () => {
    const items = [
      row('a', 3 * HOUR, brief('severe', 'high'), { createdAt: NOW - 3 * HOUR }),
      row('b', 1 * HOUR, null, { createdAt: NOW - 1 * HOUR }),
      row('c', 2 * HOUR, null, { createdAt: NOW - 2 * HOUR }),
      row('c', 2 * HOUR, null, { createdAt: NOW - 2 * HOUR + 1 }),
    ];
    expect(groupQueue(items, { sort: 'latest' }).map((g) => g.person)).toEqual(['b', 'c', 'a']);
    expect(groupQueue(items, { sort: 'oldest' }).map((g) => g.person)).toEqual(['a', 'c', 'b']);
    expect(groupQueue(items, { sort: 'reports' }).map((g) => g.person)).toEqual(['c', 'b', 'a']);
    expect(groupQueue(items).map((g) => g.person)).toEqual(['b', 'c', 'a']);
  });
});

describe('an older server', () => {
  it('an older server that sends no ai field gives every case the neutral weight', () => {
    const items = [row('a', 2 * HOUR, undefined), row('b', 1 * HOUR, undefined)];
    const groups = groupQueue(items, { sort: 'priority', now: NOW });
    expect(groups.every((g) => g.ai === null)).toBe(true);
    // Neutral for both, so only the wait differs: the longer wait first.
    expect(groups.map((g) => g.person)).toEqual(['a', 'b']);
    expect(score(items, 'a')).toBeCloseTo(1.2 + (2 * 2) / 24, 10);
  });

  it('a server that sends ai: null is the same as one that sends no field', () => {
    const none = groupQueue([row('a', HOUR, undefined)], { sort: 'priority', now: NOW });
    const nulls = groupQueue([row('a', HOUR, null)], { sort: 'priority', now: NOW });
    expect(priorityScore(none[0] as QueueGroup, NOW, {})).toBe(priorityScore(nulls[0] as QueueGroup, NOW, {}));
  });

  it('a brief with an unknown severity or confidence counts as neutral, not as a crash', () => {
    const odd = { ...brief('banter', 'high'), severity: 'extreme', confidence: 'certain' } as unknown as AiBrief;
    const items = [row('odd', 0, odd)];
    expect(() => score(items, 'odd')).not.toThrow();
    expect(score(items, 'odd')).toBe(1.2);
  });
});

describe('the reporter signal the hub supplies', () => {
  it('a group carries the false-report rate of its open reports, or null when the server tells nothing', () => {
    const items = [
      row('p', 0, null, { reporterAccuracy: { decided: 10, unfounded: 2, falseRate: 0.2, habitual: false } }),
      row('p', 0, null, { reporterAccuracy: { decided: 10, unfounded: 6, falseRate: 0.6, habitual: false }, createdAt: NOW - 1 }),
      row('q', 0, null, { reporterAccuracy: null }),
      row('r', 0, null),
    ];
    const by = Object.fromEntries(groupQueue(items, { sort: 'priority', now: NOW }).map((g) => [g.person, g.reporterFalseRate]));
    expect(by['p']).toBeCloseTo(0.4, 10);
    expect(by['q']).toBeNull();
    expect(by['r']).toBeNull();
  });
});
