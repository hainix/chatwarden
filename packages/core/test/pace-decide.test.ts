import { describe, expect, it } from 'vitest';
import type { ResolvedPace } from '../src/pace.js';
import { commitState, decide, normalizeForRepeat, repeatDigest, shouldSignalFlood } from '../src/paceDecide.js';
import type { KeyState, PaceDecision } from '../src/paceDecide.js';

// S4: the pure half of the pacer. `decide(state, pace, now, digest, floor)` says what a line gets and `commitState(prev, pace, now, digest)` what the state becomes: no clock, no store, no
// map, so the in-memory pacer and the shared pacer (state in the store) cannot drift. The shapes below are the table of pacing.test.ts, run against the pure functions.

const T = 1_800_000_000_000;
const OFF: ResolvedPace = { slowModeMs: null, burst: null, duplicateWindowMs: null };
const pace = (over: Partial<ResolvedPace> = {}): ResolvedPace => ({ ...OFF, ...over });
const state = (over: Partial<KeyState> = {}): KeyState => ({ lastAt: T, stamps: [], recent: [], floodSignalAt: null, ...over });
const never = (): string | null => {
  throw new Error('the digest must not be asked for');
};
const digestOf = (line: string) => (): string | null => repeatDigest(line);
const refused = (d: PaceDecision) => {
  if (d.verdict.ok) throw new Error('expected a refusal');
  return d.verdict;
};
const freeze = <S extends object>(s: S): Readonly<S> => {
  Object.freeze(s);
  for (const v of Object.values(s)) if (typeof v === 'object' && v !== null) freeze(v);
  return s;
};

describe('decide: nothing to judge', () => {
  it('no state is ok, whatever the pace; every check off is ok even with state; the digest is not asked for', () => {
    expect(decide(null, pace({ slowModeMs: 1000 }), T, never).verdict).toEqual({ ok: true });
    expect(decide(state(), OFF, T, never).verdict).toEqual({ ok: true });
    expect(decide(state(), OFF, T, never, 0).verdict).toEqual({ ok: true });
    expect(decide(state(), OFF, T, never, -5).verdict).toEqual({ ok: true });
    expect(decide(state(), OFF, T, never, Number.NaN).verdict).toEqual({ ok: true });
  });
});

describe('decide: slow mode', () => {
  it('refuses inside the gap with the exact retryAfterMs; accepts at exactly the gap', () => {
    const p = pace({ slowModeMs: 3000 });
    const r = refused(decide(state({ lastAt: T - 1000 }), p, T, never));
    expect(r).toEqual({ ok: false, reason: 'slow_mode', retryAfterMs: 2000, signalFlood: false });
    expect(decide(state({ lastAt: T - 2999 }), p, T, never).verdict).toMatchObject({ ok: false, retryAfterMs: 1 });
    expect(decide(state({ lastAt: T - 3000 }), p, T, never).verdict).toEqual({ ok: true });
    expect(decide(state({ lastAt: T - 9000 }), p, T, never).verdict).toEqual({ ok: true });
  });

  it('a probation floor is the stricter wins: it is called probation only when the floor is longer than the room\'s own gap', () => {
    const s = state({ lastAt: T - 500 });
    expect(refused(decide(s, pace({ slowModeMs: 1000 }), T, never, 5000)).reason).toBe('probation');
    expect(refused(decide(s, pace({ slowModeMs: 5000 }), T, never, 1000)).reason).toBe('slow_mode');
    expect(refused(decide(s, pace({ slowModeMs: 5000 }), T, never, 5000)).reason).toBe('slow_mode');
    // a floor paces a player even in a room whose own pace is off
    expect(refused(decide(s, OFF, T, never, 5000))).toMatchObject({ reason: 'probation', retryAfterMs: 4500 });
  });

  it('a clock that stepped back never refuses: state stamped after now is stale, and the wait never passes the gap', () => {
    const p = pace({ slowModeMs: 3000 });
    expect(decide(state({ lastAt: T + 60 * 60_000 }), p, T, never).verdict).toEqual({ ok: true });
    expect(decide(state({ lastAt: T + 1 }), p, T, never).verdict).toEqual({ ok: true });
    // the same millisecond is not the future
    expect(refused(decide(state({ lastAt: T }), p, T, never)).retryAfterMs).toBe(3000);
  });
});

