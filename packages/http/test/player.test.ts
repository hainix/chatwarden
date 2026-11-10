import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatwarden, defineRules, STARTER_RULES } from '@chatwarden/core';
import type { Chatwarden, Logger, Matcher, RawWho } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { CODE_OF_CONDUCT_CSP, createRouter, playerRoutes } from '@chatwarden/http';
import type { KitRequest, KitResponse } from '@chatwarden/http';
import { keysDeep } from './world.js';

const NOW = 1_800_000_000_000;
const ROOM = 'room-p';
const CSP = "default-src 'none'; style-src 'unsafe-inline'";

const ALICE: RawWho = { clientKey: 'raw-key-alice-0001-secret', ip: '203.0.113.11' };
const BOB: RawWho = { clientKey: 'raw-key-bob-0002-secret', ip: '203.0.113.12' };
const STRANGER: RawWho = { clientKey: 'raw-key-stranger-0003-secret', accountId: 'acct-stranger', ip: '203.0.113.13' };
const RAW_VALUES = [ALICE.clientKey, BOB.clientKey, STRANGER.clientKey, STRANGER.accountId, ALICE.ip, BOB.ip, STRANGER.ip] as string[];

const SUBJECT_RE = /s_[A-Za-z0-9_-]{22}/;
const FORBIDDEN_KEYS = ['ip', 'ipHash', 'keyHash', 'hash', 'roomId', 'groupId', 'actor', 'reason', 'subject', 'clientKey', 'accountId'];
const PRIVATE_TEXT = ['private reason text', 'mod@example.test', 'bob line'];

const blocker: Matcher = {
  match: (t) => (t.toLowerCase().includes('zorbak') ? { termId: 'syn:zorbak' } : null),
  spans: (t) => {
    const i = t.toLowerCase().indexOf('zorbak');
    return i < 0 ? [] : [{ start: i, end: i + 6, termId: 'syn:zorbak' }];
  },
};

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

/** Identity from headers: x-key, x-account, x-ip; x-identify=throw / reject / null / string breaks the hook. */
const identifyFromHeaders = async (req: KitRequest): Promise<RawWho> => {
  const h = req.headers;
  const mode = h['x-identify'];
  if (mode === 'throw') throw new Error(`boom for ${h['x-key'] ?? ''}`);
  if (mode === 'reject') return Promise.reject(new TypeError(`boom for ${h['x-key'] ?? ''}`));
  if (mode === 'null') return null as unknown as RawWho;
  if (mode === 'string') return 'not an object' as unknown as RawWho;
  const who: Record<string, unknown> = {};
  if (h['x-key'] !== undefined) who.clientKey = h['x-key'];
  if (h['x-account'] !== undefined) who.accountId = h['x-account'];
  if (h['x-ip'] !== undefined) who.ip = h['x-ip'];
  if (h['x-extra'] !== undefined) who.evil = h['x-extra'];
  return who as RawWho;
};

interface SetupOptions {
  rules?: ReturnType<typeof defineRules>;
  wrap?: (cw: Chatwarden) => Chatwarden;
  routes?: Record<string, unknown>;
}

