import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createChatwarden } from '@chatwarden/core';
import { createRoomBroadcaster } from '@chatwarden/http/chat';
import { MemoryStore } from '@chatwarden/store-memory';
import { Server } from 'socket.io';
import { io as connectClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BLOCKED_WORD, LONG_TOKEN, SECRET, keyOf, settle, withEnv } from './harness.js';
import * as hooks from './cases/express-sqlite-box-socketio/chatwarden/auth.js';
import { createKit } from './cases/express-sqlite-box-socketio/chatwarden/kit.js';
import type { Kit } from './cases/express-sqlite-box-socketio/chatwarden/kit.js';
import { attachChat } from './cases/express-sqlite-box-socketio/chatwarden/socketio.js';

// The generated Socket.IO recipe, run over a real socket.io server and socket.io-client.

let restoreEnv = (): void => undefined;
beforeAll(() => {
  restoreEnv = withEnv({ CHATWARDEN_SECRET: SECRET, CHATWARDEN_ADMIN_TOKEN: LONG_TOKEN, CHATWARDEN_DB: ':memory:', NODE_ENV: 'test' });
});
afterAll(() => restoreEnv());

type Frame = Record<string, unknown>;
interface Player {
  socket: ClientSocket;
  frames: Frame[];
  /** Everything the server sent this player, as text: frames, refusals and acks. */
  seen: string[];
  refused: unknown[];
  disconnected: Promise<string>;
  ask(event: string, input: unknown): Promise<unknown>;
}

interface Running {
  kit: Kit;
  io: Server;
  http: HttpServer;
  url: string;
}
const running: Running[] = [];
const players: Player[] = [];

afterEach(async () => {
  for (const p of players.splice(0)) p.socket.close();
  for (const r of running.splice(0)) {
    await r.io.close();
    await r.kit.close();
  }
});

