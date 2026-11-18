import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import type { PaceStateRow, Store } from '../src/types.js';
import type { ResolvedPace } from '../src/pace.js';
import type { PaceKey, PaceVerdict } from '../src/pacing.js';
import { createSharedPacer } from '../src/pacingShared.js';
import { purge } from '../src/retention.js';
import type { PurgeResult } from '../src/retention.js';

// S4: the shared pacer: the same decisions as the in-memory pacer, with the state in the store, so two processes on one store judge one player's lines together.

const T = 1_800_000_000_000;
const HOUR = 3_600_000;
const OFF: ResolvedPace = { slowModeMs: null, burst: null, duplicateWindowMs: null };
const KEY: PaceKey = { roomId: 'R1', who: 's_aaaaaaaaaaaaaaaaaaaaaa' };

interface Spy {
  store: MemoryStore;
  calls: string[];
}
/** A memory store that records which pace methods were called. */
function spyStore(): Spy {
  const store = new MemoryStore();
  const calls: string[] = [];
  for (const m of ['paceLoad', 'paceUpdate', 'paceDropRoom', 'paceSweep'] as const) {
    const real = store[m].bind(store) as (...a: unknown[]) => unknown;
    (store as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
      calls.push(`${m}${m === 'paceSweep' ? `:${String(args[0])}` : ''}`);
      return real(...args);
    };
  }
  return { store, calls };
}

function setup(initial: Partial<ResolvedPace> = {}, spy: Spy = spyStore()) {
  const clock = { t: T, now: () => clock.t };
  const cfg = { pace: { ...OFF, ...initial } as ResolvedPace };
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const pacer = createSharedPacer({ clock, settings: () => cfg.pace, store: spy.store, logger: { warn: (e, d) => void logged.push([e, d]) } });
  const send = (line: string, k: PaceKey = KEY): PaceVerdict => {
    const v = pacer.check(k, line);
    if (v.ok) pacer.commit(k, line);
    return v;
  };
  return { clock, cfg, pacer, send, spy, logged };
}

const refusal = (v: PaceVerdict) => {
  if (v.ok) throw new Error('expected a refusal');
  return v;
};

describe('createSharedPacer: construction', () => {
  it('a store without the methods is a plain message naming the first missing one; a bad argument is a TypeError', () => {
    const clock = { now: () => T };
    const settings = () => OFF;
    const bare = {} as Store;
    expect(() => createSharedPacer({ clock, settings, store: bare })).toThrow(/paceLoad/);
    const half = { paceLoad: () => null, paceUpdate: () => ({}) } as unknown as Store;
    expect(() => createSharedPacer({ clock, settings, store: half })).toThrow(/paceDropRoom/);
    const noSweep = { paceLoad: () => null, paceUpdate: () => ({}), paceDropRoom: () => 0 } as unknown as Store;
    expect(() => createSharedPacer({ clock, settings, store: noSweep })).toThrow(/paceSweep/);
    expect(() => createSharedPacer({ clock, settings: 5 as never, store: new MemoryStore() })).toThrow(TypeError);
    expect(() => createSharedPacer(undefined as never)).toThrow(TypeError);
  });
});

