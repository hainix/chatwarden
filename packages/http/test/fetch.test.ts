import { describe, expect, it } from 'vitest';
import type { Logger } from '@chatwarden/core';
import { toFetch } from '../src/fetch.js';
import type { Mounts } from '../src/fetch.js';
import { HttpError, NotFoundError, ValidationError } from '../src/errors.js';
import { createRouter } from '../src/router.js';
import type { RouteTable } from '../src/router.js';
import type { KitRequest, KitResponse } from '../src/types.js';

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;
const logs = (): { logger: Logger; logged: Logged } => {
  const logged: Logged = [];
  return { logger: { warn: (event, detail) => void logged.push([event, detail]) }, logged };
};

const URL_BASE = 'http://game.example.invalid';
const req = (path: string, init: RequestInit = {}): Request => new Request(`${URL_BASE}${path}`, init);
const json = async (res: Response | null): Promise<unknown> => JSON.parse(await (res as Response).text());

/** A table whose routes record the KitRequest they were given. */
function recorder(): { table: RouteTable; seen: KitRequest[] } {
  const seen: KitRequest[] = [];
  const handler = (r: KitRequest): KitResponse => {
    seen.push(r);
    return { status: 200, body: { ok: true } };
  };
  return {
    seen,
    table: { 'GET /': handler, 'GET /things/:id': handler, 'POST /things': handler, 'GET /ping': handler, 'POST /echo': handler, 'GET /healthz': handler },
  };
}

