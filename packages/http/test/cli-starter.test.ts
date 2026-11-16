/* eslint-disable @typescript-eslint/no-explicit-any */
import * as nodeCrypto from 'node:crypto';
import ts from 'typescript';
import * as core from '@chatwarden/core';
import * as discord from '@chatwarden/discord';
import * as httpChat from '@chatwarden/http/chat';
import * as matcher from '@chatwarden/matcher';
import * as fixtures from '@chatwarden/matcher/fixtures';
import * as profanity from '@chatwarden/profanity';
import * as storeMemory from '@chatwarden/store-memory';
import * as storeSqlite from '@chatwarden/store-sqlite';
import { describe, expect, it } from 'vitest';
import { renderAll } from '../src/cli/templates/index.js';
import type { Answers } from '../src/cli/types.js';
import { VERSIONS, answersOf } from './cli-stubs.js';

// The starter (design 7): what a first run needs and a production run must replace. These tests render the generated files, compile them
// with TypeScript, and run them against the real kit over the in-memory store, with a fake `process` and `console` so each test sets the
// environment and sees what was logged.

const TOKEN = 'vlemmo-staff-token-of-good-length-0001';
const SECRET = 'quissel-secret-comfortably-over-thirty-two-characters';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/zorbak_vlemmo-quissel';

interface Loaded {
  kit: any;
  auth: any;
  terms: any;
  warns: string[];
  logs: string[];
  /** How many times the generated code called crypto.timingSafeEqual. */
  compared: () => number;
  env: Record<string, string | undefined>;
}

function load(over: Partial<Answers>, env: Record<string, string | undefined> = {}, replace: Record<string, unknown> = {}): Loaded {
  const answers = answersOf({ store: 'memory', ...over });
  const sources = new Map(renderAll(answers, VERSIONS).filter((f) => /\.ts$/.test(f.path)).map((f) => [f.path.slice(answers.dir.length + 1).replace(/\.ts$/, ''), f.content]));
  const warns: string[] = [];
  const logs: string[] = [];
  let timingCalls = 0;
  const fakeProcess = { env: { ...env } as Record<string, string | undefined> };
  const fakeConsole = {
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    log: (...args: unknown[]) => void logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => void logs.push(args.map(String).join(' ')),
  };
  const crypto = { ...nodeCrypto, timingSafeEqual: (a: any, b: any) => (timingCalls += 1, nodeCrypto.timingSafeEqual(a, b)) };
  const external: Record<string, unknown> = {
    'node:crypto': crypto,
    '@chatwarden/core': core,
    '@chatwarden/matcher': matcher,
    '@chatwarden/matcher/fixtures': fixtures,
    '@chatwarden/profanity': profanity,
    '@chatwarden/store-memory': storeMemory,
    '@chatwarden/store-sqlite': storeSqlite,
    '@chatwarden/http/chat': httpChat,
    '@chatwarden/discord': discord,
    '@chatwarden/http': {},
    ...replace,
  };
  const registry = new Map<string, { exports: any }>();
  const local = (name: string): any => {
    const cached = registry.get(name);
    if (cached) return cached.exports;
    const source = sources.get(name);
    if (source === undefined) throw new Error(`the rendering has no ${name}`);
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} as any };
    registry.set(name, mod);
    new Function('require', 'exports', 'module', 'process', 'console', js)(requireFrom, mod.exports, mod, fakeProcess, fakeConsole);
    return mod.exports;
  };
  const requireFrom = (specifier: string): unknown => {
    if (specifier.startsWith('./')) return local(specifier.slice(2).replace(/\.js$/, ''));
    if (!(specifier in external)) throw new Error(`the rendering imports ${specifier}, which this test does not provide`);
    return external[specifier];
  };
  return {
    get kit() { return local('kit'); },
    get auth() { return local('auth'); },
    get terms() { return local('terms'); },
    warns,
    logs,
    compared: () => timingCalls,
    env: fakeProcess.env,
  };
}