async function setup(over: SetupOptions = {}) {
  const store = openStore({ db: new DatabaseSync(':memory:') });
  const clock = { t: NOW, now: () => clock.t };
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const cw = await createChatwarden({
    store,
    secret: 'player-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    logger,
    matcher: blocker,
    retention: false,
    ...(over.rules === undefined ? {} : { rules: over.rules }),
  });
  const used = over.wrap === undefined ? cw : over.wrap(cw);
  const routes = playerRoutes(used, {
    identify: identifyFromHeaders,
    logger,
    now: () => clock.t,
    ...over.routes,
  } as Parameters<typeof playerRoutes>[1]);
  const router = createRouter(routes);
  const call = (
    method: string,
    path: string,
    o: { who?: RawWho; query?: Record<string, string>; body?: unknown; raw?: string; headers?: Record<string, string> } = {},
  ): Promise<KitResponse> => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.who?.clientKey !== undefined) headers['x-key'] = o.who.clientKey;
    if (o.who?.accountId !== undefined) headers['x-account'] = o.who.accountId;
    if (o.who?.ip !== undefined && o.who.ip !== null) headers['x-ip'] = o.who.ip;
    const rawBody = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    return router({ method, path, query: o.query ?? {}, headers, body: undefined, ...(rawBody === undefined ? {} : { rawBody }) });
  };

  // alice is warned over a report from bob.
  cw.rooms.seat(ROOM, 'a', ALICE, 'Alice');
  cw.rooms.seat(ROOM, 'b', BOB, 'Bob');
  cw.chat.accept(ROOM, 'a', 'hello there');
  cw.chat.accept(ROOM, 'a', 'you zorbak');
  cw.chat.accept(ROOM, 'b', 'bob line');
  const submitted = await cw.reports.submit({ roomId: ROOM, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
  if (!submitted.ok) throw new Error('expected a stored report');
  const subjectA = cw.rooms.subjectAt(ROOM, 'a');
  if (subjectA === null) throw new Error('expected a subject');
  const warn = async () => {
    const lineIds = (store.loadReport(submitted.reportId)?.excerpt ?? []).filter((l) => l.seatId === 'a').map((l) => l.lineId);
    return cw.decide({
      reportId: submitted.reportId,
      verdict: 'upheld',
      actor: 'mod@example.test',
      reason: 'private reason text',
      actions: [{ subject: subjectA, kind: 'warning', durationMs: null, rule: 2, lineIds }],
    });
  };
  return { cw, store, clock, logged, call, router, warn, routes };
}

type Call = Awaited<ReturnType<typeof setup>>['call'];

const body = (res: KitResponse) => res.body as Record<string, unknown>;
const errorOf = (res: KitResponse) => (res.body as { error: string }).error;

/** Fails when a response (headers included) carries an identifier, a raw credential or a staff-only field. */
function expectNoLeak(res: KitResponse, allowKeys: string[] = []): void {
  const text = JSON.stringify(res);
  expect(text).not.toMatch(SUBJECT_RE);
  expect(text).not.toMatch(/\b[0-9a-f]{32,}\b/);
  for (const v of RAW_VALUES) expect(text).not.toContain(v);
  for (const v of PRIVATE_TEXT) expect(text).not.toContain(v);
  const keys = keysDeep(res.body);
  for (const k of FORBIDDEN_KEYS.filter((f) => !allowKeys.includes(f))) expect(keys.has(k), `key ${k}`).toBe(false);
}

const NOTICE_KEYS = ['createdAt', 'excerpt', 'id', 'kind', 'mustAcknowledge', 'refCode', 'rule', 'ruleLabel', 'until'];

const noticeId = async (call: Call, who: RawWho) =>
  ((body(await call('GET', '/notices', { who })).notices as Array<{ id: string }>)[0] as { id: string }).id;

afterEach(() => vi.restoreAllMocks());

describe('playerRoutes: the route table', () => {
  it('has exactly the six player routes', async () => {
    const { routes } = await setup();
    expect(Object.keys(routes).sort()).toEqual([
      'GET /code-of-conduct',
      'GET /notices',
      'GET /record',
      'GET /rules',
      'POST /names/check',
      'POST /notices/:id/ack',
    ]);
  });

  it('other methods are 405 with allow, other paths 404', async () => {
    const { call } = await setup();
    expect((await call('POST', '/notices', { who: ALICE })).status).toBe(405);
    expect((await call('POST', '/notices')).headers?.allow).toBe('GET, HEAD');
    expect((await call('GET', '/names/check')).headers?.allow).toBe('POST');
    expect((await call('GET', '/notices/x/ack')).headers?.allow).toBe('POST');
    expect((await call('DELETE', '/rules')).status).toBe(405);
    expect((await call('GET', '/reports')).status).toBe(404);
    expect((await call('GET', '/policy')).status).toBe(404);
  });

  it('refuses to build with a bad option', async () => {
    const mk = (routes: Record<string, unknown>) => setup({ routes });
    await expect(mk({ identify: undefined })).rejects.toThrow(TypeError);
    await expect(mk({ identify: 'nope' })).rejects.toThrow(TypeError);
    await expect(mk({ gameName: '' })).rejects.toThrow(RangeError);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(mk({ namesRateLimit: { max: bad, windowMs: 1000 } }), `max ${String(bad)}`).rejects.toThrow(RangeError);
      await expect(mk({ namesRateLimit: { max: 5, windowMs: bad } }), `windowMs ${String(bad)}`).rejects.toThrow(RangeError);
    }
    await expect(mk({ namesRateLimit: { max: 5 } })).rejects.toThrow(RangeError);
    await expect(mk({ namesRateLimit: null })).rejects.toThrow(RangeError);
    await expect(mk({ namesRateLimit: { max: 1, windowMs: 1 } })).resolves.toBeDefined();
  });
});

