import { describe, expect, it } from 'vitest';
import { countSignals, evaluateThreshold } from '../src/signalCounts.js';
import type { SignalSourceRow, SubjectId } from '../src/types.js';

// Counting by distinct source (design 5.3): the source key decides what one "count" is, the highest weight in a source wins, a weight of 0
// drops a source, and a merged person's aliases fold into one.

const T = 1_800_000_000_000;
const DAY = 86_400_000;

const kinds = {
  muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const },
  blocked_by_player: { label: 'Blocked by other players', polarity: 'negative' as const },
  commended: { label: 'Commended by other players', polarity: 'positive' as const },
};
const identity = (s: SubjectId): SubjectId => s;
const ctx = { kinds, canonical: identity, windowDays: 14 };

const row = (over: Partial<SignalSourceRow> = {}): SignalSourceRow => ({
  subject: 's_target',
  kind: 'muted_by_player',
  sourceKey: 'b:s_from_1',
  bySubject: 's_from_1',
  weight: 1,
  firstAt: T,
  lastAt: T,
  ...over,
});
const from = (n: number, over: Partial<SignalSourceRow> = {}) => row({ sourceKey: `b:s_from_${n}`, bySubject: `s_from_${n}`, ...over });

describe('countSignals: distinct sources', () => {
  it('ten rows from one by count 1; five different by count 5', () => {
    // The store returns one row per source already; ten rows of one source and the same source repeated must still be one.
    const sameSource = Array.from({ length: 10 }, (_, i) => row({ firstAt: T + i, lastAt: T + i }));
    expect(countSignals(sameSource, ctx)).toMatchObject([{ kind: 'muted_by_player', distinct: 1, weight: 1 }]);
    const five = [1, 2, 3, 4, 5].map((n) => from(n));
    expect(countSignals(five, ctx)).toMatchObject([{ kind: 'muted_by_player', distinct: 5, weight: 5 }]);
  });

  it('source-less rows count per room, and per day when there is no room', () => {
    const rooms = [
      row({ sourceKey: 'r:room-1', bySubject: null }),
      row({ sourceKey: 'r:room-1', bySubject: null, subject: 's_alias' }),
      row({ sourceKey: 'r:room-2', bySubject: null }),
    ];
    expect(countSignals(rooms, ctx)).toMatchObject([{ distinct: 2 }]);
    const days = [
      row({ sourceKey: 'd:2027-01-15', bySubject: null }),
      row({ sourceKey: 'd:2027-01-15', bySubject: null }),
      row({ sourceKey: 'd:2027-01-16', bySubject: null }),
      row({ sourceKey: 'd:2027-01-17', bySubject: null }),
    ];
    expect(countSignals(days, ctx)).toMatchObject([{ distinct: 3 }]);
    // A room, a day and a player are different kinds of source and never meet.
    expect(countSignals([row({ sourceKey: 'r:x', bySubject: null }), row({ sourceKey: 'd:x', bySubject: null }), from(1)], ctx)).toMatchObject([{ distinct: 3 }]);
  });
});

describe('countSignals: aliases', () => {
  it('two aliases of one by count once after a merge', () => {
    const canonical = (s: SubjectId): SubjectId => (s === 's_from_2' ? 's_from_1' : s);
    const rows = [from(1), from(2)];
    expect(countSignals(rows, { ...ctx, canonical })).toMatchObject([{ distinct: 1, weight: 1 }]);
    // Without the merge they are two people.
    expect(countSignals(rows, ctx)).toMatchObject([{ distinct: 2 }]);
  });

  it('the fold goes through the canonical of bySubject, not the stored source key', () => {
    // Recorded before the merge: the keys differ, bySubject names each alias.
    const canonical = (s: SubjectId): SubjectId => (s === 's_old' ? 's_new' : s);
    const rows = [
      row({ sourceKey: 'b:s_old', bySubject: 's_old' }),
      row({ sourceKey: 'b:s_new', bySubject: 's_new' }),
    ];
    expect(countSignals(rows, { ...ctx, canonical })).toMatchObject([{ distinct: 1 }]);
  });

  it('rows about an alias and about the canonical person fold into one count', () => {
    const rows = [row({ subject: 's_canonical' }), row({ subject: 's_alias' }), from(2, { subject: 's_alias' }), from(2, { subject: 's_canonical' })];
    expect(countSignals(rows, ctx)).toMatchObject([{ distinct: 2, weight: 2 }]);
  });

  it('a bySubject-less b: key folds through the id in the key', () => {
    const canonical = (s: SubjectId): SubjectId => (s === 's_from_2' ? 's_from_1' : s);
    const rows = [row({ bySubject: null }), row({ sourceKey: 'b:s_from_2', bySubject: null })];
    expect(countSignals(rows, { ...ctx, canonical })).toMatchObject([{ distinct: 1 }]);
  });
});

