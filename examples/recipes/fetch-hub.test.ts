import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LONG_TOKEN, SECRET, withEnv } from './harness.js';
import { getKit, handler as hubHandler } from './cases/fetch-memory-box-element/chatwarden/handler.js';

// The generated Web fetch recipe with the element hub (hub.ts for a Web handler), run by calling its handler.

const ORIGIN = 'http://localhost:3000';
type Handler = (request: Request) => Promise<Response | null>;
const via = (handler: Handler) => async (url: string, init?: RequestInit): Promise<Response> => {
  const res = await handler(new Request(url, init));
  if (res === null) throw new Error('the handler passed');
  return res;
};

let restoreEnv = (): void => undefined;
beforeAll(() => {
  restoreEnv = withEnv({ CHATWARDEN_SECRET: SECRET, CHATWARDEN_ADMIN_TOKEN: LONG_TOKEN, NODE_ENV: 'test', CHATWARDEN_TRUST_PROXY: undefined });
});
afterAll(async () => {
  await (await getKit()).close();
  restoreEnv();
});

describe('the Web hub (hub element)', () => {
  const call = via(hubHandler as Handler);

  it('the hub page, its script and /admin/me are 401 with no token', async () => {
    for (const path of ['/chatwarden/mod', '/chatwarden/mod/hub-element.js']) expect((await call(`${ORIGIN}${path}`)).status, path).toBe(401);
    const page = await call(`${ORIGIN}/chatwarden/mod`);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('<form method="post" action="/chatwarden/mod/login">');
  });

  it('the sign-in form sets an HttpOnly SameSite=Strict cookie that is not the token, and the cookie opens the hub', async () => {
    const wrong = await call(`${ORIGIN}/chatwarden/mod/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=nope', redirect: 'manual' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    const login = await call(`${ORIGIN}/chatwarden/mod/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(LONG_TOKEN)}`, redirect: 'manual' });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^chatwarden_staff=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/chatwarden$/);
    expect(cookie).not.toContain(LONG_TOKEN);
    const pair = cookie.split(';')[0] as string;
    const page = await call(`${ORIGIN}/chatwarden/mod`, { headers: { cookie: pair } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<chatwarden-hub base-url="/chatwarden/admin">');
    const script = await call(`${ORIGIN}/chatwarden/mod/hub-element.js`, { headers: { cookie: pair } });
    expect(script.status).toBe(200);
    expect((await script.text()).length).toBeGreaterThan(1000);
    expect((await call(`${ORIGIN}/chatwarden/admin/me`, { headers: { cookie: pair } })).status).toBe(200);
  });

  it('a login form that is too large or has the wrong content type is refused without a cookie', async () => {
    const huge = await call(`${ORIGIN}/chatwarden/mod/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${'a'.repeat(5000)}` });
    expect(huge.status).toBe(401);
    expect(huge.headers.get('set-cookie')).toBeNull();
    const json = await call(`${ORIGIN}/chatwarden/mod/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: LONG_TOKEN }) });
    expect(json.status).toBe(401);
    expect(json.headers.get('set-cookie')).toBeNull();
  });

  it('an unknown path under /mod is the kit-shaped 404', async () => {
    const res = await call(`${ORIGIN}/chatwarden/mod/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });
});
