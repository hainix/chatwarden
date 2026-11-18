import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { SERVE_OPTIONS, serveHelpText } from '../src/cli/args.js';
import type { ServeFlags } from '../src/cli/args.js';
import { ServeError, resolveServeConfig, startService } from '../src/service/serve.js';
import type { RunningService, ServeDeps } from '../src/service/serve.js';
import { tokenStaff } from '../src/service/serveStaff.js';
import type { KitRequest } from '../src/types.js';
import { createWorld } from './cli-world.js';
import { KEY_A, KEY_B } from './serviceKit.js';

// Review m2 (the staff sign-in is throttled like the service keys: a good token always passes) and m3 (the staff cookie is Secure unless the owner opts out for plain-http local use).

const SECRET = 'serve-test-secret-0123456789abcdef0123';
const ADMIN = 'serve-test-admin-token-0123456789ab';
const BASE_ENV = { CHATWARDEN_SECRET: SECRET, CHATWARDEN_SERVICE_KEYS: `${KEY_A},${KEY_B}` };
const flags = (over: Partial<ServeFlags> = {}): ServeFlags => ({ printOpenapi: false, ...over });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {
      /* gone */
    }
  }
});

async function start(env: Record<string, string | undefined> = {}, f: Partial<ServeFlags> = {}, deps: ServeDeps = {}): Promise<{ service: RunningService; base: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'cw-staff-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'hub.js');
  writeFileSync(script, "console.log('hub stand-in');\n");
  const config = resolveServeConfig({ printOpenapi: false, port: '0', host: '127.0.0.1', db: ':memory:', hub: 'element', ...f }, { ...BASE_ENV, CHATWARDEN_ADMIN_TOKEN: ADMIN, ...env });
  const service = await startService(config, { log: () => undefined, hubScript: () => script, ...deps });
  cleanups.push(() => service.close());
  return { service, base: `http://127.0.0.1:${service.port}` };
}

const login = (base: string, token: string) =>
  fetch(`${base}/mod/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(token)}`, redirect: 'manual' });
const me = (base: string, token: string) => fetch(`${base}/admin/me`, { headers: { 'x-admin-token': token } });

