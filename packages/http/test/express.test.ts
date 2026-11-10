import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ErrorRequestHandler, Express, RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@chatwarden/core';
import { NotFoundError } from '../src/errors.js';
import { toExpress } from '../src/express.js';
import type { ExpressOptions } from '../src/express.js';
import type { KitRequest, KitResponse } from '../src/types.js';
import type { RouteTable } from '../src/router.js';

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** Listen on an ephemeral port; closed after the test. */
async function listen(app: Express): Promise<string> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const sawRequests: KitRequest[] = [];

/** A table whose routes record the KitRequest they were given. */
const echoRoutes: RouteTable = {
  'GET /ping': (req) => {
    sawRequests.push(req);
    return { status: 200, body: { pong: true } };
  },
  'POST /echo': (req) => {
    sawRequests.push(req);
    return {
      status: 200,
      body: {
        method: req.method,
        path: req.path,
        query: req.query,
        headers: req.headers,
        rawBody: req.rawBody ?? null,
        parsed: req.body === undefined ? 'undefined' : 'set',
      },
    };
  },
  'GET /echo': (req) => {
    sawRequests.push(req);
    return {
      status: 200,
      body: { path: req.path, query: req.query, headers: req.headers, rawBody: req.rawBody ?? null },
    };
  },
  'GET /items/:id': (_req, params) => ({ status: 200, body: { id: params.id } }),
  'GET /doc': () => ({
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
    },
    body: '<p>"quoted" & <b>bold</b> é 日本</p>',
  }),
  'GET /plain': () => ({ status: 200, body: 'no content type given' }),
  'GET /md': () => ({ status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' }, body: '# Title\n\n- a\n' }),
  'GET /created': () => ({ status: 201, headers: { location: '/things/7', 'x-one': '1', 'x-two': '2' }, body: { id: 7 } }),
  'GET /null': () => ({ status: 200, body: null }),
  'GET /array': () => ({ status: 200, body: [1, 'two', { three: 3 }] }),
  'GET /empty-string': () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: '' }),
  'GET /teapot': () => ({ status: 418, body: { error: 'teapot' } }),
  'GET /bad-status': () => ({ status: 42, body: {} }),
  'GET /crlf-value': () => ({ status: 200, headers: { 'x-before': 'set first', 'x-evil': 'a\r\nset-cookie: pwned=1' }, body: { ok: true } }),
  'GET /bad-header-name': () => ({ status: 200, headers: { 'x-before': 'set first', 'bad name:': 'v' }, body: { ok: true } }),
  'GET /circular': () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    return { status: 200, headers: { 'x-before': 'set first' }, body: loop };
  },
  'GET /bigint': () => ({ status: 200, body: { n: 10n } }),
  'GET /remote': (req) => ({ status: 200, body: { remoteAddress: req.remoteAddress ?? null, headers: req.headers } }),
  'GET /throws': () => {
    throw new TypeError('secret detail that must not leak');
  },
  'GET /rejects': () => Promise.reject(new Error('another secret detail')),
};

function build(routes: RouteTable = echoRoutes, opts?: ExpressOptions, mount = '/kit'): { app: Express; logged: Logged } {
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const app = express();
  // These tests are about the kit answering for everything under its mount, so they turn the fallthrough off; the
  // fallthrough has its own describe below.
  app.use(mount, toExpress(routes, { logger, fallthrough: false, ...opts }));
  return { app, logged };
}

