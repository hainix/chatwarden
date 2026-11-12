import { describe, expect, it } from 'vitest';
import type { SendResult } from '../src/chat/wire.js';
import { chatWorld, SEC, spoken } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';

const ROOM = 'lobby';
const HEARTBEAT = 20 * SEC;
const GRACE = 120 * SEC;

function say(w: ChatWorld, s: { send(i: { text: string }): SendResult }, text: string): SendResult {
  w.advance(2 * SEC);
  return s.send({ text });
}

describe('heartbeat', () => {
  it('is pinged every heartbeatMs on every open stream, and re-armed', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend('other-room', 'wumbo');
    w.advance(HEARTBEAT - 1);
    expect(a.heard.pings).toBe(0);
    w.advance(1);
    expect([a.heard.pings, b.heard.pings]).toEqual([1, 1]);
    w.advance(HEARTBEAT * 3);
    expect([a.heard.pings, b.heard.pings]).toEqual([4, 4]);
  });

  it('a sink without a ping gets no heartbeat (a socket with its own keep-alive)', async () => {
    const w = await chatWorld();
    const s = w.join(ROOM, 'plenk');
    const frames: string[] = [];
    s.open({ write: (f) => void frames.push(f.type) });
    w.advance(HEARTBEAT * 5);
    expect(frames).toEqual(['hello']);
  });

  it('closing a stream cancels the heartbeat when it was the last', async () => {
    const w = await chatWorld({ options: { seatGraceMs: 10_000_000 } });
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    expect(w.pending()).toBe(1); // one shared heartbeat timer
    a.stream.close();
    expect(w.pending()).toBe(2); // + a's seat grace
    w.advance(HEARTBEAT);
    expect(b.heard.pings).toBe(1);
    expect(a.heard.pings).toBe(0);
    b.stream.close();
    // the heartbeat is gone: only the two seat graces remain, and no further ping is ever written
    expect(w.pending()).toBe(2);
    w.advance(HEARTBEAT * 10);
    expect(b.heard.pings).toBe(1);
  });

  it('a new stream after the heartbeat was cancelled arms it again, once', async () => {
    const w = await chatWorld({ options: { seatGraceMs: 10_000_000 } });
    const a = w.attend(ROOM, 'plenk');
    a.stream.close();
    const again = spoken();
    const s = a.session.open(again.sink);
    expect('close' in s).toBe(true);
    const more = spoken();
    a.session.open(more.sink);
    w.advance(HEARTBEAT);
    expect([again.pings, more.pings]).toEqual([1, 1]);
  });

  it('a sink whose ping throws is closed; the others keep their heartbeat', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    a.heard.broken = true;
    w.advance(HEARTBEAT);
    expect(w.chat.stats().streams).toBe(1);
    expect(b.heard.pings).toBe(1);
    w.advance(HEARTBEAT);
    expect(b.heard.pings).toBe(2);
  });
});

