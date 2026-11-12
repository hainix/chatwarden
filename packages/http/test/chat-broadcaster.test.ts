import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_MAX_AGE_MS } from '@chatwarden/core';
import type { Chatwarden, RawWho } from '@chatwarden/core';
import { createRoomBroadcaster, ROOM_BROADCASTER_DEFAULTS } from '../src/chat/broadcaster.js';
import type { ChatSession } from '../src/chat/broadcaster.js';
import { chatWorld, NOW, SEC, spoken } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';

const ROOM = 'lobby';

/** Send one line, moving time on first so the kit's 3-per-5-seconds budget is never what a test is about. */
function say(w: ChatWorld, session: ChatSession, text: string) {
  w.advance(2 * SEC);
  return session.send({ text });
}

describe('delivery', () => {
  it("a delivered line reaches every other open stream and the author's streams, in order, with mine only on the author's", async () => {
    const w = await chatWorld();
    const a1 = w.attend(ROOM, 'plenk');
    const a2 = { heard: spoken() };
    const a2s = a1.session.open(a2.heard.sink);
    expect('refused' in a2s).toBe(false);
    const b = w.attend(ROOM, 'wumbo');
    const c = w.attend(ROOM, 'glarn');

    const first = say(w, a1.session, 'first line');
    const second = say(w, a1.session, 'second line');
    const third = say(w, b.session, 'third line');

    expect(first.ok && second.ok && third.ok).toBe(true);
    for (const heard of [a1.heard, a2.heard, b.heard, c.heard]) {
      expect(heard.frames[0]?.type).toBe('hello');
      expect(heard.texts()).toEqual(['first line', 'second line', 'third line']);
    }
    // ids are the same everywhere, ascending as sent, and the author's answer carries the same id
    expect(a1.heard.ids()).toEqual(c.heard.ids());
    expect(a2.heard.ids()).toEqual(c.heard.ids());
    expect(first.ok && first.line.id).toBe(c.heard.ids()[0]);
    // mine only on the author's own lines, on every one of the author's streams
    const mineOf = (h: ReturnType<typeof spoken>) => h.of('line').map((f) => f.line.mine === true);
    expect(mineOf(a1.heard)).toEqual([true, true, false]);
    expect(mineOf(a2.heard)).toEqual([true, true, false]);
    expect(mineOf(b.heard)).toEqual([false, false, true]);
    expect(mineOf(c.heard)).toEqual([false, false, false]);
    // and the answer to the author says mine too
    expect(first.ok && first.line).toEqual({ id: c.heard.ids()[0], at: NOW + 2 * SEC, name: 'plenk', text: 'first line', mine: true });
    // a line frame is exactly { id, at, name, text, mine? }
    for (const f of c.heard.of('line')) expect(Object.keys(f.line).sort()).toEqual(['at', 'id', 'name', 'text']);
  });

  it('a stream opened later receives the line in hello.lines', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    say(w, a.session, 'early line');
    const late = w.attend(ROOM, 'wumbo');
    const hello = late.heard.of('hello')[0];
    expect(hello?.lines.map((l) => l.text)).toEqual(['early line']);
    expect(hello?.lines[0]?.mine).toBeUndefined();
    expect(late.heard.texts()).toEqual([]); // not repeated as a line frame
    // and the author's own reconnect sees it as mine
    const again = spoken();
    a.session.open(again.sink);
    expect(again.of('hello')[0]?.lines[0]?.mine).toBe(true);
  });

  it('a line in one room reaches nobody in another', async () => {
    const w = await chatWorld();
    const a = w.attend('room-a', 'plenk');
    const b = w.attend('room-b', 'wumbo');
    say(w, a.session, 'only for room a');
    expect(a.heard.texts()).toEqual(['only for room a']);
    expect(b.heard.texts()).toEqual([]);
  });

  it('hello is written before open returns, and is the first frame', async () => {
    const w = await chatWorld();
    const s = w.join(ROOM, 'plenk');
    const heard = spoken();
    const stream = s.open(heard.sink);
    expect('close' in stream).toBe(true);
    expect(heard.frames).toHaveLength(1);
    expect(heard.frames[0]?.type).toBe('hello');
  });

  it('hello carries epoch, room, you.name, maxLength from cw.limits, summary from cw.summary, restriction from cw.chat.restricted, and no other field', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const hello = a.heard.of('hello')[0];
    expect(Object.keys(hello ?? {}).sort()).toEqual(['epoch', 'heartbeatMs', 'lines', 'maxLength', 'muted', 'now', 'restriction', 'room', 'summary', 'type', 'v', 'you']);
    expect(hello).toMatchObject({ type: 'hello', v: 1, room: ROOM, you: { name: 'plenk' }, restriction: null, lines: [], muted: [] });
    expect(hello?.maxLength).toBe(w.cw.limits.chatMaxLength);
    expect(hello?.maxLength).toBe(200);
    expect(hello?.summary).toBe(w.cw.summary);
    expect(hello?.summary.length).toBeGreaterThan(0);
    expect(typeof hello?.epoch).toBe('string');
    expect(hello?.epoch.length).toBeGreaterThan(0);
    expect(Object.keys(hello?.you ?? {})).toEqual(['name']);
  });

  it('restriction in hello is what cw.chat.restricted says, for a moderator chat restriction and for none', async () => {
    const w = await chatWorld();
    const first = w.join(ROOM, 'plenk');
    first.open(spoken().sink);
    await w.sanction('chat', ROOM, 'plenk', 3_600_000);
    const heard = spoken();
    first.open(heard.sink);
    expect(heard.of('hello')[0]?.restriction).toEqual({ until: NOW + 3_600_000, byModerator: true });
    const fine = w.attend(ROOM, 'wumbo');
    expect(fine.heard.of('hello')[0]?.restriction).toBeNull();
  });

  it('a permanent restriction has until null', async () => {
    const w = await chatWorld();
    const s = w.join(ROOM, 'plenk');
    await w.sanction('chat', ROOM, 'plenk', null);
    const heard = spoken();
    s.open(heard.sink);
    expect(heard.of('hello')[0]?.restriction).toEqual({ until: null, byModerator: true });
  });

  it('the epoch differs between rooms and between broadcasters over one kit', async () => {
    const w = await chatWorld();
    const a = w.attend('room-a', 'plenk');
    const b = w.attend('room-b', 'wumbo');
    expect(a.heard.of('hello')[0]?.epoch).not.toBe(b.heard.of('hello')[0]?.epoch);
    const other = createRoomBroadcaster(w.cw, { now: w.now, schedule: w.schedule });
    const s = other.session('room-a', w.who('plenk'), { name: 'plenk' });
    if ('refused' in s) throw new Error('refused');
    const heard = spoken();
    s.open(heard.sink);
    expect(heard.of('hello')[0]?.epoch).not.toBe(a.heard.of('hello')[0]?.epoch);
  });
});