describe('the same decisions as the in-memory pacer', () => {
  it('slow mode: refused inside the gap with the exact wait, accepted at the gap; a refused line does not move the time', () => {
    const w = setup({ slowModeMs: 3000 });
    expect(w.send('one')).toEqual({ ok: true });
    w.clock.t += 1000;
    expect(refusal(w.send('two'))).toEqual({ ok: false, reason: 'slow_mode', retryAfterMs: 2000, signalFlood: false });
    w.clock.t += 2000;
    expect(w.send('three').ok).toBe(true);
  });

  it('burst: the (N+1)th line is refused with oldest + window - now; it is accepted once the oldest ages out', () => {
    const w = setup({ burst: { lines: 3, windowMs: 10_000 } });
    for (const t of ['a', 'b', 'c']) {
      expect(w.send(t).ok).toBe(true);
      w.clock.t += 1000;
    }
    expect(refusal(w.send('d'))).toMatchObject({ reason: 'flood', retryAfterMs: 7000 });
    w.clock.t += 7000;
    expect(w.send('e').ok).toBe(true);
  });

  it('repeats: the same line in other spelling is refused until the window ends; another line is fine', () => {
    const w = setup({ duplicateWindowMs: 30_000 });
    expect(w.send('Hello there friend').ok).toBe(true);
    w.clock.t += 5000;
    expect(refusal(w.send('hello, THERE friend!'))).toMatchObject({ reason: 'duplicate', retryAfterMs: 25_000 });
    expect(w.send('a different line').ok).toBe(true);
    w.clock.t += 31_000;
    expect(w.send('hello there friend').ok).toBe(true);
  });

  it('a probation floor paces a player even when the room\'s own pace is off', () => {
    const w = setup();
    expect(w.pacer.check(KEY, 'x', 5000).ok).toBe(true);
    w.pacer.commit(KEY, 'x', 5000);
    w.clock.t += 1000;
    expect(refusal(w.pacer.check(KEY, 'y', 5000))).toMatchObject({ reason: 'probation', retryAfterMs: 4000 });
  });

  it('people and rooms are separate keys; a guest key and a person key are separate', () => {
    const w = setup({ slowModeMs: 5000 });
    w.send('one');
    expect(w.send('x', { roomId: 'R2', who: KEY.who }).ok).toBe(true);
    expect(w.send('x', { roomId: 'R1', who: 's_other' }).ok).toBe(true);
    expect(w.send('x', { roomId: 'R1', who: 'seat:p1' }).ok).toBe(true);
    expect(w.send('x', { roomId: 'R1', who: 'seat:p2' }).ok).toBe(true);
    expect(w.send('again').ok).toBe(false);
    expect(w.send('x', { roomId: 'R1', who: 'seat:p1' }).ok).toBe(false);
  });

  it('active follows the settings of the room; size is 0 (nothing is held in memory)', () => {
    const w = setup();
    expect(w.pacer.active('R1')).toBe(false);
    w.cfg.pace = { ...OFF, slowModeMs: 1000 };
    expect(w.pacer.active('R1')).toBe(true);
    w.send('one');
    expect(w.pacer.size()).toBe(0);
  });

  it('a settings change applies at once: turning a check off stops it; turning one on works from what was recorded', () => {
    const w = setup({ slowModeMs: 5000, burst: { lines: 2, windowMs: 10_000 } });
    w.send('one');
    w.clock.t += 100;
    expect(w.send('two').ok).toBe(false);
    w.cfg.pace = { ...OFF, burst: { lines: 2, windowMs: 10_000 } };
    expect(w.send('two').ok).toBe(true);
    expect(w.send('three').ok).toBe(false);
  });
});

describe('what is stored', () => {
  it('one row per (room, who): the times and the digests, never the line text', () => {
    const w = setup({ slowModeMs: 1000, burst: { lines: 3, windowMs: 10_000 }, duplicateWindowMs: 30_000 });
    w.send('a line that mentions secret-marker-text');
    w.clock.t += 2000;
    w.send('another line entirely here');
    const row = w.spy.store.paceLoad(KEY.roomId, KEY.who) as PaceStateRow;
    expect(row.stamps).toEqual([T, T + 2000]);
    expect(row.lastAt).toBe(T + 2000);
    expect(row.touchedAt).toBe(T + 2000);
    expect(row.recent).toHaveLength(2);
    for (const e of row.recent) expect(e.h).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(row)).not.toContain('secret-marker');
    expect(JSON.stringify(w.spy.store)).not.toContain('secret-marker');
  });

  it('holdsText: the digest memo holds a line only between a check that passed and its commit or discard', () => {
    const w = setup({ duplicateWindowMs: 30_000 });
    w.pacer.commit(KEY, 'first line of text', undefined);
    expect(w.pacer.holdsText()).toBe(false);
    expect(w.pacer.check(KEY, 'second line of text').ok).toBe(true);
    expect(w.pacer.holdsText()).toBe(true);
    w.pacer.commit(KEY, 'second line of text');
    expect(w.pacer.holdsText()).toBe(false);
    w.clock.t += 1;
    w.pacer.check(KEY, 'third line of text');
    expect(w.pacer.holdsText()).toBe(true);
    w.pacer.discard();
    expect(w.pacer.holdsText()).toBe(false);
    // a refused check leaves nothing behind either
    w.pacer.commit(KEY, 'fourth line of text');
    expect(w.pacer.check(KEY, 'fourth line of text').ok).toBe(false);
    expect(w.pacer.holdsText()).toBe(false);
  });

  it('a room with every check off touches the store not at all: no load, no update', () => {
    const w = setup();
    for (let i = 0; i < 5; i++) {
      expect(w.send(`line number ${i}`).ok).toBe(true);
      w.clock.t += 10;
    }
    expect(w.spy.calls).toEqual([]);
  });

  it('a check with a state-less player reads once and writes nothing; a commit writes once', () => {
    const w = setup({ slowModeMs: 1000 });
    w.pacer.check(KEY, 'one');
    expect(w.spy.calls).toEqual(['paceLoad']);
    w.pacer.commit(KEY, 'one');
    expect(w.spy.calls).toEqual(['paceLoad', 'paceUpdate']);
  });
});