describe('countSignals: weights', () => {
  it('weights per source take the max, and the total sums the maxes', () => {
    const rows = [from(1, { weight: 0.5 }), from(1, { weight: 2 }), from(1, { weight: 1 }), from(2, { weight: 1.5 })];
    expect(countSignals(rows, ctx)).toMatchObject([{ distinct: 2, weight: 3.5 }]);
  });

  it('a weight of 0 drops a source; a source that is only 0 is not counted at all', () => {
    const rows = [from(1, { weight: 0 }), from(2, { weight: 1 }), from(3, { weight: 0 }), from(3, { weight: 0.25 })];
    expect(countSignals(rows, ctx)).toMatchObject([{ distinct: 2, weight: 1.25 }]);
    expect(countSignals([from(1, { weight: 0 })], ctx)).toEqual([]);
  });

  it('a negative or non-finite weight is not counted', () => {
    expect(countSignals([from(1, { weight: -1 }), from(2, { weight: Number.NaN }), from(3, { weight: 1 })], ctx)).toMatchObject([{ distinct: 1, weight: 1 }]);
  });
});

describe('countSignals: kinds and times', () => {
  it('a kind outside the request is absent; an undeclared kind in the rows is ignored', () => {
    const rows = [from(1), from(1, { kind: 'blocked_by_player' }), from(1, { kind: 'removed_kind' }), from(1, { kind: 'constructor' }), from(1, { kind: 'toString' })];
    expect(countSignals(rows, ctx).map((c) => c.kind)).toEqual(['muted_by_player', 'blocked_by_player']);
    expect(countSignals(rows, { ...ctx, kinds: { muted_by_player: kinds.muted_by_player } }).map((c) => c.kind)).toEqual(['muted_by_player']);
  });

  it('the entries follow the order of the request and carry the label, polarity and window', () => {
    const rows = [from(1, { kind: 'commended' }), from(1, { kind: 'blocked_by_player' }), from(1)];
    const out = countSignals(rows, { ...ctx, windowDays: 30 });
    expect(out.map((c) => c.kind)).toEqual(['muted_by_player', 'blocked_by_player', 'commended']);
    expect(out[2]).toEqual({ kind: 'commended', label: 'Commended by other players', polarity: 'positive', distinct: 1, weight: 1, windowDays: 30, firstAt: T, lastAt: T });
  });

  it('firstAt and lastAt span the counted sources only', () => {
    const rows = [
      from(1, { firstAt: T + 5 * DAY, lastAt: T + 6 * DAY }),
      from(2, { firstAt: T + 2 * DAY, lastAt: T + 9 * DAY }),
      from(3, { weight: 0, firstAt: T - 100 * DAY, lastAt: T + 100 * DAY }),
    ];
    expect(countSignals(rows, ctx)).toMatchObject([{ distinct: 2, firstAt: T + 2 * DAY, lastAt: T + 9 * DAY }]);
  });

  it('a count per kind keeps its own times', () => {
    const rows = [from(1, { firstAt: T, lastAt: T + 1 }), from(1, { kind: 'blocked_by_player', firstAt: T + DAY, lastAt: T + 2 * DAY })];
    const out = countSignals(rows, ctx);
    expect(out[0]).toMatchObject({ kind: 'muted_by_player', firstAt: T, lastAt: T + 1 });
    expect(out[1]).toMatchObject({ kind: 'blocked_by_player', firstAt: T + DAY, lastAt: T + 2 * DAY });
  });

  it('a request with no kinds, or no rows, gives []', () => {
    expect(countSignals([], ctx)).toEqual([]);
    expect(countSignals([from(1)], { ...ctx, kinds: {} })).toEqual([]);
  });

  it('does not change its inputs', () => {
    const rows = [from(1), from(2)];
    const copy = JSON.parse(JSON.stringify(rows)) as SignalSourceRow[];
    countSignals(rows, ctx);
    expect(rows).toEqual(copy);
  });

  it('prototype-named kinds in the request are counted only when requested as own keys', () => {
    const own = { constructor: { label: 'Ctor', polarity: 'negative' as const } };
    expect(countSignals([from(1, { kind: 'constructor' })], { ...ctx, kinds: own })).toMatchObject([{ kind: 'constructor', distinct: 1 }]);
    expect(countSignals([from(1, { kind: 'constructor' })], ctx)).toEqual([]);
  });
});

