import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import type { ResolvedPace } from '../src/pace.js';
import { createPacer } from '../src/pacing.js';
import type { PaceKey, Pacer, PaceVerdict } from '../src/pacing.js';
import { createSharedPacer } from '../src/pacingShared.js';

// S4: one script of 400 steps over three rooms and ten players (clock steps, bursts, repeats, a guest) gives the same verdict at every step from the in-memory pacer and from
// the shared pacer over a memory store. The two share the pure functions, so this is what proves nothing else differs: the keys, the memo, the sweeps, the signal bookkeeping.

const T = 1_800_000_000_000;
const OFF: ResolvedPace = { slowModeMs: null, burst: null, duplicateWindowMs: null };

/** Per room: one with everything on, one with the gap only, one with repeats and the burst. A fourth room has every check off. */
const PACES: Record<string, ResolvedPace> = {
  arena: { slowModeMs: 1500, burst: { lines: 4, windowMs: 12_000 }, duplicateWindowMs: 30_000 },
  lobby: { slowModeMs: 3000, burst: null, duplicateWindowMs: null },
  quiet: { slowModeMs: null, burst: { lines: 2, windowMs: 6000 }, duplicateWindowMs: 20_000 },
  free: OFF,
};
const ROOMS = Object.keys(PACES);
const PEOPLE = [...Array.from({ length: 4 }, (_, i) => `s_person${i}`), 'seat:guest-1'];
const LINES = ['hello there everyone', 'good game all', 'anyone want to play', 'gg', 'ok', 'hello there everyone', 'GOOD GAME, ALL!', 'where is the flag', 'nice shot', 'look at this'];

function prng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
}

interface Run {
  verdicts: PaceVerdict[];
  floors: Array<number | undefined>;
}

function drive(make: (clock: { now: () => number }, settings: (room: string) => ResolvedPace) => Pacer): Run {
  const clock = { t: T, now: () => clock.t };
  const pacer = make(clock, (room) => PACES[room] ?? OFF);
  const next = prng(20_26);
  const verdicts: PaceVerdict[] = [];
  const floors: Array<number | undefined> = [];
  for (let step = 0; step < 400; step++) {
    const r = next();
    // time: mostly small steps, sometimes a long pause, sometimes a step back
    const roll = r % 20;
    if (roll < 14) clock.t += 100 + (r % 900);
    else if (roll < 17) clock.t += 2000 + (r % 9000);
    else if (roll < 19) clock.t += 40_000 + (r % 30_000);
    else clock.t -= 1 + (r % 8000);
    const key: PaceKey = { roomId: ROOMS[next() % ROOMS.length] as string, who: PEOPLE[next() % PEOPLE.length] as string };
    const line = LINES[next() % LINES.length] as string;
    // a probation floor on some lines
    const floor = next() % 9 === 0 ? 2500 : undefined;
    if (floor === undefined ? !pacer.active(key.roomId) : false) {
      verdicts.push({ ok: true });
      floors.push(floor);
      continue;
    }
    const verdict = pacer.check(key, line, floor);
    verdicts.push(verdict);
    floors.push(floor);
    if (verdict.ok) {
      // the fixed rate refuses some accepted lines: the memo is dropped instead of committed
      if (next() % 11 === 0) pacer.discard();
      else pacer.commit(key, line, floor);
    }
  }
  return { verdicts, floors };
}

describe('differential: the in-memory pacer and the shared pacer agree', () => {
  it('a script of 400 steps over three paced rooms, one free room, five players, a guest, clock steps back and forth and probation floors: the same verdict at every step', () => {
    const memory = drive((clock, settings) => createPacer({ clock, settings }));
    const store = new MemoryStore();
    const shared = drive((clock, settings) => createSharedPacer({ clock, settings, store }));
    expect(shared.verdicts).toHaveLength(400);
    for (let i = 0; i < 400; i++) expect(shared.verdicts[i], `step ${i}`).toEqual(memory.verdicts[i]);
    // the script really exercised every verdict
    const reasons = new Set<string>(memory.verdicts.map((v) => (v.ok ? 'ok' : v.reason)));
    for (const wanted of ['ok', 'slow_mode', 'flood', 'duplicate', 'probation']) expect(reasons.has(wanted), wanted).toBe(true);
    expect(memory.verdicts.some((v) => !v.ok && v.signalFlood)).toBe(true);
  });

  it('three more seeds of the same script, with the pacers built the other way round, still agree', () => {
    for (const seed of [1, 99, 4242]) {
      const run = (make: Parameters<typeof drive>[0]): Run => {
        const clock = { t: T, now: () => clock.t };
        const pacer = make(clock, (room) => PACES[room] ?? OFF);
        const next = prng(seed);
        const verdicts: PaceVerdict[] = [];
        for (let i = 0; i < 150; i++) {
          const r = next();
          clock.t += r % 7 === 0 ? 20_000 : 200 + (r % 1500);
          const key: PaceKey = { roomId: ROOMS[next() % ROOMS.length] as string, who: PEOPLE[next() % PEOPLE.length] as string };
          const line = LINES[next() % LINES.length] as string;
          if (!pacer.active(key.roomId)) continue;
          const v = pacer.check(key, line);
          verdicts.push(v);
          if (v.ok) pacer.commit(key, line);
        }
        return { verdicts, floors: [] };
      };
      const shared = run((clock, settings) => createSharedPacer({ clock, settings, store: new MemoryStore() }));
      const memory = run((clock, settings) => createPacer({ clock, settings }));
      expect(shared.verdicts, `seed ${seed}`).toEqual(memory.verdicts);
    }
  });
});
