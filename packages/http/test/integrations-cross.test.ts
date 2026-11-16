import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chatwarden } from '@chatwarden/core';
import * as http from '../src/index.js';
import { coop } from '../src/coop/index.js';
import { discordBot, registerCommands } from '../src/discord/index.js';
import { eos } from '../src/eos/index.js';
import { ReplayCache, SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from '../src/webhooks/sign.js';
import type { KitRequest } from '../src/types.js';
import { APP_ID, GUILD_ID, OTHER_GUILD_ID, ROLE_MOD, ROLE_OTHER, ROLE_OWNER, ROLE_SENIOR, USER_2, botWorld, newPair } from './discord-world.js';
import type { BotWorld } from './discord-world.js';
import { callbackBody, callbackRequest, coopWorld, newRsaPair, sharedPair } from './coop-world.js';
import { CLIENT_ID, CLIENT_SECRET, DEPLOYMENT, EOS_URL, eosWorld, idle, makeEos } from './eos-world.js';
import { DAY, world } from './world.js';

// K5 X1: the checks that belong to no one adapter (design 10 and 11, "cross"; Review Focus 3). Every adapter is run through failures with a distinctive
// key, token, secret, url, id and text in every option and body, and nothing it logs, answers or throws may hold any of them. No network: every `fetch` is a local function.

afterEach(() => {
  vi.useRealTimers();
});

/** The names `@chatwarden/http` exported at 0.1.11 (main 7447e69); K5 adds none. */
const ROOT_EXPORTS: string[] = [
  'ATTEMPT_TIMEOUT_MS',
  'AiUnavailableError',
  'AuditFailedError',
  'BACKOFF_BASE_MS',
  'BODY_MAX_BYTES',
  'BadActorError',
  'CHAT_WIRE_VERSION',
  'CODE_OF_CONDUCT_CSP',
  'ClaimedError',
  'DEFAULT_GAME_NAME',
  'DELIVERY_HEADER',
  'HEARTBEAT',
  'HttpError',
  'MAX_RETRIES',
  'MIN_SECRET_LENGTH',
  'NotFoundError',
  'PERMISSIONS',
  'PERMISSION_KEYS',
  'QUEUE_MAX',
  'REPLAY_CACHE_SIZE',
  'RETRY_AFTER_CAP_MS',
  'RETRY_AFTER_FLOOR_MS',
  'ROLES',
  'ROOM_BROADCASTER_DEFAULTS',
  'ReplayCache',
  'SIGNATURE_HEADER',
  'SIGNATURE_WINDOW_MS',
  'TIMESTAMP_HEADER',
  'VERSION',
  'ValidationError',
  'adminRoutes',
  'aiRoutes',
  'appealRoutes',
  'auditRoutes',
  'blockedRoutes',
  'chatRoutes',
  'createAdminContext',
  'createRoomBroadcaster',
  'createRouter',
  'encodeFrame',
  'errorResponse',
  'gapRoutes',
  'guard',
  'healthRoutes',
  'matchRoute',
  'meRoutes',
  'nameRoutes',
  'parseJson',
  'playerRoutes',
  'policyRoutes',
  'refusalOf',
  'reportRoutes',
  'requireRole',
  'resolvePermissions',
  'roleAtLeast',
  'sanctionRoutes',
  'sign',
  'teamRoutes',
  'termRoutes',
  'toFetch',
  'verify',
  'webhookIn',
  'webhooksOut',
  'withErrors',
];

// ---- the seeds: every one holds LEAK, so one scan finds any of them, in any case ----

const seeds = {
  key: 'LEAKkey-vlemmo-4471',
  secret: 'LEAKsecret-quissel-9902',
  token: 'LEAKtoken-snerp-5530-abcdef',
  url: 'LEAKurl-tarvo',
  id: 'LEAKid-glarn-3318',
  text: 'LEAKtext zorbak said a thing',
  handle: 'LEAKhandle-drakkuun',
  note: 'LEAKnote about fenrisk',
};

class SeedError extends Error {
  constructor(what: string) {
    super(`${what} ${seeds.secret} ${seeds.url} ${seeds.text} ${seeds.token}`);
    this.name = 'SeedError';
  }
}
const leak = (what: string): SeedError => new SeedError(what);

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;
const IDENT = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;

/** Every log line is an event name and short detail: numbers, booleans and identifier-like words (an error class, an op, a reason code), and none holds a seed. */
function expectClean(logged: Logged, label: string): void {
  for (const [event, detail] of logged) {
    const line = JSON.stringify([event, detail]);
    expect(line.toUpperCase().includes('LEAK'), `${label}: ${line}`).toBe(false);
    expect(event, label).toMatch(/^chatwarden\.[a-z_]+$/);
    for (const [k, v] of Object.entries(detail ?? {})) {
      expect(k, `${label}: ${line}`).toMatch(/^[A-Za-z]{1,20}$/);
      if (typeof v === 'string') expect(v, `${label}: ${line}`).toMatch(IDENT);
    }
  }
}
const expectNoLeak = (value: unknown, label: string): void => {
  expect(JSON.stringify(value, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v)).toUpperCase().includes('LEAK'), label).toBe(false);
};