describe('evaluateThreshold', () => {
  const t = (over: Record<string, unknown> = {}) => ({ kinds: ['muted_by_player'], minDistinct: 3, windowDays: 14, ...over });

  it('minWeight is honoured; distinct below minDistinct is not met', () => {
    const rows = [from(1), from(2), from(3, { weight: 0.5 })];
    expect(evaluateThreshold(rows, ctx, t())).toMatchObject({ met: true, distinct: 3, weight: 2.5 });
    expect(evaluateThreshold(rows, ctx, t({ minDistinct: 4 }))).toMatchObject({ met: false, distinct: 3 });
    expect(evaluateThreshold(rows, ctx, t({ minWeight: 2.5 }))).toMatchObject({ met: true });
    expect(evaluateThreshold(rows, ctx, t({ minWeight: 2.51 }))).toMatchObject({ met: false, distinct: 3, weight: 2.5 });
    // Distinct fails even when the weight would be enough.
    expect(evaluateThreshold([from(1, { weight: 10 })], ctx, t({ minDistinct: 2, minWeight: 5 }))).toMatchObject({ met: false, distinct: 1, weight: 10 });
  });

  it('muted plus blocked by one player counts twice for a two-kind threshold and once for a one-kind threshold', () => {
    const rows = [from(1), from(1, { kind: 'blocked_by_player' }), from(2)];
    expect(evaluateThreshold(rows, ctx, t({ kinds: ['muted_by_player', 'blocked_by_player'], minDistinct: 3 }))).toMatchObject({ met: true, distinct: 3 });
    expect(evaluateThreshold(rows, ctx, t({ kinds: ['muted_by_player'], minDistinct: 3 }))).toMatchObject({ met: false, distinct: 2 });
    expect(evaluateThreshold(rows, ctx, t({ kinds: ['blocked_by_player'], minDistinct: 1 }))).toMatchObject({ met: true, distinct: 1 });
  });

  it('only the threshold\'s kinds are read, and a kind not in the request or not declared is ignored', () => {
    const rows = [from(1), from(2, { kind: 'commended' }), from(3, { kind: 'removed_kind' })];
    expect(evaluateThreshold(rows, ctx, t({ kinds: ['muted_by_player'], minDistinct: 1 }))).toMatchObject({ distinct: 1 });
    expect(evaluateThreshold(rows, ctx, t({ kinds: ['removed_kind'], minDistinct: 1 }))).toMatchObject({ met: false, distinct: 0 });
    expect(evaluateThreshold(rows, { ...ctx, kinds: {} }, t({ minDistinct: 1 }))).toMatchObject({ met: false, distinct: 0 });
  });

  it('folds aliases and drops weight 0 like countSignals', () => {
    const canonical = (s: SubjectId): SubjectId => (s === 's_from_2' ? 's_from_1' : s);
    const rows = [from(1), from(2), from(3, { weight: 0 }), from(4)];
    expect(evaluateThreshold(rows, { ...ctx, canonical }, t({ minDistinct: 2 }))).toMatchObject({ met: true, distinct: 2, weight: 2 });
  });

  it('firstAt and lastAt span the counted sources across the kinds', () => {
    const rows = [from(1, { firstAt: T + DAY, lastAt: T + 2 * DAY }), from(1, { kind: 'blocked_by_player', firstAt: T, lastAt: T + 3 * DAY }), from(2, { weight: 0, firstAt: T - DAY, lastAt: T + 9 * DAY })];
    expect(evaluateThreshold(rows, ctx, t({ kinds: ['muted_by_player', 'blocked_by_player'], minDistinct: 1 }))).toEqual({
      met: true,
      distinct: 2,
      weight: 2,
      firstAt: T,
      lastAt: T + 3 * DAY,
    });
  });

  it('empty rows give [] and a not-met threshold with null times', () => {
    expect(countSignals([], ctx)).toEqual([]);
    expect(evaluateThreshold([], ctx, t())).toEqual({ met: false, distinct: 0, weight: 0, firstAt: null, lastAt: null });
    expect(evaluateThreshold([from(1, { weight: 0 })], ctx, t({ minDistinct: 1 }))).toEqual({ met: false, distinct: 0, weight: 0, firstAt: null, lastAt: null });
  });

  it('a not-met threshold still reports what it counted', () => {
    const r = evaluateThreshold([from(1, { firstAt: T, lastAt: T + 5 })], ctx, t());
    expect(r).toEqual({ met: false, distinct: 1, weight: 1, firstAt: T, lastAt: T + 5 });
  });

  it('works without a windowDays in the context (the threshold has its own)', () => {
    const { windowDays: _w, ...bare } = ctx;
    void _w;
    expect(evaluateThreshold([from(1)], bare, t({ minDistinct: 1 })).met).toBe(true);
  });
});
