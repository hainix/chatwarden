import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden, Logger, RawWho } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { createRouter, healthRoutes } from '@chatwarden/http';
import type { KitResponse } from '@chatwarden/http';

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

async function setup(wrap?: (cw: Chatwarden) => Chatwarden) {
  const store = openStore({ db: new DatabaseSync(':memory:') });
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const cw = await createChatwarden({
    store,
    secret: 'health-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    logger,
    retention: false,
  });
  logged.length = 0; // start-up notes (no matcher and so on) are not what these tests are about
  const used = wrap === undefined ? cw : wrap(cw);
  const router = createRouter(healthRoutes(used, { logger }));
  const call = (method: string, path: string): Promise<KitResponse> =>
    router({ method, path, query: {}, headers: {}, body: undefined });
  return { cw, store, logged, call, router };
}

/** A kit whose every member throws when touched: proves a route never reaches into it. */
const untouchable = (allow: string[] = []): ((cw: Chatwarden) => Chatwarden) => (cw) =>
  new Proxy(cw, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && allow.includes(prop)) return Reflect.get(target, prop, receiver) as unknown;
      throw new Error(`touched ${String(prop)}`);
    },
  });

describe('healthRoutes', () => {
  it('has exactly /healthz and /readyz', async () => {
    const { router } = await setup();
    expect(Object.keys(healthRoutes((await setup()).cw)).sort()).toEqual(['GET /healthz', 'GET /readyz']);
    expect((await router({ method: 'GET', path: '/', query: {}, headers: {}, body: undefined })).status).toBe(404);
  });

  it('/healthz is 200 {ok:true} and never touches the kit or the store', async () => {
    const { call } = await setup(untouchable());
    const res = await call('GET', '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('/healthz stays 200 while the store is closed or broken', async () => {
    const { call, store } = await setup();
    store.close();
    expect((await call('GET', '/healthz')).body).toEqual({ ok: true });
  });

  it('/readyz is 200 {ok:true} when the store answers schemaVersion()', async () => {
    const { call, logged } = await setup();
    const res = await call('GET', '/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(logged).toEqual([]);
  });

  it('/readyz asks only the readiness question of the kit', async () => {
    const { call } = await setup(untouchable(['ready']));
    expect((await call('GET', '/readyz')).status).toBe(200);
  });

  it('/readyz is 503 {ok:false} with no detail when schemaVersion() throws, and logs the class only', async () => {
    const { call, store, logged } = await setup();
    vi.spyOn(store, 'schemaVersion').mockImplementation(() => {
      throw new TypeError('db at /var/lib/secret/203.0.113.7 is on fire');
    });
    const res = await call('GET', '/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toStrictEqual({ ok: false });
    expect(JSON.stringify(res)).not.toMatch(/fire|secret|203/);
    expect(logged).toEqual([['chatwarden.ready_failed', { error: 'TypeError' }]]);
    expect(JSON.stringify(logged)).not.toMatch(/fire|secret|203/);
  });

  it('/readyz is 503 once the store is closed, and 200 again for a healthy one (control)', async () => {
    const down = await setup();
    down.store.close();
    expect((await down.call('GET', '/readyz')).status).toBe(503);
    const up = await setup();
    expect((await up.call('GET', '/readyz')).status).toBe(200);
  });

  it('cw.close() then ready() is false on the SQLite store, and /readyz is 503 (healthz stays 200)', async () => {
    const { cw, call, logged } = await setup();
    expect(cw.ready()).toBe(true);
    await cw.close();
    expect(cw.ready()).toBe(false);
    expect(logged.at(-1)).toEqual(['chatwarden.ready_failed', { error: 'Error' }]);
    expect(await call('GET', '/readyz')).toMatchObject({ status: 503, body: { ok: false } });
    expect((await call('GET', '/healthz')).status).toBe(200);
  });

  it('/readyz is 503 even if cw.ready() itself throws, logging the class only', async () => {
    const { call, logged } = await setup((cw) => ({
      ...cw,
      ready: () => {
        throw new RangeError('detail 198.51.100.4');
      },
    }));
    const res = await call('GET', '/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toStrictEqual({ ok: false });
    expect(logged).toEqual([['chatwarden.http_ready_failed', { error: 'RangeError' }]]);
  });

  it('/readyz is 503 when cw.ready() returns something other than true', async () => {
    const { call } = await setup((cw) => ({ ...cw, ready: (() => 'yes') as unknown as () => boolean }));
    expect((await call('GET', '/readyz')).status).toBe(503);
  });

  it('answers only GET (405 with allow) and sends no-store', async () => {
    const { call } = await setup();
    for (const path of ['/healthz', '/readyz']) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await call(method, path);
        expect(res.status).toBe(405);
        expect(res.headers?.allow).toBe('GET');
      }
      expect((await call('GET', path)).headers?.['cache-control']).toBe('no-store');
    }
  });

  it('is public: needs no credentials of any kind', async () => {
    const { router } = await setup();
    const res = await router({ method: 'GET', path: '/readyz', query: {}, headers: {}, body: undefined });
    expect(res.status).toBe(200);
  });
});
