import { REPORTER_RANK_LAPSE_MS } from '@chatwarden/core';
import type { ReportSummary } from '@chatwarden/http/admin';
import { describe, expect, it } from 'vitest';
import { groupQueue } from '../src/queue.js';
import type { QueueSort } from '../src/queue.js';

// Ranking a case lower when every open report on it came from a habitual false reporter. A hint to order by, never a filter: nothing
// is removed, and a case that has waited a day ranks as any other. The same rule as core's take-next, from the summaries the queue holds.

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HABITUAL = { decided: 10, unfounded: 9, falseRate: 0.9, habitual: true };
const ORDINARY = { decided: 10, unfounded: 2, falseRate: 0.2, habitual: false };
const NOISY = { decided: 10, unfounded: 7, falseRate: 0.7, habitual: false };

let seq = 0;
function report(over: Partial<ReportSummary> = {}): ReportSummary {
  seq += 1;
  return {
    id: over.id ?? `r${String(seq).padStart(4, '0')}`,
    createdAt: NOW - 10 * MIN,
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

const rank = { now: NOW };
const people = (items: ReportSummary[], options: Parameters<typeof groupQueue>[1] = {}): string[] => groupQueue(items, options).map((g) => g.person);
const lowOf = (items: ReportSummary[], options: Parameters<typeof groupQueue>[1] = { rankDown: rank }): Record<string, boolean | undefined> =>
  Object.fromEntries(groupQueue(items, options).map((g) => [g.person, g.rankedLow]));

describe('groupQueue rankDown', () => {
  it('a case whose open reports are all from habitual reporters sorts after ordinary cases in every sort', () => {
    // `hab` is the newest, the longest-waiting and has the most reports, so each sort would put it first without the ranking.
    const items = [
      report({ targetPerson: 'hab', createdAt: NOW - 20 * MIN, reporterPerson: 'h1', reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'hab', createdAt: NOW - 19 * MIN, reporterPerson: 'h2', reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'hab', createdAt: NOW - 1 * MIN, reporterPerson: 'h3', reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'plain-a', createdAt: NOW - 5 * MIN, reporterAccuracy: ORDINARY }),
      report({ targetPerson: 'plain-b', createdAt: NOW - 6 * MIN, reporterAccuracy: null }),
    ];
    for (const sort of ['latest', 'oldest', 'reports'] as QueueSort[]) {
      const without = people(items, { sort });
      expect(without[0], `${sort} without ranking`).toBe('hab');
      const ranked = groupQueue(items, { sort, rankDown: rank });
      expect(ranked.map((g) => g.person).at(-1), sort).toBe('hab');
      expect(ranked.find((g) => g.person === 'hab')?.rankedLow, sort).toBe(true);
      expect(ranked.filter((g) => g.person !== 'hab').every((g) => g.rankedLow === false), sort).toBe(true);
    }
  });

  it('each partition keeps the chosen sort order inside it', () => {
    const items = [
      report({ targetPerson: 'h-new', createdAt: NOW - 1 * MIN, reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'h-old', createdAt: NOW - 9 * MIN, reporterPerson: 'rep-2', reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'p-new', createdAt: NOW - 2 * MIN, reporterPerson: 'rep-3', reporterAccuracy: ORDINARY }),
      report({ targetPerson: 'p-old', createdAt: NOW - 8 * MIN, reporterPerson: 'rep-4', reporterAccuracy: ORDINARY }),
    ];
    expect(people(items, { sort: 'latest', rankDown: rank })).toEqual(['p-new', 'p-old', 'h-new', 'h-old']);
    expect(people(items, { sort: 'oldest', rankDown: rank })).toEqual(['p-old', 'p-new', 'h-old', 'h-new']);
  });

  it('one ordinary reporter keeps the case normal, however many habitual ones also reported it', () => {
    const items = [
      report({ targetPerson: 'mixed', reporterPerson: 'h1', reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'mixed', reporterPerson: 'h2', reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'mixed', reporterPerson: 'ok', reporterAccuracy: ORDINARY }),
    ];
    expect(lowOf(items)).toEqual({ mixed: false });
  });

  it('a noticeable reporter who is not habitual does not rank a case down', () => {
    expect(lowOf([report({ targetPerson: 'x', reporterAccuracy: NOISY })])).toEqual({ x: false });
  });

  it('a decided report does not count: only open reports decide, and a group with none open is never ranked low', () => {
    const items = [
      report({ targetPerson: 'x', reporterPerson: 'h1', reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'x', reporterPerson: 'ok', status: 'dismissed', reporterAccuracy: null }),
      report({ targetPerson: 'closed', status: 'dismissed', reporterAccuracy: HABITUAL }),
    ];
    expect(lowOf(items)).toEqual({ x: true, closed: false });
  });

  it('a report waiting 24 h or more is not ranked low (boundary, injected now)', () => {
    const at = (age: number) => [report({ targetPerson: 'x', createdAt: NOW - age, reporterAccuracy: HABITUAL })];
    expect(REPORTER_RANK_LAPSE_MS).toBe(24 * 60 * MIN);
    expect(lowOf(at(REPORTER_RANK_LAPSE_MS - 1))).toEqual({ x: true });
    expect(lowOf(at(REPORTER_RANK_LAPSE_MS))).toEqual({ x: false });
    expect(lowOf(at(REPORTER_RANK_LAPSE_MS + 1))).toEqual({ x: false });
  });

  it('the lapse follows the oldest open report: one old report lifts the whole case', () => {
    const items = [
      report({ targetPerson: 'x', reporterPerson: 'h1', createdAt: NOW - 25 * 60 * MIN, reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'x', reporterPerson: 'h2', createdAt: NOW - MIN, reporterAccuracy: HABITUAL }),
    ];
    expect(lowOf(items)).toEqual({ x: false });
  });

  it('the lapse is measured at the injected now, not the clock', () => {
    const items = [report({ targetPerson: 'x', createdAt: NOW, reporterAccuracy: HABITUAL })];
    expect(lowOf(items, { rankDown: { now: NOW + REPORTER_RANK_LAPSE_MS - 1 } })).toEqual({ x: true });
    expect(lowOf(items, { rankDown: { now: NOW + REPORTER_RANK_LAPSE_MS } })).toEqual({ x: false });
  });

  it('a case with more than 200 open reports is never ranked low (never bury a mass report)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => report({ targetPerson: 'x', reporterPerson: `h${i}`, reporterAccuracy: HABITUAL }));
    expect(lowOf(many(200))).toEqual({ x: true });
    expect(lowOf(many(201))).toEqual({ x: false });
  });

  it('no rankDown option: order identical to today, and no group carries rankedLow', () => {
    const items = [
      report({ targetPerson: 'h', createdAt: NOW - MIN, reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'p', createdAt: NOW - 2 * MIN, reporterPerson: 'rep-2', reporterAccuracy: ORDINARY }),
    ];
    const plain = groupQueue(items);
    expect(plain.map((g) => g.person)).toEqual(['h', 'p']);
    expect(plain.every((g) => g.rankedLow === undefined)).toBe(true);
    expect(groupQueue(items, { sort: 'latest' })).toEqual(plain);
    expect(groupQueue(items, {})).toEqual(plain);
  });

  it('a missing reporterAccuracy (older server) ranks nobody low', () => {
    const items = [
      report({ targetPerson: 'a', reporterPerson: 'r1' }),
      report({ targetPerson: 'b', reporterPerson: 'r2', reporterAccuracy: undefined }),
      report({ targetPerson: 'c', reporterPerson: 'r3', reporterAccuracy: null }),
    ];
    expect(lowOf(items)).toEqual({ a: false, b: false, c: false });
    expect(people(items, { rankDown: rank })).toEqual(people(items));
  });

  it('a habitual report with a missing one beside it is not enough (every open report must say so)', () => {
    const items = [report({ targetPerson: 'x', reporterPerson: 'h1', reporterAccuracy: HABITUAL }), report({ targetPerson: 'x', reporterPerson: 'h2' })];
    expect(lowOf(items)).toEqual({ x: false });
  });

  it('nothing is dropped: the output has the same cases, reports and counts', () => {
    const items = [
      report({ targetPerson: 'h', reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'h', reporterPerson: 'rep-2', reporterAccuracy: HABITUAL }),
      report({ targetPerson: 'p', reporterPerson: 'rep-3', reporterAccuracy: ORDINARY }),
    ];
    const plain = groupQueue(items);
    const ranked = groupQueue(items, { rankDown: rank });
    expect(ranked).toHaveLength(plain.length);
    const strip = <G extends { rankedLow?: boolean }>(g: G): G => ({ ...g, rankedLow: undefined });
    const byPerson = (a: { person: string }, b: { person: string }) => (a.person < b.person ? -1 : 1);
    expect(ranked.map(strip).sort(byPerson)).toEqual(plain.map(strip).sort(byPerson));
    expect(ranked.reduce((n, g) => n + g.reports, 0)).toBe(3);
  });

  it('sorting is stable and deterministic across input order', () => {
    const items = [
      report({ id: 'a1', targetPerson: 'h1', createdAt: NOW - MIN, reporterPerson: 'x1', reporterAccuracy: HABITUAL }),
      report({ id: 'a2', targetPerson: 'h2', createdAt: NOW - MIN, reporterPerson: 'x2', reporterAccuracy: HABITUAL }),
      report({ id: 'a3', targetPerson: 'p1', createdAt: NOW - MIN, reporterPerson: 'x3', reporterAccuracy: ORDINARY }),
      report({ id: 'a4', targetPerson: 'p2', createdAt: NOW - MIN, reporterPerson: 'x4', reporterAccuracy: ORDINARY }),
    ];
    for (const sort of ['latest', 'oldest', 'reports'] as QueueSort[]) {
      const forward = people(items, { sort, rankDown: rank });
      expect(people([...items].reverse(), { sort, rankDown: rank }), sort).toEqual(forward);
      expect(people([items[2]!, items[0]!, items[3]!, items[1]!], { sort, rankDown: rank }), sort).toEqual(forward);
      expect(forward, sort).toEqual(['p1', 'p2', 'h1', 'h2']);
    }
  });

  it('does not change the input', () => {
    const items = [report({ targetPerson: 'h', reporterAccuracy: HABITUAL }), report({ targetPerson: 'p', reporterPerson: 'r2', reporterAccuracy: ORDINARY })];
    const copy = structuredClone(items);
    groupQueue(items, { rankDown: rank });
    expect(items).toEqual(copy);
  });
});
