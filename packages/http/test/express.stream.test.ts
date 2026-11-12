import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { Logger, RawWho } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { playerRoutes } from '../src/player.js';
import { toExpress } from '../src/express.js';
import type { RouteTable } from '../src/router.js';
import type { KitResponse, KitStream } from '../src/types.js';
import { world } from './world.js';

type Sink = Parameters<KitStream['start']>[0];
type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function listen(app: Express): Promise<{ base: string; port: number }> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port };
}

/** Poll until `check` holds (real time: the server runs on a real socket). */
async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** One stream route whose lifecycle the test can see and drive. */
function streamWorld(over: { headers?: Record<string, string>; status?: number; start?: (sink: Sink) => (() => void) | void } = {}) {
  const state = { starts: 0, cancels: 0, sink: undefined as Sink | undefined, logged: [] as Logged };
  const routes: RouteTable = {
    'GET /s': (): KitResponse => ({
      status: over.status ?? 200,
      ...(over.headers === undefined ? {} : { headers: over.headers }),
      body: 'ignored: stream wins',
      stream: {
        start(sink) {
          state.starts += 1;
          state.sink = sink;
          if (over.start !== undefined) {
            const cancel = over.start(sink);
            if (typeof cancel === 'function') {
              return () => {
                state.cancels += 1;
                cancel();
              };
            }
          } else {
            sink.write('event: hello\ndata: {}\n\n');
          }
          return () => {
            state.cancels += 1;
          };
        },
      },
    }),
    'GET /plain': () => ({ status: 200, body: { ok: true } }),
  };
  const logger: Logger = { warn: (event, detail) => void state.logged.push([event, detail]) };
  const app = express();
  app.use('/kit', toExpress(routes, { logger, fallthrough: false }));
  return { app, state };
}

const decoder = new TextDecoder();

