import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeHandler, peerAddress } from '../src/service/node.js';
import { toFetch } from '../src/fetch.js';
import type { RouteTable } from '../src/router.js';
import type { KitRequest, KitResponse } from '../src/types.js';

// S5: the Node bridge: a request to a `Request` with a byte cap and a read timeout, a `Response` to the socket with backpressure, and no trust in any forwarding header.

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => (s.closeAllConnections(), s.close(() => resolve())));
});

interface Seen {
  calls: KitRequest[];
}

async function listen(routes: RouteTable, options: { maxBody?: number; readTimeoutMs?: number } = {}): Promise<{ base: string; port: number; seen: Seen }> {
  const seen: Seen = { calls: [] };
  const wrapped: RouteTable = {};
  for (const [key, handler] of Object.entries(routes)) {
    wrapped[key] = (req, params) => {
      seen.calls.push(req);
      return handler(req, params);
    };
  }
  const fetchHandler = toFetch({ '': wrapped }, { remoteAddress: peerAddress, ...(options.maxBody === undefined ? {} : { maxBody: options.maxBody }) });
  const server = createServer(nodeHandler(fetchHandler, { ...options }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, port, seen };
}

const echo: RouteTable = {
  'POST /echo': (req): KitResponse => ({ status: 200, body: { bytes: (req.rawBody ?? '').length, address: req.remoteAddress ?? null, forwarded: req.headers['x-forwarded-for'] ?? null } }),
  'GET /ping': () => ({ status: 200, body: { pong: true } }),
};

/** A raw request over a socket, for what fetch will not send (a slow body, a header lie). */
function rawRequest(port: number, head: string, then: (write: (text: string) => void, end: () => void) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => (data += c));
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(head);
      then((text) => socket.write(text), () => socket.end());
    });
  });
}

describe('the body cap', () => {
  it('a 64 KiB body passes; one byte more is 413 before the handler runs', async () => {
    const s = await listen(echo);
    const fit = await fetch(`${s.base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `"${'a'.repeat(65_534)}"` });
    expect(fit.status).toBe(200);
    expect(((await fit.json()) as { bytes: number }).bytes).toBe(65_536);
    const before = s.seen.calls.length;
    const over = await fetch(`${s.base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `"${'a'.repeat(65_535)}"` });
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: string }).error).toBe('payload_too_large');
    expect(s.seen.calls.length).toBe(before);
  });

  it('a body with no content-length (chunked) over the cap is 413 too, and the handler never runs', async () => {
    const s = await listen(echo);
    const head = 'POST /echo HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n';
    const chunk = `"${'a'.repeat(40_000)}"`;
    const reply = await rawRequest(s.port, head, (write, end) => {
      write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
      write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
      write('0\r\n\r\n');
      end();
    });
    expect(reply).toMatch(/^HTTP\/1\.1 413/);
    expect(s.seen.calls).toHaveLength(0);
  });

  it('a custom cap applies', async () => {
    const s = await listen(echo, { maxBody: 100 });
    expect((await fetch(`${s.base}/echo`, { method: 'POST', body: 'x'.repeat(100) })).status).toBe(200);
    expect((await fetch(`${s.base}/echo`, { method: 'POST', body: 'x'.repeat(101) })).status).toBe(413);
  });
});