const request = (headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): any => ({ method: 'GET', path: '/chatwarden/admin/reports', query: {}, headers, body: undefined, ...extra });
const OWNER = { actor: 'admin', role: 'owner' };
const withToken = (over: Partial<Answers> = {}, env: Record<string, string | undefined> = {}): Loaded => load(over, { CHATWARDEN_SECRET: SECRET, CHATWARDEN_ADMIN_TOKEN: TOKEN, ...env });
const cookieOf = (setCookie: string): string => setCookie.split(';')[0]!;

describe('authorize (staff)', () => {
  it('with no CHATWARDEN_ADMIN_TOKEN authorize returns null for a request with the right header, the right cookie and none', () => {
    const signedIn = withToken();
    const cookie = cookieOf(signedIn.auth.signIn(TOKEN));
    const none = load({}, { CHATWARDEN_SECRET: SECRET });
    expect(none.auth.authorize(request({ 'x-admin-token': TOKEN }))).toBeNull();
    expect(none.auth.authorize(request({ cookie }))).toBeNull();
    expect(none.auth.authorize(request())).toBeNull();
    // Unset by the host the same way: an empty string is not a token either.
    const empty = load({}, { CHATWARDEN_SECRET: SECRET, CHATWARDEN_ADMIN_TOKEN: '' });
    expect(empty.auth.authorize(request({ 'x-admin-token': '' }))).toBeNull();
    expect(empty.auth.authorize(request({ 'x-admin-token': TOKEN }))).toBeNull();
  });

  it('a token under 24 characters is the same as none', () => {
    for (const short of ['a', 'x'.repeat(23), 'zorbak']) {
      const loaded = withToken({}, { CHATWARDEN_ADMIN_TOKEN: short });
      expect(loaded.auth.authorize(request({ 'x-admin-token': short })), short).toBeNull();
      expect(loaded.auth.signIn(short), short).toBeNull();
    }
    const exactly24 = 'x'.repeat(24);
    const ok = withToken({}, { CHATWARDEN_ADMIN_TOKEN: exactly24 });
    expect(ok.auth.authorize(request({ 'x-admin-token': exactly24 }))).toEqual(OWNER);
  });

  it('with a long token the header and the cookie both authorize, a wrong one does not, a near-miss of the same length does not (timing-safe path taken)', () => {
    const loaded = withToken();
    const { authorize, signIn } = loaded.auth;
    expect(authorize(request({ 'x-admin-token': TOKEN }))).toEqual(OWNER);
    expect(authorize(request({ cookie: cookieOf(signIn(TOKEN)) }))).toEqual(OWNER);
    expect(authorize(request({ cookie: `other=1; ${cookieOf(signIn(TOKEN))}; more=2` }))).toEqual(OWNER);

    const before = loaded.compared();
    const nearMiss = `${TOKEN.slice(0, -1)}X`;
    expect(nearMiss).toHaveLength(TOKEN.length);
    expect(authorize(request({ 'x-admin-token': nearMiss }))).toBeNull();
    expect(loaded.compared()).toBeGreaterThan(before);
    expect(authorize(request({ 'x-admin-token': 'wrong' }))).toBeNull();
    expect(authorize(request({ 'x-admin-token': `${TOKEN}extra` }))).toBeNull();
    expect(authorize(request({ 'x-admin-token': TOKEN.slice(1) }))).toBeNull();
    expect(authorize(request({ 'x-admin-token': '' }))).toBeNull();
    expect(authorize(request())).toBeNull();
    expect(authorize(request({ cookie: 'chatwarden_staff=nope' }))).toBeNull();
    expect(authorize(request({ cookie: 'chatwarden_staff=' }))).toBeNull();
    expect(authorize(request({ cookie: 'chatwarden_staff' }))).toBeNull();
    expect(authorize(request({ cookie: '%E0%A4%A' }))).toBeNull();
    // The cookie is not the token: presenting the token as the cookie does not sign anyone in.
    expect(authorize(request({ cookie: `chatwarden_staff=${TOKEN}` }))).toBeNull();
    // A cookie signed under another secret does not sign in here.
    const other = withToken({}, { CHATWARDEN_SECRET: `${SECRET}-changed` });
    expect(authorize(request({ cookie: cookieOf(other.auth.signIn(TOKEN)) }))).toBeNull();
    // A wrong header is not rescued by a good cookie; a good header is not spoiled by a bad cookie.
    expect(authorize(request({ 'x-admin-token': nearMiss, cookie: cookieOf(signIn(TOKEN)) }))).toBeNull();
    expect(authorize(request({ 'x-admin-token': TOKEN, cookie: 'chatwarden_staff=nope' }))).toEqual(OWNER);
  });

  it('returns a new object each time, with an actor and a role the kit accepts', () => {
    const { authorize } = withToken().auth;
    const a = authorize(request({ 'x-admin-token': TOKEN }));
    const b = authorize(request({ 'x-admin-token': TOKEN }));
    expect(a).not.toBe(b);
    expect(core.ROLES).toContain(a.role);
    expect(typeof a.actor).toBe('string');
  });

  it('the cookie is an HMAC, is not equal to the token, and changes with the secret', () => {
    const one = withToken();
    const setCookie: string = one.auth.signIn(TOKEN);
    const value = cookieOf(setCookie).split('=')[1]!;
    expect(value).toBe(nodeCrypto.createHmac('sha256', SECRET).update(TOKEN).digest('hex'));
    expect(value).not.toBe(TOKEN);
    expect(setCookie).not.toContain(TOKEN);
    const two = withToken({}, { CHATWARDEN_SECRET: `${SECRET}-changed` });
    expect(cookieOf(two.auth.signIn(TOKEN))).not.toBe(cookieOf(setCookie));
    // A different token under the same secret is a different cookie.
    const three = withToken({}, { CHATWARDEN_ADMIN_TOKEN: `${TOKEN}-2` });
    expect(cookieOf(three.auth.signIn(`${TOKEN}-2`))).not.toBe(cookieOf(setCookie));
  });

  it('the sign-in cookie is HttpOnly, SameSite=Strict, scoped to the base path, and Secure only in production', () => {
    const dev = withToken().auth.signIn(TOKEN) as string;
    expect(dev).toContain('HttpOnly');
    expect(dev).toContain('SameSite=Strict');
    expect(dev).toContain('Path=/chatwarden');
    expect(dev).not.toContain('Secure');
    const prod = withToken({}, { NODE_ENV: 'production' }).auth.signIn(TOKEN) as string;
    expect(prod).toContain('Secure');
    expect(prod).toContain('HttpOnly');
    const custom = withToken({ base: '/tarvo' }).auth.signIn(TOKEN) as string;
    expect(custom).toContain('Path=/tarvo');
    expect(custom).not.toContain('Path=/chatwarden');
  });

  it('signIn refuses a wrong token, a missing one and a non-string', () => {
    const { signIn } = withToken().auth;
    for (const bad of ['wrong', '', undefined, null, 42, {}, [TOKEN], `${TOKEN} `, TOKEN.toUpperCase()]) expect(signIn(bad), String(bad)).toBeNull();
    expect(signIn(TOKEN)).toEqual(expect.stringContaining('chatwarden_staff='));
  });

  it('in production it announces once that the starter sign-in is on; in development and with no token it is silent', () => {
    const prod = withToken({}, { NODE_ENV: 'production' });
    prod.auth.announce();
    prod.auth.announce();
    expect(prod.warns).toHaveLength(1);
    expect(prod.warns[0]).toMatch(/starter staff sign-in is on; replace authorize\(\) with your own/);
    const dev = withToken();
    dev.auth.announce();
    expect(dev.warns).toEqual([]);
    const noToken = load({}, { CHATWARDEN_SECRET: SECRET, NODE_ENV: 'production' });
    noToken.auth.announce();
    expect(noToken.warns).toEqual([]);
  });
});