describe('routing', () => {
  it('prefix and mount keys are stripped before the table sees the path', async () => {
    const admin = recorder();
    const api = recorder();
    const root = recorder();
    const fetchHandler = toFetch({ '/admin': admin.table, '/api': api.table, '': root.table }, { prefix: '/chatwarden' });
    expect((await fetchHandler(req('/chatwarden/admin/things/7'))).status).toBe(200);
    expect((await fetchHandler(req('/chatwarden/api/ping'))).status).toBe(200);
    expect((await fetchHandler(req('/chatwarden/healthz'))).status).toBe(200);
    expect(admin.seen.map((r) => r.path)).toEqual(['/things/7']);
    expect(api.seen.map((r) => r.path)).toEqual(['/ping']);
    expect(root.seen.map((r) => r.path)).toEqual(['/healthz']);
    // The mount itself, with and without a query, is the table's root.
    expect((await fetchHandler(req('/chatwarden/admin'))).status).toBe(200);
    expect((await fetchHandler(req('/chatwarden/admin?x=1'))).status).toBe(200);
    expect(admin.seen.map((r) => r.path)).toEqual(['/things/7', '/', '/']);
  });

  it('works with no prefix, and with a prefix of its own and no mount key', async () => {
    const one = recorder();
    expect((await toFetch({ '': one.table })(req('/ping'))).status).toBe(200);
    expect(one.seen[0]!.path).toBe('/ping');
    const two = recorder();
    expect((await toFetch({ '': two.table }, { prefix: '/kit' })(req('/kit/ping'))).status).toBe(200);
    expect(two.seen[0]!.path).toBe('/ping');
  });

  it('the longest mount wins, and a mount owns whole path segments only', async () => {
    const a = recorder();
    const ab = recorder();
    const fetchHandler = toFetch({ '/a': a.table, '/a/b': ab.table }, { unmatched: 'pass' });
    await fetchHandler(req('/a/b/ping'));
    await fetchHandler(req('/a/ping'));
    await fetchHandler(req('/a/c'));
    expect(ab.seen.map((r) => r.path)).toEqual(['/ping']);
    expect(a.seen.map((r) => r.path)).toEqual(['/ping']); // /a/c matched nothing in table a (a 404 from the kit, so not recorded)
    // /ab is not under /a, and /a/bc is not under /a/b.
    expect(await fetchHandler(req('/ab/ping'))).toBeNull();
    const res = (await fetchHandler(req('/a/bc/ping')))!;
    expect(res.status).toBe(404);
    expect(ab.seen).toHaveLength(1);
  });

  it('the order the mounts were written in never decides', async () => {
    for (const keys of [['/a', '/a/b'], ['/a/b', '/a']]) {
      const tables = new Map(keys.map((k) => [k, recorder()]));
      const mounts: Mounts = Object.fromEntries(keys.map((k) => [k, tables.get(k)!.table]));
      await toFetch(mounts)(req('/a/b/ping'));
      expect(tables.get('/a/b')!.seen).toHaveLength(1);
      expect(tables.get('/a')!.seen).toHaveLength(0);
    }
  });

  it('404 and 405 with allow, as createRouter', async () => {
    const { table } = recorder();
    const router = createRouter(table);
    const fetchHandler = toFetch({ '': table });
    for (const [method, path] of [['GET', '/nothing'], ['DELETE', '/ping'], ['PUT', '/things'], ['POST', '/things/7'], ['GET', '/things/a%20b'], ['GET', '/things/%E0'], ['DELETE', '/']] as const) {
      const expected = await router({ method, path, query: {}, headers: {}, body: undefined });
      const got = await fetchHandler(req(path, { method }));
      expect(got.status, `${method} ${path}`).toBe(expected.status);
      expect(got.headers.get('allow'), `${method} ${path}`).toBe(expected.headers?.allow ?? null);
      expect(await json(got), `${method} ${path}`).toEqual(expected.body);
    }
    const notAllowed = await fetchHandler(req('/ping', { method: 'DELETE' }));
    expect(notAllowed.status).toBe(405);
    expect(notAllowed.headers.get('allow')).toBe('GET, HEAD');
  });

  it("unmatched: 'pass' resolves null for a path outside every mount and still answers 404/405 inside one", async () => {
    const { table } = recorder();
    const fetchHandler = toFetch({ '/admin': table }, { prefix: '/chatwarden', unmatched: 'pass' });
    expect(await fetchHandler(req('/elsewhere'))).toBeNull();
    expect(await fetchHandler(req('/chatwarden'))).toBeNull();
    expect(await fetchHandler(req('/chatwarden/other/ping'))).toBeNull();
    expect(await fetchHandler(req('/chatwarden/administrator'))).toBeNull();
    const missing = (await fetchHandler(req('/chatwarden/admin/zzz')))!;
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ error: 'not_found' });
    const wrong = (await fetchHandler(req('/chatwarden/admin/ping', { method: 'DELETE' })))!;
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET, HEAD');
    expect((await fetchHandler(req('/chatwarden/admin/ping')))!.status).toBe(200);
  });

  it("the default answers a path outside every mount with the kit's 404, in the router's shape", async () => {
    const { table } = recorder();
    const res = await toFetch({ '/admin': table }, { prefix: '/chatwarden' })(req('/elsewhere'));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await json(res)).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it("a root ('') mount owns only the paths its table has, so 'pass' still passes the rest", async () => {
    const { table } = recorder();
    const fetchHandler = toFetch({ '': table }, { unmatched: 'pass' });
    expect((await fetchHandler(req('/healthz')))!.status).toBe(200);
    expect((await fetchHandler(req('/healthz', { method: 'POST' })))!.status).toBe(405);
    expect(await fetchHandler(req('/something-else'))).toBeNull();
  });

  it('a malformed mount key or prefix (no leading slash, trailing slash, //) is a RangeError at toFetch time', () => {
    const { table } = recorder();
    const bad = ['admin', '/admin/', '//a', '/a//b', '/', '/a b', '/a?x', '/a#x', '/a/../b', '/a/./b', '/..', '/a%2Fb', '/a\\b', '/a\nb', ' /a', '/é'];
    for (const key of bad) {
      expect(() => toFetch({ [key]: table }), `key ${JSON.stringify(key)}`).toThrow(RangeError);
      expect(() => toFetch({ '': table }, { prefix: key }), `prefix ${JSON.stringify(key)}`).toThrow(RangeError);
    }
    // The error does not echo what was given.
    for (const key of ['admin', '/a b']) {
      try {
        toFetch({ [key]: table });
      } catch (cause) {
        expect((cause as Error).message).not.toContain(key);
      }
    }
    for (const good of ['', '/a', '/a/b', '/a-b_c.d', '/api/v1', '/~x']) {
      expect(() => toFetch({ [good]: table }, { prefix: good })).not.toThrow();
    }
  });

  it('refuses what is not a table, not a mounts object or not a known option, at toFetch time', () => {
    const { table } = recorder();
    for (const bad of [null, undefined, 5, 'x', []]) expect(() => toFetch(bad as never), String(bad)).toThrow(TypeError);
    for (const bad of [null, 5, 'x', [], () => ({})]) expect(() => toFetch({ '/a': bad as never }), String(bad)).toThrow(TypeError);
    expect(() => toFetch({ '/a': { 'bad key': () => ({ status: 200, body: {} }) } })).toThrow(RangeError);
    expect(() => toFetch({ '/a': table }, { unmatched: 'maybe' as never })).toThrow(TypeError);
    expect(() => toFetch({ '/a': table }, { remoteAddress: 'nope' as never })).toThrow(TypeError);
    expect(() => toFetch({ '/a': table }, null as never)).not.toThrow(); // no options is no options
  });

  it('the options and the mounts are read once: changing them later changes nothing', async () => {
    const { table } = recorder();
    const mounts: Mounts = { '/a': table };
    const options = { unmatched: 'pass' as const };
    const fetchHandler = toFetch(mounts, options);
    delete mounts['/a'];
    options.unmatched = 'not_found' as never;
    expect((await fetchHandler(req('/a/ping')))!.status).toBe(200);
    expect(await fetchHandler(req('/b'))).toBeNull();
  });

  it('answers the same path the same way, concurrently', async () => {
    const { table } = recorder();
    const fetchHandler = toFetch({ '/a': table });
    const all = await Promise.all(Array.from({ length: 30 }, (_, i) => fetchHandler(req(`/a/things/${i}`))));
    expect(all.every((r) => r.status === 200)).toBe(true);
  });
});

