import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './server.js';
import type { TinyChat } from './server.js';

// CW_DEMO_ROOMS=1 (or the `demoRooms` option) turns on room control with no setup: a `demo-staff-` key is staff and can lock the lobby, unlock it and take a line back for everyone, and the
// chat shows the lock (a non-staff line is refused `locked`, a staff line is delivered), the lock ends by itself, and a taken-back line disappears from a second client but stays in a later
// report's excerpt. Without it none of that exists.

const ambient = { rooms: process.env.CW_DEMO_ROOMS, url: process.env.DISCORD_WEBHOOK_URL, role: process.env.DISCORD_MENTION_ROLE_ID };
beforeAll(() => {
  delete process.env.CW_DEMO_ROOMS;
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.DISCORD_MENTION_ROLE_ID;
});
afterEach(() => {
  delete process.env.CW_DEMO_ROOMS;
});
afterAll(() => {
  for (const [key, value] of [['CW_DEMO_ROOMS', ambient.rooms], ['DISCORD_WEBHOOK_URL', ambient.url], ['DISCORD_MENTION_ROLE_ID', ambient.role]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const ADMIN = 'rooms-admin-token';
const ROOM = 'lobby';
const T0 = 1_800_000_000_000;
const servers: TinyChat[] = [];
const open: Array<() => void> = [];
afterEach(() => {
  for (const stop of open.splice(0)) stop();
});
afterAll(async () => {
  for (const s of servers) await s.close();
});

/** A server on a clock the test moves. */
async function boot(opts: Parameters<typeof startServer>[0] = {}) {
  const clock = { t: T0, now: () => clock.t };
  const server = await startServer({ port: 0, secret: 'rooms-test-secret-not-for-production', adminToken: ADMIN, discordWebhookUrl: '', clock, ...opts });
  servers.push(server);
  return { server, clock, base: `http://127.0.0.1:${server.port}` };
}
const keyOf = (name: string): string => `demo-key-${name}-0001-secret`;
const staffKey = (name: string): string => `demo-staff-${name}-0001-secret`;

type Json = Record<string, unknown>;
const send = async (base: string, key: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'x-chatwarden-key': key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    // not json: a 404 page
  }
  return { status: res.status, json };
};
const say = (base: string, key: string, text: string) => send(base, key, `/chat/rooms/${ROOM}/lines`, { text });
const lock = (base: string, key: string, forMs?: number) => send(base, key, `/demo/rooms/${ROOM}/lock`, forMs === undefined ? {} : { forMs });
const admin = async (base: string, path: string): Promise<{ status: number; json: Json }> => {
  const res = await fetch(`${base}${path}`, { headers: { 'x-admin-token': ADMIN } });
  return { status: res.status, json: (await res.json()) as Json };
};

/** An open stream and its frames. */
async function listen(base: string, key: string) {
  const ac = new AbortController();
  open.push(() => ac.abort());
  const res = await fetch(`${base}/chat/rooms/${ROOM}/stream`, { headers: { 'x-chatwarden-key': key, accept: 'text/event-stream' }, signal: ac.signal });
  let text = '';
  void (async () => {
    try {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted
    }
  })();
  const frames = (): Json[] => [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1] as string) as Json);
  const until = async (pred: (f: Json[]) => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !pred(frames()); i += 1) await new Promise((r) => setTimeout(r, 10));
    if (!pred(frames())) throw new Error(`timed out; got ${text.slice(0, 300)}`);
  };
  return { frames, until };
}

