import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import type { RawWho, SubjectId } from '../src/types.js';
import { DAY, signalRowsOf, sworld } from './signalsWorld.js';
import type { SignalWorld } from './signalsWorld.js';

// flood_triggered: a flood trip records the built-in kind once per burst window per player per room, deferred out of the verdict.

const BURST = { burst: { lines: 2, windowMs: 10_000 } };
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

type Row = { kind: string; subject: string; sourceKey: string; bySubject: string | null; roomId: string | null; weight: number; at: number };
const rows = (w: SignalWorld): Row[] => signalRowsOf(w.store);

async function world(over: Parameters<typeof sworld>[0] = {}) {
  const w = await sworld({ overrides: { pace: BURST }, ...over });
  const seat = (room: string, key = 'player-1', seatId = 'p1'): void => w.cw.rooms.seat(room, seatId, { clientKey: key }, `H-${key}`);
  const say = (room: string, text: string, seatId = 'p1'): string => {
    const r = w.cw.chat.accept(room, seatId, text);
    return 'refuse' in r ? r.refuse.reason : 'deliver';
  };
  /** Two lines, then a third that trips the burst. Returns the third's reason. */
  const trip = (room: string, tag: string, seatId = 'p1'): string => {
    w.clock.t += 10;
    say(room, `${tag} one`, seatId);
    w.clock.t += 10;
    say(room, `${tag} two`, seatId);
    w.clock.t += 10;
    return say(room, `${tag} three`, seatId);
  };
  return { ...w, seat, say, trip };
}

describe('a flood trip records flood_triggered', () => {
  it('once per burst window per player per room: the row has no by, a room id and weight 1, and counts() shows one source per room', async () => {
    const w = await world();
    w.seat('room-a');
    const subject = w.cw.rooms.subjectAt('room-a', 'p1') as SubjectId;
    expect(w.trip('room-a', 'x')).toBe('flood');
    await flush();
    expect(rows(w)).toHaveLength(1);
    expect(rows(w)[0]).toMatchObject({ kind: 'flood_triggered', subject, sourceKey: 'r:room-a', bySubject: null, roomId: 'room-a', weight: 1 });
    expect(w.cw.signals.counts(subject)).toMatchObject([{ kind: 'flood_triggered', distinct: 1, weight: 1 }]);
  });

  it('five trips in one window leave one row', async () => {
    const w = await world();
    w.seat('room-a');
    w.trip('room-a', 'x');
    for (let i = 0; i < 4; i += 1) {
      w.clock.t += 10;
      expect(w.say('room-a', `again ${i}`)).toBe('flood');
    }
    await flush();
    expect(rows(w)).toHaveLength(1);
  });

  it('the next window adds a row only when the per-room-per-day cap allows', async () => {
    const w = await world();
    w.seat('room-a');
    const subject = w.cw.rooms.subjectAt('room-a', 'p1') as SubjectId;
    w.clock.t = w.clock.t - (w.clock.t % DAY) + 3_600_000;
    w.trip('room-a', 'first');
    await flush();
    // A second window the same UTC day: the pacer signals again, the cap refuses the row.
    w.clock.t += 20_000;
    expect(w.trip('room-a', 'second')).toBe('flood');
    await flush();
    expect(rows(w)).toHaveLength(1);
    // The next day it lands.
    w.clock.t += DAY;
    expect(w.trip('room-a', 'third')).toBe('flood');
    await flush();
    expect(rows(w)).toHaveLength(2);
    expect(w.cw.signals.counts(subject)).toMatchObject([{ distinct: 1 }]);
  });

  it('a player flooding ten rooms leaves ten rows, ten sources', async () => {
    const w = await world();
    for (let i = 0; i < 10; i += 1) {
      w.seat(`room-${i}`);
      w.clock.t += 20_000;
      expect(w.trip(`room-${i}`, `r${i}`)).toBe('flood');
    }
    await flush();
    expect(rows(w)).toHaveLength(10);
    const subject = w.cw.rooms.subjectAt('room-0', 'p1') as SubjectId;
    expect(w.cw.signals.counts(subject)).toMatchObject([{ kind: 'flood_triggered', distinct: 10, weight: 10 }]);
  });

  it('two players in one room leave two rows', async () => {
    const w = await world();
    w.seat('room-a', 'one', 'p1');
    w.seat('room-a', 'two', 'p2');
    w.trip('room-a', 'a', 'p1');
    w.trip('room-a', 'b', 'p2');
    await flush();
    expect(rows(w)).toHaveLength(2);
    expect(new Set(rows(w).map((r) => r.subject)).size).toBe(2);
  });

  it('a room id the signal rules do not accept is recorded without a room (a day source)', async () => {
    const w = await world();
    w.seat('my room with spaces');
    w.trip('my room with spaces', 'x');
    await flush();
    expect(rows(w)).toHaveLength(1);
    expect(rows(w)[0]?.roomId).toBeNull();
    expect(rows(w)[0]?.sourceKey).toMatch(/^d:\d{4}-\d{2}-\d{2}$/);
  });

  it('works with nothing declared at all (the built-in kind only)', async () => {
    const w = await world({ kinds: {} });
    w.seat('room-a');
    w.trip('room-a', 'x');
    await flush();
    expect(rows(w)).toHaveLength(1);
  });

  it('a redeclared flood_triggered weight is the weight of the row', async () => {
    const w = await world({ kinds: { flood_triggered: { label: 'Spammed', polarity: 'negative', weight: 3 } } });
    w.seat('room-a');
    w.trip('room-a', 'x');
    await flush();
    expect(rows(w)[0]?.weight).toBe(3);
  });
});

