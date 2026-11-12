import { describe, expect, it } from 'vitest';
import { MIN, signalRowsOf, sworld } from './signalsWorld.js';
import type { SignalWorld } from './signalsWorld.js';

// Final review round (flood control and signals): leniency for null, the age hook asked once a minute per player, a bound on connection
// details, quiet capped flood trips, and room ids that fail the pattern keep their per-room cap through a stable digest.

const rec = (w: SignalWorld, input: Record<string, unknown>): boolean => w.cw.signals.record(input as never);
const refusals = (w: SignalWorld): unknown[] => w.logged.filter(([e]) => e === 'chatwarden.signal_refused').map(([, d]) => d);
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('FC M1: the new-account hook is asked once a minute per player', () => {
  async function world() {
    const asked: Array<readonly string[]> = [];
    const w = await sworld({
      guards: { newAccount: { belowDays: 7, factor: 0.25 } },
      signals: {
        accountAgeDays: (ids) => {
          asked.push([...ids]);
          return 1;
        },
      },
    });
    return { ...w, asked };
  }

  it('ten records of one by call the hook once, and every row still carries the factor', async () => {
    const w = await world();
    const by = w.person('by', { accountId: 'acct-1' });
    for (let i = 0; i < 10; i += 1) expect(rec(w, { kind: 'muted_by_player', subject: w.person(`t${i}`), by })).toBe(true);
    expect(w.asked).toHaveLength(1);
    expect(signalRowsOf(w.store).every((r) => r.weight === 0.25)).toBe(true);
  });

  it('a record the cap refuses does not ask again', async () => {
    const w = await world();
    const by = w.person('by', { accountId: 'acct-1' });
    const target = w.person('target');
    rec(w, { kind: 'muted_by_player', subject: target, by });
    for (let i = 0; i < 5; i += 1) expect(rec(w, { kind: 'muted_by_player', subject: target, by })).toBe(false);
    expect(w.asked).toHaveLength(1);
  });

  it('another player is asked separately, and the same player is asked again after a minute', async () => {
    const w = await world();
    const a = w.person('a', { accountId: 'acct-a' });
    const b = w.person('b', { accountId: 'acct-b' });
    rec(w, { kind: 'muted_by_player', subject: w.person('t1'), by: a });
    rec(w, { kind: 'muted_by_player', subject: w.person('t2'), by: b });
    expect(w.asked).toHaveLength(2);
    w.clock.t += MIN - 1;
    rec(w, { kind: 'muted_by_player', subject: w.person('t3'), by: a });
    expect(w.asked).toHaveLength(2);
    w.clock.t += 2;
    rec(w, { kind: 'muted_by_player', subject: w.person('t4'), by: a });
    expect(w.asked).toHaveLength(3);
  });

  it('many different players are each answered right (the memory is bounded, not the answers)', async () => {
    const w = await world();
    const target = w.person('same-target');
    for (let i = 0; i < 600; i += 1) {
      const by = w.person(`by-${i}`, { accountId: `acct-${i}` });
      expect(rec(w, { kind: 'muted_by_player', subject: target, by })).toBe(true);
    }
    expect(w.asked).toHaveLength(600);
    expect(signalRowsOf(w.store).every((r) => r.weight === 0.25)).toBe(true);
  });
});

describe('FC M2: null means "left out" for by, roomId and at', () => {
  it.each([
    ['by', { by: null }],
    ['roomId', { roomId: null }],
    ['at', { at: null }],
    ['all three', { by: null, roomId: null, at: null }],
  ])('%s: null records, as if the key were omitted', async (_name, extra) => {
    const w = await sworld();
    const target = w.person('target');
    expect(rec(w, { kind: 'muted_by_player', subject: target, ...extra })).toBe(true);
    const row = signalRowsOf(w.store)[0]!;
    expect(row.bySubject).toBeNull();
    expect(row.roomId).toBeNull();
    expect(row.at).toBe(w.clock.t);
  });

  it('a record with by null and no room is a day source, as when by is omitted', async () => {
    const w = await sworld();
    const target = w.person('target');
    rec(w, { kind: 'muted_by_player', subject: target, by: null });
    expect(signalRowsOf(w.store)[0]!.sourceKey).toMatch(/^d:\d{4}-\d{2}-\d{2}$/);
  });

  it('what null never forgives: a null subject or kind, and a wrong type elsewhere, stay refused', async () => {
    const w = await sworld();
    const target = w.person('target');
    expect(rec(w, { kind: 'muted_by_player', subject: null })).toBe(false);
    expect(rec(w, { kind: null, subject: target })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: 5 })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: target, roomId: '' })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: target, weight: null })).toBe(false);
  });
});

