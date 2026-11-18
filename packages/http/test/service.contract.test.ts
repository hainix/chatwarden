import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVICE_API_VERSION, parseWho, requestIdFor, validId } from '../src/service/contract.js';
import { createServiceWrapper } from '../src/service/wrap.js';
import type { ServiceCall } from '../src/service/wrap.js';
import { ValidationError } from '../src/errors.js';
import { KEY_A, callerOver, errorCode } from './serviceKit.js';

// S1: the shape every /v1 answer shares: headers, ids, who, the body cap, the log line.

const logs: Array<[string, Record<string, unknown> | undefined]> = [];

function table(over: { maxBody?: number } = {}) {
  logs.length = 0;
  const clock = { t: 1_800_000_000_000 };
  const { svc } = createServiceWrapper({ keys: [KEY_A], now: () => clock.t, logger: { warn: (e, d) => void logs.push([e, d]) }, ...over });
  const seen: ServiceCall[] = [];
  const call = callerOver({
    'GET /ping': svc('GET /ping', () => ({ status: 200, body: { pong: true } })),
    'POST /echo': svc('POST /echo', (c) => {
      seen.push(c);
      return { status: 200, body: { got: c.body ?? null } };
    }),
    'PUT /echo': svc('PUT /echo', (c) => ({ status: 200, body: { got: c.body ?? null } })),
    'POST /boom': svc('POST /boom', () => {
      throw new Error('boom with a secret detail');
    }),
    'POST /rooms/:room~room/seats/:seat~room': svc('POST /rooms/:room~room/seats/:seat~room', (c) => ({ status: 200, body: { room: validId(c.params.room), seat: validId(c.params.seat) } })),
  });
  return { call, seen, clock };
}

describe('the version', () => {
  it('is 1', () => {
    expect(SERVICE_API_VERSION).toBe(1);
  });
});