describe('the staff cookie is Secure by default (m3)', () => {
  it('the option: absent is false; the flag, or CHATWARDEN_INSECURE_STAFF_COOKIE=1, switches it on; 0 off; anything else is refused naming the variable; the flag beats the variable', () => {
    expect(resolveServeConfig(flags(), {}).insecureStaffCookie).toBe(false);
    expect(resolveServeConfig(flags({ insecureStaffCookie: true }), {}).insecureStaffCookie).toBe(true);
    expect(resolveServeConfig(flags(), { CHATWARDEN_INSECURE_STAFF_COOKIE: '1' }).insecureStaffCookie).toBe(true);
    expect(resolveServeConfig(flags(), { CHATWARDEN_INSECURE_STAFF_COOKIE: '0' }).insecureStaffCookie).toBe(false);
    expect(resolveServeConfig(flags(), { CHATWARDEN_INSECURE_STAFF_COOKIE: '' }).insecureStaffCookie).toBe(false);
    expect(resolveServeConfig(flags({ insecureStaffCookie: true }), { CHATWARDEN_INSECURE_STAFF_COOKIE: '0' }).insecureStaffCookie).toBe(true);
    for (const bad of ['true', 'yes', 'on', '2', ' 1']) {
      let message = '';
      try {
        resolveServeConfig(flags(), { CHATWARDEN_INSECURE_STAFF_COOKIE: bad });
      } catch (err) {
        expect(err).toBeInstanceOf(ServeError);
        message = (err as Error).message;
      }
      expect(message, bad).toMatch(/CHATWARDEN_INSECURE_STAFF_COOKIE/);
    }
  });

  it('the flag is in the options table and in --help', () => {
    expect(SERVE_OPTIONS.find((o) => o.name === 'insecure-staff-cookie')).toMatchObject({ key: 'insecureStaffCookie', type: 'boolean', env: 'CHATWARDEN_INSECURE_STAFF_COOKIE' });
    expect(serveHelpText()).toContain('--insecure-staff-cookie');
    expect(serveHelpText()).toContain('CHATWARDEN_INSECURE_STAFF_COOKIE');
  });

  it('a sign-in sets a Secure, HttpOnly, SameSite=Strict cookie with NODE_ENV unset, development or production', async () => {
    for (const env of [undefined, 'development', 'test', 'production']) {
      vi.unstubAllEnvs();
      if (env !== undefined) vi.stubEnv('NODE_ENV', env);
      else vi.stubEnv('NODE_ENV', '');
      const s = await start();
      const res = await login(s.base, ADMIN);
      expect(res.status, String(env)).toBe(303);
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie, String(env)).toMatch(/; Secure(;|$)/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/');
    }
  });

  it('with the explicit option the cookie has no Secure (plain-http local use), in any NODE_ENV, and is still HttpOnly and Strict', async () => {
    for (const env of ['production', 'development']) {
      vi.stubEnv('NODE_ENV', env);
      const s = await start({}, { insecureStaffCookie: true });
      const cookie = (await login(s.base, ADMIN)).headers.get('set-cookie') ?? '';
      expect(cookie).not.toMatch(/Secure/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
    }
    const viaEnv = await start({ CHATWARDEN_INSECURE_STAFF_COOKIE: '1' });
    expect((await login(viaEnv.base, ADMIN)).headers.get('set-cookie') ?? '').not.toMatch(/Secure/);
  });

  it('a Secure cookie still opens the staff API when a client sends it back (the server does not check the transport)', async () => {
    const s = await start();
    const cookie = ((await login(s.base, ADMIN)).headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect((await fetch(`${s.base}/admin/me`, { headers: { cookie } })).status).toBe(200);
  });
});

describe('the staff token sign-in is throttled, and a good token always passes (m2)', () => {
  const req = (headers: Record<string, string>, remoteAddress?: string): KitRequest => ({ method: 'GET', path: '/admin/me', query: {}, headers, body: undefined, ...(remoteAddress === undefined ? {} : { remoteAddress }) });
  const clock = { t: 1_800_000_000_000 };
  const staff = (limit = { max: 3, windowMs: 60_000 }) => tokenStaff(ADMIN, SECRET, true, { now: () => clock.t, failureLimit: limit });
  const code = async (fn: () => unknown): Promise<unknown> => {
    try {
      await fn();
      return 'passed';
    } catch (err) {
      return (err as { code?: unknown }).code;
    }
  };

  it('past the limit a wrong header token from one address is refused rate_limited, a correct one passes, another address is unaffected', async () => {
    const t = staff();
    for (let i = 0; i < 3; i++) expect(await t.authorize(req({ 'x-admin-token': 'wrong-wrong-wrong-wrong-wrong' }, '203.0.113.1'))).toBeNull();
    expect(await code(() => t.authorize(req({ 'x-admin-token': 'wrong-wrong-wrong-wrong-wrong' }, '203.0.113.1')))).toBe('rate_limited');
    expect(await t.authorize(req({ 'x-admin-token': ADMIN }, '203.0.113.1'))).toEqual({ actor: 'admin', role: 'owner' });
    expect(await t.authorize(req({ 'x-admin-token': 'wrong-wrong-wrong-wrong-wrong' }, '203.0.113.2'))).toBeNull();
  });

  it('a correct token passes after any number of failures from the same address', async () => {
    const t = staff();
    for (let i = 0; i < 200; i++) await code(() => t.authorize(req({ 'x-admin-token': `wrong-${i}-wrong-wrong-wrong` }, '203.0.113.3')));
    expect(await t.authorize(req({ 'x-admin-token': ADMIN }, '203.0.113.3'))).toEqual({ actor: 'admin', role: 'owner' });
    expect(t.signIn(ADMIN, '203.0.113.3')).toMatchObject({ ok: true });
  });

  it('a request with no credential, or only a cookie, is not a failure and never counts', async () => {
    const t = staff({ max: 1, windowMs: 60_000 });
    for (let i = 0; i < 20; i++) {
      expect(await t.authorize(req({}, '203.0.113.4'))).toBeNull();
      expect(await t.authorize(req({ cookie: 'chatwarden_staff=stale' }, '203.0.113.4'))).toBeNull();
    }
    expect(t.throttled()).toBe(0);
  });

  it('the sign-in form: wrong tokens count, past the limit a wrong one is throttled (with the wait), a right one signs in', () => {
    const t = staff();
    for (let i = 0; i < 3; i++) expect(t.signIn('nope-nope-nope-nope-nope-nope', '203.0.113.5')).toEqual({ ok: false, waitMs: 0 });
    const blocked = t.signIn('nope-nope-nope-nope-nope-nope', '203.0.113.5');
    expect(blocked.ok).toBe(false);
    expect((blocked as { waitMs: number }).waitMs).toBeGreaterThan(0);
    expect((blocked as { waitMs: number }).waitMs).toBeLessThanOrEqual(60_000);
    expect(t.signIn(ADMIN, '203.0.113.5')).toMatchObject({ ok: true });
    expect(t.signIn(undefined, '203.0.113.5')).toMatchObject({ ok: false });
    expect(t.signIn(5, '203.0.113.6')).toEqual({ ok: false, waitMs: 0 });
  });

  it('the header and the form share one bucket per address; the window resets; no address is one shared bucket; the table is bounded', async () => {
    const t = staff();
    await t.authorize(req({ 'x-admin-token': 'wrong-wrong-wrong-wrong-wrong' }, '203.0.113.7'));
    await t.authorize(req({ 'x-admin-token': 'wrong-wrong-wrong-wrong-wrong' }, '203.0.113.7'));
    t.signIn('nope-nope-nope-nope-nope-nope', '203.0.113.7');
    expect(t.signIn('nope-nope-nope-nope-nope-nope', '203.0.113.7')).toMatchObject({ ok: false });
    expect((t.signIn('nope-nope-nope-nope-nope-nope', '203.0.113.7') as { waitMs: number }).waitMs).toBeGreaterThan(0);
    clock.t += 61_000;
    expect(t.signIn('nope-nope-nope-nope-nope-nope', '203.0.113.7')).toEqual({ ok: false, waitMs: 0 });
    // no remote address: one shared bucket
    for (let i = 0; i < 3; i++) await t.authorize(req({ 'x-admin-token': 'wrong-wrong-wrong-wrong-wrong' }));
    expect(await code(() => t.authorize(req({ 'x-admin-token': 'wrong-wrong-wrong-wrong-wrong' })))).toBe('rate_limited');
    expect(await t.authorize(req({ 'x-admin-token': ADMIN }))).toEqual({ actor: 'admin', role: 'owner' });
    const many = staff({ max: 3, windowMs: 60_000 });
    for (let n = 0; n < 10_050; n++) await many.authorize(req({ 'x-admin-token': 'wrong-wrong-wrong-wrong-wrong' }, `10.${n >> 16}.${(n >> 8) & 255}.${n & 255}`));
    expect(many.throttled()).toBeLessThanOrEqual(10_000);
  });

  it('end to end: 20 wrong header tokens are 401, the 21st is 429 with retry-after, a correct token is 200 throughout', async () => {
    const s = await start();
    for (let i = 0; i < 20; i++) expect((await me(s.base, `wrong-${i}-wrong-wrong-wrong-wrong`)).status).toBe(401);
    const over = await me(s.base, 'wrong-more-wrong-wrong-wrong');
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(((await over.json()) as { error: string }).error).toBe('rate_limited');
    expect((await me(s.base, ADMIN)).status).toBe(200);
    expect((await fetch(`${s.base}/admin/me`)).status).toBe(401);
  });

  it('end to end: the sign-in form is throttled after 20 wrong tokens (429 page, no cookie), and the right token still signs in', async () => {
    const s = await start();
    for (let i = 0; i < 20; i++) expect((await login(s.base, `wrong-${i}-wrong-wrong-wrong-wrong`)).status).toBe(401);
    const over = await login(s.base, 'wrong-more-wrong-wrong-wrong');
    expect(over.status).toBe(429);
    expect(over.headers.get('set-cookie')).toBeNull();
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await over.text()).toContain('Too many');
    const right = await login(s.base, ADMIN);
    expect(right.status).toBe(303);
    expect(right.headers.get('set-cookie')).toMatch(/^chatwarden_staff=/);
  });

  it('a throttled answer never echoes the presented token or the real one', async () => {
    const s = await start();
    for (let i = 0; i < 21; i++) await me(s.base, `PRESENTED-${i}-wrong-wrong-wrong`);
    const over = await me(s.base, 'PRESENTED-last-wrong-wrong');
    const text = JSON.stringify([over.status, await over.text(), [...over.headers.entries()]]);
    expect(text).not.toContain('PRESENTED');
    expect(text).not.toContain(ADMIN);
  });
});

describe('.env.example tells the owner how to make the staff token (m2)', () => {
  it('init --service writes an openssl line above each of the three secrets', async () => {
    const world = createWorld();
    expect(await runCli(['init', '--service', '--yes'], world.env)).toBe(0);
    const env = world.read('chatwarden-service/.env.example') as string;
    const lines = env.split(String.fromCharCode(10));
    for (const name of ['CHATWARDEN_SECRET=', 'CHATWARDEN_SERVICE_KEYS=', 'CHATWARDEN_ADMIN_TOKEN=']) {
      const at = lines.indexOf(name);
      expect(at, name).toBeGreaterThan(0);
      expect(lines[at - 1], name).toBe('# Make one with: openssl rand -base64 32');
    }
  });
});