describe('it is deferred and fenced', () => {
  it('the verdict is returned before the write: the store sees nothing until the microtask runs', async () => {
    const w = await world();
    w.seat('room-a');
    w.clock.t += 10;
    w.say('room-a', 'one');
    w.clock.t += 10;
    w.say('room-a', 'two');
    w.clock.t += 10;
    expect(w.say('room-a', 'three')).toBe('flood');
    expect(rows(w)).toHaveLength(0);
    await Promise.resolve();
    expect(rows(w)).toHaveLength(1);
  });

  it('slow_mode and duplicate record nothing', async () => {
    const w = await world({ overrides: { pace: { slowModeMs: 5000, duplicateWindowMs: 60_000 } } });
    w.seat('room-a');
    w.clock.t += 10;
    expect(w.say('room-a', 'same words here')).toBe('deliver');
    w.clock.t += 10;
    expect(w.say('room-a', 'other words')).toBe('slow_mode');
    w.clock.t += 6000;
    expect(w.say('room-a', 'Same words, here!')).toBe('duplicate');
    await flush();
    expect(rows(w)).toHaveLength(0);
  });

  it('a guest records nothing', async () => {
    const w = await world();
    w.cw.rooms.seat('room-a', 'g1', {} as RawWho, 'Guest');
    expect(w.trip('room-a', 'x', 'g1')).toBe('flood');
    await flush();
    expect(rows(w)).toHaveLength(0);
  });

  it('a store failure is absorbed and logged by class only', async () => {
    const w = await world();
    w.seat('room-a');
    w.store.insertSignal = () => {
      throw new TypeError('secret detail s_abc room-a');
    };
    w.logged.length = 0;
    expect(w.trip('room-a', 'x')).toBe('flood');
    await flush();
    expect(w.logged).toEqual([['chatwarden.signal_refused', { reason: 'store_failed', error: 'TypeError' }]]);
    expect(JSON.stringify(w.logged)).not.toContain('room-a');
    // Chat goes on.
    w.clock.t += 20_000;
    expect(w.say('room-a', 'a later line')).toBe('deliver');
  });

  it('a store without signals is skipped and logged once', async () => {
    const store = new MemoryStore();
    for (const m of ['insertSignal', 'listSignalSources', 'purgeSignals']) Object.defineProperty(store, m, { value: undefined });
    const logged: Array<[string, unknown]> = [];
    let t = 1_800_000_000_000;
    const cw = await createChatwarden({
      store,
      secret: 's',
      platform: { identify: (ctx) => ctx as RawWho },
      clock: { now: () => t },
      logger: { warn: (e, d) => void logged.push([e, d]) },
      retention: false,
      overrides: { pace: BURST },
    });
    cw.rooms.seat('room-a', 'p1', { clientKey: 'k' }, 'H');
    for (let round = 0; round < 3; round += 1) {
      t += 20_000;
      for (const text of ['one', 'two', 'three']) {
        t += 10;
        cw.chat.accept('room-a', 'p1', `${text} ${round}`);
      }
    }
    await flush();
    expect(logged.filter(([e]) => e === 'chatwarden.signals_store_unsupported')).toHaveLength(1);
    expect(logged.some(([e]) => e === 'chatwarden.signal_refused')).toBe(false);
  });

  it('off by default: with no pace configured nothing is ever recorded', async () => {
    const w = await sworld();
    w.person('p');
    for (let i = 0; i < 6; i += 1) {
      w.clock.t += 10;
      w.cw.chat.accept('seat-room-p', 'p1', `line ${i}`);
    }
    await flush();
    expect(rows(w)).toHaveLength(0);
  });
});