describe('a backed-up stream', () => {
  it('a sink that returns false maxBacklog times is closed; fewer times, not', async () => {
    const w = await chatWorld({ options: { maxBacklog: 3 } });
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    b.heard.backedUp = true;
    say(w, a.session, 'one');
    say(w, a.session, 'two');
    expect(w.chat.stats().streams).toBe(2); // two refusals: still open
    say(w, a.session, 'three');
    expect(w.chat.stats().streams).toBe(1); // the third closes it
    say(w, a.session, 'four');
    expect(b.heard.texts()).toEqual(['one', 'two', 'three']); // nothing after it was closed
  });

  it('the count is of refusals in a row: one accepted write resets it', async () => {
    const w = await chatWorld({ options: { maxBacklog: 3 } });
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    b.heard.backedUp = true;
    say(w, a.session, 'one');
    say(w, a.session, 'two');
    b.heard.backedUp = false;
    say(w, a.session, 'three');
    b.heard.backedUp = true;
    say(w, a.session, 'four');
    say(w, a.session, 'five');
    expect(w.chat.stats().streams).toBe(2);
    expect(b.heard.texts()).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('a heartbeat that is refused counts too, so an idle dead reader is dropped', async () => {
    const w = await chatWorld({ options: { maxBacklog: 2 } });
    const a = w.attend(ROOM, 'plenk');
    a.heard.backedUp = true;
    w.advance(HEARTBEAT);
    expect(w.chat.stats().streams).toBe(1);
    w.advance(HEARTBEAT);
    expect(w.chat.stats().streams).toBe(0);
    expect(w.pending()).toBe(1); // only the seat's grace is left
  });

  it('the default is 64 refusals in a row', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    b.heard.backedUp = true;
    for (let i = 0; i < 63; i += 1) w.advance(HEARTBEAT);
    expect(w.chat.stats().streams).toBe(2); // 63 refused heartbeats: still open
    w.advance(HEARTBEAT);
    expect(w.chat.stats().streams).toBe(1); // the 64th closes it
    expect(a.heard.pings).toBe(64);
  });
});

describe('seats', () => {
  it('are released seatGraceMs after the last stream and last session call, not before', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const seat = w.seatOf(ROOM, 'plenk');
    a.stream.close();
    w.advance(GRACE - 1);
    expect(w.chat.stats().members).toBe(1);
    expect(w.cw.rooms.subjectAt(ROOM, seat)).not.toBeNull();
    // a request refreshes the grace
    a.session.send({ text: 'still here' });
    w.advance(GRACE - 1);
    expect(w.chat.stats().members).toBe(1);
    // a session call refreshes it too
    w.chat.session(ROOM, w.who('plenk'), { name: 'plenk' });
    w.advance(GRACE - 1);
    expect(w.chat.stats().members).toBe(1);
    w.advance(1);
    expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
    expect(w.cw.rooms.subjectAt(ROOM, seat)).toBeNull();
    expect(w.pending()).toBe(0);
  });

  it('a seat with an open stream is never released, however long it is quiet', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    w.advance(GRACE * 10);
    expect(w.chat.stats()).toEqual({ rooms: 1, members: 1, streams: 1 });
    expect(a.heard.pings).toBe((GRACE * 10) / HEARTBEAT);
  });

  it('a stream opened before the grace ends cancels it', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    a.stream.close();
    w.advance(GRACE - 1);
    const heard = spoken();
    a.session.open(heard.sink);
    w.advance(GRACE * 5);
    expect(w.chat.stats().members).toBe(1);
  });

  it('one tab closing leaves the seat; the last one starts the grace', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const second = spoken();
    const s2 = a.session.open(second.sink);
    if ('refused' in s2) throw new Error('refused');
    a.stream.close();
    w.advance(GRACE * 2);
    expect(w.chat.stats().members).toBe(1);
    s2.close();
    w.advance(GRACE);
    expect(w.chat.stats().members).toBe(0);
  });

  it('a session held past its seat release has nothing to act with: it answers like an unseated player, and a new session() works', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    a.stream.close();
    w.advance(GRACE);
    expect(w.chat.stats().members).toBe(0);
    // the broadcaster kept no credential to seat them again with
    expect(a.session.send({ text: 'back after a while' })).toEqual({ ok: false, refused: { reason: 'gate' } });
    expect(a.session.canOpen()).toBe(false);
    expect(a.session.open(spoken().sink)).toEqual({ refused: { reason: 'full' } });
    expect(a.session.mute({ lineId: '1', on: true })).toBe(false);
    expect(w.chat.stats().members).toBe(0);
    const fresh = w.join(ROOM, 'plenk');
    expect(say(w, fresh, 'back after a while').ok).toBe(true);
    expect(w.chat.stats().members).toBe(1);
    w.advance(GRACE);
    expect(w.chat.stats().members).toBe(0);
  });

  it('a released seat in a room with other members leaves them alone', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    a.stream.close();
    w.advance(GRACE);
    expect(w.chat.stats()).toEqual({ rooms: 1, members: 1, streams: 1 });
    expect(say(w, b.session, 'alone now').ok).toBe(true);
  });

  it('an empty room and its ring are removed', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    say(w, a.session, 'a line');
    a.stream.close();
    w.advance(GRACE);
    expect(w.chat.stats().rooms).toBe(0);
    const again = w.attend(ROOM, 'wumbo');
    expect(again.heard.of('hello')[0]?.lines).toEqual([]);
  });
});