describe('history in hello', () => {
  it('is bounded in count: only the last history.lines', async () => {
    const w = await chatWorld({ options: { history: { lines: 3 } } });
    const a = w.attend(ROOM, 'plenk');
    for (let i = 1; i <= 5; i += 1) say(w, a.session, `line ${i}`);
    const late = w.attend(ROOM, 'wumbo');
    expect(late.heard.of('hello')[0]?.lines.map((l) => l.text)).toEqual(['line 3', 'line 4', 'line 5']);
  });

  it('defaults to 50 lines', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    for (let i = 1; i <= 55; i += 1) say(w, a.session, `line ${i}`);
    const late = w.attend(ROOM, 'wumbo');
    const lines = late.heard.of('hello')[0]?.lines ?? [];
    expect(lines).toHaveLength(50);
    expect(lines[0]?.text).toBe('line 6');
    expect(lines[49]?.text).toBe('line 55');
  });

  it('is bounded in age: never older than the evidence window, in a quiet room too', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    say(w, a.session, 'old line');
    w.advance(EVIDENCE_MAX_AGE_MS); // the line is exactly the window old at the next hello
    const edge = w.attend(ROOM, 'wumbo');
    expect(edge.heard.of('hello')[0]?.lines.map((l) => l.text)).toEqual(['old line']);
    w.advance(1);
    const gone = spoken();
    edge.session.open(gone.sink);
    expect(gone.of('hello')[0]?.lines).toEqual([]);
  });

  it('a lower maxAgeMs is honoured', async () => {
    const w = await chatWorld({ options: { history: { maxAgeMs: 30 * SEC } } });
    const a = w.attend(ROOM, 'plenk');
    say(w, a.session, 'short lived');
    w.advance(30 * SEC + 1);
    const late = spoken();
    a.session.open(late.sink);
    expect(late.of('hello')[0]?.lines).toEqual([]);
  });

  it("is per viewer: a snapshot omits a muted author's lines", async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    const c = w.attend(ROOM, 'glarn');
    say(w, a.session, 'from plenk');
    say(w, b.session, 'from wumbo');
    // the mute is set directly on the kit (the broadcaster's own mute API is a later task)
    w.cw.mutes.set(ROOM, w.seatOf(ROOM, 'glarn'), w.seatOf(ROOM, 'plenk'), true);
    const again = spoken();
    c.session.open(again.sink);
    expect(again.of('hello')[0]?.lines.map((l) => l.text)).toEqual(['from wumbo']);
    // a viewer who muted nobody still sees both
    const other = spoken();
    b.session.open(other.sink);
    expect(other.of('hello')[0]?.lines.map((l) => l.text)).toEqual(['from plenk', 'from wumbo']);
    // and the muter's live stream skips the muted author's next line while others get it
    say(w, a.session, 'next from plenk');
    expect(c.heard.texts()).not.toContain('next from plenk');
    expect(b.heard.texts()).toContain('next from plenk');
  });
});

