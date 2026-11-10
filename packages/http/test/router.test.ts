import { describe, expect, it, vi } from 'vitest';
import { createRouter } from '@chatwarden/http';
import { compileRoutes } from '../src/router.js';
import type { KitRequest, KitResponse } from '@chatwarden/http';

const req = (method: string, path: string, extra: Partial<KitRequest> = {}): KitRequest => ({
  method,
  path,
  query: {},
  headers: {},
  body: undefined,
  ...extra,
});

const ok = (body: unknown = { ok: true }): KitResponse => ({ status: 200, body });

describe('createRouter: matching', () => {
  it('dispatches by method and path, and passes the params', async () => {
    const getOne = vi.fn((_r: KitRequest, p: Record<string, string>) => ok({ id: p['id'] }));
    const list = vi.fn(() => ok({ list: true }));
    const router = createRouter({ 'GET /reports/:id': getOne, 'GET /reports': list });
    expect(await router(req('GET', '/reports/abc-123_X'))).toEqual({ status: 200, body: { id: 'abc-123_X' } });
    expect(await router(req('GET', '/reports'))).toEqual({ status: 200, body: { list: true } });
    expect(getOne).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('passes the request through unchanged', async () => {
    const seen: KitRequest[] = [];
    const router = createRouter({
      'POST /x': (r) => {
        seen.push(r);
        return ok();
      },
    });
    const r = req('POST', '/x', { query: { a: '1' }, headers: { h: 'v' }, body: { k: 1 }, rawBody: '{"k":1}' });
    await router(r);
    expect(seen[0]).toBe(r);
  });

  it('supports several params and a root route', async () => {
    const router = createRouter({
      'GET /a/:x/b/:y': (_r, p) => ok(p),
      'GET /': () => ok('root'),
    });
    expect((await router(req('GET', '/a/one/b/two'))).body).toEqual({ x: 'one', y: 'two' });
    expect((await router(req('GET', '/'))).body).toBe('root');
  });

  it('supports async handlers', async () => {
    const router = createRouter({ 'GET /a': async () => ok('later') });
    expect((await router(req('GET', '/a'))).body).toBe('later');
  });

  it('is case sensitive on the path and normalises the method case', async () => {
    const router = createRouter({ 'GET /Reports': () => ok() });
    expect((await router(req('GET', '/reports'))).status).toBe(404);
    expect((await router(req('get', '/Reports'))).status).toBe(200);
  });

  it('prefers a literal segment over a param', async () => {
    const router = createRouter({
      'GET /reports/:id': () => ok('param'),
      'GET /reports/export': () => ok('literal'),
    });
    expect((await router(req('GET', '/reports/export'))).body).toBe('literal');
    expect((await router(req('GET', '/reports/other'))).body).toBe('param');
  });

  it('breaks an equal-literal tie left to right, whatever the insertion order', async () => {
    const one = createRouter({ 'GET /a/:x/c': () => ok('x-first'), 'GET /a/b/:y': () => ok('b-first') });
    const two = createRouter({ 'GET /a/b/:y': () => ok('b-first'), 'GET /a/:x/c': () => ok('x-first') });
    expect((await one(req('GET', '/a/b/c'))).body).toBe('b-first');
    expect((await two(req('GET', '/a/b/c'))).body).toBe('b-first');
    expect((await one(req('GET', '/a/z/c'))).body).toBe('x-first');
    expect((await two(req('GET', '/a/z/c'))).body).toBe('x-first');
  });

  it('strips the query string before matching', async () => {
    const router = createRouter({ 'GET /reports/:id': (_r, p) => ok(p['id']) });
    expect((await router(req('GET', '/reports/abc?limit=5&x=/y'))).body).toBe('abc');
    expect((await router(req('GET', '/reports?limit=5'))).status).toBe(404);
  });

  it('treats a trailing slash as no match', async () => {
    const router = createRouter({ 'GET /reports': () => ok(), 'GET /reports/:id': () => ok() });
    expect((await router(req('GET', '/reports/'))).status).toBe(404);
    expect((await router(req('GET', '/reports/abc/'))).status).toBe(404);
    expect((await router(req('GET', '/reports/?x=1'))).status).toBe(404);
  });

  it('does not match empty segments or a path without a leading slash', async () => {
    const router = createRouter({ 'GET /a/:id': () => ok() });
    expect((await router(req('GET', '/a//'))).status).toBe(404);
    expect((await router(req('GET', '//a/x'))).status).toBe(404);
    expect((await router(req('GET', 'a/x'))).status).toBe(404);
    expect((await router(req('GET', ''))).status).toBe(404);
  });
});

describe('createRouter: params', () => {
  const router = createRouter({ 'GET /r/:id': (_r, p) => ok(p['id']) });
  const status = async (path: string): Promise<number> => (await router(req('GET', path))).status;

  it('accepts 1 to 64 characters of [A-Za-z0-9_-]', async () => {
    expect(await status('/r/a')).toBe(200);
    expect(await status(`/r/${'a'.repeat(64)}`)).toBe(200);
    expect(await status('/r/A-z_9')).toBe(200);
  });

  it('answers 404 for a bad param', async () => {
    expect(await status(`/r/${'a'.repeat(65)}`)).toBe(404);
    expect(await status('/r/a.b')).toBe(404);
    expect(await status('/r/a b')).toBe(404);
    expect(await status('/r/a:b')).toBe(404);
    expect(await status('/r/a;b')).toBe(404);
    expect(await status('/r/é')).toBe(404);
  });

  it('decodes the param before the check', async () => {
    expect((await router(req('GET', '/r/a%2Db'))).body).toBe('a-b');
    expect((await router(req('GET', '/r/%61bc'))).body).toBe('abc');
    expect(await status('/r/a%2Fb')).toBe(404);
    expect(await status('/r/a%20b')).toBe(404);
    expect(await status('/r/a%2e%2e')).toBe(404);
    expect(await status('/r/%2e%2e')).toBe(404);
    expect(await status(`/r/${'%61'.repeat(65)}`)).toBe(404);
  });

  it('answers 404 for a malformed encoding', async () => {
    expect(await status('/r/%')).toBe(404);
    expect(await status('/r/%zz')).toBe(404);
    expect(await status('/r/%E0%A4%A')).toBe(404);
    expect(await status('/r/%ff')).toBe(404);
  });

  it('never calls the handler for a bad param', async () => {
    const h = vi.fn(() => ok());
    const r = createRouter({ 'GET /r/:id': h });
    await r(req('GET', '/r/a%2Fb'));
    await r(req('GET', '/r/%'));
    await r(req('POST', '/r/%'));
    expect(h).not.toHaveBeenCalled();
  });

  it('answers 404, not 405, for a bad param on another method', async () => {
    expect(await status('/r/a.b')).toBe(404);
    const res = await router(req('DELETE', '/r/a.b'));
    expect(res.status).toBe(404);
    expect(res.headers?.['allow']).toBeUndefined();
  });
});

describe('createRouter: 404 and 405', () => {
  const router = createRouter({
    'GET /things': () => ok(),
    'POST /things': () => ok(),
    'GET /things/:id': () => ok(),
    'DELETE /things/:id': () => ok(),
  });

  it('answers 404 with a fixed body for no match', async () => {
    const res = await router(req('GET', '/nothing/here'));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it('answers 405 with an allow header for the wrong method', async () => {
    const res = await router(req('PUT', '/things'));
    expect(res.status).toBe(405);
    expect(res.headers).toEqual({ allow: 'GET, HEAD, POST' });
    expect(res.body).toEqual({ error: 'method_not_allowed', message: 'Method not allowed.' });
    const res2 = await router(req('POST', '/things/abc'));
    expect(res2.status).toBe(405);
    expect(res2.headers).toEqual({ allow: 'DELETE, GET, HEAD' });
  });

  it('does not echo the path or method', async () => {
    const res = await router(req('PATCH', '/things/secret-id'));
    expect(JSON.stringify(res)).not.toContain('secret-id');
    expect(JSON.stringify(res)).not.toContain('PATCH');
    const res2 = await router(req('GET', '/leak-me'));
    expect(JSON.stringify(res2)).not.toContain('leak-me');
  });

  it('does not run any handler on 404 or 405', async () => {
    const h = vi.fn(() => ok());
    const r = createRouter({ 'GET /a': h });
    await r(req('POST', '/a'));
    await r(req('GET', '/b'));
    expect(h).not.toHaveBeenCalled();
  });
});

describe('createRouter: HEAD', () => {
  it('runs the GET handler and returns the GET response (an adapter drops the body on the wire)', async () => {
    const h = vi.fn((r: KitRequest) => (void r, { status: 201, headers: { 'x-a': '1', 'cache-control': 'no-store' }, body: { big: 'payload' } }));
    const router = createRouter({ 'GET /things/:id': h });
    const res = await router(req('HEAD', '/things/abc'));
    expect(res.status).toBe(201);
    expect(res.headers).toEqual({ 'x-a': '1', 'cache-control': 'no-store' });
    // The GET answer, whole: an adapter sends its headers (and the length of this body) but never the body itself.
    expect(res.body).toEqual({ big: 'payload' });
    expect(h).toHaveBeenCalledTimes(1);
    expect(h.mock.calls[0]?.[0].method).toBe('HEAD');
  });

  it('passes the params, the query and the headers to the GET handler', async () => {
    const seen: Array<[Record<string, string>, KitRequest]> = [];
    const router = createRouter({ 'GET /a/:id': (r, p) => (seen.push([p, r]), ok()) });
    await router(req('HEAD', '/a/xyz', { query: { q: '1' }, headers: { h: 'v' } }));
    expect(seen[0]?.[0]).toEqual({ id: 'xyz' });
    expect(seen[0]?.[1].query).toEqual({ q: '1' });
  });

  it('a GET error response keeps its status (a handler 404 stays 404) and its body', async () => {
    const router = createRouter({ 'GET /a': () => ({ status: 404, body: { error: 'not_found' } }) });
    const res = await router(req('HEAD', '/a'));
    expect([res.status, res.body]).toEqual([404, { error: 'not_found' }]);
  });

  it('an explicit HEAD route wins over the GET fallback', async () => {
    const get = vi.fn(() => ok());
    const head = vi.fn(() => ({ status: 204, body: undefined }));
    const router = createRouter({ 'GET /a': get, 'HEAD /a': head });
    expect((await router(req('HEAD', '/a'))).status).toBe(204);
    expect(get).not.toHaveBeenCalled();
    expect(head).toHaveBeenCalledTimes(1);
  });

  it('a path with only other methods is 405, and a HEAD does not run their handlers', async () => {
    const post = vi.fn(() => ok());
    const router = createRouter({ 'POST /only': post });
    const res = await router(req('HEAD', '/only'));
    expect(res.status).toBe(405);
    expect(res.headers).toEqual({ allow: 'POST' });
    expect(post).not.toHaveBeenCalled();
  });

  it('an unknown path is 404 for HEAD, and a bad param is 404 not 405', async () => {
    const router = createRouter({ 'GET /a/:id': () => ok() });
    expect((await router(req('HEAD', '/b'))).status).toBe(404);
    expect((await router(req('HEAD', '/a/bad id'))).status).toBe(404);
  });

  it('the method is case-insensitive, and allow lists HEAD only beside GET', async () => {
    const router = createRouter({ 'GET /g': () => ok(), 'POST /p': () => ok() });
    expect((await router(req('head', '/g'))).status).toBe(200);
    expect((await router(req('DELETE', '/g'))).headers).toEqual({ allow: 'GET, HEAD' });
    expect((await router(req('DELETE', '/p'))).headers).toEqual({ allow: 'POST' });
  });

  it('a literal GET route beats a param route on HEAD, as it does on GET', async () => {
    const lit = vi.fn(() => ok({ lit: true }));
    const par = vi.fn(() => ok({ par: true }));
    const router = createRouter({ 'GET /r/export': lit, 'GET /r/:id': par });
    await router(req('HEAD', '/r/export'));
    expect(lit).toHaveBeenCalledTimes(1);
    expect(par).not.toHaveBeenCalled();
  });

  it('handler errors propagate as on GET', async () => {
    const router = createRouter({ 'GET /x': () => { throw new Error('boom'); } });
    await expect(router(req('HEAD', '/x'))).rejects.toThrow('boom');
  });
});

describe('createRouter: route table validation', () => {
  const h = (): KitResponse => ok();

  it('rejects a malformed route key', () => {
    expect(() => createRouter({ 'GET reports': h })).toThrow(RangeError);
    expect(() => createRouter({ '/reports': h })).toThrow(RangeError);
    expect(() => createRouter({ 'get /reports': h })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /reports/': h })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /a//b': h })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /a/:': h })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /a/:b-c': h })).toThrow(RangeError);
  });

  it('rejects two routes that are the same shape for one method', () => {
    expect(() => createRouter({ 'GET /a/:x': h, 'GET /a/:y': h })).toThrow(RangeError);
  });

  it('rejects a duplicate param name in one route', () => {
    expect(() => createRouter({ 'GET /a/:id/b/:id': h })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /:x/:x': h })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /a/:x/b/:y': h })).not.toThrow();
  });

  it('rejects "." and ".." literal segments', () => {
    expect(() => createRouter({ 'GET /a/./b': h })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /a/../b': h })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /..': h })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /.': h })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /a/.b/..c/d.e': h })).not.toThrow();
  });

  it('rejects any two routes of one method with an identical shape, whatever the param names', () => {
    expect(() => createRouter({ 'GET /a/:x/c': h, 'GET /a/:y/c': h })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /:a/:b': h, 'GET /:c/:d': h })).toThrow(RangeError);
    // Different shapes are fine, in either order.
    expect(() => createRouter({ 'GET /a/:x/c': h, 'GET /a/b/:y': h })).not.toThrow();
    expect(() => createRouter({ 'GET /a/:x': h, 'GET /a/b': h })).not.toThrow();
  });

  it('allows the same path under different methods', () => {
    expect(() => createRouter({ 'GET /a/:x': h, 'POST /a/:y': h })).not.toThrow();
  });
});

