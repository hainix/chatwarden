import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RawWho } from '@chatwarden/core';
import type { Client, Room } from './colyseus-types.js';
import { LONG_TOKEN, SECRET, keyOf, settle, withEnv } from './harness.js';
import { attach } from './cases/colyseus/room.js';
import type { ChatAuth } from './cases/colyseus/room.js';
import { createKit } from './cases/express-sqlite-box-element/chatwarden/kit.js';
import type { Kit } from './cases/express-sqlite-box-element/chatwarden/kit.js';

// The Colyseus recipe, run against fakes of Room and Client (Colyseus itself is not a dependency of this repo; the page says so).

let restoreEnv = (): void => undefined;
beforeAll(() => {
  restoreEnv = withEnv({ CHATWARDEN_SECRET: SECRET, CHATWARDEN_ADMIN_TOKEN: LONG_TOKEN, CHATWARDEN_DB: ':memory:', NODE_ENV: 'test' });
});
afterAll(() => restoreEnv());

class FakeRoom implements Room {
  roomId = 'lobby';
  handlers = new Map<string, (client: Client, message: unknown) => void>();
  gameJoined: string[] = [];
  onMessage(type: string, callback: (client: Client, message: unknown) => void): void {
    this.handlers.set(type, callback);
  }
  // The game's own methods: attach() runs them first, then adds the chat.
  onJoin(client: Client): void {
    this.gameJoined.push(client.sessionId);
  }
}

interface FakeClient extends Client {
  sent: Array<{ type: string; message: unknown }>;
  left: Array<{ code?: number; reason?: string }>;
  all(type: string): unknown[];
}
let counter = 0;
function fakeClient(): FakeClient {
  counter += 1;
  const client: FakeClient = {
    sessionId: `session-${counter}`,
    sent: [],
    left: [],
    send: (type, message) => void client.sent.push({ type, message: structuredClone(message) }),
    leave: (code, reason) => void client.left.push({ code, reason }),
    all: (type) => client.sent.filter((m) => m.type === type).map((m) => m.message),
  };
  return client;
}

let kit: Kit;
beforeAll(async () => {
  kit = await createKit();
});
afterAll(async () => {
  await kit.close();
});
const rooms: FakeRoom[] = [];
afterEach(() => {
  rooms.length = 0;
});

const auth = (name: string, who: RawWho = { clientKey: keyOf(name) }): ChatAuth => ({ who, member: { name } });
async function joined(name: string, who?: RawWho, room = new FakeRoom()) {
  rooms.push(room);
  attach(room, kit);
  const client = fakeClient();
  await (room as Room).onJoin?.(client, {}, auth(name, who));
  return { room, client };
}
const frames = (c: FakeClient): Array<Record<string, unknown>> => c.all('chat:frame') as Array<Record<string, unknown>>;

describe('the Colyseus recipe', () => {
  it('attach registers the documented messages; a message answers on the client; onLeave closes the stream', async () => {
    const room = new FakeRoom();
    const a = await joined('pilot', undefined, room);
    expect([...room.handlers.keys()].sort()).toEqual(['chat:mute', 'chat:report', 'chat:send']);
    expect(room.gameJoined).toEqual([a.client.sessionId]);
    expect(frames(a.client)[0]).toMatchObject({ type: 'hello', room: 'lobby' });
    expect(kit.chat.stats().streams).toBe(1);

    const b = fakeClient();
    await (room as Room).onJoin?.(b, {}, auth('ranger'));
    room.handlers.get('chat:send')?.(a.client, { text: 'hello there' });
    expect(a.client.all('chat:result')).toEqual([{ type: 'send', result: expect.objectContaining({ ok: true }) }]);
    expect(frames(b).some((f) => f.type === 'line')).toBe(true);

    room.handlers.get('chat:send')?.(a.client, { text: 'you zorbak' });
    expect(a.client.all('chat:result')[1]).toMatchObject({ type: 'send', result: { ok: false, refused: { reason: 'blocked', rule: 1 } } });
    expect(JSON.stringify(frames(b))).not.toContain('you zorbak');

    const line = (a.client.all('chat:result')[0] as { result: { line: { id: string } } }).result.line.id;
    room.handlers.get('chat:report')?.(b, { lineId: line });
    await settle(50);
    expect(b.all('chat:result')[0]).toMatchObject({ type: 'report', outcome: { ok: true } });
    room.handlers.get('chat:mute')?.(b, { lineId: line, on: true });
    expect(b.all('chat:result')[1]).toMatchObject({ type: 'mute', result: { ok: true, hiddenIds: [line] } });

    // A bad message is an answer, not a throw, and is dropped.
    for (const bad of [null, undefined, 7, { text: 5 }, { text: 'x'.repeat(5000) }]) room.handlers.get('chat:send')?.(a.client, bad);
    expect(a.client.all('chat:result').length).toBe(2 + 5);

    await (room as Room).onLeave?.(a.client, true);
    await (room as Room).onLeave?.(b, true);
    expect(kit.chat.stats().streams).toBe(0);
    // A client that never joined, or one that already left, leaves quietly.
    await (room as Room).onLeave?.(fakeClient(), true);
    await (room as Room).onLeave?.(a.client, true);
  });

  it('a refused session disconnects the client with the reason', async () => {
    const none = await joined('anon', {});
    expect(none.client.left).toEqual([{ code: 4001, reason: 'unauthorized' }]);
    expect(none.client.all('chat:frame')).toEqual([]);
    expect(kit.chat.stats().streams).toBe(0);
    // A message from a client with no session answers nothing and throws nothing.
    none.room.handlers.get('chat:send')?.(none.client, { text: 'hi' });
    expect(none.client.all('chat:result')).toEqual([]);
  });

  it('the recipe\'s comment names the Colyseus major version it follows', () => {
    const source = readFileSync(new URL('./cases/colyseus/room.ts', import.meta.url), 'utf8');
    expect(source).toContain('Colyseus 0.16');
    expect(source).toMatch(/checked against fakes|fakes of Room and Client/);
    expect(source).toMatch(/not run in a real Colyseus|not been run in a real Colyseus/);
  });
});
