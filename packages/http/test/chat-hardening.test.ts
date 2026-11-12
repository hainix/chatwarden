import { describe, expect, it } from 'vitest';
import type { Chatwarden, ChatResult } from '@chatwarden/core';
import { createRoomBroadcaster, inspectBroadcaster } from '../src/chat/broadcaster.js';
import type { SendResult } from '../src/chat/wire.js';
import { BLOCKED, chatWorld, NOW, scripted, SEC, spoken } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';

const ROOM = 'lobby';
const GRACE = 120 * SEC;
const HEARTBEAT = 20 * SEC;

const say = (w: ChatWorld, s: { send(i: { text: string }): SendResult }, text: string): SendResult => {
  w.advance(2 * SEC);
  return s.send({ text });
};

/** Every string reachable from `root` through plain objects, arrays, Maps and Sets (keys included). Functions are not entered. */
function strings(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === 'string') {
      out.push(node);
      continue;
    }
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    if (node instanceof Map) {
      for (const [k, v] of node) stack.push(k, v);
    } else if (node instanceof Set || Array.isArray(node)) {
      for (const v of node) stack.push(v);
    } else {
      for (const [k, v] of Object.entries(node)) stack.push(k, v);
    }
  }
  return out;
}

describe('the broadcaster holds no raw credential (design 11, 12)', () => {
  it('after join, open, send, mute and a close, no string in its state equals or contains the raw key, account or address', async () => {
    const w = await chatWorld();
    const key = 'RAW-CLIENTKEY-plenk-aaaa1111';
    const account = 'RAW-ACCOUNT-plenk-bbbb2222';
    const ip = '203.0.113.171';
    const other = { clientKey: 'RAW-CLIENTKEY-wumbo-cccc3333', ip: '198.51.100.172' };
    const p = w.chat.session(ROOM, { clientKey: key, accountId: account, ip }, { name: 'plenk', tags: { mode: 'ranked' } });
    const q = w.chat.session(ROOM, other, { name: 'wumbo' });
    if ('refused' in p || 'refused' in q) throw new Error('refused');
    const heard = spoken();
    const stream = p.open(heard.sink);
    q.open(spoken().sink);
    const sent = say(w, q, 'a line to mute');
    if (!sent.ok) throw new Error('refused');
    p.mute({ lineId: sent.line.id, on: true });
    say(w, p, 'my own line');
    const state = inspectBroadcaster(w.chat);
    const held = strings(state);
    expect(held.length).toBeGreaterThan(10); // the walk really saw the state
    for (const secret of [key, account, ip, other.clientKey, other.ip]) {
      expect(held.some((s) => s.includes(secret)), secret).toBe(false);
    }
    // also not in the closure-held state a session carries: the session object has no such field
    expect(strings(p)).not.toContain(key);
    if ('refused' in stream) throw new Error('refused');
    stream.close();
    expect(strings(inspectBroadcaster(w.chat)).some((s) => s.includes(key) || s.includes(ip))).toBe(false);
  });

  it('the restriction is re-read by subject, never by a stored identity', async () => {
    let bySubject = 0;
    let byWho = 0;
    const w = await chatWorld({
      wrap: (cw) => {
        const f = Object.create(cw) as Chatwarden;
        f.chat = {
          ...cw.chat,
          restricted: (...args) => {
            byWho += 1;
            return cw.chat.restricted(...args);
          },
          restrictedBySubject: (...args) => {
            bySubject += 1;
            return cw.chat.restrictedBySubject(...args);
          },
        };
        return f;
      },
    });
    const a = w.attend(ROOM, 'plenk');
    await w.sanction('chat', ROOM, 'plenk', 3_600_000);
    w.chat.noticePending(w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk')) as string);
    expect(a.heard.of('state')[0]?.restriction).toEqual({ until: NOW + 3_600_000, byModerator: true });
    expect(byWho).toBe(0);
    expect(bySubject).toBeGreaterThanOrEqual(2); // the hello and the nudge
  });

  it('a seat that was merged into another person is asked about by the survivor', async () => {
    const w = await chatWorld();
    const byAccount = w.attend(ROOM, 'plenk', { accountId: 'acct-hard-1', clientKey: undefined });
    w.attend(ROOM, 'wumbo', { clientKey: 'key-hard-aaaaaaaa' });
    w.chat.session('merge-room', { accountId: 'acct-hard-1', clientKey: 'key-hard-aaaaaaaa' }, { name: 'both' });
    await w.sanction('chat', ROOM, 'wumbo', 3_600_000, { clientKey: 'key-hard-aaaaaaaa' });
    const heard = spoken();
    byAccount.session.open(heard.sink);
    expect(heard.of('hello')[0]?.restriction).toEqual({ until: NOW + 3_600_000, byModerator: true });
  });
});

describe('hello', () => {
  it('carries heartbeatMs, the server heartbeat, so a client can size its liveness watchdog from it', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    expect(a.heard.of('hello')[0]?.heartbeatMs).toBe(20_000);
    const quick = await chatWorld({ options: { heartbeatMs: 5000 } });
    expect(quick.attend(ROOM, 'plenk').heard.of('hello')[0]?.heartbeatMs).toBe(5000);
  });

  it('carries now, the server clock in ms from the injected clock, so a client can read a restriction against it', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    expect(a.heard.of('hello')[0]?.now).toBe(NOW);
    w.advance(90_000);
    const b = w.attend(ROOM, 'vlemmo');
    expect(b.heard.of('hello')[0]?.now).toBe(NOW + 90_000);
    // `now` is a whole number of ms and nothing else about the server's clock leaks (no timezone, no offset)
    expect(Number.isInteger(b.heard.of('hello')[0]?.now)).toBe(true);
  });

  it('heartbeatMs is capped at 60 s: 60 000 builds, 60 001 is a RangeError that does not echo it', async () => {
    const w = await chatWorld({ noBroadcaster: true });
    expect(() => createRoomBroadcaster(w.cw, { heartbeatMs: 60_000 })).not.toThrow();
    for (const bad of [60_001, 3_600_000, 0, -1, 1.5]) {
      let message = '';
      try {
        createRoomBroadcaster(w.cw, { heartbeatMs: bad });
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
        message = (err as Error).message;
      }
      expect(message).toBe('createRoomBroadcaster: heartbeatMs must be a whole number from 1 to 60000');
    }
  });

  it('stays under the 64 KiB a client reads: a profile with long lines trims the history oldest first', async () => {
    const w = await chatWorld({ limits: { chatMaxLength: 1500 } });
    const authors = ['plenk', 'wumbo', 'glarn', 'mivvo'].map((n) => w.join(ROOM, n));
    let i = 0;
    for (let round = 0; round < 13; round += 1) {
      for (const a of authors) {
        const text = `${String(i).padStart(3, '0')} ` + 'x'.repeat(1400);
        const res = say(w, a, text);
        if (!res.ok) throw new Error(`refused ${res.refused.reason}`);
        i += 1;
      }
      w.advance(5 * SEC);
    }
    const late = spoken();
    const reader = w.join(ROOM, 'tarvish');
    reader.open(late.sink);
    const hello = late.of('hello')[0];
    const bytes = new TextEncoder().encode(JSON.stringify(hello)).length;
    expect(bytes).toBeLessThanOrEqual(48 * 1024);
    const lines = hello?.lines ?? [];
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.length).toBeLessThan(50);
    // newest kept, oldest dropped, order preserved
    expect(lines.at(-1)?.text.startsWith('051')).toBe(true);
    const numbers = lines.map((l) => Number(l.text.slice(0, 3)));
    expect(numbers).toEqual([...numbers].sort((x, y) => x - y));
    expect(numbers[0]).toBeGreaterThan(0);
  });

  it('a normal room is not trimmed at all', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    for (let i = 0; i < 50; i += 1) say(w, a.session, `line ${i}`);
    const late = spoken();
    a.session.open(late.sink);
    expect(late.of('hello')[0]?.lines).toHaveLength(50);
  });
});