const post = (url: string, body: string | Buffer, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

describe('toExpress: mapping the KitResponse', () => {
  it('sends a JSON body with the status and the JSON content type', async () => {
    const base = await listen(build().app);
    const res = await fetch(`${base}/kit/ping`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json; charset=utf-8$/);
    expect(await res.json()).toEqual({ pong: true });
  });

  it('sends the status and every header the response names', async () => {
    const base = await listen(build().app);
    const res = await fetch(`${base}/kit/created`);
    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toBe('/things/7');
    expect(res.headers.get('x-one')).toBe('1');
    expect(res.headers.get('x-two')).toBe('2');
    expect(await res.json()).toEqual({ id: 7 });
  });

  it('sends an error status with its JSON body', async () => {
    const base = await listen(build().app);
    const res = await fetch(`${base}/kit/teapot`);
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'teapot' });
  });

  it('sends a string body RAW with its own content type, never JSON-quoted', async () => {
    const base = await listen(build().app);
    const res = await fetch(`${base}/kit/doc`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const text = await res.text();
    expect(text).toBe('<p>"quoted" & <b>bold</b> é 日本</p>');
    expect(text.startsWith('"')).toBe(false);
  });

  it('keeps a markdown string as markdown', async () => {
    const base = await listen(build().app);
    const res = await fetch(`${base}/kit/md`);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await res.text()).toBe('# Title\n\n- a\n');
  });

  it('a string body with no content type goes out as text/plain, not JSON', async () => {
    const base = await listen(build().app);
    const res = await fetch(`${base}/kit/plain`);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('no content type given');
  });

  it('an empty string body is an empty body', async () => {
    const base = await listen(build().app);
    const res = await fetch(`${base}/kit/empty-string`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('serialises null and arrays as JSON (control: only strings are raw)', async () => {
    const base = await listen(build().app);
    expect(await (await fetch(`${base}/kit/null`)).json()).toBeNull();
    expect(await (await fetch(`${base}/kit/array`)).json()).toEqual([1, 'two', { three: 3 }]);
  });

  it('sets the right content length for multi-byte text', async () => {
    const base = await listen(build().app);
    const res = await fetch(`${base}/kit/doc`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length'))).toBe(bytes.length);
    expect(bytes.length).toBeGreaterThan('<p>"quoted" & <b>bold</b> é 日本</p>'.length);
  });
});

describe('toExpress: building the KitRequest', () => {
  it('passes the method, the mount-relative path, the lowercased headers and the raw body', async () => {
    const base = await listen(build().app);
    const res = await post(`${base}/kit/echo`, '{"a":1}', { 'X-Custom-Header': 'Value', 'X-Other': 'two' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.method).toBe('POST');
    expect(body.path).toBe('/echo');
    expect(body.rawBody).toBe('{"a":1}');
    const headers = body.headers as Record<string, string>;
    expect(headers['x-custom-header']).toBe('Value');
    expect(headers['x-other']).toBe('two');
    expect(Object.keys(headers).every((k) => k === k.toLowerCase())).toBe(true);
  });

  it('never pre-parses: the request body is undefined, only rawBody is set', async () => {
    const base = await listen(build().app);
    const body = (await (await post(`${base}/kit/echo`, '{"a":1}')).json()) as Record<string, unknown>;
    expect(body.parsed).toBe('undefined');
  });

  it('keeps the body byte for byte: whitespace, key order, multi-byte characters and emoji', async () => {
    const base = await listen(build().app);
    const samples = [
      '{ "name" :  "héllo 😀 日本語" ,\n\t"b":[1, 2 ,3]}\n',
      '   ',
      '{"dup":1,"dup":2}',
      'not json at all é',
      '‮​ ',
    ];
    for (const sample of samples) {
      const body = (await (await post(`${base}/kit/echo`, sample)).json()) as { rawBody: string };
      expect(body.rawBody).toBe(sample);
    }
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const base = await listen(build().app);
    const url = new URL(`${base}/kit/echo`);
    const bytes = Buffer.from('{"t":"日本"}', 'utf8');
    const cut = bytes.indexOf(0xe6) + 1; // inside the first three-byte character
    const out = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (d: Buffer) => parts.push(d));
          res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        },
      );
      req.on('error', reject);
      req.write(bytes.subarray(0, cut));
      setTimeout(() => {
        req.write(bytes.subarray(cut));
        req.end();
      }, 30);
    });
    expect((JSON.parse(out) as { rawBody: string }).rawBody).toBe('{"t":"日本"}');
  });

  it('reads a body whatever its content type (the adapter does not care)', async () => {
    const base = await listen(build().app);
    const body = (await (await post(`${base}/kit/echo`, 'a=1&b=2', { 'content-type': 'application/x-www-form-urlencoded' })).json()) as { rawBody: string };
    expect(body.rawBody).toBe('a=1&b=2');
    const text = (await (await post(`${base}/kit/echo`, 'plain', { 'content-type': 'text/plain' })).json()) as { rawBody: string };
    expect(text.rawBody).toBe('plain');
  });

  it('gives a request with no body an empty raw body', async () => {
    const base = await listen(build().app);
    const body = (await (await fetch(`${base}/kit/echo`)).json()) as { rawBody: string };
    expect(body.rawBody).toBe('');
    const postBody = (await (await fetch(`${base}/kit/echo`, { method: 'POST' })).json()) as { rawBody: string };
    expect(postBody.rawBody).toBe('');
  });

  it('takes the first value of a repeated query key, strings only', async () => {
    const base = await listen(build().app);
    const body = (await (await fetch(`${base}/kit/echo?a=1&a=2&a=3&b=x&c=`)).json()) as { query: Record<string, string> };
    expect(body.query).toEqual({ a: '1', b: 'x', c: '' });
  });

  it('drops nested query values from the extended parser (control: strings survive)', async () => {
    const { app } = build();
    app.set('query parser', 'extended');
    const base = await listen(app);
    const body = (await (await fetch(`${base}/kit/echo?o[x]=1&n[]=2&n[]=3&s=ok&dup=1&dup=2`)).json()) as { query: Record<string, string> };
    expect(body.query.s).toBe('ok');
    expect(body.query.dup).toBe('1');
    expect(body.query.o).toBeUndefined();
    expect(Object.values(body.query).every((v) => typeof v === 'string')).toBe(true);
  });

  it('a __proto__ query key cannot reach the prototype', async () => {
    const base = await listen(build().app);
    await fetch(`${base}/kit/echo?__proto__=polluted&constructor=x`);
    const seen = sawRequests.at(-1) as KitRequest;
    expect(Object.getPrototypeOf(seen.query)).toBeNull();
    expect(Object.getPrototypeOf(seen.headers)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('decodes percent-encoded query values', async () => {
    const base = await listen(build().app);
    const body = (await (await fetch(`${base}/kit/echo?q=a%20b%26c&e=%E6%97%A5`)).json()) as { query: Record<string, string> };
    expect(body.query).toEqual({ q: 'a b&c', e: '日' });
  });

  it('joins a header sent as an array with ", "', async () => {
    const base = await listen(build().app);
    const url = new URL(`${base}/kit/echo`);
    const out = await new Promise<{ headers: Record<string, string> }>((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, headers: { 'set-cookie': ['a=1', 'b=2'] } }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (d: Buffer) => parts.push(d));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(parts).toString('utf8')) as { headers: Record<string, string> }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(out.headers['set-cookie']).toBe('a=1, b=2');
  });

  it('leaves a repeated ordinary header as Node merged it (joined with ", ")', async () => {
    const base = await listen(build().app);
    const url = new URL(`${base}/kit/echo`);
    const out = await new Promise<{ headers: Record<string, string> }>((resolve, reject) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, headers: { 'x-multi': ['one', 'two'] } }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (d: Buffer) => parts.push(d));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(parts).toString('utf8')) as { headers: Record<string, string> }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(out.headers['x-multi']).toBe('one, two');
  });
});