describe('decide: burst', () => {
  const p = pace({ burst: { lines: 3, windowMs: 10_000 } });

  it('the (N+1)th line is refused flood with oldest + window - now; N - 1 live lines are fine; aged-out stamps do not count', () => {
    const live = state({ lastAt: T - 100, stamps: [T - 9000, T - 5000, T - 100] });
    expect(refused(decide(live, p, T, never))).toMatchObject({ reason: 'flood', retryAfterMs: 1000 });
    expect(decide(state({ stamps: [T - 5000, T - 100] }), p, T, never).verdict).toEqual({ ok: true });
    expect(decide(state({ stamps: [T - 10_000, T - 5000, T - 100] }), p, T, never).verdict).toEqual({ ok: true });
    expect(decide(state({ stamps: [T - 9999, T - 5000, T - 100] }), p, T, never).verdict).toMatchObject({ ok: false, retryAfterMs: 1 });
  });

  it('a burst narrowed after the lines were sent counts all live stamps and waits for enough to age out', () => {
    const many = state({ stamps: [T - 9000, T - 8000, T - 7000, T - 6000, T - 5000] });
    expect(refused(decide(many, p, T, never)).retryAfterMs).toBe(T - 7000 + 10_000 - T);
  });

  it('stamps stamped after now are ignored (a clock that stepped back)', () => {
    expect(decide(state({ stamps: [T + 5, T + 6, T + 7] }), p, T, never).verdict).toEqual({ ok: true });
  });

  it('retryAfterMs is a whole number from 1 up to the window, for a fractional clock too', () => {
    const s = state({ stamps: [T - 9000.4, T - 5000, T - 100] });
    const wait = refused(decide(s, p, T, never)).retryAfterMs;
    expect(Number.isInteger(wait)).toBe(true);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(10_000);
  });
});

describe('decide: the flood signal', () => {
  const p = pace({ burst: { lines: 2, windowMs: 10_000 } });
  const tripped = (floodSignalAt: number | null) => decide(state({ stamps: [T - 2000, T - 1000], floodSignalAt }), p, T, never);

  it('signals once per burst window: the first refusal asks to record the signal at now, later ones inside the window do not', () => {
    const first = tripped(null);
    expect(refused(first)).toMatchObject({ reason: 'flood', signalFlood: true });
    expect(first.signalAt).toBe(T);
    const again = tripped(T - 1);
    expect(refused(again).signalFlood).toBe(false);
    expect(again.signalAt).toBeNull();
    expect(refused(tripped(T - 9999)).signalFlood).toBe(false);
    expect(refused(tripped(T - 10_000)).signalFlood).toBe(true);
  });

  it('a signal stamped after now (a clock that stepped back) is stale: the trip signals again', () => {
    expect(refused(tripped(T + 5000)).signalFlood).toBe(true);
  });

  it('shouldSignalFlood is the same rule on its own', () => {
    expect(shouldSignalFlood(null, T, 1000)).toBe(true);
    expect(shouldSignalFlood(T - 999, T, 1000)).toBe(false);
    expect(shouldSignalFlood(T - 1000, T, 1000)).toBe(true);
    expect(shouldSignalFlood(T + 1, T, 1000)).toBe(true);
  });

  it('only a flood signals: slow mode and duplicate refusals carry signalFlood false and no signalAt', () => {
    const slow = decide(state({ lastAt: T - 10 }), pace({ slowModeMs: 1000, burst: { lines: 2, windowMs: 10_000 } }), T, never);
    expect(refused(slow)).toMatchObject({ reason: 'slow_mode', signalFlood: false });
    expect(slow.signalAt).toBeNull();
  });
});