describe('createRouter: the `~ref` param pattern', () => {
  const echo = (_r: KitRequest, p: Record<string, string>): KitResponse => ok({ id: p['id'] });
  const router = createRouter({ 'GET /rows/:id~ref': echo, 'GET /plain/:id': echo });

  it('accepts the audit-ref charset (A-Z a-z 0-9 _ . : -), raw or percent-encoded, decoded before the check', async () => {
    for (const [raw, id] of [
      ['syn:zorbak', 'syn:zorbak'],
      ['syn-ex:tarvo-lake', 'syn-ex:tarvo-lake'],
      ['syn%3Azorbak', 'syn:zorbak'],
      ['syn%3azorbak', 'syn:zorbak'],
      ['a.b', 'a.b'],
      ['.a', '.a'],
      ['a..', 'a..'],
      ['x'.repeat(64), 'x'.repeat(64)],
      ['Abc_1-2', 'Abc_1-2'],
    ] as const) {
      expect(await router(req('GET', `/rows/${raw}`)), raw).toEqual({ status: 200, body: { id } });
    }
  });

  it('still rejects "." ".." and every all-dot value, encoded or not', async () => {
    for (const bad of ['.', '..', '...', '%2E', '%2E%2E', '%2e%2e%2e']) {
      expect((await router(req('GET', `/rows/${bad}`))).status, bad).toBe(404);
    }
  });

  it('rejects anything outside the charset or longer than 64', async () => {
    for (const bad of ['a%2Fb', 'a%20b', 'a b', 'a%00b', 'a%0Ab', 'a%25b', 'a;b', 'a@b', 'a%E2%82%ACb', '%ZZ', 'x'.repeat(65)]) {
      expect((await router(req('GET', `/rows/${bad}`))).status, bad).toBe(404);
    }
  });

  it('leaves the default pattern alone: other routes still reject ":" and dots', async () => {
    expect((await router(req('GET', '/plain/ok_1-2'))).status).toBe(200);
    for (const bad of ['a:b', 'a%3Ab', 'a.b', '.', '..']) {
      expect((await router(req('GET', `/plain/${bad}`))).status, bad).toBe(404);
    }
  });

  it('an unknown pattern name, or a bare "~", is a bad route', () => {
    expect(() => createRouter({ 'GET /rows/:id~nope': () => ok() })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /rows/:id~': () => ok() })).toThrow(RangeError);
    expect(() => createRouter({ 'GET /rows/:id~ref~ref': () => ok() })).toThrow(RangeError);
    // Names that exist on Object.prototype are not patterns.
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype']) {
      expect(() => createRouter({ [`GET /rows/:x~${name}`]: () => ok() }), name).toThrow(RangeError);
    }
  });

  it('a `~ref` route and a plain route of one shape collide', () => {
    expect(() => createRouter({ 'GET /rows/:id~ref': () => ok(), 'GET /rows/:other': () => ok() })).toThrow(RangeError);
  });
});