describe('headers', () => {
  it('every response has chatwarden-api 1, cache-control no-store, nosniff and an x-request-id', async () => {
    const { call } = table();
    const responses = [
      await call('GET', '/ping'),
      await call('GET', '/ping', { key: null }),
      await call('POST', '/echo', { raw: '{nope' }),
      await call('POST', '/echo', { body: { a: 1 }, contentType: 'text/plain' }),
      await call('POST', '/boom', { body: {} }),
      await call('POST', '/echo', { raw: `{"x":"${'a'.repeat(70_000)}"}` }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 401, 400, 400, 500, 413]);
    for (const res of responses) {
      expect(res.headers?.['chatwarden-api']).toBe('1');
      expect(res.headers?.['cache-control']).toBe('no-store');
      expect(res.headers?.['x-content-type-options']).toBe('nosniff');
      expect(res.headers?.['x-request-id']).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
    }
  });

  it('a valid request id is echoed, an invalid one replaced by 16 hex characters', async () => {
    const { call } = table();
    for (const id of ['abc', 'A-Za-z0-9_.:-', 'x'.repeat(64), '1']) expect((await call('GET', '/ping', { headers: { 'x-request-id': id } })).headers?.['x-request-id']).toBe(id);
    for (const id of ['x'.repeat(65), 'has space', '', 'sl/ash', 'new\nline', 'café']) {
      const got = (await call('GET', '/ping', { headers: { 'x-request-id': id } })).headers?.['x-request-id'];
      expect(got, JSON.stringify(id)).toMatch(/^[0-9a-f]{16}$/);
    }
    const a = (await call('GET', '/ping')).headers?.['x-request-id'];
    const b = (await call('GET', '/ping')).headers?.['x-request-id'];
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  it('requestIdFor is the same rule on its own', () => {
    expect(requestIdFor('ok-id')).toBe('ok-id');
    expect(requestIdFor(undefined)).toMatch(/^[0-9a-f]{16}$/);
    expect(requestIdFor('a b')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('the error body is the flat shape with a fixed message that never echoes the input', async () => {
    const { call } = table();
    const res = await call('POST', '/echo', { raw: '{"secret-marker": nope' });
    expect(Object.keys(res.body as object).sort()).toEqual(['error', 'message']);
    expect(JSON.stringify(res.body)).not.toContain('secret-marker');
    const boom = await call('POST', '/boom', { body: {} });
    expect(boom.body).toEqual({ error: 'internal' });
  });

  it('HEAD is not supported on a route: 405 with allow naming the route method, after the headers', async () => {
    const { call } = table();
    const res = await call('HEAD', '/ping');
    expect(res.status).toBe(405);
    expect(res.headers?.allow).toBe('GET');
    expect(res.headers?.['chatwarden-api']).toBe('1');
  });
});

describe('body', () => {
  const padded = (bytes: number): string => {
    const head = '{"pad":"';
    const tail = '"}';
    return `${head}${'x'.repeat(bytes - head.length - tail.length)}${tail}`;
  };

  it('64 KiB accepted, one byte more is 413', async () => {
    const { call } = table();
    expect((await call('POST', '/echo', { raw: padded(65_536) })).status).toBe(200);
    const over = await call('POST', '/echo', { raw: padded(65_537) });
    expect(over.status).toBe(413);
    expect(errorCode(over)).toBe('payload_too_large');
  });

  it('the cap counts bytes, not characters: 21 843 three-byte characters are over the cap, 21 842 are not', async () => {
    const { call } = table();
    const body = (n: number): string => `{"t":"${'€'.repeat(n)}"}`;
    // `{"t":"` and `"}` are 8 bytes; each euro sign is 3
    expect((await call('POST', '/echo', { raw: body(21_842) })).status).toBe(200);
    expect((await call('POST', '/echo', { raw: body(21_843) })).status).toBe(413);
  });

  it('a custom maxBody applies', async () => {
    const { call } = table({ maxBody: 100 });
    expect((await call('POST', '/echo', { raw: padded(100) })).status).toBe(200);
    expect((await call('POST', '/echo', { raw: padded(101) })).status).toBe(413);
  });

  it('a non-JSON content type on POST is 400 invalid_request, a missing one too; a PUT with a body is held to it, a PUT with none is not', async () => {
    const { call } = table();
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx', 'multipart/form-data']) {
      const res = await call('POST', '/echo', { body: { a: 1 }, contentType });
      expect(res.status, contentType).toBe(400);
      expect(errorCode(res)).toBe('invalid_request');
    }
    expect((await call('POST', '/echo', { body: { a: 1 }, contentType: null })).status).toBe(400);
    expect((await call('POST', '/echo', { body: { a: 1 }, contentType: 'Application/JSON; charset=utf-8' })).status).toBe(200);
    expect((await call('PUT', '/echo', { body: { a: 1 }, contentType: 'text/plain' })).status).toBe(400);
    expect((await call('PUT', '/echo', {})).status).toBe(200);
  });

  it('a forbidden key (__proto__) is 400 forbidden_key, at depth too; invalid JSON is 400 invalid_json', async () => {
    const { call } = table();
    for (const raw of ['{"__proto__":{"x":1}}', '{"a":{"b":[{"constructor":1}]}}', '{"prototype":0}']) {
      const res = await call('POST', '/echo', { raw });
      expect(res.status, raw).toBe(400);
      expect(errorCode(res)).toBe('forbidden_key');
    }
    for (const raw of ['{nope', '[1,', 'undefined']) {
      const res = await call('POST', '/echo', { raw });
      expect(res.status, raw).toBe(400);
      expect(errorCode(res)).toBe('invalid_json');
    }
  });

  it('the parsed body reaches the handler; no body is undefined; a bad key is refused before the handler runs', async () => {
    const { call, seen } = table();
    await call('POST', '/echo', { body: { a: [1, { b: 2 }] } });
    expect(seen[0]?.body).toEqual({ a: [1, { b: 2 }] });
    await call('POST', '/echo', { headers: { 'content-type': 'application/json' } });
    expect(seen[1]?.body).toBeUndefined();
    await call('POST', '/echo', { raw: '{"__proto__":1}' });
    expect(seen).toHaveLength(2);
  });

  it('an unauthenticated oversize body is 401, never 413 (the body is not read for a stranger)', async () => {
    const { call } = table();
    expect((await call('POST', '/echo', { key: null, raw: padded(70_000) })).status).toBe(401);
  });
});

describe('ids', () => {
  it('room and seat ids of 1 and 128 characters of the set accepted', async () => {
    const { call } = table();
    const ids = ['a', 'A-Za-z0-9_.:@~-', 'room:1', 'user@host', 'a.b', 'x'.repeat(128), 'a..b', '~tilde'];
    for (const id of ids) {
      const res = await call('POST', `/rooms/${encodeURIComponent(id)}/seats/${encodeURIComponent(id)}`, { body: {} });
      expect(res.status, id).toBe(200);
      expect(res.body).toEqual({ room: id, seat: id });
    }
  });

  it('129, a space, a slash-encoded %2F, a dot-only segment, a control character and a non-ASCII id are 400', async () => {
    const { call } = table();
    for (const id of ['x'.repeat(129), 'has space', 'a%2Fb', '.', '..', '...', 'tab\tid', 'café', 'a/b', 'q?', 'semi;colon', 'star*']) {
      const res = await call('POST', `/rooms/${encodeURIComponent(id)}/seats/ok`, { body: {} });
      expect(res.status, JSON.stringify(id)).toBe(400);
      expect(errorCode(res)).toBe('invalid_request');
      const seat = await call('POST', `/rooms/ok/seats/${encodeURIComponent(id)}`, { body: {} });
      expect(seat.status, JSON.stringify(id)).toBe(400);
    }
  });

  it('an empty segment cannot match a route: 404 not_found', async () => {
    const { call } = table();
    const res = await call('POST', '/rooms//seats/x', { body: {} });
    expect(res.status).toBe(404);
  });

  it('validId on its own: the same rule, ValidationError, never echoing the value', () => {
    expect(validId('ok.id:1')).toBe('ok.id:1');
    for (const bad of ['', ' ', 'a b', '.', '..', 'x'.repeat(129), 5, null, undefined, {}]) {
      let err: unknown;
      try {
        validId(bad);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(bad)).toBeInstanceOf(ValidationError);
    }
  });
});

describe('who', () => {
  it('a who of clientKey, accountId and ip each of 1 and 256 characters is accepted, as a copy of the known fields', () => {
    const value = { clientKey: 'c', accountId: 'a'.repeat(256), ip: '203.0.113.7' };
    const who = parseWho(value);
    expect(who).toEqual(value);
    expect(who).not.toBe(value);
    expect(parseWho({ clientKey: 'k' })).toEqual({ clientKey: 'k' });
    expect(parseWho({ accountId: 'x' })).toEqual({ accountId: 'x' });
  });

  it('unknown keys, a 257-character value, a non-string, an empty string and a non-object are 400', () => {
    for (const bad of [{ clientKey: 'k', extra: 1 }, { clientKey: 'x'.repeat(257) }, { clientKey: 5 }, { accountId: '' }, { clientKey: null }, 'who', 5, null, undefined, [], [{ clientKey: 'k' }], {}]) {
      expect(() => parseWho(bad), JSON.stringify(bad)).toThrow(ValidationError);
    }
  });

  it('a who that has only ip is refused when an identity is needed, and accepted when it is not', () => {
    expect(() => parseWho({ ip: '203.0.113.7' }, { identity: true })).toThrow(ValidationError);
    expect(() => parseWho({}, { identity: true })).toThrow(ValidationError);
    expect(parseWho({ clientKey: 'k' }, { identity: true })).toEqual({ clientKey: 'k' });
    expect(parseWho({ ip: '203.0.113.7' })).toEqual({ ip: '203.0.113.7' });
  });

  it('a who with a forbidden key never reaches the object (the body parser stops it first)', async () => {
    const { call } = table();
    expect((await call('POST', '/echo', { raw: '{"who":{"__proto__":{}}}' })).status).toBe(400);
  });
});

describe('logging', () => {
  it('a spy logger sees event names, rid, kid, route pattern and status only; no key, no who, no path with ids, no body', async () => {
    const { call } = table();
    await call('GET', '/ping');
    await call('POST', '/rooms/room-secret-1/seats/seat-secret-2', { body: { who: { accountId: 'acct-secret-3' }, text: 'line-secret-4' } });
    await call('GET', '/ping', { key: null });
    await call('POST', '/boom', { body: { who: { accountId: 'acct-secret-3' } } });
    expect(logs.length).toBeGreaterThanOrEqual(4);
    const allowed = new Set(['rid', 'kid', 'route', 'status', 'ms', 'error']);
    for (const [event, detail] of logs) {
      expect(event).toMatch(/^chatwarden\.[a-z_]+$/);
      for (const key of Object.keys(detail ?? {})) expect(allowed.has(key), key).toBe(true);
    }
    const text = JSON.stringify(logs);
    for (const secret of ['room-secret-1', 'seat-secret-2', 'acct-secret-3', 'line-secret-4', KEY_A, 'secret detail', 'Bearer']) expect(text).not.toContain(secret);
    const lines = logs.filter(([e]) => e === 'chatwarden.service_request').map(([, d]) => d);
    expect(lines.map((d) => d?.route)).toContain('GET /ping');
    expect(lines.map((d) => d?.route)).toContain('POST /rooms/:room~room/seats/:seat~room');
    expect(lines.find((d) => d?.status === 401)?.kid).toBeUndefined();
    expect(String(lines[0]?.kid)).toMatch(/^[0-9a-f]{8}$/);
    expect(String(lines[0]?.rid)).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof lines[0]?.status).toBe('number');
    // an unexpected error is logged by class only
    const failure = logs.find(([e]) => e === 'chatwarden.http_error');
    expect(failure?.[1]).toEqual({ error: 'Error' });
  });

  it('no logger given: nothing is written to the console for a request line', async () => {
    const calls: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void calls.push(args);
    try {
      const { svc } = createServiceWrapper({ keys: [KEY_A] });
      const call = callerOver({ 'GET /ping': svc('GET /ping', () => ({ status: 200, body: {} })) });
      await call('GET', '/ping');
      expect(calls).toEqual([]);
    } finally {
      console.warn = original;
    }
  });
});

describe('the service folder is browser-safe', () => {
  it('service/ imports nothing from node: or from node.ts and serve.ts (a static scan)', () => {
    const dir = fileURLToPath(new URL('../src/service/', import.meta.url));
    // node.ts, serve.ts and serveStaff.ts are the process, and deliveryWebhook.ts the delivery sender (they import node: on purpose); everything else in the folder runs in a browser
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !/^(node|serve|deliveryWebhook)/.test(f));
    expect(files).toEqual(expect.arrayContaining(['contract.ts', 'auth.ts', 'idempotency.ts', 'index.ts', 'wrap.ts']));
    for (const file of files) {
      const text = readFileSync(`${dir}${file}`, 'utf8');
      expect(text, file).not.toMatch(/from\s+['"]node:/);
      expect(text, file).not.toMatch(/import\s*\(\s*['"]node:/);
      expect(text, file).not.toMatch(/from\s+['"]\.\/(?:node|serve|deliveryWebhook)[A-Za-z]*\.js['"]/);
      expect(text, file).not.toMatch(/\brequire\s*\(/);
      expect(text, file).not.toMatch(/\bBuffer\b/);
      expect(text, file).not.toMatch(/\bprocess\./);
    }
  });
});
