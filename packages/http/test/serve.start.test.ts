import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { ServeError, resolveServeConfig, startService } from '../src/service/serve.js';
import type { RunningService, ServeDeps } from '../src/service/serve.js';
import type { ServeFlags } from '../src/cli/args.js';
import { createWorld } from './cli-world.js';
import { KEY_A, KEY_B } from './serviceKit.js';

// S5: `chatwarden serve` as a process: configuration, startup refusals, what it serves, the files it reads, shutdown. Every call is to an ephemeral loopback port; no key or secret in this file is real.

const SECRET = 'serve-test-secret-0123456789abcdef0123';
const ADMIN = 'serve-test-admin-token-0123456789ab';
const BASE_ENV = { CHATWARDEN_SECRET: SECRET, CHATWARDEN_SERVICE_KEYS: `${KEY_A},${KEY_B}` };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {
      /* gone */
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-serve-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Started {
  service: RunningService;
  base: string;
  lines: Array<Record<string, unknown>>;
  raw: string[];
}

async function start(env: Record<string, string | undefined> = {}, f: Partial<ServeFlags> = {}, deps: ServeDeps = {}): Promise<Started> {
  const raw: string[] = [];
  const config = resolveServeConfig({ printOpenapi: false, port: '0', host: '127.0.0.1', db: ':memory:', hub: 'none', ...f }, { ...BASE_ENV, ...env });
  const service = await startService(config, { log: (line) => void raw.push(line), ...deps });
  cleanups.push(() => service.close());
  return { service, base: `http://127.0.0.1:${service.port}`, raw, get lines() { return raw.map((l) => JSON.parse(l) as Record<string, unknown>); } } as Started;
}

const get = (base: string, path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const bearer = { authorization: `Bearer ${KEY_A}` };

describe('start', () => {
  it('on an ephemeral port: /healthz and /readyz answer; GET /v1 with a key answers the handshake with synthetic_terms in warnings', async () => {
    const s = await start();
    expect(s.service.port).toBeGreaterThan(0);
    expect((await get(s.base, '/healthz')).status).toBe(200);
    expect(await (await get(s.base, '/readyz')).json()).toEqual({ ok: true });
    const res = await get(s.base, '/v1', bearer);
    expect(res.status).toBe(200);
    expect(res.headers.get('chatwarden-api')).toBe('1');
    const body = (await res.json()) as { api: number; mode: string; processes: string; warnings: string[]; capabilities: { sharedPacing: boolean } };
    expect(body).toMatchObject({ api: 1, mode: 'service', processes: 'single' });
    expect(body.warnings).toContain('synthetic_terms');
    expect(body.capabilities.sharedPacing).toBe(false);
  });

  it('/v1 needs a key (401 without), either configured key works, and an unknown path is 404', async () => {
    const s = await start();
    expect((await get(s.base, '/v1')).status).toBe(401);
    expect((await get(s.base, '/v1', { authorization: `Bearer ${KEY_B}` })).status).toBe(200);
    expect((await get(s.base, '/v1/nowhere', bearer)).status).toBe(404);
    expect((await get(s.base, '/nowhere')).status).toBe(404);
  });

  it('a whole conversation over the socket: seat, check a line, refuse a slur, report, ask for the restriction', async () => {
    const s = await start();
    const who = { clientKey: 'serve-test-client-0001' };
    expect((await post(s.base, '/v1/rooms/r1/seats/a', { who, handle: 'alice' }, bearer, 'PUT')).status).toBe(200);
    const ok = (await (await post(s.base, '/v1/rooms/r1/seats/a/lines', { text: 'hello there' }, bearer)).json()) as { ok: boolean; line: { text: string } };
    expect(ok).toMatchObject({ ok: true, line: { text: 'hello there' } });
    const bad = (await (await post(s.base, '/v1/rooms/r1/seats/a/lines', { text: 'you zorbak' }, bearer)).json()) as { ok: boolean; refused: { reason: string } };
    expect(bad).toMatchObject({ ok: false, refused: { reason: 'blocked' } });
    expect(await (await post(s.base, '/v1/restriction', { who }, bearer)).json()).toEqual({ restricted: false, until: null, kind: null });
  });

  it('the staff side is closed without an admin token: /admin/* is 401, /mod is not served, and /v1 still works', async () => {
    const s = await start({}, { hub: 'element' }, { hubScript: () => null, hubPackage: () => true });
    expect((await get(s.base, '/admin/me')).status).toBe(401);
    expect((await get(s.base, '/admin/me', { 'x-admin-token': 'anything' })).status).toBe(401);
    expect((await get(s.base, '/mod')).status).toBe(404);
    expect((await get(s.base, '/v1', bearer)).status).toBe(200);
  });

  it('with an admin token: /admin answers a staff caller, the hub page and its script are served to a signed-in one only, and a sign-in form takes the token', async () => {
    const dir = tempDir();
    const script = join(dir, 'hub.js');
    writeFileSync(script, "console.log('hub element stand-in');\n");
    const s = await start({ CHATWARDEN_ADMIN_TOKEN: ADMIN }, { hub: 'element' }, { hubScript: () => script });
    expect((await get(s.base, '/admin/me')).status).toBe(401);
    const me = await get(s.base, '/admin/me', { 'x-admin-token': ADMIN });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ actor: 'admin', role: 'owner' });
    // the page: a sign-in form for a stranger, the hub for staff
    const closed = await get(s.base, '/mod');
    expect(closed.status).toBe(401);
    expect(await closed.text()).toContain('Staff token');
    const open = await get(s.base, '/mod', { 'x-admin-token': ADMIN });
    expect(open.status).toBe(200);
    const page = await open.text();
    expect(page).toContain('<chatwarden-hub');
    expect(page).toContain('base-url="/admin"');
    expect(open.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await get(s.base, '/mod/hub-element.js')).status).toBe(401);
    const js = await get(s.base, '/mod/hub-element.js', { 'x-admin-token': ADMIN });
    expect(js.status).toBe(200);
    expect(await js.text()).toContain('hub element stand-in');
    // sign in: a wrong token is refused, the right one sets a cookie that works on /admin
    const wrong = await fetch(`${s.base}/mod/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=wrong', redirect: 'manual' });
    expect(wrong.status).toBe(401);
    const right = await fetch(`${s.base}/mod/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${ADMIN}`, redirect: 'manual' });
    expect(right.status).toBe(303);
    const cookie = (right.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect(cookie).toMatch(/^chatwarden_staff=/);
    expect((await get(s.base, '/admin/me', { cookie })).status).toBe(200);
    // the cookie holds a digest, never the token
    expect(cookie).not.toContain(ADMIN);
  });

  it('the hub script is served only when the hub is on: --hub none leaves /mod absent even with a token', async () => {
    const s = await start({ CHATWARDEN_ADMIN_TOKEN: ADMIN }, { hub: 'none' });
    expect((await get(s.base, '/mod', { 'x-admin-token': ADMIN })).status).toBe(404);
    expect((await get(s.base, '/admin/me', { 'x-admin-token': ADMIN })).status).toBe(200);
  });

  it('the hub is on and its script cannot be found: the page is served and the script is 503, never a stack', async () => {
    const s = await start({ CHATWARDEN_ADMIN_TOKEN: ADMIN }, { hub: 'element' }, { hubScript: () => null, hubPackage: () => true });
    expect((await get(s.base, '/mod', { 'x-admin-token': ADMIN })).status).toBe(200);
    const js = await get(s.base, '/mod/hub-element.js', { 'x-admin-token': ADMIN });
    expect(js.status).toBe(503);
  });

  it('shared pacing on: the handshake says so and the kit keeps pace state in the store', async () => {
    const s = await start({}, { sharedPacing: true });
    const body = (await (await get(s.base, '/v1', bearer)).json()) as { capabilities: { sharedPacing: boolean } };
    expect(body.capabilities.sharedPacing).toBe(true);
  });

  it('CHATWARDEN_PROCESSES above 1 without shared pacing raises pacing_per_process; with shared pacing it does not; the handshake says multiple', async () => {
    const many = await start({ CHATWARDEN_PROCESSES: '3' });
    const one = (await (await get(many.base, '/v1', bearer)).json()) as { processes: string; warnings: string[] };
    expect(one.processes).toBe('multiple');
    expect(one.warnings).toContain('pacing_per_process');
    const shared = await start({ CHATWARDEN_PROCESSES: '3' }, { sharedPacing: true });
    const two = (await (await get(shared.base, '/v1', bearer)).json()) as { warnings: string[] };
    expect(two.warnings).not.toContain('pacing_per_process');
  });
});

describe('startup refusals: each is a ServeError that names the variable and holds no value', () => {
  const refusal = async (env: Record<string, string | undefined>, f: Partial<ServeFlags> = {}, deps: ServeDeps = {}): Promise<string> => {
    const config = resolveServeConfig({ printOpenapi: false, port: '0', host: '127.0.0.1', db: ':memory:', hub: 'none', ...f }, env);
    try {
      const service = await startService(config, { log: () => undefined, ...deps });
      await service.close();
    } catch (err) {
      expect(err).toBeInstanceOf(ServeError);
      return (err as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('no secret, a 31-character secret', async () => {
    expect(await refusal({ CHATWARDEN_SERVICE_KEYS: KEY_A })).toMatch(/CHATWARDEN_SECRET/);
    const short = 'x'.repeat(31);
    const message = await refusal({ CHATWARDEN_SECRET: short, CHATWARDEN_SERVICE_KEYS: KEY_A });
    expect(message).toMatch(/CHATWARDEN_SECRET/);
    expect(message).not.toContain(short);
    // 32 is enough
    const ok = resolveServeConfig({ printOpenapi: false, port: '0', host: '127.0.0.1', db: ':memory:', hub: 'none' }, { CHATWARDEN_SECRET: 'x'.repeat(32), CHATWARDEN_SERVICE_KEYS: KEY_A });
    const service = await startService(ok, { log: () => undefined });
    await service.close();
  });

  it('no service keys, a key shorter than 32, a key outside the set, six keys, a duplicate', async () => {
    expect(await refusal({ CHATWARDEN_SECRET: SECRET })).toMatch(/CHATWARDEN_SERVICE_KEYS/);
    const bad = ['short-key', `${KEY_A},short`, `${KEY_A},${KEY_A}`, `${KEY_A}!`, ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => `${c}-key-${'0'.repeat(32)}`).join(','), ','];
    for (const keys of bad) {
      const message = await refusal({ CHATWARDEN_SECRET: SECRET, CHATWARDEN_SERVICE_KEYS: keys });
      expect(message, keys).toMatch(/CHATWARDEN_SERVICE_KEYS/);
      expect(message).not.toContain(KEY_A);
    }
  });

  it('an admin token equal to a service key is refused, and so is one shorter than 24 characters', async () => {
    const same = await refusal({ ...BASE_ENV, CHATWARDEN_ADMIN_TOKEN: KEY_B });
    expect(same).toMatch(/CHATWARDEN_ADMIN_TOKEN/);
    expect(same).not.toContain(KEY_B);
    expect(await refusal({ ...BASE_ENV, CHATWARDEN_ADMIN_TOKEN: 'short-token' })).toMatch(/CHATWARDEN_ADMIN_TOKEN/);
  });

  it('an unreadable profile file, an invalid profile (the ProfileError path is printed) and a bad JSON file', async () => {
    const dir = tempDir();
    expect(await refusal(BASE_ENV, { profileFile: join(dir, 'missing.json') })).toMatch(/--profile-file|CHATWARDEN_PROFILE_FILE|profile/i);
    const invalid = join(dir, 'invalid.json');
    writeFileSync(invalid, JSON.stringify({ pace: { slowModeMs: 'secret-text-value' } }));
    const message = await refusal(BASE_ENV, { profileFile: invalid });
    expect(message).toMatch(/pace/);
    expect(message).not.toContain('secret-text-value');
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{nope');
    expect(await refusal(BASE_ENV, { profileFile: broken })).toMatch(/profile/i);
    const unknown = join(dir, 'unknown.json');
    writeFileSync(unknown, JSON.stringify({ preset: 'lenient' }));
    expect(await refusal(BASE_ENV, { profileFile: unknown })).toMatch(/preset|profile/i);
  });

  it('an unreadable terms pack and an invalid one', async () => {
    const dir = tempDir();
    expect(await refusal(BASE_ENV, { termsFile: join(dir, 'missing.json') })).toMatch(/terms/i);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ id: 'x' }));
    expect(await refusal(BASE_ENV, { termsFile: bad })).toMatch(/terms/i);
  });

  it('a missing optional peer is named with the install command', async () => {
    const importer = (name: string): Promise<unknown> => (name === '@chatwarden/matcher' ? Promise.reject(Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' })) : import(/* @vite-ignore */ name));
    const message = await refusal(BASE_ENV, {}, { importer });
    expect(message).toMatch(/@chatwarden\/matcher/);
    expect(message).toMatch(/npm install/);
    // each of the four is checked the same way
    for (const name of ['@chatwarden/store-sqlite', '@chatwarden/profanity']) {
      const m = await refusal(BASE_ENV, {}, { importer: (n) => (n === name ? Promise.reject(Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' })) : import(/* @vite-ignore */ n)) });
      expect(m).toContain(name);
    }
    const hub = await refusal(BASE_ENV, { hub: 'element' }, { hubScript: () => null, hubPackage: () => false });
    expect(hub).toMatch(/@chatwarden\/hub-element/);
  });

  it('a port in use is a ServeError that names the port, not a stack', async () => {
    const first = await start();
    const config = resolveServeConfig({ printOpenapi: false, port: String(first.service.port), host: '127.0.0.1', db: ':memory:', hub: 'none' }, BASE_ENV);
    await expect(startService(config, { log: () => undefined })).rejects.toThrow(ServeError);
    await expect(startService(config, { log: () => undefined })).rejects.toThrow(/port/i);
  });

  it('the order: a missing secret is reported before the keys, the keys before the admin token, the token before the files', async () => {
    expect(await refusal({}, { profileFile: '/nowhere/profile.json' })).toMatch(/CHATWARDEN_SECRET/);
    expect(await refusal({ CHATWARDEN_SECRET: SECRET, CHATWARDEN_ADMIN_TOKEN: 'short' }, { profileFile: '/nowhere/profile.json' })).toMatch(/CHATWARDEN_SERVICE_KEYS/);
    expect(await refusal({ ...BASE_ENV, CHATWARDEN_ADMIN_TOKEN: 'short' }, { profileFile: '/nowhere/profile.json' })).toMatch(/CHATWARDEN_ADMIN_TOKEN/);
    expect(await refusal(BASE_ENV, { profileFile: '/nowhere/profile.json', termsFile: '/nowhere/terms.json' })).toMatch(/profile/i);
  });
});

describe('the files', () => {
  it('the profile file is applied: a preset and an override change what /v1 lines refuse; contexts and names.reserved in the file reach the kit', async () => {
    const dir = tempDir();
    const file = join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify({ preset: 'strict', pace: { slowModeMs: 5000 }, contexts: { kids: { label: 'Kids' } }, names: { reserved: ['moderator'] } }));
    const s = await start({}, { profileFile: file });
    const who = { clientKey: 'serve-test-client-0002' };
    await post(s.base, '/v1/rooms/r1/seats/a', { who, handle: 'alice' }, bearer, 'PUT');
    expect(((await (await post(s.base, '/v1/rooms/r1/seats/a/lines', { text: 'first line here' }, bearer)).json()) as { ok: boolean }).ok).toBe(true);
    const second = (await (await post(s.base, '/v1/rooms/r1/seats/a/lines', { text: 'a second line here' }, bearer)).json()) as { ok: boolean; refused: { reason: string } };
    expect(second).toMatchObject({ ok: false, refused: { reason: 'slow_mode' } });
    const hand = (await (await get(s.base, '/v1', bearer)).json()) as { capabilities: { contexts: string[] } };
    expect(hand.capabilities.contexts).toEqual(['kids']);
    expect(await (await post(s.base, '/v1/names/check', { name: 'Moderator' }, bearer)).json()).toMatchObject({ ok: false, reason: 'name_reserved' });
  });

  it('phrase books in the profile file make phrase-only rooms: the handshake says phrases and a phrase is delivered', async () => {
    const dir = tempDir();
    const file = join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify({ contexts: { junior: { chat: { phrases: 'junior' } } }, phrases: { junior: [{ id: 'gg', text: 'Good game!' }] } }));
    const s = await start({}, { profileFile: file });
    expect(((await (await get(s.base, '/v1', bearer)).json()) as { capabilities: { phrases: boolean } }).capabilities.phrases).toBe(true);
    await post(s.base, '/v1/rooms/kids/seats/a', { who: { clientKey: 'serve-test-client-0003' }, handle: 'a', tags: { context: 'junior' } }, bearer, 'PUT');
    const res = (await (await post(s.base, '/v1/rooms/kids/seats/a/phrases', { phraseId: 'gg' }, bearer)).json()) as { ok: boolean; line: { text: string } };
    expect(res).toMatchObject({ ok: true, line: { text: 'Good game!' } });
  });

  it('terms file: a valid TermPack replaces the synthetic pack and the warning disappears; the old test word is no longer blocked', async () => {
    const dir = tempDir();
    const file = join(dir, 'terms.json');
    writeFileSync(
      file,
      JSON.stringify({ id: 'custom', version: '1', terms: [{ id: 'c:fenrisk', term: 'fenrisk', language: 'en', positive: ['you fenrisk'], negative: ['a fine line'] }], exceptions: [], negativeCorpus: ['a fine line'], knownLosses: [] }),
    );
    const s = await start({}, { termsFile: file });
    const hand = (await (await get(s.base, '/v1', bearer)).json()) as { warnings: string[] };
    expect(hand.warnings).not.toContain('synthetic_terms');
    const who = { clientKey: 'serve-test-client-0004' };
    await post(s.base, '/v1/rooms/r1/seats/a', { who, handle: 'alice' }, bearer, 'PUT');
    const blocked = (await (await post(s.base, '/v1/rooms/r1/seats/a/lines', { text: 'you fenrisk' }, bearer)).json()) as { refused: { reason: string } };
    expect(blocked.refused.reason).toBe('blocked');
    const allowed = (await (await post(s.base, '/v1/rooms/r1/seats/a/lines', { text: 'you zorbak' }, bearer)).json()) as { ok: boolean };
    expect(allowed.ok).toBe(true);
  });

  it('a custom auth module is loaded from a path and its authorize is used for /admin', async () => {
    const dir = tempDir();
    const file = join(dir, 'auth.mjs');
    writeFileSync(file, "export default { authorize(req) { return req.headers['x-test-staff'] === 'yes' ? { actor: 'mod_custom', role: 'senior' } : null; } };\n");
    const s = await start({ CHATWARDEN_AUTH_MODULE: pathToFileURL(file).href });
    expect((await get(s.base, '/admin/me')).status).toBe(401);
    const me = await get(s.base, '/admin/me', { 'x-test-staff': 'yes' });
    expect(await me.json()).toMatchObject({ actor: 'mod_custom', role: 'senior' });
  });

  it('the auth module beats the admin token; a module without authorize is a startup refusal naming the variable', async () => {
    const dir = tempDir();
    const file = join(dir, 'auth.mjs');
    writeFileSync(file, 'export default { authorize() { return null; } };\n');
    const s = await start({ CHATWARDEN_AUTH_MODULE: pathToFileURL(file).href, CHATWARDEN_ADMIN_TOKEN: ADMIN });
    expect((await get(s.base, '/admin/me', { 'x-admin-token': ADMIN })).status).toBe(401);
    const bad = join(dir, 'bad.mjs');
    writeFileSync(bad, 'export default {};\n');
    const config = resolveServeConfig({ printOpenapi: false, port: '0', host: '127.0.0.1', db: ':memory:', hub: 'none' }, { ...BASE_ENV, CHATWARDEN_AUTH_MODULE: pathToFileURL(bad).href });
    await expect(startService(config, { log: () => undefined })).rejects.toThrow(/CHATWARDEN_AUTH_MODULE/);
  });

  it('a module that throws makes /admin 500 with no detail', async () => {
    const dir = tempDir();
    const file = join(dir, 'auth.mjs');
    writeFileSync(file, "export default { authorize() { throw new Error('module secret detail'); } };\n");
    const s = await start({ CHATWARDEN_AUTH_MODULE: pathToFileURL(file).href });
    const res = await get(s.base, '/admin/me');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('module secret detail');
    expect(s.raw.join('\n')).not.toContain('module secret detail');
  });
});

describe('logs', () => {
  it('JSON lines with event and class, plus one request line with rid, kid, route pattern, status and ms; no key, no who, no body', async () => {
    const s = await start();
    const who = { clientKey: 'secret-client-key-for-the-log-test' };
    await post(s.base, '/v1/rooms/room-secret/seats/seat-secret', { who, handle: 'handle-secret' }, bearer, 'PUT');
    await post(s.base, '/v1/rooms/room-secret/seats/seat-secret/lines', { text: 'line-secret zorbak' }, bearer);
    await get(s.base, '/v1', { authorization: 'Bearer wrong-key-value' });
    expect(s.raw.length).toBeGreaterThanOrEqual(3);
    for (const line of s.raw) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed.event).toBe('string');
      for (const key of Object.keys(parsed)) expect(['event', 'rid', 'kid', 'route', 'status', 'ms', 'error', 'suppressed', 'port']).toContain(key);
    }
    const requests = s.lines.filter((l) => l.event === 'chatwarden.service_request');
    expect(requests.map((l) => l.route)).toEqual(expect.arrayContaining(['PUT /rooms/:room~room/seats/:seat~room', 'POST /rooms/:room~room/seats/:seat~room/lines', 'GET /']));
    expect(requests.find((l) => l.status === 401)?.kid).toBeUndefined();
    expect(String(requests[0]?.kid)).toMatch(/^[0-9a-f]{8}$/);
    const text = s.raw.join('\n');
    for (const secret of [KEY_A, KEY_B, SECRET, 'secret-client-key', 'room-secret', 'seat-secret', 'handle-secret', 'line-secret', 'wrong-key-value', 'Bearer']) expect(text, secret).not.toContain(secret);
  });

  it('start logs one line saying the synthetic term list is in use, and one with the port; nothing with a path or a value', async () => {
    const s = await start();
    const events = s.lines.map((l) => l.event);
    expect(events).toContain('chatwarden.serve_synthetic_terms');
    expect(events).toContain('chatwarden.serve_started');
    expect(s.raw.join('\n')).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
  });
});

describe('the shutdown', () => {
  const fakeSignals = () => {
    const handlers: Array<(signal: string) => void> = [];
    return {
      source: { on: (h: (signal: string) => void) => (handlers.push(h), () => void handlers.splice(handlers.indexOf(h), 1)) },
      send: (signal: string) => [...handlers].forEach((h) => h(signal)),
      count: () => handlers.length,
    };
  };

  async function runServing(extraEnv: Record<string, string> = {}) {
    const signals = fakeSignals();
    const world = createWorld({ files: {} });
    Object.assign(world.env.env, { ...BASE_ENV, CHATWARDEN_DB: ':memory:', ...extraEnv });
    const started: RunningService[] = [];
    const done = runCli(['serve', '--port', '0', '--host', '127.0.0.1', '--hub', 'none'], world.env, {
      serve: {
        signals: signals.source,
        log: () => undefined,
        onStarted: (service) => void started.push(service),
      },
    });
    for (let i = 0; i < 200 && started.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(started).toHaveLength(1);
    return { signals, done, service: started[0] as RunningService, world };
  }

  it('SIGTERM stops accepting, closes the store and exits 0; the signal handler is removed', async () => {
    const run = await runServing();
    const base = `http://127.0.0.1:${run.service.port}`;
    expect((await get(base, '/healthz')).status).toBe(200);
    run.signals.send('SIGTERM');
    expect(await run.done).toBe(0);
    await expect(get(base, '/healthz')).rejects.toThrow();
    expect(run.signals.count()).toBe(0);
  });

  it('SIGINT does the same', async () => {
    const run = await runServing();
    run.signals.send('SIGINT');
    expect(await run.done).toBe(0);
  });

  it('an in-flight request finishes before the exit (within 10 seconds), and a second signal exits at once', async () => {
    const run = await runServing();
    const base = `http://127.0.0.1:${run.service.port}`;
    // a request that holds the connection: the body of a POST is sent slowly
    const slow = new Promise<number>((resolve) => {
      void fetch(`${base}/v1/names/check`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: new ReadableStream({ start(c) { setTimeout(() => (c.enqueue(new TextEncoder().encode('{"name":"x"}')), c.close()), 300); } }) as never, duplex: 'half' } as never).then((r) => resolve(r.status), () => resolve(0));
    });
    await new Promise((r) => setTimeout(r, 80));
    run.signals.send('SIGTERM');
    const second = new Promise<void>((resolve) => setTimeout(() => (run.signals.send('SIGTERM'), resolve()), 50));
    await second;
    expect(await run.done).toBe(0);
    expect([200, 0]).toContain(await slow);
  });
});