describe('the request the table sees', () => {
  it('query keeps the first value of each key, strings only; headers are lower-cased; the raw body is the exact text, a bad UTF-8 byte becomes U+FFFD; body stays undefined', async () => {
    const { table, seen } = recorder();
    const fetchHandler = toFetch({ '': table });
    await fetchHandler(req('/echo?a=1&a=2&b=&c&d=x%20y&e=%C3%A9&f[]=1', { method: 'POST', headers: { 'X-Zorbak': 'Vlemmo', 'Content-Type': 'application/json' }, body: '{"k":"é"}' }));
    const r = seen[0]!;
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/echo');
    expect(r.query).toEqual({ a: '1', b: '', c: '', d: 'x y', e: 'é', 'f[]': '1' });
    expect(Object.getPrototypeOf(r.query)).toBeNull();
    expect(r.headers['x-zorbak']).toBe('Vlemmo');
    expect(r.headers['content-type']).toBe('application/json');
    expect(Object.keys(r.headers).every((k) => k === k.toLowerCase())).toBe(true);
    expect(r.rawBody).toBe('{"k":"é"}');
    expect(r.body).toBeUndefined();

    await fetchHandler(req('/echo', { method: 'POST', body: new Uint8Array([0x61, 0xff, 0x62, 0xc3]) }));
    expect(seen[1]!.rawBody).toBe('a�b�');
    // A byte-order mark is kept (the Express adapter keeps it too), so a signature over the text is the same.
    await fetchHandler(req('/echo', { method: 'POST', body: new Uint8Array([0xef, 0xbb, 0xbf, 0x61]) }));
    expect(seen[2]!.rawBody).toBe('﻿a');
    // Multi-byte text over several chunks is joined before it is decoded.
    const encoded = new TextEncoder().encode('héllo wörld ☃');
    const chunked = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < encoded.length; i += 2) c.enqueue(encoded.slice(i, i + 2));
        c.close();
      },
    });
    await fetchHandler(req('/echo', { method: 'POST', body: chunked, duplex: 'half' } as RequestInit));
    expect(seen[3]!.rawBody).toBe('héllo wörld ☃');
  });

  it('query keys that look like prototype keys are plain data', async () => {
    const { table, seen } = recorder();
    await toFetch({ '': table })(req('/ping?__proto__=x&constructor=y&toString=z'));
    expect(seen[0]!.query.__proto__).toBe('x');
    expect(seen[0]!.query.constructor).toBe('y');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('a request with no body has an empty raw body, whatever the method', async () => {
    const { table, seen } = recorder();
    const fetchHandler = toFetch({ '': table });
    await fetchHandler(req('/ping'));
    await fetchHandler(req('/ping', { method: 'HEAD' }));
    await fetchHandler(req('/echo', { method: 'POST' }));
    await fetchHandler(req('/echo', { method: 'POST', body: '' }));
    expect(seen.map((r) => r.rawBody)).toEqual(['', '', '', '']);
  });

  it('remoteAddress comes only from the option and is absent otherwise (a spoofed x-forwarded-for never reaches it)', async () => {
    const { table, seen } = recorder();
    const spoofed = { 'x-forwarded-for': '203.0.113.99', forwarded: 'for=203.0.113.98', 'x-real-ip': '203.0.113.97', 'cf-connecting-ip': '203.0.113.96' };
    await toFetch({ '': table })(req('/ping', { headers: spoofed }));
    expect('remoteAddress' in seen[0]!).toBe(false);
    const asked: Request[] = [];
    const withAddress = toFetch({ '': table }, { remoteAddress: (request) => (asked.push(request), '198.51.100.7') });
    await withAddress(req('/ping', { headers: spoofed }));
    expect(seen[1]!.remoteAddress).toBe('198.51.100.7');
    expect(asked).toHaveLength(1);
    // The raw headers are still there for the adopter's own identify hook; the kit just never promotes one to the address.
    expect(seen[1]!.headers['x-forwarded-for']).toBe('203.0.113.99');
    for (const odd of [undefined, '', 5, null, {}]) {
      const { table: t2, seen: s2 } = recorder();
      const { logger, logged } = logs();
      await toFetch({ '': t2 }, { remoteAddress: () => odd as never, logger })(req('/ping'));
      expect(s2[0]!.remoteAddress === undefined || s2[0]!.remoteAddress === '', String(odd)).toBe(true);
      expect(logged).toEqual([]);
    }
  });

  it('a remoteAddress option that throws is no address and one warning, class only', async () => {
    const { table, seen } = recorder();
    const { logger, logged } = logs();
    const res = await toFetch({ '': table }, { remoteAddress: () => { throw new TypeError('secret detail 203.0.113.5'); }, logger })(req('/ping'));
    expect(res.status).toBe(200);
    expect('remoteAddress' in seen[0]!).toBe(false);
    expect(logged).toEqual([['chatwarden.http_error', { error: 'TypeError' }]]);
  });

  it('the method is the request method, upper case; a route is chosen by it', async () => {
    const seen: string[] = [];
    const table: RouteTable = { 'GET /x': (r) => (seen.push(r.method), { status: 200, body: 1 }), 'PURGE /x': (r) => (seen.push(r.method), { status: 200, body: 2 }) };
    const fetchHandler = toFetch({ '': table });
    await fetchHandler(req('/x'));
    await fetchHandler(req('/x', { method: 'purge' }));
    expect(seen).toEqual(['GET', 'PURGE']);
  });
});

