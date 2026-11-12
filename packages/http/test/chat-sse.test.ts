import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { toExpress } from '../src/express.js';
import { BLOCKED, routeWorld, SEC } from './chat-world.js';
import type { RouteWorld } from './chat-world.js';

// The chat routes over a real Express app (through `toExpress`) and real `fetch`: the same code the adopter mounts.

const ROOM = 'lobby';
const HEARTBEAT_MS = 20 * SEC;
const GRACE_MS = 120 * SEC;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function serve(w: RouteWorld, mount = '/chat'): Promise<string> {
  const app = express();
  app.use(mount, toExpress(w.routes, { fallthrough: false }));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${mount}`;
}

/** Poll until `check` holds (real time: the server runs on a real socket). */
async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** An open stream over fetch: everything read so far, parsed into events. */
async function connect(base: string, headers: Record<string, string>, room = ROOM) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/rooms/${room}/stream`, { headers, signal: ctl.signal });
  let text = '';
  let done = false;
  const decoder = new TextDecoder();
  const reader = res.body?.getReader();
  const pump = (async () => {
    try {
      for (;;) {
        const r = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
        if (r.done) break;
        text += decoder.decode(r.value, { stream: true });
      }
    } catch {
      // aborted
    }
    done = true;
  })();
  const events = (): Array<{ event: string; data: unknown }> =>
    text
      .split('\n\n')
      .filter((block) => block.startsWith('event: '))
      .map((block) => {
        const [first, second] = block.split('\n');
        return { event: (first as string).slice(7), data: JSON.parse((second as string).slice(6)) as unknown };
      });
  return { res, ctl, text: () => text, events, done: () => done, pump };
}