/** A kit whose call at `path` throws a seeded error while `on()` is true. */
function failing(cw: Chatwarden, path: readonly [string, string], on: () => boolean): Chatwarden {
  const [head, name] = path;
  return new Proxy(cw, {
    get(target, prop, receiver) {
      if (prop === head) {
        return new Proxy(Reflect.get(target, prop, receiver) as object, {
          get(t, p, r) {
            if (p === name && on()) {
              return () => {
                throw leak(`${head}.${name}`);
              };
            }
            return Reflect.get(t, p, r) as unknown;
          },
        });
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** One report with a distinctive handle, line and note, filed on the real kit. Returns its id. */
let roomN = 0;
async function seededReport(cw: Chatwarden): Promise<string> {
  const room = `cross-room-${++roomN}`;
  cw.rooms.seat(room, 'p1', { clientKey: `${seeds.key}-r${roomN}`, ip: '198.51.100.7' }, `${seeds.handle}-reporter`);
  cw.rooms.seat(room, 'p2', { clientKey: `${seeds.key}-t${roomN}`, ip: '203.0.113.9' }, seeds.handle);
  cw.chat.accept(room, 'p2', seeds.text);
  const res = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment', note: seeds.note });
  if (!res.ok) throw new Error(`report refused: ${res.refused}`);
  return res.reportId;
}

/** How the outside system answers in a failure run: a status, a thrown error, or a 200 with hostile content. */
type Mode = { kind: 'status'; status: number } | { kind: 'throw' } | { kind: 'junk' };
const STATUSES = [301, 400, 401, 403, 404, 408, 413, 429, 500, 502, 503];
const MODES: Mode[] = [...STATUSES.map((status): Mode => ({ kind: 'status', status })), { kind: 'throw' }, { kind: 'junk' }];
const modeName = (m: Mode): string => (m.kind === 'status' ? `status ${m.status}` : m.kind);

/** A `fetch` that answers every call the way `mode` says, with the seeds in the body and the headers. `except` answers some URLs normally. */
function hostileFetch(mode: Mode, except?: (url: string) => Response | undefined) {
  const calls: string[] = [];
  const fn = ((input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const special = except?.(url);
    if (special !== undefined) return Promise.resolve(special);
    if (mode.kind === 'throw') return Promise.reject(leak('connect'));
    const headers = { 'content-type': 'application/json', 'retry-after': '2', 'x-leak': seeds.secret, location: `https://${seeds.url}.example.test/` };
    if (mode.kind === 'junk') {
      return Promise.resolve(new Response(`{"reportId":"${seeds.id} with space","elements":[{"time":"${seeds.text}"}],"access_token":"${seeds.token} x","message":"${seeds.text}"}`, { status: 200, headers }));
    }
    const body = JSON.stringify({ error: seeds.text, message: seeds.secret, token: seeds.token, retry_after: 1 });
    return Promise.resolve(new Response(mode.status === 301 ? null : body, { status: mode.status, headers }));
  }) as typeof fetch;
  return { fn, calls };
}

const recorder = () => {
  const logged: Logged = [];
  return { logged, logger: { warn: (event: string, detail?: Record<string, string | number | boolean>) => void logged.push([event, detail]) } };
};

// ---- 1. logs hold event names and error classes only ----

describe('logs hold event names and error classes only (Review Focus 3)', () => {
  it('discord: refused requests, a failing store, a failing audit, a slow answer: nothing seeded is logged or answered', async () => {
    const flags = { byRef: false, audit: false, reports: false };
    const b: BotWorld = await botWorld({
      options: { actions: { dismiss: true, suggestion: true }, hubLink: () => "https://hub.example.test/the-hub", actorOf: () => seeds.id },
      wrapKit: (cw) => failing(failing(failing(cw, ['sanctions', 'byRef'], () => flags.byRef), ['audit', 'record'], () => flags.audit), ['reports', 'get'], () => flags.reports),
    });
    const sent: unknown[] = [];
    const send = async (req: KitRequest) => {
      const res = await b.send(req);
      sent.push(res.body);
      return res;
    };
    const filed = await seededReport(b.cw);
    const code = (
      await b.cw.sanctions.apply({ kind: 'chat', subject: b.w.person(), includeIp: false, durationMs: DAY, reason: seeds.text, actor: 'ann', source: 'moderator', automated: false, rule: 2 })
    ).refCode;
    // Forged and broken requests.
    await send(b.client.lookup(code, {}, { pair: newPair() }));
    await send(b.client.lookup(code, {}, { headers: { 'x-signature-ed25519': undefined } }));
    await send(b.client.lookup(code, {}, { timestamp: 1 }));
    await send(b.client.signed({ type: 2, note: seeds.text }, { sendRaw: `{"x":"${seeds.text}"}` }));
    await send(b.client.ping());
    // Refused people.
    await send(b.client.lookup(code, { guild: OTHER_GUILD_ID }));
    await send(b.client.lookup(code, { roles: [ROLE_OTHER] }));
    await send(b.client.lookup(code, { member: false }));
    await send(b.client.lookup(seeds.text));
    await send(b.client.lookup(`${seeds.id}-${seeds.key}`));
    // The kit fails under the bot.
    flags.byRef = true;
    await send(b.client.lookup(code));
    flags.byRef = false;
    flags.audit = true;
    await send(b.client.lookup(code));
    await send(b.client.click(`cw1:sug:${filed}`));
    flags.audit = false;
    flags.reports = true;
    await send(b.client.click(`cw1:dis:${filed}`));
    flags.reports = false;
    // Forged custom ids and a click on a report that does not exist.
    for (const id of [`cw1:dis:${seeds.id}`, `cw1:zz:${seeds.text}`, seeds.text, `cw1:ok:${filed}:LEAK`, `cw1:ok:${seeds.id}:n`, 'cw1:dis:']) await send(b.client.click(id));
    // One user over the rate limit.
    for (let i = 0; i < 25; i++) await send(b.client.lookup(code, { user: USER_2, roles: [ROLE_SENIOR, ROLE_OWNER] }));
    expect(b.logged.length).toBeGreaterThan(3);
    expectClean(b.logged as Logged, 'discord');
    sent.forEach((body, i) => expectNoLeak(body, `discord answer ${i}: ${JSON.stringify(body)}`));
    b.bot.dispose();
  });

  it.each(MODES.map((m) => [modeName(m), m] as const))('discord, slow work and a follow-up that fails (%s): the follow-up logs a reason, a status or a class', async (_name, mode) => {
    const h = hostileFetch(mode);
    const { logged, logger } = recorder();
    const b = await botWorld({ options: { fetch: h.fn, schedule: (run, ms) => (ms === 2500 ? (run(), () => undefined) : () => undefined), actions: { dismiss: true, suggestion: true }, logger } });
    const filed = await seededReport(b.cw);
    const code = (await b.cw.sanctions.apply({ kind: 'chat', subject: b.w.person(), includeIp: false, durationMs: DAY, reason: seeds.text, actor: 'ann', source: 'moderator', automated: false, rule: 2 })).refCode;
    const answers = [await b.send(b.client.lookup(code)), await b.send(b.client.click(`cw1:dis:${filed}`))];
    // A token of the wrong shape is no deferral at all (logged by reason).
    const odd = b.client.interaction(2, { id: '666666666666666601', name: 'chatwarden', type: 1, options: [{ type: 1, name: 'lookup', options: [{ type: 3, name: 'ref', value: code }] }] });
    answers.push(await b.send(b.client.signed({ ...odd, token: `${seeds.token} ${seeds.secret}` })));
    for (let i = 0; i < 40 && h.calls.length < 2; i++) await new Promise((r) => setImmediate(r));
    await idle();
    expectClean(logged, `discord ${modeName(mode)}`);
    expectClean(b.logged as Logged, `kit ${modeName(mode)}`);
    expectNoLeak(answers.map((a) => a.body), 'discord answers');
    b.bot.dispose();
  });

  it.each(MODES.map((m) => [modeName(m), m] as const))('discord registerCommands (%s): the result holds a status and nothing else, and the token is only in the request header', async (_name, mode) => {
    vi.useFakeTimers();
    const seen: Array<Record<string, string>> = [];
    const h = hostileFetch(mode);
    const wrapped = ((input: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return h.fn(input);
    }) as typeof fetch;
    const p = registerCommands({ applicationId: APP_ID, botToken: seeds.token, guildId: GUILD_ID, commands: [], fetch: wrapped });
    await vi.advanceTimersByTimeAsync(70_000);
    const result = await p;
    expect(result.ok).toBe(mode.kind === 'junk' ? false : false);
    expectNoLeak(result, 'registerCommands result');
    expect(Object.keys(result).sort()).toEqual(['ok', 'status']);
    for (const headers of seen) expect(Object.entries(headers).filter(([, v]) => v.includes(seeds.token)).map(([k]) => k.toLowerCase())).toEqual(['authorization']);
  });

  it('coop: inbound refusals, a signed body full of seeds, a failing store, a throwing signal read: nothing seeded is logged or answered', async () => {
    const flags = { reports: false };
    const pair = sharedPair();
    const c = await coopWorld({
      options: {
        apiKey: seeds.key,
        baseUrl: `https://coop.example.test/${seeds.url}`,
        callbackAuth: { header: 'x-cross-auth', value: seeds.secret },
        signal: { secret: `${seeds.secret}-0123456789abcdefghij`, read: () => { throw leak('read'); } },
        aiSeverity: () => { throw leak('severity'); },
        includeNote: true,
        handles: 'shown',
        fetch: hostileFetch({ kind: 'status', status: 500 }).fn,
      },
      wrapKit: (cw) => failing(cw, ['reports', 'get'], () => flags.reports),
    });
    const sent: unknown[] = [];
    const send = async (req: KitRequest) => {
      const res = await c.send(req);
      sent.push(res.body);
      return res;
    };
    const filed = await seededReport(c.cw);
    const auth = { 'x-cross-auth': seeds.secret };
    await send(callbackRequest(callbackBody(filed), { pair: newRsaPair(), headers: auth }));
    await send(callbackRequest(callbackBody(filed), { headers: { ...auth, 'coop-signature': undefined } }));
    await send(callbackRequest(callbackBody(filed), { sendRaw: `{"x":"${seeds.text}"}`, headers: auth }));
    await send(callbackRequest(callbackBody(filed), { headers: {} }));
    // A signed body that holds seeds in every field it has.
    const hostile = callbackBody(seeds.id, {
      action: { id: seeds.id },
      policies: [{ id: seeds.id, name: seeds.text }],
      custom: { [seeds.key]: seeds.text },
      actorEmail: `${seeds.handle}@example.test`,
      decisionReason: seeds.text,
    });
    await send(callbackRequest(hostile, { headers: auth }));
    await send(callbackRequest(callbackBody(filed, { action: { id: seeds.id } }), { headers: auth }));
    await send(callbackRequest('not json LEAK', { headers: auth }));
    flags.reports = true;
    await send(callbackRequest(callbackBody(filed), { headers: auth, pair }));
    flags.reports = false;
    // The signal route.
    const raw = JSON.stringify({ lines: [{ label: 'reporter', text: seeds.text }] });
    const ts = Math.floor(c.w.clock.now() / 1000);
    const signalKey = `${seeds.secret}-0123456789abcdefghij`;
    const signed = (secret: string, body: string): KitRequest => ({
      method: 'POST',
      path: '/coop/signal',
      query: {},
      headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: sign(secret, ts, body) },
      body: undefined,
      rawBody: body,
    });
    await send(signed(signalKey, raw));
    await send(signed('some-other-secret-0123456789abcdefghij', raw));
    await send(signed(signalKey, `{"lines":"${seeds.text}"}`));
    expect(c.logged.length).toBeGreaterThan(2);
    expectClean(c.logged as Logged, 'coop');
    expectNoLeak(sent, 'coop answers');
    c.adapter.dispose();
  });

  it.each(MODES.map((m) => [modeName(m), m] as const))('coop, outbound and sweep (%s): every retry and the last failure log a status or a class, with every evidence, includeNote and handles mix', async (_name, mode) => {
    for (const evidence of ['none', 'excerpt'] as const) {
      for (const includeNote of [false, true]) {
        for (const handles of ['hidden', 'shown'] as const) {
          const c = await coopWorld({ options: { apiKey: seeds.key, baseUrl: `https://coop.example.test/${seeds.url}`, evidence, includeNote, handles, fetch: hostileFetch(mode).fn } });
          vi.useFakeTimers();
          await seededReport(c.cw);
          await vi.advanceTimersByTimeAsync(120_000);
          const p = c.adapter.sweep();
          await vi.advanceTimersByTimeAsync(120_000);
          await p;
          expectClean(c.logged as Logged, `coop ${modeName(mode)} ${evidence}/${String(includeNote)}/${handles}`);
          c.adapter.dispose();
          vi.useRealTimers();
        }
      }
    }
  });

  it('coop setup.verify with failing answers: the result holds a status or a class, never the key', async () => {
    for (const mode of MODES) {
      const c = await coopWorld({ options: { apiKey: seeds.key, fetch: hostileFetch(mode).fn } });
      vi.useFakeTimers();
      const p = c.adapter.setup.verify();
      await vi.advanceTimersByTimeAsync(30_000);
      expectNoLeak(await p, `verify ${modeName(mode)}`);
      expectClean(c.logged as Logged, `verify ${modeName(mode)}`);
      c.adapter.dispose();
      vi.useRealTimers();
    }
  });

  it('eos: a throwing productUserIdsOf, seatOf and players, and junk answers: nothing seeded is logged', async () => {
    const c = await eosWorld({
      sanctions: { productUserIdsOf: () => { throw leak('ids'); } },
      reports: { seatOf: () => { throw leak('seat'); }, players: () => { throw leak('players'); } },
      options: { clientSecret: seeds.secret, clientId: seeds.key, deploymentId: seeds.id },
    });
    await c.w.cw.sanctions.apply({ kind: 'chat', subject: c.w.person(), includeIp: false, durationMs: DAY, reason: seeds.text, actor: 'ann', source: 'moderator', automated: false, rule: 1 });
    await idle();
    await c.adapter.pollReports();
    expect(c.logged.length).toBeGreaterThan(0);
    expectClean(c.logged as Logged, 'eos adapter functions');
    c.adapter.dispose();
  });

  it.each(MODES.map((m) => [modeName(m), m] as const))('eos, push and pull (%s): the token step and the API steps log a status or a class', async (_name, mode) => {
    for (const target of ['token', 'api'] as const) {
      const h = hostileFetch(
        mode,
        target === 'api'
          ? (url) => (url.includes('/oauth/token') ? new Response(JSON.stringify({ access_token: 'cross-access-token-0001', expires_in: 3600 }), { status: 200 }) : undefined)
          : undefined,
      );
      const w = await world();
      const puid = `${seeds.id}-puid`;
      // The first push goes to the healthy fake, so there is an active link to revoke; then EOS turns hostile.
      const route: { to?: typeof fetch } = {};
      const c = makeEos(w, {
        sanctions: { justification: 'reason' },
        fake: { clientId: seeds.key, clientSecret: seeds.secret, deploymentId: seeds.url },
        options: { clientId: seeds.key, clientSecret: seeds.secret, deploymentId: seeds.url, baseUrl: EOS_URL, fetch: ((...args: Parameters<typeof fetch>) => (route.to ?? c.fake.fetch)(...args)) as typeof fetch },
      });
      const subject = w.person();
      c.accounts.set(subject, [puid]);
      const second = w.person();
      c.accounts.set(second, [`${puid}-2`]);
      // A seated pair the pull can place.
      const reporter = `${seeds.id}-reporter`;
      const room = `cross-eos-${++roomN}`;
      w.cw.rooms.seat(room, 'p1', { clientKey: `${seeds.key}-a`, ip: '198.51.100.8' }, seeds.handle);
      w.cw.rooms.seat(room, 'p2', { clientKey: `${seeds.key}-b`, ip: '203.0.113.8' }, seeds.handle);
      c.seats.set(reporter, { roomId: room, seatId: 'p1' });
      c.seats.set(puid, { roomId: room, seatId: 'p2' });
      c.players.push(puid);
      vi.useFakeTimers();
      const input = { kind: 'ban' as const, includeIp: false, durationMs: DAY, reason: seeds.text, actor: 'ann', source: 'moderator' as const, automated: false, rule: 1 };
      const group = await w.cw.sanctions.apply({ ...input, subject });
      await vi.advanceTimersByTimeAsync(5000);
      expect(c.fake.sanctions).toHaveLength(1);
      route.to = h.fn;
      w.clock.t += 2 * 3_600_000;
      await w.cw.sanctions.revoke(group.groupId, 'ann', seeds.text);
      await w.cw.sanctions.apply({ ...input, subject: second });
      await vi.advanceTimersByTimeAsync(120_000);
      const polled = c.adapter.pollReports();
      await vi.advanceTimersByTimeAsync(120_000);
      await polled;
      expect(c.logged.length, `${target} ${modeName(mode)}`).toBeGreaterThan(0);
      expectClean(c.logged as Logged, `eos ${target} ${modeName(mode)}`);
      c.adapter.dispose();
      vi.useRealTimers();
    }
  });
});

// ---- 2. construction errors never echo a value ----

const BAD_VALUES: unknown[] = ['LEAKstring with a space and é ☃', 987654.321, { LEAKkey: 'LEAKvalue' }, ['LEAKelement'], -987654, { __proto__: null, LEAKnull: 'LEAKnullvalue' }];
const LEAKY = /LEAK|987654/i;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Every path to a value in `base` (a plain object tree), as arrays of keys. */
function paths(base: Record<string, unknown>, prefix: string[] = []): string[][] {
  return Object.keys(base).flatMap((k) => {
    const here = [...prefix, k];
    const child = base[k];
    return isPlain(child) ? [here, ...paths(child, here)] : [here];
  });
}
/** A deep copy of `base` with the value at `path` replaced (the functions and class instances are shared, not copied). */
function withValue(base: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path as [string, ...string[]];
  const copy: Record<string, unknown> = { ...base };
  copy[head] = rest.length === 0 ? value : withValue(base[head] as Record<string, unknown>, rest, value);
  return copy;
}
/** A deep copy of `base` with an extra key (holding a plausible value) inside the object at `path` (the root when empty). */
function withExtraKey(base: Record<string, unknown>, path: readonly string[], key: string, value: unknown): Record<string, unknown> {
  if (path.length === 0) return { ...base, [key]: value };
  const [head, ...rest] = path as [string, ...string[]];
  return { ...base, [head]: withExtraKey(base[head] as Record<string, unknown>, rest, key, value) };
}
const objectPaths = (base: Record<string, unknown>): string[][] => [[], ...paths(base).filter((p) => isPlain(p.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], base)))];

/** Build with `options`; anything that throws must not carry a seeded value. A build that works is disposed. */
async function expectNoEcho(build: (o: Record<string, unknown>) => unknown, options: Record<string, unknown>, label: string): Promise<void> {
  let built: unknown;
  try {
    built = await build(options);
  } catch (err) {
    const e = err as Error;
    const text = [e.message, e.name, e.stack ?? '', String(err), ...Object.values(e).map((v) => JSON.stringify(v) ?? '')].join('\n');
    expect(LEAKY.test(text), `${label}: ${e.message}`).toBe(false);
    return;
  }
  (built as { dispose?: () => void } | null)?.dispose?.();
}

describe('construction errors never echo a value', () => {
  const fn = (): undefined => undefined;

  const discordBase = (publicKey: string): Record<string, unknown> => ({
    applicationId: APP_ID,
    publicKey,
    guildId: GUILD_ID,
    roles: { moderator: [ROLE_MOD], senior: [ROLE_SENIOR], owner: [ROLE_OWNER] },
    hubLink: () => 'https://hub.example.test/x',
    actions: { dismiss: true, suggestion: true, confirm: true },
    permissions: { 'reports.decide': 'moderator' },
    actorOf: fn,
    rateLimit: { max: 5, windowMs: 1000 },
    timestampToleranceMs: 1000,
    respondWithinMs: 1000,
    schedule: () => fn,
    replay: new ReplayCache(),
    fetch: fn,
    clock: { now: () => 1 },
    logger: { warn: fn },
  });
  const coopBase = (): Record<string, unknown> => ({
    baseUrl: 'https://coop.example.test',
    apiKey: 'a-valid-api-key-0001',
    webhookPublicKey: sharedPair().publicPem,
    itemTypes: { user: 'type-user', line: 'type-line', report: 'type-report' },
    evidence: 'none',
    includeNote: false,
    handles: 'hidden',
    policies: { byReason: { harassment: 'policy-1' }, byRule: { '1': 'policy-1' } },
    actions: { 'action-1': { verdict: 'upheld', kind: 'chat', durationMs: 1000 }, 'action-2': { verdict: 'no_action' } },
    rules: { 'policy-1': 1 },
    role: 'moderator',
    permissions: { 'reports.decide': 'moderator' },
    callbackAuth: { header: 'x-auth', value: 'a-value' },
    catchUpMs: 1000,
    aiSeverity: fn,
    signal: { secret: 'a-signal-secret-0123456789abcdefghij', read: () => 1, rateLimit: { max: 5, windowMs: 1000 }, replay: new ReplayCache() },
    schedule: () => fn,
    fetch: fn,
    clock: { now: () => 1 },
    random: () => 0.5,
    logger: { warn: fn },
  });
  const eosBase = (): Record<string, unknown> => ({
    deploymentId: DEPLOYMENT,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    baseUrl: EOS_URL,
    sanctions: { productUserIdsOf: () => [], actions: { chat: 'cw-chat', ban: 'cw-ban' }, justification: 'ref', includeAutomatic: true },
    reports: { seatOf: () => null, players: () => [], reasons: { '1': 'cheating', '2': null }, pollMs: 5000, batch: 5, maxPerPoll: 5 },
    fetch: fn,
    clock: { now: () => 1 },
    random: () => 0.5,
    logger: { warn: fn },
  });

  async function sweepOptions(label: string, base: Record<string, unknown>, build: (o: Record<string, unknown>) => unknown): Promise<void> {
    // The base itself must build, or the sweep proves nothing.
    const ok = build(base) as { dispose?: () => void };
    ok.dispose?.();
    let tried = 0;
    for (const path of paths(base)) {
      for (const value of BAD_VALUES) {
        tried++;
        await expectNoEcho(build, withValue(base, path, value), `${label} ${path.join('.')}`);
      }
    }
    for (const path of objectPaths(base)) {
      tried++;
      await expectNoEcho(build, withExtraKey(base, path, 'LEAKkey', 'x'), `${label} extra key in ${path.join('.') || 'root'}`);
      tried++;
      await expectNoEcho(build, withExtraKey(base, path, 'LEAKkey', { LEAKinner: 'LEAKvalue' }), `${label} extra object in ${path.join('.') || 'root'}`);
    }
    expect(tried).toBeGreaterThan(50);
  }

  it('discordBot: a distinctive bad value for every option, nested ones too, and a distinctive extra key anywhere', async () => {
    const w = await world();
    await sweepOptions('discordBot', discordBase(newPair().publicKeyHex), (o) => discordBot(w.cw, o as unknown as Parameters<typeof discordBot>[1]));
    for (const options of [undefined, null, 'LEAKtext', 42, ['LEAKelement']]) await expectNoEcho((o) => discordBot(w.cw, o as never), options as never, 'discordBot options');
  });

  it('coop: a distinctive bad value for every option, nested ones too, and a distinctive extra key anywhere', async () => {
    const w = await world();
    await sweepOptions('coop', coopBase(), (o) => coop(w.cw, o as unknown as Parameters<typeof coop>[1]));
    for (const options of [undefined, null, 'LEAKtext', 42, ['LEAKelement']]) await expectNoEcho((o) => coop(w.cw, o as never), options as never, 'coop options');
  });

  it('eos: a distinctive bad value for every option, nested ones too, and a distinctive extra key anywhere', async () => {
    const w = await world();
    await sweepOptions('eos', eosBase(), (o) => eos(w.cw, o as unknown as Parameters<typeof eos>[1]));
    for (const options of [undefined, null, 'LEAKtext', 42, ['LEAKelement']]) await expectNoEcho((o) => eos(w.cw, o as never), options as never, 'eos options');
  });

  it('registerCommands: a distinctive bad value for every option', async () => {
    const base: Record<string, unknown> = { applicationId: APP_ID, botToken: 'a.valid-token_0001', guildId: GUILD_ID, commands: [], fetch: () => Promise.resolve(new Response('[]', { status: 200 })) };
    for (const path of paths(base)) {
      for (const value of BAD_VALUES) await expectNoEcho((o) => registerCommands(o as unknown as Parameters<typeof registerCommands>[0]), withValue(base, path, value), `registerCommands ${path.join('.')}`);
    }
  });
});

// ---- 3. nothing at import; dispose clears every timer ----

describe('dispose clears every timer', () => {
  const hang = (): typeof fetch =>
    ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      })) as typeof fetch;

  it('discord: a slow click leaves a deferral timer and, later, a request timer; dispose leaves none', async () => {
    let slow = false;
    const gate: { release: () => void } = { release: () => undefined };
    const b = await botWorld({
      options: { fetch: hang(), actions: { dismiss: true, suggestion: true, confirm: false } },
      wrapKit: (cw) =>
        new Proxy(cw, {
          get(target, prop, receiver) {
            if (prop === 'reports') {
              return new Proxy(target.reports, {
                get(t, p, r) {
                  if (p === 'decide' && slow) return () => new Promise((resolve) => (gate.release = () => resolve({ ok: false })));
                  return Reflect.get(t, p, r) as unknown;
                },
              });
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        }),
    });
    const filed = await b.w.file();
    vi.useFakeTimers();
    const base = vi.getTimerCount();
    slow = true;
    const click = b.send(b.client.click(`cw1:dis:${filed.id}`));
    await vi.advanceTimersByTimeAsync(0);
    await click;
    await vi.advanceTimersByTimeAsync(3000);
    b.bot.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(base);
  });

  it('coop: a job being retried, a request in flight and a slow signal read; dispose leaves no timer', async () => {
    for (const script of ['retry', 'hang'] as const) {
      const c = await coopWorld({
        options: {
          fetch: script === 'hang' ? hang() : hostileFetch({ kind: 'status', status: 503 }).fn,
          signal: { secret: 'a-signal-secret-0123456789abcdefghij', read: () => new Promise<number>(() => undefined) },
        },
      });
      vi.useFakeTimers();
      const base = vi.getTimerCount();
      await seededReport(c.cw);
      await vi.advanceTimersByTimeAsync(2500);
      expect(vi.getTimerCount(), script).toBeGreaterThan(base);
      const ts = Math.floor(c.w.clock.now() / 1000);
      const body = JSON.stringify({ lines: [{ label: 'reporter', text: 'zorbak' }] });
      void c.send({ method: 'POST', path: '/coop/signal', query: {}, headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: sign('a-signal-secret-0123456789abcdefghij', ts, body) }, body: undefined, rawBody: body });
      await vi.advanceTimersByTimeAsync(10);
      c.adapter.dispose();
      c.adapter.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount(), script).toBe(base);
      vi.useRealTimers();
    }
  });

  it('eos: the poll timer, a request in flight, a job being retried and the token request; dispose leaves no timer', async () => {
    for (const script of ['retry', 'hang'] as const) {
      const w = await world();
      const c = makeEos(w, { options: { fetch: script === 'hang' ? hang() : hostileFetch({ kind: 'status', status: 503 }).fn } });
      const subject = w.person();
      c.accounts.set(subject, ['puid-cross-0001']);
      c.players.push('puid-cross-0002');
      vi.useFakeTimers();
      const base = vi.getTimerCount();
      c.adapter.start();
      void w.cw.sanctions.apply({ kind: 'chat', subject, includeIp: false, durationMs: DAY, reason: 'a reason', actor: 'ann', source: 'moderator', automated: false, rule: 1 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount(), script).toBeGreaterThan(base);
      c.adapter.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount(), script).toBe(base);
      vi.useRealTimers();
    }
  });
});