describe('storms', () => {
  it('10 000 joins and leaves leave stats() at zero rooms, members and streams', async () => {
    const w = await chatWorld();
    for (let i = 0; i < 10_000; i += 1) {
      const s = w.chat.session(`room-${i % 25}`, { clientKey: `storm-key-${i}-aaaaaaaa` }, { name: 'plenk' });
      if ('refused' in s) throw new Error('refused');
      const stream = s.open(spoken().sink);
      if ('refused' in stream) throw new Error('refused');
      if (i % 100 === 0) w.advance(1000);
      stream.close();
    }
    expect(w.chat.stats().streams).toBe(0);
    w.advance(GRACE + 100 * SEC);
    expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
    expect(w.pending()).toBe(0);
  }, 60_000);

  it('a reconnect storm of one player leaves one timer, not thousands', async () => {
    const w = await chatWorld();
    const s = w.join(ROOM, 'plenk');
    for (let i = 0; i < 2000; i += 1) {
      const stream = s.open(spoken().sink);
      if ('refused' in stream) throw new Error('refused');
      stream.close();
    }
    expect(w.pending()).toBe(1); // the grace; no heartbeat, no stragglers
    expect(w.chat.stats()).toEqual({ rooms: 1, members: 1, streams: 0 });
  });

  it('opening many tabs at once never holds more than the per-player limit', async () => {
    const w = await chatWorld();
    const s = w.join(ROOM, 'plenk');
    const open = [];
    for (let i = 0; i < 10; i += 1) {
      const stream = s.open(spoken().sink);
      if ('close' in stream) open.push(stream);
    }
    expect(open).toHaveLength(10); // every open is admitted: each newest tab replaces the oldest
    expect(w.chat.stats().streams).toBe(3);
  });
});

describe('limits', () => {
  it('maxMembers refuses the next join with full; a player already in is not counted twice', async () => {
    const w = await chatWorld({ options: { maxMembers: 2 } });
    w.join(ROOM, 'plenk');
    w.join(ROOM, 'wumbo');
    expect(w.chat.session(ROOM, w.who('glarn'), { name: 'glarn' })).toEqual({ refused: { reason: 'full' } });
    expect('refused' in w.chat.session(ROOM, w.who('plenk'), { name: 'plenk' })).toBe(false);
    // another room has its own count
    expect('refused' in w.chat.session('other-room', w.who('glarn'), { name: 'glarn' })).toBe(false);
    // the refused player was not seated, and left nothing behind
    expect(w.chat.stats().members).toBe(3);
    // a seat released makes room
    w.advance(GRACE);
    expect('refused' in w.chat.session(ROOM, w.who('glarn'), { name: 'glarn' })).toBe(false);
  });

  it('maxStreamsPerMember: the newest stream wins, the oldest of that player is ended, nobody else is touched', async () => {
    const w = await chatWorld({ options: { maxStreamsPerMember: 2 } });
    const a = w.join(ROOM, 'plenk');
    const b = w.join(ROOM, 'wumbo');
    const sinks = [spoken(), spoken(), spoken()] as const;
    const first = a.open(sinks[0].sink);
    a.open(sinks[1].sink);
    const bs = spoken();
    b.open(bs.sink);
    const third = a.open(sinks[2].sink);
    expect('close' in third).toBe(true);
    // the oldest was ended (its sink told), the second and third stay, the other player is untouched
    expect(sinks.map((s) => s.ended)).toEqual([1, 0, 0]);
    expect(bs.ended).toBe(0);
    expect(w.chat.stats().streams).toBe(3);
    // the evicted stream hears nothing more and its own close is harmless
    say(w, a, 'a line');
    expect(sinks[0].texts()).toEqual([]);
    expect(sinks[1].texts()).toEqual(['a line']);
    expect(sinks[2].texts()).toEqual(['a line']);
    if ('refused' in first) throw new Error('refused');
    first.close();
    expect(w.chat.stats().streams).toBe(3);
    // requests (a line) are never refused for having too many tabs
    expect(say(w, a, 'a line from a crowded player').ok).toBe(true);
  });

  it('three zombie streams (a phone that changed network) do not lock the player out: a fourth opens fine', async () => {
    const w = await chatWorld();
    const s = w.join(ROOM, 'plenk');
    const zombies = [spoken(), spoken(), spoken()];
    for (const z of zombies) expect('close' in s.open(z.sink)).toBe(true); // they accept writes into a dead socket: nothing tells the server
    expect(s.canOpen()).toBe(true);
    const fresh = spoken();
    expect('close' in s.open(fresh.sink)).toBe(true);
    expect(fresh.of('hello')).toHaveLength(1);
    expect(zombies[0]?.ended).toBe(1);
    // a fifth and a sixth keep working: always the newest three
    s.open(spoken().sink);
    s.open(spoken().sink);
    expect(w.chat.stats().streams).toBe(3);
    expect(zombies.map((z) => z.ended)).toEqual([1, 1, 1]);
  });

  it('maxStreams refuses the next open with full, across players and rooms', async () => {
    const w = await chatWorld({ options: { maxStreams: 3 } });
    const players = ['plenk', 'wumbo', 'glarn', 'mivvo'].map((n, i) => w.join(`room-${i % 2}`, n));
    const opened = players.slice(0, 3).map((p) => p.open(spoken().sink));
    expect(opened.every((o) => 'close' in o)).toBe(true);
    const last = players[3];
    expect(last?.open(spoken().sink)).toEqual({ refused: { reason: 'full' } });
    // a request still works at the limit
    expect(say(w, players[0] as never, 'still talking').ok).toBe(true);
    const first = opened[0];
    if (first === undefined || 'refused' in first) throw new Error('refused');
    first.close();
    expect('close' in (last?.open(spoken().sink) ?? { refused: 1 })).toBe(true);
  });

  it('the refusals say full and nothing else', async () => {
    const w = await chatWorld({ options: { maxMembers: 1 } });
    w.join(ROOM, 'plenk');
    const refused = w.chat.session(ROOM, w.who('wumbo'), { name: 'wumbo' });
    expect(refused).toEqual({ refused: { reason: 'full' } });
  });
});