describe('the flood signal', () => {
  const P = { burst: { lines: 2, windowMs: 10_000 } } as const;

  it('is written through paceUpdate and fires once per burst window, again after the window', () => {
    const w = setup(P);
    w.send('a');
    w.send('b');
    const first = refusal(w.pacer.check(KEY, 'c'));
    expect(first.signalFlood).toBe(true);
    expect(w.spy.store.paceLoad(KEY.roomId, KEY.who)?.floodSignalAt).toBe(T);
    expect(refusal(w.pacer.check(KEY, 'c')).signalFlood).toBe(false);
    w.clock.t += 5000;
    expect(refusal(w.pacer.check(KEY, 'c')).signalFlood).toBe(false);
    w.clock.t += 5000;
    w.send('a2');
    w.send('b2');
    expect(refusal(w.pacer.check(KEY, 'c')).signalFlood).toBe(true);
  });

  it('across two pacers on one store (two processes) one flood is signalled once per window', () => {
    const spy = spyStore();
    const a = setup(P, spy);
    const b = setup(P, spy);
    a.send('one');
    b.send('two');
    // both are over the limit now: whichever asks first signals, the other does not
    const verdicts = [refusal(a.pacer.check(KEY, 'x')).signalFlood, refusal(b.pacer.check(KEY, 'y')).signalFlood, refusal(a.pacer.check(KEY, 'z')).signalFlood];
    expect(verdicts.filter(Boolean)).toHaveLength(1);
  });

  it('slow mode and duplicate refusals write nothing', () => {
    const w = setup({ slowModeMs: 5000, duplicateWindowMs: 30_000 });
    w.send('hello there friend');
    const before = w.spy.calls.length;
    w.pacer.check(KEY, 'hello there friend');
    expect(w.spy.calls.slice(before)).toEqual(['paceLoad']);
  });
});

describe('two pacers on one store are one pacer', () => {
  it('a player alternating lines between them is slowed by the burst limit as if on one process; a repeat sent to the second after the first is refused duplicate', () => {
    const spy = spyStore();
    const a = setup({ burst: { lines: 3, windowMs: 10_000 }, duplicateWindowMs: 30_000 }, spy);
    const b = setup({ burst: { lines: 3, windowMs: 10_000 }, duplicateWindowMs: 30_000 }, spy);
    expect(a.send('first line of text').ok).toBe(true);
    expect(b.send('second line of text').ok).toBe(true);
    expect(a.send('third line of text').ok).toBe(true);
    expect(refusal(b.send('fourth line of text'))).toMatchObject({ reason: 'flood' });
    expect(refusal(a.send('fifth line of text'))).toMatchObject({ reason: 'flood' });
    a.clock.t += 31_000;
    b.clock.t += 31_000;
    expect(a.send('a repeated line here').ok).toBe(true);
    expect(refusal(b.send('A repeated line here!'))).toMatchObject({ reason: 'duplicate' });
  });
});