describe('the read timeout', () => {
  it('a slow body is closed by the read timeout: a 408 or a closed socket, and the handler never runs', async () => {
    const s = await listen(echo, { readTimeoutMs: 150 });
    const head = 'POST /echo HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 100\r\nconnection: close\r\n\r\n{"a"';
    const started = Date.now();
    const reply = await rawRequest(s.port, head, () => undefined);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(reply === '' || /^HTTP\/1\.1 (408|400)/.test(reply)).toBe(true);
    expect(s.seen.calls).toHaveLength(0);
  });

  it('a body that arrives in time passes under the same timeout', async () => {
    const s = await listen(echo, { readTimeoutMs: 1000 });
    const res = await fetch(`${s.base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"fine":true}' });
    expect(res.status).toBe(200);
  });
});

describe('the address', () => {
  it('the socket address, never a header, is the remoteAddress', async () => {
    const s = await listen(echo);
    const res = await fetch(`${s.base}/echo`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.99', 'x-real-ip': '203.0.113.98', forwarded: 'for=203.0.113.97', 'content-type': 'application/json' }, body: '{}' });
    const body = (await res.json()) as { address: string | null; forwarded: string | null };
    expect(body.address).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    expect(body.address).not.toContain('203.0.113');
  });

  it('a header the client sends is passed on as a header, and never becomes the address; the address is not a header either', async () => {
    const s = await listen(echo);
    await fetch(`${s.base}/echo`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.99', 'content-type': 'application/json' }, body: '{}' });
    const seen = s.seen.calls[0] as KitRequest;
    expect(seen.remoteAddress).not.toBe('203.0.113.99');
    expect(Object.keys(seen.headers).some((h) => h === 'x-remote-address')).toBe(false);
  });
});

describe('methods and responses', () => {
  it('HEAD is refused (405) without running the handler; GET and POST work', async () => {
    const s = await listen(echo);
    const head = await fetch(`${s.base}/ping`, { method: 'HEAD' });
    expect(head.status).toBe(405);
    expect(head.headers.get('allow')).toMatch(/GET/);
    expect(s.seen.calls).toHaveLength(0);
    expect((await fetch(`${s.base}/ping`)).status).toBe(200);
  });

  it('an unexpected handler failure is a 500 with no detail', async () => {
    const s = await listen({
      'GET /boom': () => {
        throw new Error('detail that must not leak');
      },
    });
    const res = await fetch(`${s.base}/boom`);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('must not leak');
  });

  it('a large response goes out whole through the socket (backpressure)', async () => {
    const big = 'x'.repeat(3_000_000);
    const s = await listen({ 'GET /big': () => ({ status: 200, body: { big } }) });
    const res = await fetch(`${s.base}/big`);
    expect(((await res.json()) as { big: string }).big.length).toBe(3_000_000);
  });

  it('a streaming response is written chunk by chunk, and a client that goes away cancels the stream exactly once', async () => {
    let started = 0;
    let cancelled = 0;
    const s = await listen({
      'GET /stream': () => ({
        status: 200,
        body: undefined,
        stream: {
          start(sink) {
            started += 1;
            sink.write('data: one\n\n');
            const timer = setInterval(() => sink.write('data: tick\n\n'), 10);
            return () => {
              cancelled += 1;
              clearInterval(timer);
            };
          },
        },
      }),
    });
    const controller = new AbortController();
    const res = await fetch(`${s.base}/stream`, { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('data: one');
    controller.abort();
    await reader.cancel().catch(() => undefined);
    for (let i = 0; i < 100 && cancelled === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toBe(1);
    expect(cancelled).toBe(1);
  });
});

// Review m4 and m5: HEAD on the two health paths, and the bridge's own errors on /v1 carry the service headers and a `message`.

const v1: RouteTable = {
  'POST /v1/echo': (req): KitResponse => ({ status: 200, body: { bytes: (req.rawBody ?? '').length } }),
  'GET /v1/boom': () => {
    throw new Error('detail that must not leak');
  },
  'GET /boom': () => {
    throw new Error('detail that must not leak');
  },
  'GET /healthz': () => ({ status: 200, body: { ok: true } }),
  'GET /readyz': () => ({ status: 200, body: { ready: true } }),
  'GET /ping': () => ({ status: 200, body: { pong: true } }),
  'GET /v1': () => ({ status: 200, body: { api: 1 } }),
};

describe('HEAD (review m4)', () => {
  it('/healthz and /readyz answer HEAD like GET with no body; the handler sees a GET', async () => {
    const s = await listen(v1);
    for (const path of ['/healthz', '/readyz', '/healthz?probe=1']) {
      const res = await fetch(`${s.base}${path}`, { method: 'HEAD' });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe('');
      expect(res.headers.get('content-type'), path).toMatch(/json/);
    }
    expect(s.seen.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
  });

  it('every other path stays 405 for HEAD, /v1 included, and the handler never runs', async () => {
    const s = await listen(v1);
    for (const path of ['/ping', '/v1', '/v1/echo', '/healthzz', '/healthz/x', '/', '/readyz/', '/Healthz']) {
      const res = await fetch(`${s.base}${path}`, { method: 'HEAD' });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toMatch(/GET/);
    }
    expect(s.seen.calls).toHaveLength(0);
  });

  it('a POST to /healthz is not turned into anything: it is the router that answers', async () => {
    const s = await listen(v1);
    const res = await fetch(`${s.base}/healthz`, { method: 'POST', body: 'x' });
    expect(res.status).not.toBe(200);
  });
});

describe('the bridge errors on /v1 (review m5)', () => {
  const RID = /^[0-9a-f]{16}$/;
  const serviceHeaders = (res: Response, rid?: string): void => {
    expect(res.headers.get('chatwarden-api')).toBe('1');
    expect(res.headers.get('x-request-id')).toMatch(rid === undefined ? RID : new RegExp(`^${rid}$`));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  };

  it('413 on /v1 carries the version, a request id, no-store and a message', async () => {
    const s = await listen(v1);
    const res = await fetch(`${s.base}/v1/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `"${'a'.repeat(65_535)}"` });
    expect(res.status).toBe(413);
    serviceHeaders(res);
    expect(await res.json()).toEqual({ error: 'payload_too_large', message: 'The request body is too large.' });
  });

  it('a request id the caller sent (a valid one) is echoed; a bad one is replaced', async () => {
    const s = await listen(v1);
    const body = `"${'a'.repeat(65_535)}"`;
    const given = await fetch(`${s.base}/v1/echo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'call-1234' }, body });
    serviceHeaders(given, 'call-1234');
    const bad = await fetch(`${s.base}/v1/echo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'bad id!' }, body });
    serviceHeaders(bad);
  });

  it('408 on /v1 (a slow body) carries the same and a message', async () => {
    const s = await listen(v1, { readTimeoutMs: 150 });
    const head = 'POST /v1/echo HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 100\r\nconnection: close\r\n\r\n{"a"';
    const reply = await rawRequest(s.port, head, () => undefined);
    // a closed socket is also allowed (the read timeout may win the race with the client)
    if (reply !== '') {
      expect(reply).toMatch(/^HTTP\/1\.1 408/);
      expect(reply.toLowerCase()).toContain('chatwarden-api: 1');
      expect(reply.toLowerCase()).toMatch(/x-request-id: [0-9a-f]{16}/);
      expect(reply).toContain('"message"');
    }
    expect(s.seen.calls).toHaveLength(0);
  });

  /** A server whose fetch handler itself throws (what the bridge's own 500 is for), over the bridge alone. */
  async function throwing(): Promise<string> {
    const server = createServer(
      nodeHandler(() => {
        throw new Error('detail that must not leak');
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('500 on /v1 carries the same, a message and no detail', async () => {
    const base = await throwing();
    const res = await fetch(`${base}/v1/boom`);
    expect(res.status).toBe(500);
    serviceHeaders(res);
    const text = await res.text();
    expect(text).not.toContain('must not leak');
    const body = JSON.parse(text) as { error: string; message: string };
    expect(body.error).toBe('internal');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('a 405 for HEAD on /v1 carries the service headers too', async () => {
    const s = await listen(v1);
    const res = await fetch(`${s.base}/v1`, { method: 'HEAD' });
    expect(res.status).toBe(405);
    serviceHeaders(res);
  });

  it('outside /v1 the bridge errors stay plain (no service headers) but still carry a message', async () => {
    const s = await listen(v1);
    const base = await throwing();
    const res = await fetch(`${base}/boom`);
    expect(res.status).toBe(500);
    expect(res.headers.get('chatwarden-api')).toBeNull();
    expect(res.headers.get('x-request-id')).toBeNull();
    expect(((await res.json()) as { message?: string }).message).toBeTypeOf('string');
    const over = await fetch(`${s.base}/ping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `"${'a'.repeat(65_535)}"` });
    expect(over.status).toBe(413);
    expect(over.headers.get('chatwarden-api')).toBeNull();
  });

  it('a path that merely starts with /v1 (like /v10 or /v1x) is not the service', async () => {
    const base = await throwing();
    const res = await fetch(`${base}/v10/boom`);
    expect(res.status).toBe(500);
    expect(res.headers.get('chatwarden-api')).toBeNull();
  });
});