describe('GET /notices and GET /record', () => {
  it('before anything happened: empty lists', async () => {
    const { call } = await setup();
    expect(await call('GET', '/notices', { who: ALICE })).toMatchObject({ status: 200, body: { notices: [] } });
    expect(await call('GET', '/record', { who: ALICE })).toMatchObject({ status: 200, body: { record: [] } });
  });

  it('a warned player gets the core player notice, exactly, wrapped as { notices }', async () => {
    const { call, warn, cw } = await setup();
    expect((await warn()).ok).toBe(true);
    const res = await call('GET', '/notices', { who: ALICE });
    expect(res.status).toBe(200);
    expect(Object.keys(body(res))).toEqual(['notices']);
    const [n] = body(res).notices as Array<{ excerpt: Array<Record<string, unknown>> }>;
    expect(Object.keys(n as object).sort()).toEqual(NOTICE_KEYS);
    expect(n).toMatchObject({ kind: 'warning', rule: 2, until: null, mustAcknowledge: true });
    // passed through as-is
    expect(body(res).notices).toEqual(cw.notices.pending(ALICE));
    expect((n as { excerpt: unknown[] }).excerpt.length).toBeGreaterThan(0);
    for (const line of n?.excerpt ?? []) expect(Object.keys(line).sort()).toEqual(['day', 'text']);
    expectNoLeak(res);
  });

  it('GET /record is { record } of the same notices, seen or not', async () => {
    const { call, warn, cw } = await setup();
    await warn();
    const res = await call('GET', '/record', { who: ALICE });
    expect(Object.keys(body(res))).toEqual(['record']);
    expect(body(res).record).toEqual(cw.notices.record(ALICE));
    expect((body(res).record as unknown[]).length).toBe(1);
    expectNoLeak(res);
  });

  it("the reporter's notice is a report outcome and carries no rule, ref code or excerpt", async () => {
    const { call, warn } = await setup();
    await warn();
    const res = await call('GET', '/notices', { who: BOB });
    const [n] = body(res).notices as Array<Record<string, unknown>>;
    expect(n).toMatchObject({ kind: 'report_outcome', rule: null, refCode: null, excerpt: [], mustAcknowledge: false });
    expect(Object.keys(n as object).sort()).toEqual(NOTICE_KEYS);
    expectNoLeak(res);
  });

  it('after an ack the notice leaves /notices but stays in /record', async () => {
    const { call, warn } = await setup();
    await warn();
    const id = await noticeId(call, ALICE);
    expect((await call('POST', `/notices/${id}/ack`, { who: ALICE })).body).toEqual({ ok: true });
    expect(body(await call('GET', '/notices', { who: ALICE })).notices).toEqual([]);
    expect((body(await call('GET', '/record', { who: ALICE })).record as unknown[]).length).toBe(1);
  });

  it("one player never sees another's notices", async () => {
    const { call, warn } = await setup();
    await warn();
    const bobs = body(await call('GET', '/notices', { who: BOB })).notices as Array<{ kind: string }>;
    expect(bobs.map((n) => n.kind)).toEqual(['report_outcome']);
    const alices = body(await call('GET', '/notices', { who: ALICE })).notices as Array<{ kind: string }>;
    expect(alices.map((n) => n.kind)).toEqual(['warning']);
  });

  it('an unknown identity, an IP-only identity and no identity at all get 200 and empty lists', async () => {
    const { call, warn } = await setup();
    await warn();
    const ghosts: Array<{ who?: RawWho }> = [
      { who: STRANGER },
      { who: { ip: ALICE.ip as string } }, // alice's own IP alone finds nobody
      { who: { clientKey: 'wrong-key' } },
      { who: { accountId: 'acct-nobody' } },
      {},
    ];
    for (const g of ghosts) {
      expect(await call('GET', '/notices', g)).toMatchObject({ status: 200, body: { notices: [] } });
      expect(await call('GET', '/record', g)).toMatchObject({ status: 200, body: { record: [] } });
    }
  });

  it('a timeout notice (automatic restriction) shows the same shape', async () => {
    const { call, cw, clock } = await setup();
    clock.t += 60_000;
    for (let i = 0; i < 3; i++) {
      cw.chat.accept(ROOM, 'a', 'zorbak');
      clock.t += 5_000;
    }
    expect(cw.chat.accept(ROOM, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted' } });
    const res = await call('GET', '/notices', { who: ALICE });
    const notices = body(res).notices as Array<Record<string, unknown>>;
    expect(notices.length).toBeGreaterThan(0);
    for (const n of notices) expect(Object.keys(n).sort()).toEqual(NOTICE_KEYS);
    expectNoLeak(res);
  });

  it('personal responses are not cacheable', async () => {
    const { call } = await setup();
    for (const [m, p] of [['GET', '/notices'], ['GET', '/record'], ['POST', '/notices/abc/ack']] as const) {
      expect((await call(m, p, { who: ALICE })).headers?.['cache-control']).toBe('no-store');
    }
  });
});

describe('POST /notices/:id/ack', () => {
  it('the owner acks: 200 { ok: true }, and again (idempotent)', async () => {
    const { call, warn, cw } = await setup();
    await warn();
    const id = await noticeId(call, ALICE);
    const res = await call('POST', `/notices/${id}/ack`, { who: ALICE });
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect(Object.keys(body(res))).toEqual(['ok']);
    expect(cw.notices.pendingWarning(ALICE)).toBe(false);
    expect((await call('POST', `/notices/${id}/ack`, { who: ALICE })).body).toEqual({ ok: true });
  });

  it('a non-target gets 200 { ok: false } (never 403 or 404) and the notice stays pending', async () => {
    const { call, warn, cw } = await setup();
    await warn();
    const id = await noticeId(call, ALICE);
    for (const who of [BOB, STRANGER, { ip: ALICE.ip as string }]) {
      const res = await call('POST', `/notices/${id}/ack`, { who });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false });
    }
    expect((await call('POST', `/notices/${id}/ack`)).body).toEqual({ ok: false });
    expect(cw.notices.pendingWarning(ALICE)).toBe(true);
  });

  it('an unknown id looks exactly like a foreign id', async () => {
    const { call, warn } = await setup();
    await warn();
    const id = await noticeId(call, ALICE);
    const foreign = await call('POST', `/notices/${id}/ack`, { who: BOB });
    const unknown = await call('POST', '/notices/does-not-exist/ack', { who: ALICE });
    const random = await call('POST', `/notices/${'a'.repeat(32)}/ack`, { who: ALICE });
    expect(unknown).toEqual(foreign);
    expect(random).toEqual(foreign);
  });

  it('a malformed id is a plain 404 from the router', async () => {
    const { call } = await setup();
    expect((await call('POST', `/notices/${'a'.repeat(65)}/ack`, { who: ALICE })).status).toBe(404);
    expect((await call('POST', '/notices/a%2Fb/ack', { who: ALICE })).status).toBe(404);
    expect((await call('POST', '/notices/a.b/ack', { who: ALICE })).status).toBe(404);
  });

  it('ignores any body', async () => {
    const { call } = await setup();
    expect((await call('POST', '/notices/abc/ack', { who: ALICE, raw: 'not json at all' })).body).toEqual({ ok: false });
  });
});