describe('decide: repeats', () => {
  const p = pace({ duplicateWindowMs: 30_000 });
  const h = repeatDigest('hello there friend') as string;

  it('the same line is refused with at + window - now, edge exact; a different line is fine', () => {
    const s = state({ recent: [{ h, at: T - 10_000 }] });
    expect(refused(decide(s, p, T, digestOf('Hello, there FRIEND!')))).toEqual({ ok: false, reason: 'duplicate', retryAfterMs: 20_000, signalFlood: false });
    expect(decide(s, p, T, digestOf('something else')).verdict).toEqual({ ok: true });
    expect(decide(state({ recent: [{ h, at: T - 29_999 }] }), p, T, digestOf('hello there friend')).verdict).toMatchObject({ ok: false, retryAfterMs: 1 });
    expect(decide(state({ recent: [{ h, at: T - 30_000 }] }), p, T, digestOf('hello there friend')).verdict).toEqual({ ok: true });
  });

  it('a digest stamped after now is stale: the repeat is accepted', () => {
    expect(decide(state({ recent: [{ h, at: T + 100 }] }), p, T, digestOf('hello there friend')).verdict).toEqual({ ok: true });
  });

  it('a line too short to be a repeat (a digest of null) is never refused', () => {
    const s = state({ recent: [{ h, at: T }] });
    expect(decide(s, p, T, () => null).verdict).toEqual({ ok: true });
    expect(repeatDigest('gg')).toBeNull();
    expect(repeatDigest('ok')).toBeNull();
    expect(repeatDigest('abc')).not.toBeNull();
  });

  it('the digest is asked for only when it is needed: not with repeats off, not with nothing recent, once otherwise', () => {
    expect(decide(state({ recent: [{ h, at: T }] }), OFF, T, never, 0).verdict).toEqual({ ok: true });
    expect(decide(state({ recent: [] }), p, T, never).verdict).toEqual({ ok: true });
    let asked = 0;
    decide(state({ recent: [{ h, at: T - 1 }] }), p, T, () => (asked++, null));
    expect(asked).toBe(1);
  });
});

describe('decide: order and purity', () => {
  const all = pace({ slowModeMs: 3000, burst: { lines: 2, windowMs: 10_000 }, duplicateWindowMs: 30_000 });
  const h = repeatDigest('the same line again') as string;

  it('slow_mode beats flood and flood beats duplicate', () => {
    const everything = state({ lastAt: T - 100, stamps: [T - 2000, T - 100], recent: [{ h, at: T - 100 }] });
    expect(refused(decide(everything, all, T, digestOf('the same line again'))).reason).toBe('slow_mode');
    const noSlow = state({ lastAt: T - 4000, stamps: [T - 5000, T - 4000], recent: [{ h, at: T - 4000 }] });
    expect(refused(decide(noSlow, all, T, digestOf('the same line again'))).reason).toBe('flood');
    const justRepeat = state({ lastAt: T - 4000, stamps: [T - 4000], recent: [{ h, at: T - 4000 }] });
    expect(refused(decide(justRepeat, all, T, digestOf('the same line again'))).reason).toBe('duplicate');
  });

  it('decide changes nothing it is given (a frozen state is fine) and gives the same answer twice', () => {
    const s = freeze(state({ lastAt: T - 100, stamps: [T - 2000, T - 100], recent: [{ h, at: T - 100 }] }));
    const a = decide(s, all, T, digestOf('x'.repeat(10)));
    const b = decide(s, all, T, digestOf('x'.repeat(10)));
    expect(b).toEqual(a);
    expect(s.stamps).toEqual([T - 2000, T - 100]);
  });

  it('whatever the state and clock, a refusal waits a whole number of ms from 1 to the refusing window (a fuzz over 2000 states)', () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 2000; i++) {
      const now = T + (next() % 20_000) - 10_000;
      const s = state({
        lastAt: T + (next() % 40_000) - 20_000,
        stamps: Array.from({ length: next() % 5 }, () => T + (next() % 40_000) - 20_000),
        recent: next() % 2 === 0 ? [{ h, at: T + (next() % 40_000) - 20_000 }] : [],
      });
      const v = decide(s, all, now, digestOf('the same line again')).verdict;
      if (v.ok) continue;
      expect(Number.isInteger(v.retryAfterMs)).toBe(true);
      expect(v.retryAfterMs).toBeGreaterThanOrEqual(1);
      expect(v.retryAfterMs).toBeLessThanOrEqual(v.reason === 'flood' ? 10_000 : v.reason === 'duplicate' ? 30_000 : 3000);
    }
  });
});