describe('tiny-chat with CW_DEMO_ROOMS', () => {
  it('a staff key locks the lobby: a non-staff line is refused locked, a staff line is delivered', async () => {
    const { base } = await boot({ demoRooms: true });
    expect((await say(base, keyOf('quissel'), 'hello before the lock')).json['ok']).toBe(true);
    const locked = await lock(base, staffKey('mod'));
    expect(locked.status).toBe(200);
    expect(locked.json['mode']).toBe('locked');
    expect(locked.json['until']).toBe(T0 + 30 * 60_000);
    const refused = await say(base, keyOf('quissel'), 'can anyone hear me');
    expect(refused.json['ok']).toBe(false);
    expect(refused.json['refused']).toMatchObject({ reason: 'locked', until: T0 + 30 * 60_000 });
    const staff = await say(base, staffKey('mod'), 'the lobby is locked for a minute');
    expect(staff.json['ok']).toBe(true);
  });

  it('the lock expires on its own: the clock passes the end and a non-staff line is delivered', async () => {
    const { base, clock } = await boot({ demoRooms: true });
    await lock(base, staffKey('mod'), 60_000);
    expect((await say(base, keyOf('quissel'), 'still locked')).json['ok']).toBe(false);
    clock.t += 59_000;
    expect((await say(base, keyOf('quissel'), 'one second to go')).json['ok']).toBe(false);
    clock.t += 2_000;
    expect((await say(base, keyOf('quissel'), 'it ended by itself')).json['ok']).toBe(true);
  });

  it('unlock clears it at once', async () => {
    const { base } = await boot({ demoRooms: true });
    await lock(base, staffKey('mod'));
    expect((await say(base, keyOf('tarvo'), 'locked')).json['ok']).toBe(false);
    const open = await send(base, staffKey('mod'), `/demo/rooms/${ROOM}/unlock`);
    expect(open.status).toBe(200);
    expect(open.json['mode']).toBe('normal');
    expect((await say(base, keyOf('tarvo'), 'open again')).json['ok']).toBe(true);
  });

  it('only a staff key may lock, unlock or take a line back: any other key is 403, and a length the kit refuses is a 400', async () => {
    const { base } = await boot({ demoRooms: true });
    for (const path of [`/demo/rooms/${ROOM}/lock`, `/demo/rooms/${ROOM}/unlock`, `/demo/rooms/${ROOM}/lines/1/retract`]) {
      const res = await send(base, keyOf('glarn'), path, {});
      expect(res.status, path).toBe(403);
      expect(res.json['refused']).toBe('not_staff');
    }
    // A key that only looks like staff in the middle is not staff.
    expect((await lock(base, 'demo-key-demo-staff-0001-secret')).status).toBe(403);
    expect((await lock(base, staffKey('mod'), 5)).status).toBe(400);
    expect((await send(base, staffKey('mod'), '/demo/rooms/elsewhere/lock', {})).status).toBe(404);
  });

  it('a taken-back line disappears from a second client and stays in a later report\'s excerpt', async () => {
    const { base } = await boot({ demoRooms: true });
    const second = await listen(base, keyOf('tarvo'));
    await second.until((f) => f.some((x) => x['type'] === 'hello'));
    const said = await say(base, keyOf('fenrisk'), 'a line to take back');
    const line = said.json['line'] as { id: string };
    expect(typeof line.id).toBe('string');
    await second.until((f) => f.some((x) => x['type'] === 'line' && JSON.stringify(x).includes('a line to take back')));
    const taken = await send(base, staffKey('mod'), `/demo/rooms/${ROOM}/lines/${encodeURIComponent(line.id)}/retract`, {});
    expect(taken.status).toBe(200);
    expect(taken.json['count']).toBe(1);
    await second.until((f) => f.some((x) => x['type'] === 'retract' && JSON.stringify(x).includes(line.id)));
    // A second take-back of the same line is not found.
    expect((await send(base, staffKey('mod'), `/demo/rooms/${ROOM}/lines/${encodeURIComponent(line.id)}/retract`, {})).status).toBe(404);
    // A report filed after it (about the author's next line: the taken-back one is gone from the chat, so it cannot be picked) still holds the text in its excerpt, marked taken back: it is evidence.
    const next = (await say(base, keyOf('fenrisk'), 'and another line')).json['line'] as { id: string };
    const filed = await send(base, keyOf('tarvo'), `/chat/rooms/${ROOM}/report`, { lineId: next.id, reason: 'harassment' });
    expect(filed.json, JSON.stringify(filed.json)).toMatchObject({ ok: true });
    const list = await admin(base, '/admin/reports');
    const items = list.json['items'] as Array<{ id: string }>;
    const report = await admin(base, `/admin/reports/${items[0]?.id}`);
    const excerpt = (report.json['report'] as { excerpt: Array<{ raw: string; retracted?: boolean }> }).excerpt;
    const kept = excerpt.find((l) => l.raw === 'a line to take back');
    expect(kept).toBeDefined();
    expect(kept?.retracted).toBe(true);
  });

  it('"remove all recent lines" takes back every line of the author still in the buffer', async () => {
    const { base } = await boot({ demoRooms: true });
    const first = (await say(base, keyOf('snerp'), 'spam one')).json['line'] as { id: string };
    await say(base, keyOf('snerp'), 'spam two');
    await say(base, keyOf('drakkuun'), 'a bystander');
    const res = await send(base, staffKey('mod'), `/demo/rooms/${ROOM}/lines/${encodeURIComponent(first.id)}/retract`, { allFromAuthor: true });
    expect(res.json['count']).toBe(2);
  });

  it('the WebSocket accepts a staff key\'s lines in a locked room, and refuses others', async () => {
    const { server } = await boot({ demoRooms: true });
    const { WebSocket } = await import('ws');
    const base = `http://127.0.0.1:${server.port}`;
    await lock(base, staffKey('mod'));
    const frames: Json[] = [];
    const ws = (key: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${key}`);
      socket.on('message', (d) => void frames.push(JSON.parse(d.toString()) as Json));
      open.push(() => socket.close());
      return socket;
    };
    const wait = async (pred: () => boolean): Promise<void> => {
      for (let i = 0; i < 300 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 10));
      if (!pred()) throw new Error('timed out');
    };
    const player = ws(keyOf('quissel'));
    await wait(() => frames.some((f) => f['type'] === 'welcome'));
    player.send(JSON.stringify({ type: 'chat', text: 'am I locked' }));
    await wait(() => frames.some((f) => f['type'] === 'refused' && f['reason'] === 'locked'));
    const staff = ws(staffKey('mod'));
    await wait(() => frames.filter((f) => f['type'] === 'welcome').length === 2);
    staff.send(JSON.stringify({ type: 'chat', text: 'staff speaking' }));
    await wait(() => frames.some((f) => f['type'] === 'chat' && f['text'] === 'staff speaking'));
  });
});

describe('without the switch none of it exists', () => {
  it('the routes are not there, and a staff-looking key is not staff', async () => {
    const { base } = await boot();
    for (const path of [`/demo/rooms/${ROOM}/lock`, `/demo/rooms/${ROOM}/unlock`, `/demo/rooms/${ROOM}/lines/1/retract`]) {
      expect((await send(base, staffKey('mod'), path, {})).status, path).toBe(404);
    }
    // The room is locked by the staff API (it is always there with a token), and the staff-looking key is refused like anyone.
    const res = await fetch(`${base}/admin/rooms/${ROOM}/mode`, { method: 'POST', headers: { 'x-admin-token': ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'locked' }) });
    expect(res.status).toBe(200);
    const refused = await say(base, staffKey('mod'), 'staff in name only');
    expect(refused.json['ok']).toBe(false);
    expect(refused.json['refused']).toMatchObject({ reason: 'locked' });
  });

  it('the page is not told, and an explicit false wins over the environment', async () => {
    process.env.CW_DEMO_ROOMS = '1';
    const off = await boot({ demoRooms: false });
    expect((await send(off.base, staffKey('mod'), `/demo/rooms/${ROOM}/lock`, {})).status).toBe(404);
    expect(await (await fetch(`${off.base}/`)).text()).not.toContain('tiny-chat-rooms');
    const on = await boot();
    expect((await lock(on.base, staffKey('mod'))).status).toBe(200);
    expect(await (await fetch(`${on.base}/`)).text()).toContain('tiny-chat-rooms');
  });
});
