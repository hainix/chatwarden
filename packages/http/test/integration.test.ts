import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden, Logger, RawWho } from '@chatwarden/core';
import { discordFeed } from '@chatwarden/discord';
import type { DiscordFeed } from '@chatwarden/discord';
import { LiveTerms } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/test-fixtures';
import { openStore } from '@chatwarden/store-sqlite';
import { adminRoutes, healthRoutes, playerRoutes, ReplayCache, sign, verify, webhookIn, webhooksOut } from '../src/index.js';
import type { KitRequest, WebhooksOut } from '../src/index.js';
import { toExpress } from '../src/express.js';
import { DELIVERY_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../src/webhooks/sign.js';

// The whole kit over real HTTP: a real Express app (`toExpress`), a real SQLite store in memory, the real LiveTerms, real
// `fetch`, a real webhook receiver (a local node:http server that verifies with our own `verify`), and a fake Discord
// (an injected `fetch`, so the webhook URL stays a valid discord.com one).

const ROOM = 'room-int';
const KEY_ALICE = 'raw-client-key-alice-integration-0001';
const KEY_BOB = 'raw-client-key-bob-integration-000002';
const IP = '127.0.0.1';
const CHAT_ALICE = 'ALICE-CHAT-LINE about the weather';
const CHAT_BOB = 'BOB-CHAT-LINE about the lobby';
const NOTE = 'REPORTER-NOTE-TEXT';
const REASON = 'PRIVATE-MODERATOR-REASON';
const REVOKE_REASON = 'PRIVATE-REVOKE-REASON';
const HANDLE_ALICE = 'HandleAliceIntegration';
const HANDLE_BOB = 'HandleBobIntegration';
const MOD_TOKEN = 'token-moderator';
const SENIOR_TOKEN = 'token-senior';
const SECRET_PLAIN = 'plain-endpoint-secret-at-least-32-characters';
const SECRET_EXCERPT = 'excerpt-endpoint-secret-at-least-32-characters';
const SECRET_IN = 'incoming-endpoint-secret-at-least-32-chars';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/tok_ABC-def_123XYZ';
const ROLE = '987654321098765432';

// ---- the leak scan ----

const SUBJECT_ID = /s_[A-Za-z0-9_-]{6,}/;
const LONG_HEX = /[0-9a-f]{32,}/i;

/** Links are the one place an id may appear in Discord text: markdown links and bare URLs are cut out before a scan. */
const withoutLinks = (text: string): string =>
  text.replace(/\]\(<[^>]*>\)/g, '](link)').replace(/<https?:\/\/[^>\s]*>/g, '<link>').replace(/https?:\/\/\S+/g, 'link');

interface ScanOptions {
  /** Strings that must not appear (ids, raw keys, addresses, chat lines, notes, reasons, handles). */
  forbidden: readonly string[];
  /** A subject id is allowed (a staff channel's body carries them by design). */
  subjectIds?: boolean;
  /** Links are cut out first (Discord text). */
  links?: boolean;
}

/** What a scan finds in `text`. Empty means clean. */
function leaks(text: string, o: ScanOptions): string[] {
  const visible = o.links === true ? withoutLinks(text) : text;
  const found: string[] = [];
  if (o.subjectIds !== true && SUBJECT_ID.test(visible)) found.push('subject-id');
  if (LONG_HEX.test(visible)) found.push('hex-hash');
  for (const f of o.forbidden) if (f !== '' && visible.includes(f)) found.push(`forbidden:${f}`);
  return found;
}

// ---- helpers ----

interface Received {
  path: string;
  headers: Record<string, string>;
  body: string;
  verified: boolean;
  json: { id: string; type: string; at: number; data: Record<string, unknown> };
}

interface Reply {
  status: number;
  text: string;
  json: Record<string, unknown>;
  headers: Headers;
}