describe('secretFromEnv', () => {
  it('production without CHATWARDEN_SECRET, or with one under 32 characters, throws a message naming the variable', () => {
    for (const secret of [undefined, '', 'a', 'x'.repeat(31)]) {
      const loaded = load({ framework: 'none', hub: 'none' }, { NODE_ENV: 'production', ...(secret === undefined ? {} : { CHATWARDEN_SECRET: secret }) });
      expect(() => loaded.kit.secretFromEnv(), String(secret)).toThrow(/CHATWARDEN_SECRET/);
      expect(() => loaded.kit.secretFromEnv()).toThrow(/randomBytes\(32\)/);
    }
    const exactly32 = load({ framework: 'none', hub: 'none' }, { NODE_ENV: 'production', CHATWARDEN_SECRET: 'x'.repeat(32) });
    expect(exactly32.kit.secretFromEnv()).toBe('x'.repeat(32));
    expect(exactly32.warns).toEqual([]);
  });

  it('the error never carries the secret it was given', () => {
    const loaded = load({ framework: 'none', hub: 'none' }, { NODE_ENV: 'production', CHATWARDEN_SECRET: 'short-zorbak' });
    try {
      loaded.kit.secretFromEnv();
      throw new Error('should have thrown');
    } catch (cause) {
      expect(String((cause as Error).message)).not.toContain('short-zorbak');
    }
  });

  it('development logs once and uses the fixed string', () => {
    const loaded = load({ framework: 'none', hub: 'none' }, {});
    const first = loaded.kit.secretFromEnv();
    const second = loaded.kit.secretFromEnv();
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(loaded.warns).toHaveLength(1);
    expect(loaded.warns[0]).toMatch(/CHATWARDEN_SECRET/);
    expect(loaded.warns[0]).toMatch(/development secret/);
    // The same constant in another start: a fixed string, not a random one.
    expect(load({ framework: 'none', hub: 'none' }, {}).kit.secretFromEnv()).toBe(first);
  });

  it('development with a secret set uses it, and logs nothing', () => {
    const loaded = load({ framework: 'none', hub: 'none' }, { CHATWARDEN_SECRET: 'short' });
    expect(loaded.kit.secretFromEnv()).toBe('short');
    expect(loaded.warns).toEqual([]);
  });

  it('createKit in production without a secret throws before it opens a store', async () => {
    const loaded = load({ store: 'sqlite' }, { NODE_ENV: 'production', CHATWARDEN_DB: ':memory:' });
    await expect(loaded.kit.createKit()).rejects.toThrow(/CHATWARDEN_SECRET/);
  });
});