describe('commitState', () => {
  it('a first line makes the state: lastAt now, one stamp, the digest, no flood signal; the previous state is not changed', () => {
    const p = pace({ slowModeMs: 1000, burst: { lines: 3, windowMs: 10_000 }, duplicateWindowMs: 30_000 });
    const h = repeatDigest('first line here') as string;
    const next = commitState(null, p, T, h);
    expect(next).toEqual({ lastAt: T, stamps: [T], recent: [{ h, at: T }], floodSignalAt: null });
    const prev = freeze(next);
    const after = commitState(prev, p, T + 1000, null);
    expect(after.lastAt).toBe(T + 1000);
    expect(prev.lastAt).toBe(T);
    expect(after).not.toBe(prev);
  });

  it('stamps keep the burst\'s last N inside the window, oldest first; with burst off they are dropped', () => {
    const p = pace({ burst: { lines: 3, windowMs: 10_000 } });
    let s: KeyState | null = null;
    for (const dt of [0, 1000, 2000, 3000]) s = commitState(s, p, T + dt, null);
    expect(s?.stamps).toEqual([T + 1000, T + 2000, T + 3000]);
    expect(commitState(s, p, T + 20_000, null).stamps).toEqual([T + 20_000]);
    expect(commitState(s, pace({ slowModeMs: 500 }), T + 4000, null).stamps).toEqual([]);
  });

  it('stamps and digests stamped after now are dropped (a clock that stepped back); the commit starts clean', () => {
    const p = pace({ burst: { lines: 3, windowMs: 10_000 }, duplicateWindowMs: 30_000 });
    const h = repeatDigest('some earlier line') as string;
    const s = commitState(state({ stamps: [T + 5000, T + 6000], recent: [{ h, at: T + 5000 }] }), p, T, null);
    expect(s.stamps).toEqual([T]);
    expect(s.recent).toEqual([]);
  });

  it('recent keeps the last 8 distinct digests inside the window; a repeat replaces its entry instead of stacking; null never pushes; repeats off drops them', () => {
    const p = pace({ duplicateWindowMs: 60_000 });
    let s: KeyState | null = null;
    for (let i = 0; i < 12; i++) s = commitState(s, p, T + i * 1000, repeatDigest(`line number ${i} here`));
    expect(s?.recent).toHaveLength(8);
    expect(s?.recent[0]?.at).toBe(T + 4000);
    const h = repeatDigest('line number 11 here') as string;
    const again = commitState(s, p, T + 20_000, h);
    expect(again.recent.filter((e) => e.h === h)).toHaveLength(1);
    expect(again.recent.at(-1)).toEqual({ h, at: T + 20_000 });
    expect(commitState(s, p, T + 21_000, null).recent).toHaveLength(8);
    expect(commitState(s, pace({ slowModeMs: 100 }), T + 21_000, h).recent).toEqual([]);
    // an entry past the window goes
    expect(commitState(s, p, T + 200_000, null).recent).toEqual([]);
  });

  it('the flood signal time rides along unchanged', () => {
    const p = pace({ burst: { lines: 2, windowMs: 10_000 } });
    expect(commitState(state({ floodSignalAt: T - 77 }), p, T, null).floodSignalAt).toBe(T - 77);
  });
});

describe('the digest', () => {
  it('is 16 hex characters of the normalized line; the same line in other spelling is the same digest; another line is another; nothing of the text is in it', () => {
    const h = repeatDigest('Hello World');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(repeatDigest('hello,   WORLD!!')).toBe(h);
    expect(repeatDigest('hello there')).not.toBe(h);
    expect(h).not.toContain('hello');
  });

  it('normalizeForRepeat keeps lower-cased NFKC letters, digits and combining marks; variation selectors and punctuation go', () => {
    expect(normalizeForRepeat('Ab 1! ＡＢ c')).toBe('ab1abc');
    expect(normalizeForRepeat('1️⃣')).toBe(normalizeForRepeat('1⃣'));
    expect(repeatDigest('😀😀😀')).toBeNull();
    expect(() => repeatDigest('x'.repeat(200) + '\uD800')).not.toThrow();
  });
});