const parseObject = (text: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const shut = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

/** A webhook receiver: two paths (`/plain`, `/excerpts`) with their own secrets; every body is verified and recorded. */
async function receiver() {
  const received: Received[] = [];
  const caches = new Map<string, ReplayCache>();
  const secrets: Record<string, string> = { '/plain': SECRET_PLAIN, '/excerpts': SECRET_EXCERPT };
  const server = createServer((req, res) => {
    void (async () => {
      const path = req.url ?? '';
      const body = await readBody(req);
      const secret = secrets[path];
      if (secret === undefined) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      const cache = caches.get(path) ?? new ReplayCache();
      caches.set(path, cache);
      // The receiver's whole job: verify with the kit's own `verify`, before it trusts anything.
      const verified = verify(secret, headers, body, Date.now(), cache);
      received.push({ path, headers, body, verified, json: JSON.parse(body) as Received['json'] });
      res.statusCode = verified ? 200 : 401;
      res.end();
    })();
  });
  const port = await listen(server);
  return { received, port, server };
}

/** A fake Discord forum webhook: opens thread `T<n>`, accepts posts into one. */
function fakeDiscord() {
  const calls: Array<{ url: URL; body: Record<string, unknown> }> = [];
  let threads = 0;
  const fetchFn = ((url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: u, body });
    if (u.searchParams.has('thread_id')) return Promise.resolve(new Response(JSON.stringify({ id: `m${calls.length}` }), { status: 200 }));
    threads++;
    return Promise.resolve(new Response(JSON.stringify({ id: `m${calls.length}`, channel_id: `T${threads}` }), { status: 200 }));
  }) as typeof fetch;
  const texts = (): string[] => calls.flatMap((c) => [String(c.body.content ?? ''), String(c.body.thread_name ?? '')]).filter((t) => t !== '');
  return { fetch: fetchFn, calls, texts, creates: () => calls.filter((c) => !c.url.searchParams.has('thread_id')) };
}

interface World {
  cw: Chatwarden;
  port: number;
  base: string;
  hooks: Awaited<ReturnType<typeof receiver>>;
  discord: ReturnType<typeof fakeDiscord>;
  logged: Array<[string, Record<string, string | number | boolean> | undefined]>;
  alice: string;
  bob: string;
  /** Player responses (bodies as text), every one, in the order they were made. */
  playerBodies: string[];
  close(): Promise<void>;
}

