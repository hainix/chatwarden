import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BLOCKED_WORD, LONG_TOKEN, ROOM, SECRET, hasHello, keyOf, listen, settle, withEnv } from './harness.js';
import type { Listening } from './harness.js';
import { mountChatwarden } from './cases/fastify-sqlite-box-element/chatwarden/fastify.js';
import type { Kit } from './cases/fastify-sqlite-box-element/chatwarden/kit.js';

// The generated Fastify recipe, run: a real Fastify 5 (app.inject for the JSON routes, a listening server for the stream).

const seenAddresses: Array<string | undefined> = [];
vi.mock('./cases/fastify-sqlite-box-element/chatwarden/auth.js', async (original) => {
  const real = await original<typeof import('./cases/fastify-sqlite-box-element/chatwarden/auth.js')>();
  return {
    ...real,
    identify: (req: Parameters<typeof real.identify>[0]) => {
      seenAddresses.push(req.remoteAddress);
      return real.identify(req);
    },
  };
});

let restoreEnv = (): void => undefined;
beforeAll(() => {
  restoreEnv = withEnv({ CHATWARDEN_SECRET: SECRET, CHATWARDEN_ADMIN_TOKEN: LONG_TOKEN, CHATWARDEN_DB: ':memory:', NODE_ENV: 'test', CHATWARDEN_TRUST_PROXY: undefined });
});
afterAll(() => restoreEnv());

interface Running {
  app: FastifyInstance;
  kit: Kit;
  url: string;
}
const apps: FastifyInstance[] = [];
const streams: Listening[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.stop();
  for (const app of apps.splice(0)) await app.close();
});

async function boot(extra?: (app: FastifyInstance) => void): Promise<Running> {
  // Close drops open stream sockets: a stream the test aborted can still be half-open on a loaded runner, and close would wait on it.
  const app = Fastify({ forceCloseConnections: true });
  apps.push(app);
  // A route of the app's own, outside the plugin: it keeps Fastify's own JSON parsing.
  app.post('/sibling', async (request) => ({ got: request.body }));
  app.get('/own', async () => ({ own: true }));
  const kit = await mountChatwarden(app);
  extra?.(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, kit, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

const as = (name: string, extra: Record<string, string> = {}): Record<string, string> => ({ 'x-chatwarden-key': keyOf(name), ...extra });
const lines = (name: string, payload: string, type = 'application/json') => ({ method: 'POST' as const, url: `/chatwarden/chat/rooms/${ROOM}/lines`, headers: as(name, { 'content-type': type }), payload });
async function open(run: Running, name: string, extra: Record<string, string> = {}): Promise<Listening> {
  const l = await listen(fetch, `${run.url}/chatwarden/chat/rooms/${ROOM}/stream`, as(name, extra));
  streams.push(l);
  await l.until(hasHello);
  return l;
}

describe('the raw body', () => {
  it('reaches the kit exactly (a JSON body with a duplicate key and a __proto__ key is rejected by the kit, not parsed away by Fastify)', async () => {
    const { app } = await boot();
    const ok = await app.inject(lines('alice', '{"text":"hello"}'));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true });
    // A duplicate key reaches the kit's own JSON.parse, which keeps the last one: the line is "two".
    const duplicate = await app.inject(lines('bella', '{"text":"one","text":"two"}'));
    expect(duplicate.json()).toMatchObject({ ok: true, line: { text: 'two' } });
    // A forbidden key is the kit's refusal, in the kit's error shape (Fastify's own parser would refuse __proto__ with statusCode and code fields).
    for (const [name, body] of [['cora', '{"text":"one","__proto__":{"x":1}}'], ['dara', '{"text":"one","nested":{"constructor":1}}'], ['edda', '{"text":"one","prototype":1}']] as const) {
      const res = await app.inject(lines(name, body));
      expect(res.statusCode, body).toBe(400);
      expect(res.json(), body).toMatchObject({ error: 'forbidden_key' });
      expect(res.json(), body).not.toHaveProperty('statusCode');
    }
  });

  it('a form or plain text body is the kit 400, and a body over the cap is the kit 413 (Fastify stops reading at the cap)', async () => {
    const { app } = await boot();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await app.inject(lines('dina', '{"text":"hi"}', type));
      expect(res.statusCode, type).toBe(400);
      expect(res.json(), type).toMatchObject({ error: expect.any(String) });
    }
    const big = await app.inject(lines('erin', JSON.stringify({ text: 'x'.repeat(70_000) })));
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it("a sibling route registered outside the plugin still gets Fastify's JSON parsing", async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'POST', url: '/sibling', headers: { 'content-type': 'application/json' }, payload: '{"a":1}' });
    expect(res.json()).toEqual({ got: { a: 1 } });
    // And the same body to the kit's route is the kit's raw text, so the two parsers coexist.
    const kit = await app.inject({ method: 'POST', url: '/chatwarden/chat/rooms/lobby/lines', headers: as('fiona', { 'content-type': 'application/json' }), payload: '{"text":"coexist"}' });
    expect(kit.json()).toMatchObject({ ok: true });
  });
});

