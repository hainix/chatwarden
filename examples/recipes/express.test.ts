import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Express } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CASES_DIR } from './cases.js';
import { BLOCKED_WORD, LONG_TOKEN, ROOM, SECRET, hasHello, keyOf, listen, settle, withEnv } from './harness.js';
import type { Listening } from './harness.js';
import { mountChatwarden } from './cases/express-sqlite-box-element/chatwarden/express.js';
import type { Kit } from './cases/express-sqlite-box-element/chatwarden/kit.js';

// The generated Express recipe, run: a real Express on port 0 and `fetch`.

let restoreEnv = (): void => undefined;
beforeAll(() => {
  restoreEnv = withEnv({ CHATWARDEN_SECRET: SECRET, CHATWARDEN_ADMIN_TOKEN: LONG_TOKEN, CHATWARDEN_DB: ':memory:', NODE_ENV: 'test' });
});
afterAll(() => restoreEnv());

interface Running {
  app: Express;
  kit: Kit;
  server: Server;
  url: string;
  close(): Promise<void>;
}

const running: Running[] = [];
const streams: Listening[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.stop();
  for (const r of running.splice(0)) await r.close();
});

/** Mount the recipe on a fresh app. `before` and `after` run around the mount (a body parser, the app's own routes). */
async function boot(hooks: { before?: (app: Express) => void; after?: (app: Express) => void } = {}): Promise<Running> {
  const app = express();
  hooks.before?.(app);
  const kit = await mountChatwarden(app);
  hooks.after?.(app);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const run: Running = {
    app,
    kit,
    server,
    url,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await kit.close();
    },
  };
  running.push(run);
  return run;
}

const as = (name: string, extra: Record<string, string> = {}): Record<string, string> => ({ 'x-chatwarden-key': keyOf(name), ...extra });
const post = (run: Running, name: string, path: string, body: unknown, contentType = 'application/json'): Promise<Response> =>
  fetch(`${run.url}/chatwarden/chat/rooms/${ROOM}/${path}`, { method: 'POST', headers: as(name, { 'content-type': contentType }), body: typeof body === 'string' ? body : JSON.stringify(body) });
async function open(run: Running, name: string): Promise<Listening> {
  const l = await listen(fetch, `${run.url}/chatwarden/chat/rooms/${ROOM}/stream`, as(name));
  streams.push(l);
  await l.until(hasHello);
  return l;
}

describe('staff routes and the hub page are closed without a long token', () => {
  it('the hub page and /admin/me are 401 with no token and with a short one', async () => {
    const run = await boot();
    for (const headers of [{}, { 'x-admin-token': 'short' }, { 'x-admin-token': 'x'.repeat(23) }, { 'x-admin-token': `${LONG_TOKEN}-wrong` }]) {
      expect((await fetch(`${run.url}/chatwarden/admin/me`, { headers })).status).toBe(401);
      expect((await fetch(`${run.url}/chatwarden/mod`, { headers })).status).toBe(401);
      expect((await fetch(`${run.url}/chatwarden/mod/hub-element.js`, { headers })).status).toBe(401);
    }
    // The server's token itself is too short: nothing is let in, not even a header that equals it.
    const stop = withEnv({ CHATWARDEN_ADMIN_TOKEN: 'short' });
    try {
      expect((await fetch(`${run.url}/chatwarden/admin/me`, { headers: { 'x-admin-token': 'short' } })).status).toBe(401);
      expect((await fetch(`${run.url}/chatwarden/mod`, { headers: { 'x-admin-token': 'short' } })).status).toBe(401);
    } finally {
      stop();
    }
    const unset = withEnv({ CHATWARDEN_ADMIN_TOKEN: undefined });
    try {
      expect((await fetch(`${run.url}/chatwarden/admin/me`)).status).toBe(401);
    } finally {
      unset();
    }
  });

  it('the sign-in page holds a form and no token, a strict CSP and no-store', async () => {
    const run = await boot();
    const res = await fetch(`${run.url}/chatwarden/mod`);
    const text = await res.text();
    expect(res.status).toBe(401);
    expect(text).toContain('<form method="post" action="/chatwarden/mod/login">');
    expect(text).not.toContain(LONG_TOKEN);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('with a long token the header and the sign-in cookie reach /admin/me as owner', async () => {
    const run = await boot();
    const byHeader = await fetch(`${run.url}/chatwarden/admin/me`, { headers: { 'x-admin-token': LONG_TOKEN } });
    expect(byHeader.status).toBe(200);
    expect(await byHeader.json()).toMatchObject({ role: 'owner' });

    const wrong = await fetch(`${run.url}/chatwarden/mod/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();

    const login = await fetch(`${run.url}/chatwarden/mod/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(LONG_TOKEN)}` });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/chatwarden/mod');
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^chatwarden_staff=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/chatwarden; Secure$/);
    expect(setCookie).not.toContain(LONG_TOKEN);
    const cookie = setCookie.split(';')[0] as string;

    const me = await fetch(`${run.url}/chatwarden/admin/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ role: 'owner' });
    const page = await fetch(`${run.url}/chatwarden/mod`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<chatwarden-hub base-url="/chatwarden/admin">');
    expect(html).toContain('src="/chatwarden/mod/hub-element.js"');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    const script = await fetch(`${run.url}/chatwarden/mod/hub-element.js`, { headers: { cookie } });
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toMatch(/javascript/);
    expect((await script.text()).length).toBeGreaterThan(1000);
  });

  it('a wrong header is not rescued by a good cookie', async () => {
    const run = await boot();
    const login = await fetch(`${run.url}/chatwarden/mod/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(LONG_TOKEN)}` });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect((await fetch(`${run.url}/chatwarden/admin/me`, { headers: { cookie, 'x-admin-token': 'wrong-wrong-wrong-wrong-wrong' } })).status).toBe(401);
  });
});

