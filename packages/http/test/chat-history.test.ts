import { describe, expect, expectTypeOf, it } from 'vitest';
import { EVIDENCE_MAX_AGE_MS } from '@chatwarden/core';
import { createRing, HISTORY_LINES_DEFAULT, HISTORY_LINES_MAX, resolveHistory } from '../src/chat/history.js';
import type { Ring, RingLine } from '../src/chat/history.js';

const T0 = 1_800_000_000_000;
const MIN = 60_000;

function clocked() {
  const clock = { t: T0, now: () => clock.t };
  return clock;
}

const mk = (n: number, at: number, seat = `seat-${n}`): RingLine => ({ id: String(n), at, seat, name: `name-${n}`, text: `line ${n} snerp` });

describe('createRing', () => {
  it('keeps the last N and drops the oldest', () => {
    const clock = clocked();
    const ring = createRing({ lines: 3, maxAgeMs: 15 * MIN, now: clock.now });
    for (let i = 1; i <= 5; i += 1) ring.append(mk(i, clock.t));
    expect(ring.snapshot().map((l) => l.id)).toEqual(['3', '4', '5']);
    expect(ring.size()).toBe(3);
    ring.append(mk(6, clock.t));
    expect(ring.snapshot().map((l) => l.id)).toEqual(['4', '5', '6']);
  });

  it('a ring of one line holds exactly the newest', () => {
    const clock = clocked();
    const ring = createRing({ lines: 1, maxAgeMs: MIN, now: clock.now });
    ring.append(mk(1, clock.t));
    ring.append(mk(2, clock.t));
    expect(ring.snapshot().map((l) => l.id)).toEqual(['2']);
  });

  it('snapshot is oldest first', () => {
    const clock = clocked();
    const ring = createRing({ lines: 10, maxAgeMs: 15 * MIN, now: clock.now });
    for (let i = 1; i <= 4; i += 1) {
      ring.append(mk(i, clock.t));
      clock.t += 10;
    }
    expect(ring.snapshot().map((l) => l.id)).toEqual(['1', '2', '3', '4']);
  });

  it('a line exactly maxAgeMs old is kept, one millisecond older is dropped', () => {
    const clock = clocked();
    const ring = createRing({ lines: 10, maxAgeMs: 15 * MIN, now: clock.now });
    ring.append(mk(1, clock.t));
    clock.t += 15 * MIN; // exactly the cutoff
    expect(ring.snapshot().map((l) => l.id)).toEqual(['1']);
    expect(ring.byId('1')).toBeDefined();
    expect(ring.size()).toBe(1);
    clock.t += 1; // one millisecond older
    expect(ring.snapshot()).toEqual([]);
    expect(ring.byId('1')).toBeUndefined();
    expect(ring.size()).toBe(0);
  });

  it('a quiet ring empties on read', () => {
    const clock = clocked();
    const ring = createRing({ lines: 50, maxAgeMs: 15 * MIN, now: clock.now });
    for (let i = 1; i <= 10; i += 1) ring.append(mk(i, clock.t));
    clock.t += 15 * MIN + 1;
    expect(ring.size()).toBe(0);
    expect(ring.snapshot()).toEqual([]);
  });

  it('append prunes by age too, so an old line is gone before the next one lands', () => {
    const clock = clocked();
    const ring = createRing({ lines: 50, maxAgeMs: 2 * MIN, now: clock.now });
    ring.append(mk(1, clock.t));
    clock.t += MIN;
    ring.append(mk(2, clock.t));
    clock.t += MIN + 1; // line 1 is now 2 min + 1 ms old, line 2 is 1 min + 1 ms
    ring.append(mk(3, clock.t));
    expect(ring.snapshot().map((l) => l.id)).toEqual(['2', '3']);
  });

  it('a snapshot never holds a line older than the window, whatever the order of reads and writes', () => {
    const clock = clocked();
    const maxAgeMs = 5 * MIN;
    const ring = createRing({ lines: 20, maxAgeMs, now: clock.now });
    let n = 0;
    for (let step = 0; step < 200; step += 1) {
      clock.t += 37_000;
      if (step % 3 !== 0) ring.append(mk((n += 1), clock.t));
      for (const line of ring.snapshot()) expect(clock.t - line.at).toBeLessThanOrEqual(maxAgeMs);
      expect(ring.size()).toBeLessThanOrEqual(20);
    }
  });

  it('byId and bySeat follow pruning', () => {
    const clock = clocked();
    const ring = createRing({ lines: 3, maxAgeMs: 15 * MIN, now: clock.now });
    ring.append(mk(1, clock.t, 'a'));
    ring.append(mk(2, clock.t, 'b'));
    ring.append(mk(3, clock.t, 'a'));
    expect(ring.byId('2')?.seat).toBe('b');
    expect(ring.bySeat('a').map((l) => l.id)).toEqual(['1', '3']);
    ring.append(mk(4, clock.t, 'a')); // pushes line 1 out by count
    expect(ring.byId('1')).toBeUndefined();
    expect(ring.bySeat('a').map((l) => l.id)).toEqual(['3', '4']);
    clock.t += 15 * MIN + 1; // everything out by age
    expect(ring.byId('4')).toBeUndefined();
    expect(ring.bySeat('a')).toEqual([]);
    expect(ring.bySeat('nobody')).toEqual([]);
    expect(ring.byId('nope')).toBeUndefined();
  });

  it('byId finds the right line among many, and an unknown id is undefined', () => {
    const clock = clocked();
    const ring = createRing({ lines: 100, maxAgeMs: 15 * MIN, now: clock.now });
    for (let i = 1; i <= 100; i += 1) ring.append(mk(i, clock.t));
    expect(ring.byId('1')?.text).toBe('line 1 snerp');
    expect(ring.byId('100')?.text).toBe('line 100 snerp');
    expect(ring.byId('101')).toBeUndefined();
    expect(ring.byId('__proto__')).toBeUndefined();
    expect(ring.byId('constructor')).toBeUndefined();
  });

  it('snapshot returns copies: mutating one changes nothing', () => {
    const clock = clocked();
    const ring = createRing({ lines: 5, maxAgeMs: 15 * MIN, now: clock.now });
    ring.append(mk(1, clock.t));
    const first = ring.snapshot();
    (first[0] as RingLine).text = 'tampered';
    (first[0] as RingLine).seat = 'tampered';
    first.push(mk(99, clock.t));
    expect(ring.snapshot()).toEqual([mk(1, T0)]);
    expect(ring.size()).toBe(1);
    const byId = ring.byId('1') as RingLine;
    byId.text = 'tampered';
    expect(ring.byId('1')?.text).toBe('line 1 snerp');
    const bySeat = ring.bySeat('seat-1');
    (bySeat[0] as RingLine).name = 'tampered';
    expect(ring.bySeat('seat-1')[0]?.name).toBe('name-1');
  });

  it('append copies the line in: mutating the original later changes nothing', () => {
    const clock = clocked();
    const ring = createRing({ lines: 5, maxAgeMs: 15 * MIN, now: clock.now });
    const line = mk(1, clock.t);
    ring.append(line);
    line.text = 'changed after';
    line.seat = 'changed after';
    expect(ring.byId('1')?.text).toBe('line 1 snerp');
    expect(ring.byId('1')?.seat).toBe('seat-1');
  });

  it('append keeps only the five documented fields', () => {
    const clock = clocked();
    const ring = createRing({ lines: 5, maxAgeMs: 15 * MIN, now: clock.now });
    ring.append({ ...mk(1, clock.t), extra: 'drakkuun', subject: 's_secret' } as RingLine);
    expect(Object.keys(ring.snapshot()[0] as RingLine).sort()).toEqual(['at', 'id', 'name', 'seat', 'text']);
  });

  it('size is 0 after everything ages out, and a new line then starts the ring again', () => {
    const clock = clocked();
    const ring = createRing({ lines: 5, maxAgeMs: MIN, now: clock.now });
    expect(ring.size()).toBe(0);
    ring.append(mk(1, clock.t));
    ring.append(mk(2, clock.t));
    expect(ring.size()).toBe(2);
    clock.t += MIN + 1;
    expect(ring.size()).toBe(0);
    ring.append(mk(3, clock.t));
    expect(ring.snapshot().map((l) => l.id)).toEqual(['3']);
  });

  it('a clock that steps backwards keeps lines (nothing is dropped early) and never throws', () => {
    const clock = clocked();
    const ring = createRing({ lines: 5, maxAgeMs: 15 * MIN, now: clock.now });
    ring.append(mk(1, clock.t));
    clock.t -= 10 * MIN; // the clock jumps back: the line is "from the future"
    expect(() => ring.snapshot()).not.toThrow();
    expect(ring.snapshot().map((l) => l.id)).toEqual(['1']);
    expect(() => ring.append(mk(2, clock.t))).not.toThrow();
    expect(ring.snapshot().map((l) => l.id)).toEqual(['1', '2']);
    expect(ring.byId('1')).toBeDefined();
    expect(ring.size()).toBe(2);
    clock.t -= 24 * 60 * MIN;
    expect(ring.size()).toBe(2);
    // and forward again, the age rule applies from the original stamps
    clock.t = T0 + 15 * MIN + 1;
    expect(ring.snapshot()).toEqual([]);
  });

  it('a line with a stamp that is not a finite number is stamped with the ring clock, so it can age out', () => {
    const clock = clocked();
    const ring = createRing({ lines: 5, maxAgeMs: MIN, now: clock.now });
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined as unknown as number, '5' as unknown as number]) {
      ring.append({ ...mk(1, 0), id: String(String(at)), at });
    }
    expect(ring.size()).toBe(5);
    expect(ring.snapshot().every((l) => l.at === T0)).toBe(true);
    clock.t += MIN + 1;
    expect(ring.size()).toBe(0);
  });

  it('a line is dropped, not stored, when even the ring clock gives no finite time', () => {
    const ring = createRing({ lines: 5, maxAgeMs: MIN, now: () => Number.NaN });
    expect(() => ring.append(mk(1, Number.NaN))).not.toThrow();
    expect(ring.size()).toBe(0);
  });

  it('the clock is read on every call, not captured', () => {
    const clock = clocked();
    let reads = 0;
    const ring = createRing({
      lines: 5,
      maxAgeMs: MIN,
      now: () => {
        reads += 1;
        return clock.t;
      },
    });
    ring.append(mk(1, clock.t));
    const afterAppend = reads;
    ring.snapshot();
    ring.size();
    ring.byId('1');
    ring.bySeat('seat-1');
    expect(reads).toBeGreaterThanOrEqual(afterAppend + 4);
  });

  it('bad options are a RangeError that never carries the value', () => {
    const now = (): number => T0;
    for (const lines of [0, -1, 1.5, Number.NaN, Infinity, '5' as unknown as number]) {
      expect(() => createRing({ lines, maxAgeMs: MIN, now })).toThrow(RangeError);
    }
    for (const maxAgeMs of [0, -1, 0.5, Number.NaN, Infinity, '5' as unknown as number]) {
      expect(() => createRing({ lines: 5, maxAgeMs, now })).toThrow(RangeError);
    }
    expect(() => createRing({ lines: 5, maxAgeMs: MIN, now: 'x' as unknown as () => number })).toThrow(TypeError);
  });

  it('the Ring type is the documented shape', () => {
    expectTypeOf<Ring>().toEqualTypeOf<{
      append(line: RingLine): void;
      snapshot(): RingLine[];
      byId(id: string): RingLine | undefined;
      bySeat(seat: string): RingLine[];
      size(): number;
    }>();
    expectTypeOf<RingLine>().toEqualTypeOf<{ id: string; at: number; seat: string; name: string; text: string }>();
  });
});