describe('a ban that lands mid-stream', () => {
  it('ends the stream with bye banned on the next noticePending, with the end of the ban', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const tab = spoken();
    a.session.open(tab.sink);
    const b = w.attend(ROOM, 'wumbo');
    await w.sanction('ban', ROOM, 'plenk', 3_600_000);
    w.chat.noticePending(w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk')) as string);
    for (const heard of [a.heard, tab]) {
      expect(heard.frames.at(-1)).toEqual({ type: 'bye', reason: 'banned', until: NOW + 3_600_000 });
      expect(heard.ended).toBe(1);
    }
    expect(b.heard.frames.map((f) => f.type)).toEqual(['hello']);
    expect(w.chat.stats().streams).toBe(1);
  });

  it('a permanent ban says until null; a chat restriction is not a ban and keeps the stream', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    await w.sanction('ban', ROOM, 'plenk', null);
    w.chat.noticePending(w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk')) as string);
    expect(a.heard.frames.at(-1)).toEqual({ type: 'bye', reason: 'banned', until: null });

    const c = await chatWorld();
    const d = c.attend(ROOM, 'plenk');
    await c.sanction('chat', ROOM, 'plenk', 3_600_000);
    c.chat.noticePending(c.cw.rooms.subjectAt(ROOM, c.seatOf(ROOM, 'plenk')) as string);
    expect(d.heard.frames.slice(1).map((f) => f.type)).toEqual(['notices', 'state']);
    expect(d.heard.ended).toBe(0);
  });
});