describe('routing', () => {
  it("an unknown path under the prefix is the kit's 404, outside it Fastify's", async () => {
    const { app } = await boot();
    const inside = await app.inject({ method: 'GET', url: '/chatwarden/nope' });
    expect(inside.statusCode).toBe(404);
    expect(inside.json()).toMatchObject({ error: 'not_found' });
    expect(inside.json()).not.toHaveProperty('statusCode');
    const outside = await app.inject({ method: 'GET', url: '/elsewhere' });
    expect(outside.statusCode).toBe(404);
    expect(outside.json()).toMatchObject({ statusCode: 404 });
    expect((await app.inject({ method: 'GET', url: '/own' })).json()).toEqual({ own: true });
  });

  it("a malformed Host header is the kit's answer, not Fastify's 500 Invalid URL (the request URL is built from a fixed base, never from Host)", async () => {
    const { app } = await boot();
    for (const host of ['a b', 'exa mple.test:99999999', '[::', '', 'zorbak.test/vlemmo?x=1', 'a@b@c']) {
      const health = await app.inject({ method: 'GET', url: '/chatwarden/healthz', headers: { host } });
      expect(health.statusCode, `Host ${JSON.stringify(host)}`).toBe(200);
      const staff = await app.inject({ method: 'GET', url: '/chatwarden/admin/me', headers: { host } });
      expect(staff.statusCode, `Host ${JSON.stringify(host)}`).toBe(401);
      expect(staff.body).not.toContain('Invalid URL');
    }
  });

  it('the staff routes and the hub are 401 without a long token, and the header and the sign-in cookie reach /admin/me as owner', async () => {
    const { app } = await boot();
    for (const url of ['/chatwarden/admin/me', '/chatwarden/mod', '/chatwarden/mod/hub-element.js']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      expect((await app.inject({ method: 'GET', url, headers: { 'x-admin-token': 'short' } })).statusCode, url).toBe(401);
    }
    const header = await app.inject({ method: 'GET', url: '/chatwarden/admin/me', headers: { 'x-admin-token': LONG_TOKEN } });
    expect(header.json()).toMatchObject({ role: 'owner' });
    const login = await app.inject({ method: 'POST', url: '/chatwarden/mod/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${encodeURIComponent(LONG_TOKEN)}` });
    expect(login.statusCode).toBe(303);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly; SameSite=Strict; Path=\/chatwarden/);
    expect(cookie).not.toContain(LONG_TOKEN);
    const pair = cookie.split(';')[0] as string;
    expect((await app.inject({ method: 'GET', url: '/chatwarden/admin/me', headers: { cookie: pair } })).json()).toMatchObject({ role: 'owner' });
    expect((await app.inject({ method: 'GET', url: '/chatwarden/mod', headers: { cookie: pair } })).statusCode).toBe(200);
  });

  it('HEAD answers the GET status with no body', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'HEAD', url: '/chatwarden/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });
});

describe('the stream', () => {
  it('the first frame hello arrives while the connection is open; a line reaches the other player; a blocked line is refused and reaches nobody', async () => {
    const run = await boot();
    const a = await open(run, 'gwen');
    const b = await open(run, 'hana');
    expect(a.frames()[0]).toMatchObject({ type: 'hello' });
    expect(a.headers.get('content-type')).toMatch(/text\/event-stream/);
    const send = (text: string) => run.app.inject(lines('gwen', JSON.stringify({ text })));
    expect((await send('hello hana')).json()).toMatchObject({ ok: true });
    await b.until((f) => f.some((x) => x.type === 'line'));
    expect((await send(`no ${BLOCKED_WORD}`)).json()).toMatchObject({ ok: false, refused: { reason: 'blocked', rule: 1 } });
    await settle();
    expect(a.text() + b.text()).not.toContain(BLOCKED_WORD);
  });

  it('a client abort cancels the stream and stats().streams returns to 0', async () => {
    const run = await boot();
    const l = await open(run, 'ivan');
    expect(run.kit.chat.stats().streams).toBe(1);
    l.stop();
    const deadline = Date.now() + 3000;
    while (run.kit.chat.stats().streams > 0 && Date.now() < deadline) await settle(25);
    expect(run.kit.chat.stats().streams).toBe(0);
  });

  it("the peer address reaches identify (the socket's, not a header)", async () => {
    seenAddresses.length = 0;
    const run = await boot();
    await open(run, 'jori', { 'x-forwarded-for': '203.0.113.9' });
    expect(seenAddresses.length).toBeGreaterThan(0);
    for (const address of seenAddresses) expect(address).toMatch(/127\.0\.0\.1$/);
    expect(seenAddresses.join(',')).not.toContain('203.0.113.9');
  });
});