describe('identify', () => {
  it('may be async', async () => {
    const { call, warn } = await setup({
      routes: { identify: async (req: KitRequest) => (await Promise.resolve(), { clientKey: req.headers['x-key'] ?? '' }) },
    });
    await warn();
    expect((body(await call('GET', '/notices', { who: ALICE })).notices as unknown[]).length).toBe(1);
  });

  it('is handed only the known fields, as a copy (nothing extra reaches the kit)', async () => {
    let seen: RawWho | undefined;
    const { call } = await setup({
      wrap: (cw) => ({
        ...cw,
        notices: {
          ...cw.notices,
          pending: (who: RawWho) => {
            seen = who;
            return [];
          },
        },
      }),
    });
    await call('GET', '/notices', { who: ALICE, headers: { 'x-extra': 'e', 'x-account': 'acct-1' } });
    expect(seen).toEqual({ clientKey: ALICE.clientKey, accountId: 'acct-1', ip: ALICE.ip });
    expect(Object.keys(seen as object).sort()).toEqual(['accountId', 'clientKey', 'ip']);
  });

  it('fails closed when it throws, rejects, or returns a non-object: empty lists, { ok: false }, class-only log', async () => {
    const { call, warn, logged } = await setup();
    await warn();
    for (const mode of ['throw', 'reject', 'null', 'string']) {
      const headers = { 'x-identify': mode, 'x-key': ALICE.clientKey as string };
      expect(await call('GET', '/notices', { headers })).toMatchObject({ status: 200, body: { notices: [] } });
      expect(await call('GET', '/record', { headers })).toMatchObject({ status: 200, body: { record: [] } });
      expect(await call('POST', '/notices/abc/ack', { headers })).toMatchObject({ status: 200, body: { ok: false } });
    }
    const failures = logged.filter(([e]) => e === 'chatwarden.http_identify_failed');
    expect(failures.map(([, d]) => d)).toEqual([
      { error: 'Error' },
      { error: 'Error' },
      { error: 'Error' },
      { error: 'TypeError' },
      { error: 'TypeError' },
      { error: 'TypeError' },
    ]);
    expect(JSON.stringify(logged)).not.toContain(ALICE.clientKey);
  });

  it('a failing identify still lets the public routes work', async () => {
    const { call } = await setup();
    const headers = { 'x-identify': 'throw' };
    expect((await call('GET', '/rules', { headers })).status).toBe(200);
    expect((await call('GET', '/code-of-conduct', { headers })).status).toBe(200);
  });

  it('a raw credential never reaches a log, success or failure', async () => {
    const { call, warn, logged } = await setup();
    await warn();
    await call('GET', '/notices', { who: ALICE });
    await call('POST', '/names/check', { who: ALICE, body: { name: 'zorbak' } });
    await call('POST', '/names/check', { who: ALICE, raw: '{' });
    for (const v of RAW_VALUES) expect(JSON.stringify(logged)).not.toContain(v);
  });
});

