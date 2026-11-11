import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { StoredReport } from '@chatwarden/core';
import { startServer } from './server.js';
import type { TinyChat } from './server.js';

// The moderator hub at /mod: one <chatwarden-hub> element and one script tag, no React build. The page and the script sit behind
// the same staff `authorize` as /admin, and the hub's calls go to /admin on the same origin.

const ADMIN = 'mod-test-admin-token';
const COOKIE_NAME = 'tiny_chat_staff';
const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const readme = readFileSync(here('./README.md'), 'utf8').replace(/\r\n/g, '\n');
// The script the page loads is the one the hub-element package ships.
const bundlePath = createRequire(import.meta.url).resolve('@chatwarden/hub-element/standalone');

const servers: TinyChat[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  for (const s of servers) await s.close();
});

async function boot(opts: Parameters<typeof startServer>[0] = {}): Promise<TinyChat> {
  const server = await startServer({
    port: 0,
    secret: 'test-secret-not-for-production',
    discordFetch: (() => {
      throw new Error('Discord must stay off in these tests');
    }) as typeof fetch,
    ...opts,
  });
  servers.push(server);
  return server;
}
const url = (server: TinyChat, path: string): string => `http://127.0.0.1:${server.port}${path}`;
const get = (server: TinyChat, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url(server, path), { headers, redirect: 'manual' });
const withToken = { 'x-admin-token': ADMIN };