describe('seats', () => {
  it('the same account in two sessions shares one seat; accountId beats clientKey; two accounts never collide', async () => {
    const w = await chatWorld();
    const s = (who: RawWho, name = 'plenk') => w.chat.session(ROOM, who, { name });
    const one = s({ accountId: 'acct-1', clientKey: 'key-one-aaaaaaaa' });
    const two = s({ accountId: 'acct-1', clientKey: 'key-two-bbbbbbbb' }); // another device, same account
    expect('refused' in one || 'refused' in two).toBe(false);
    expect(w.chat.stats().members).toBe(1);
    expect(new Set(w.seatCalls.map((c) => c.seatId)).size).toBe(1);

    s({ accountId: 'acct-2', clientKey: 'key-one-aaaaaaaa' }); // same key, other account: another seat
    expect(w.chat.stats().members).toBe(2);
    s({ accountId: 'acct-3' });
    expect(w.chat.stats().members).toBe(3);
    s({ clientKey: 'key-only-cccccccc' });
    s({ clientKey: 'key-only-cccccccc', ip: '198.51.100.9' }); // the address does not matter
    expect(w.chat.stats().members).toBe(4);
    expect(new Set(w.seatCalls.map((c) => c.seatId)).size).toBe(4);
  });

  it('an account id and a client key with the same text are different seats', async () => {
    const w = await chatWorld();
    w.chat.session(ROOM, { accountId: 'same-text-1234' }, { name: 'plenk' });
    w.chat.session(ROOM, { clientKey: 'same-text-1234' }, { name: 'wumbo' });
    expect(w.chat.stats().members).toBe(2);
  });

  it('the seat id is not the key, the account or any prefix or suffix of them, and has the shape of an id the limiter can key on', async () => {
    const w = await chatWorld();
    const key = 'raw-client-key-secret-9999';
    const account = 'acct-secret-777';
    w.chat.session(ROOM, { clientKey: key, accountId: account, ip: '203.0.113.50' }, { name: 'plenk' });
    const seat = w.seatOf(ROOM, 'plenk');
    expect(seat).toMatch(/^s[0-9a-f]{32}$/);
    for (const secret of [key, account, '203.0.113.50']) {
      expect(seat).not.toContain(secret);
      // From 5 characters: every 5-character prefix or suffix of these secrets holds a non-hex character, so a random hex seat id can
      // never contain one by chance (a 3- or 4-character slice such as "acc" or "9999" is all hex and would match a random id sometimes).
      for (let n = 5; n <= secret.length; n += 1) {
        expect(seat).not.toContain(secret.slice(0, n));
        expect(seat).not.toContain(secret.slice(secret.length - n));
      }
    }
  });

  it('seat ids are salted: another broadcaster (or salt) gives the same player another seat id; a given seatSalt is stable', async () => {
    const a = await chatWorld();
    const b = await chatWorld();
    a.chat.session(ROOM, a.who('plenk'), { name: 'plenk' });
    b.chat.session(ROOM, b.who('plenk'), { name: 'plenk' });
    expect(a.seatOf(ROOM, 'plenk')).not.toBe(b.seatOf(ROOM, 'plenk'));
    const c = await chatWorld({ options: { seatSalt: 'a-shared-salt-for-two-processes' } });
    const d = await chatWorld({ options: { seatSalt: 'a-shared-salt-for-two-processes' } });
    c.chat.session(ROOM, c.who('plenk'), { name: 'plenk' });
    d.chat.session(ROOM, d.who('plenk'), { name: 'plenk' });
    expect(c.seatOf(ROOM, 'plenk')).toBe(d.seatOf(ROOM, 'plenk'));
  });

  it('session with no account and no client key is refused unauthorized and seats nobody', async () => {
    const w = await chatWorld();
    for (const who of [{}, { ip: '203.0.113.9' }, { clientKey: '' }, { accountId: '', clientKey: '' }, { ip: 'unknown' }, null, undefined, 'a string', 7]) {
      const s = w.chat.session(ROOM, who as RawWho, { name: 'plenk' });
      expect(s).toEqual({ refused: { reason: 'unauthorized' } });
    }
    expect(w.seatCalls).toHaveLength(0);
    expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
    expect(w.pending()).toBe(0);
  });

  it('a banned player gets banned and is not seated', async () => {
    const w = await chatWorld();
    w.attend('elsewhere', 'plenk'); // known to the kit
    await w.sanction('ban', 'elsewhere', 'plenk', 3_600_000);
    const before = w.seatCalls.length;
    const s = w.chat.session(ROOM, w.who('plenk'), { name: 'plenk' });
    expect(s).toMatchObject({ refused: { reason: 'banned', until: NOW + 3_600_000 } });
    expect(Object.keys((s as { refused: object }).refused).every((k) => ['reason', 'until', 'noticeId'].includes(k))).toBe(true);
    expect(w.seatCalls).toHaveLength(before);
    expect(w.chat.stats().rooms).toBe(1); // only 'elsewhere'
    // someone else is unaffected
    expect('refused' in w.chat.session(ROOM, w.who('wumbo'), { name: 'wumbo' })).toBe(false);
  });

  it('a permanent ban has until null', async () => {
    const w = await chatWorld();
    w.join('elsewhere', 'plenk');
    await w.sanction('ban', 'elsewhere', 'plenk', null);
    expect(w.chat.session(ROOM, w.who('plenk'), { name: 'plenk' })).toMatchObject({ refused: { reason: 'banned', until: null } });
  });

  it('a session that is in a room already reuses its seat; tags reach the kit', async () => {
    const w = await chatWorld();
    w.chat.session(ROOM, w.who('plenk'), { name: 'plenk', tags: { mode: 'ranked' } });
    expect(w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk'))).not.toBeNull();
    w.chat.session(ROOM, w.who('plenk'), { name: 'plenk' });
    expect(w.chat.stats().members).toBe(1);
  });
});

describe('names', () => {
  const nameOf = async (name: unknown, options = {}) => {
    const w = await chatWorld({ options });
    const s = w.chat.session(ROOM, w.who('plenk'), { name } as never);
    if ('refused' in s) throw new Error('refused');
    const heard = spoken();
    s.open(heard.sink);
    expect(heard.of('hello')[0]?.you.name).toBe(s.name);
    return { name: s.name, w };
  };

  it('a blank name is Player N, and N counts the joins in the room', async () => {
    const w = await chatWorld();
    const names = ['', '   ', '\t\n', undefined, null, 5].map((n, i) => {
      const s = w.chat.session(ROOM, w.who(`p${i}`), { name: n } as never);
      return 'refused' in s ? '?' : s.name;
    });
    expect(names).toEqual(['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6']);
    // another room counts from 1
    const s = w.chat.session('other-room', w.who('someone'), { name: '' });
    expect('refused' in s ? '?' : s.name).toBe('Player 1');
    // the same player coming back keeps their number
    const again = w.chat.session(ROOM, w.who('p0'), { name: '' });
    expect('refused' in again ? '?' : again.name).toBe('Player 1');
  });

  it('a 40 character name is cut at 32', async () => {
    const { name } = await nameOf('n'.repeat(40));
    expect(name).toBe('n'.repeat(32));
  });

  it('control characters are removed, and the rest trimmed', async () => {
    const { name } = await nameOf('  \u0007wum\u0000bo\nglarn\u001b[0m\u007f  ');
    expect(name).toBe('wumboglarn[0m');
    const bidi = await nameOf(`miv${String.fromCharCode(0x202e)}vo${String.fromCharCode(0x2066)}`);
    expect(bidi.name).toBe('mivvo');
  });

  it('a name that is only control characters is Player N', async () => {
    const { name } = await nameOf('\u0000\u0001\u0002');
    expect(name).toBe('Player 1');
  });

  it('a blocked name becomes Player N (even disguised), and the blocked text is never on the wire', async () => {
    const w = await chatWorld();
    expect(w.cw.names.check('Zorbak_99').ok).toBe(false); // the guard for this test
    const heard = spoken();
    const s = w.chat.session(ROOM, w.who('plenk'), { name: 'Zorbak_99' });
    if ('refused' in s) throw new Error('refused');
    s.open(heard.sink);
    expect(s.name).toBe('Player 1');
    expect(JSON.stringify(heard.frames).toLowerCase()).not.toContain('zorbak');
    expect(w.seatCalls[0]?.handle).toBe('Player 1'); // the kit's seat handle is the checked name too
  });

  it('an emoji name is kept, and a long emoji name is cut by characters, never in the middle of one', async () => {
    const { name } = await nameOf('\u{1F600} plenk \u{1F680}');
    expect(name).toBe('\u{1F600} plenk \u{1F680}');
    const long = await nameOf('\u{1F600}'.repeat(40));
    expect(Array.from(long.name)).toHaveLength(32);
    expect(long.name).toBe('\u{1F600}'.repeat(32));
  });

  it("a name equal to another player's is allowed (the game owns what a name is), each with its own seat", async () => {
    const w = await chatWorld();
    const a = w.chat.session(ROOM, w.who('one'), { name: 'wumbo' });
    const b = w.chat.session(ROOM, w.who('two'), { name: 'wumbo' });
    expect('refused' in a || 'refused' in b).toBe(false);
    expect(w.chat.stats().members).toBe(2);
    expect((a as ChatSession).name).toBe('wumbo');
    expect((b as ChatSession).name).toBe('wumbo');
  });

  it('nameCheck false skips the check', async () => {
    const off = await nameOf('Zorbak_99', { nameCheck: false });
    expect(off.name).toBe('Zorbak_99');
    const on = await nameOf('Zorbak_99', { nameCheck: true });
    expect(on.name).toBe('Player 1');
  });

  it('a name check that throws is logged by class and the name becomes Player N', async () => {
    const w = await chatWorld({
      wrap: (cw) => {
        const f = Object.create(cw) as Chatwarden;
        f.names = {
          ...cw.names,
          check: () => {
            throw new RangeError('the matcher broke on zorbak');
          },
        };
        return f;
      },
    });
    const s = w.chat.session(ROOM, w.who('plenk'), { name: 'plenk' });
    expect('refused' in s ? '?' : s.name).toBe('Player 1');
    expect(w.logs).toEqual([['chatwarden.chat_name_check_failed', { error: 'RangeError' }]]);
  });

  it('the handle the kit sees is the name other players see', async () => {
    const w = await chatWorld();
    w.chat.session(ROOM, w.who('plenk'), { name: '  plenk  ' });
    expect(w.seatCalls[0]?.handle).toBe('plenk');
  });
});

describe('options', () => {
  const build = (options: Record<string, unknown>) => async () => {
    const w = await chatWorld({ noBroadcaster: true });
    return createRoomBroadcaster(w.cw, options);
  };

  it('every invalid value is a RangeError that never echoes the value', async () => {
    const keys = ['maxMembers', 'maxRooms', 'maxStreamsPerMember', 'maxStreams', 'heartbeatMs', 'seatGraceMs', 'maxBacklog'];
    const bad: unknown[] = [0, -987654, 7777.5, Number.NaN, Number.POSITIVE_INFINITY, 'vlemmo-7777', null, {}, [], true, 10 ** 12];
    for (const key of keys) {
      for (const value of bad) {
        let message = '';
        try {
          await build({ [key]: value })();
        } catch (err) {
          expect(err).toBeInstanceOf(RangeError);
          message = (err as Error).message;
        }
        expect(message, `${key}=${String(value)}`).not.toBe('');
        for (const needle of ['987654', '7777', 'vlemmo', '1000000000000']) expect(message).not.toContain(needle);
      }
    }
    for (const history of [{ lines: 0 }, { lines: 101 }, { lines: 1.5 }, { maxAgeMs: 999 }, { maxAgeMs: EVIDENCE_MAX_AGE_MS + 1 }]) {
      await expect(build({ history })()).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('other option types are refused with a TypeError that never echoes the value', async () => {
    for (const options of [{ seatSalt: '' }, { seatSalt: 7 }, { nameCheck: 'yes' }, { now: 'vlemmo-now' }, { schedule: 5 }, { logger: 'vlemmo' }, { logger: {} }, 'vlemmo-options', null, []]) {
      let message = '';
      try {
        await build(options as Record<string, unknown>)();
      } catch (err) {
        expect(err).toBeInstanceOf(TypeError);
        message = (err as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('vlemmo');
    }
  });

  it('the defaults are 50, EVIDENCE_MAX_AGE_MS, 500, 3, 5000, 20000, 120000, 64', async () => {
    expect(ROOM_BROADCASTER_DEFAULTS).toEqual({
      historyLines: 50,
      historyMaxAgeMs: EVIDENCE_MAX_AGE_MS,
      maxMembers: 500,
      maxRooms: 10_000,
      maxStreamsPerMember: 3,
      maxStreams: 5000,
      heartbeatMs: 20_000,
      seatGraceMs: 120_000,
      maxBacklog: 64,
    });
    expect(EVIDENCE_MAX_AGE_MS).toBe(900_000);
    // and they are the values in force: the heartbeat timer and the seat grace sit at the default distances
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    expect([...w.timers.values()].map((t) => t.at - NOW)).toContain(20_000);
    a.stream.close();
    expect([...w.timers.values()].map((t) => t.at - NOW)).toContain(120_000);
  });

  it('a minimal valid set builds', async () => {
    await expect(
      build({ history: { lines: 1, maxAgeMs: 1000 }, maxMembers: 1, maxRooms: 1, maxStreamsPerMember: 1, maxStreams: 1, heartbeatMs: 1, seatGraceMs: 1, maxBacklog: 1, seatSalt: 'x', nameCheck: false })(),
    ).resolves.toBeDefined();
  });
});

describe('failure containment', () => {
  it('no write reaches a sink after its stream is closed', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    say(w, a.session, 'before');
    b.stream.close();
    const frozen = b.heard.frames.length;
    say(w, a.session, 'after');
    w.advance(60 * SEC); // heartbeats too
    expect(b.heard.frames).toHaveLength(frozen);
    expect(b.heard.pings).toBe(0);
    b.stream.close(); // safe twice
    expect(a.heard.texts()).toEqual(['before', 'after']);
  });

  it('a sink that throws on one write loses only that stream, the others still get the line', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    const c = w.attend(ROOM, 'glarn');
    b.heard.broken = true;
    const res = say(w, a.session, 'for everyone');
    expect(res.ok).toBe(true);
    expect(c.heard.texts()).toEqual(['for everyone']);
    expect(a.heard.texts()).toEqual(['for everyone']);
    expect(w.chat.stats().streams).toBe(2);
    // the broken stream is gone for good: it is not written to again
    b.heard.broken = false;
    say(w, a.session, 'second');
    expect(b.heard.texts()).toEqual([]);
    // the log has the event and the class, not the message (which names a blocked term here)
    expect(w.logs).toEqual([['chatwarden.chat_stream_failed', { error: 'Error' }]]);
    expect(JSON.stringify(w.logs)).not.toContain('zorbak');
  });

  it('a sink that throws on hello is closed and the others are unaffected', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const bad = spoken();
    bad.broken = true;
    const s = w.join(ROOM, 'wumbo');
    const stream = s.open(bad.sink);
    expect('close' in stream).toBe(true);
    expect(w.chat.stats().streams).toBe(1);
    say(w, a.session, 'still works');
    expect(a.heard.texts()).toEqual(['still works']);
  });

  it('a sink that closes its own stream from inside a write does not break the delivery loop', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const s = w.join(ROOM, 'wumbo');
    const c = w.attend(ROOM, 'glarn');
    const holder: { stream?: { close(): void } } = {};
    const sink = {
      write: (frame: { type: string }) => {
        if (frame.type === 'line') holder.stream?.close();
      },
    };
    const opened = s.open(sink);
    holder.stream = opened as { close(): void };
    say(w, a.session, 'one');
    say(w, a.session, 'two');
    expect(c.heard.texts()).toEqual(['one', 'two']);
    expect(w.chat.stats().streams).toBe(2);
  });

  it('a throwing logger or clock never breaks delivery', async () => {
    const w = await chatWorld();
    const throwing = createRoomBroadcaster(w.cw, {
      now: w.now,
      schedule: w.schedule,
      logger: {
        warn: () => {
          throw new Error('logger is down');
        },
      },
    });
    const s = throwing.session(ROOM, w.who('plenk'), { name: 'plenk' });
    if ('refused' in s) throw new Error('refused');
    const bad = spoken();
    bad.broken = true;
    s.open(bad.sink);
    expect(() => s.send({ text: 'hello there' })).not.toThrow();
  });
});

describe('send', () => {
  it('never throws, whatever the input', async () => {
    const w = await chatWorld();
    const s = w.join(ROOM, 'plenk');
    for (const input of [undefined, null, 5, 'text', {}, { text: 5 }, { text: null }, { text: {} }, []]) {
      const res = s.send(input as never);
      expect(res).toEqual({ ok: false, refused: { reason: 'empty' } });
    }
  });

  it('a kit whose accept throws answers unknown and logs the class only', async () => {
    const w = await chatWorld({
      wrap: (cw) => {
        const f = Object.create(cw) as Chatwarden;
        f.chat = {
          ...cw.chat,
          accept: () => {
            throw new TypeError('secret detail zorbak');
          },
        };
        return f;
      },
    });
    const a = w.attend(ROOM, 'plenk');
    const res = a.session.send({ text: 'secret line text' });
    expect(res).toEqual({ ok: false, refused: { reason: 'unknown' } });
    expect(w.logs).toEqual([['chatwarden.chat_accept_failed', { error: 'TypeError' }]]);
    expect(a.heard.texts()).toEqual([]);
  });

  it('the line is trimmed by the kit and delivered as the kit returns it (starred text is starred on the wire)', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    const res = say(w, a.session, '   hello   there   ');
    expect(res.ok && res.line.text).toBe('hello   there');
    expect(b.heard.texts()).toEqual(['hello   there']);
  });

  it('the evidence line id is the wire id, so a report can name it', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    const res = say(w, a.session, 'a reportable line');
    expect(res.ok).toBe(true);
    const id = res.ok ? res.line.id : '';
    const evidence = await w.cw.reports.submit({ roomId: ROOM, reporterSeat: w.seatOf(ROOM, 'wumbo'), targetSeat: w.seatOf(ROOM, 'plenk'), lineId: id, category: 'harassment' });
    expect(evidence.ok).toBe(true);
    void b;
  });
});