describe('terms', () => {
  it('production with the synthetic pack logs one warning; development logs none', async () => {
    const prod = load({ framework: 'none', hub: 'none' }, { NODE_ENV: 'production', CHATWARDEN_SECRET: SECRET });
    await prod.terms.loadMatcher();
    expect(prod.warns).toHaveLength(1);
    expect(prod.warns[0]).toMatch(/synthetic/i);
    const dev = load({ framework: 'none', hub: 'none' }, {});
    await dev.terms.loadMatcher();
    expect(dev.warns).toEqual([]);
  });

  it('the starter blocks the synthetic words and lets ordinary text through (it is wired to a real matcher)', async () => {
    const loaded = load({ framework: 'none', hub: 'none' }, {});
    const terms = await loaded.terms.loadMatcher();
    expect(terms.match('you zorbak')).not.toBeNull();
    expect(terms.match('good game everyone')).toBeNull();
  });

  it('the sqlite variant takes the store it is given and keeps its words there', async () => {
    const loaded = load({ store: 'sqlite', framework: 'none', hub: 'none' }, {});
    const store = storeSqlite.openStore({ path: ':memory:' });
    const terms = await loaded.terms.loadMatcher(store);
    expect(terms.match('zorbak')).not.toBeNull();
    expect(store.listTerms().length).toBeGreaterThan(0);
    expect(store.isSeeded('synthetic')).toBe(true);
    store.close();
  });

  it('once the store holds a term of its own the production warning stops', async () => {
    const loaded = load({ store: 'sqlite', framework: 'none', hub: 'none' }, { NODE_ENV: 'production' });
    const store = storeSqlite.openStore({ path: ':memory:' });
    store.insertTerm({ id: 'mine-1', term: 'glarnoo', language: 'en', active: true, note: null, addedBy: 'owner', addedAt: 1, updatedBy: null, updatedAt: null });
    await loaded.terms.loadMatcher(store);
    expect(loaded.warns).toEqual([]);
    store.close();
  });
});