/** One raw HTTP/1.1 exchange: the status line, the headers (lowercased) and the exact body bytes after the blank line. */
function rawExchange(base: string, method: string, path: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(`${method} ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    const parts: Buffer[] = [];
    socket.on('data', (d: Buffer) => parts.push(d));
    socket.on('error', reject);
    socket.on('close', () => {
      const all = Buffer.concat(parts);
      const split = all.indexOf('\r\n\r\n');
      const head = all.subarray(0, split).toString('latin1').split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of head.slice(1)) headers[line.slice(0, line.indexOf(':')).toLowerCase()] = line.slice(line.indexOf(':') + 1).trim();
      resolve({ status: Number(head[0]?.split(' ')[1]), headers, body: all.subarray(split + 4) });
    });
  });
}

describe('toExpress: HEAD on the wire (raw sockets: fetch never reads a HEAD body)', () => {
  const paths = ['/kit/ping', '/kit/doc', '/kit/plain', '/kit/md', '/kit/created', '/kit/array', '/kit/empty-string', '/kit/teapot', '/kit/missing', '/kit/throws'];

  it.each(paths)('HEAD %s: zero body bytes, and the GET status, content type and Content-Length', async (path) => {
    const base = await listen(build().app);
    const get = await rawExchange(base, 'GET', path);
    const head = await rawExchange(base, 'HEAD', path);
    expect(head.body.length).toBe(0);
    expect(head.status).toBe(get.status);
    expect(head.headers['content-type']).toBe(get.headers['content-type']);
    expect(head.headers['content-length']).toBe(get.headers['content-length']);
    expect(Number(head.headers['content-length'])).toBe(get.body.length);
    expect(get.body.length > 0 || path.endsWith('empty-string')).toBe(true);
  });

  it('a string body with no content type is text/plain on HEAD too, not JSON', async () => {
    const base = await listen(build().app);
    const head = await rawExchange(base, 'HEAD', '/kit/plain');
    expect(head.headers['content-type']).toMatch(/^text\/plain/);
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength('no content type given')));
  });

  it('Content-Length counts bytes for multi-byte text', async () => {
    const base = await listen(build().app);
    const head = await rawExchange(base, 'HEAD', '/kit/doc');
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength('<p>"quoted" & <b>bold</b> \u00e9 \u65e5\u672c</p>')));
  });

  it('a GET still sends its body (control)', async () => {
    const base = await listen(build().app);
    const get = await rawExchange(base, 'GET', '/kit/ping');
    expect(JSON.parse(get.body.toString('utf8'))).toEqual({ pong: true });
  });
});

describe('toExpress: the body reader cannot escape the adapter', () => {
  const realConcat = Buffer.concat.bind(Buffer);
  const TRIGGER = 'READER-THROW-TRIGGER';
  const trip = (what: unknown): void => {
    vi.spyOn(Buffer, 'concat').mockImplementation(((list: readonly Uint8Array[], length?: number) => {
      if (list.length > 0 && Buffer.from(list[0] as Uint8Array).toString('utf8').startsWith(TRIGGER)) throw what;
      return realConcat(list, length);
    }) as typeof Buffer.concat);
  };
  afterEach(() => void vi.restoreAllMocks());

  it.each([
    ['an Error', new TypeError('decoder blew up with a secret detail'), 'TypeError'],
    ['a string', 'thrown string', 'string'],
  ])('a throw while decoding the body (%s) is the kit 500, logged by class, with no uncaught exception', async (_name, thrown, cls) => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => void uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      trip(thrown);
      const calls = vi.fn(() => ({ status: 200, body: {} }));
      const { app, logged } = build({ 'POST /echo': calls });
      const base = await listen(app);
      const res = await post(`${base}/kit/echo`, `${TRIGGER} payload`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'internal' });
      expect(text).not.toContain('secret');
      expect(calls).not.toHaveBeenCalled();
      expect(logged).toEqual([['chatwarden.http_error', { error: cls }]]);
      await new Promise((r) => setTimeout(r, 30));
      expect(uncaught).toEqual([]);
      // The server carries on.
      vi.restoreAllMocks();
      expect((await post(`${base}/kit/echo`, 'fine')).status).toBe(200);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('control: a body that does not trip the injected failure is read normally', async () => {
    trip(new TypeError('x'));
    const { app } = build();
    const base = await listen(app);
    const res = await post(`${base}/kit/echo`, 'ordinary body');
    expect(((await res.json()) as { rawBody: string }).rawBody).toBe('ordinary body');
  });

  it('maxBody is capped at 16 MiB: the cap itself is fine, one byte more is a RangeError at construction', () => {
    const cap = 16 * 1024 * 1024;
    expect(() => toExpress({}, { maxBody: cap })).not.toThrow();
    for (const maxBody of [cap + 1, 512 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
      expect(() => toExpress({}, { maxBody })).toThrow(RangeError);
    }
  });
});

describe('toExpress: the peer address and the response headers', () => {
  it('remoteAddress is the socket peer, whatever the client claims in headers', async () => {
    const base = await listen(build().app);
    const plain = (await (await fetch(`${base}/kit/remote`)).json()) as { remoteAddress: string };
    expect(plain.remoteAddress).toBe('127.0.0.1');
    const forged = (await (
      await fetch(`${base}/kit/remote`, {
        headers: { 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '203.0.113.8', forwarded: 'for=203.0.113.9', 'x-tiny-chat-ip': '203.0.113.10', 'x-remote-address': '203.0.113.11' },
      })
    ).json()) as { remoteAddress: string; headers: Record<string, string> };
    expect(forged.remoteAddress).toBe('127.0.0.1');
    // The forged headers are still visible as headers (the adopter decides whether to trust a proxy); they are not the address.
    expect(forged.headers['x-forwarded-for']).toBe('203.0.113.7');
  });

  it('sends no ETag and never a 304: a conditional GET is a plain 200', async () => {
    const base = await listen(build().app);
    const first = await fetch(`${base}/kit/ping`);
    expect(first.headers.get('etag')).toBeNull();
    const second = await fetch(`${base}/kit/ping`, { headers: { 'if-none-match': '*', 'if-modified-since': new Date(Date.now() + 1e9).toUTCString() } });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ pong: true });
    for (const path of ['/kit/doc', '/kit/plain', '/kit/created']) {
      expect((await fetch(`${base}${path}`)).headers.get('etag')).toBeNull();
    }
  });

  it('does not advertise Express: no x-powered-by on the kit responses, even on an app that leaves it enabled', async () => {
    const { app } = build();
    app.enable('x-powered-by');
    app.get('/mine', (_req, res) => void res.send('mine'));
    const base = await listen(app);
    expect((await fetch(`${base}/mine`)).headers.get('x-powered-by')).toBe('Express'); // control: the app default is on
    for (const path of ['/kit/ping', '/kit/doc', '/kit/missing', '/kit/bad-status']) {
      expect((await fetch(`${base}${path}`)).headers.get('x-powered-by')).toBeNull();
    }
  });

  it('JSON bodies get an explicit content type; a response that names its own is not overridden', async () => {
    const routes: RouteTable = {
      'GET /own': () => ({ status: 200, headers: { 'content-type': 'application/problem+json' }, body: { a: 1 } }),
      'GET /dflt': () => ({ status: 200, body: { a: 1 } }),
    };
    const base = await listen(build(routes).app);
    expect((await fetch(`${base}/kit/own`)).headers.get('content-type')).toBe('application/problem+json');
    expect((await fetch(`${base}/kit/dflt`)).headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

describe('toExpress: mount-relative paths', () => {
  it('strips the mount point, however deep', async () => {
    for (const mount of ['/kit', '/a/b/c', '/api/v1']) {
      const { app } = build(echoRoutes, undefined, mount);
      const base = await listen(app);
      const body = (await (await fetch(`${base}${mount}/echo`)).json()) as { path: string };
      expect(body.path).toBe('/echo');
    }
  });

  it('the mount root is "/"', async () => {
    const routes: RouteTable = { 'GET /': (req) => ({ status: 200, body: { path: req.path } }) };
    const base = await listen(build(routes).app);
    expect((await (await fetch(`${base}/kit`)).json()) as { path: string }).toEqual({ path: '/' });
    expect((await (await fetch(`${base}/kit/`)).json()) as { path: string }).toEqual({ path: '/' });
  });

  it('can be mounted at the app root', async () => {
    const { app } = build(echoRoutes, undefined, '/');
    const base = await listen(app);
    expect(((await (await fetch(`${base}/ping`)).json()) as { pong: boolean }).pong).toBe(true);
  });

  it('does not see a path outside its mount; the app keeps its own routes', async () => {
    const { app } = build();
    app.get('/other', (_req, res) => void res.send('mine'));
    const base = await listen(app);
    expect(await (await fetch(`${base}/other`)).text()).toBe('mine');
    expect((await fetch(`${base}/kitchen`)).status).toBe(404); // app 404, not the kit's
    const kit404 = await fetch(`${base}/kit/nope`);
    expect(kit404.status).toBe(404);
    expect(await kit404.json()).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it('passes the query string out of the path, and a route param is decoded by the router', async () => {
    const base = await listen(build().app);
    const body = (await (await fetch(`${base}/kit/items/abc-1?x=1`)).json()) as { id: string };
    expect(body.id).toBe('abc-1');
    await fetch(`${base}/kit/echo?x=1`);
    expect((sawRequests.at(-1) as KitRequest).path).toBe('/echo');
  });

  it('a bad or malformed param encoding is the router 404', async () => {
    const base = await listen(build().app);
    for (const path of ['/kit/items/a%20b', '/kit/items/%zz', '/kit/items/a%2Fb', '/kit/items//x']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
  });
});

describe('toExpress: methods the router refuses', () => {
  it('HEAD on a GET route runs the GET handler: its status and headers, no body', async () => {
    const base = await listen(build().app);
    const before = sawRequests.length;
    const res = await fetch(`${base}/kit/ping`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.text()).toBe('');
    expect(sawRequests.length).toBe(before + 1);
    expect(sawRequests.at(-1)?.method).toBe('HEAD');
  });

  it('HEAD keeps the GET response status and headers (created, and the code of conduct)', async () => {
    const base = await listen(build().app);
    const created = await fetch(`${base}/kit/created`, { method: 'HEAD' });
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe('/things/7');
    expect(await created.text()).toBe('');
    const doc = await fetch(`${base}/kit/doc`, { method: 'HEAD' });
    expect(doc.status).toBe(200);
    expect(doc.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(doc.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(await doc.text()).toBe('');
  });

  it('HEAD on a POST-only route is 405 and allows only POST; HEAD on an unknown path is 404', async () => {
    const routes: RouteTable = { 'POST /only': () => ({ status: 200, body: {} }) };
    const base = await listen(build(routes).app);
    const res = await fetch(`${base}/kit/only`, { method: 'HEAD' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect((await fetch(`${base}/kit/missing`, { method: 'HEAD' })).status).toBe(404);
  });

  it('HEAD on a route whose GET handler fails is the kit 500, with no body', async () => {
    const base = await listen(build().app);
    const res = await fetch(`${base}/kit/throws`, { method: 'HEAD' });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('');
  });

  it('an unsupported method on a known path is 405 and lists what is allowed', async () => {
    const base = await listen(build().app);
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      const res = await fetch(`${base}/kit/ping`, { method, body: method === 'DELETE' ? undefined : '{}' });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
      expect(await res.json()).toEqual({ error: 'method_not_allowed', message: 'Method not allowed.' });
    }
    const echo = await fetch(`${base}/kit/echo`, { method: 'DELETE' });
    expect(echo.status).toBe(405);
    expect(echo.headers.get('allow')).toBe('GET, HEAD, POST');
  });

  it('OPTIONS is the router answer too (405), not a silent success', async () => {
    const base = await listen(build().app);
    expect((await fetch(`${base}/kit/ping`, { method: 'OPTIONS' })).status).toBe(405);
  });

  it('any method on an unknown path is 404', async () => {
    const base = await listen(build().app);
    for (const method of ['GET', 'POST', 'HEAD', 'DELETE']) {
      expect((await fetch(`${base}/kit/missing`, { method })).status).toBe(404);
    }
  });

  it('a body sent to a refused method is still bounded and does not crash the server', async () => {
    const base = await listen(build().app);
    const res = await fetch(`${base}/kit/ping`, { method: 'PUT', body: 'x'.repeat(1000) });
    expect(res.status).toBe(405);
    expect((await fetch(`${base}/kit/ping`)).status).toBe(200);
  });
});

describe('toExpress: the body cap', () => {
  const small = { maxBody: 32 };
  const handlerSpy = (): { routes: RouteTable; calls: () => number } => {
    let n = 0;
    return {
      routes: {
        'POST /echo': (req) => {
          n++;
          return { status: 200, body: { length: Buffer.byteLength(req.rawBody ?? '', 'utf8') } };
        },
      },
      calls: () => n,
    };
  };

  it('a body of exactly the cap passes; one byte more is 413 in the kit error shape', async () => {
    const spy = handlerSpy();
    const base = await listen(build(spy.routes, small).app);
    const ok = await post(`${base}/kit/echo`, 'a'.repeat(32));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ length: 32 });
    const over = await post(`${base}/kit/echo`, 'a'.repeat(33));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: 'payload_too_large', message: 'The request body is too large.' });
    expect(spy.calls()).toBe(1);
  });

  it('counts bytes, not characters', async () => {
    const spy = handlerSpy();
    const base = await listen(build(spy.routes, small).app);
    expect((await post(`${base}/kit/echo`, 'é'.repeat(16))).status).toBe(200); // 32 bytes
    expect((await post(`${base}/kit/echo`, 'é'.repeat(17))).status).toBe(413); // 34 bytes, 17 characters
    expect((await post(`${base}/kit/echo`, '日'.repeat(11))).status).toBe(413); // 33 bytes
    expect((await post(`${base}/kit/echo`, '日'.repeat(10))).status).toBe(200); // 30 bytes
  });

  it('defaults to 65536 bytes', async () => {
    const spy = handlerSpy();
    const base = await listen(build(spy.routes).app);
    const ok = await post(`${base}/kit/echo`, 'a'.repeat(65536));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ length: 65536 });
    expect((await post(`${base}/kit/echo`, 'a'.repeat(65537))).status).toBe(413);
  });

  it('a chunked body with no content length is capped too', async () => {
    const spy = handlerSpy();
    const base = await listen(build(spy.routes, small).app);
    const url = new URL(`${base}/kit/echo`);
    const send = (chunks: string[]): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        for (const c of chunks) req.write(c);
        req.end();
      });
    expect(await send(['a'.repeat(16), 'b'.repeat(16)])).toBe(200);
    expect(await send(['a'.repeat(16), 'b'.repeat(16), 'c'])).toBe(413);
    expect(await send(['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10), 'd'.repeat(10)])).toBe(413);
  });

  it('a much larger body gets a 413 response, or at worst a reset of the connection; the handler never runs', async () => {
    const spy = handlerSpy();
    const base = await listen(build(spy.routes).app);
    const url = new URL(base);
    const total = 2 * 1024 * 1024;
    const outcome = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname);
      let answer = '';
      socket.on('data', (d: Buffer) => (answer += d.toString('latin1')));
      socket.on('close', () => resolve(answer.startsWith('HTTP/1.1 413') ? '413' : answer === '' ? 'closed without a response' : `unexpected: ${answer.slice(0, 40)}`));
      socket.on('error', (err: NodeJS.ErrnoException) => {
        // Only a reset or a broken pipe on the way out is acceptable; any other error fails the test.
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') resolve(answer.startsWith('HTTP/1.1 413') ? '413' : 'reset');
        else reject(err);
      });
      socket.on('connect', () => {
        socket.write(`POST /kit/echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${total}\r\n\r\n`);
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = (): void => {
          while (sent < total && !socket.destroyed) {
            sent += chunk.length;
            if (!socket.write(chunk)) {
              socket.once('drain', pump);
              return;
            }
          }
        };
        pump();
      });
    });
    expect(['413', 'reset']).toContain(outcome);
    expect(spy.calls()).toBe(0);
    expect((await post(`${base}/kit/echo`, 'ok')).status).toBe(200);
  });

  it('the same 413 on a plain fetch of a body just over the cap is always a real 413 (no reset)', async () => {
    const spy = handlerSpy();
    const base = await listen(build(spy.routes, { maxBody: 1024 }).app);
    const res = await post(`${base}/kit/echo`, 'a'.repeat(4096));
    expect(res.status).toBe(413);
    expect(spy.calls()).toBe(0);
  });

  it('413 does not echo the body and carries no detail', async () => {
    const spy = handlerSpy();
    const base = await listen(build(spy.routes, small).app);
    const res = await post(`${base}/kit/echo`, `SECRET-MARKER-${'z'.repeat(60)}`);
    expect(res.status).toBe(413);
    expect(JSON.stringify(await res.json())).not.toContain('SECRET-MARKER');
  });

  it('rejects an invalid maxBody when the adapter is built', () => {
    for (const maxBody of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10' as unknown as number]) {
      expect(() => toExpress({}, { maxBody })).toThrow(RangeError);
    }
    expect(() => toExpress({}, { maxBody: 1 })).not.toThrow();
  });

  it('a client that hangs up mid-body does not run the handler or break the server, and logs nothing', async () => {
    const spy = handlerSpy();
    const { app, logged } = build(spy.routes);
    const base = await listen(app);
    const url = new URL(base);
    await new Promise<void>((resolve) => {
      const socket = connect(Number(url.port), url.hostname, () => {
        socket.write('POST /kit/echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n0123456789');
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 30);
      });
      socket.on('error', () => undefined);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy.calls()).toBe(0);
    expect(logged).toEqual([]);
    expect((await post(`${base}/kit/echo`, 'ok')).status).toBe(200);
    expect(spy.calls()).toBe(1);
  });

  it('a request already destroyed when the adapter runs is dropped quietly: no handler, no "already parsed" log, no hang', async () => {
    const spy = handlerSpy();
    const logged: Logged = [];
    const app = express();
    // Hold the request until the client is gone, then hand it on.
    app.use((req, _res, next) => {
      req.on('close', () => setImmediate(next));
    });
    app.use('/kit', toExpress(spy.routes, { logger: { warn: (e, d) => void logged.push([e, d]) } }));
    const base = await listen(app);
    const url = new URL(base);
    await new Promise<void>((resolve) => {
      const socket = connect(Number(url.port), url.hostname, () => {
        socket.write('POST /kit/echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}');
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 20);
      });
      socket.on('error', () => undefined);
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(spy.calls()).toBe(0);
    expect(logged).toEqual([]);
  });
});

describe('toExpress: a body parser ran first (misuse)', () => {
  it('express.json() before the adapter is a 500 internal, and the handler never runs', async () => {
    const spy: RouteTable = { 'POST /echo': vi.fn(() => ({ status: 200, body: {} })) };
    const logged: Logged = [];
    const app = express();
    app.use(express.json());
    app.use('/kit', toExpress(spy, { logger: { warn: (e, d) => void logged.push([e, d]) } }));
    const base = await listen(app);
    const res = await post(`${base}/kit/echo`, '{"a":1}');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(spy['POST /echo']).not.toHaveBeenCalled();
    expect(logged.map(([e]) => e)).toEqual(['chatwarden.http_body_already_parsed']);
  });

  it('logs once per adapter, not once per request, and with no detail', async () => {
    const routes: RouteTable = { 'POST /echo': () => ({ status: 200, body: {} }) };
    const logged: Logged = [];
    const app = express();
    app.use(express.json());
    app.use('/kit', toExpress(routes, { logger: { warn: (e, d) => void logged.push([e, d]) } }));
    const base = await listen(app);
    for (let i = 0; i < 4; i++) expect((await post(`${base}/kit/echo`, '{"a":1}')).status).toBe(500);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual(['chatwarden.http_body_already_parsed', undefined]);
  });

  it('a second adapter instance logs on its own', async () => {
    const routes: RouteTable = { 'POST /echo': () => ({ status: 200, body: {} }) };
    const logged: Logged = [];
    const logger: Logger = { warn: (e, d) => void logged.push([e, d]) };
    const app = express();
    app.use(express.json());
    app.use('/one', toExpress(routes, { logger }));
    app.use('/two', toExpress(routes, { logger }));
    const base = await listen(app);
    await post(`${base}/one/echo`, '{}');
    await post(`${base}/two/echo`, '{}');
    await post(`${base}/two/echo`, '{}');
    expect(logged).toHaveLength(2);
  });

  it('express.raw() and express.text() before the adapter are the same misuse', async () => {
    const routes: RouteTable = { 'POST /echo': () => ({ status: 200, body: {} }) };
    for (const parser of [express.raw({ type: '*/*' }), express.text({ type: '*/*' })] as RequestHandler[]) {
      const app = express();
      app.use(parser);
      app.use('/kit', toExpress(routes, { logger: { warn: () => undefined } }));
      const base = await listen(app);
      expect((await post(`${base}/kit/echo`, 'hello', { 'content-type': 'text/plain' })).status).toBe(500);
    }
  });

  it('a parser that already drained the stream without setting req.body is caught too', async () => {
    const routes: RouteTable = { 'POST /echo': () => ({ status: 200, body: {} }) };
    const app = express();
    app.use((req, _res, next) => {
      req.on('data', () => undefined);
      req.on('end', () => next());
    });
    app.use('/kit', toExpress(routes, { logger: { warn: () => undefined } }));
    const base = await listen(app);
    const res = await post(`${base}/kit/echo`, '{"a":1}');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
  });

  it('controls: express.json() on a DIFFERENT route, or mounted after the adapter, does not disturb it', async () => {
    const routes: RouteTable = { 'POST /echo': (req) => ({ status: 200, body: { rawBody: req.rawBody } }) };
    const app = express();
    app.use('/kit', toExpress(routes));
    app.post('/mine', express.json(), (req, res) => void res.json({ got: req.body as unknown }));
    app.use(express.json());
    const base = await listen(app);
    expect(await (await post(`${base}/kit/echo`, '{"a":1}')).json()).toEqual({ rawBody: '{"a":1}' });
    expect(await (await post(`${base}/mine`, '{"b":2}')).json()).toEqual({ got: { b: 2 } });
  });

  it('control: express.json() that skips the request (other content type) leaves the stream for the adapter', async () => {
    const routes: RouteTable = { 'POST /echo': (req) => ({ status: 200, body: { rawBody: req.rawBody } }) };
    const app = express();
    app.use(express.json());
    app.use('/kit', toExpress(routes));
    const base = await listen(app);
    const res = await post(`${base}/kit/echo`, 'plain text', { 'content-type': 'text/plain' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rawBody: 'plain text' });
  });

  it('a GET with express.json() before is fine: nothing was consumed', async () => {
    const app = express();
    app.use(express.json());
    app.use('/kit', toExpress(echoRoutes));
    const base = await listen(app);
    expect((await fetch(`${base}/kit/ping`)).status).toBe(200);
  });
});

describe('toExpress: failures', () => {
  it('a throwing or rejecting handler is a 500 internal with nothing leaked, logged by class only', async () => {
    const { app, logged } = build();
    const base = await listen(app);
    for (const path of ['/kit/throws', '/kit/rejects']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'internal' });
      expect(text).not.toContain('secret');
    }
    expect(logged).toEqual([
      ['chatwarden.http_error', { error: 'TypeError' }],
      ['chatwarden.http_error', { error: 'Error' }],
    ]);
  });

  const escapes: Array<[string, string]> = [
    ['an impossible status', '/kit/bad-status'],
    ['a CR/LF header value', '/kit/crlf-value'],
    ['an illegal header name', '/kit/bad-header-name'],
    ['a circular body', '/kit/circular'],
    ['a BigInt in the body', '/kit/bigint'],
  ];

  it.each(escapes)('an error while sending (%s) is the kit 500 {error:internal}: no stack, no HTML, nothing leaked, logged by class', async (_name, path) => {
    const { app, logged } = build();
    const base = await listen(app);
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal' });
    expect(text).not.toMatch(/<html|<pre|stack|\bat .*\(|node_modules|\.ts|ERR_/i);
    // Headers the failed response had already set are gone, and the injected cookie never arrived.
    expect(res.headers.get('x-before')).toBeNull();
    expect(res.headers.get('x-evil')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(logged).toHaveLength(1);
    expect(logged[0]?.[0]).toBe('chatwarden.http_error');
    expect(Object.keys(logged[0]?.[1] ?? {})).toEqual(['error']);
  });

  it('an escaped error never reaches the app error handler or Express default handler', async () => {
    const { app } = build();
    const seen: unknown[] = [];
    const handler: ErrorRequestHandler = (err, _req, res, next) => {
      void next; // Express treats a four-argument handler as the error handler
      seen.push(err);
      res.status(599).json({ handled: true });
    };
    app.use(handler);
    const base = await listen(app);
    for (const [, path] of escapes) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal' });
    }
    expect(seen).toHaveLength(0);
  });

  it('headers set by the app before the adapter survive an escaped error; only the adapter own are cleared', async () => {
    const { app } = build();
    const outer = express();
    outer.use((_req, res, next) => {
      res.setHeader('x-app-wide', 'kept');
      next();
    });
    outer.use(app);
    const base = await listen(outer);
    const res = await fetch(`${base}/kit/crlf-value`);
    expect(res.status).toBe(500);
    expect(res.headers.get('x-app-wide')).toBe('kept');
    expect(res.headers.get('x-before')).toBeNull();
  });

  it('an error after the headers went out destroys the connection and is logged; the server carries on', async () => {
    const logged: Logged = [];
    const app = express();
    app.use((_req, res, next) => {
      res.end = (() => {
        res.flushHeaders();
        throw new Error('write failed after headers');
      }) as typeof res.end;
      next();
    });
    app.use('/kit', toExpress(echoRoutes, { logger: { warn: (e, d) => void logged.push([e, d]) } }));
    const base = await listen(app);
    await expect(fetch(`${base}/kit/ping`).then((r) => r.text())).rejects.toThrow();
    expect(logged).toEqual([['chatwarden.http_error', { error: 'Error' }]]);
    const ok = express();
    ok.use('/kit', toExpress(echoRoutes));
    expect((await fetch(`${(await listen(ok))}/kit/ping`)).status).toBe(200);
  });

  it('rejects a routes argument that is not a route table', () => {
    for (const routes of [null, undefined, 'x', 3, []] as unknown[]) {
      expect(() => toExpress(routes as RouteTable)).toThrow(TypeError);
    }
  });

  it('a bad route key fails at build time, as createRouter does', () => {
    expect(() => toExpress({ 'get /x': () => ({ status: 200, body: {} }) })).toThrow(RangeError);
  });

  it('returns something app.use can mount, and it is reusable across apps', async () => {
    const adapter = toExpress(echoRoutes);
    expect(typeof adapter).toBe('function');
    for (let i = 0; i < 2; i++) {
      const app = express();
      app.use('/k', adapter);
      const base = await listen(app);
      expect((await fetch(`${base}/k/ping`)).status).toBe(200);
    }
  });

  it('a KitResponse typed value is what a handler can return (type check)', () => {
    const r: KitResponse = { status: 200, body: 'x' };
    expect(r.status).toBe(200);
  });
});

describe('toExpress: fallthrough (a path that is not the kit\'s goes on to the next handler)', () => {
  /** A kit at `mount`, then the adopter's own handlers, which record that they ran. */
  function app2(mount: string, opts?: ExpressOptions, routes: RouteTable = echoRoutes) {
    const ran: string[] = [];
    const app = express();
    app.use(mount, toExpress(routes, opts));
    app.get('/mine', (_req, res) => {
      ran.push('mine');
      res.send('mine');
    });
    app.post('/json', express.json(), (req, res) => {
      ran.push('json');
      res.json({ got: req.body as unknown });
    });
    app.use((_req, res) => {
      ran.push('last');
      res.status(404).send('app 404');
    });
    return { app, ran };
  }

  it('by default an unmatched path under the mount calls next(): the app answers, not the kit', async () => {
    const { app, ran } = app2('/kit');
    const base = await listen(app);
    const res = await fetch(`${base}/kit/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('app 404');
    expect(ran).toEqual(['last']);
  });

  it('a kit mounted at the root lets the app\'s later routes and body parsers work', async () => {
    const { app, ran } = app2('/');
    const base = await listen(app);
    expect(await (await fetch(`${base}/ping`)).json()).toEqual({ pong: true });
    expect(await (await fetch(`${base}/mine`)).text()).toBe('mine');
    const res = await post(`${base}/json`, '{"a":1}');
    expect(await res.json()).toEqual({ got: { a: 1 } });
    expect(ran).toEqual(['mine', 'json']);
  });

  it('the body is untouched on a fallthrough: a later express.json() still parses it, whatever its size', async () => {
    const { app } = app2('/', { maxBody: 10 });
    const base = await listen(app);
    const big = JSON.stringify({ text: 'x'.repeat(5000) });
    const res = await post(`${base}/json`, big);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { got: { text: string } }).got.text).toHaveLength(5000);
  });

  it('a HEAD on an unmatched path falls through too', async () => {
    const { app, ran } = app2('/kit');
    const base = await listen(app);
    expect((await fetch(`${base}/kit/nope`, { method: 'HEAD' })).status).toBe(404);
    expect(ran).toEqual(['last']);
  });

  it('a handler that answers 404 (an unknown id) is still the kit 404, and nothing after it runs', async () => {
    const routes: RouteTable = {
      'GET /reports/:id': () => {
        throw new NotFoundError();
      },
    };
    const { app, ran } = app2('/kit', undefined, routes);
    const base = await listen(app);
    const res = await fetch(`${base}/kit/reports/abc`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: 'Not found.' });
    expect(ran).toEqual([]);
  });

  it('a path that matches under another method is still 405 with allow, and nothing after it runs', async () => {
    const { app, ran } = app2('/kit');
    const base = await listen(app);
    const res = await fetch(`${base}/kit/ping`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(await res.json()).toEqual({ error: 'method_not_allowed', message: 'Method not allowed.' });
    expect(ran).toEqual([]);
  });

  it('a matched path with a bad body is still the kit\'s 413, not a fallthrough', async () => {
    const { app, ran } = app2('/kit', { maxBody: 10 });
    const base = await listen(app);
    expect((await post(`${base}/kit/echo`, 'x'.repeat(100))).status).toBe(413);
    expect(ran).toEqual([]);
  });

  it('fallthrough: false keeps the kit 404 for everything under the mount, and the app is not reached', async () => {
    const { app, ran } = app2('/kit', { fallthrough: false });
    const base = await listen(app);
    const res = await fetch(`${base}/kit/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: 'Not found.' });
    expect((await fetch(`${base}/kit/nope`, { method: 'HEAD' })).status).toBe(404);
    expect(ran).toEqual([]);
  });

  it('fallthrough: true is the default, spelled out', async () => {
    const { app, ran } = app2('/kit', { fallthrough: true });
    const base = await listen(app);
    expect(await (await fetch(`${base}/kit/nope`)).text()).toBe('app 404');
    expect(ran).toEqual(['last']);
  });

  it('OPTIONS on a known path falls through by default, so a CORS handler before the kit can answer the preflight', async () => {
    const app = express();
    const seen: string[] = [];
    // The documented order: CORS middleware first, then the kit.
    app.use((req, res, next) => {
      if (req.method !== 'OPTIONS') return next();
      seen.push(req.path);
      res.status(204).setHeader('access-control-allow-origin', '*').end();
    });
    app.use('/kit', toExpress(echoRoutes));
    const base = await listen(app);
    const res = await fetch(`${base}/kit/ping`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(seen).toEqual(['/kit/ping']);
  });

  it('OPTIONS on a known path reaches an OPTIONS handler mounted after the kit', async () => {
    const ran: string[] = [];
    const fresh = express();
    fresh.use('/kit', toExpress(echoRoutes));
    fresh.options('/kit/ping', (_req, res) => {
      ran.push('options');
      res.status(204).setHeader('allow', 'GET, HEAD, OPTIONS').end();
    });
    const base = await listen(fresh);
    const res = await fetch(`${base}/kit/ping`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(ran).toEqual(['options']);
    expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
  });

  it('with no handler anywhere an OPTIONS falls through to the app 404, not the kit 405', async () => {
    const { app, ran } = app2('/kit');
    const base = await listen(app);
    const res = await fetch(`${base}/kit/echo`, { method: 'OPTIONS' });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('app 404');
    expect(ran).toEqual(['last']);
  });

  it('fallthrough: false still answers OPTIONS on a known path itself (405 with allow), the app is not reached', async () => {
    const { app, ran } = app2('/kit', { fallthrough: false });
    const base = await listen(app);
    const res = await fetch(`${base}/kit/echo`, { method: 'OPTIONS' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD, POST');
    expect(ran).toEqual([]);
  });

  it('other wrong methods on a known path are still the kit 405 with fallthrough on (only OPTIONS is handed on)', async () => {
    const { app, ran } = app2('/kit');
    const base = await listen(app);
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      expect((await fetch(`${base}/kit/ping`, { method })).status, method).toBe(405);
    }
    expect(ran).toEqual([]);
  });

  it('a route table with its own OPTIONS route keeps answering it, fallthrough on', async () => {
    const { app, ran } = app2('/kit', undefined, { ...echoRoutes, 'OPTIONS /ping': () => ({ status: 204, headers: { 'x-own': '1' }, body: undefined }) });
    const base = await listen(app);
    const res = await fetch(`${base}/kit/ping`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('x-own')).toBe('1');
    expect(ran).toEqual([]);
    // Another known path without an OPTIONS route still goes on.
    expect((await fetch(`${base}/kit/echo`, { method: 'OPTIONS' })).status).toBe(404);
  });

  it.each([['yes'], [1], [null]])('refuses a fallthrough option that is not a boolean (%j)', (value) => {
    expect(() => toExpress(echoRoutes, { fallthrough: value as never })).toThrow(TypeError);
  });

  it('a request whose body was already parsed still gets the misuse 500 on a MATCHED path, and falls through on an unmatched one', async () => {
    const app = express();
    app.use(express.json());
    app.use('/kit', toExpress(echoRoutes));
    app.use((_req, res) => void res.status(404).send('app 404'));
    const base = await listen(app);
    expect((await post(`${base}/kit/echo`, '{"a":1}')).status).toBe(500);
    expect(await (await post(`${base}/kit/nope`, '{"a":1}')).text()).toBe('app 404');
  });
});
