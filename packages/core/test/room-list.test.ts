import { describe, expect, it } from 'vitest';
import { RoomRoster } from '../src/evidence.js';
import { HOUR, MIN, roomsWorld } from './roomsWorld.js';

// R1: rooms.list() (what a staff Rooms panel reads) and rooms.postingState() (what the chat box's hello reads). No seat id and no handle in either.

describe('RoomRoster.rooms', () => {
  it('lists every room with its tags and how many seats are held; a copy', () => {
    const r = new RoomRoster();
    r.seat('A', 's1', null, 'h1', { mode: 'ranked' });
    r.seat('A', 's2', null, 'h2');
    r.seat('B', 's1', null, 'h3');
    r.unseat('B', 's1');
    const rooms = r.rooms();
    expect(rooms.sort((x, y) => x.roomId.localeCompare(y.roomId))).toEqual([
      { roomId: 'A', tags: { mode: 'ranked' }, seated: 2 },
      { roomId: 'B', tags: {}, seated: 0 },
    ]);
    rooms[0]!.tags.x = 'y';
    expect(r.tags('A')).toEqual({ mode: 'ranked' });
  });
});

describe('rooms.list', () => {
  it('most seated first, ties by room id; each has tags, seated, mode and until', async () => {
    const w = await roomsWorld();
    w.cw.rooms.seat('small', 'p1', { clientKey: 'k-small-aaaaaaaaaaaa' }, 'A', { region: 'eu' });
    for (let i = 0; i < 3; i += 1) w.cw.rooms.seat('big', `p${i}`, { clientKey: `k-big-${i}-aaaaaaaaaaaa` }, `B${i}`);
    w.cw.rooms.seat('also-small', 'p1', { clientKey: 'k-also-aaaaaaaaaaaa' }, 'C');
    w.cw.rooms.setMode('small', 'locked', { forMs: 10 * MIN });
    expect(w.cw.rooms.list()).toEqual([
      { roomId: 'big', tags: {}, seated: 3, mode: 'normal', until: null },
      { roomId: 'also-small', tags: {}, seated: 1, mode: 'normal', until: null },
      { roomId: 'small', tags: { region: 'eu' }, seated: 1, mode: 'locked', until: w.clock.t + 10 * MIN },
    ]);
  });

  it('includes a room with a mode and no seats', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('ghost', 'emergency', { forMs: HOUR });
    expect(w.cw.rooms.list()).toEqual([{ roomId: 'ghost', tags: {}, seated: 0, mode: 'emergency', until: w.clock.t + HOUR }]);
  });

  it('a room whose mode has expired reads as normal and, with no seats, is not listed', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('ghost', 'locked', { forMs: 60_000 });
    w.clock.t += 61_000;
    expect(w.cw.rooms.list()).toEqual([]);
  });

  it('is capped at 500 rooms', async () => {
    const w = await roomsWorld();
    for (let i = 0; i < 520; i += 1) w.cw.rooms.seat(`room-${String(i).padStart(4, '0')}`, 'p1', { clientKey: `k-${i}-aaaaaaaaaaaaaaaa` }, 'x');
    expect(w.cw.rooms.list()).toHaveLength(500);
  });

  it('never carries a seat id, a handle, a subject or any other key', async () => {
    const w = await roomsWorld();
    w.cw.rooms.seat('R1', 'SEAT-SECRET', { clientKey: 'k-list-aaaaaaaaaaaaaaaa', accountId: 'acct-secret-1' }, 'HANDLE-SECRET');
    w.cw.rooms.setMode('R1', 'locked');
    const text = JSON.stringify(w.cw.rooms.list());
    for (const needle of ['SEAT-SECRET', 'HANDLE-SECRET', 'acct-secret', 'k-list', 's_']) expect(text, needle).not.toContain(needle);
    expect(Object.keys(w.cw.rooms.list()[0]!).sort()).toEqual(['mode', 'roomId', 'seated', 'tags', 'until']);
  });

  it('a closed room is gone', async () => {
    const w = await roomsWorld();
    w.cw.rooms.seat('R1', 'p1', { clientKey: 'k-close-aaaaaaaaaaaaaaaa' }, 'x');
    w.cw.rooms.setMode('R1', 'locked');
    w.cw.rooms.close('R1');
    expect(w.cw.rooms.list()).toEqual([]);
  });
});

describe('rooms.postingState', () => {
  it('ok in a normal room; locked in a locked room; new_account in an emergency for a young account', async () => {
    const w = await roomsWorld();
    const young = w.player('R1', { ageDays: 1 });
    const old = w.player('R1', { ageDays: 90 });
    expect(w.cw.rooms.postingState('R1', young)).toBe('ok');
    w.cw.rooms.setMode('R1', 'emergency', { forMs: HOUR });
    expect(w.cw.rooms.postingState('R1', young)).toBe('new_account');
    expect(w.cw.rooms.postingState('R1', old)).toBe('ok');
    w.cw.rooms.setMode('R1', 'locked', { forMs: HOUR });
    expect(w.cw.rooms.postingState('R1', young)).toBe('locked');
    expect(w.cw.rooms.postingState('R1', old)).toBe('locked');
  });

  it('follows the same decision as accept for the seat, staff included', async () => {
    const w = await roomsWorld({ overrides: { rooms: { unknownAge: 'treat_as_new' } } });
    const seats = [w.player('R1', { ageDays: 1 }), w.player('R1', { ageDays: 90 }), w.player('R1'), w.player('R1', { account: null })];
    for (const mode of ['normal', 'locked', 'emergency'] as const) {
      w.cw.rooms.setMode('R1', mode, { forMs: HOUR });
      for (const seat of seats) {
        for (const staff of [false, true]) {
          const state = w.cw.rooms.postingState('R1', seat, { staff });
          const res = w.cw.chat.accept('R1', seat, `line ${mode} ${seat} ${staff}`, { staff });
          w.clock.t += 31_000;
          const refused = 'refuse' in res ? res.refuse.reason : null;
          expect(refused === 'locked' || refused === 'new_account' ? refused : 'ok', `${mode} ${seat} staff=${staff}`).toBe(state);
        }
      }
    }
  });

  it('is a pure read: it spends no budget, raises no event except an expiry, writes nothing', async () => {
    const w = await roomsWorld();
    const a = w.player('R1', { ageDays: 1 });
    w.cw.rooms.setMode('R1', 'emergency', { forMs: HOUR });
    const events = w.events.length;
    for (let i = 0; i < 20; i += 1) w.cw.rooms.postingState('R1', a);
    expect(w.events).toHaveLength(events);
    // the first line is still free: the reads did not start any clock
    w.cw.rooms.setMode('R1', 'normal');
    expect('deliver' in w.cw.chat.accept('R1', a, 'hello')).toBe(true);
  });

  it('an empty seat, an unknown seat and an unknown room are ok', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'emergency', { forMs: HOUR });
    expect(w.cw.rooms.postingState('R1', 'nobody')).toBe('ok');
    expect(w.cw.rooms.postingState('unknown-room', 'p1')).toBe('ok');
  });

  it('a locked room says locked even for an unknown seat (a joiner who is not seated yet)', async () => {
    const w = await roomsWorld();
    w.cw.rooms.setMode('R1', 'locked', { forMs: HOUR });
    expect(w.cw.rooms.postingState('R1', 'nobody')).toBe('locked');
  });
});