describe('join (chat names)', () => {
  it('returns null for any room but lobby, names count per key and never contain any part of it, the table stops at 400', () => {
    const { join } = withToken({ chat: 'box' }).auth;
    expect(join(request({ 'x-chatwarden-key': 'k1' }), 'lobby')).toEqual({ name: 'Player 1' });
    for (const room of ['other', 'Lobby', '', 'lobby ', 'lobby/../x', '__proto__', 'constructor']) expect(join(request({ 'x-chatwarden-key': 'k1' }), room), room).toBeNull();
    // The same key keeps its number; a new key takes the next one.
    expect(join(request({ 'x-chatwarden-key': 'k1' }), 'lobby')).toEqual({ name: 'Player 1' });
    expect(join(request({ 'x-chatwarden-key': 'k2' }), 'lobby')).toEqual({ name: 'Player 2' });
    // A name has nothing of the key in it.
    const key = 'zorbak-private-credential-9f3a7c1e';
    const named = join(request({ 'x-chatwarden-key': key }), 'lobby');
    expect(named).toEqual({ name: 'Player 3' });
    for (let i = 0; i + 4 <= key.length; i += 1) expect(named.name).not.toContain(key.slice(i, i + 4));
    // No header at all is one shared anonymous key, not a crash.
    expect(join(request(), 'lobby')).toEqual({ name: 'Player 4' });
    expect(join(request(), 'lobby')).toEqual({ name: 'Player 4' });
    // The table is bounded: key 401 gets no name, keys already in the table keep theirs.
    for (let i = 5; i <= 400; i += 1) expect(join(request({ 'x-chatwarden-key': `bulk-${i}` }), 'lobby')).toEqual({ name: `Player ${i}` });
    expect(join(request({ 'x-chatwarden-key': 'one-too-many' }), 'lobby')).toBeNull();
    expect(join(request({ 'x-chatwarden-key': 'k1' }), 'lobby')).toEqual({ name: 'Player 1' });
  });

  it('two starts do not share a table', () => {
    const a = withToken({ chat: 'box' }).auth;
    const b = withToken({ chat: 'box' }).auth;
    a.join(request({ 'x-chatwarden-key': 'ka' }), 'lobby');
    expect(b.join(request({ 'x-chatwarden-key': 'kb' }), 'lobby')).toEqual({ name: 'Player 1' });
  });
});

function spyHeaders(init: Record<string, string>): { headers: Record<string, string>; touched: string[] } {
  const touched: string[] = [];
  const headers = new Proxy(init, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') touched.push(prop.toLowerCase());
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string') touched.push(prop.toLowerCase());
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      touched.push('*');
      return Reflect.ownKeys(target);
    },
  });
  return { headers, touched };
}