describe('a failure under a player route', () => {
  it('is a 500 internal with nothing echoed', async () => {
    const { call, logged } = await setup({
      wrap: (cw) => ({
        ...cw,
        rules: {
          ...cw.rules,
          active: () => {
            throw new Error('db at 203.0.113.99');
          },
        } as unknown as Chatwarden['rules'],
      }),
    });
    const res = await call('GET', '/rules');
    expect(res).toEqual({ status: 500, body: { error: 'internal' } });
    expect(JSON.stringify(logged)).not.toContain('203.0.113.99');
  });
});

describe('GET /rules', () => {
  it('is { summary, rules } with active rules in the public shape', async () => {
    const { call, cw } = await setup();
    const res = await call('GET', '/rules');
    expect(res.status).toBe(200);
    expect(Object.keys(body(res)).sort()).toEqual(['rules', 'summary']);
    expect(body(res).summary).toBe(cw.summary);
    const rules = body(res).rules as Array<Record<string, unknown>>;
    expect(rules.map((r) => r.number)).toEqual(STARTER_RULES.map((r) => r.number));
    for (const r of rules) {
      expect(Object.keys(r).sort()).toEqual(['number', 'text', 'title']);
      expect(typeof r.title).toBe('string');
      expect(typeof r.text).toBe('string');
    }
    expectNoLeak(res);
  });

  it('lists active rules only: a retired rule is gone', async () => {
    const rules = defineRules([
      { number: 1, title: 'Be kind', text: 'Treat people well.' },
      { number: 2, title: 'Old rule', text: 'Retired text.', retired: true },
      { number: 3, title: 'No spam', text: 'Do not flood chat.' },
    ]);
    const { call } = await setup({ rules });
    const res = await call('GET', '/rules');
    expect(body(res).rules).toEqual([
      { number: 1, title: 'Be kind', text: 'Treat people well.' },
      { number: 3, title: 'No spam', text: 'Do not flood chat.' },
    ]);
    expect(JSON.stringify(res)).not.toContain('Old rule');
    expect(JSON.stringify(res)).not.toContain('retired');
  });

  it('is public (no identity needed), and the same for everyone', async () => {
    const { call } = await setup();
    expect((await call('GET', '/rules', { who: ALICE })).body).toEqual((await call('GET', '/rules')).body);
  });
});