describe('browser safety', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

  /** Every file the entry reaches through relative imports and re-exports. */
  function reach(entry: string): Map<string, string> {
    const seen = new Map<string, string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      const text = readFileSync(file, 'utf8');
      seen.set(file, text);
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
        queue.push(join(dirname(file), (m[1] as string).replace(/\.js$/, '.ts')));
      }
    }
    return seen;
  }

  it('the module graph imports no node: module and uses no Buffer, process or require', () => {
    const files = reach(join(SRC, 'chat', 'broadcaster.ts'));
    expect([...files.keys()].map((f) => f.replaceAll('\\', '/').split('/src/')[1]).sort()).toEqual(['chat/broadcaster.ts', 'chat/history.ts', 'chat/random.ts', 'chat/wire.ts']);
    for (const [file, text] of files) {
      const code = text.replaceAll(/\/\/.*$/gm, '').replaceAll(/\/\*[\s\S]*?\*\//g, '');
      expect(code, file).not.toMatch(/from\s*['"]node:/);
      expect(code, file).not.toMatch(/import\s*\(\s*['"]node:/);
      expect(code, file).not.toMatch(/\bBuffer\b/);
      expect(code, file).not.toMatch(/\bprocess\./);
      expect(code, file).not.toMatch(/\brequire\s*\(/);
      expect(code, file).not.toMatch(/Date\.now\s*\(/);
    }
  });
});