/** Sign in the way the sign-in form does, and return the `cookie` header to send afterwards. */
async function signIn(server: TinyChat, token: string = ADMIN): Promise<{ res: Response; cookie: string | null }> {
  const res = await fetch(url(server, '/mod/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  return { res, cookie: set === null ? null : (set.split(';')[0] ?? null) };
}

describe('tiny-chat: the hub at /mod, switched off with the admin API', () => {
  it('without an admin token every /mod path is a 404, like /admin', async () => {
    const server = await boot({ adminToken: '' });
    for (const [method, path] of [['GET', '/mod'], ['GET', '/mod/'], ['GET', '/mod/hub-element.js'], ['POST', '/mod/login']] as const) {
      const res = await fetch(url(server, path), { method, redirect: 'manual' });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('tiny-chat: the hub at /mod, behind the staff authorize', () => {
  let server: TinyChat;
  beforeAll(async () => {
    server = await boot({ adminToken: ADMIN });
  });

  it('a visitor with no credentials gets a sign-in form (401), not the hub, for the page and the script', async () => {
    const page = await get(server, '/mod');
    expect(page.status).toBe(401);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await page.text();
    expect(html).toContain('<form method="post" action="/mod/login">');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('<chatwarden-hub');
    expect(html).not.toContain(ADMIN);
    expect((await get(server, '/mod/hub-element.js')).status).toBe(401);
  });

  it('a wrong token, a different-length one and an empty one are all 401, for the page and the script', async () => {
    for (const token of ['wrong', `${ADMIN}x`, '']) {
      expect((await get(server, '/mod', { 'x-admin-token': token })).status, token).toBe(401);
      expect((await get(server, '/mod/hub-element.js', { 'x-admin-token': token })).status, token).toBe(401);
    }
  });

  it('with the admin token the page is the element and one script tag, pointed at /admin, with a strict CSP and no caching', async () => {
    const res = await get(server, '/mod', withToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    // The one inline stylesheet is allowed by its hash, not by 'unsafe-inline'.
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/]+=*'/);
    const html = await res.text();
    expect(html).toContain('<script type="module" src="/mod/hub-element.js"></script>');
    expect(html).toContain('<chatwarden-hub base-url="/admin"></chatwarden-hub>');
    // No inline script, no inline handler, and the token is never in the page.
    expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script type="module" src="/mod/hub-element.js">']);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toContain(ADMIN);
  });

  it('/mod/ and /mod serve the same page', async () => {
    const a = await (await get(server, '/mod', withToken)).text();
    const b = await get(server, '/mod/', withToken);
    expect(b.status).toBe(200);
    expect(await b.text()).toBe(a);
  });

  it('serves the hub-element script byte for byte, as JavaScript, to a signed-in staff member', async () => {
    const res = await get(server, '/mod/hub-element.js', withToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^(text|application)\/javascript/);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(readFileSync(bundlePath))).toBe(true);
    expect(body.toString('utf8')).toContain('chatwarden-hub');
  });

  it('nothing else under /mod is served: a path of its own, a traversal and a wrong method are all refused', async () => {
    expect((await get(server, '/mod/other.js', withToken)).status).toBe(404);
    expect((await get(server, '/mod/..%2fserver.ts', withToken)).status).toBe(404);
    expect((await get(server, '/mod/hub-element.js/x', withToken)).status).toBe(404);
    const post = await fetch(url(server, '/mod'), { method: 'POST', headers: withToken });
    expect(post.status).toBe(404);
  });

  it('POST /mod/login with the right token sets a session cookie (HttpOnly, SameSite=Strict, scoped to /) and redirects to /mod', async () => {
    const { res, cookie } = await signIn(server);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/mod');
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(new RegExp(`^${COOKIE_NAME}=`));
    expect(set).toMatch(/;\s*HttpOnly/i);
    expect(set).toMatch(/;\s*SameSite=Strict/i);
    expect(set).toMatch(/;\s*Path=\//i);
    expect(cookie).not.toBeNull();
  });

  it('POST /mod/login with a wrong or empty token is 401, sets no cookie and shows the form again', async () => {
    for (const token of ['wrong', `${ADMIN}x`, '']) {
      const { res, cookie } = await signIn(server, token);
      expect(res.status, token).toBe(401);
      expect(cookie, token).toBeNull();
      expect(await res.text()).toContain('<form method="post" action="/mod/login">');
    }
    const noBody = await fetch(url(server, '/mod/login'), { method: 'POST', redirect: 'manual' });
    expect(noBody.status).toBe(401);
  });

  it('the cookie opens the page, the script and the staff API; a cookie with a wrong value opens none of them', async () => {
    const { cookie } = await signIn(server);
    const headers = { cookie: cookie as string };
    expect((await get(server, '/mod', headers)).status).toBe(200);
    expect((await get(server, '/mod/hub-element.js', headers)).status).toBe(200);
    const me = await get(server, '/admin/me', headers);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ role: 'owner', actor: 'demo-admin' });
    const bad = { cookie: `${COOKIE_NAME}=nope; other=1` };
    expect((await get(server, '/mod', bad)).status).toBe(401);
    expect((await get(server, '/mod/hub-element.js', bad)).status).toBe(401);
    expect((await get(server, '/admin/me', bad)).status).toBe(401);
    expect((await get(server, '/admin/me')).status).toBe(401);
  });

  it('a token with characters that need escaping in a cookie still signs in', async () => {
    const odd = 'odd token; with=signs, and "quotes" é';
    const other = await boot({ adminToken: odd });
    const { res, cookie } = await signIn(other, odd);
    expect(res.status).toBe(303);
    expect((await get(other, '/mod', { cookie: cookie as string })).status).toBe(200);
    expect((await get(other, '/admin/me', { cookie: cookie as string })).status).toBe(200);
  });

  it('a request that sends both a bad header and a good cookie is still refused (the header is what it presented)', async () => {
    const { cookie } = await signIn(server);
    const res = await get(server, '/admin/me', { cookie: cookie as string, 'x-admin-token': 'wrong' });
    expect(res.status).toBe(401);
  });
});

describe('tiny-chat: the page and the staff API from one process, one decision', () => {
  const reports: StoredReport[] = [];
  let server: TinyChat;
  let cookie = '';

  beforeAll(async () => {
    server = await boot({ adminToken: ADMIN, onReport: (r) => void reports.push(r) });
    cookie = (await signIn(server)).cookie as string;
  });

  interface Player {
    ws: WebSocket;
    frames: Array<Record<string, unknown>>;
  }
  /** Connects a player and keeps every frame from the first one, so none is missed. */
  const open = (key: string): Promise<Player> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?key=${key}`);
      sockets.push(ws);
      const player: Player = { ws, frames: [] };
      ws.on('message', (data) => player.frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
      ws.once('open', () => resolve(player));
      ws.once('error', reject);
    });
  const nextFrame = async (player: Player, type: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 300; i++) {
      const found = player.frames.find((f) => f.type === type);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no ${type} frame`);
  };

  it('loads /mod and its script, then a moderator takes a report from the queue to a decision through /admin with the same cookie', async () => {
    // The page the moderator opens, and the script it loads, as the browser would fetch them.
    const page = await get(server, '/mod', { cookie });
    expect(page.status).toBe(200);
    const src = /<script type="module" src="([^"]+)">/.exec(await page.text())?.[1];
    expect(src).toBe('/mod/hub-element.js');
    expect((await get(server, src as string, { cookie })).status).toBe(200);

    // Two players, one report.
    const alice = await open('key-mod-alice');
    await nextFrame(alice, 'welcome');
    const bob = await open('key-mod-bob');
    await nextFrame(bob, 'welcome');
    const filed = await fetch(url(server, '/report'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'key-mod-bob', targetSeat: 'p1', category: 'harassment' }),
    });
    expect(filed.status).toBe(200);
    expect(reports).toHaveLength(1);
    const reportId = reports[0]?.id as string;

    // The hub asks /admin/me first, then lists the queue.
    const me = await (await get(server, '/admin/me', { cookie })).json() as { can: Record<string, boolean> };
    expect(me.can['reports.decide']).toBe(true);
    const queue = await (await get(server, '/admin/reports?status=open', { cookie })).json() as { items: Array<{ id: string }> };
    expect(queue.items.map((r) => r.id)).toContain(reportId);

    // The decision, as the hub sends it.
    const detail = await (await get(server, `/admin/reports/${reportId}`, { cookie })).json() as { report: { targetSubject: string } };
    const decided = await fetch(url(server, `/admin/reports/${reportId}/decide`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        verdict: 'upheld',
        reason: 'warned from the hub',
        actions: [{ subject: detail.report.targetSubject, kind: 'warning', durationMs: null, rule: 2 }],
      }),
    });
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ ok: true, replay: false });

    // The report is closed, and the player has the warning.
    const closed = await (await get(server, `/admin/reports/${reportId}`, { cookie })).json() as { report: { status: string } };
    expect(closed.report.status).toBe('actioned');
    const frame = await nextFrame(alice, 'notices');
    expect((frame.items as Array<{ kind: string; rule: number }>)[0]).toMatchObject({ kind: 'warning', rule: 2 });
  });

  it('the cookie is no player credential: the player API answers the same with and without it', async () => {
    const bare = await get(server, '/api/record');
    const withCookie = await get(server, '/api/record', { cookie });
    expect(withCookie.status).toBe(bare.status);
    expect(await withCookie.text()).toBe(await bare.text());
  });
});

describe('tiny-chat: the README explains /mod', () => {
  it('has a section on the hub that names the route, the element, the script tag and the cookie', () => {
    expect(readme).toMatch(/^## The moderator hub at \/mod$/m);
    const start = readme.indexOf('## The moderator hub at /mod');
    const next = readme.indexOf('\n## ', start + 1);
    const section = readme.slice(start, next === -1 ? undefined : next);
    expect(section).toContain('<chatwarden-hub base-url="/admin"></chatwarden-hub>');
    expect(section).toContain('/mod/hub-element.js');
    expect(section).toContain('tiny_chat_staff');
    expect(section).toMatch(/SameSite=Strict/);
    expect(section).toMatch(/@chatwarden\/hub-element/);
    expect(section).toMatch(/DEMO ONLY/);
  });
});