async function boot(kit?: Kit): Promise<Running> {
  const made = kit ?? (await createKit());
  const http = createServer();
  const io = new Server(http);
  attachChat(io, made);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const run = { kit: made, io, http, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}${made.base}/chat` };
  running.push(run);
  return run;
}

function join(run: Running, key: string | undefined, room = 'lobby'): Player {
  const socket = connectClient(run.url, { auth: { ...(key === undefined ? {} : { key }), room }, transports: ['websocket'], reconnection: false, forceNew: true });
  const player: Player = {
    socket,
    frames: [],
    seen: [],
    refused: [],
    disconnected: new Promise((resolve) => socket.once('disconnect', (reason) => resolve(String(reason)))),
    ask: (event, input) =>
      new Promise((resolve) => {
        socket.emit(event, input, (answer: unknown) => {
          player.seen.push(JSON.stringify(answer));
          resolve(answer);
        });
      }),
  };
  socket.on('chat:frame', (frame: Frame) => {
    player.frames.push(frame);
    player.seen.push(JSON.stringify(frame));
  });
  socket.on('chat:refused', (refused: unknown) => {
    player.refused.push(refused);
    player.seen.push(JSON.stringify(refused));
  });
  players.push(player);
  return player;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await settle(10);
  }
}
const hello = (p: Player): boolean => p.frames.some((f) => f.type === 'hello');

describe('two sockets in the lobby', () => {
  it('two sockets in lobby: a line from one reaches the other with mine only on the sender\'s copy', async () => {
    const run = await boot();
    const a = join(run, keyOf('alice'));
    const b = join(run, keyOf('bob'));
    await until(() => hello(a) && hello(b));
    expect(a.frames[0]).toMatchObject({ type: 'hello', room: 'lobby' });
    const answer = (await a.ask('chat:send', { text: 'hello bob' })) as { ok: boolean; line: { text: string; mine?: boolean } };
    expect(answer).toMatchObject({ ok: true, line: { text: 'hello bob', mine: true } });
    await until(() => b.frames.some((f) => f.type === 'line'));
    const heard = b.frames.find((f) => f.type === 'line') as { line: { text: string; mine?: boolean; name: string } };
    expect(heard.line.text).toBe('hello bob');
    expect(heard.line.mine).toBeUndefined();
    expect(heard.line.name).toMatch(/^Player \d+$/);
    await until(() => a.frames.some((f) => f.type === 'line'));
    expect((a.frames.find((f) => f.type === 'line') as { line: { mine?: boolean } }).line.mine).toBe(true);
  });

  it("a blocked line is refused to its author's ack only and no other socket gets it", async () => {
    const run = await boot();
    const a = join(run, keyOf('cara'));
    const b = join(run, keyOf('dion'));
    await until(() => hello(a) && hello(b));
    const answer = await a.ask('chat:send', { text: `you ${BLOCKED_WORD}` });
    expect(answer).toMatchObject({ ok: false, refused: { reason: 'blocked', rule: 1 } });
    await settle(200);
    expect(b.seen.join('')).not.toContain(BLOCKED_WORD);
    expect(a.seen.filter((s) => s.includes(BLOCKED_WORD))).toEqual([]);
    expect(b.frames.filter((f) => f.type === 'line')).toEqual([]);
  });
});

describe('who may connect', () => {
  it('a socket with no identity is refused at the handshake with the reason unauthorized', async () => {
    const run = await boot();
    const none = connectClient(run.url, { auth: { room: 'lobby' }, transports: ['websocket'], reconnection: false, forceNew: true });
    const err = await new Promise<Error>((resolve) => none.once('connect_error', resolve));
    none.close();
    expect(err.message).toBe('unauthorized');
    // An empty key is no identity either.
    const empty = connectClient(run.url, { auth: { key: '', room: 'lobby' }, transports: ['websocket'], reconnection: false, forceNew: true });
    expect((await new Promise<Error>((resolve) => empty.once('connect_error', resolve))).message).toBe('unauthorized');
    empty.close();
    expect(run.kit.chat.stats().streams).toBe(0);
  });

  it('a room the join hook refuses is disconnected with the reason forbidden, and no seat is taken', async () => {
    const run = await boot();
    const p = join(run, keyOf('erin'), 'some-other-room');
    await p.disconnected;
    expect(p.refused).toEqual([{ reason: 'forbidden' }]);
    expect(p.frames).toEqual([]);
    expect(run.kit.chat.stats().members).toBe(0);
    // A missing room is refused the same way.
    const q = join(run, keyOf('erin'), '');
    await q.disconnected;
    expect(q.refused).toEqual([{ reason: 'forbidden' }]);
  });

  it('a banned player is told banned and disconnected', async () => {
    const run = await boot();
    const probe = join(run, keyOf('fenn'));
    await until(() => hello(probe));
    const subject = await subjectOf(run, keyOf('fenn'));
    await run.kit.cw.sanctions.apply({ kind: 'ban', subject, includeIp: false, durationMs: 3_600_000, reason: 'private moderator reason', actor: 'mod@example.test', source: 'moderator', automated: false, rule: 2, roomId: 'lobby' });
    run.kit.chat.noticePending(subject);
    await probe.disconnected;
    const again = join(run, keyOf('fenn'));
    await again.disconnected;
    expect(again.refused).toEqual([expect.objectContaining({ reason: 'banned' })]);
    expect(JSON.stringify(again.refused)).not.toContain('private moderator reason');
  });
});

async function subjectOf(run: Running, key: string) {
  const probe = 'probe-seat';
  run.kit.cw.rooms.seat('lobby', probe, { clientKey: key }, 'probe');
  const subject = run.kit.cw.rooms.subjectAt('lobby', probe);
  run.kit.cw.rooms.unseat('lobby', probe);
  if (subject === null) throw new Error('no subject');
  return subject;
}

describe('what a socket is told', () => {
  it('no seat, subject, key, hash or ip appears in any emitted frame or ack (seeded values scan)', async () => {
    const run = await boot();
    const a = join(run, keyOf('gale'));
    const b = join(run, keyOf('hugo'));
    await until(() => hello(a) && hello(b));
    const sent = (await a.ask('chat:send', { text: 'a first line' })) as { line: { id: string } };
    await until(() => b.frames.some((f) => f.type === 'line'));
    await b.ask('chat:send', { text: `no ${BLOCKED_WORD}` });
    await b.ask('chat:mute', { lineId: sent.line.id, on: true });
    await b.ask('chat:mute', { lineId: sent.line.id, on: false });
    await b.ask('chat:report', { lineId: sent.line.id, reason: 'other', note: 'a note' });
    const late = join(run, keyOf('ivor'));
    await until(() => hello(late));
    await settle(150);
    const everything = [a, b, late].flatMap((p) => p.seen).join('\n');
    expect(everything.length).toBeGreaterThan(200);
    for (const seeded of [keyOf('gale'), keyOf('hugo'), keyOf('ivor'), SECRET, '127.0.0.1', '::1', 'clientKey', 'accountId', 'seatId', 'subject', 'reportId', 'hash', BLOCKED_WORD]) {
      expect(everything, seeded).not.toContain(seeded);
    }
  });

  it('mute and report answer in their acks, and a bad input is an answer, not a crash', async () => {
    const run = await boot();
    const a = join(run, keyOf('jana'));
    const b = join(run, keyOf('kyle'));
    await until(() => hello(a) && hello(b));
    const sent = (await a.ask('chat:send', { text: 'say something' })) as { line: { id: string } };
    await until(() => b.frames.some((f) => f.type === 'line'));
    expect(await b.ask('chat:report', { lineId: sent.line.id })).toMatchObject({ ok: true });
    expect(await b.ask('chat:mute', { lineId: sent.line.id, on: true })).toMatchObject({ ok: true, hiddenIds: [sent.line.id] });
    for (const bad of [null, undefined, 7, 'text', [], { text: 5 }, { text: 'x'.repeat(5000) }]) {
      const answer = await b.ask('chat:send', bad);
      expect(answer, JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(await b.ask('chat:mute', { on: true })).toMatchObject({ ok: false });
    expect(await b.ask('chat:mute', { lineId: 'x', ref: 'y', on: true })).toMatchObject({ ok: false });
    expect(await b.ask('chat:report', { lineId: 12 })).toMatchObject({ ok: false });
    // An event with no acknowledgement function is ignored, and the connection stays up.
    b.socket.emit('chat:send', { text: 'no ack' });
    b.socket.emit('chat:mute');
    b.socket.emit('chat:report', 5);
    await settle(100);
    expect(b.socket.connected).toBe(true);
    expect(await b.ask('chat:send', { text: 'still here' })).toMatchObject({ ok: true });
  });
});

describe('leaving', () => {
  it('disconnect closes the stream and the seat is released after the grace (fake clock via the broadcaster\'s now and schedule options)', async () => {
    const clock = { t: 1_800_000_000_000 };
    const timers: Array<{ due: number; fn: () => void; live: boolean }> = [];
    const advance = (ms: number): void => {
      clock.t += ms;
      for (const timer of [...timers].sort((x, y) => x.due - y.due)) {
        if (timer.live && timer.due <= clock.t) {
          timer.live = false;
          timer.fn();
        }
      }
    };
    const cw = await createChatwarden({ store: new MemoryStore(), secret: SECRET, platform: { identify: () => ({}) }, clock: { now: () => clock.t }, retention: false });
    const chat = createRoomBroadcaster(cw, {
      now: () => clock.t,
      schedule: (fn, ms) => {
        const timer = { due: clock.t + ms, fn, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    });
    const kit = { cw, chat, hooks, base: '/chatwarden', close: async () => (chat.close(), cw.close()) } as unknown as Kit;
    const run = await boot(kit);
    const a = join(run, keyOf('mara'));
    await until(() => hello(a));
    expect(chat.stats()).toMatchObject({ streams: 1, members: 1 });
    a.socket.close();
    await until(() => chat.stats().streams === 0);
    // The stream is closed at once; the seat stays for the grace, and is released when it ends.
    expect(chat.stats().members).toBe(1);
    advance(119_000);
    expect(chat.stats().members).toBe(1);
    advance(2_000);
    expect(chat.stats().members).toBe(0);
  });

  it('the server closing ends every socket with bye shutdown', async () => {
    const run = await boot();
    const a = join(run, keyOf('nils'));
    await until(() => hello(a));
    run.kit.chat.close();
    await until(() => a.frames.some((f) => f.type === 'bye'));
    expect(a.frames.find((f) => f.type === 'bye')).toMatchObject({ reason: 'shutdown' });
  });
});