async function boot(o: { healthFirst?: boolean } = {}): Promise<World> {
  const db = new DatabaseSync(':memory:');
  const store = openStore({ db });
  const clock = { now: () => Date.now() };
  const logged: World['logged'] = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const terms = new LiveTerms({ store, pack: syntheticTermPack(), clock, logger });
  await terms.load();
  const cw = await createChatwarden({
    store,
    secret: 'integration-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    matcher: terms,
    clock,
    logger,
    retention: false,
  });

  // The people: two seats, each with a line of chat.
  cw.rooms.seat(ROOM, 'a', { clientKey: KEY_ALICE, ip: IP }, HANDLE_ALICE);
  cw.rooms.seat(ROOM, 'b', { clientKey: KEY_BOB, ip: IP }, HANDLE_BOB);
  cw.chat.accept(ROOM, 'a', CHAT_ALICE);
  cw.chat.accept(ROOM, 'b', CHAT_BOB);
  const alice = cw.rooms.subjectAt(ROOM, 'a') as string;
  const bob = cw.rooms.subjectAt(ROOM, 'b') as string;

  const hooks = await receiver();
  const discord = fakeDiscord();

  const app = express();
  app.disable('x-powered-by');
  // The kit routes first, and no body parser anywhere: the adapter reads the raw body itself.
  app.use(
    '/admin',
    toExpress(
      adminRoutes(cw, {
        authorize: (req: KitRequest) => {
          const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
          if (token === MOD_TOKEN) return { actor: 'mod@example.test', role: 'moderator' };
          if (token === SENIOR_TOKEN) return { actor: 'senior@example.test', role: 'senior' };
          return null;
        },
        terms,
        gameName: 'Integration Game',
        logger,
      }),
    ),
  );
  app.use(
    '/api',
    toExpress(
      playerRoutes(cw, {
        identify: (req: KitRequest): RawWho => ({
          ...(req.headers['x-player-key'] === undefined ? {} : { clientKey: req.headers['x-player-key'] }),
          // The socket peer, never a header.
          ...(req.remoteAddress === undefined ? {} : { ip: req.remoteAddress }),
        }),
        gameName: 'Integration Game',
        logger,
      }),
    ),
  );
  // The probes at the root. With `healthFirst` they come BEFORE the hooks and the adopter's routes: the kit hands paths that
  // are not its own to the next handler, so nothing after it is hidden.
  if (o.healthFirst === true) app.use(toExpress(healthRoutes(cw, { logger })));
  app.use('/hooks', toExpress(webhookIn(cw, { secret: SECRET_IN, actor: 'webhook@example.test', logger })));
  // The adopter's own routes, one of them with a body parser of its own.
  app.get('/mine', (_req, res) => void res.send('mine'));
  app.post('/json', express.json(), (req, res) => void res.json({ got: req.body as unknown }));
  if (o.healthFirst !== true) app.use(toExpress(healthRoutes(cw, { logger })));
  const server = createServer(app);
  const port = await listen(server);

  const out: WebhooksOut = webhooksOut(cw, {
    endpoints: [
      { url: `http://127.0.0.1:${hooks.port}/plain`, secret: SECRET_PLAIN, events: '*' },
      { url: `http://127.0.0.1:${hooks.port}/excerpts`, secret: SECRET_EXCERPT, events: ['report.created'], includeExcerpts: true },
    ],
    logger,
  });
  const feed: DiscordFeed = discordFeed(cw, {
    webhookUrl: WEBHOOK,
    hubLink: (kind, id) => `https://hub.example.test/${kind}/${encodeURIComponent(id)}`,
    mentionRoleId: ROLE,
    fetch: discord.fetch,
    logger,
  });

  return {
    cw,
    port,
    base: `http://127.0.0.1:${port}`,
    hooks,
    discord,
    logged,
    alice,
    bob,
    playerBodies: [],
    close: async () => {
      out.dispose();
      feed.dispose();
      await shut(server);
      await shut(hooks.server);
      await cw.close();
    },
  };
}

const staff = (token: string | null, extra: Record<string, string> = {}): Record<string, string> => ({
  ...(token === null ? {} : { authorization: `Bearer ${token}` }),
  ...extra,
});

