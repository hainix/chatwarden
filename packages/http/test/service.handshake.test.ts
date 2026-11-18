import { describe, expect, it } from 'vitest';
import { SERVICE_API_VERSION, serviceRoutes } from '../src/service/index.js';
import { VERSION } from '../src/version.js';
import { toFetch } from '../src/fetch.js';
import { chatWorld } from './chat-world.js';
import { KEY_A, KEY_B, bodyOf, callerOver, errorCode } from './serviceKit.js';

// S1: GET /v1, the handshake, and the unknown paths under the mount.

async function setup(over: Parameters<typeof serviceRoutes>[1] extends infer O ? Partial<O> : never = {}, world: Parameters<typeof chatWorld>[0] = {}) {
  const w = await chatWorld({ noBroadcaster: true, ...world });
  const routes = serviceRoutes(w.cw, { keys: [KEY_A], logger: { warn: () => undefined }, now: w.clock.now, ...over } as never);
  return { w, routes, call: callerOver(routes) };
}

describe('handshake', () => {
  it('GET /v1 answers api, kit, mode, processes, capabilities and warnings', async () => {
    const { call } = await setup();
    const res = await call('GET', '/');
    expect(res.status).toBe(200);
    expect(bodyOf(res)).toEqual({
      api: 1,
      kit: VERSION,
      mode: 'service',
      processes: 'single',
      capabilities: { phrases: false, blocks: true, contexts: [], sharedPacing: false, matchModes: ['word', 'segment', 'contains'] },
      warnings: [],
    });
    expect(SERVICE_API_VERSION).toBe(1);
  });

  it('warnings come from the option, as given; capabilities and processes follow the options', async () => {
    const { call } = await setup({ warnings: () => ['synthetic_terms', 'pacing_per_process'], capabilities: { sharedPacing: true }, processes: 'multiple' });
    const body = bodyOf(await call('GET', '/'));
    expect(body.warnings).toEqual(['synthetic_terms', 'pacing_per_process']);
    expect(body.capabilities.sharedPacing).toBe(true);
    expect(body.processes).toBe('multiple');
  });

  it('warnings are read at each request (a function), and a kit with contexts lists their names', async () => {
    let list: string[] = [];
    const { call } = await setup({ warnings: () => list }, { contexts: { kids: { label: 'Kids' }, ranked: {} } });
    expect(bodyOf(await call('GET', '/')).warnings).toEqual([]);
    list = ['synthetic_terms'];
    const body = bodyOf(await call('GET', '/'));
    expect(body.warnings).toEqual(['synthetic_terms']);
    expect([...body.capabilities.contexts].sort()).toEqual(['kids', 'ranked']);
  });

  it('a request that carries x-forwarded-proto: http adds the plain_http warning for that answer only', async () => {
    const { call } = await setup({ warnings: () => ['synthetic_terms'] });
    const plain = bodyOf(await call('GET', '/', { headers: { 'x-forwarded-proto': 'http' } }));
    expect(plain.warnings).toEqual(['synthetic_terms', 'plain_http']);
    expect(bodyOf(await call('GET', '/', { headers: { 'x-forwarded-proto': 'HTTP' } })).warnings).toContain('plain_http');
    expect(bodyOf(await call('GET', '/', { headers: { 'x-forwarded-proto': 'https' } })).warnings).toEqual(['synthetic_terms']);
    expect(bodyOf(await call('GET', '/')).warnings).toEqual(['synthetic_terms']);
  });

  it('a warnings option that is not a function, or that throws, or returns the wrong thing is a RangeError at start, or an empty list and a log line at the request', async () => {
    const w = await chatWorld({ noBroadcaster: true });
    expect(() => serviceRoutes(w.cw, { keys: [KEY_A], warnings: 'x' as never })).toThrow(TypeError);
    const { call } = await setup({
      warnings: () => {
        throw new Error('hook secret');
      },
    });
    const res = await call('GET', '/');
    expect(res.status).toBe(200);
    expect(bodyOf(res).warnings).toEqual([]);
    const odd = await setup({ warnings: () => [1, 'ok', { a: 1 }] as never });
    expect(bodyOf(await odd.call('GET', '/')).warnings).toEqual(['ok']);
  });

  it('the answer needs the key', async () => {
    const { call } = await setup();
    const res = await call('GET', '/', { key: null });
    expect(res.status).toBe(401);
    expect(res.headers?.['www-authenticate']).toBe('Bearer');
    expect((await call('GET', '/', { key: KEY_B })).status).toBe(401);
  });

  it('the answer holds no key, digest or kid', async () => {
    const { call } = await setup();
    const text = JSON.stringify((await call('GET', '/')).body);
    expect(text).not.toContain(KEY_A);
    expect(text).not.toMatch(/kid|digest/i);
  });
});

describe('under the mount', () => {
  it('unknown paths are 404 not_found, wrong methods are 405 with allow', async () => {
    const { call } = await setup();
    const missing = await call('GET', '/nowhere');
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe('not_found');
    const wrong = await call('POST', '/', { body: {} });
    expect(wrong.status).toBe(405);
    expect(wrong.headers?.allow).toContain('GET');
  });

  it('the table has the handshake at the root of the mount, and serviceRoutes validates its options', async () => {
    const { routes, w } = await setup();
    expect(Object.keys(routes)).toContain('GET /');
    for (const bad of [undefined, null, {}, { keys: [] }, { keys: 'x' }, { keys: [KEY_A], maxBody: 0 }, { keys: [KEY_A], maxBody: 1.5 }, { keys: [KEY_A], now: 5 }, { keys: [KEY_A], processes: 'many' }]) {
      expect(() => serviceRoutes(w.cw, bad as never), JSON.stringify(bad)).toThrow();
    }
    expect(() => serviceRoutes(undefined as never, { keys: [KEY_A] })).toThrow(TypeError);
  });

  it('mounted at /v1 over toFetch: the handshake and the headers, an unknown /v1 path is a JSON 404, a path outside is the mount owner\'s', async () => {
    const { routes } = await setup();
    const handle = toFetch({ '/v1': routes });
    const res = await handle(new Request('http://svc.test/v1', { headers: { authorization: `Bearer ${KEY_A}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('chatwarden-api')).toBe('1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { api: number }).api).toBe(1);
    const missing = await handle(new Request('http://svc.test/v1/nowhere', { headers: { authorization: `Bearer ${KEY_A}` } }));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe('not_found');
  });
});
