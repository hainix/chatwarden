import type { ReportSummary } from '@chatwarden/http/admin';
import { describe, expect, it } from 'vitest';
import { conductSignal, priorityScore, RANK_WEIGHTS, SIGNAL_BOOST } from '../src/ai/rank.js';
import { groupQueue } from '../src/queue.js';
import type { QueueGroup, RankSignals } from '../src/queue.js';

// The queue's second pure seam (flood control and signals, design 5.5): `signals.conduct`, beside `reporter`. A person who meets the queue
// signal feed (`boosted` on the server's report items) scores half a point higher in the `priority` sort. A weight, never a filter; the
// default sort and the chip set do not change.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

let seq = 0;
function report(person: string, over: Partial<ReportSummary> = {}): ReportSummary {
  seq += 1;
  return {
    id: `r${String(seq).padStart(4, '0')}`,
    createdAt: NOW - HOUR,
    roomId: 'room-a',
    tags: {},
    category: 'harassment',
    reportedReason: 'harassment',
    reportedReasonLabel: 'Insults or harassment',
    status: 'open',
    badFaith: false,
    targetPerson: person,
    reporterPerson: `rep-${seq}`,
    actionedAt: null,
    actionedBy: null,
    targetHandle: null,
    reporterHandle: null,
    claim: null,
    viewing: [],
    ...over,
  };
}