describe('compileRoutes: "no route matched" is not a handler 404', () => {
  const table = {
    'GET /reports/:id': () => ok({ got: true }),
    'POST /reports/:id/decide': () => ok({ decided: true }),
    'GET /missing': () => ({ status: 404, body: { error: 'not_found' } }),
  };

  it('matches a path that some route answers, under any method, ignoring the query string', () => {
    const { matches } = compileRoutes(table);
    expect(matches('/reports/abc')).toBe(true);
    expect(matches('/reports/abc?x=1')).toBe(true);
    expect(matches('/reports/abc/decide')).toBe(true);
    expect(matches('/missing')).toBe(true);
  });

  it.each([
    ['an unknown path', '/nothing'],
    ['a longer path', '/reports/abc/decide/more'],
    ['the root', '/'],
    ['a param that fails its pattern', '/reports/a%20b'],
    ['a malformed escape', '/reports/%E0%A4%A'],
    ['an empty segment', '/reports//decide'],
    ['a trailing slash', '/reports/abc/'],
    ['no leading slash', 'reports/abc'],
  ])('does not match %s', (_n, path) => {
    expect(compileRoutes(table).matches(path)).toBe(false);
  });

  it('a path that matches under another method still matches, and run answers 405 with allow', async () => {
    const { matches, run } = compileRoutes(table);
    expect(matches('/reports/abc')).toBe(true);
    const res = await run(req('DELETE', '/reports/abc'));
    expect(res.status).toBe(405);
    expect(res.headers?.allow).toBe('GET, HEAD');
  });

  it('with a method, OPTIONS belongs to the table only when a route of its own answers it', () => {
    const { matches } = compileRoutes(table);
    expect(matches('/reports/abc', 'OPTIONS')).toBe(false);
    expect(matches('/reports/abc', 'options')).toBe(false);
    expect(matches('/reports/abc/decide', 'OPTIONS')).toBe(false);
    expect(matches('/nothing', 'OPTIONS')).toBe(false);
    // Every other method keeps the old answer, and no method is the old answer too.
    for (const method of ['GET', 'POST', 'DELETE', 'HEAD', 'PUT']) expect(matches('/reports/abc', method), method).toBe(true);
    expect(matches('/reports/abc')).toBe(true);
    const own = compileRoutes({ ...table, 'OPTIONS /reports/:id': () => ok({ preflight: true }) });
    expect(own.matches('/reports/abc', 'OPTIONS')).toBe(true);
    expect(own.matches('/reports/abc/decide', 'OPTIONS')).toBe(false);
  });

  it('a handler that answers 404 is a match: run returns its response', async () => {
    const { matches, run } = compileRoutes(table);
    expect(matches('/missing')).toBe(true);
    expect(await run(req('GET', '/missing'))).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('run on an unmatched path is still the kit 404, and createRouter is unchanged', async () => {
    const { run } = compileRoutes(table);
    expect((await run(req('GET', '/nothing'))).body).toEqual({ error: 'not_found', message: 'Not found.' });
    expect(await createRouter(table)(req('GET', '/nothing'))).toEqual(await run(req('GET', '/nothing')));
  });

  it('validates the table like createRouter does', () => {
    expect(() => compileRoutes({ 'nope': () => ok() })).toThrow(RangeError);
  });
});