describe('toExpress: streaming responses', () => {
  it('a stream response sends status, headers and the first chunk before the stream ends', async () => {
    const { app, state } = streamWorld();
    const { base } = await listen(app);
    const res = await fetch(`${base}/kit/s`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('x-powered-by')).toBeNull();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('event: hello\ndata: {}\n\n');
    expect(state.cancels).toBe(0); // still open

    // a later write reaches the client while the response is still open
    expect((state.sink as Sink).write('event: line\ndata: {}\n\n')).toBe(true);
    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe('event: line\ndata: {}\n\n');

    (state.sink as Sink).end();
    const last = await reader.read();
    expect(last.done).toBe(true);
    expect(state.starts).toBe(1);
  });

  it('the default stream headers are added and a route\'s own headers win', async () => {
    const { app } = streamWorld({
      status: 202,
      headers: { 'cache-control': 'private, max-age=0', 'content-type': 'text/plain', 'x-accel-buffering': 'yes', 'x-own': '1' },
    });
    const { base } = await listen(app);
    const res = await fetch(`${base}/kit/s`);
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('private, max-age=0');
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('x-accel-buffering')).toBe('yes');
    expect(res.headers.get('x-own')).toBe('1');
    await res.body?.cancel();
  });

  it('the defaults fill only the headers the route left out', async () => {
    const { app } = streamWorld({ headers: { 'cache-control': 'private' } });
    const { base } = await listen(app);
    const res = await fetch(`${base}/kit/s`);
    expect(res.headers.get('cache-control')).toBe('private');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    await res.body?.cancel();
  });

  it('cancel runs once when the client aborts', async () => {
    const { app, state } = streamWorld();
    const { base } = await listen(app);
    const ctl = new AbortController();
    const res = await fetch(`${base}/kit/s`, { signal: ctl.signal });
    await (res.body as ReadableStream<Uint8Array>).getReader().read();
    expect(state.cancels).toBe(0);
    ctl.abort();
    await until(() => state.cancels === 1, 'cancel after abort');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.cancels).toBe(1);
  });

  it('cancel runs once when the sink ends, and not again when the connection then closes', async () => {
    const { app, state } = streamWorld();
    const { base } = await listen(app);
    const res = await fetch(`${base}/kit/s`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    (state.sink as Sink).end();
    (state.sink as Sink).end(); // a second end is harmless
    await until(() => state.cancels === 1, 'cancel after end');
    expect((await reader.read()).done).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.cancels).toBe(1);
  });

  it('cancel never runs twice when the sink ends and the client aborts together', async () => {
    const { app, state } = streamWorld();
    const { base } = await listen(app);
    const ctl = new AbortController();
    const res = await fetch(`${base}/kit/s`, { signal: ctl.signal });
    await (res.body as ReadableStream<Uint8Array>).getReader().read();
    (state.sink as Sink).end();
    ctl.abort();
    await until(() => state.cancels >= 1, 'a cancel');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(state.cancels).toBe(1);
  });

  it('write after the client left returns false and throws nothing', async () => {
    const { app, state } = streamWorld();
    const { base } = await listen(app);
    const ctl = new AbortController();
    const res = await fetch(`${base}/kit/s`, { signal: ctl.signal });
    await (res.body as ReadableStream<Uint8Array>).getReader().read();
    ctl.abort();
    await until(() => state.cancels === 1, 'cancel after abort');
    const sink = state.sink as Sink;
    expect(() => sink.write('after')).not.toThrow();
    expect(sink.write('after')).toBe(false);
    expect(() => sink.end()).not.toThrow();
    expect(sink.write('after the end')).toBe(false);
    expect(state.cancels).toBe(1);
    expect(state.logged).toEqual([]);
  });

  it('write after end returns false and writes nothing', async () => {
    const { app, state } = streamWorld();
    const { base } = await listen(app);
    const res = await fetch(`${base}/kit/s`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const sink = state.sink as Sink;
    sink.end();
    expect(sink.write('late')).toBe(false);
    expect((await reader.read()).done).toBe(true);
  });

  it('a write is reported backed up (false) when the client does not read, and cancel runs when that client drops', async () => {
    const { app, state } = streamWorld();
    const { port } = await listen(app);
    // A raw client that sends the request and never reads.
    const socket = connect(port, '127.0.0.1');
    closers.push(async () => void socket.destroy());
    socket.pause();
    socket.write('GET /kit/s HTTP/1.1\r\nHost: x\r\n\r\n');
    await until(() => state.sink !== undefined, 'the stream to start');
    const sink = state.sink as Sink;
    const chunk = 'x'.repeat(64 * 1024);
    let sawFalse = false;
    for (let i = 0; i < 400 && !sawFalse; i += 1) sawFalse = !sink.write(chunk);
    expect(sawFalse).toBe(true);
    socket.destroy();
    await until(() => state.cancels === 1, 'cancel after the socket closed');
  });

  it('a throw in start before the headers is the 500', async () => {
    const { app, state } = streamWorld({
      start: () => {
        throw new TypeError('secret detail that must not leak');
      },
    });
    const { base } = await listen(app);
    const res = await fetch(`${base}/kit/s`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('x-accel-buffering')).toBeNull(); // the stream defaults were taken back off
    expect(res.headers.get('cache-control')).not.toBe('no-store');
    expect(state.logged).toEqual([['chatwarden.http_error', { error: 'TypeError' }]]);
    expect(JSON.stringify(state.logged)).not.toContain('secret detail');
  });

  it('a throw in start after the first write destroys the connection', async () => {
    const { app, state } = streamWorld({
      start: (sink) => {
        sink.write('event: hello\ndata: {}\n\n');
        throw new RangeError('after the first byte');
      },
    });
    const { base } = await listen(app);
    let failed = false;
    try {
      const res = await fetch(`${base}/kit/s`);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
      }
    } catch {
      failed = true;
    }
    expect(failed).toBe(true); // truncated, never a clean end
    expect(state.logged).toEqual([['chatwarden.http_error', { error: 'RangeError' }]]);
    expect(state.starts).toBe(1);
  });

  it('a start that returns after the client already left still gets its cancel called once', async () => {
    const { app, state } = streamWorld({
      start: (sink) => {
        sink.end(); // ended inside start
        return () => undefined;
      },
    });
    const { base } = await listen(app);
    const res = await fetch(`${base}/kit/s`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    await until(() => state.cancels === 1, 'cancel after an end inside start');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.cancels).toBe(1);
  });

  it('a client that left while the handler was still running never gets start called', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let starts = 0;
    const routes: RouteTable = {
      'GET /slow': async (): Promise<KitResponse> => {
        await gate;
        return {
          status: 200,
          body: undefined,
          stream: {
            start() {
              starts += 1;
              return () => undefined;
            },
          },
        };
      },
    };
    const app = express();
    app.use('/kit', toExpress(routes, { fallthrough: false }));
    const { port } = await listen(app);
    const socket = connect(port, '127.0.0.1');
    closers.push(async () => void socket.destroy());
    socket.write(['GET /kit/slow HTTP/1.1', 'Host: x', '', ''].join(String.fromCharCode(13, 10)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(starts).toBe(0);
  });

  it('a stream whose start is not a function is the kit 500', async () => {
    const routes: RouteTable = { 'GET /bad': () => ({ status: 200, body: undefined, stream: {} as unknown as KitStream }) };
    const app = express();
    app.use('/kit', toExpress(routes, { fallthrough: false }));
    const { base } = await listen(app);
    const res = await fetch(`${base}/kit/bad`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
  });

  it('HEAD on a stream route gets the status and headers and no body, and start is not called', async () => {
    const { app, state } = streamWorld({ headers: { 'x-own': '1' } });
    const { port } = await listen(app);
    const out = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/kit/s', method: 'HEAD' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(out.headers['cache-control']).toBe('no-store');
    expect(out.headers['x-own']).toBe('1');
    expect(out.body).toBe('');
    expect(state.starts).toBe(0);
    expect(state.cancels).toBe(0);
  });

  it('stream is ignored for body: a handler that sets both streams', async () => {
    const { app, state } = streamWorld();
    const { base } = await listen(app);
    const res = await fetch(`${base}/kit/s`);
    const text = await new Promise<string>((resolve) => {
      void (async () => {
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const first = await reader.read();
        (state.sink as Sink).end();
        resolve(decoder.decode(first.value));
        await reader.read();
      })();
    });
    expect(text).toBe('event: hello\ndata: {}\n\n');
    expect(text).not.toContain('ignored');
  });

  it('the connection has Nagle disabled so a small frame is not held back', async () => {
    const seen: boolean[] = [];
    const routes: RouteTable = {
      'GET /s': (): KitResponse => ({
        status: 200,
        body: undefined,
        stream: {
          start(sink) {
            sink.write(': hi\n\n');
            return () => undefined;
          },
        },
      }),
    };
    const app = express();
    app.use((req, _res, next) => {
      const socket = req.socket;
      const original = socket.setNoDelay.bind(socket);
      socket.setNoDelay = (noDelay?: boolean) => {
        seen.push(noDelay !== false);
        return original(noDelay);
      };
      next();
    });
    app.use('/kit', toExpress(routes, { fallthrough: false }));
    const { base } = await listen(app);
    const res = await fetch(`${base}/kit/s`);
    expect(seen).toContain(true);
    await res.body?.cancel();
  });

  it('a route without a stream on the same table is unaffected', async () => {
    const { app } = streamWorld();
    const { base } = await listen(app);
    const res = await fetch(`${base}/kit/plain`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-accel-buffering')).toBeNull();
    expect(res.headers.get('cache-control')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ ok: true });
  });
});