describe('closeRoom and close', () => {
  it('closeRoom ends only that room', async () => {
    const w = await chatWorld();
    const a = w.attend('room-a', 'plenk');
    const a2 = w.attend('room-a', 'wumbo');
    const b = w.attend('room-b', 'glarn');
    say(w, a.session, 'in room a');
    const seat = w.seatOf('room-a', 'plenk');
    w.chat.closeRoom('room-a');
    for (const heard of [a.heard, a2.heard]) expect(heard.frames.at(-1)).toEqual({ type: 'bye', reason: 'room_closed' });
    expect(b.heard.frames.map((f) => f.type)).toEqual(['hello']);
    expect(w.chat.stats()).toEqual({ rooms: 1, members: 1, streams: 1 });
    expect(w.cw.rooms.subjectAt('room-a', seat)).toBeNull(); // the kit forgot the room too
    // no write after the bye
    const frozen = a.heard.frames.length;
    say(w, b.session, 'in room b');
    w.advance(HEARTBEAT * 3);
    expect(a.heard.frames).toHaveLength(frozen);
    expect(b.heard.texts()).toEqual(['in room b']);
    // only room b's timers are left: its heartbeat
    expect(w.pending()).toBe(1);
  });

  it('closeRoom drops the history: the room starts again with a new epoch', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    say(w, a.session, 'before the close');
    const epoch = a.heard.of('hello')[0]?.epoch;
    w.chat.closeRoom(ROOM);
    const again = w.attend(ROOM, 'wumbo');
    expect(again.heard.of('hello')[0]?.lines).toEqual([]);
    expect(again.heard.of('hello')[0]?.epoch).not.toBe(epoch);
    // a session held from before the close is over (the broadcaster kept no credential to seat it again); a new one works
    expect(a.session.send({ text: 'after the close' })).toEqual({ ok: false, refused: { reason: 'gate' } });
    const fresh = w.join(ROOM, 'plenk');
    expect(say(w, fresh, 'after the reopen').ok).toBe(true);
    expect(again.heard.texts()).toEqual(['after the reopen']);
  });

  it('closeRoom of a room nobody is in still closes it in the kit, and does not throw', async () => {
    const w = await chatWorld();
    w.cw.rooms.seat('ghost-room', 'seat-x', w.who('plenk'), 'plenk');
    expect(() => w.chat.closeRoom('ghost-room')).not.toThrow();
    expect(w.cw.rooms.subjectAt('ghost-room', 'seat-x')).toBeNull();
  });

  it('a sink that throws on the bye does not stop the room closing', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    a.heard.broken = true;
    expect(() => w.chat.closeRoom(ROOM)).not.toThrow();
    expect(b.heard.frames.at(-1)).toEqual({ type: 'bye', reason: 'room_closed' });
    expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
    expect(w.pending()).toBe(0);
  });

  it('close ends all and clears every scheduled timer (the fake scheduler has none pending)', async () => {
    const w = await chatWorld();
    const a = w.attend('room-a', 'plenk');
    const b = w.attend('room-b', 'wumbo');
    const c = w.attend('room-b', 'glarn');
    c.stream.close(); // a seat grace timer is pending too
    expect(w.pending()).toBeGreaterThan(1);
    w.chat.close();
    for (const heard of [a.heard, b.heard]) expect(heard.frames.at(-1)).toEqual({ type: 'bye', reason: 'shutdown' });
    expect(w.pending()).toBe(0);
    expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
    // seats are released in the kit
    expect(w.cw.rooms.subjectAt('room-a', w.seatOf('room-a', 'plenk'))).toBeNull();
    // unusable afterwards
    expect(w.chat.session(ROOM, w.who('plenk'), { name: 'plenk' })).toEqual({ refused: { reason: 'full' } });
    expect(a.session.send({ text: 'too late' })).toEqual({ ok: false, refused: { reason: 'gate' } });
    expect(a.session.open(spoken().sink)).toEqual({ refused: { reason: 'full' } });
    expect(() => w.chat.close()).not.toThrow();
    expect(() => w.chat.noticePending('s_x' as never)).not.toThrow();
    w.advance(HEARTBEAT * 10);
    expect(a.heard.frames.at(-1)).toEqual({ type: 'bye', reason: 'shutdown' });
  });

  it('close with a sink that throws still clears everything', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    a.heard.broken = true;
    expect(() => w.chat.close()).not.toThrow();
    expect(w.pending()).toBe(0);
  });
});