describe('limits', () => {
  /** A request body stream that reports what the adapter did to it. */
  function watched(chunks: Uint8Array[], declared?: number): { request: Request; reads: () => number; cancelled: () => boolean } {
    let reads = 0;
    let cancelled = false;
    let i = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          reads += 1;
          const chunk = chunks[i++];
          if (chunk === undefined) c.close();
          else c.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const headers: Record<string, string> = declared === undefined ? {} : { 'content-length': String(declared) };
    return { request: req('/echo', { method: 'POST', body: stream, duplex: 'half', headers } as RequestInit), reads: () => reads, cancelled: () => cancelled };
  }
  const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(0x61);

  it('a declared content-length over the cap is 413 before the body is read (the stream is not touched)', async () => {
    const { table, seen } = recorder();
    const { logger } = logs();
    const w = watched([bytes(10)], 100_000);
    const res = await toFetch({ '': table }, { logger })(w.request);
    expect(res.status).toBe(413);
    expect(await json(res)).toEqual({ error: 'payload_too_large', message: 'The request body is too large.' });
    expect(w.reads()).toBe(0);
    expect(seen).toEqual([]);
    // With a custom cap, the same rule.
    const small = watched([bytes(10)], 11);
    expect((await toFetch({ '': table }, { maxBody: 10 })(small.request)).status).toBe(413);
    expect(small.reads()).toBe(0);
  });

  it('a chunked body over the cap is 413 and the reader is cancelled', async () => {
    const { table, seen } = recorder();
    const w = watched([bytes(6), bytes(6), bytes(6), bytes(6)]);
    const res = await toFetch({ '': table }, { maxBody: 10 })(w.request);
    expect(res.status).toBe(413);
    expect(w.cancelled()).toBe(true);
    expect(w.reads()).toBeLessThanOrEqual(3); // it stopped at the cap, not at the end
    expect(seen).toEqual([]);
  });

  it('a content-length that lies low is still held to the cap by counting bytes', async () => {
    const { table } = recorder();
    const w = watched([bytes(6), bytes(6)], 3);
    expect((await toFetch({ '': table }, { maxBody: 10 })(w.request)).status).toBe(413);
    expect(w.cancelled()).toBe(true);
  });

  it('a body of exactly the cap is read; one byte more is 413 (the default cap is 65536)', async () => {
    const { table, seen } = recorder();
    for (const [cap, size] of [[10, 10], [65536, 65536], [100, 0]] as const) {
      const ok = watched([bytes(size)]);
      const handler = toFetch({ '': table }, cap === 65536 ? {} : { maxBody: cap });
      expect((await handler(ok.request)).status, `${size} of ${cap}`).toBe(200);
    }
    expect(seen.map((r) => r.rawBody?.length)).toEqual([10, 65536, 0]);
    expect((await toFetch({ '': table }, { maxBody: 10 })(watched([bytes(11)]).request)).status).toBe(413);
    expect((await toFetch({ '': table })(watched([bytes(65537)]).request)).status).toBe(413);
    // Bytes are counted, not characters: four 3-byte characters are 12 bytes.
    const multi = req('/echo', { method: 'POST', body: '☃☃☃☃' });
    expect((await toFetch({ '': table }, { maxBody: 11 })(multi)).status).toBe(413);
    expect((await toFetch({ '': table }, { maxBody: 12 })(req('/echo', { method: 'POST', body: '☃☃☃☃' }))).status).toBe(200);
  });

  it('a content-length that is not a number is ignored and the body is counted', async () => {
    const { table } = recorder();
    const odd = req('/echo', { method: 'POST', body: 'hello', headers: { 'content-length': 'banana' } });
    // Node's Request may refuse the header; either way the answer is a normal one.
    expect([200, 400]).toContain((await toFetch({ '': table })(odd)).status);
  });

  it('a body stream that fails midway is a 400 in the kit shape, and nothing is thrown', async () => {
    const { table, seen } = recorder();
    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(bytes(3));
        throw new Error('connection reset 203.0.113.5');
      },
    });
    const res = await toFetch({ '': table })(req('/echo', { method: 'POST', body: broken, duplex: 'half' } as RequestInit));
    expect(res.status).toBe(400);
    const answer = await json(res);
    expect(answer).toMatchObject({ error: 'invalid_request' });
    expect(JSON.stringify(answer)).not.toContain('203.0.113.5');
    expect(seen).toEqual([]);
  });

  it('a GET or HEAD never reads a body, and a declared length on one does not matter', async () => {
    const { table } = recorder();
    const fetchHandler = toFetch({ '': table }, { maxBody: 10 });
    expect((await fetchHandler(req('/ping', { headers: { 'content-length': '999999' } }))).status).toBe(200);
    expect((await fetchHandler(req('/ping', { method: 'HEAD', headers: { 'content-length': '999999' } }))).status).toBe(200);
  });

  it('maxBody: 0, 1.5, NaN, "5" and 16 MiB + 1 are RangeErrors that never echo the value', () => {
    const { table } = recorder();
    const MIB16 = 16 * 1024 * 1024;
    for (const bad of [0, -1, 1.5, Number.NaN, '5', MIB16 + 1, Infinity, -Infinity, null, true, {}, [5], 2 ** 53]) {
      try {
        toFetch({ '': table }, { maxBody: bad as never });
        throw new Error(`accepted ${String(bad)}`);
      } catch (cause) {
        expect(cause, String(bad)).toBeInstanceOf(RangeError);
        const message = (cause as Error).message;
        for (const shown of [String(bad), JSON.stringify(bad)]) {
          if (shown !== undefined && shown.length > 1) expect(message).not.toContain(shown);
        }
        expect(message).toMatch(/maxBody/);
      }
    }
    for (const good of [1, 5, 65536, MIB16, undefined]) expect(() => toFetch({ '': table }, { maxBody: good })).not.toThrow();
  });
});