/** The object without these keys. */
const without = (o: object, keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const groups = (items: ReportSummary[], sort: Parameters<typeof groupQueue>[1] = {}): QueueGroup[] => groupQueue(items, { now: NOW, ...sort });
const find = (g: QueueGroup[], person: string): QueueGroup => g.find((x) => x.person === person) as QueueGroup;
const orderOf = (items: ReportSummary[], signals?: RankSignals): string[] =>
  groupQueue(items, { sort: 'priority', now: NOW, ...(signals === undefined ? {} : { signals }) }).map((g) => g.person);

describe('the constant and the signal', () => {
  it('SIGNAL_BOOST is 0.5, the same size as the reporter clamp', () => {
    expect(SIGNAL_BOOST).toBe(0.5);
    expect(RANK_WEIGHTS.reporterClamp).toBe(0.5);
  });

  it('conductSignal answers the boost for a boosted group and 0 for any other', () => {
    const g = groups([report('person-a', { boosted: true }), report('person-b')]);
    expect(conductSignal(find(g, 'person-a'))).toBe(0.5);
    expect(conductSignal(find(g, 'person-b'))).toBe(0);
  });
});

describe('groupQueue carries the mark', () => {
  it('sets boosted on a group when an open report of the person is marked, and on no other', () => {
    const g = groups([report('person-a', { boosted: true }), report('person-a'), report('person-b')]);
    expect(find(g, 'person-a').boosted).toBe(true);
    expect('boosted' in find(g, 'person-b')).toBe(false);
  });

  it('an older server that sends no boosted field gives every group the neutral weight, and no key', () => {
    const g = groups([report('person-a'), report('person-b')]);
    for (const x of g) {
      expect('boosted' in x).toBe(false);
      expect(conductSignal(x)).toBe(0);
    }
  });

  it('a decided report never boosts (the server marks open ones only; a stray mark on a decided one is ignored)', () => {
    const g = groups([report('person-a', { boosted: true, status: 'dismissed' }), report('person-a', { status: 'open' })]);
    expect('boosted' in find(g, 'person-a')).toBe(false);
  });
});

describe('the priority score', () => {
  const two = (): ReportSummary[] => [report('person-a'), report('person-b', { boosted: true })];

  it('a boosted group scores plus 0.5 with the default signals, and ties still break by person ref', () => {
    // Without the mark the tie breaks person-a first; with it person-b is half a point ahead.
    expect(orderOf([report('person-a'), report('person-b')])).toEqual(['person-a', 'person-b']);
    expect(orderOf(two())).toEqual(['person-b', 'person-a']);
    const g = groups(two());
    const plain = priorityScore(find(g, 'person-b'), NOW, {});
    expect(priorityScore(find(g, 'person-b'), NOW, { conduct: conductSignal }) - plain).toBeCloseTo(0.5, 10);
  });

  it('the clamp is plus or minus 0.5, like reporter', () => {
    const g = find(groups([report('person-a')]), 'person-a');
    const base = priorityScore(g, NOW, {});
    expect(priorityScore(g, NOW, { conduct: () => 5 }) - base).toBeCloseTo(0.5, 10);
    expect(priorityScore(g, NOW, { conduct: () => -5 }) - base).toBeCloseTo(-0.5, 10);
    expect(priorityScore(g, NOW, { conduct: () => 0.2 }) - base).toBeCloseTo(0.2, 10);
    expect(priorityScore(g, NOW, { conduct: () => 5, reporter: () => 5 }) - base).toBeCloseTo(1, 10);
  });

  it('NaN, Infinity, a non-number and a throw from conduct are ignored', () => {
    const g = find(groups([report('person-a')]), 'person-a');
    const base = priorityScore(g, NOW, {});
    for (const bad of [() => Number.NaN, () => Number.POSITIVE_INFINITY, () => Number.NEGATIVE_INFINITY, () => 'x', () => null, () => undefined, () => { throw new Error('boom'); }]) {
      expect(priorityScore(g, NOW, { conduct: bad as never }), String(bad)).toBe(base);
    }
  });

  it('no signals gives the same order as without them: nobody is marked', () => {
    const items = [report('person-a', { createdAt: NOW - 3 * HOUR }), report('person-b', { createdAt: NOW - HOUR }), report('person-c')];
    expect(orderOf(items)).toEqual(orderOf(items, { reporter: () => 0 }));
    expect(orderOf(items)).toEqual(orderOf(items, { conduct: () => 0 }));
  });

  it('half a point reorders a close call but never overrides a long wait', () => {
    const waited = report('person-a', { createdAt: NOW - 12 * HOUR });
    const fresh = report('person-b', { createdAt: NOW - 10 * 60_000, boosted: true });
    expect(orderOf([waited, fresh])).toEqual(['person-a', 'person-b']);
  });

  it('an explicit signals object without conduct leaves the boost out (the host chose its own weights)', () => {
    expect(orderOf(two(), { reporter: () => 0 })).toEqual(['person-a', 'person-b']);
  });
});

describe('what does not change', () => {
  const once = [
    report('person-a', { createdAt: NOW - 5 * HOUR }),
    report('person-b', { createdAt: NOW - 3 * HOUR, boosted: true }),
    report('person-b', { createdAt: NOW - 2 * HOUR }),
    report('person-c', { createdAt: NOW - HOUR }),
  ];
  const items = (): ReportSummary[] => once;
  const unmarked = (): ReportSummary[] => once.map((r) => without(r, ['boosted']) as ReportSummary);

  it('the default sort orders (latest, oldest, reports) are the same with and without the mark', () => {
    for (const sort of ['latest', 'oldest', 'reports'] as const) {
      expect(groupQueue(items(), { sort, now: NOW }).map((g) => g.person), sort).toEqual(groupQueue(unmarked(), { sort, now: NOW }).map((g) => g.person));
    }
  });

  it('the groups differ only by the boosted key: counts, reasons, claims and chips are as they were', () => {
    const a = groupQueue(items(), { now: NOW }).map((g) => without(g, ['boosted', 'summaries']));
    const b = groupQueue(unmarked(), { now: NOW }).map((g) => without(g, ['summaries']));
    expect(a).toEqual(b);
  });

  it('nothing is removed by the mark: every person and every report is still listed', () => {
    const g = groups(items(), { sort: 'priority' });
    expect(g.map((x) => x.person).sort()).toEqual(['person-a', 'person-b', 'person-c']);
    expect(g.reduce((n, x) => n + x.reports, 0)).toBe(4);
  });
});