const post = (base: string, room: string, route: string, headers: Record<string, string>, body: unknown) =>
  fetch(`${base}/rooms/${room}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('the stream over real HTTP', () => {
  it('hello is the first event', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    const c = await connect(base, w.as('plenk'));
    await until(() => c.events().length >= 1, 'hello');
    const first = c.events()[0];
    expect(first?.event).toBe('hello');
    expect(first?.data).toMatchObject({ type: 'hello', v: 1, room: ROOM, you: { name: 'plenk' }, maxLength: 200, restriction: null, lines: [], muted: [] });
    c.ctl.abort();
  });

  it('headers: text/event-stream, no-store and no-transform, nosniff, x-accel-buffering no', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    const c = await connect(base, w.as('plenk'));
    expect(c.res.status).toBe(200);
    expect(c.res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(c.res.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(c.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(c.res.headers.get('x-accel-buffering')).toBe('no');
    expect(c.res.headers.get('content-encoding')).toBeNull();
    expect(c.res.headers.get('etag')).toBeNull();
    c.ctl.abort();
  });

  it('a heartbeat arrives at heartbeatMs (fake schedule driven)', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    const c = await connect(base, w.as('plenk'));
    await until(() => c.events().length >= 1, 'hello');
    expect(c.text()).not.toContain(': ping');
    w.advance(HEARTBEAT_MS);
    await until(() => c.text().includes(': ping\n\n'), 'a heartbeat');
    w.advance(HEARTBEAT_MS);
    await until(() => c.text().split(': ping').length === 3, 'a second heartbeat');
    // a comment is not an event
    expect(c.events().map((e) => e.event)).toEqual(['hello']);
    c.ctl.abort();
  });

  it('a line from another player arrives as a line event, and the answer to the POST is the same line', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    const c = await connect(base, w.as('plenk'));
    await until(() => c.events().length >= 1, 'hello');
    w.advance(2 * SEC);
    const answer = (await (await post(base, ROOM, 'lines', w.as('wumbo'), { text: 'hello there' })).json()) as { ok: boolean; line: { id: string } };
    expect(answer.ok).toBe(true);
    await until(() => c.events().some((e) => e.event === 'line'), 'a line');
    const line = c.events().find((e) => e.event === 'line');
    expect(line?.data).toEqual({ type: 'line', line: { id: answer.line.id, at: expect.any(Number), name: 'wumbo', text: 'hello there' } });
    c.ctl.abort();
  });

  it('a refused line reaches nobody', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    const c = await connect(base, w.as('plenk'));
    await until(() => c.events().length >= 1, 'hello');
    w.advance(2 * SEC);
    const answer = (await (await post(base, ROOM, 'lines', w.as('wumbo'), { text: `you ${BLOCKED}` })).json()) as { ok: boolean };
    expect(answer.ok).toBe(false);
    w.advance(2 * SEC);
    await post(base, ROOM, 'lines', w.as('wumbo'), { text: 'a clean one' });
    await until(() => c.events().some((e) => e.event === 'line'), 'the clean line');
    expect(c.text().toLowerCase()).not.toContain(BLOCKED);
    c.ctl.abort();
  });

  it('a late joiner gets the history in hello', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    await post(base, ROOM, 'lines', w.as('wumbo'), { text: 'before you came' });
    const c = await connect(base, w.as('plenk'));
    await until(() => c.events().length >= 1, 'hello');
    expect((c.events()[0]?.data as { lines: Array<{ text: string }> }).lines.map((l) => l.text)).toEqual(['before you came']);
    c.ctl.abort();
  });

  it('aborting the request cancels the stream and the seat is released after the grace', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    const c = await connect(base, w.as('plenk'));
    await until(() => c.events().length >= 1, 'hello');
    expect(w.chat.stats()).toEqual({ rooms: 1, members: 1, streams: 1 });
    c.ctl.abort();
    await until(() => w.chat.stats().streams === 0, 'the stream to close');
    expect(w.chat.stats().members).toBe(1); // still seated for the grace
    w.advance(GRACE_MS - 1);
    expect(w.chat.stats().members).toBe(1);
    w.advance(1);
    expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
    expect(w.pending()).toBe(0);
  });

  it('a reconnect storm over real sockets leaves no stream behind', async () => {
    const w = await routeWorld({ routes: { openRateLimit: { max: 1000, windowMs: 60_000 } } });
    const base = await serve(w);
    for (let i = 0; i < 25; i += 1) {
      const c = await connect(base, w.as('plenk'));
      await until(() => c.events().length >= 1, 'hello');
      c.ctl.abort();
      await until(() => w.chat.stats().streams === 0, 'the stream to close');
    }
    expect(w.pending()).toBe(1); // the one seat grace
  });

  it('closeRoom sends bye and ends the response', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    const c = await connect(base, w.as('plenk'));
    await until(() => c.events().length >= 1, 'hello');
    w.chat.closeRoom(ROOM);
    await until(() => c.done(), 'the response to end');
    expect(c.events().at(-1)).toEqual({ event: 'bye', data: { type: 'bye', reason: 'room_closed' } });
    expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
  });

  it('close() sends bye shutdown and ends every response', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    const a = await connect(base, w.as('plenk'));
    const b = await connect(base, w.as('wumbo'), 'other-room');
    await until(() => a.events().length >= 1 && b.events().length >= 1, 'hellos');
    w.chat.close();
    await until(() => a.done() && b.done(), 'the responses to end');
    expect(a.events().at(-1)?.data).toEqual({ type: 'bye', reason: 'shutdown' });
    expect(b.events().at(-1)?.data).toEqual({ type: 'bye', reason: 'shutdown' });
    expect(w.pending()).toBe(0);
  });

  it('a banned player gets one bye frame and the response ends', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    w.join('elsewhere', 'plenk');
    await w.sanction('ban', 'elsewhere', 'plenk', 3_600_000);
    const c = await connect(base, w.as('plenk'));
    await until(() => c.done(), 'the response to end');
    expect(c.res.status).toBe(200);
    expect(c.events()).toEqual([{ event: 'bye', data: { type: 'bye', reason: 'banned', until: expect.any(Number) } }]);
    expect(w.chat.stats().streams).toBe(0);
  });

  it('a fourth tab ends the oldest one: a player on a changed network is never locked out', async () => {
    const w = await routeWorld({ options: { maxStreamsPerMember: 3 } });
    const base = await serve(w);
    const tabs: Array<Awaited<ReturnType<typeof connect>>> = [];
    for (let i = 0; i < 4; i += 1) {
      const c = await connect(base, w.as('plenk'));
      await until(() => c.events().length >= 1, 'hello');
      tabs.push(c);
    }
    await until(() => tabs[0]?.done() === true, 'the oldest response to end');
    expect(tabs.map((t) => t.done())).toEqual([true, false, false, false]);
    expect(w.chat.stats().streams).toBe(3);
    for (const t of tabs) t.ctl.abort();
  });

  it('401, 403 and 429 are plain JSON errors, not streams', async () => {
    const w = await routeWorld({ options: { maxStreams: 1 } });
    const base = await serve(w);
    const none = await fetch(`${base}/rooms/${ROOM}/stream`);
    expect(none.status).toBe(401);
    expect(none.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await none.json()).toEqual({ error: 'unauthorized', message: 'Authentication is required.' });
    const forbidden = await fetch(`${base}/rooms/${ROOM}/stream`, { headers: w.as('plenk', { 'x-join': 'null' }) });
    expect(forbidden.status).toBe(403);
    const first = await connect(base, w.as('plenk'));
    await until(() => first.events().length >= 1, 'hello');
    const second = await fetch(`${base}/rooms/${ROOM}/stream`, { headers: w.as('wumbo') });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('5');
    expect(second.headers.get('cache-control')).toBe('no-store');
    first.ctl.abort();
  });

  it('HEAD is not a stream: it gets the headers and no body, and nobody is left connected', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    const url = new URL(`${base}/rooms/${ROOM}/stream`);
    const out = await new Promise<{ status: number; type: string | string[] | undefined; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: 'HEAD', headers: w.as('plenk') }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(out).toEqual({ status: 200, type: 'text/event-stream; charset=utf-8', body: '' });
    expect(w.chat.stats().streams).toBe(0);
  });

  it('a cross-site form post over real HTTP is refused and nobody hears it', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    const c = await connect(base, w.as('plenk'));
    await until(() => c.events().length >= 1, 'hello');
    for (const [type, body] of [
      ['application/x-www-form-urlencoded', 'text=hello+from+a+form'],
      ['text/plain', '{"text":"hello from a text form"}'],
      ['multipart/form-data; boundary=x', '--x\r\ncontent-disposition: form-data; name="text"\r\n\r\nhello multipart\r\n--x--'],
    ] as const) {
      const res = await fetch(`${base}/rooms/${ROOM}/lines`, { method: 'POST', headers: { ...w.as('wumbo'), 'content-type': type }, body });
      expect(res.status).toBe(400);
    }
    expect(c.events().map((e) => e.event)).toEqual(['hello']);
    expect(c.text()).not.toMatch(/from a form|text form|multipart/);
    expect(w.chat.stats().members).toBe(1);
    c.ctl.abort();
  });

  it('mute and report work over HTTP and the muter is told by a state frame', async () => {
    const w = await routeWorld();
    const base = await serve(w);
    const c = await connect(base, w.as('plenk'));
    await until(() => c.events().length >= 1, 'hello');
    w.advance(2 * SEC);
    const sent = (await (await post(base, ROOM, 'lines', w.as('wumbo'), { text: 'hello from wumbo' })).json()) as { line: { id: string } };
    await until(() => c.events().some((e) => e.event === 'line'), 'the line');
    const muted = await post(base, ROOM, 'mute', w.as('plenk'), { lineId: sent.line.id, on: true });
    expect(await muted.json()).toEqual({ ok: true, hiddenIds: [sent.line.id] });
    await until(() => c.events().some((e) => e.event === 'state'), 'state');
    expect(c.events().find((e) => e.event === 'hide')?.data).toEqual({ type: 'hide', ids: [sent.line.id] });
    const report = await post(base, ROOM, 'report', w.as('glarn'), { lineId: sent.line.id });
    expect(await report.json()).toEqual({ ok: true, remaining: 9 });
    c.ctl.abort();
  });
});