describe('errors', () => {
  it("a handler that throws is the kit's 500 shape with no stack; one that rejects, the same", async () => {
    const { logger, logged } = logs();
    const table: RouteTable = {
      'GET /throws': () => {
        throw new Error('database password is hunter2 at /srv/app/db.ts:44');
      },
      'GET /rejects': () => Promise.reject(new TypeError('also secret')),
    };
    const fetchHandler = toFetch({ '': table }, { logger });
    for (const path of ['/throws', '/rejects']) {
      const res = await fetchHandler(req(path));
      expect(res.status, path).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'internal' });
      expect(text).not.toMatch(/hunter2|secret|\.ts|stack|at /);
    }
    expect(logged.map(([event, detail]) => [event, detail])).toEqual([['chatwarden.http_error', { error: 'Error' }], ['chatwarden.http_error', { error: 'TypeError' }]]);
  });

  it("the router's own error mapping is kept: a validation error is 400, a not found 404, an http error its own status and headers", async () => {
    const table: RouteTable = {
      'GET /bad': () => {
        throw new ValidationError();
      },
      'GET /gone': () => {
        throw new NotFoundError();
      },
      'GET /limited': () => {
        throw new HttpError('rate_limited', { 'retry-after': '7' });
      },
    };
    const fetchHandler = toFetch({ '': table });
    expect((await fetchHandler(req('/bad'))).status).toBe(400);
    expect((await fetchHandler(req('/gone'))).status).toBe(404);
    const limited = await fetchHandler(req('/limited'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('7');
  });

  it('a response that cannot be serialised is the 500', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const table: RouteTable = {
      'GET /circular': () => ({ status: 200, body: circular }),
      'GET /bigint': () => ({ status: 200, body: { n: 10n } }),
      'GET /status-low': () => ({ status: 99, body: {} }),
      'GET /status-high': () => ({ status: 1000, body: {} }),
      'GET /status-nan': () => ({ status: Number.NaN, body: {} }),
      'GET /header-newline': () => ({ status: 200, headers: { 'x-a': 'one\r\ntwo: injected' }, body: {} }),
      'GET /header-name': () => ({ status: 200, headers: { 'bad name': 'x' }, body: {} }),
      'GET /no-content-with-body': () => ({ status: 204, body: { should: 'not be here' } }),
    };
    const { logger, logged } = logs();
    const fetchHandler = toFetch({ '': table }, { logger });
    for (const path of Object.keys(table).map((k) => k.slice(4))) {
      const res = await fetchHandler(req(path));
      expect(res.status, path).toBe(500);
      expect(await json(res), path).toEqual({ error: 'internal' });
      expect(res.headers.get('x-a'), path).toBeNull();
    }
    expect(logged).toHaveLength(Object.keys(table).length);
    for (const [event, detail] of logged) {
      expect(event).toBe('chatwarden.http_error');
      expect(Object.keys(detail ?? {})).toEqual(['error']);
      expect(detail?.error).toMatch(/^(TypeError|RangeError|SyntaxError)$/);
    }
  });

  it('a logger that throws does not change the answer', async () => {
    const fetchHandler = toFetch({ '': { 'GET /x': () => { throw new Error('x'); } } }, { logger: { warn: () => { throw new Error('logger down'); } } });
    expect((await fetchHandler(req('/x'))).status).toBe(500);
  });

  it('a 204 and a 304 are sent with no body', async () => {
    const table: RouteTable = { 'GET /empty': () => ({ status: 204, body: undefined }), 'GET /cached': () => ({ status: 304, body: undefined }) };
    const fetchHandler = toFetch({ '': table });
    for (const path of ['/empty', '/cached']) {
      const res = await fetchHandler(req(path));
      expect(res.body).toBeNull();
    }
    expect((await fetchHandler(req('/empty'))).status).toBe(204);
  });
});