async function call(w: World, method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  const res = await fetch(`${w.base}${path}`, {
    method,
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: parseObject(text), headers: res.headers };
}

/** A player call: the body is kept for the leak scan, whatever the route. */
async function player(w: World, method: string, path: string, key: string | null, body?: unknown): Promise<Reply> {
  const res = await call(w, method, path, { headers: key === null ? {} : { 'x-player-key': key }, ...(body === undefined ? {} : { body }) });
  w.playerBodies.push(res.text);
  return res;
}

const eventsOf = (w: World, type: string): Received[] => w.hooks.received.filter((r) => r.path === '/plain' && r.json.type === type);
const shown = (r: Reply): string => `${r.status} ${r.text}`;

// ---- the flow ----

describe('integration: the kit over real Express', () => {
  let w: World;
  let reportId = '';
  let groupId = '';
  let refCode = '';
  let noticeId = '';

  beforeAll(async () => {
    w = await boot();
  });
  afterAll(async () => {
    await w.close();
  });

  it('1. a player reports', async () => {
    const res = await w.cw.reports.submit({ roomId: ROOM, reporterSeat: 'b', targetSeat: 'a', category: 'harassment', note: NOTE });
    if (!res.ok) throw new Error('expected a stored report');
    reportId = res.reportId;
    // The signed webhook arrives, and Discord opens the person's thread.
    await vi.waitFor(() => expect(eventsOf(w, 'report.created')).toHaveLength(1));
    await vi.waitFor(() => expect(w.discord.creates()).toHaveLength(1));
    expect(eventsOf(w, 'report.created')[0]?.json.data).toMatchObject({ type: 'report.created', reportId, category: 'harassment' });
  });

  it('2a. the staff API refuses nobody (401) and a too-low role (403), with fixed bodies', async () => {
    const none = await call(w, 'GET', '/admin/reports');
    expect(none.status).toBe(401);
    expect(none.json).toEqual({ error: 'unauthorized', message: 'Authentication is required.' });
    const bad = await call(w, 'GET', '/admin/reports', { headers: staff('wrong-token') });
    expect(bad.status).toBe(401);
    const low = await call(w, 'GET', '/admin/audit', { headers: staff(MOD_TOKEN) });
    expect(low.status).toBe(403);
    expect(low.json).toEqual({ error: 'forbidden', message: 'You do not have permission to do this.' });
    const unknown = await call(w, 'GET', '/admin/reports/no-such-report', { headers: staff(MOD_TOKEN) });
    expect(unknown.status).toBe(404);
  });

  it('2b. staff list, then get (audited), then decide a warning', async () => {
    const list = await call(w, 'GET', '/admin/reports', { headers: staff(MOD_TOKEN) });
    expect(list.status).toBe(200);
    expect((list.json.items as Array<{ id: string }>).map((r) => r.id)).toContain(reportId);

    const got = await call(w, 'GET', `/admin/reports/${reportId}`, { headers: staff(MOD_TOKEN) });
    expect(got.status).toBe(200);
    const report = got.json.report as { targetSubject: string; reporterSubject: string };
    expect(report.targetSubject).toBe(w.alice);
    expect(report.reporterSubject).toBe(w.bob);

    const decided = await call(w, 'POST', `/admin/reports/${reportId}/decide`, {
      headers: staff(MOD_TOKEN),
      body: { verdict: 'upheld', reason: REASON, actions: [{ subject: w.alice, kind: 'warning', durationMs: null, rule: 2 }] },
    });
    expect(shown(decided)).toMatch(/^200 /);
    expect(decided.json).toMatchObject({ ok: true, replay: false });
    const groups = decided.json.groups as Array<{ refCode: string; kind: string }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('warning');
    refCode = groups[0]?.refCode as string;

    // The same decision again is a replay: nothing is applied twice.
    const again = await call(w, 'POST', `/admin/reports/${reportId}/decide`, {
      headers: staff(MOD_TOKEN),
      body: { verdict: 'upheld', reason: REASON, actions: [{ subject: w.alice, kind: 'warning', durationMs: null, rule: 2 }] },
    });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ ok: true, replay: true });
  });

  it('2c. the audit trail holds the view and the decision, as ids and action names only', async () => {
    const audit = await call(w, 'GET', '/admin/audit?limit=50', { headers: staff(SENIOR_TOKEN) });
    expect(audit.status).toBe(200);
    const rows = (audit.json.items as Array<{ actor: string; role: string; action: string; target?: { type: string; ref: string } }>).filter(
      (r) => r.role !== undefined && r.role !== null,
    );
    const view = rows.find((r) => r.action === 'report.view' && r.target?.ref === reportId);
    expect(view).toMatchObject({ actor: 'mod@example.test', role: 'moderator' });
    expect(rows.some((r) => r.action === 'report.decide' && r.target?.ref === reportId && r.actor === 'mod@example.test')).toBe(true);
    for (const text of [REASON, NOTE, CHAT_ALICE, CHAT_BOB]) expect(audit.text).not.toContain(text);
  });

  it('3. the player sees the notice, acknowledges it, and finds it in the record', async () => {
    const pending = await player(w, 'GET', '/api/notices', KEY_ALICE);
    expect(pending.status).toBe(200);
    expect(pending.headers.get('cache-control')).toBe('no-store');
    const notices = pending.json.notices as Array<{ id: string; kind?: string; rule?: number; refCode?: string }>;
    expect(notices).toHaveLength(1);
    noticeId = notices[0]?.id as string;
    expect(notices[0]).toMatchObject({ kind: 'warning', rule: 2, refCode });

    const stranger = await player(w, 'POST', `/api/notices/${noticeId}/ack`, KEY_BOB);
    expect(stranger.json).toEqual({ ok: false });
    const nobody = await player(w, 'POST', `/api/notices/${noticeId}/ack`, null);
    expect(nobody.json).toEqual({ ok: false });

    const acked = await player(w, 'POST', `/api/notices/${noticeId}/ack`, KEY_ALICE);
    expect(acked.json).toEqual({ ok: true });
    expect(((await player(w, 'GET', '/api/notices', KEY_ALICE)).json.notices as unknown[]).length).toBe(0);

    const record = await player(w, 'GET', '/api/record', KEY_ALICE);
    const entries = record.json.record as Array<{ kind?: string; refCode?: string }>;
    expect(entries.map((e) => e.refCode)).toContain(refCode);
  });

  it('4. staff revoke the group, and the record is empty again', async () => {
    // The group id is staff-only: it comes from the signed sanction.applied event.
    await vi.waitFor(() => expect(eventsOf(w, 'sanction.applied')).toHaveLength(1));
    groupId = eventsOf(w, 'sanction.applied')[0]?.json.data.groupId as string;
    expect(groupId).toBeTruthy();

    const revoked = await call(w, 'POST', `/admin/sanctions/${groupId}/revoke`, { headers: staff(MOD_TOKEN), body: { reason: REVOKE_REASON } });
    expect(revoked.status).toBe(200);
    expect(revoked.json).toEqual({ ok: true });
    const twice = await call(w, 'POST', `/admin/sanctions/${groupId}/revoke`, { headers: staff(MOD_TOKEN), body: { reason: REVOKE_REASON } });
    expect(twice.status).toBe(404);

    const record = await player(w, 'GET', '/api/record', KEY_ALICE);
    expect(record.json.record).toEqual([]);
    expect((await player(w, 'GET', '/api/notices', KEY_ALICE)).json.notices).toEqual([]);
  });

  it('5. the webhook endpoint received signed, verified deliveries', async () => {
    await vi.waitFor(() => expect(eventsOf(w, 'sanction.revoked')).toHaveLength(1));
    const plain = w.hooks.received.filter((r) => r.path === '/plain');
    const types = plain.map((r) => r.json.type);
    expect(types).toContain('report.created');
    expect(types).toContain('report.closed');
    expect(types).toContain('sanction.applied');
    expect(types).toContain('sanction.revoked');
    expect(types.filter((t) => t === 'sanction.applied')).toHaveLength(1);

    for (const r of w.hooks.received) {
      expect(r.verified).toBe(true);
      expect(r.headers[SIGNATURE_HEADER]).toMatch(/^v1=[0-9a-f]{64}$/);
      expect(r.headers[TIMESTAMP_HEADER]).toMatch(/^\d{10}$/);
      expect(r.headers[DELIVERY_HEADER]).toBe(r.json.id);
    }
    expect(new Set(plain.map((r) => r.json.id)).size).toBe(plain.length);

    // The same bytes with the same signature are refused the second time (a replay), and a changed byte fails.
    const first = plain[0] as Received;
    const cache = new ReplayCache();
    const headers = first.headers;
    expect(verify(SECRET_PLAIN, headers, first.body, Date.now(), cache)).toBe(true);
    expect(verify(SECRET_PLAIN, headers, first.body, Date.now(), cache)).toBe(false);
    expect(verify(SECRET_PLAIN, headers, `${first.body} `, Date.now(), new ReplayCache())).toBe(false);
    expect(verify('some-other-secret-that-is-32-characters-long', headers, first.body, Date.now(), new ReplayCache())).toBe(false);

    // Signed with the staff-side data they are meant for: the event names the subject (staff only) and the ref code.
    const applied = eventsOf(w, 'sanction.applied')[0]?.json.data;
    expect(applied).toMatchObject({ refCode, kind: 'warning', rule: 2, target: w.alice });
  });

  it('6. Discord got one thread with the posts, and the visible text names no one', async () => {
    await vi.waitFor(() => expect(w.discord.calls.length).toBeGreaterThanOrEqual(4));
    expect(w.discord.creates()).toHaveLength(1);
    expect(w.discord.creates()[0]?.body.thread_name).toMatch(/^Case [0-9A-HJKMNP-TV-Z]{5}$/);
    for (const post of w.discord.calls.slice(1)) expect(post.url.searchParams.get('thread_id')).toBe('T1');

    const all = w.discord.texts().join('\n');
    expect(all).toContain('**New report**');
    expect(all).toContain('**Report closed** · Upheld');
    expect(all).toContain('**Sanction applied** · Warning');
    expect(all).toContain(`Ref: ${refCode}`);
    expect(all).toContain('Community Rule 2');
    expect(all).toContain('**Lifted**');
    // Ids appear only inside the hub links.
    expect(all).toContain(`https://hub.example.test/report/${reportId}`);
    expect(all).toContain(`https://hub.example.test/person/${w.alice}`);
    expect(withoutLinks(all)).not.toContain(w.alice);
    expect(withoutLinks(all)).not.toContain(reportId);
    for (const call of w.discord.calls) expect(call.body.allowed_mentions).toMatchObject({ parse: [] });
  });

  it('7. the health probes answer without detail', async () => {
    const live = await call(w, 'GET', '/healthz');
    expect(live).toMatchObject({ status: 200, json: { ok: true } });
    const ready = await call(w, 'GET', '/readyz');
    expect(ready).toMatchObject({ status: 200, json: { ok: true } });
    w.playerBodies.push(live.text, ready.text);
  });

  it('8. the player API answers rules, the code of conduct and a name check', async () => {
    const rules = await player(w, 'GET', '/api/rules', null);
    expect(rules.status).toBe(200);
    const coc = await player(w, 'GET', '/api/code-of-conduct?format=html', null);
    expect(coc.status).toBe(200);
    expect(coc.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    const names = await player(w, 'POST', '/api/names/check', KEY_ALICE, { name: 'FineName' });
    expect(names.json).toEqual({ ok: true });
    const bad = await player(w, 'POST', '/api/names/check', KEY_ALICE, { name: 'zorbak' });
    expect(bad.json).toMatchObject({ ok: false, reason: 'name_not_allowed' });
    const wrong = await player(w, 'GET', '/api/code-of-conduct?format=pdf', null);
    expect(wrong.status).toBe(400);
    // The reporter's own feedback and the stranger's empty list, as players see them.
    await player(w, 'GET', '/api/notices', KEY_BOB);
    await player(w, 'GET', '/api/record', KEY_BOB);
    await player(w, 'GET', '/api/notices', 'a-key-nobody-has-0000000000000000');
  });

  it('9. one leak scan over every player response, every webhook body and all Discord text', () => {
    const forbidden = [
      w.alice,
      w.bob,
      reportId,
      groupId,
      KEY_ALICE,
      KEY_BOB,
      IP,
      CHAT_ALICE,
      CHAT_BOB,
      NOTE,
      REASON,
      REVOKE_REASON,
      HANDLE_ALICE,
      HANDLE_BOB,
      MOD_TOKEN,
      SENIOR_TOKEN,
      SECRET_PLAIN,
      SECRET_EXCERPT,
      SECRET_IN,
    ];

    // Player responses: not one identifier, hash or other player's text.
    expect(w.playerBodies.length).toBeGreaterThan(10);
    const playerLeaks = w.playerBodies.flatMap((b) => leaks(b, { forbidden }));
    expect(playerLeaks).toEqual([]);

    // Webhook bodies: staff data (subject ids are allowed), but no chat text, no note, no reason, no hash, no key, no address.
    // The one endpoint that opted in to excerpts may carry chat lines, in report.created only.
    const plain = w.hooks.received.filter((r) => r.path === '/plain');
    expect(plain.length).toBeGreaterThanOrEqual(4);
    const noText = forbidden.filter((f) => f !== w.alice && f !== w.bob && f !== reportId && f !== groupId);
    expect(plain.flatMap((r) => leaks(r.body, { forbidden: noText, subjectIds: true }))).toEqual([]);
    const excerpts = w.hooks.received.filter((r) => r.path === '/excerpts');
    expect(excerpts).toHaveLength(1);
    expect(excerpts.map((r) => r.json.type)).toEqual(['report.created']);
    expect(excerpts[0]?.body).toContain(CHAT_ALICE);
    const excerptLeaks = leaks(excerpts[0]?.body ?? '', { forbidden: noText.filter((f) => f !== CHAT_ALICE && f !== CHAT_BOB && f !== HANDLE_ALICE && f !== HANDLE_BOB), subjectIds: true });
    expect(excerptLeaks).toEqual([]);
    expect(excerpts[0]?.body).not.toContain(NOTE);

    // Discord text: ids only inside links.
    const texts = w.discord.texts();
    expect(texts.length).toBeGreaterThanOrEqual(4);
    expect(texts.flatMap((t) => leaks(t, { forbidden, links: true }))).toEqual([]);
  });
});