describe('after a ban ends the streams', () => {
  it('the seat grace is armed, so the seat, the room and the ring are released', async () => {
    const w = await chatWorld();
    const banned = w.attend(ROOM, 'plenk');
    const seat = w.seatOf(ROOM, 'plenk');
    say(w, banned.session, 'a line before the ban');
    await w.sanction('ban', ROOM, 'plenk', 3_600_000);
    w.chat.noticePending(w.cw.rooms.subjectAt(ROOM, seat) as string);
    expect(banned.heard.frames.at(-1)).toMatchObject({ type: 'bye', reason: 'banned' });
    expect(w.chat.stats()).toEqual({ rooms: 1, members: 1, streams: 0 });
    expect(w.pending()).toBe(1); // the seat grace; the heartbeat is gone with the last stream
    w.advance(GRACE - 1);
    expect(w.chat.stats().members).toBe(1);
    w.advance(1);
    expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
    expect(w.cw.rooms.subjectAt(ROOM, seat)).toBeNull();
    expect(w.pending()).toBe(0);
  });

  it('with other players in the room, only the banned seat is released and the ring stays for them', async () => {
    const w = await chatWorld();
    const banned = w.attend(ROOM, 'plenk');
    const stays = w.attend(ROOM, 'wumbo');
    say(w, banned.session, 'a line before the ban');
    await w.sanction('ban', ROOM, 'plenk', 3_600_000);
    w.chat.noticePending(w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk')) as string);
    w.advance(GRACE);
    expect(w.chat.stats()).toEqual({ rooms: 1, members: 1, streams: 1 });
    const late = spoken();
    stays.session.open(late.sink);
    expect(late.of('hello')[0]?.lines.map((l) => l.text)).toEqual(['a line before the ban']);
  });
});

describe('the facade the broadcaster is built over', () => {
  it('a kit without chat.restrictedBySubject is a TypeError at construction, not a silent "not restricted" later', async () => {
    const w = await chatWorld({ noBroadcaster: true });
    const old = Object.create(w.cw) as Chatwarden;
    old.chat = { ...w.cw.chat, restrictedBySubject: undefined as never };
    expect(() => createRoomBroadcaster(old)).toThrow(TypeError);
    let message = '';
    try {
      createRoomBroadcaster(old);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/restrictedBySubject/);
    expect(message).toMatch(/@chatwarden\/core/);
    for (const bad of [undefined, null, 5, {}, { chat: {} }, { chat: { restrictedBySubject: 'no' } }]) {
      expect(() => createRoomBroadcaster(bad as never)).toThrow(TypeError);
    }
    expect(() => createRoomBroadcaster(w.cw)).not.toThrow();
  });
});

describe('visibility fails closed', () => {
  it('a visibleTo that throws hides the line from that viewer (a mute is a promise), keeps the author\'s own, and fails a report as not_found', async () => {
    let breakIt = false;
    const w = await chatWorld({
      wrap: (cw) => {
        const f = Object.create(cw) as Chatwarden;
        f.chat = {
          ...cw.chat,
          visibleTo: (...args) => {
            if (breakIt) throw new RangeError('mutes are down');
            return cw.chat.visibleTo(...args);
          },
        };
        return f;
      },
    });
    const author = w.attend(ROOM, 'plenk');
    const viewer = w.attend(ROOM, 'wumbo');
    const first = say(w, author.session, 'before the failure');
    if (!first.ok) throw new Error('refused');
    breakIt = true;
    const mine = say(w, author.session, 'during the failure');
    expect(mine.ok).toBe(true);
    expect(author.heard.texts()).toEqual(['before the failure', 'during the failure']); // own lines always show
    expect(viewer.heard.texts()).toEqual(['before the failure']); // the viewer is not shown what cannot be checked
    const late = spoken();
    viewer.session.open(late.sink);
    expect(late.of('hello')[0]?.lines.map((l) => l.text)).toEqual([]);
    expect(await viewer.session.report({ lineId: first.line.id })).toEqual({ ok: false, refused: 'not_found' });
    expect(w.logs.filter((l) => l[0] === 'chatwarden.chat_visibility_failed').length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(w.logs)).not.toContain('mutes are down');
    breakIt = false;
    expect((await viewer.session.report({ lineId: first.line.id })).ok).toBe(true);
  });
});

describe('failures are named', () => {
  it('a session() that fails inside refuses with internal, not full', async () => {
    const w = await chatWorld({
      wrap: (cw) => {
        const f = Object.create(cw) as Chatwarden;
        f.rooms = {
          ...cw.rooms,
          seat: () => {
            throw new TypeError('store down');
          },
        };
        return f;
      },
    });
    expect(w.chat.session(ROOM, w.who('plenk'), { name: 'plenk' })).toEqual({ refused: { reason: 'internal' } });
    expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
    expect(w.logs.filter((l) => l[0].startsWith('chatwarden.chat_'))).toEqual([['chatwarden.chat_seat_failed', { error: 'TypeError' }]]);
  });

  it('maxRooms: a new room over the cap is refused rooms_full; the rooms that exist still take players; a freed room makes room', async () => {
    const w = await chatWorld({ options: { maxRooms: 2 } });
    w.join('room-a', 'plenk');
    w.join('room-b', 'wumbo');
    expect(w.chat.session('room-c', w.who('glarn'), { name: 'glarn' })).toEqual({ refused: { reason: 'rooms_full' } });
    expect('refused' in w.chat.session('room-a', w.who('glarn'), { name: 'glarn' })).toBe(false);
    expect(w.chat.stats().rooms).toBe(2);
    expect(w.seatCalls.some((c) => c.roomId === 'room-c')).toBe(false);
    w.advance(GRACE);
    expect('refused' in w.chat.session('room-c', w.who('glarn'), { name: 'glarn' })).toBe(false);
  });

  it('maxRooms defaults to 10 000 and is validated like the other options', async () => {
    const w = await chatWorld({ noBroadcaster: true });
    for (const bad of [0, -1, 1.5, Number.NaN, '5', 10_000_001]) expect(() => createRoomBroadcaster(w.cw, { maxRooms: bad as number })).toThrow(RangeError);
    expect(() => createRoomBroadcaster(w.cw, { maxRooms: 1 })).not.toThrow();
  });

  it('noticePending: one member whose lookup throws does not stop the others hearing it', async () => {
    let boom = '';
    const w = await chatWorld({
      wrap: (cw) => {
        const f = Object.create(cw) as Chatwarden;
        f.rooms = {
          ...cw.rooms,
          subjectAt: (room, seat) => {
            if (seat === boom) throw new RangeError('lookup failed');
            return cw.rooms.subjectAt(room, seat);
          },
        };
        return f;
      },
    });
    const first = w.attend(ROOM, 'plenk');
    const second = w.attend(ROOM, 'wumbo');
    const third = w.attend(ROOM, 'glarn');
    boom = w.seatOf(ROOM, 'plenk');
    const subject = w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'glarn')) as string;
    expect(() => w.chat.noticePending(subject)).not.toThrow();
    expect(third.heard.frames.slice(1).map((f) => f.type)).toEqual(['notices', 'state']);
    expect(first.heard.frames.map((f) => f.type)).toEqual(['hello']);
    expect(second.heard.frames.map((f) => f.type)).toEqual(['hello']);
    expect(w.logs.filter((l) => l[0] === 'chatwarden.chat_notice_failed')).toEqual([['chatwarden.chat_notice_failed', { error: 'RangeError' }]]);
  });
});