describe('response', () => {
  it('a string body is raw with text/plain unless the route set a type; an object is JSON', async () => {
    const table: RouteTable = {
      'GET /text': () => ({ status: 200, body: '# Rules\n"quoted"' }),
      'GET /html': () => ({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: '<p>hi</p>' }),
      'GET /object': () => ({ status: 201, body: { a: 1, b: ['é'] } }),
      'GET /null': () => ({ status: 200, body: null }),
      'GET /number': () => ({ status: 200, body: 5 }),
      'GET /empty-string': () => ({ status: 200, body: '' }),
      'GET /nothing': () => ({ status: 200, body: undefined }),
      'GET /custom-json': () => ({ status: 200, headers: { 'content-type': 'application/problem+json' }, body: { e: 1 } }),
    };
    const fetchHandler = toFetch({ '': table });
    const text = await fetchHandler(req('/text'));
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await text.text()).toBe('# Rules\n"quoted"');
    const html = await fetchHandler(req('/html'));
    expect([...html.headers].filter(([k]) => k === 'content-type')).toEqual([['content-type', 'text/html; charset=utf-8']]);
    expect(await html.text()).toBe('<p>hi</p>');
    const object = await fetchHandler(req('/object'));
    expect(object.status).toBe(201);
    expect(object.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await object.json()).toEqual({ a: 1, b: ['é'] });
    expect(await (await fetchHandler(req('/null'))).text()).toBe('null');
    expect(await (await fetchHandler(req('/number'))).text()).toBe('5');
    expect(await (await fetchHandler(req('/empty-string'))).text()).toBe('');
    expect((await fetchHandler(req('/empty-string'))).headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const nothing = await fetchHandler(req('/nothing'));
    expect(await nothing.text()).toBe('');
    expect(nothing.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect((await fetchHandler(req('/custom-json'))).headers.get('content-type')).toBe('application/problem+json');
  });

  it('every header the route sets is sent as given', async () => {
    const table: RouteTable = { 'GET /h': () => ({ status: 200, headers: { 'cache-control': 'no-store', 'X-Custom': 'a, b', 'set-cookie': 'a=1; HttpOnly' }, body: {} }) };
    const res = await toFetch({ '': table })(req('/h'));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-custom')).toBe('a, b');
    expect(res.headers.getSetCookie()).toEqual(['a=1; HttpOnly']);
  });

  it('HEAD has the GET headers and no body, with the length of what GET would send', async () => {
    const table: RouteTable = {
      'GET /doc': () => ({ status: 200, headers: { 'x-doc': '1' }, body: '€ rules' }),
      'GET /obj': () => ({ status: 200, body: { é: 1 } }),
      'GET /none': () => ({ status: 200, body: undefined }),
    };
    const fetchHandler = toFetch({ '': table });
    const get = await fetchHandler(req('/doc'));
    const head = await fetchHandler(req('/doc', { method: 'HEAD' }));
    expect(head.status).toBe(get.status);
    expect(head.body).toBeNull();
    expect(head.headers.get('x-doc')).toBe('1');
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
    expect(head.headers.get('content-length')).toBe(String(new TextEncoder().encode('€ rules').length));
    const headObj = await fetchHandler(req('/obj', { method: 'HEAD' }));
    expect(headObj.headers.get('content-length')).toBe(String(new TextEncoder().encode(JSON.stringify({ é: 1 })).length));
    expect((await fetchHandler(req('/none', { method: 'HEAD' }))).headers.get('content-length')).toBeNull();
    // A route that answers HEAD itself is used as it is.
    const own: RouteTable = { 'GET /x': () => ({ status: 200, body: 'get' }), 'HEAD /x': () => ({ status: 204, body: undefined }) };
    expect((await toFetch({ '': own })(req('/x', { method: 'HEAD' }))).status).toBe(204);
  });

  it('a content-length the route set on HEAD is kept', async () => {
    const table: RouteTable = { 'GET /x': () => ({ status: 200, headers: { 'content-length': '999' }, body: 'abc' }) };
    expect((await toFetch({ '': table })(req('/x', { method: 'HEAD' }))).headers.get('content-length')).toBe('999');
  });
});

