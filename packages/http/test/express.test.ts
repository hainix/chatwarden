import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ErrorRequestHandler, Express, RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@chatwarden/core';
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
  app.use(mount, toExpress(routes, { logger, ...opts }));
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