describe('GET /code-of-conduct', () => {
  it('defaults to markdown', async () => {
    const { call, cw } = await setup();
    const res = await call('GET', '/code-of-conduct');
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers?.['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe(cw.documents.codeOfConduct({ format: 'markdown', gameName: 'Our game' }));
    expect(typeof res.body).toBe('string');
  });

  it('format=text', async () => {
    const { call, cw } = await setup();
    const res = await call('GET', '/code-of-conduct', { query: { format: 'text' } });
    expect(res.headers?.['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers?.['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe(cw.documents.codeOfConduct({ format: 'text', gameName: 'Our game' }));
  });

  it('format=html: a full document, the exact CSP, nosniff, the core fragment inside', async () => {
    const { call, cw } = await setup();
    const res = await call('GET', '/code-of-conduct', { query: { format: 'html' } });
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
    });
    const html = res.body as string;
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(cw.documents.codeOfConduct({ format: 'html', gameName: 'Our game' }));
    expect(html).not.toMatch(/<script|<link|<img|<iframe|src=|\son[a-z]+=/i);
  });

  it('the markdown and text responses carry no CSP, only html does', async () => {
    const { call } = await setup();
    for (const format of ['markdown', 'text']) {
      expect((await call('GET', '/code-of-conduct', { query: { format } })).headers).not.toHaveProperty('content-security-policy');
    }
  });

  it('an unknown or malformed format is 400 invalid_query', async () => {
    const { call } = await setup();
    for (const format of ['pdf', '', 'HTML', 'Markdown', 'html,text', ' html', 'html ', 'constructor', '__proto__', 'toString', 'json']) {
      const res = await call('GET', '/code-of-conduct', { query: { format } });
      expect(res.status, JSON.stringify(format)).toBe(400);
      expect(errorOf(res)).toBe('invalid_query');
      expect(JSON.stringify(res.body)).not.toContain('pdf');
    }
  });

  it('uses the adopter game name and contact URL, escaped for the format', async () => {
    const { call } = await setup({
      routes: { gameName: '<script>alert(1)</script> & "Co"', contactUrl: 'https://example.test/appeal' },
    });
    const html = (await call('GET', '/code-of-conduct', { query: { format: 'html' } })).body as string;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('https://example.test/appeal');
    const md = (await call('GET', '/code-of-conduct')).body as string;
    expect(md).toContain('example.test/appeal');
  });

  it('exports the CSP it sends, byte for byte', () => {
    expect(CODE_OF_CONDUCT_CSP).toBe(CSP);
  });

  describe('hostile adopter rules', () => {
    const hostile = defineRules([
      { number: 1, title: '<script>alert(1)</script>', text: '"><img src=x onerror=alert(2)>' },
      { number: 2, title: 'Fine <b>title</b>', text: "'><svg onload=alert(3)> & more" },
    ]);

    it('html: escaped in the full document, with the exact CSP and nosniff', async () => {
      const { call } = await setup({ rules: hostile });
      const res = await call('GET', '/code-of-conduct', { query: { format: 'html' } });
      expect(res.status).toBe(200);
      expect(res.headers).toEqual({
        'content-type': 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': CSP,
      });
      const html = res.body as string;
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).not.toMatch(/<script|<img|<svg|<b>/i);
      // `onerror=` survives only as inert escaped text: no tag carries an event handler
      expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
      expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
      expect(html).toContain('&lt;script&gt;');
      // the shell's own single <style> block is the only markup of its kind
      expect(html.match(/<style/gi)?.length).toBe(1);
    });

    it('markdown and text: the right content type and nosniff, and no live markup in the text format', async () => {
      const { call } = await setup({ rules: hostile });
      const md = await call('GET', '/code-of-conduct', { query: { format: 'markdown' } });
      expect(md.headers).toEqual({ 'content-type': 'text/markdown; charset=utf-8', 'x-content-type-options': 'nosniff' });
      expect(typeof md.body).toBe('string');
      const text = await call('GET', '/code-of-conduct', { query: { format: 'text' } });
      expect(text.headers).toEqual({ 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
      expect(typeof text.body).toBe('string');
      // markdown is rendered by the reader's own tool; the route must not hand it out as html
      expect(md.headers?.['content-type']).not.toMatch(/html/);
      expect(text.headers?.['content-type']).not.toMatch(/html/);
    });
  });

  it('a game name that cannot head a document fails at build', async () => {
    await expect(setup({ routes: { gameName: '   ' } })).rejects.toThrow(RangeError);
  });

  it('is public and personal-data free in every format', async () => {
    const { call, warn } = await setup();
    await warn();
    for (const format of ['markdown', 'html', 'text']) {
      const res = await call('GET', '/code-of-conduct', { who: ALICE, query: { format } });
      expectNoLeak({ ...res, body: { text: res.body } });
    }
  });
});

describe('POST /names/check', () => {
  it('passes core answers through', async () => {
    const { call } = await setup();
    expect(await call('POST', '/names/check', { body: { name: 'Friendly Fox' } })).toMatchObject({ status: 200, body: { ok: true } });
    const bad = await call('POST', '/names/check', { body: { name: 'Zorbak_99' } });
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
  });

  it('does not echo the name', async () => {
    const { call } = await setup();
    const res = await call('POST', '/names/check', { body: { name: 'zorbak-unique-name-77' } });
    expect(JSON.stringify(res)).not.toContain('unique-name-77');
  });

  it('accepts 1 and 64 characters, refuses 0 and 65', async () => {
    const { call } = await setup();
    expect((await call('POST', '/names/check', { body: { name: 'a' } })).status).toBe(200);
    expect((await call('POST', '/names/check', { body: { name: 'a'.repeat(64) } })).status).toBe(200);
    expect(errorOf(await call('POST', '/names/check', { body: { name: '' } }))).toBe('invalid_request');
    expect((await call('POST', '/names/check', { body: { name: 'a'.repeat(65) } })).status).toBe(400);
  });

  it('every other body is 400', async () => {
    const { call } = await setup();
    const bodies: unknown[] = [{}, { name: 1 }, { name: null }, { name: ['a'] }, { name: { a: 1 } }, { name: true }, { Name: 'x' }, [], ['x'], 'x', 7, null];
    for (const b of bodies) {
      const res = await call('POST', '/names/check', { raw: JSON.stringify(b) });
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
    expect(errorOf(await call('POST', '/names/check'))).toBe('invalid_request');
    expect(errorOf(await call('POST', '/names/check', { raw: '{nope' }))).toBe('invalid_json');
    expect(errorOf(await call('POST', '/names/check', { raw: '{"name":"x","__proto__":{"a":1}}' }))).toBe('forbidden_key');
  });

  it('a body over 64 KiB is 413', async () => {
    const { call } = await setup();
    const res = await call('POST', '/names/check', { raw: JSON.stringify({ name: 'a'.repeat(70_000) }) });
    expect(res.status).toBe(413);
  });

  it('ignores extra keys', async () => {
    const { call } = await setup();
    expect((await call('POST', '/names/check', { body: { name: 'fine', note: 'x' } })).status).toBe(200);
  });
});

describe('POST /names/check: the rate limit', () => {
  const check = (call: Call, who?: RawWho, name = 'Friendly Fox') =>
    call('POST', '/names/check', { ...(who === undefined ? {} : { who }), body: { name } });

  it('allows 20 a minute per identity by default, then 429 rate_limited with retry-after', async () => {
    const { call, clock } = await setup();
    for (let i = 0; i < 20; i++) expect((await check(call, ALICE)).status, `call ${i + 1}`).toBe(200);
    clock.t += 10_000;
    const res = await check(call, ALICE);
    expect(res.status).toBe(429);
    expect(errorOf(res)).toBe('rate_limited');
    expect(res.headers?.['retry-after']).toBe('50');
    // still refused, whatever the name is
    expect((await check(call, ALICE, 'zorbak')).status).toBe(429);
  });

  it('the window reopens after windowMs', async () => {
    const { call, clock } = await setup();
    for (let i = 0; i < 21; i++) await check(call, ALICE);
    clock.t += 59_999;
    expect((await check(call, ALICE)).status).toBe(429);
    clock.t += 1;
    expect((await check(call, ALICE)).status).toBe(200);
  });

  it('retry-after is whole seconds, rounded up, at least 1', async () => {
    const { call, clock } = await setup({ routes: { namesRateLimit: { max: 1, windowMs: 1500 } } });
    await check(call, ALICE);
    expect((await check(call, ALICE)).headers?.['retry-after']).toBe('2');
    clock.t += 1499;
    expect((await check(call, ALICE)).headers?.['retry-after']).toBe('1');
  });

  it('is per identity: one player exhausting the limit does not touch another', async () => {
    const { call } = await setup();
    for (let i = 0; i < 21; i++) await check(call, ALICE);
    expect((await check(call, ALICE)).status).toBe(429);
    expect((await check(call, BOB)).status).toBe(200);
  });

  it('is configurable', async () => {
    const { call, clock } = await setup({ routes: { namesRateLimit: { max: 3, windowMs: 1000 } } });
    for (let i = 0; i < 3; i++) expect((await check(call, ALICE)).status).toBe(200);
    expect((await check(call, ALICE)).status).toBe(429);
    clock.t += 1000;
    expect((await check(call, ALICE)).status).toBe(200);
  });

  it('keys on accountId first, then clientKey, then ip', async () => {
    const { call } = await setup({ routes: { namesRateLimit: { max: 1, windowMs: 60_000 } } });
    // same account, different client keys and addresses: one bucket
    expect((await check(call, { accountId: 'acct-1', clientKey: 'k1', ip: '198.51.100.1' })).status).toBe(200);
    expect((await check(call, { accountId: 'acct-1', clientKey: 'k2', ip: '198.51.100.2' })).status).toBe(429);
    // same client key, no account, different addresses: one bucket
    expect((await check(call, { clientKey: 'k3', ip: '198.51.100.3' })).status).toBe(200);
    expect((await check(call, { clientKey: 'k3', ip: '198.51.100.4' })).status).toBe(429);
    // ip only
    expect((await check(call, { ip: '198.51.100.5' })).status).toBe(200);
    expect((await check(call, { ip: '198.51.100.5' })).status).toBe(429);
    expect((await check(call, { ip: '198.51.100.6' })).status).toBe(200);
    // the value 'k1' as an account is not the client key 'k1'
    expect((await check(call, { accountId: 'k1' })).status).toBe(200);
  });

  it('shares one anonymous bucket when nothing is known (empty, unknown ip, empty strings, failing identify)', async () => {
    const { call } = await setup({ routes: { namesRateLimit: { max: 3, windowMs: 60_000 } } });
    expect((await check(call)).status).toBe(200);
    expect((await check(call, { ip: 'unknown' })).status).toBe(200);
    expect((await check(call, { clientKey: '', accountId: '' })).status).toBe(200);
    expect((await call('POST', '/names/check', { headers: { 'x-identify': 'throw' }, body: { name: 'x' } })).status).toBe(429);
    expect((await check(call)).status).toBe(429);
    expect((await check(call, ALICE)).status).toBe(200);
  });

  it('counts refused and malformed requests too, and limits before validating the body', async () => {
    const { call } = await setup({ routes: { namesRateLimit: { max: 2, windowMs: 60_000 } } });
    expect((await call('POST', '/names/check', { who: ALICE, raw: '{' })).status).toBe(400);
    expect((await call('POST', '/names/check', { who: ALICE, body: { name: '' } })).status).toBe(400);
    expect((await call('POST', '/names/check', { who: ALICE, raw: '{' })).status).toBe(429);
  });

  it('does not limit the other routes', async () => {
    const { call } = await setup({ routes: { namesRateLimit: { max: 1, windowMs: 60_000 } } });
    await check(call, ALICE);
    expect((await check(call, ALICE)).status).toBe(429);
    for (const [m, p] of [['GET', '/notices'], ['GET', '/record'], ['GET', '/rules'], ['GET', '/code-of-conduct'], ['POST', '/notices/abc/ack']] as const) {
      expect((await call(m, p, { who: ALICE })).status, p).toBe(200);
    }
  });

  it('the map is bounded: at 10000 live keys the oldest is evicted (so a flood cannot grow memory)', async () => {
    const { call } = await setup({ routes: { namesRateLimit: { max: 1, windowMs: 3_600_000 } } });
    expect((await check(call, { ip: '10.0.0.1' })).status).toBe(200);
    expect((await check(call, { ip: '10.0.0.1' })).status).toBe(429);
    // control: far fewer than the cap, the first stays limited
    for (let i = 0; i < 100; i++) await check(call, { accountId: `ctl-${i}` });
    expect((await check(call, { ip: '10.0.0.1' })).status).toBe(429);
    for (let i = 0; i < 10_000; i++) await check(call, { accountId: `flood-${i}` });
    expect((await check(call, { ip: '10.0.0.1' })).status).toBe(200); // evicted: it is a fresh bucket
  }, 30_000);

  it('expired entries are dropped first, so live ones are not evicted to make room', async () => {
    const { call, clock } = await setup({ routes: { namesRateLimit: { max: 1, windowMs: 1000 } } });
    for (let i = 0; i < 9_000; i++) await check(call, { accountId: `old-${i}` });
    clock.t += 1000;
    for (let i = 0; i < 9_000; i++) await check(call, { accountId: `new-${i}` });
    // 18000 keys were seen, over the cap, yet every one of the newest 9000 is still held
    expect((await check(call, { accountId: 'new-0' })).status).toBe(429);
    expect((await check(call, { accountId: 'new-8999' })).status).toBe(429);
  }, 30_000);

  it('stores only a salted SHA-256 of the identity, never the raw value', async () => {
    const keys: string[] = [];
    const real = Map.prototype.set;
    vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      if (typeof k === 'string') keys.push(k);
      return real.call(this, k, v);
    });
    const a = await setup();
    const b = await setup();
    keys.length = 0;
    for (const who of [ALICE, STRANGER, { ip: '198.51.100.77' }, undefined]) await check(a.call, who);
    const first = [...keys];
    keys.length = 0;
    await check(b.call, ALICE);
    const second = [...keys];
    const raw = [...RAW_VALUES, '198.51.100.77'];
    for (const k of [...first, ...second]) for (const v of raw) expect(k.includes(v), k).toBe(false);
    const hashes = first.filter((k) => /^[0-9a-f]{64}$/.test(k));
    expect(hashes.length).toBe(4);
    expect(new Set(hashes).size).toBe(4);
    // a per-instance random salt: the same identity hashes differently in another instance
    expect(second.filter((k) => /^[0-9a-f]{64}$/.test(k))).not.toContain(hashes[0]);
  });

  it('the 429 is a fixed response', async () => {
    const { call } = await setup({ routes: { namesRateLimit: { max: 1, windowMs: 60_000 } } });
    await check(call, ALICE);
    const res = await check(call, ALICE, 'zorbak');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
    expectNoLeak(res);
  });
});

describe('every player response is free of identifiers', () => {
  it('a sweep over all routes and error paths', async () => {
    const { call, warn } = await setup({ routes: { namesRateLimit: { max: 2, windowMs: 60_000 } } });
    await warn();
    const id = await noticeId(call, ALICE);
    const responses: KitResponse[] = [
      await call('GET', '/notices', { who: ALICE }),
      await call('GET', '/notices', { who: BOB }),
      await call('GET', '/record', { who: ALICE }),
      await call('GET', '/record', { who: BOB }),
      await call('GET', '/record', { who: STRANGER }),
      await call('POST', `/notices/${id}/ack`, { who: BOB }),
      await call('POST', `/notices/${id}/ack`, { who: ALICE }),
      await call('GET', '/rules'),
      await call('POST', '/names/check', { who: ALICE, body: { name: 'zorbak' } }),
      await call('POST', '/names/check', { who: ALICE, body: { name: '' } }),
      await call('POST', '/names/check', { who: ALICE, raw: '{' }),
      await call('POST', '/names/check', { who: ALICE, body: { name: 'x' } }),
      await call('GET', '/code-of-conduct', { query: { format: 'pdf' } }),
      await call('GET', '/nowhere', { who: ALICE }),
      await call('PUT', '/notices', { who: ALICE }),
    ];
    // `names/check` answers with the core's own `reason: 'name_not_allowed'` code (not a moderator's reason).
    for (const r of responses) expectNoLeak(r, ['reason']);
    const refusal = responses[8] as KitResponse;
    expect(body(refusal)).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
    for (const r of responses.filter((x) => x !== refusal)) expect(keysDeep(r.body).has('reason')).toBe(false);
  });
});