// ---- 4. the root, the sources ----

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}${e.name}/`) : e.name.endsWith('.ts') ? [`${dir}${e.name}`] : []));
const SUBPATH_FILES = ['discord/', 'coop/', 'eos/'].flatMap((d) => walk(`${SRC}${d}`));
const SHARED_FILES = ['internal/deliveryQueue.ts', 'internal/boundedText.ts', 'admin/decideAs.ts'].map((f) => `${SRC}${f}`);
/** The code of a file with block comments, line comments and string-free comment markers removed (a URL's `//` is kept). */
const codeOf = (file: string): string => readFileSync(file, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|\s)\/\/.*$/gm, '$1');

describe('the root and the sources', () => {
  it('the three subpaths are not exported from the root; the root export list is unchanged', () => {
    expect(Object.keys(http).sort()).toEqual(ROOT_EXPORTS);
    for (const name of ['discordBot', 'registerCommands', 'verifyInteraction', 'coop', 'eos', 'decideAs', 'createDeliveryQueue', 'readBoundedText']) expect(name in http, name).toBe(false);
    const index = readFileSync(`${SRC}index.ts`, 'utf8');
    expect(index).not.toMatch(/['"]\.\/(?:discord|coop|eos|internal)\//);
    expect(index).not.toMatch(/decideAs|deliveryQueue/);
  });

  it('there are source files to scan (the scans below are not vacuous)', () => {
    expect(SUBPATH_FILES.length).toBeGreaterThanOrEqual(30);
    expect(SUBPATH_FILES.some((f) => f.endsWith('coop/inbound.ts'))).toBe(true);
    expect(SUBPATH_FILES.some((f) => f.endsWith('eos/reports.ts'))).toBe(true);
    expect(SUBPATH_FILES.some((f) => f.endsWith('discord/bot.ts'))).toBe(true);
  });

  it('no adapter reads process.env (or any other global of the process)', () => {
    for (const file of [...SUBPATH_FILES, ...SHARED_FILES]) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/\bprocess\b/);
      expect(code, file).not.toMatch(/import\.meta\.env|Deno\.env|\bBun\.env/);
      expect(code, file).not.toMatch(/\bglobalThis\s*\.\s*process\b/);
    }
  });

  it('no Date.now() or Math.random() in the three subpaths beyond the one default each option gives', () => {
    let defaults = 0;
    for (const file of [...SUBPATH_FILES, ...SHARED_FILES]) {
      const code = codeOf(file);
      const withoutDefault = code.replaceAll('const systemClock: Clock = { now: () => Date.now() };', () => (defaults++, ''));
      expect(withoutDefault, file).not.toMatch(/Date\.now|new Date\(\s*\)|performance\.now|process\.hrtime/);
      const withoutRandom = withoutDefault.replaceAll('random ?? Math.random', '');
      expect(withoutRandom, file).not.toMatch(/Math\.random/);
    }
    // One default clock for each adapter, and no other.
    expect(defaults).toBe(3);
  });

  it('importing the three subpaths together starts nothing: no timer, no listener, no request', async () => {
    vi.useFakeTimers();
    const listeners = process.eventNames().map((n) => process.listenerCount(n));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      vi.resetModules();
      const mods = await Promise.all([import('../src/discord/index.js'), import('../src/coop/index.js'), import('../src/eos/index.js')]);
      expect(typeof mods[0].discordBot).toBe('function');
      expect(typeof mods[1].coop).toBe('function');
      expect(typeof mods[2].eos).toBe('function');
      expect(vi.getTimerCount()).toBe(0);
      expect(process.eventNames().map((n) => process.listenerCount(n))).toEqual(listeners);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