describe('identify (players)', () => {
  const FORWARDED = { 'x-forwarded-for': '203.0.113.9, 10.1.1.1', 'x-chatwarden-key': 'player-key-1' };

  it('reads the key from x-chatwarden-key and the address from the socket, never anything else', () => {
    const { identify } = withToken().auth;
    expect(identify(request({ 'x-chatwarden-key': 'player-key-1' }, { remoteAddress: '198.51.100.7' }))).toEqual({ clientKey: 'player-key-1', ip: '198.51.100.7' });
    expect(identify(request({}, { remoteAddress: '198.51.100.7' }))).toEqual({ ip: '198.51.100.7' });
    expect(identify(request({ 'x-chatwarden-key': '' }, { remoteAddress: '198.51.100.7' }))).toEqual({ ip: '198.51.100.7' });
    expect(identify(request({ 'x-chatwarden-key': 'k' }))).toEqual({ clientKey: 'k', ip: null });
    // No account id is invented; the starter leaves it to the adopter.
    expect(Object.keys(identify(request(FORWARDED, { remoteAddress: '198.51.100.7' })))).not.toContain('accountId');
  });

  it('identify never reads x-forwarded-for unless CHATWARDEN_TRUST_PROXY=1', () => {
    for (const framework of ['express', 'fastify'] as const) {
      // Not even with the switch on: these adapters see the socket.
      for (const env of [{}, { CHATWARDEN_TRUST_PROXY: '1' }]) {
        const spy = spyHeaders(FORWARDED);
        const who = withToken({ framework }, env).auth.identify(request(spy.headers, { remoteAddress: '198.51.100.7' }));
        expect(who.ip, framework).toBe('198.51.100.7');
        expect(spy.touched, framework).not.toContain('x-forwarded-for');
        expect(spy.touched, framework).not.toContain('*');
      }
    }
    for (const framework of ['next', 'fetch'] as const) {
      for (const env of [{}, { CHATWARDEN_TRUST_PROXY: '' }, { CHATWARDEN_TRUST_PROXY: '0' }, { CHATWARDEN_TRUST_PROXY: 'true' }, { CHATWARDEN_TRUST_PROXY: ' 1' }, { CHATWARDEN_TRUST_PROXY: 'yes' }]) {
        const spy = spyHeaders(FORWARDED);
        const who = withToken({ framework, hub: 'react' }, env).auth.identify(request(spy.headers, { remoteAddress: '198.51.100.7' }));
        expect(who.ip, `${framework} ${JSON.stringify(env)}`).toBe('198.51.100.7');
        expect(spy.touched, `${framework} ${JSON.stringify(env)}`).not.toContain('x-forwarded-for');
      }
      const trusted = withToken({ framework, hub: 'react' }, { CHATWARDEN_TRUST_PROXY: '1' }).auth;
      expect(trusted.identify(request(FORWARDED, { remoteAddress: '198.51.100.7' })).ip, framework).toBe('203.0.113.9');
      expect(trusted.identify(request({ 'x-forwarded-for': '203.0.113.9' })).ip).toBe('203.0.113.9');
      expect(trusted.identify(request({ 'x-forwarded-for': '2001:db8::1, 10.1.1.1' })).ip).toBe('2001:db8::1');
      // With the switch on but nothing usable in the header, it falls back to the socket (or to nobody).
      for (const junk of ['', ' ', ',', 'not an address', '<script>', 'a'.repeat(200), '203.0.113.9; drop']) {
        expect(trusted.identify(request({ 'x-forwarded-for': junk }, { remoteAddress: '198.51.100.7' })).ip, JSON.stringify(junk)).toBe('198.51.100.7');
      }
      expect(trusted.identify(request({ 'x-forwarded-for': '' })).ip).toBeNull();
      // The key is still the key.
      expect(trusted.identify(request(FORWARDED)).clientKey).toBe('player-key-1');
    }
  });
});