/** The raw bytes of one HTTP/1.1 exchange, with the Date header (the only moving part) fixed. */
async function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/^Date: .*$/m, 'Date: <date>')));
    socket.write(request);
  });
}

describe('toExpress: a response without a stream is unchanged', () => {
  it('a response with no stream is byte-identical to before (one admin route, one player route)', async () => {
    const w = await world();
    const store = openStore({ db: new DatabaseSync(':memory:') });
    const cw = await createChatwarden({
      store,
      secret: 'stream-test-secret',
      platform: { identify: (ctx) => ctx as RawWho },
      clock: { now: () => 1_800_000_000_000 },
      retention: false,
    });
    const app = express();
    app.use('/admin', toExpress(w.routes, { fallthrough: false }));
    app.use(
      '/player',
      toExpress(playerRoutes(cw, { identify: () => ({ clientKey: 'raw-key-snerp-0001-secret' }) as RawWho, now: () => 1_800_000_000_000 }), {
        fallthrough: false,
      }),
    );
    const { port } = await listen(app);

    const admin = await raw(port, 'GET /admin/me HTTP/1.1\r\nHost: x\r\nx-role: moderator\r\nx-actor: ann\r\nConnection: close\r\n\r\n');
    const player = await raw(port, 'GET /player/rules HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    const head = await raw(port, 'HEAD /player/rules HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    expect({ admin, player, head }).toMatchSnapshot();
    // belt: the head of each is the plain, non-stream one
    for (const text of [admin, player, head]) {
      expect(text).not.toMatch(/x-accel-buffering/i);
      expect(text).not.toMatch(/event-stream/i);
    }
  });
});