describe('resolveHistory', () => {
  it('resolveHistory: defaults 50 and EVIDENCE_MAX_AGE_MS', () => {
    expect(HISTORY_LINES_DEFAULT).toBe(50);
    expect(HISTORY_LINES_MAX).toBe(100);
    expect(resolveHistory(undefined)).toEqual({ lines: 50, maxAgeMs: EVIDENCE_MAX_AGE_MS });
    expect(resolveHistory({})).toEqual({ lines: 50, maxAgeMs: EVIDENCE_MAX_AGE_MS });
    expect(resolveHistory({ lines: undefined, maxAgeMs: undefined })).toEqual({ lines: 50, maxAgeMs: EVIDENCE_MAX_AGE_MS });
    expect(EVIDENCE_MAX_AGE_MS).toBe(900_000);
  });

  it('the boundaries are accepted', () => {
    expect(resolveHistory({ lines: 1 })).toEqual({ lines: 1, maxAgeMs: EVIDENCE_MAX_AGE_MS });
    expect(resolveHistory({ lines: 100 })).toEqual({ lines: 100, maxAgeMs: EVIDENCE_MAX_AGE_MS });
    expect(resolveHistory({ maxAgeMs: 1000 })).toEqual({ lines: 50, maxAgeMs: 1000 });
    expect(resolveHistory({ maxAgeMs: EVIDENCE_MAX_AGE_MS })).toEqual({ lines: 50, maxAgeMs: EVIDENCE_MAX_AGE_MS });
    expect(resolveHistory({ lines: 7, maxAgeMs: 60_000 })).toEqual({ lines: 7, maxAgeMs: 60_000 });
  });

  it('lines 0, 101, 1.5, NaN, "5" refused', () => {
    for (const lines of [0, 101, 1.5, Number.NaN, '5', -1, Infinity, null, {}, [], true]) {
      expect(() => resolveHistory({ lines: lines as number })).toThrow(RangeError);
    }
  });

  it('maxAgeMs 999 and EVIDENCE_MAX_AGE_MS + 1 refused', () => {
    for (const maxAgeMs of [999, EVIDENCE_MAX_AGE_MS + 1, 0, -5, 1000.5, Number.NaN, '60000', Infinity, null, {}, true]) {
      expect(() => resolveHistory({ maxAgeMs: maxAgeMs as number })).toThrow(RangeError);
    }
  });

  it('a message never contains the bad value', () => {
    const bad: Array<[Parameters<typeof resolveHistory>[0], string]> = [
      [{ lines: 987_654 }, '987654'],
      [{ lines: 1.23456 }, '1.23456'],
      [{ lines: 'vlemmo-secret' as unknown as number }, 'vlemmo-secret'],
      [{ maxAgeMs: 123_456_789 }, '123456789'],
      [{ maxAgeMs: 'quissel-secret' as unknown as number }, 'quissel-secret'],
    ];
    for (const [input, needle] of bad) {
      let message = '';
      try {
        resolveHistory(input);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(needle);
      expect(message).not.toMatch(/987[ ,_]?654|123[ ,_]?456[ ,_]?789/);
    }
  });

  it('input that is not an object is refused without echoing it', () => {
    for (const input of ['fenrisk', 5, true, null]) {
      let message = '';
      try {
        resolveHistory(input as never);
      } catch (err) {
        expect(err).toBeInstanceOf(TypeError);
        message = (err as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('fenrisk');
    }
  });

  it('the result feeds createRing, and the limits it names are the ones createRing enforces', () => {
    const clock = clocked();
    const { lines, maxAgeMs } = resolveHistory({ lines: HISTORY_LINES_MAX });
    const ring = createRing({ lines, maxAgeMs, now: clock.now });
    for (let i = 1; i <= HISTORY_LINES_MAX + 20; i += 1) ring.append(mk(i, clock.t));
    expect(ring.size()).toBe(HISTORY_LINES_MAX);
  });
});
