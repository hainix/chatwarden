import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '@chatwarden/core';
import { adminRoutes } from '../src/admin/index.js';
import { chatRoutes } from '../src/chat/routes.js';
import { toExpress } from '../src/express.js';
import { toFetch } from '../src/fetch.js';
import type { Mounts } from '../src/fetch.js';
import { healthRoutes } from '../src/health.js';
import { playerRoutes } from '../src/player.js';
import type { RouteTable } from '../src/router.js';
import type { KitRequest } from '../src/types.js';
import { chatWorld } from './chat-world.js';
import { identifyFromHeaders } from './playerWorld.js';

// Review Focus 4: the same request must give the same answer through toExpress (over a real Express server) and through toFetch. Each side
// gets its own fresh kit (the same clock, the same data), and the samples run in the same order on both.

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const role = (req: KitRequest): { actor: string; role: Role } | null => {
  const given = req.headers['x-role'];
  return given === undefined ? null : { actor: 'ann', role: given as Role };
};

/** The kit's route families, plus an echo route that reports what the adapter built. */
async function tables(): Promise<{ mounts: Mounts }> {
  const w = await chatWorld();
  const echoRoutes: RouteTable = {
    'GET /x': (r) => ({ status: 200, body: shape(r) }),
    'POST /x': (r) => ({ status: 200, body: shape(r) }),
    'PUT /x': (r) => ({ status: 200, body: shape(r) }),
    'GET /deep/:a/:b': (r, p) => ({ status: 200, body: { ...shape(r), params: p } }),
  };
  return {
    mounts: {
      '/admin': adminRoutes(w.cw, { authorize: role }),
      '/api': playerRoutes(w.cw, { identify: identifyFromHeaders }),
      '/chat': chatRoutes(w.cw, w.chat, { identify: identifyFromHeaders, join: (req) => ({ name: req.headers['x-name'] ?? 'plenk' }) }),
      '/echo': echoRoutes,
      '': healthRoutes(w.cw),
    },
  };
}

/** What a route sees of the request, apart from the headers and the address (those are the transport's). */
const shape = (r: KitRequest): Record<string, unknown> => ({ method: r.method, path: r.path, query: { ...r.query }, rawBody: r.rawBody, body: r.body === undefined ? 'undefined' : 'set', contentType: r.headers['content-type'] ?? null });

