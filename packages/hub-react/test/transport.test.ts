import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter } from '@chatwarden/http/admin';
import type { KitRequest, KitResponse } from '@chatwarden/http/admin';
import { fetchTransport, routerTransport } from '../src/transport.js';
import { hubWorld } from './world.js';

describe('routerTransport', () => {
  const echo = (res: Partial<KitResponse> = {}) => {
    const seen: KitRequest[] = [];
    const handle = (req: KitRequest): Promise<KitResponse> => {
      seen.push(req);
      return Promise.resolve({ status: 200, body: { ok: true }, ...res });
    };
    return { seen, handle };
  };

  it('builds a KitRequest: method, path, string query without the undefined ones, no body', async () => {
    const { seen, handle } = echo();
    await routerTransport(handle)({ method: 'GET', path: '/reports', query: { status: 'open', limit: 50, cursor: undefined } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/reports', query: { status: 'open', limit: '50' }, headers: {} });
    expect(seen[0]?.query).not.toHaveProperty('cursor');
    expect(seen[0]?.body).toBeUndefined();
    expect(seen[0]).not.toHaveProperty('rawBody');
  });

  it('sends a body as rawBody, JSON text exactly as JSON.stringify gives it, and leaves body unset', async () => {
    const { seen, handle } = echo();
    const body = { verdict: 'upheld', reason: 'two lines', actions: [] as unknown[], note: null };
    await routerTransport(handle)({ method: 'POST', path: '/reports/x/decide', body });
    expect(seen[0]?.rawBody).toBe(JSON.stringify(body));
    expect(seen[0]?.body).toBeUndefined();
    expect(seen[0]?.query).toEqual({});
  });

  it('sends a falsy body (false, 0, empty string, null) as a body, not as none', async () => {
    const { seen, handle } = echo();
    const t = routerTransport(handle);
    for (const body of [false, 0, '', null]) await t({ method: 'POST', path: '/x', body });
    expect(seen.map((r) => r.rawBody)).toEqual(['false', '0', '""', 'null']);
  });

  it('adds fixed headers to every request', async () => {
    const { seen, handle } = echo();
    await routerTransport(handle, { headers: { 'x-session': 'abc' } })({ method: 'GET', path: '/me' });
    expect(seen[0]?.headers).toEqual({ 'x-session': 'abc' });
  });

  it('returns the status, lower-case headers and a JSON body', async () => {
    const { handle } = echo({ status: 201, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3' }, body: { a: [1, { b: null }] } });
    const res = await routerTransport(handle)({ method: 'GET', path: '/x' });
    expect(res.status).toBe(201);
    expect(res.headers).toEqual({ 'cache-control': 'no-store', 'retry-after': '3' });
    expect(res.body).toEqual({ a: [1, { b: null }] });
  });

  it('hands over a copy that went through JSON, as a fetch would (undefined dropped, no shared objects)', async () => {
    const shared = { n: 1, gone: undefined as number | undefined };
    const { handle } = echo({ body: shared });
    const res = await routerTransport(handle)({ method: 'GET', path: '/x' });
    expect(res.body).toEqual({ n: 1 });
    expect(res.body).not.toBe(shared);
    expect(Object.keys(res.body as object)).toEqual(['n']);
  });

  it('passes a string body through untouched (a policy document)', async () => {
    const { handle } = echo({ status: 200, body: '# Heading\n\ntext "quoted"' });
    const res = await routerTransport(handle)({ method: 'GET', path: '/x' });
    expect(res.body).toBe('# Heading\n\ntext "quoted"');
  });

  it('returns an error status as a response, never a throw', async () => {
    const { handle } = echo({ status: 404, body: { error: 'not_found', message: 'Not found.' } });
    const res = await routerTransport(handle)({ method: 'GET', path: '/x' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it('treats a missing body as null', async () => {
    const { handle } = echo({ body: undefined });
    const res = await routerTransport(handle)({ method: 'GET', path: '/x' });
    expect(res.body).toBeNull();
  });

  it('rejects when the handler throws (the caller maps that to a network error)', async () => {
    const t = routerTransport(() => Promise.reject(new Error('boom')));
    await expect(t({ method: 'GET', path: '/x' })).rejects.toThrow('boom');
  });

  it('runs the real routes: GET /me, a POST with a body, a 404 and a 405', async () => {
    const w = await hubWorld({ role: 'senior' });
    const t = routerTransport(w.handle);
    const me = await t({ method: 'GET', path: '/me' });
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.body).toMatchObject({ actor: 'ann@example.test', role: 'senior' });
    const bad = await t({ method: 'POST', path: '/terms/check', body: { term: 'x', language: 'en' } });
    expect(bad.status).toBeLessThan(500);
    const gone = await t({ method: 'GET', path: '/reports/does-not-exist' });
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ error: 'not_found' });
    const wrong = await t({ method: 'DELETE', path: '/me' });
    expect(wrong.status).toBe(405);
  });
});

// ---- fetchTransport against a real HTTP server running the real routes ----

let server: Server | null = null;
afterEach(async () => {
  if (server !== null) await new Promise((resolve) => server?.close(resolve));
  server = null;
});

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

async function serve(prefix = '/admin') {
  const w = await hubWorld({ role: 'owner' });
  const router = createRouter(w.routes);
  const log: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];
  server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      log.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      const out = await router({
        method: req.method ?? 'GET',
        path: url.pathname.slice(prefix.length),
        query,
        headers: {},
        body: undefined,
        ...(raw === '' ? {} : { rawBody: raw }),
      });
      const isText = typeof out.body === 'string';
      res.writeHead(out.status, {
        'content-type': isText ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
        ...(out.headers ?? {}),
      });
      res.end(isText ? (out.body as string) : JSON.stringify(out.body));
    })();
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { w, log, base: `http://127.0.0.1:${port}${prefix}` };
}

describe('fetchTransport', () => {
  it('reads JSON from the real routes: status, headers and body', async () => {
    const { base } = await serve();
    const t = fetchTransport({ baseUrl: base });
    const res = await t({ method: 'GET', path: '/me' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as { role: string }).role).toBe('owner');
  });

  it('puts the query in the URL, drops undefined values and encodes the rest', async () => {
    const { base, log } = await serve();
    const t = fetchTransport({ baseUrl: base });
    await t({ method: 'GET', path: '/reports', query: { status: 'open', limit: 5, cursor: undefined } });
    await t({ method: 'GET', path: '/audit', query: { actor: 'a b&c=d' } });
    expect(log[0]?.url).toBe('/admin/reports?status=open&limit=5');
    expect(log[1]?.url).toBe('/admin/audit?actor=a+b%26c%3Dd');
  });

  it('tolerates a trailing slash on baseUrl and a path with no leading slash problems', async () => {
    const { base, log } = await serve();
    await fetchTransport({ baseUrl: `${base}/` })({ method: 'GET', path: '/me' });
    expect(log[0]?.url).toBe('/admin/me');
  });

  it('sends a JSON body with a content-type and the accept header, and the extra headers', async () => {
    const { base, log } = await serve();
    const t = fetchTransport({ baseUrl: base, headers: { 'x-csrf': 'tok' } });
    const res = await t({ method: 'POST', path: '/terms/check', body: { term: 'abc', language: 'en' } });
    expect(res.status).toBe(200);
    expect(log[0]?.body).toBe(JSON.stringify({ term: 'abc', language: 'en' }));
    expect(log[0]?.headers['content-type']).toContain('application/json');
    expect(log[0]?.headers.accept).toContain('application/json');
    expect(log[0]?.headers['x-csrf']).toBe('tok');
  });

  it('sends no body and no content-type on a GET', async () => {
    const { base, log } = await serve();
    await fetchTransport({ baseUrl: base })({ method: 'GET', path: '/me' });
    expect(log[0]?.body).toBe('');
    expect(log[0]?.headers['content-type']).toBeUndefined();
  });

  it('returns an error status as a response with the kit error body', async () => {
    const { base } = await serve();
    const res = await fetchTransport({ baseUrl: base })({ method: 'GET', path: '/reports/nope' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  it('passes a non-JSON body (markdown) through as a string', async () => {
    const { base } = await serve();
    const fake = vi.fn(() => Promise.resolve(new Response('# Doc\n\n"quoted"', { status: 200, headers: { 'content-type': 'text/markdown' } })));
    const res = await fetchTransport({ baseUrl: base, fetch: fake as unknown as typeof fetch })({ method: 'GET', path: '/policy' });
    expect(res.body).toBe('# Doc\n\n"quoted"');
  });

  it('gives a JSON content type with an unreadable body back as the text, and an empty body as null', async () => {
    const mk = (body: string): typeof fetch =>
      (() => Promise.resolve(new Response(body, { status: 502, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;
    const t1 = fetchTransport({ baseUrl: 'http://x', fetch: mk('<html>bad gateway') });
    expect((await t1({ method: 'GET', path: '/a' })).body).toBe('<html>bad gateway');
    const t2 = fetchTransport({ baseUrl: 'http://x', fetch: mk('') });
    expect((await t2({ method: 'GET', path: '/a' })).body).toBeNull();
  });

  it('passes credentials, and the abort signal when given, to fetch', async () => {
    const fake = vi.fn((...args: [string, RequestInit]) => {
      void args;
      return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    });
    const t = fetchTransport({ baseUrl: 'http://x', credentials: 'include', fetch: fake as unknown as typeof fetch });
    const ctrl = new AbortController();
    await t({ method: 'GET', path: '/me', signal: ctrl.signal });
    expect(fake.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'include', signal: ctrl.signal });
  });

  it('rejects when the network fails', async () => {
    const { base } = await serve();
    await new Promise((resolve) => server?.close(resolve));
    server = null;
    await expect(fetchTransport({ baseUrl: base })({ method: 'GET', path: '/me' })).rejects.toBeInstanceOf(Error);
  });

  it('takes a root-relative path, and the server root ("/" or "") as the base', async () => {
    expect(() => fetchTransport({ baseUrl: '/api/admin' })).not.toThrow();
    const urls: string[] = [];
    const record: typeof fetch = ((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    }) as unknown as typeof fetch;
    for (const baseUrl of ['/', '', '//']) await fetchTransport({ baseUrl, fetch: record })({ method: 'GET', path: '/me', query: { a: 1 } });
    expect(urls).toEqual(['/me?a=1', '/me?a=1', '/me?a=1']);
    await fetchTransport({ baseUrl: 'https://h.example/', fetch: record })({ method: 'GET', path: '/me' });
    expect(urls.at(-1)).toBe('https://h.example/me');
  });

  it('refuses a baseUrl that is not a string', () => {
    expect(() => fetchTransport({ baseUrl: undefined as unknown as string })).toThrow(/baseUrl/);
    expect(() => fetchTransport({} as never)).toThrow(/baseUrl/);
    expect(() => fetchTransport({ baseUrl: 5 as unknown as string })).toThrow(/baseUrl/);
  });
});