describe('integration: the incoming webhook over real HTTP', () => {
  let w: World;
  beforeAll(async () => {
    w = await boot();
  });
  afterAll(async () => {
    await w.close();
  });

  const signed = (body: unknown, o: { secret?: string; skewSeconds?: number } = {}): { headers: Record<string, string>; raw: string } => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000) + (o.skewSeconds ?? 0);
    return {
      raw,
      headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: sign(o.secret ?? SECRET_IN, ts, raw) },
    };
  };
  const send = (s: { headers: Record<string, string>; raw: string }): Promise<Reply> =>
    call(w, 'POST', '/hooks/webhooks/in/action', { headers: s.headers, body: s.raw });
  const sanction = (key: string, over: Record<string, unknown> = {}) => ({
    action: 'sanction',
    input: { subject: w.alice, kind: 'chat', durationMs: 3_600_000, rule: 1, reason: REASON, idempotencyKey: key, ...over },
  });

  it('applies a signed sanction once; a replay of the same bytes is 401; the same key returns the first result; a different request on it is 409', async () => {
    const first = signed(sanction('ik-1'));
    const done = await send(first);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ groupId: expect.any(String), refCode: expect.stringMatching(/^M-/) });

    // The same signed request again: refused as a replay.
    expect((await send(first)).status).toBe(401);

    // A fresh signature with the same key: the first result, applied once.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await send(signed(sanction('ik-1')));
    expect(again.status).toBe(200);
    expect(again.json).toEqual(done.json);

    // The same key on a different sanction: 409, and nothing applied.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const other = await send(signed(sanction('ik-1', { durationMs: 7_200_000 })));
    expect(other.status).toBe(409);
    expect(other.json.error).toBe('idempotency_mismatch');

    // Only the one sanction exists, and its audit row is the webhook's actor.
    await vi.waitFor(() => expect(w.hooks.received.filter((r) => r.path === '/plain' && r.json.type === 'sanction.applied')).toHaveLength(1));
    const audit = await call(w, 'GET', '/admin/audit?limit=50', { headers: staff(SENIOR_TOKEN) });
    const applied = (audit.json.items as Array<{ actor: string; action: string }>).filter((r) => r.action === 'sanction.apply');
    expect(applied).toEqual([expect.objectContaining({ actor: 'webhook@example.test' })]);
  });

  it('a wrong secret, a stale timestamp, and a changed body are all the same 401', async () => {
    const bodies = [
      signed(sanction('ik-2'), { secret: 'wrong-secret-that-is-at-least-32-characters' }),
      signed(sanction('ik-3'), { skewSeconds: -600 }),
      { ...signed(sanction('ik-4')), raw: JSON.stringify(sanction('ik-5')) },
    ];
    for (const b of bodies) {
      const res = await send(b);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: 'unauthorized', message: 'Authentication is required.' });
    }
    expect(await call(w, 'POST', '/hooks/webhooks/in/action', { body: '{}' })).toMatchObject({ status: 401 });
  });
});