describe('FC M3: connection details are bounded', () => {
  it.each(['clientKey', 'accountId', 'ip'])('a 1 MB %s is refused as malformed, for the subject and for by', async (key) => {
    const w = await sworld();
    const target = w.person('target');
    const huge = 'k'.repeat(1_000_000);
    expect(rec(w, { kind: 'muted_by_player', subject: { [key]: huge } })).toBe(false);
    w.clock.t += 2 * MIN;
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: { [key]: huge } })).toBe(false);
    expect(refusals(w)).toEqual([{ reason: 'malformed' }, { reason: 'malformed' }]);
  });

  it('512 characters are still looked up (an unknown person), 513 are malformed', async () => {
    const w = await sworld();
    w.logged.length = 0;
    expect(rec(w, { kind: 'muted_by_player', subject: { clientKey: 'k'.repeat(512) } })).toBe(false);
    expect(refusals(w)).toEqual([{ reason: 'unknown_subject' }]);
    w.logged.length = 0;
    w.clock.t += 2 * MIN;
    expect(rec(w, { kind: 'muted_by_player', subject: { clientKey: 'k'.repeat(513) } })).toBe(false);
    expect(refusals(w)).toEqual([{ reason: 'malformed' }]);
  });

  it('a normal key still finds the person', async () => {
    const w = await sworld();
    const target = w.person('target');
    expect(rec(w, { kind: 'muted_by_player', subject: w.who('target') })).toBe(true);
    expect(w.cw.signals.counts(target)).toHaveLength(1);
  });
});

describe('FC M4 and M5: flood_triggered', () => {
  const BURST = { burst: { lines: 2, windowMs: 10_000 } };
  async function world() {
    const w = await sworld({ overrides: { pace: BURST } });
    const seat = (room: string, key = 'player-1'): void => w.cw.rooms.seat(room, 'p1', { clientKey: key }, `H-${key}`);
    const trip = (room: string, tag: string): void => {
      for (const n of ['one', 'two', 'three']) {
        w.clock.t += 10;
        w.cw.chat.accept(room, 'p1', `${tag} ${n}`);
      }
    };
    return { ...w, seat, trip };
  }

  it('M4: a second trip in the same room the same day is the cap working, and logs nothing', async () => {
    const w = await world();
    w.seat('room-a');
    w.trip('room-a', 'x');
    await flush();
    w.logged.length = 0;
    w.clock.t += 60_000;
    w.trip('room-a', 'y');
    await flush();
    expect(signalRowsOf(w.store)).toHaveLength(1);
    expect(refusals(w)).toEqual([]);
  });

  it('M4: a real failure (the store throws) is still logged', async () => {
    const w = await world();
    w.seat('room-a');
    w.store.insertSignal = () => {
      throw new TypeError('db is gone');
    };
    w.logged.length = 0;
    w.trip('room-a', 'x');
    await flush();
    expect(refusals(w)).toEqual([{ reason: 'store_failed', error: 'TypeError' }]);
  });

  it('M5: a room id the pattern refuses is recorded under a stable digest, so each room keeps its own cap', async () => {
    const w = await world();
    w.seat('my room one');
    w.seat('my room two', 'player-2');
    w.trip('my room one', 'a');
    w.trip('my room two', 'b');
    await flush();
    w.clock.t += 60_000;
    w.trip('my room one', 'c');
    await flush();
    const rows = signalRowsOf(w.store);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.roomId).toMatch(/^h[0-9a-f]{16}$/);
      expect(r.sourceKey).toBe(`r:${r.roomId}`);
    }
    expect(JSON.stringify(rows)).not.toContain('my room');
  });

  it('M5: the digest of a room is the same in another kit', async () => {
    const w = await world();
    w.seat('room/one');
    w.trip('room/one', 'a');
    await flush();
    const first = signalRowsOf(w.store)[0]!.roomId;
    const w2 = await world();
    w2.seat('room/one');
    w2.trip('room/one', 'a');
    await flush();
    expect(signalRowsOf(w2.store)[0]!.roomId).toBe(first);
  });

  it('M5: a 300-character room id works; an ordinary id is kept as it is', async () => {
    const w = await world();
    const long = `room-${'x'.repeat(295)}`;
    w.seat(long);
    w.seat('room-a', 'player-2');
    w.trip(long, 'a');
    w.trip('room-a', 'b');
    await flush();
    const ids = signalRowsOf(w.store).map((r) => r.roomId);
    expect(ids).toContain('room-a');
    expect(ids.some((id) => /^h[0-9a-f]{16}$/.test(id ?? ''))).toBe(true);
  });
});