interface Seen {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const DROP = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding']);
async function seen(res: Response, method: string, stream: boolean): Promise<Seen> {
  const headers: Record<string, string> = {};
  for (const [name, value] of res.headers) {
    if (DROP.has(name)) continue;
    // A GET's length is the transport's to compute; a HEAD's is the route's, and both sides must say the same.
    if (name === 'content-length' && method !== 'HEAD') continue;
    headers[name] = value;
  }
  if (stream) {
    const reader = res.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(first.value);
    return { status: res.status, headers, body: `first frame: ${/"type":\s*"(\w+)"/.exec(text)?.[1] ?? text.slice(0, 20)}` };
  }
  return { status: res.status, headers, body: await res.text() };
}

interface Sample {
  name: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  stream?: boolean;
}

const PLAYER = { 'x-key': 'raw-client-key-plenk-0001', 'x-ip': '203.0.113.7', 'x-name': 'plenk' };
const JSON_TYPE = { 'content-type': 'application/json' };

const SAMPLES: Sample[] = [
  { name: 'admin me', path: '/admin/me', headers: { 'x-role': 'owner' } },
  { name: 'admin me as a junior role', path: '/admin/me', headers: { 'x-role': 'junior' } },
  { name: 'admin me with nobody', path: '/admin/me' },
  { name: 'a report list', path: '/admin/reports?limit=5&state=open', headers: { 'x-role': 'owner' } },
  { name: 'a report list with a bad query', path: '/admin/reports?limit=banana', headers: { 'x-role': 'owner' } },
  { name: 'a player rules route', path: '/api/rules', headers: PLAYER },
  { name: 'a player rules HEAD', method: 'HEAD', path: '/api/rules', headers: PLAYER },
  { name: 'the code of conduct as text', path: '/api/code-of-conduct?format=text', headers: PLAYER },
  { name: 'a chat open', path: '/chat/rooms/lobby/stream', headers: PLAYER, stream: true },
  { name: 'a chat send', method: 'POST', path: '/chat/rooms/lobby/lines', headers: { ...PLAYER, ...JSON_TYPE }, body: '{"text":"hello there"}' },
  { name: 'a chat send with an invalid body', method: 'POST', path: '/chat/rooms/lobby/lines', headers: { ...PLAYER, ...JSON_TYPE }, body: '{' },
  { name: 'a bad content type', method: 'POST', path: '/chat/rooms/lobby/lines', headers: { ...PLAYER, 'content-type': 'text/plain' }, body: 'hello' },
  { name: 'a body that is not UTF-8', method: 'POST', path: '/chat/rooms/lobby/lines', headers: { ...PLAYER, ...JSON_TYPE }, body: new Uint8Array([0x7b, 0xff, 0x7d]) },
  { name: 'a body over the cap', method: 'POST', path: '/chat/rooms/lobby/lines', headers: { ...PLAYER, ...JSON_TYPE }, body: `{"text":"${'a'.repeat(70_000)}"}` },
  { name: 'a 404 under a mount', path: '/admin/zzz', headers: { 'x-role': 'owner' } },
  { name: 'a 404 outside every mount', path: '/nothing/at/all' },
  { name: 'a 405', method: 'DELETE', path: '/admin/me', headers: { 'x-role': 'owner' } },
  { name: 'a 405 on a root-mounted route', method: 'POST', path: '/healthz' },
  { name: 'the probe', path: '/healthz' },
  { name: 'the readiness probe', path: '/readyz' },
  // What the routes are given: path, query, body.
  { name: 'echo: a query with repeats, empties, escapes and a prototype key', path: '/echo/x?a=1&a=2&b=&c&d=%20x%20&e=%C3%A9&__proto__=p&constructor=q' },
  { name: 'echo: a path with params', path: '/echo/deep/one/two-2' },
  { name: 'echo: a path with a bad param', path: '/echo/deep/one/a%20b' },
  { name: 'echo: a path with a malformed escape', path: '/echo/deep/one/%E0%A4%A' },
  { name: 'echo: a JSON body', method: 'POST', path: '/echo/x?k=v', headers: JSON_TYPE, body: '{"é":["☃"]}' },
  { name: 'echo: a body with a byte-order mark', method: 'POST', path: '/echo/x', body: new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]) },
  { name: 'echo: invalid UTF-8 bytes', method: 'POST', path: '/echo/x', body: new Uint8Array([0x61, 0xff, 0xfe, 0x62, 0xc3]) },
  { name: 'echo: an empty POST', method: 'POST', path: '/echo/x' },
  { name: 'echo: a PUT', method: 'PUT', path: '/echo/x', body: 'put body' },
  { name: 'echo: a GET with no body', path: '/echo/x' },
  { name: 'echo: HEAD falls to the GET route', method: 'HEAD', path: '/echo/x?z=1' },
];

describe('the same request gives the same answer through toExpress and toFetch', () => {
  it('for a table-driven sample (admin me, a report list, a player rules route, a chat open, a chat send, a bad content type, a 404, a 405, and what the routes are given)', async () => {
    const app = express();
    app.disable('x-powered-by');
    const expressSide = await tables();
    for (const [key, table] of Object.entries(expressSide.mounts)) app.use(key === '' ? '/' : key, toExpress(table, { fallthrough: false }));
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const handler = toFetch((await tables()).mounts);

    for (const sample of SAMPLES) {
      const method = sample.method ?? 'GET';
      const init: RequestInit = { method, headers: sample.headers ?? {}, ...(sample.body === undefined ? {} : { body: sample.body as RequestInit['body'] }) };
      const viaExpress = await seen(await fetch(`${base}${sample.path}`, init), method, sample.stream === true);
      const viaFetch = await seen(await handler(new Request(`http://game.example.invalid${sample.path}`, init)), method, sample.stream === true);
      expect(viaFetch.status, `${sample.name}: status`).toBe(viaExpress.status);
      expect(viaFetch.headers, `${sample.name}: headers`).toEqual(viaExpress.headers);
      expect(viaFetch.body, `${sample.name}: body`).toBe(viaExpress.body);
    }
  }, 30_000);

  it('the sample is wide enough to mean something: it has answers of every class', async () => {
    const handler = toFetch((await tables()).mounts);
    const statuses = new Set<number>();
    for (const sample of SAMPLES.filter((s) => s.stream !== true)) {
      const init: RequestInit = { method: sample.method ?? 'GET', headers: sample.headers ?? {}, ...(sample.body === undefined ? {} : { body: sample.body as RequestInit['body'] }) };
      statuses.add((await handler(new Request(`http://game.example.invalid${sample.path}`, init))).status);
    }
    for (const wanted of [200, 400, 401, 404, 405, 413]) expect([...statuses], String(wanted)).toContain(wanted);
  }, 30_000);
});