describe('restart', () => {
  it('a restart is a new epoch: two broadcasters over one cw have different epochs and a client can tell', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    say(w, a.session, 'before the restart');
    const first = a.heard.of('hello')[0];
    w.chat.close();
    expect(a.heard.frames.at(-1)).toEqual({ type: 'bye', reason: 'shutdown' });

    const { createRoomBroadcaster } = await import('../src/chat/broadcaster.js');
    const second = createRoomBroadcaster(w.cw, { now: w.now, schedule: w.schedule });
    const s = second.session(ROOM, w.who('plenk'), { name: 'plenk' });
    if ('refused' in s) throw new Error('refused');
    const heard = spoken();
    s.open(heard.sink);
    const next = heard.of('hello')[0];
    expect(next?.epoch).not.toBe(first?.epoch);
    expect(next?.lines).toEqual([]); // the ring did not survive
    expect(typeof next?.epoch).toBe('string');
  });
});

describe('telling the sink it is done', () => {
  it('end is called when the broadcaster drops a stream (backed up, thrown, bye) and not when the caller closes it', async () => {
    const w = await chatWorld({ options: { maxBacklog: 2 } });
    const closedByCaller = w.attend(ROOM, 'plenk');
    const backedUp = w.attend(ROOM, 'wumbo');
    const thrower = w.attend(ROOM, 'glarn');
    const talker = w.attend(ROOM, 'mivvo');
    closedByCaller.stream.close();
    expect(closedByCaller.heard.ended).toBe(0);
    backedUp.heard.backedUp = true;
    thrower.heard.broken = true;
    say(w, talker.session, 'one');
    say(w, talker.session, 'two');
    expect(backedUp.heard.ended).toBe(1);
    expect(thrower.heard.ended).toBe(1);
    expect(talker.heard.ended).toBe(0);
    w.chat.closeRoom(ROOM);
    expect(talker.heard.frames.at(-1)).toEqual({ type: 'bye', reason: 'room_closed' });
    expect(talker.heard.ended).toBe(1);
    expect(backedUp.heard.ended).toBe(1); // never twice
  });

  it('end is called after the bye of close()', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    w.chat.close();
    expect(a.heard.ended).toBe(1);
  });

  it('a sink whose end throws does not break the broadcaster', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const bad = w.join(ROOM, 'wumbo');
    bad.open({
      write: () => false,
      end: () => {
        throw new Error('end failed');
      },
    });
    expect(() => w.chat.closeRoom(ROOM)).not.toThrow();
    expect(a.heard.ended).toBe(1);
  });
});

describe('canOpen', () => {
  it('is false when open would be refused, and agrees with open', async () => {
    const w = await chatWorld({ options: { maxStreamsPerMember: 1, maxStreams: 2 } });
    const a = w.join(ROOM, 'plenk');
    const b = w.join(ROOM, 'wumbo');
    const c = w.join(ROOM, 'glarn');
    expect(a.canOpen()).toBe(true);
    const first = a.open(spoken().sink);
    expect(a.canOpen()).toBe(true); // at the per-player limit the oldest is evicted, so a new one is always welcome
    expect('close' in a.open(spoken().sink)).toBe(true);
    expect(b.canOpen()).toBe(true);
    b.open(spoken().sink);
    expect(c.canOpen()).toBe(false); // process limit
    expect(c.open(spoken().sink)).toEqual({ refused: { reason: 'full' } });
    if ('refused' in first) throw new Error('refused');
    first.close(); // already evicted: nothing changes
    expect(c.canOpen()).toBe(false);
    a.open(spoken().sink); // the player's own newest stream replaces their oldest: the process count stays
    expect(w.chat.stats().streams).toBe(2);
    w.chat.close();
    expect(c.canOpen()).toBe(false);
  });
});