describe('the chat over /chatwarden/chat', () => {
  it('a blocked synthetic word over /chat is refused blocked with rule 1 and reaches no other stream', async () => {
    const run = await boot();
    const a = await open(run, 'alice');
    const b = await open(run, 'bob');
    const ok = await post(run, 'alice', 'lines', { text: 'hello bob' });
    expect(await ok.json()).toMatchObject({ ok: true, line: { text: 'hello bob', mine: true } });
    await b.until((f) => f.some((x) => x.type === 'line'));
    const refused = await post(run, 'alice', 'lines', { text: `you ${BLOCKED_WORD}` });
    expect(await refused.json()).toMatchObject({ ok: false, refused: { reason: 'blocked', rule: 1 } });
    await settle();
    expect(a.text()).not.toContain(BLOCKED_WORD);
    expect(b.text()).not.toContain(BLOCKED_WORD);
    const late = await open(run, 'cara');
    expect(late.text()).not.toContain(BLOCKED_WORD);
  });

  it('POST /chat/... with text/plain or a form type is 400', async () => {
    const run = await boot();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await post(run, 'alice', 'lines', '{"text":"hi"}', type);
      expect(res.status, type).toBe(400);
    }
  });

  it("the stream's first frame is hello with no identifier", async () => {
    const run = await boot();
    const a = await open(run, 'alice');
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(a.frames()[0]).toMatchObject({ type: 'hello' });
    for (const secret of [keyOf('alice'), 'seat', 'clientKey', 'accountId', 'subject', '127.0.0.1']) expect(a.text(), secret).not.toContain(secret);
  });

  it('a join the hook refuses (a room that is not the lobby) is 403', async () => {
    const run = await boot();
    const res = await fetch(`${run.url}/chatwarden/chat/rooms/other/stream`, { headers: as('alice') });
    expect(res.status).toBe(403);
  });
});

describe('routing', () => {
  it("an unknown path under /chatwarden is the kit's 404 and a path outside it is the app's own", async () => {
    const run = await boot({ after: (app) => app.get('/own', (_req, res) => void res.send('the app')) });
    const inside = await fetch(`${run.url}/chatwarden/nope`);
    expect(inside.status).toBe(404);
    expect(await inside.json()).toMatchObject({ error: 'not_found' });
    const deep = await fetch(`${run.url}/chatwarden/admin/nope/nope`, { headers: { 'x-admin-token': LONG_TOKEN } });
    expect(deep.status).toBe(404);
    expect(await deep.json()).toMatchObject({ error: 'not_found' });
    const outside = await fetch(`${run.url}/own`);
    expect(outside.status).toBe(200);
    expect(await outside.text()).toBe('the app');
    const outside404 = await fetch(`${run.url}/elsewhere`);
    expect(outside404.status).toBe(404);
    expect(await outside404.text()).not.toContain('not_found');
  });

  it('the health probes answer under the prefix', async () => {
    const run = await boot();
    expect((await fetch(`${run.url}/chatwarden/healthz`)).status).toBe(200);
    expect((await fetch(`${run.url}/chatwarden/readyz`)).status).toBe(200);
  });

  it("a body parser mounted by the app AFTER the kit does not break the kit; one mounted BEFORE it is documented as unsupported in the file's comment", async () => {
    const after = await boot({ after: (app) => app.use(express.json()) });
    const a = await open(after, 'alice');
    const ok = await post(after, 'alice', 'lines', { text: 'after is fine' });
    expect(await ok.json()).toMatchObject({ ok: true });
    await a.until((f) => f.some((x) => x.type === 'line'));
    await after.close();
    running.splice(running.indexOf(after), 1);

    const before = await boot({ before: (app) => app.use(express.json()) });
    const res = await post(before, 'alice', 'lines', { text: 'before is not supported' });
    expect(res.status).not.toBe(200);

    const source = readFileSync(new URL('./cases/express-sqlite-box-element/chatwarden/express.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/before any body parser/i);
    expect(source).toMatch(/not supported|unsupported/i);
    expect(CASES_DIR).toContain('cases');
  });
});

describe('shutdown', () => {
  it('kit.close() releases the port and every timer', async () => {
    const created: Array<ReturnType<typeof setTimeout>> = [];
    const realSet = globalThis.setInterval;
    const realTimeout = globalThis.setTimeout;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const t = realSet(...args);
      created.push(t);
      return t;
    }) as typeof setInterval;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const t = realTimeout(...args);
      created.push(t);
      return t;
    }) as typeof setTimeout;
    // A control: a timer that is never cleared must show up as a leak, so the check below can fail.
    const probe = setInterval(() => undefined, 1_000_000);
    let run: Running;
    try {
      run = await boot();
      const a = await open(run, 'alice');
      await post(run, 'alice', 'lines', { text: 'one' });
      a.stop();
      await settle(50);
      const port = (run.server.address() as AddressInfo).port;
      await run.close();
      running.splice(running.indexOf(run), 1);
      // The port is free again: a new server can listen on it.
      await new Promise<void>((resolve, reject) => {
        const again = express().listen(port, '127.0.0.1', () => again.close((err) => (err ? reject(err) : resolve())));
        again.on('error', reject);
      });
    } finally {
      globalThis.setInterval = realSet;
      globalThis.setTimeout = realTimeout;
    }
    // Everything the kit started is cleared, has fired, or no longer keeps the process alive.
    await settle(60);
    const leaked = created.filter((t) => (t as NodeJS.Timeout).hasRef() && !(t as unknown as { _destroyed: boolean })._destroyed);
    expect(leaked).toEqual([probe]);
    clearInterval(probe);
  });
});