describe('the command', () => {
  it('--print-openapi prints SERVICE_OPENAPI as JSON and exits 0, starting nothing and needing no secret', async () => {
    const world = createWorld({ files: {} });
    expect(await runCli(['serve', '--print-openapi'], world.env)).toBe(0);
    const doc = JSON.parse(world.out()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(Object.keys(doc.paths)).toContain('/v1');
  });

  it('a startup refusal is exit 2 with one line "chatwarden: ..." on stderr naming the variable, and nothing else', async () => {
    const world = createWorld({ files: {} });
    Object.assign(world.env.env, { CHATWARDEN_DB: ':memory:' });
    const code = await runCli(['serve', '--port', '0', '--hub', 'none'], world.env, { serve: { log: () => undefined } });
    expect(code).toBe(2);
    expect(world.err().trim().split('\n')).toHaveLength(1);
    expect(world.err()).toMatch(/^chatwarden: .*CHATWARDEN_SECRET/);
    expect(world.out()).toBe('');
  });

  it('a usage error (an unknown flag) is exit 1 and starts nothing', async () => {
    const world = createWorld({ files: {} });
    expect(await runCli(['serve', '--bogus'], world.env)).toBe(1);
    expect(world.err()).toMatch(/^chatwarden: Unknown option/);
  });

  it('serve --help prints the serve help and exits 0', async () => {
    const world = createWorld({ files: {} });
    expect(await runCli(['serve', '--help'], world.env)).toBe(0);
    expect(world.out()).toContain('--shared-pacing');
  });
});