describe('integration: mount order does not hide routes (healthRoutes at the root, first)', () => {
  let w: World;
  beforeAll(async () => {
    w = await boot({ healthFirst: true });
  });
  afterAll(async () => {
    await w.close();
  });

  it('the probes, the incoming webhook, an adopter route and a later express.json() are all reachable', async () => {
    expect((await call(w, 'GET', '/healthz')).json).toEqual({ ok: true });
    expect((await call(w, 'GET', '/readyz')).json).toEqual({ ok: true });
    // The webhook route is behind the root-mounted probes: it must still answer (a signature failure is 401, not 404).
    const hook = await call(w, 'POST', '/hooks/webhooks/in/action', { body: '{}' });
    expect(hook.status).toBe(401);
    expect(hook.json.error).toBe('unauthorized');
    expect((await call(w, 'GET', '/mine')).text).toBe('mine');
    const parsed = await call(w, 'POST', '/json', { body: { a: [1, 2] } });
    expect(parsed.json).toEqual({ got: { a: [1, 2] } });
    // The staff and player mounts, ahead of the probes, are as before.
    expect((await call(w, 'GET', '/admin/reports')).status).toBe(401);
    expect((await call(w, 'GET', '/api/rules')).status).toBe(200);
  });

  it('a signed webhook still applies a sanction through the shadowed mount', async () => {
    const raw = JSON.stringify({ action: 'sanction', input: { subject: w.alice, kind: 'chat', durationMs: 3_600_000, rule: 1, reason: REASON, idempotencyKey: 'order-1' } });
    const ts = Math.floor(Date.now() / 1000);
    const res = await call(w, 'POST', '/hooks/webhooks/in/action', {
      headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: sign(SECRET_IN, ts, raw) },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect(res.json.refCode).toMatch(/^M-/);
  });

  it('an unknown path is the app 404, a handler 404 (unknown report) is the kit 404, and a wrong method is 405', async () => {
    const unknown = await call(w, 'GET', '/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBeUndefined();
    const report = await call(w, 'GET', '/admin/reports/no-such-report', { headers: staff(MOD_TOKEN) });
    expect(report.status).toBe(404);
    expect(report.json).toEqual({ error: 'not_found', message: 'Not found.' });
    expect((await call(w, 'POST', '/healthz')).status).toBe(405);
  });
});

describe('integration: the leak scan is not vacuous (positive controls)', () => {
  const forbidden = [CHAT_BOB, 'secret-note'];

  it('finds a planted subject id, a 32+ character hex hash and a chat line', () => {
    const subject = `s_${'AbCdEfGhIjKlMnOpQrStUv'}`;
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(leaks(`hello ${subject} there`, { forbidden })).toContain('subject-id');
    expect(leaks(`digest ${hash}`, { forbidden })).toContain('hex-hash');
    expect(leaks(`they said ${CHAT_BOB}`, { forbidden })).toContain(`forbidden:${CHAT_BOB}`);
    expect(leaks('a note: secret-note', { forbidden })).toContain('forbidden:secret-note');
  });

  it('a subject id is allowed where the scan says so, and in a Discord link, but nowhere else', () => {
    const subject = 's_AbCdEfGhIjKlMnOpQrStUv';
    expect(leaks(`staff body ${subject}`, { forbidden, subjectIds: true })).toEqual([]);
    expect(leaks(`[Open person](<https://hub.example.test/person/${subject}>)`, { forbidden, links: true })).toEqual([]);
    expect(leaks(`https://hub.example.test/person/${subject}`, { forbidden, links: true })).toEqual([]);
    expect(leaks(`Open person ${subject} [x](<https://h.test/${subject}>)`, { forbidden, links: true })).toContain('subject-id');
    // A hash is never allowed, not even for staff bodies or inside prose that looks like a link label.
    expect(leaks('a1b2c3d4e5f60718293a4b5c6d7e8f90', { forbidden, subjectIds: true })).toContain('hex-hash');
  });

  it('is clean on ordinary text, ref codes, rule numbers and notice ids', () => {
    expect(leaks('Warning, Community Rule 2. Ref: M-AB3CD', { forbidden })).toEqual([]);
    expect(leaks('{"notices":[{"id":"Q3n8vYx2LmP0aKd4","kind":"warning","rule":2}]}', { forbidden })).toEqual([]);
  });

  it('the Discord scan catches an id that sits outside a link', () => {
    const subject = 's_AbCdEfGhIjKlMnOpQrStUv';
    expect(leaks(`**New report** for ${subject}\n[Open person](<https://hub.example.test/person/${subject}>)`, { forbidden, links: true })).toContain('subject-id');
  });
});