describe('createKit runs the generated wiring against the real kit', () => {
  it('express over the memory store: a kit with hooks, the base and a working moderation check', async () => {
    const loaded = load({ framework: 'express' }, { CHATWARDEN_SECRET: SECRET, CHATWARDEN_ADMIN_TOKEN: TOKEN });
    const kit = await loaded.kit.createKit();
    try {
      expect(kit.base).toBe('/chatwarden');
      expect(typeof kit.hooks.authorize).toBe('function');
      expect(typeof kit.hooks.identify).toBe('function');
      expect(typeof kit.hooks.join).toBe('function');
      expect(kit.terms.match('you zorbak')).not.toBeNull();
      expect('chat' in kit).toBe(false);
      kit.cw.rooms.seat('room-1', 'p1', { clientKey: 'raw-key-1', ip: '203.0.113.5' }, 'Player 1');
      expect(kit.cw.chat.accept('room-1', 'p1', 'good game')).toHaveProperty('deliver');
      expect(kit.cw.chat.accept('room-1', 'p1', 'you zorbak')).toHaveProperty('refuse');
    } finally {
      await kit.close();
    }
  });

  it('the sqlite variant opens the store named by CHATWARDEN_DB', async () => {
    const loaded = load({ store: 'sqlite', framework: 'fastify' }, { CHATWARDEN_SECRET: SECRET, CHATWARDEN_DB: ':memory:' });
    const kit = await loaded.kit.createKit();
    try {
      kit.cw.rooms.seat('room-1', 'p1', { clientKey: 'raw-key-1', ip: '203.0.113.5' }, 'Player 1');
      expect(kit.cw.chat.accept('room-1', 'p1', 'you zorbak')).toHaveProperty('refuse');
    } finally {
      await kit.close();
    }
  });

  it('the chat box adds the room broadcaster, and close stops it', async () => {
    const loaded = load({ chat: 'box', chatTransport: 'sse' }, { CHATWARDEN_SECRET: SECRET });
    const kit = await loaded.kit.createKit();
    expect(typeof kit.chat.noticePending).toBe('function');
    expect(typeof kit.chat.close).toBe('function');
    await kit.close();
  });

  it('library only has no hooks and no routes: a kit and the check, nothing more', async () => {
    const loaded = load({ framework: 'none', hub: 'none' }, { CHATWARDEN_SECRET: SECRET });
    const kit = await loaded.kit.createKit();
    try {
      expect('hooks' in kit).toBe(false);
      expect('chat' in kit).toBe(false);
      expect(typeof kit.cw.chat.accept).toBe('function');
      expect(kit.base).toBe('/chatwarden');
    } finally {
      await kit.close();
    }
    expect(() => loaded.auth).toThrow(/no auth/);
  });

  it('the Discord feed starts only when DISCORD_WEBHOOK_URL is set, and is disposed on close', async () => {
    const off = load({ discord: true }, { CHATWARDEN_SECRET: SECRET });
    const offKit = await off.kit.createKit();
    await offKit.close();
    expect(off.warns).toEqual([]);

    const on = load({ discord: true }, { CHATWARDEN_SECRET: SECRET, DISCORD_WEBHOOK_URL: WEBHOOK, DISCORD_MENTION_ROLE_ID: '123456789012345678' });
    const onKit = await on.kit.createKit();
    await onKit.close();
    expect(on.warns).toEqual([]);

    const bad = load({ discord: true }, { CHATWARDEN_SECRET: SECRET, DISCORD_WEBHOOK_URL: 'not a url' });
    await expect(bad.kit.createKit()).rejects.toThrow();
  });

  it('a Discord hub link points at the hub page when there is one, and at the staff API when there is not', async () => {
    const run = async (hub: 'element' | 'none', publicUrl?: string): Promise<{ links: string[]; options: any }> => {
      const links: string[] = [];
      let seen: any;
      const feed = {
        discordFeed: (_cw: unknown, options: any) => {
          seen = options;
          links.push(options.hubLink('report', 'r 1'), options.hubLink('person', 'p1'));
          return { dispose() {} };
        },
      };
      const env = { CHATWARDEN_SECRET: SECRET, DISCORD_WEBHOOK_URL: WEBHOOK, ...(publicUrl === undefined ? {} : { CHATWARDEN_PUBLIC_URL: publicUrl }) };
      const loaded = load({ discord: true, hub }, env, { '@chatwarden/discord': feed });
      await (await loaded.kit.createKit()).close();
      return { links, options: seen };
    };
    expect((await run('element', 'https://game.example.invalid')).links).toEqual([
      'https://game.example.invalid/chatwarden/mod#/reports/r%201',
      'https://game.example.invalid/chatwarden/mod#/people/p1',
    ]);
    expect((await run('none', 'https://game.example.invalid')).links).toEqual([
      'https://game.example.invalid/chatwarden/admin/reports/r%201',
      'https://game.example.invalid/chatwarden/admin/people/p1/history',
    ]);
    // A trailing slash on the public address does not double up; with none set the links are for a local run.
    expect((await run('element', 'https://game.example.invalid/')).links[0]).toBe('https://game.example.invalid/chatwarden/mod#/reports/r%201');
    expect((await run('element')).links[0]).toBe('http://localhost:3000/chatwarden/mod#/reports/r%201');
    // The webhook is passed through, the role only when set.
    expect((await run('element')).options.webhookUrl).toBe(WEBHOOK);
    expect('mentionRoleId' in (await run('element')).options).toBe(false);
  });
});
