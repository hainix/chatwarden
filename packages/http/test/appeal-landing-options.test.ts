import { describe, expect, it } from 'vitest';
import type { Chatwarden } from '@chatwarden/core';
import { appealLandingRoutes, createRouter, playerRoutes } from '@chatwarden/http';
import { APPEAL_LANDING_READ_LIMIT, APPEAL_LANDING_WRITE_LIMIT } from '../src/appealLanding.js';
import { errorOf, identifyFromHeaders } from './playerWorld.js';
import { htmlOf, landingWorld, locationOf } from './landingWorld.js';

// The options of the landing routes, the limits' defaults, and the failure path: a failure inside is logged by class only and answered like the route's other failures.

describe('appealLandingRoutes on its own', () => {
  it('is a route table of exactly the four landing routes, usable without the player routes', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const routes = appealLandingRoutes(w.cw, { now: () => w.clock.t });
    expect(Object.keys(routes).sort()).toEqual(['GET /appeal', 'GET /appeal/case', 'OPTIONS /appeal/case', 'POST /appeal/case']);
    const router = createRouter(routes);
    const res = await router({ method: 'GET', path: '/appeal/case', query: { t: s.token }, headers: {}, body: undefined });
    expect(res.status).toBe(200);
  });

  it('the default limits are 60 reads and 10 writes an hour', () => {
    expect(APPEAL_LANDING_READ_LIMIT).toEqual({ max: 60, windowMs: 3_600_000 });
    expect(APPEAL_LANDING_WRITE_LIMIT).toEqual({ max: 10, windowMs: 3_600_000 });
  });

  it('a bad limit is a RangeError that names the option and not the value', async () => {
    const w = await landingWorld();
    for (const bad of [{ max: 0, windowMs: 1000 }, { max: 1.5, windowMs: 1000 }, { max: 5 }, null, 'secret-limit-value']) {
      for (const key of ['readRateLimit', 'appealsRateLimit'] as const) {
        let message = '';
        try {
          appealLandingRoutes(w.cw, { [key]: bad } as never);
        } catch (err) {
          expect(err).toBeInstanceOf(RangeError);
          message = (err as Error).message;
        }
        expect(message, `${key} ${JSON.stringify(bad)}`).toContain(key);
        expect(message).not.toContain('secret-limit-value');
      }
    }
  });

  it('playerRoutes takes landingReadRateLimit and checks it, and its appealsRateLimit also limits the landing writes', async () => {
    const w = await landingWorld();
    expect(() => playerRoutes(w.cw, { identify: identifyFromHeaders, landingReadRateLimit: { max: 0, windowMs: 1 } })).toThrow(RangeError);
    const limited = await landingWorld({ routeOptions: { appealsRateLimit: { max: 2, windowMs: 60_000 } } });
    const s = await limited.sanctioned();
    expect((await limited.postJson({ t: s.token, statement: '' })).status).toBe(400);
    expect((await limited.postJson({ t: s.token, statement: '' })).status).toBe(400);
    expect((await limited.postJson({ t: s.token, statement: '' })).status).toBe(429);
  });
});

describe('a failure inside is logged by class and never by content', () => {
  async function broken() {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const real = w.cw;
    const boom = (): never => {
      throw new TypeError(`boom for ${s.token} and a statement`);
    };
    const wrapped = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'appeals') return new Proxy(target.appeals, { get: (a, p, r) => (p === 'caseByLink' || p === 'fileByLink' ? boom : Reflect.get(a, p, r)) });
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Chatwarden;
    const router = createRouter(appealLandingRoutes(wrapped, { logger: { warn: (event, detail) => void w.logged.push([event, detail]) }, now: () => w.clock.t }));
    const call = (method: string, path: string, o: { query?: Record<string, string>; raw?: string; type?: string } = {}) =>
      router({ method, path, query: o.query ?? {}, headers: o.type === undefined ? {} : { 'content-type': o.type }, body: undefined, ...(o.raw === undefined ? {} : { rawBody: o.raw }) });
    return { w, s, call };
  }

  it('GET answers like an invalid link (404), POST json answers 500 internal, the form answers 303 e=failed; one log line each, the class only', async () => {
    const { w, s, call } = await broken();
    const page = await call('GET', '/appeal', { query: { t: s.token } });
    expect(page.status).toBe(404);
    expect(htmlOf(page)).toContain('This link is no longer valid.');
    const json = await call('GET', '/appeal/case', { query: { t: s.token } });
    expect(json.status).toBe(404);
    expect(errorOf(json)).toBe('not_found');
    const post = await call('POST', '/appeal/case', { raw: JSON.stringify({ t: s.token, statement: 'a statement' }), type: 'application/json' });
    expect(post.status).toBe(500);
    expect(post.body).toEqual({ error: 'internal' });
    const form = await call('POST', '/appeal/case', { raw: new URLSearchParams({ t: s.token, statement: 'a statement' }).toString(), type: 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(303);
    expect(locationOf(form)).toBe(`../appeal?t=${s.token}&lang=en&e=failed`);
    expect(w.logged.filter(([event]) => event === 'chatwarden.landing_failed')).toEqual([
      ['chatwarden.landing_failed', { error: 'TypeError' }],
      ['chatwarden.landing_failed', { error: 'TypeError' }],
      ['chatwarden.landing_failed', { error: 'TypeError' }],
      ['chatwarden.landing_failed', { error: 'TypeError' }],
    ]);
    const text = JSON.stringify(w.logged) + JSON.stringify([page, json, post]);
    expect(text).not.toContain('boom for');
    expect(JSON.stringify(w.logged)).not.toContain(s.token);
    expect(JSON.stringify(w.logged)).not.toContain('a statement');
  });
});