describe('rooms, people and the sweep', () => {
  it('dropRoom drops the room\'s rows in the store and leaves the others', () => {
    const w = setup({ slowModeMs: 1000 });
    w.send('x', { roomId: 'R1', who: 'a' });
    w.send('x', { roomId: 'R2', who: 'a' });
    w.pacer.dropRoom('R1');
    expect(w.spy.store.paceLoad('R1', 'a')).toBeNull();
    expect(w.spy.store.paceLoad('R2', 'a')).not.toBeNull();
    expect(w.spy.calls).toContain('paceDropRoom');
  });

  it('forgetPeople needs no call (the store erases the person\'s rows itself) and does not throw', () => {
    const w = setup({ slowModeMs: 1000 });
    w.send('x');
    const before = w.spy.calls.length;
    expect(() => w.pacer.forgetPeople(new Set([KEY.who]))).not.toThrow();
    expect(w.spy.calls.length).toBe(before);
  });

  it('every 256 commits the pacer sweeps rows untouched for an hour (and only then)', () => {
    const w = setup({ slowModeMs: 1000 });
    for (let i = 0; i < 255; i++) w.pacer.commit({ roomId: 'R1', who: `p${i % 10}` }, 'x');
    expect(w.spy.calls.filter((c) => c.startsWith('paceSweep'))).toEqual([]);
    w.pacer.commit({ roomId: 'R1', who: 'p0' }, 'x');
    expect(w.spy.calls.filter((c) => c.startsWith('paceSweep'))).toEqual([`paceSweep:${T - HOUR}`]);
    for (let i = 0; i < 256; i++) w.pacer.commit({ roomId: 'R1', who: 'p0' }, 'x');
    expect(w.spy.calls.filter((c) => c.startsWith('paceSweep'))).toHaveLength(2);
  });

  it('a sweep that fails is swallowed and logged, and the commit still counts', () => {
    const w = setup({ slowModeMs: 1000 });
    w.spy.store.paceSweep = () => {
      throw new Error('disk full');
    };
    for (let i = 0; i < 256; i++) w.pacer.commit(KEY, 'x');
    expect(w.spy.store.paceLoad(KEY.roomId, KEY.who)?.lastAt).toBe(T);
    expect(JSON.stringify(w.logged)).not.toContain('disk full');
  });
});

describe('purge', () => {
  const rowAt = (touchedAt: number, who: string): PaceStateRow => ({ roomId: 'R', who, lastAt: touchedAt, stamps: [touchedAt], recent: [], floodSignalAt: null, touchedAt });

  it('sweeps rows older than an hour, keeps newer ones, and reports the count', async () => {
    const store = new MemoryStore();
    store.paceUpdate('R', 'old', () => rowAt(T - HOUR - 1, 'old'));
    store.paceUpdate('R', 'edge', () => rowAt(T - HOUR, 'edge'));
    store.paceUpdate('R', 'new', () => rowAt(T - 1000, 'new'));
    const res: PurgeResult = await purge(store, T);
    expect(res.pace).toBe(1);
    expect(store.paceLoad('R', 'old')).toBeNull();
    expect(store.paceLoad('R', 'edge')).not.toBeNull();
    expect(store.paceLoad('R', 'new')).not.toBeNull();
    expect((await purge(store, T)).pace).toBe(0);
  });

  it('a store without the methods purges the rest and says 0', async () => {
    const store = new MemoryStore();
    const bare = Object.create(store) as MemoryStore;
    (bare as unknown as Record<string, unknown>).paceSweep = undefined;
    const res = await purge(bare, T);
    expect(res.pace).toBe(0);
    expect(typeof res.reports).toBe('number');
  });
});

describe('a failing store', () => {
  it('check and commit fail open and log pace_failed by class, at most once a minute', () => {
    const w = setup({ slowModeMs: 1000 });
    const boom = () => {
      throw new TypeError('secret detail of the failure');
    };
    w.spy.store.paceLoad = boom;
    w.spy.store.paceUpdate = boom;
    for (let i = 0; i < 5; i++) {
      expect(w.pacer.check(KEY, 'x')).toEqual({ ok: true });
      expect(() => w.pacer.commit(KEY, 'x')).not.toThrow();
    }
    const lines = w.logged.filter(([e]) => e === 'chatwarden.pace_failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toEqual({ error: 'TypeError' });
    expect(JSON.stringify(w.logged)).not.toContain('secret detail');
    w.clock.t += 61_000;
    w.pacer.check(KEY, 'x');
    expect(w.logged.filter(([e]) => e === 'chatwarden.pace_failed')).toHaveLength(2);
    expect(w.logged.at(-1)?.[1]).toMatchObject({ error: 'TypeError' });
  });
});