describe('the muted list keeps players who left', () => {
  it('a muted player who left is still listed and can still be unmuted, and the mute applies when they return', async () => {
    const w = await chatWorld();
    const author = w.attend(ROOM, 'plenk');
    const muter = w.attend(ROOM, 'wumbo');
    const line = say(w, author.session, 'a line to mute');
    if (!line.ok) throw new Error('refused');
    muter.session.mute({ lineId: line.line.id, on: true });
    const ref = muter.heard.of('state')[0]?.muted[0]?.ref as string;

    author.stream.close();
    w.advance(GRACE); // the author's seat is released
    expect(w.chat.stats().members).toBe(1);
    const reopened = spoken();
    muter.session.open(reopened.sink);
    expect(reopened.of('hello')[0]?.muted).toEqual([{ ref, name: 'plenk' }]);

    // they come back: the mute still applies, with the same token
    const back = w.attend(ROOM, 'plenk');
    say(w, back.session, 'i am back');
    expect(muter.heard.texts()).not.toContain('i am back');
    back.stream.close();
    w.advance(GRACE);

    // and unmuting by that token works although they are gone
    expect(muter.session.mute({ ref, on: false })).toBe(true);
    expect(muter.heard.of('state').at(-1)?.muted).toEqual([]);
    const again = w.attend(ROOM, 'plenk');
    say(w, again.session, 'now heard');
    expect(muter.heard.texts()).toContain('now heard');
  });

  it('what is kept for a departed player is bounded by the viewers who hold the mute: when the last holder goes, the seat and the room go', async () => {
    const w = await chatWorld();
    const author = w.attend(ROOM, 'plenk');
    const muter = w.attend(ROOM, 'wumbo');
    const line = say(w, author.session, 'a line to mute');
    if (!line.ok) throw new Error('refused');
    muter.session.mute({ lineId: line.line.id, on: true });
    const authorSeat = w.seatOf(ROOM, 'plenk');
    author.stream.close();
    w.advance(GRACE);
    expect(w.cw.rooms.subjectAt(ROOM, authorSeat)).not.toBeNull(); // kept for the muter's list
    expect(w.chat.stats()).toEqual({ rooms: 1, members: 1, streams: 1 });
    muter.stream.close();
    w.advance(GRACE);
    expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
    expect(w.cw.rooms.subjectAt(ROOM, authorSeat)).toBeNull(); // released with the last holder
    expect(w.pending()).toBe(0);
  });

  it('unmuting a player who is still there releases nothing early, and a muter who unmutes lets the departed seat go', async () => {
    const w = await chatWorld();
    const author = w.attend(ROOM, 'plenk');
    const muter = w.attend(ROOM, 'wumbo');
    const other = w.attend(ROOM, 'glarn');
    const line = say(w, author.session, 'a line to mute');
    if (!line.ok) throw new Error('refused');
    muter.session.mute({ lineId: line.line.id, on: true });
    author.stream.close();
    w.advance(GRACE);
    const ref = muter.heard.of('state')[0]?.muted[0]?.ref as string;
    expect(muter.session.mute({ ref, on: false })).toBe(true);
    expect(w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk'))).toBeNull();
    void other;
  });
});

describe('refused text is never logged', () => {
  const MARKER = 'wumbo-secret-line-7731';

  it('a kit that throws with the text in its message logs the class only', async () => {
    const w = await chatWorld({
      wrap: scripted(() => {
        throw new TypeError(`could not check: ${MARKER} ${BLOCKED}`);
      }),
    });
    const a = w.attend(ROOM, 'plenk');
    const res = say(w, a.session, `${MARKER} ${BLOCKED}`);
    expect(res).toEqual({ ok: false, refused: { reason: 'unknown' } });
    expect(JSON.stringify(w.logs)).not.toContain(MARKER);
    expect(JSON.stringify(w.logs).toLowerCase()).not.toContain(BLOCKED);
    expect(w.logs.filter((l) => l[0].startsWith('chatwarden.chat_'))).toEqual([['chatwarden.chat_accept_failed', { error: 'TypeError' }]]);
  });

  it('refused and failed lines of every kind leave the captured log free of the text, the name and the room', async () => {
    const answers: Array<ChatResult | 'throw'> = ['throw', { refuse: { reason: 'blocked', rule: 1 } }, { refuse: { reason: 'rate' } }];
    for (const answer of answers) {
      const w = await chatWorld({
        wrap: scripted(() => {
          if (answer === 'throw') throw new RangeError(`${MARKER}`);
          return answer;
        }),
      });
      const a = w.attend('secret-room-name', 'plenk');
      say(w, a.session, MARKER);
      const logged = JSON.stringify(w.logs);
      for (const needle of [MARKER, 'secret-room-name', 'plenk', w.seatOf('secret-room-name', 'plenk')]) expect(logged).not.toContain(needle);
    }
  });
});

describe('keep-alive intervals', () => {
  it('a quiet room with a connected player keeps pinging at the interval the hello announced', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const announced = a.heard.of('hello')[0]?.heartbeatMs ?? 0;
    w.advance(announced * 3);
    expect(a.heard.pings).toBe(3);
    expect(announced).toBe(HEARTBEAT);
  });
});
