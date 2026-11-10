import { describe, expect, it } from 'vitest';
import { BANNER_AFTER_FAILURES, POLL_FAILING_MS, POLL_HIDDEN_MS, POLL_VISIBLE_MS, adopt, pollDelay, reconcile } from '../src/live.js';
import type { ShownRow } from '../src/live.js';
import type { QueueGroup } from '../src/queue.js';

const group = (person: string, over: Partial<QueueGroup> = {}): QueueGroup => ({
  person,
  handle: person,
  handles: [person],
  categories: ['harassment'],
  reports: 1,
  open: 1,
  actioned: 0,
  dismissed: 0,
  rooms: [],
  reporters: 1,
  firstAt: 1,
  latestAt: 1,
  oldestOpenAt: 1,
  reportIds: [`r-${person}`],
  entries: [{ id: `r-${person}`, category: 'harassment', createdAt: 1 }],
  claim: null,
  viewing: [],
  ...over,
});
const row = (person: string, over: Partial<QueueGroup> = {}, gone = false): ShownRow => ({ group: group(person, over), gone });
const people = (rows: readonly ShownRow[]): string[] => rows.map((r) => r.group.person);
const never = (): boolean => false;
const always = (): boolean => true;

describe('pollDelay', () => {
  it('polls every 5 seconds while the tab is visible, and every 30 while it is hidden', () => {
    expect(POLL_VISIBLE_MS).toBe(5_000);
    expect(POLL_HIDDEN_MS).toBe(30_000);
    expect(pollDelay({ visible: true, failures: 0 })).toBe(5_000);
    expect(pollDelay({ visible: false, failures: 0 })).toBe(30_000);
  });

  it('retries a first failure at the normal pace, then slows down once the banner shows', () => {
    expect(BANNER_AFTER_FAILURES).toBe(2);
    expect(pollDelay({ visible: true, failures: 1 })).toBe(5_000);
    expect(pollDelay({ visible: true, failures: 2 })).toBe(POLL_FAILING_MS);
    expect(pollDelay({ visible: true, failures: 9 })).toBe(POLL_FAILING_MS);
  });

  it('never polls a hidden tab faster than 30 seconds, failing or not', () => {
    for (const failures of [0, 1, 2, 10]) expect(pollDelay({ visible: false, failures })).toBeGreaterThanOrEqual(POLL_HIDDEN_MS);
  });
});

describe('reconcile: the list never moves under the cursor', () => {
  it('keeps the shown order even when the fresh list is in another order', () => {
    const shown = [row('a'), row('b'), row('c')];
    const out = reconcile(shown, [group('c'), group('a'), group('b')], never);
    expect(people(out.rows)).toEqual(['a', 'b', 'c']);
    expect(out.incoming).toBe(0);
  });

  it('shows fresh data for a row that is still there (a claim arrives in place)', () => {
    const claim = { by: 'maya@example.test', since: 1, until: 9 };
    const out = reconcile([row('a'), row('b')], [group('a', { claim }), group('b')], never);
    expect(out.rows[0]?.group.claim).toEqual(claim);
    expect(out.rows[1]?.group.claim).toBeNull();
  });

  it('holds new cases back and counts them', () => {
    const out = reconcile([row('a')], [group('a'), group('x'), group('y')], never);
    expect(people(out.rows)).toEqual(['a']);
    expect(out.incoming).toBe(2);
  });

  it('drops a case that is gone when nobody is on it', () => {
    const out = reconcile([row('a'), row('b'), row('c')], [group('a'), group('c')], never);
    expect(people(out.rows)).toEqual(['a', 'c']);
  });

  it('keeps a gone case in place, marked, when the cursor is on it, with its last data', () => {
    const shown = [row('a'), row('b', { handle: 'Last known' }), row('c')];
    const out = reconcile(shown, [group('a'), group('c')], (p) => p === 'b');
    expect(people(out.rows)).toEqual(['a', 'b', 'c']);
    expect(out.rows.map((r) => r.gone)).toEqual([false, true, false]);
    expect(out.rows[1]?.group.handle).toBe('Last known');
  });

  it('keeps every gone case while the pointer or focus is in the list (keep says yes to all)', () => {
    const out = reconcile([row('a'), row('b'), row('c')], [group('b')], always);
    expect(people(out.rows)).toEqual(['a', 'b', 'c']);
    expect(out.rows.map((r) => r.gone)).toEqual([true, false, true]);
  });

  it('a gone row goes once nothing holds it, on the next pass', () => {
    const first = reconcile([row('a'), row('b')], [group('a')], always);
    expect(people(first.rows)).toEqual(['a', 'b']);
    const second = reconcile(first.rows, [group('a')], never);
    expect(people(second.rows)).toEqual(['a']);
  });

  it('a gone row that comes back (the case reopened) is a live row again', () => {
    const second = reconcile([row('a'), row('b', {}, true)], [group('a'), group('b')], never);
    expect(second.rows.map((r) => r.gone)).toEqual([false, false]);
    expect(second.incoming).toBe(0);
  });

  it('is idempotent: reconciling twice with the same fresh list changes nothing more', () => {
    const fresh = [group('a'), group('z')];
    const once = reconcile([row('a'), row('b')], fresh, (p) => p === 'b');
    const twice = reconcile(once.rows, fresh, (p) => p === 'b');
    expect(twice).toEqual(once);
  });

  it('does not change its inputs', () => {
    const shown = [row('a'), row('b')];
    const fresh = [group('a')];
    const shownCopy = structuredClone(shown);
    const freshCopy = structuredClone(fresh);
    reconcile(shown, fresh, always);
    expect(shown).toEqual(shownCopy);
    expect(fresh).toEqual(freshCopy);
  });

  it('handles an empty shown list (everything is new) and an empty fresh list (everything is gone)', () => {
    expect(reconcile([], [group('a')], never)).toEqual({ rows: [], incoming: 1 });
    expect(reconcile([row('a')], [], never)).toEqual({ rows: [], incoming: 0 });
    expect(people(reconcile([row('a')], [], always).rows)).toEqual(['a']);
  });
});

describe('adopt', () => {
  it('shows the fresh list in its own order, none of it gone', () => {
    const out = adopt([group('b'), group('a')]);
    expect(people(out)).toEqual(['b', 'a']);
    expect(out.every((r) => !r.gone)).toBe(true);
  });
});
