import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { StoredReport } from '@chatwarden/core';
import { CODE_OF_CONDUCT_CSP } from '@chatwarden/http';
import { startServer } from './server.js';
import type { TinyChat } from './server.js';

// Count randomUUID() calls (the server's fallback client key) while still returning real values.
const uuid = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: (...args: Parameters<typeof actual.randomUUID>) => {
      uuid.calls++;
      return actual.randomUUID(...args);
    },
  };
});

type Frame = Record<string, unknown>;

/** A real ws client that keeps every frame it receives, in order, as raw text and parsed. */
class Client {
  readonly raw: string[] = [];
  readonly frames: Frame[] = [];
  private waiting: Array<() => void> = [];
  readonly ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const text = data.toString();
      this.raw.push(text);
      this.frames.push(JSON.parse(text) as Frame);
      for (const w of this.waiting.splice(0)) w();
    });
  }
  static async connect(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return client;
  }
  say(text: string): void {
    this.ws.send(JSON.stringify({ type: 'chat', text }));
  }
  send(frame: Frame): void {
    this.ws.send(JSON.stringify(frame));
  }
  /** Resolves with the first not-yet-consumed frame of this type matching `pred`, or throws after 2 s. */
  async next(type: string, pred: (f: Frame) => boolean = () => true): Promise<Frame> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const i = this.frames.findIndex((f) => f.type === type && pred(f));
      if (i >= 0) return this.frames.splice(i, 1)[0] as Frame;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${type} frame arrived`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

const IDENTIFIER_RE = /s_[A-Za-z0-9_-]{22}|[0-9a-f]{32}/;

// The tests must not depend on the developer's shell: an exported DISCORD_WEBHOOK_URL (the README's own instruction) would
// start the real feed in every test and post to a real channel. Clear both once, restore them after the file.
const ambient = { url: process.env.DISCORD_WEBHOOK_URL, role: process.env.DISCORD_MENTION_ROLE_ID };
beforeAll(() => {
  delete process.env.DISCORD_WEBHOOK_URL;
  delete process.env.DISCORD_MENTION_ROLE_ID;
});
afterAll(() => {
  if (ambient.url === undefined) delete process.env.DISCORD_WEBHOOK_URL;
  else process.env.DISCORD_WEBHOOK_URL = ambient.url;
  if (ambient.role === undefined) delete process.env.DISCORD_MENTION_ROLE_ID;
  else process.env.DISCORD_MENTION_ROLE_ID = ambient.role;
});

/** Every call the default Discord fetch received: a test that did not ask for the feed must leave this empty. */
const strayDiscordCalls: string[] = [];
/** The default `discordFetch` of `boot()`: records the call and throws, so a feed that starts by accident fails loudly. */
const unexpectedDiscordFetch = ((url: string | URL) => {
  strayDiscordCalls.push(String(url));
  throw new Error('a test that did not configure Discord reached the Discord fetch');
}) as typeof fetch;

const servers: TinyChat[] = [];
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  for (const s of servers) await s.close();
  expect(strayDiscordCalls).toEqual([]);
});

async function boot(opts: Parameters<typeof startServer>[0] = {}): Promise<TinyChat> {
  const server = await startServer({ port: 0, secret: 'test-secret-not-for-production', discordFetch: unexpectedDiscordFetch, ...opts });
  servers.push(server);
  return server;
}
async function join(server: TinyChat, key: string): Promise<Client> {
  const client = await Client.connect(`ws://127.0.0.1:${server.port}/?key=${key}`);
  clients.push(client);
  await client.next('welcome');
  return client;
}
const post = (server: TinyChat, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('tiny-chat: one room, two players', () => {
  const reports: StoredReport[] = [];
  let server: TinyChat;
  let a: Client;
  let b: Client;
  let seatA: string;

  beforeAll(async () => {
    server = await boot({ onReport: (r) => void reports.push(r) });
    a = await join(server, 'key-a');
    b = await join(server, 'key-b');
    seatA = 'p1';
  });

  it('A says hello and B receives it with a lineId', async () => {
    a.say('hello');
    const got = await b.next('chat');
    expect(got).toMatchObject({ type: 'chat', seatId: seatA, text: 'hello' });
    expect(typeof got.lineId).toBe('string');
    expect(got.lineId).not.toBe('');
    // The sender sees their own line too.
    expect(await a.next('chat')).toMatchObject({ text: 'hello', lineId: got.lineId });
  });

  it('A sends a blocked term: A is refused as blocked and B receives nothing', async () => {
    a.say('zorbak');
    expect(await a.next('refused')).toEqual({ type: 'refused', reason: 'blocked', rule: 1 });
    // Anything B receives next on its one socket is the later line, so the blocked one never came.
    a.say('after');
    expect(await b.next('chat')).toMatchObject({ text: 'after' });
    expect(b.frames.filter((f) => f.type === 'chat')).toEqual([]);
  });

  it('B reports A: 200, the report is stored and its excerpt holds the blocked line, blocked=true', async () => {
    const res = await post(server, { key: 'key-b', targetSeat: seatA, category: 'harassment', note: 'rude' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, remaining: 9 });
    expect(reports).toHaveLength(1);
    const blocked = reports[0]?.excerpt.find((l) => l.blocked);
    expect(blocked).toMatchObject({ seatId: seatA, raw: 'zorbak', blocked: true, delivered: null });
    expect(reports[0]?.excerpt.some((l) => !l.blocked && l.delivered === 'hello')).toBe(true);
  });

  it('a chat sanction on A makes A next line refused as restricted, with an end time and no identifier', async () => {
    const subject = server.chatwarden.rooms.subjectAt('lobby', seatA);
    if (subject === null) throw new Error('expected a subject');
    await server.chatwarden.sanctions.apply({
      kind: 'chat',
      subject,
      includeIp: false,
      durationMs: 60_000,
      reason: 'test',
      actor: 'mod@example.test',
      source: 'moderator',
      automated: false,
      rule: 1,
    });
    a.say('still here');
    const refused = await a.next('refused');
    expect(refused).toMatchObject({ type: 'refused', reason: 'restricted' });
    expect(typeof refused.until).toBe('number');
  });

  it('no frame either client received contains a subject id, key or hash', () => {
    expect(a.raw.length).toBeGreaterThan(0);
    expect(b.raw.length).toBeGreaterThan(0);
    for (const text of [...a.raw, ...b.raw]) expect(text).not.toMatch(IDENTIFIER_RE);
    for (const text of [...a.raw, ...b.raw]) {
      expect(text).not.toContain('key-a');
      expect(text).not.toContain('key-b');
    }
  });
});

describe('tiny-chat: edges', () => {
  it('a banned person is refused at the door and the socket closes', async () => {
    const server = await boot();
    const first = await join(server, 'key-ban');
    const subject = server.chatwarden.rooms.subjectAt('lobby', 'p1');
    if (subject === null) throw new Error('expected a subject');
    await server.chatwarden.sanctions.apply({
      kind: 'ban',
      subject,
      includeIp: false,
      durationMs: null,
      reason: 'test',
      actor: 'mod@example.test',
      source: 'moderator',
      automated: false,
      rule: 1,
    });
    await first.close();
    const again = await Client.connect(`ws://127.0.0.1:${server.port}/?key=key-ban`);
    clients.push(again);
    const refused = await again.next('refused');
    expect(refused).toEqual({ type: 'refused', reason: 'banned', until: null });
    await new Promise<void>((resolve) => again.ws.once('close', () => resolve()));
    expect(again.raw.join('')).not.toMatch(IDENTIFIER_RE);
  });

  it('a muted player is hidden from the muter only, and the muter still sees themself', async () => {
    const server = await boot();
    const a = await join(server, 'key-ma');
    const b = await join(server, 'key-mb');
    b.send({ type: 'mute', seatId: 'p1', on: true });
    // Ordering on one socket: the mute is handled before this line is, and A's line reaches A either way.
    await new Promise((resolve) => setTimeout(resolve, 50));
    a.say('hidden from b');
    expect(await a.next('chat')).toMatchObject({ text: 'hidden from b' });
    b.send({ type: 'mute', seatId: 'p1', on: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    a.say('visible to b');
    expect(await b.next('chat')).toMatchObject({ text: 'visible to b' });
    expect(b.frames.filter((f) => f.type === 'chat')).toEqual([]);
  });

  it('refuses an over-long line and stays silent on an empty one', async () => {
    const server = await boot();
    const a = await join(server, 'key-len');
    a.say('x'.repeat(201));
    expect(await a.next('refused')).toEqual({ type: 'refused', reason: 'length' });
    a.say('   ');
    a.say('ok');
    expect(await a.next('chat')).toMatchObject({ text: 'ok' });
    expect(a.frames.filter((f) => f.type === 'refused')).toEqual([]);
  });

  it('ignores malformed frames without dropping the connection', async () => {
    const server = await boot();
    const a = await join(server, 'key-bad');
    a.ws.send('not json');
    a.send({ type: 'chat', text: 42 });
    a.send({ type: 'nope' });
    a.say('alive');
    expect(await a.next('chat')).toMatchObject({ text: 'alive' });
  });

  it('POST /report answers 422 with the refusal for a self-report and 400 for a bad body', async () => {
    const server = await boot();
    await join(server, 'key-self');
    const self = await post(server, { key: 'key-self', targetSeat: 'p1', category: 'spam' });
    expect(self.status).toBe(422);
    expect(await self.json()).toEqual({ ok: false, refused: 'self' });
    const unknown = await post(server, { key: 'nobody', targetSeat: 'p1', category: 'spam' });
    expect(unknown.status).toBe(422);
    const bad = await post(server, { targetSeat: 'p1' });
    expect(bad.status).toBe(400);
  });

  const postRaw = (server: TinyChat, body: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${server.port}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  it('a malformed JSON body to /report is a JSON 400 bad_request, never an HTML stack page', async () => {
    const server = await boot();
    const res = await postRaw(server, '{"key": "k", "targetSeat": ');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const text = await res.text();
    expect(text).not.toMatch(/<html|<pre|SyntaxError|at .*\(/i);
    expect(JSON.parse(text)).toEqual({ ok: false, refused: 'bad_request' });
  });

  it('an oversized body to /report is a JSON 4xx bad_request too', async () => {
    const server = await boot();
    const res = await postRaw(server, JSON.stringify({ key: 'k', note: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, refused: 'bad_request' });
  });

  it('the server still works after a bad body (control)', async () => {
    const server = await boot();
    await join(server, 'key-ctl');
    await postRaw(server, '{nope');
    const res = await post(server, { key: 'key-ctl', targetSeat: 'p1', category: 'spam' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, refused: 'self' });
  });

  it('identifies a connection once: a keyless player draws one fallback key, not two', async () => {
    const server = await boot();
    const before = uuid.calls;
    const keyless = await Client.connect(`ws://127.0.0.1:${server.port}/`);
    clients.push(keyless);
    await keyless.next('welcome');
    expect(uuid.calls - before).toBe(1);
    // The seated person is the one the door saw: they can chat as themself.
    keyless.say('hi');
    expect(await keyless.next('chat')).toMatchObject({ text: 'hi' });
  });
});

describe('tiny-chat: the leak-scan regex is not vacuous (positive controls)', () => {
  it('matches a real subject id from subjectAt()', async () => {
    const server = await boot();
    await join(server, 'key-ctl-re');
    const subject = server.chatwarden.rooms.subjectAt('lobby', 'p1');
    expect(subject).not.toBeNull();
    expect(IDENTIFIER_RE.test(`{"x":"${subject}"}`)).toBe(true);
  });

  it('matches a 32-hex hash, and not ordinary chat text', () => {
    expect(IDENTIFIER_RE.test('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(IDENTIFIER_RE.test('{"type":"chat","seatId":"p1","text":"hello there","lineId":"7"}')).toBe(false);
  });
});

describe('tiny-chat: the secret', () => {
  const saved = { secret: process.env.CHATWARDEN_SECRET, nodeEnv: process.env.NODE_ENV };
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved.secret === undefined) delete process.env.CHATWARDEN_SECRET;
    else process.env.CHATWARDEN_SECRET = saved.secret;
    process.env.NODE_ENV = saved.nodeEnv;
  });

  it('an explicit secret starts quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.CHATWARDEN_SECRET;
    await boot();
    expect(warn).not.toHaveBeenCalled();
  });

  it('CHATWARDEN_SECRET from the environment starts quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CHATWARDEN_SECRET = 'from-the-environment';
    const server = await startServer({ port: 0 });
    servers.push(server);
    expect(warn).not.toHaveBeenCalled();
  });

  it('with no secret outside production it generates one and warns once, in one line, without printing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.CHATWARDEN_SECRET;
    process.env.NODE_ENV = 'development';
    const server = await startServer({ port: 0 });
    servers.push(server);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toMatch(/CHATWARDEN_SECRET/);
    expect(line).toMatch(/restart/);
    expect(line).toMatch(/production/);
    expect(line).not.toContain('\n');
    expect(line).not.toMatch(/[0-9a-f]{32}/);
  });

  it('in production with no secret it throws at startup', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.CHATWARDEN_SECRET;
    process.env.NODE_ENV = 'production';
    await expect(startServer({ port: 0 })).rejects.toThrow(/CHATWARDEN_SECRET/);
  });

  it('in production an explicit or environment secret is fine', async () => {
    process.env.NODE_ENV = 'production';
    const server = await startServer({ port: 0, secret: 'configured' });
    servers.push(server);
    process.env.CHATWARDEN_SECRET = 'configured-too';
    const again = await startServer({ port: 0 });
    servers.push(again);
  });

  it('an empty CHATWARDEN_SECRET counts as unset', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CHATWARDEN_SECRET = '';
    process.env.NODE_ENV = 'production';
    await expect(startServer({ port: 0 })).rejects.toThrow(/CHATWARDEN_SECRET/);
  });
});

// --- K2: warnings and notices ---------------------------------------------------------------------------------

const ADMIN = 'demo-admin-token';

interface Reply {
  status: number;
  text: string;
  json: Record<string, unknown>;
}

/** Every body an HTTP call returned, for the leak scan. */
const bodies: string[] = [];
/** Where each of those bodies came from (path without query), and every staff (`/admin`) response with its path. */
const bodyPaths: string[] = [];
const staffLog: Array<{ path: string; text: string }> = [];

async function http(server: TinyChat, path: string, init?: RequestInit): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, init);
  const text = await res.text();
  bodies.push(text);
  bodyPaths.push(path.split('?')[0] as string);
  if (path.startsWith('/admin')) staffLog.push({ path: path.split('?')[0] as string, text });
  return { status: res.status, text, json: parseOrEmpty(text) };
}
const parseOrEmpty = (text: string): Record<string, unknown> => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {}; // a markdown or HTML document
  }
};
const tokenHeader = (token: string | null): Record<string, string> => (token === null ? {} : { 'x-admin-token': token });

/**
 * A staff GET. It is kept out of `bodies` (the player scan: staff responses carry subject ids by design, the report detail
 * names the people) and in `staffLog`, which the staff scan at the end of the file checks for key hashes, raw keys, the
 * admin token and addresses.
 */
async function staffGet(server: TinyChat, path: string, token: string | null = ADMIN): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${server.port}/admin${path}`, { headers: tokenHeader(token) });
  const text = await res.text();
  staffLog.push({ path: `/admin${path.split('?')[0]}`, text });
  return { status: res.status, text, json: parseOrEmpty(text) };
}

/** The subject ids a report names, from `GET /admin/reports/:id` (the only place the demo shows them). */
async function subjectsOf(server: TinyChat, reportId: string): Promise<{ target: string; reporter: string } | null> {
  const res = await staffGet(server, `/reports/${reportId}`);
  if (res.status !== 200) return null;
  const report = res.json.report as { targetSubject: string; reporterSubject: string };
  return { target: report.targetSubject, reporter: report.reporterSubject };
}

/**
 * Decide through the kit: `POST /admin/reports/:id/decide`. The tests name people by seat, as they always did (p1 is the
 * reported player, anyone else the reporter); this helper turns each `seat` into the subject id the staff API wants,
 * read from `GET /admin/reports/:id`. An action that already names a `subject` is sent as given.
 */
async function decideHttp(server: TinyChat, body: unknown, token: string | null = ADMIN): Promise<Reply> {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const { reportId, ...rest } = input;
  const id = typeof reportId === 'string' ? reportId : 'missing';
  const who = await subjectsOf(server, id);
  if (who !== null && Array.isArray(rest.actions)) {
    rest.actions = (rest.actions as unknown[]).map((a) => {
      if (typeof a !== 'object' || a === null || !('seat' in a)) return a;
      const { seat, ...action } = a as Record<string, unknown>;
      return { ...action, subject: seat === 'p1' ? who.target : who.reporter };
    });
  }
  return http(server, `/admin/reports/${id}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...tokenHeader(token) },
    body: JSON.stringify(rest),
  });
}
const reportHttp = (server: TinyChat, body: unknown): Promise<Reply> =>
  http(server, '/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const noticesOf = (f: Frame): Array<Record<string, unknown>> => f.items as Array<Record<string, unknown>>;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe('tiny-chat: report -> decision -> notice -> ack -> record', () => {
  const reports: StoredReport[] = [];
  const everyone: Client[] = [];
  let server: TinyChat;
  let a: Client;
  let b: Client;
  let warningId = '';
  let ownLineIds: string[] = [];
  let bobLineId = '';
  const decision = () => ({
    reportId: reports[0]?.id,
    verdict: 'upheld',
    reason: 'private moderator reason',
    actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 2, lineIds: ownLineIds }],
  });

  beforeAll(async () => {
    server = await boot({ onReport: (r) => void reports.push(r), adminToken: ADMIN });
    a = await join(server, 'key-na');
    b = await join(server, 'key-nb');
    everyone.push(a, b);
  });

  it('B reports A, naming A lines and B own line in the evidence', async () => {
    a.say('hello there');
    await a.next('chat');
    a.say('you zorbak');
    await a.next('refused');
    b.say('bob line');
    await b.next('chat');
    const res = await reportHttp(server, { key: 'key-nb', targetSeat: 'p1', category: 'harassment' });
    expect(res.status).toBe(200);
    expect(reports).toHaveLength(1);
    const excerpt = reports[0]?.excerpt ?? [];
    ownLineIds = excerpt.filter((l) => l.seatId === 'p1').map((l) => l.lineId);
    bobLineId = excerpt.find((l) => l.seatId === 'p2')?.lineId ?? '';
    expect(ownLineIds).toHaveLength(2);
    expect(bobLineId).not.toBe('');
  });

  it('POST /admin/reports/:id/decide needs the admin token: none, wrong and a different-length one are all 401, and nothing is decided', async () => {
    for (const token of [null, 'wrong', `${ADMIN}x`, '']) {
      const res = await decideHttp(server, decision(), token);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: 'unauthorized', message: 'Authentication is required.' });
    }
    await settle();
    expect(a.frames.filter((f) => f.type === 'notices')).toEqual([]);
    expect(server.chatwarden.notices.pending({ clientKey: 'key-na' })).toEqual([]);
  });

  it('a warning with the reported lines: the target gets the notice with their OWN lines, masked; the reporter an outcome', async () => {
    const res = await decideHttp(server, decision());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, replay: false });
    expect(res.json.groups).toHaveLength(1);
    expect((res.json.groups as Array<{ refCode: string }>)[0]?.refCode).toMatch(/^M-/);

    const mine = await a.next('notices');
    const [n] = noticesOf(mine);
    expect(noticesOf(mine)).toHaveLength(1);
    expect(n).toMatchObject({ kind: 'warning', rule: 2, mustAcknowledge: true, until: null });
    expect(String(n?.refCode)).toMatch(/^M-/);
    expect((n?.excerpt as Array<{ text: string }>).map((l) => l.text)).toEqual(['hello there', 'you ******']);
    expect(JSON.stringify(mine)).not.toContain('bob line');
    warningId = String(n?.id);

    const theirs = await b.next('notices');
    expect(noticesOf(theirs)).toHaveLength(1);
    expect(noticesOf(theirs)[0]).toMatchObject({ kind: 'report_outcome', excerpt: [], rule: null, refCode: null });
  });

  it('the same decision again (a double click) is a replay and sends nothing more', async () => {
    const res = await decideHttp(server, decision());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, replay: true });
    a.say('still here');
    await a.next('chat');
    b.say('and me');
    await b.next('chat');
    expect(a.frames.filter((f) => f.type === 'notices')).toEqual([]);
    expect(b.frames.filter((f) => f.type === 'notices')).toEqual([]);
  });

  it('a notice not yet acknowledged is pushed again when the player reconnects', async () => {
    await a.close();
    await settle();
    a = await join(server, 'key-na');
    everyone.push(a);
    const again = await a.next('notices');
    expect(noticesOf(again).map((n) => n.id)).toEqual([warningId]);
  });

  it("someone else cannot ack the notice, and an ack of an unknown id fails", async () => {
    b.send({ type: 'ack', id: warningId });
    expect(await b.next('acked')).toEqual({ type: 'acked', id: warningId, ok: false });
    a.send({ type: 'ack', id: 'no-such-notice' });
    expect(await a.next('acked')).toEqual({ type: 'acked', id: 'no-such-notice', ok: false });
    expect(server.chatwarden.notices.pending({ clientKey: 'key-na' })).toHaveLength(1);
  });

  it('a malformed ack is ignored', async () => {
    a.send({ type: 'ack', id: 5 });
    a.send({ type: 'ack' });
    a.say('alive');
    await a.next('chat');
    expect(a.frames.filter((f) => f.type === 'acked')).toEqual([]);
  });

  it('the player acks it: pending is empty, a reconnect pushes nothing, and My record lists it', async () => {
    a.send({ type: 'ack', id: warningId });
    expect(await a.next('acked')).toEqual({ type: 'acked', id: warningId, ok: true });
    expect(server.chatwarden.notices.pending({ clientKey: 'key-na' })).toEqual([]);
    expect(server.chatwarden.notices.pendingWarning({ clientKey: 'key-na' })).toBe(false);

    await a.close();
    await settle();
    a = await join(server, 'key-na');
    everyone.push(a);
    a.say('after the ack');
    await a.next('chat');
    expect(a.frames.filter((f) => f.type === 'notices')).toEqual([]);

    const rec = await http(server, '/api/record', { headers: { 'x-chatwarden-key': 'key-na' } });
    expect(rec.status).toBe(200);
    const items = rec.json.record as Array<Record<string, unknown>>;
    expect(items.map((n) => n.id)).toEqual([warningId]);
    expect(items[0]).toMatchObject({ kind: 'warning', rule: 2 });
  });

  it('the reporter record never lists a report outcome; an unknown key, a missing key and an empty key are an empty record', async () => {
    expect((await http(server, '/api/record?key=key-nb')).json).toEqual({ record: [] });
    expect((await http(server, '/api/record?key=nobody')).json).toEqual({ record: [] });
    const none = await http(server, '/api/record');
    expect([none.status, none.json]).toEqual([200, { record: [] }]);
    expect((await http(server, '/api/record?key=')).json).toEqual({ record: [] });
    expect((await http(server, '/api/record', { headers: { 'x-chatwarden-key': '' } })).json).toEqual({ record: [] });
  });

  it('the notices, the record and every response leak no identifier, key, reason or moderator', () => {
    const frames = everyone.flatMap((c) => c.raw);
    // The scan is not vacuous: it covers notice frames, acks and a record body.
    expect(frames.some((t) => t.includes('"type":"notices"'))).toBe(true);
    expect(frames.some((t) => t.includes('"type":"acked"'))).toBe(true);
    expect(bodies.some((t) => t.includes('"record"'))).toBe(true);
    expect(bodies.some((t) => t.includes('"refCode"'))).toBe(true);
    for (const text of [...frames, ...bodies]) {
      expect(text).not.toMatch(IDENTIFIER_RE);
      for (const secret of ['key-na', 'key-nb', ADMIN, 'private moderator reason', 'demo-admin']) {
        expect(text).not.toContain(secret);
      }
    }
    // Ordinary chat frames carry players' lines by design; a notice or a response must carry nobody else's, and
    // never the blocked word itself.
    const notExcerptOfChat = [...frames.filter((t) => !t.includes('"type":"chat"')), ...bodies];
    for (const text of notExcerptOfChat) {
      expect(text).not.toContain('bob line');
      expect(text).not.toContain('zorbak');
    }
  });

  it('the scan would catch a leak (positive control on a notice-shaped payload)', () => {
    const subject = server.chatwarden.rooms.subjectAt('lobby', 'p4');
    expect(subject).not.toBeNull();
    expect(IDENTIFIER_RE.test(JSON.stringify({ type: 'notices', items: [], subject }))).toBe(true);
    expect(JSON.stringify({ type: 'notices', items: [{ id: warningId }] })).not.toMatch(IDENTIFIER_RE);
  });

  it('refuses another player line in a notice (B line in A notice) and writes nothing', async () => {
    const other = await boot({ onReport: (r) => void reports.push(r), adminToken: ADMIN });
    const x = await join(other, 'key-x');
    const y = await join(other, 'key-y');
    const before = reports.length;
    x.say('x line');
    await x.next('chat');
    y.say('y line');
    await y.next('chat');
    await reportHttp(other, { key: 'key-y', targetSeat: 'p1', category: 'spam' });
    const report = reports[before];
    const yLine = report?.excerpt.find((l) => l.seatId === 'p2')?.lineId;
    const res = await decideHttp(other, {
      reportId: report?.id,
      verdict: 'upheld',
      reason: 'r',
      actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 2, lineIds: [yLine] }],
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'invalid_request', message: 'The request is not valid.' });
    await settle();
    expect(x.frames.filter((f) => f.type === 'notices')).toEqual([]);
    expect(other.chatwarden.notices.pending({ clientKey: 'key-x' })).toEqual([]);
  });
});

describe('tiny-chat: the demo admin route and notices, edges', () => {
  const saved = process.env.TINY_CHAT_ADMIN_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.TINY_CHAT_ADMIN_TOKEN;
    else process.env.TINY_CHAT_ADMIN_TOKEN = saved;
  });

  it('the admin API is off (404) when no admin token is configured, even with a header', async () => {
    delete process.env.TINY_CHAT_ADMIN_TOKEN;
    const server = await boot();
    const res = await decideHttp(server, { reportId: 'r', verdict: 'upheld', reason: 'r', actions: [] }, 'anything');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ ok: false, refused: 'off' });
    // Every admin path is off, not just decide.
    expect((await staffGet(server, '/reports', 'anything')).json).toEqual({ ok: false, refused: 'off' });
    expect((await staffGet(server, '/audit', null)).status).toBe(404);
  });

  it('the admin token can come from TINY_CHAT_ADMIN_TOKEN', async () => {
    process.env.TINY_CHAT_ADMIN_TOKEN = 'from-env-token';
    const server = await boot();
    const wrong = await decideHttp(server, { reportId: 'r', verdict: 'upheld', reason: 'r', actions: [] }, ADMIN);
    expect(wrong.status).toBe(401);
    const right = await decideHttp(server, { reportId: 'r', verdict: 'upheld', reason: 'r', actions: [] }, 'from-env-token');
    expect(right.status).toBe(404);
    expect(right.json).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it('answers 400 for a malformed body, an unknown or unnamed subject and an invalid decision, and 404 for an unknown report', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ adminToken: ADMIN, onReport: (r) => void reports.push(r) });
    const a = await join(server, 'key-e1');
    await join(server, 'key-e2');
    await join(server, 'key-e3');
    a.say('hello');
    await a.next('chat');
    await reportHttp(server, { key: 'key-e2', targetSeat: 'p1', category: 'spam' });
    const reportId = reports[0]?.id;
    const good = { reportId, verdict: 'upheld', reason: 'r', actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 2 }] };

    expect((await decideHttp(server, { verdict: 'upheld' })).status).toBe(400);
    expect((await decideHttp(server, { ...good, verdict: 'maybe' })).status).toBe(400);
    expect((await decideHttp(server, { ...good, actions: 'x' })).status).toBe(400);
    const invalid = { error: 'invalid_request', message: 'The request is not valid.' };
    // Staff name subject ids; one the report does not name (an unknown id, or a third player) is refused.
    const unknownSubject = await decideHttp(server, { ...good, actions: [{ subject: 's_no-such-subject', kind: 'warning', durationMs: null, rule: 2 }] });
    expect([unknownSubject.status, unknownSubject.json]).toEqual([400, invalid]);
    const thirdParty = server.chatwarden.rooms.subjectAt('lobby', 'p3') ?? '';
    const bystander = await decideHttp(server, { ...good, actions: [{ subject: thirdParty, kind: 'warning', durationMs: null, rule: 2 }] });
    expect([bystander.status, bystander.json]).toEqual([400, invalid]);
    const noSubject = await decideHttp(server, { ...good, actions: [{ kind: 'warning', durationMs: null, rule: 2 }] });
    expect([noSubject.status, noSubject.json]).toEqual([400, invalid]);
    const badRule = await decideHttp(server, { ...good, actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 99 }] });
    expect([badRule.status, badRule.json]).toEqual([400, invalid]);
    const unknown = await decideHttp(server, { ...good, reportId: 'nope', actions: [] });
    expect([unknown.status, unknown.json]).toEqual([404, { error: 'not_found', message: 'Not found.' }]);
    // Nothing above decided anything; the real one still can.
    expect((await decideHttp(server, good)).status).toBe(200);
  });

  it('the subject ids come from GET /admin/reports/:id; the target gets the warning and the reporter only an outcome', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ adminToken: ADMIN, onReport: (r) => void reports.push(r) });
    const a = await join(server, 'key-s1');
    const b = await join(server, 'key-s2');
    a.say('hello');
    await a.next('chat');
    await reportHttp(server, { key: 'key-s2', targetSeat: 'p1', category: 'spam' });
    const reportId = reports[0]?.id ?? '';
    const detail = await staffGet(server, `/reports/${reportId}`);
    expect(detail.status).toBe(200);
    const { targetSubject, reporterSubject } = detail.json.report as { targetSubject: string; reporterSubject: string };
    // The staff API shows ids (that is its job); the demo's seats resolve to the same people.
    expect(targetSubject).toMatch(IDENTIFIER_RE);
    expect(targetSubject).toBe(server.chatwarden.rooms.subjectAt('lobby', 'p1'));
    expect(reporterSubject).toBe(server.chatwarden.rooms.subjectAt('lobby', 'p2'));
    const res = await decideHttp(server, {
      reportId,
      verdict: 'upheld',
      reason: 'r',
      actions: [{ subject: targetSubject, kind: 'warning', durationMs: null, rule: 2 }],
    });
    expect(res.status).toBe(200);
    expect(noticesOf(await a.next('notices'))[0]).toMatchObject({ kind: 'warning' });
    expect(noticesOf(await b.next('notices')).map((n) => n.kind)).toEqual(['report_outcome']);
    // The decision's own answer shows ref codes and kinds, never an id.
    expect(res.text).not.toMatch(IDENTIFIER_RE);
  });

  it('staff routes need the token: the report detail, the queue and the audit trail are all 401 without it (and show no id)', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ adminToken: ADMIN, onReport: (r) => void reports.push(r) });
    await join(server, 'key-au1');
    await join(server, 'key-au2');
    await reportHttp(server, { key: 'key-au2', targetSeat: 'p1', category: 'spam' });
    const id = reports[0]?.id ?? '';
    for (const path of [`/reports/${id}`, '/reports', '/audit']) {
      for (const token of [null, 'wrong', '']) {
        const res = await staffGet(server, path, token);
        expect([res.status, res.json.error]).toEqual([401, 'unauthorized']);
        expect(res.text).not.toMatch(IDENTIFIER_RE);
      }
      expect((await staffGet(server, path)).status).toBe(200);
    }
    // Reading a report is audited, under the fixed demo actor.
    const audit = await staffGet(server, '/audit');
    expect(JSON.stringify(audit.json)).toContain('demo-admin');
  });

  it('an admin body over 64 KiB is 413 in the kit shape, and the server carries on', async () => {
    const server = await boot({ adminToken: ADMIN });
    const big = await http(server, '/admin/reports/x/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN },
      body: JSON.stringify({ reason: 'x'.repeat(70_000) }),
    });
    expect([big.status, big.json.error]).toEqual([413, 'payload_too_large']);
    expect((await staffGet(server, '/reports')).status).toBe(200);
  });

  it('no express body parser sits in front of the kit: a malformed admin body is the kit 400, not an Express error', async () => {
    const server = await boot({ adminToken: ADMIN });
    const res = await http(server, '/admin/reports/x/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN },
      body: '{"verdict": ',
    });
    expect([res.status, res.json.error]).toEqual([400, 'invalid_json']);
  });

  it('a decision for a player who is offline waits and is pushed on their next connect', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ onReport: (r) => void reports.push(r) });
    const c = await join(server, 'key-off');
    const d = await join(server, 'key-on');
    c.say('a clean line');
    await c.next('chat');
    await reportHttp(server, { key: 'key-on', targetSeat: 'p1', category: 'spam' });
    const subject = server.chatwarden.rooms.subjectAt('lobby', 'p1');
    if (subject === null) throw new Error('expected a subject');
    await c.close();
    await settle();
    const res = await server.chatwarden.decide({
      reportId: reports[0]?.id ?? '',
      verdict: 'upheld',
      actor: 'mod',
      reason: 'r',
      actions: [{ subject, kind: 'chat', durationMs: 60_000, rule: 4 }],
    });
    expect(res.ok).toBe(true);
    // The reporter is connected and hears at once; the target is away.
    expect(noticesOf(await d.next('notices')).map((n) => n.kind)).toEqual(['report_outcome']);
    const back = await join(server, 'key-off');
    const [n] = noticesOf(await back.next('notices'));
    expect(n).toMatchObject({ kind: 'chat', rule: 4 });
    expect(typeof n?.until).toBe('number');
    // Their next line is refused as restricted, and the refusal still carries no identifier.
    back.say('hi');
    expect(await back.next('refused')).toMatchObject({ type: 'refused', reason: 'restricted' });
    expect(JSON.stringify([...back.raw, ...d.raw])).not.toMatch(IDENTIFIER_RE);
  });

  it('revoking the sanction withdraws the notice: it leaves My record', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ onReport: (r) => void reports.push(r) });
    const a = await join(server, 'key-r1');
    await join(server, 'key-r2');
    a.say('hello');
    await a.next('chat');
    await reportHttp(server, { key: 'key-r2', targetSeat: 'p1', category: 'spam' });
    const subject = server.chatwarden.rooms.subjectAt('lobby', 'p1') ?? '';
    const res = await server.chatwarden.decide({
      reportId: reports[0]?.id ?? '',
      verdict: 'upheld',
      actor: 'mod',
      reason: 'r',
      actions: [{ subject, kind: 'warning', durationMs: null, rule: 2 }],
    });
    if (!res.ok) throw new Error('expected ok');
    await a.next('notices');
    expect(((await http(server, '/api/record?key=key-r1')).json.record as unknown[]).length).toBe(1);
    expect(await server.chatwarden.sanctions.revoke(res.groups[0]?.groupId ?? '', 'mod', 'mistake')).toBe(true);
    expect((await http(server, '/api/record?key=key-r1')).json).toEqual({ record: [] });
    expect(server.chatwarden.notices.pendingWarning({ clientKey: 'key-r1' })).toBe(false);
  });
});

describe('tiny-chat: the decide route takes the K3a verdicts', () => {
  const MARK = 'EVIDENCE-MARKER-7c1d';
  /** A fresh server with one filed report: p2 reported p1. */
  async function filed(tag: string) {
    const reports: StoredReport[] = [];
    const server = await boot({ adminToken: ADMIN, onReport: (r) => void reports.push(r) });
    const a = await join(server, `key-${tag}1`);
    await join(server, `key-${tag}2`);
    a.say('hello');
    await a.next('chat');
    await reportHttp(server, { key: `key-${tag}2`, targetSeat: 'p1', category: 'spam' });
    return { server, a, reportId: reports[0]?.id };
  }

  it('upheld with a warning is 200 and sends the target a notice', async () => {
    const { server, a, reportId } = await filed('v1');
    const res = await decideHttp(server, { reportId, verdict: 'upheld', reason: 'r', actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 2 }] });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, replay: false });
    expect(noticesOf(await a.next('notices'))).toHaveLength(1);
  });

  it('no_action is 200 with no ref codes and tells nobody', async () => {
    const { server, a, reportId } = await filed('v2');
    const res = await decideHttp(server, { reportId, verdict: 'no_action', reason: 'banter', actions: [] });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, replay: false, groups: [] });
    await settle();
    expect(a.frames.filter((f) => f.type === 'notices')).toEqual([]);
  });

  it('bad_faith with evidence is 200, and the evidence appears in no response or frame', async () => {
    const { server, a, reportId } = await filed('v3');
    const res = await decideHttp(server, { reportId, verdict: 'bad_faith', evidence: MARK, reason: 'r', actions: [] });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true });
    await settle();
    expect(JSON.stringify(a.frames)).not.toContain(MARK);
    expect(bodies.some((b) => b.includes(MARK))).toBe(false);
    expect(res.text).not.toContain(MARK);
  });

  it('bad_faith without usable evidence is 400 invalid and decides nothing; the real one still can', async () => {
    const { server, reportId } = await filed('v4');
    for (const evidence of [undefined, '', '   ', 'x'.repeat(501)]) {
      const res = await decideHttp(server, { reportId, verdict: 'bad_faith', evidence, reason: 'r', actions: [] });
      expect([res.status, res.json.error]).toEqual([400, 'invalid_request']);
    }
    expect((await decideHttp(server, { reportId, verdict: 'bad_faith', evidence: 'ok', reason: 'r', actions: [] })).status).toBe(200);
  });

  it('evidence on another verdict is 400 invalid', async () => {
    const { server, reportId } = await filed('v5');
    for (const verdict of ['upheld', 'no_action']) {
      const res = await decideHttp(server, { reportId, verdict, evidence: 'why', reason: 'r', actions: [] });
      expect([res.status, res.json.error]).toEqual([400, 'invalid_request']);
    }
  });

  it('a non-string evidence is 400 invalid_request', async () => {
    const { server, reportId } = await filed('v6');
    for (const evidence of [7, null, {}, ['x']]) {
      const res = await decideHttp(server, { reportId, verdict: 'bad_faith', evidence, reason: 'r', actions: [] });
      expect([res.status, res.json.error]).toEqual([400, 'invalid_request']);
    }
  });

  it.each(['fair', 'unfair'])('the old verdict %s is 400 invalid_request', async (verdict) => {
    const { server, reportId } = await filed(`v7${verdict}`);
    const res = await decideHttp(server, { reportId, verdict, reason: 'r', actions: [] });
    expect([res.status, res.json.error]).toEqual([400, 'invalid_request']);
  });

  it('noted with a note action is 200, tells nobody, and closes the report', async () => {
    const { server, a, reportId } = await filed('v8');
    const res = await decideHttp(server, { reportId, verdict: 'noted', reason: 'r', actions: [{ seat: 'p1', kind: 'note', durationMs: null, rule: 2 }] });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, replay: false });
    await settle();
    expect(a.frames.filter((f) => f.type === 'notices')).toEqual([]);
    expect(server.chatwarden.notices.pending({ clientKey: 'key-v81' })).toEqual([]);
    expect(server.chatwarden.notices.pendingWarning({ clientKey: 'key-v81' })).toBe(false);
    // The report is closed: a different decision is a 409, the same one replays (200).
    const other = await decideHttp(server, { reportId, verdict: 'no_action', reason: 'r', actions: [] });
    expect([other.status, other.json.error]).toEqual([409, 'already_decided']);
    const again = await decideHttp(server, { reportId, verdict: 'noted', reason: 'r', actions: [{ seat: 'p1', kind: 'note', durationMs: null, rule: 2 }] });
    expect(again.json).toMatchObject({ ok: true, replay: true });
  });

  it('noted with a warning action stays invalid (400, nothing decided)', async () => {
    const { server, reportId } = await filed('v9');
    const res = await decideHttp(server, { reportId, verdict: 'noted', reason: 'r', actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 2 }] });
    expect([res.status, res.json.error]).toEqual([400, 'invalid_request']);
    expect((await decideHttp(server, { reportId, verdict: 'no_action', reason: 'r', actions: [] })).status).toBe(200);
  });
});

describe('tiny-chat: an empty admin token counts as unset', () => {
  const saved = process.env.TINY_CHAT_ADMIN_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.TINY_CHAT_ADMIN_TOKEN;
    else process.env.TINY_CHAT_ADMIN_TOKEN = saved;
  });
  const probe = { reportId: 'r', verdict: 'upheld', reason: 'r', actions: [] };

  it("adminToken: '' switches the admin API off (404), not open to an empty header", async () => {
    delete process.env.TINY_CHAT_ADMIN_TOKEN;
    const server = await boot({ adminToken: '' });
    for (const token of ['', 'anything', null]) {
      const res = await decideHttp(server, probe, token);
      expect([res.status, res.json]).toEqual([404, { ok: false, refused: 'off' }]);
    }
  });

  it('an empty TINY_CHAT_ADMIN_TOKEN environment variable is unset too', async () => {
    process.env.TINY_CHAT_ADMIN_TOKEN = '';
    const server = await boot();
    const res = await decideHttp(server, probe, '');
    expect([res.status, res.json]).toEqual([404, { ok: false, refused: 'off' }]);
    const both = await boot({ adminToken: '' });
    expect((await decideHttp(both, probe, '')).status).toBe(404);
  });

  it("adminToken: '' falls back to a real TINY_CHAT_ADMIN_TOKEN", async () => {
    process.env.TINY_CHAT_ADMIN_TOKEN = 'env-real-token';
    const server = await boot({ adminToken: '' });
    expect((await decideHttp(server, probe, '')).status).toBe(401);
    const right = await decideHttp(server, probe, 'env-real-token');
    expect([right.status, right.json]).toEqual([404, { error: 'not_found', message: 'Not found.' }]);
  });

  it('a real token with an empty or missing x-admin-token header is 401 (control)', async () => {
    delete process.env.TINY_CHAT_ADMIN_TOKEN;
    const server = await boot({ adminToken: ADMIN });
    for (const token of ['', null, 'wrong']) {
      const res = await decideHttp(server, probe, token);
      expect([res.status, res.json.error]).toEqual([401, 'unauthorized']);
    }
    expect((await decideHttp(server, probe, ADMIN)).status).toBe(404);
  });
});

describe('tiny-chat: a merge does not stop the live notices frame', () => {
  it('the connected client still receives the notice after its browser links an account', async () => {
    const server = await boot();
    // The older person (with an account) survives a merge. Seat them first and let the clock move on.
    server.chatwarden.rooms.seat('lobby', 'ghost-old', { clientKey: 'key-m-old', accountId: 'acct-m' }, 'Old');
    await settle();
    const c = await join(server, 'key-m-new');
    const before = server.chatwarden.rooms.subjectAt('lobby', 'p1');
    // The browser links the account (a login elsewhere): the two subjects merge; seat p1 held the merged-away one.
    server.chatwarden.rooms.seat('lobby', 'ghost-link', { clientKey: 'key-m-new', accountId: 'acct-m' }, 'Link');
    expect(server.chatwarden.rooms.subjectAt('lobby', 'p1')).toBe(server.chatwarden.rooms.subjectAt('lobby', 'ghost-old'));
    expect(server.chatwarden.rooms.subjectAt('lobby', 'p1')).not.toBe(before);
    for (let i = 0; i < 3; i++) c.say('zorbak');
    const frame = await c.next('notices');
    expect(noticesOf(frame)).toHaveLength(1);
    expect(noticesOf(frame)[0]).toMatchObject({ kind: 'chat', rule: 1 });
    expect(JSON.stringify(c.raw)).not.toMatch(IDENTIFIER_RE);
  });
});

describe('tiny-chat: refused frames cite the rule and point at the notice', () => {
  it('blocked cites Community Rule 1; the automatic timeout cites it and points at its notice', async () => {
    const server = await boot();
    const c = await join(server, 'key-f1');
    c.say('zorbak');
    expect(await c.next('refused')).toEqual({ type: 'refused', reason: 'blocked', rule: 1 });
    c.say('zorbak');
    c.say('zorbak');
    const notice = noticesOf(await c.next('notices'))[0];
    expect(notice).toMatchObject({ kind: 'chat', rule: 1 });
    await c.next('refused');
    await c.next('refused');
    c.say('hello');
    const refused = await c.next('refused');
    expect(refused).toMatchObject({ type: 'refused', reason: 'restricted', rule: 1 });
    expect(refused.noticeId).toBe(notice?.id);
    expect(typeof refused.until).toBe('number');
  });

  it('a decided chat restriction cites its rule and the id of the notice the player was sent', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ onReport: (r) => void reports.push(r), adminToken: ADMIN });
    const a = await join(server, 'key-f2');
    await join(server, 'key-f3');
    a.say('hello');
    await a.next('chat');
    await reportHttp(server, { key: 'key-f3', targetSeat: 'p1', category: 'spam' });
    const res = await decideHttp(server, {
      reportId: reports[0]?.id,
      verdict: 'upheld',
      reason: 'private reason',
      actions: [{ seat: 'p1', kind: 'chat', durationMs: 60_000, rule: 4 }],
    });
    expect(res.status).toBe(200);
    const notice = noticesOf(await a.next('notices'))[0];
    a.say('again');
    const refused = await a.next('refused');
    expect(refused).toMatchObject({ type: 'refused', reason: 'restricted', rule: 4, noticeId: notice?.id });
    expect(Object.keys(refused).sort()).toEqual(['noticeId', 'reason', 'rule', 'type', 'until']);
    // The id is the notice's random handle, not an identifier: the scan stays clean.
    expect(JSON.stringify(a.raw)).not.toMatch(IDENTIFIER_RE);
    expect(JSON.stringify(a.raw)).not.toContain('private reason');
  });

  it('an uncovered restriction has no rule field but still points at its notice; other reasons carry neither field', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ onReport: (r) => void reports.push(r), adminToken: ADMIN });
    const a = await join(server, 'key-f4');
    await join(server, 'key-f5');
    a.say('x'.repeat(201));
    expect(await a.next('refused')).toEqual({ type: 'refused', reason: 'length' });
    a.say('hello');
    await a.next('chat');
    await reportHttp(server, { key: 'key-f5', targetSeat: 'p1', category: 'spam' });
    const res = await decideHttp(server, {
      reportId: reports[0]?.id,
      verdict: 'upheld',
      reason: 'r',
      actions: [{ seat: 'p1', kind: 'chat', durationMs: 60_000, rule: 'uncovered', gapNote: 'a private gap note' }],
    });
    expect(res.status).toBe(200);
    const notice = noticesOf(await a.next('notices'))[0];
    a.say('again');
    const refused = await a.next('refused');
    expect('rule' in refused).toBe(false);
    expect(refused.noticeId).toBe(notice?.id);
    expect(JSON.stringify(a.raw)).not.toContain('private gap note');
  });

  it('a banned player refused at the door is pointed at their notice too', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ onReport: (r) => void reports.push(r), adminToken: ADMIN });
    const a = await join(server, 'key-f6');
    await join(server, 'key-f7');
    a.say('hello');
    await a.next('chat');
    await reportHttp(server, { key: 'key-f7', targetSeat: 'p1', category: 'spam' });
    const res = await decideHttp(server, {
      reportId: reports[0]?.id,
      verdict: 'upheld',
      reason: 'r',
      actions: [{ seat: 'p1', kind: 'ban', durationMs: null, rule: 2 }],
    });
    expect(res.status).toBe(200);
    const notice = noticesOf(await a.next('notices'))[0];
    await a.close();
    const again = await Client.connect(`ws://127.0.0.1:${server.port}/?key=key-f6`);
    clients.push(again);
    const refused = await again.next('refused');
    expect(refused).toEqual({ type: 'refused', reason: 'banned', until: null, noticeId: notice?.id });
    expect(again.raw.join('')).not.toMatch(IDENTIFIER_RE);
  });

  it('a bystander on the offender address is told nothing about the offender', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ onReport: (r) => void reports.push(r), adminToken: ADMIN });
    const a = await join(server, 'key-f8');
    const b = await join(server, 'key-f9');
    a.say('hello');
    await a.next('chat');
    await reportHttp(server, { key: 'key-f9', targetSeat: 'p1', category: 'spam' });
    // Every local test client shares 127.0.0.1, so an IP-wide restriction on A reaches B as a bystander.
    const subject = server.chatwarden.rooms.subjectAt('lobby', 'p1') ?? '';
    const res = await server.chatwarden.decide({
      reportId: reports[0]?.id ?? '',
      verdict: 'upheld',
      actor: 'mod',
      reason: 'r',
      actions: [{ subject, kind: 'chat', durationMs: 60_000, rule: 4, includeIp: true }],
    });
    expect(res.ok).toBe(true);
    await a.next('notices');
    b.say('hi');
    const refused = await b.next('refused');
    expect(refused).toMatchObject({ type: 'refused', reason: 'restricted' });
    expect('rule' in refused).toBe(false);
    expect('noticeId' in refused).toBe(false);
  });
});

const SUMMARY = 'Trash talk is part of the game. Harassment, threats and hate are not.';

describe('tiny-chat: runs the relaxed profile and shows its summary', () => {
  it('the welcome frame carries the summary and nothing identifying', async () => {
    const server = await boot();
    expect(server.chatwarden.profile.id).toBe('relaxed');
    expect(server.chatwarden.profile.profanity.mode).toBe('star');
    const client = await Client.connect(`ws://127.0.0.1:${server.port}/?key=key-wel`);
    clients.push(client);
    const welcome = await client.next('welcome');
    expect(welcome).toEqual({ type: 'welcome', seatId: 'p1', summary: SUMMARY });
    expect(client.raw.join('')).not.toMatch(IDENTIFIER_RE);
    expect(client.raw.join('')).not.toContain('key-wel');
  });

  it('every seat gets the same summary, and it is the profile summary', async () => {
    const server = await boot();
    for (const key of ['key-w1', 'key-w2']) {
      const c = await Client.connect(`ws://127.0.0.1:${server.port}/?key=${key}`);
      clients.push(c);
      expect(await c.next('welcome')).toMatchObject({ summary: server.chatwarden.summary });
    }
  });
});

describe('tiny-chat: GET /api/code-of-conduct', () => {
  it('serves the HTML code of conduct, with a locked-down content security policy', async () => {
    const server = await boot();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/code-of-conduct?format=html`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    // The kit's own value, not a copy in the example.
    expect(res.headers.get('content-security-policy')).toBe(CODE_OF_CONDUCT_CSP);
    expect(CODE_OF_CONDUCT_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(text).toContain(server.chatwarden.documents.codeOfConduct({ format: 'html', gameName: 'tiny-chat' }));
    expect(text).toContain(SUMMARY);
    expect(text).toContain('tiny-chat');
  });

  it('is plain generated HTML: no script, no handler, no external reference, no identifier', async () => {
    const server = await boot();
    const text = await (await fetch(`http://127.0.0.1:${server.port}/api/code-of-conduct?format=html`)).text();
    expect(text).not.toMatch(/<script|\son[a-z]+=|javascript:|src=|<iframe|<link/i);
    expect(text).not.toMatch(IDENTIFIER_RE);
  });

  it('is read-only and needs no token: POST is 405, and the admin route stays guarded (control)', async () => {
    const server = await boot({ adminToken: ADMIN });
    const posted = await fetch(`http://127.0.0.1:${server.port}/api/code-of-conduct`, { method: 'POST' });
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET, HEAD');
    expect((await decideHttp(server, {}, null)).status).toBe(401);
  });

  it('defaults to markdown, names the game, and an unknown format is 400', async () => {
    const server = await boot();
    const md = await fetch(`http://127.0.0.1:${server.port}/api/code-of-conduct`);
    expect(md.headers.get('content-type')).toMatch(/^text\/markdown/);
    expect(await md.text()).toContain('tiny-chat');
    expect((await fetch(`http://127.0.0.1:${server.port}/api/code-of-conduct?format=pdf`)).status).toBe(400);
  });

  it('the old root path is gone (control: the kit serves it under /api only)', async () => {
    const server = await boot();
    const old = await fetch(`http://127.0.0.1:${server.port}/code-of-conduct`);
    expect(old.status).toBe(404);
  });
});

describe('tiny-chat: profanity starring and the overrides example', () => {
  // `floomp` and `wibble` are made-up words. Adding them to the profile stands in for real profanity, so the example holds none.
  async function two(over: Parameters<typeof startServer>[0]) {
    const server = await boot(over);
    const a = await join(server, 'key-pf1');
    const b = await join(server, 'key-pf2');
    return { server, a, b };
  }

  it('is active by default: an added word is starred for everyone, and the sender sees the same line', async () => {
    const { a, b } = await two({ overrides: { profanity: { add: ['floomp'] } } });
    a.say('oh floomp it');
    expect(await b.next('chat')).toMatchObject({ text: 'oh ****** it' });
    expect(await a.next('chat')).toMatchObject({ text: 'oh ****** it' });
  });

  it('starring is never a violation: no refusal, no notice, no record, no strike', async () => {
    const { server, a, b } = await two({ overrides: { profanity: { add: ['floomp'] } } });
    for (let i = 0; i < 3; i++) a.say('floomp floomp');
    await b.next('chat');
    await settle();
    expect(a.frames.filter((f) => f.type === 'refused' || f.type === 'notices')).toEqual([]);
    expect(server.chatwarden.notices.record({ clientKey: 'key-pf1' })).toEqual([]);
    const subject = server.chatwarden.rooms.subjectAt('lobby', 'p1') ?? '';
    expect(server.chatwarden.history(subject)).toEqual([]);
    expect(server.chatwarden.doors.check('join', { clientKey: 'key-pf1' })).toBeNull();
  });

  it('a line without the word is untouched (control)', async () => {
    const { a, b } = await two({ overrides: { profanity: { add: ['floomp'] } } });
    a.say('gg well played');
    expect(await b.next('chat')).toMatchObject({ text: 'gg well played' });
  });

  it("overrides: { profanity: { mode: 'allow' } } lets the same line through as written", async () => {
    const { a, b } = await two({ overrides: { profanity: { add: ['floomp'], mode: 'allow' } } });
    a.say('oh floomp it');
    expect(await b.next('chat')).toMatchObject({ text: 'oh floomp it' });
  });

  it('overrides: { profanity: { remove: [...] } } takes a word off the list', async () => {
    const { a, b } = await two({ overrides: { profanity: { add: ['floomp', 'wibble'], remove: ['floomp'] } } });
    a.say('floomp and wibble');
    expect(await b.next('chat')).toMatchObject({ text: 'floomp and ******' });
  });

  it("overrides: { profanity: { mode: 'refuse' } } refuses the line and still records nothing", async () => {
    const { server, a } = await two({ overrides: { profanity: { add: ['floomp'], mode: 'refuse' } } });
    a.say('oh floomp it');
    expect(await a.next('refused')).toEqual({ type: 'refused', reason: 'profanity' });
    expect(server.chatwarden.notices.record({ clientKey: 'key-pf1' })).toEqual([]);
  });

  it('a bad overrides value fails startup, naming the field and not the value', async () => {
    const bad = { profanity: { add: ['sn3rp-secret'] } };
    await expect(startServer({ port: 0, secret: 's', overrides: bad })).rejects.toThrow(/profanity\.add/);
    await expect(startServer({ port: 0, secret: 's', overrides: bad })).rejects.not.toThrow(/sn3rp-secret/);
  });
});

describe('tiny-chat: a noted decision', () => {
  it('creates no notice and no record entry for the player, and none for the reporter either', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ adminToken: ADMIN, onReport: (r) => void reports.push(r) });
    const a = await join(server, 'key-nt1');
    const b = await join(server, 'key-nt2');
    a.say('you are trash');
    await a.next('chat');
    await reportHttp(server, { key: 'key-nt2', targetSeat: 'p1', category: 'harassment' });
    const res = await decideHttp(server, {
      reportId: reports[0]?.id,
      verdict: 'noted',
      reason: 'first rude line',
      actions: [{ seat: 'p1', kind: 'note', durationMs: null, rule: 2 }],
    });
    expect(res.json).toMatchObject({ ok: true, replay: false });
    await settle();
    for (const c of [a, b]) expect(c.frames.filter((f) => f.type === 'notices')).toEqual([]);
    for (const key of ['key-nt1', 'key-nt2']) {
      expect((await http(server, `/api/record?key=${key}`)).json).toEqual({ record: [] });
    }
    const subject = server.chatwarden.rooms.subjectAt('lobby', 'p1') ?? '';
    expect(server.chatwarden.history(subject)).toMatchObject([{ kind: 'note', roomId: 'lobby' }]);
  });
});

describe('tiny-chat: the player API (/api) and the health probes', () => {
  const api = (server: TinyChat, path: string, init?: RequestInit): Promise<Reply> => http(server, `/api${path}`, init);

  /** A server where p1 holds a pending warning (decided through the staff API), and the key it belongs to. */
  async function warned(tag: string) {
    const reports: StoredReport[] = [];
    const server = await boot({ adminToken: ADMIN, onReport: (r) => void reports.push(r) });
    const a = await join(server, `key-${tag}a`);
    await join(server, `key-${tag}b`);
    a.say('hello');
    await a.next('chat');
    await reportHttp(server, { key: `key-${tag}b`, targetSeat: 'p1', category: 'spam' });
    const res = await decideHttp(server, {
      reportId: reports[0]?.id,
      verdict: 'upheld',
      reason: 'private reason',
      actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 2 }],
    });
    expect(res.status).toBe(200);
    await a.next('notices');
    return { server, a, key: `key-${tag}a`, otherKey: `key-${tag}b` };
  }

  it('GET /api/notices lists the pending notice for the key in the x-chatwarden-key header', async () => {
    const { server, key } = await warned('p1');
    const res = await api(server, '/notices', { headers: { 'x-chatwarden-key': key } });
    expect(res.status).toBe(200);
    const notices = res.json.notices as Array<Record<string, unknown>>;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'warning', rule: 2, mustAcknowledge: true });
    expect(res.text).not.toMatch(IDENTIFIER_RE);
    expect(res.text).not.toContain('private reason');
  });

  it('the demo falls back to ?key=, and the header wins when both are sent', async () => {
    const { server, key, otherKey } = await warned('p2');
    const viaQuery = await api(server, `/notices?key=${key}`);
    expect((viaQuery.json.notices as unknown[]).length).toBe(1);
    const kinds = (r: Reply): unknown[] => (r.json.notices as Array<{ kind: string }>).map((n) => n.kind);
    expect(kinds(viaQuery)).toEqual(['warning']);
    // The other player is the reporter: they hold only the report outcome, never the warning.
    const headerWins = await api(server, `/notices?key=${key}`, { headers: { 'x-chatwarden-key': otherKey } });
    expect(kinds(headerWins)).toEqual(['report_outcome']);
    const queryOnly = await api(server, `/notices?key=${otherKey}`);
    expect(kinds(queryOnly)).toEqual(['report_outcome']);
  });

  it('no key is nobody: empty lists, 200', async () => {
    const { server } = await warned('p3');
    expect((await api(server, '/notices')).json).toEqual({ notices: [] });
    expect((await api(server, '/notices?key=')).json).toEqual({ notices: [] });
    expect((await api(server, '/notices', { headers: { 'x-chatwarden-key': 'unknown-key' } })).json).toEqual({ notices: [] });
  });

  it('with no key the identity is the socket address: forged address headers cannot buy a fresh names-check bucket', async () => {
    const server = await boot();
    const json = { 'content-type': 'application/json' };
    const check = (i: number): Promise<Reply> =>
      api(server, '/names/check', {
        method: 'POST',
        headers: {
          ...json,
          'x-forwarded-for': `203.0.113.${i}`,
          'x-real-ip': `203.0.114.${i}`,
          forwarded: `for=203.0.115.${i}`,
          'x-tiny-chat-ip': `203.0.116.${i}`,
        },
        body: JSON.stringify({ name: 'Friendly Fox' }),
      });
    const statuses: number[] = [];
    // The default limit is 20 a minute per identity; with no key the identity is the address.
    for (let i = 0; i < 22; i++) statuses.push((await check(i)).status);
    expect(statuses.slice(0, 20).every((st) => st === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  it('control: distinct keys are distinct identities, each with its own names-check bucket', async () => {
    const server = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await api(server, '/names/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chatwarden-key': `key-bucket-${i}` },
        body: JSON.stringify({ name: 'Friendly Fox' }),
      });
      statuses.push(res.status);
    }
    expect(statuses.every((st) => st === 200)).toBe(true);
  });

  it('a forged address header is just a header: it does not reach a key identity either', async () => {
    const { server, key } = await warned('p4');
    const res = await api(server, '/notices', { headers: { 'x-chatwarden-key': key, 'x-forwarded-for': '203.0.113.9' } });
    expect((res.json.notices as unknown[]).length).toBe(1);
  });

  it('answers carry no x-powered-by and no etag', async () => {
    const server = await boot();
    for (const path of ['/api/rules', '/healthz', '/api/nope']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.headers.get('x-powered-by')).toBeNull();
      expect(res.headers.get('etag')).toBeNull();
    }
    const report = await fetch(`http://127.0.0.1:${server.port}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(report.headers.get('x-powered-by')).toBeNull();
  });

  it('HEAD /healthz and /readyz are 200 with no body (probes that use HEAD)', async () => {
    const server = await boot();
    for (const path of ['/healthz', '/readyz']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('');
    }
    const wrong = await fetch(`http://127.0.0.1:${server.port}/healthz`, { method: 'POST' });
    expect(wrong.headers.get('allow')).toBe('GET, HEAD');
  });

  it('POST /api/notices/:id/ack acks the caller own notice; another key, an unknown id and no key are ok:false', async () => {
    const { server, key, otherKey } = await warned('p5');
    const id = String(((await api(server, '/notices', { headers: { 'x-chatwarden-key': key } })).json.notices as Array<{ id: string }>)[0]?.id);
    const ack = (k: string | null, nid: string): Promise<Reply> =>
      api(server, `/notices/${nid}/ack`, { method: 'POST', headers: k === null ? {} : { 'x-chatwarden-key': k } });
    expect((await ack(otherKey, id)).json).toEqual({ ok: false });
    expect((await ack(null, id)).json).toEqual({ ok: false });
    expect((await ack(key, 'no-such-notice')).json).toEqual({ ok: false });
    expect((await ack(key, id)).json).toEqual({ ok: true });
    expect((await api(server, '/notices', { headers: { 'x-chatwarden-key': key } })).json).toEqual({ notices: [] });
    expect(server.chatwarden.notices.pendingWarning({ clientKey: key })).toBe(false);
    // The acked warning is in My record.
    const rec = await api(server, '/record', { headers: { 'x-chatwarden-key': key } });
    expect((rec.json.record as Array<{ id: string }>).map((n) => n.id)).toEqual([id]);
  });

  it('GET /api/rules lists the active rules and the summary, with no identifier', async () => {
    const server = await boot();
    const res = await api(server, '/rules');
    expect(res.status).toBe(200);
    expect(res.json.summary).toBe(SUMMARY);
    const rules = res.json.rules as Array<{ number: number; title: string; text: string }>;
    expect(rules.length).toBeGreaterThanOrEqual(8);
    expect(rules[0]).toEqual({ number: 1, title: expect.any(String), text: expect.any(String) });
    expect(res.text).not.toMatch(IDENTIFIER_RE);
  });

  it('POST /api/names/check answers for a name, and a missing name is 400', async () => {
    const server = await boot();
    const json = { 'content-type': 'application/json' };
    const ok = await api(server, '/names/check', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Friendly Fox' }) });
    expect(ok.status).toBe(200);
    const bad = await api(server, '/names/check', { method: 'POST', headers: json, body: '{}' });
    expect([bad.status, bad.json.error]).toEqual([400, 'invalid_request']);
  });

  it('an unknown /api path is the kit 404 JSON, and a wrong method a 405', async () => {
    const server = await boot();
    const missing = await api(server, '/nope');
    expect([missing.status, missing.json]).toEqual([404, { error: 'not_found', message: 'Not found.' }]);
    const wrong = await api(server, '/notices', { method: 'DELETE' });
    expect([wrong.status, wrong.json.error]).toEqual([405, 'method_not_allowed']);
  });

  it('the old /record and /decide routes are gone (control)', async () => {
    const server = await boot();
    expect((await http(server, '/record?key=whoever')).status).toBe(404);
    expect((await http(server, '/decide', { method: 'POST', headers: { 'x-admin-token': ADMIN } })).status).toBe(404);
  });

  it('GET /healthz and /readyz are public and say only "ok"', async () => {
    const server = await boot();
    for (const path of ['/healthz', '/readyz']) {
      const res = await http(server, path);
      expect([res.status, res.json]).toEqual([200, { ok: true }]);
    }
    const post = await http(server, '/healthz', { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it('health at the root does not swallow the demo own routes (POST /report and the socket still work)', async () => {
    const server = await boot();
    await join(server, 'key-hr1');
    const self = await reportHttp(server, { key: 'key-hr1', targetSeat: 'p1', category: 'spam' });
    expect([self.status, self.json]).toEqual([422, { ok: false, refused: 'self' }]);
    const unknown = await http(server, '/nothing-here');
    expect([unknown.status, unknown.json.error]).toEqual([404, 'not_found']);
  });
});

describe('tiny-chat: the README curl example', () => {
  const readme = readFileSync(fileURLToPath(new URL('./README.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const curl = readme.slice(readme.indexOf('curl -X POST'), readme.indexOf('```', readme.indexOf('curl -X POST')));

  it('expands the admin token (double quotes) and does not leave it literal in single quotes', () => {
    expect(curl).toContain('-H "x-admin-token: $TINY_CHAT_ADMIN_TOKEN"');
    expect(curl).not.toContain("'x-admin-token: $TINY_CHAT_ADMIN_TOKEN'");
  });

  it('breaks each option onto its own line with a backslash continuation, including before -d', () => {
    const lines = curl.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines.slice(0, -1)) expect(line.endsWith(' \\')).toBe(true);
    expect(lines.at(-1)?.trimStart().startsWith("-d '")).toBe(true);
    expect(lines.some((l) => l.trimStart().startsWith('-d ') && l.includes('-H'))).toBe(false);
  });
});

describe('the READMEs show the preset and the overrides', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const root = read('../../README.md');

  it('the root README has "Pick a preset": the one-liner, both overrides, the standards link and the slur note', () => {
    expect(root).toContain('## Pick a preset');
    expect(root).toContain("createChatwarden({ profile: 'relaxed',");
    expect(root).toContain("overrides: { profanity: { mode: 'allow' } }");
    expect(root).toContain("overrides: { profanity: { remove: ['damn', 'hell'] } }");
    expect(root).toContain('docs/design/2026-11-09-moderation-standards.md');
    expect(root).toContain('profanity starring is not slur protection');
  });

  it('the standards link points at a real file', () => {
    expect(() => read('../../docs/design/2026-11-09-moderation-standards.md')).not.toThrow();
  });

  it('the tiny-chat README says it runs relaxed with the profanity package and serves /code-of-conduct', () => {
    const tiny = read('./README.md');
    expect(tiny).toContain("profile: 'relaxed'");
    expect(tiny).toContain('profanityPackage');
    expect(tiny).toContain('GET /api/code-of-conduct');
    expect(tiny).toContain("default-src 'none'; style-src 'unsafe-inline'");
  });
});

// --- K3b: the optional Discord feed ---------------------------------------------------------------------------

const DISCORD_URL = 'https://discord.com/api/webhooks/123456789012345678/tok_ABC-def_123XYZ';
const DISCORD_ROLE = '987654321098765432';

/** A fake Discord forum webhook: records every call, opens thread T1, accepts posts. */
function fakeDiscord() {
  const calls: Array<{ url: URL; body: Record<string, unknown> }> = [];
  const fetchFn = ((url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ url: u, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const reply = u.searchParams.has('thread_id') ? { id: 'm' } : { id: 'm', channel_id: 'T1' };
    return Promise.resolve(new Response(JSON.stringify(reply), { status: 200 }));
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('tiny-chat: the optional Discord feed', () => {
  // The file clears both variables up top; each test here sets what it needs and this puts them back to cleared.
  afterEach(() => {
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_MENTION_ROLE_ID;
  });

  it('the default boot() has no feed and never reaches the Discord fetch, whatever the shell exports', async () => {
    expect(process.env.DISCORD_WEBHOOK_URL).toBeUndefined();
    expect(process.env.DISCORD_MENTION_ROLE_ID).toBeUndefined();
    const server = await boot();
    expect(server.discord).toBe(false);
    expect(strayDiscordCalls).toEqual([]);
  });

  it('an explicitly passed empty string forces the feed off even when the environment has a URL', async () => {
    process.env.DISCORD_WEBHOOK_URL = DISCORD_URL;
    process.env.DISCORD_MENTION_ROLE_ID = DISCORD_ROLE;
    const d = fakeDiscord();
    const reports: StoredReport[] = [];
    const server = await boot({ discordWebhookUrl: '', discordFetch: d.fetch, onReport: (r) => void reports.push(r) });
    expect(server.discord).toBe(false);
    await reportOne(server, reports, 'hate');
    await settle();
    expect(d.calls).toEqual([]);
  });

  it('an explicitly passed empty role id means no ping even when the environment has a role', async () => {
    process.env.DISCORD_MENTION_ROLE_ID = DISCORD_ROLE;
    const d = fakeDiscord();
    const reports: StoredReport[] = [];
    const server = await boot({ discordWebhookUrl: DISCORD_URL, discordMentionRoleId: '', discordFetch: d.fetch, onReport: (r) => void reports.push(r) });
    expect(server.discord).toBe(true);
    await reportOne(server, reports, 'hate');
    await waitFor(() => d.calls.length >= 1);
    expect(String(d.calls[0]?.body.content)).not.toContain('<@&');
    expect(d.calls[0]?.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('an option that is left out falls back to the environment', async () => {
    process.env.DISCORD_WEBHOOK_URL = DISCORD_URL;
    const d = fakeDiscord();
    const server = await boot({ discordFetch: d.fetch });
    expect(server.discord).toBe(true);
  });

  /** Two players; the second reports the first. Returns the report. */
  async function reportOne(server: TinyChat, reports: StoredReport[], category = 'harassment'): Promise<StoredReport> {
    const a = await join(server, 'key-dc1');
    await join(server, 'key-dc2');
    a.say('a line in the lobby');
    await a.next('chat');
    const res = await reportHttp(server, { key: 'key-dc2', targetSeat: 'p1', category });
    expect(res.status).toBe(200);
    await waitFor(() => reports.length > 0);
    return reports[0] as StoredReport;
  }

  it('is off without DISCORD_WEBHOOK_URL: nothing is posted, and the server says so', async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_MENTION_ROLE_ID;
    const d = fakeDiscord();
    const reports: StoredReport[] = [];
    const server = await boot({ adminToken: ADMIN, discordFetch: d.fetch, onReport: (r) => void reports.push(r) });
    expect(server.discord).toBe(false);
    const report = await reportOne(server, reports);
    await decideHttp(server, {
      reportId: report.id,
      verdict: 'upheld',
      reason: 'private',
      actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 2 }],
    });
    await settle();
    expect(d.calls).toEqual([]);
  });

  it.each([
    ['an empty DISCORD_WEBHOOK_URL', { url: '' }],
    ['only a role id', { role: DISCORD_ROLE }],
    ['an empty option', { option: '' }],
  ])('stays off with %s', async (_name, env) => {
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_MENTION_ROLE_ID;
    if ('url' in env) process.env.DISCORD_WEBHOOK_URL = env.url;
    if ('role' in env) process.env.DISCORD_MENTION_ROLE_ID = env.role;
    const d = fakeDiscord();
    const reports: StoredReport[] = [];
    const server = await boot({
      discordFetch: d.fetch,
      ...('option' in env ? { discordWebhookUrl: env.option } : {}),
      onReport: (r) => void reports.push(r),
    });
    expect(server.discord).toBe(false);
    await reportOne(server, reports);
    await settle();
    expect(d.calls).toEqual([]);
  });

  it('is on with DISCORD_WEBHOOK_URL: a report opens a thread whose links point at the demo admin routes, and the decision posts into it', async () => {
    process.env.DISCORD_WEBHOOK_URL = DISCORD_URL;
    process.env.DISCORD_MENTION_ROLE_ID = DISCORD_ROLE;
    const d = fakeDiscord();
    const reports: StoredReport[] = [];
    const server = await boot({ adminToken: ADMIN, discordFetch: d.fetch, onReport: (r) => void reports.push(r) });
    expect(server.discord).toBe(true);
    const report = await reportOne(server, reports, 'hate');
    await waitFor(() => d.calls.length >= 1);
    const first = d.calls[0] as (typeof d.calls)[number];
    expect(first.url.searchParams.has('thread_id')).toBe(false);
    expect(String(first.body.thread_name)).toMatch(/^Case [0-9A-HJKMNP-TV-Z]{5}$/);
    const text = String(first.body.content);
    expect(text).toContain('**Severe report**');
    expect(text).toContain(`<@&${DISCORD_ROLE}>`);
    expect(first.body.allowed_mentions).toEqual({ parse: [], roles: [DISCORD_ROLE] });
    expect(text).toContain(`[Open report](<http://127.0.0.1:${server.port}/admin/reports/${report.id}>)`);
    expect(text).toMatch(new RegExp(`\\[Open person\\]\\(<http://127\\.0\\.0\\.1:${server.port}/admin/people/s_[A-Za-z0-9_-]+/history>\\)`));

    // The link works with the demo token, and shows the same report.
    const link = /\(<(http:\/\/127\.0\.0\.1:\d+\/admin\/reports\/[^>]+)>\)/.exec(text)?.[1] as string;
    const opened = await fetch(link, { headers: { 'x-admin-token': ADMIN } });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { report: { id: string } }).report.id).toBe(report.id);

    // A decision posts into the same thread.
    const decided = await decideHttp(server, {
      reportId: report.id,
      verdict: 'upheld',
      reason: 'PRIVATE-REASON',
      actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 2 }],
    });
    expect(decided.status).toBe(200);
    await waitFor(() => d.calls.length >= 3);
    expect(d.calls.filter((c) => !c.url.searchParams.has('thread_id'))).toHaveLength(1);
    for (const c of d.calls.slice(1)) expect(c.url.searchParams.get('thread_id')).toBe('T1');
    const all = d.calls.map((c) => String(c.body.content)).join('\n');
    expect(all).toContain('**Report closed** · Upheld');
    expect(all).toContain('**Sanction applied** · Warning');
    // No chat text and no reason in what staff read in Discord.
    expect(all).not.toContain('a line in the lobby');
    expect(all).not.toContain('PRIVATE-REASON');
  });

  it('the options win over the environment, and a mention role is optional', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/111111111111111111/from-env';
    delete process.env.DISCORD_MENTION_ROLE_ID;
    const d = fakeDiscord();
    const reports: StoredReport[] = [];
    const server = await boot({ discordWebhookUrl: DISCORD_URL, discordFetch: d.fetch, onReport: (r) => void reports.push(r) });
    expect(server.discord).toBe(true);
    await reportOne(server, reports, 'hate');
    await waitFor(() => d.calls.length >= 1);
    expect(d.calls[0]?.url.pathname).toBe('/api/webhooks/123456789012345678/tok_ABC-def_123XYZ');
    // Severe, but no role was configured: nobody is pinged.
    expect(String(d.calls[0]?.body.content)).not.toContain('<@&');
    expect(d.calls[0]?.body.allowed_mentions).toEqual({ parse: [] });
  });

  it.each([
    ['a webhook URL that is not a Discord one', { discordWebhookUrl: 'https://example.com/api/webhooks/123456789012345678/x' }],
    ['a role id that is not digits', { discordWebhookUrl: DISCORD_URL, discordMentionRoleId: 'everyone' }],
  ])('refuses %s at startup, without echoing it', async (_name, opts) => {
    delete process.env.DISCORD_WEBHOOK_URL;
    let caught: unknown;
    try {
      await boot({ ...opts, discordFetch: fakeDiscord().fetch });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RangeError);
    for (const v of Object.values(opts)) expect(String((caught as Error).message)).not.toContain(v);
  });

  it('the README documents the variables, the package and that it is off unless the variable is set', () => {
    const tiny = readFileSync(fileURLToPath(new URL('./README.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    expect(tiny).toContain('DISCORD_WEBHOOK_URL');
    expect(tiny).toContain('DISCORD_MENTION_ROLE_ID');
    expect(tiny).toContain('@chatwarden/discord');
    expect(tiny).toMatch(/off unless|off by default/i);
    expect(tiny).toMatch(/empty string.*off/is);
  });
});

// --- leak scans that run after everything else has pushed its bodies -----------------------------------------------

/** A raw demo key as these tests name them (`key-na`, `key-bucket-3`), a 32+ hex hash, an IPv4 address. */
const RAW_KEY_RE = /\bkey-[a-z0-9-]+/;
const HASH_RE = /[0-9a-f]{32}/;
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

describe('tiny-chat: every /api and decision body, scanned after all of them exist', () => {
  beforeAll(async () => {
    // Make sure every player route has answered at least once, whatever ran before this.
    const server = await boot();
    const headers = { 'x-chatwarden-key': 'key-final-scan' };
    await http(server, '/api/notices', { headers });
    await http(server, '/api/record', { headers });
    await http(server, '/api/rules');
    await http(server, '/api/code-of-conduct?format=html');
    await http(server, '/api/notices/some-id/ack', { method: 'POST', headers });
    await http(server, '/api/names/check', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Friendly Fox' }) });
  });

  it('has bodies from every player route', () => {
    const seen = new Set(bodyPaths.map((p) => p.replace(/^\/api\/notices\/[^/]+\/ack$/, '/api/notices/:id/ack')));
    for (const route of ['/api/notices', '/api/notices/:id/ack', '/api/record', '/api/rules', '/api/code-of-conduct', '/api/names/check']) {
      expect(seen.has(route), route).toBe(true);
    }
    expect(bodies.some((t) => t.includes('"rules"'))).toBe(true);
    expect(bodies.some((t) => t.includes('"notices"'))).toBe(true);
  });

  it('none of them has an identifier, a key, a hash, the admin token, a moderator, a reason or an address', () => {
    for (const text of bodies) {
      expect(text).not.toMatch(IDENTIFIER_RE);
      expect(text).not.toMatch(RAW_KEY_RE);
      expect(text).not.toMatch(HASH_RE);
      expect(text).not.toMatch(IPV4_RE);
      for (const secret of [ADMIN, 'demo-admin', 'private reason', 'private moderator reason', 'a private gap note']) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('the scan would catch a leak (positive controls for each pattern)', () => {
    expect(JSON.stringify({ notices: [], who: 'key-na' })).toMatch(RAW_KEY_RE);
    expect(JSON.stringify({ record: [], h: 'a1b2c3d4'.repeat(4) })).toMatch(HASH_RE);
    expect(JSON.stringify({ notices: [], ip: '203.0.113.9' })).toMatch(IPV4_RE);
    expect(JSON.stringify({ ok: true, subject: 's_AAAAAAAAAAAAAAAAAAAAAA' })).toMatch(IDENTIFIER_RE);
    expect(JSON.stringify({ rules: [{ number: 1, title: 'x', text: 'y' }] })).not.toMatch(IDENTIFIER_RE);
  });
});

describe('tiny-chat: every staff (/admin) response, scanned for what staff must never see', () => {
  const reports: StoredReport[] = [];
  let server: TinyChat;

  beforeAll(async () => {
    server = await boot({ adminToken: ADMIN, onReport: (r) => void reports.push(r) });
    const a = await join(server, 'key-staff-a');
    await join(server, 'key-staff-b');
    a.say('hello there');
    await a.next('chat');
    await reportHttp(server, { key: 'key-staff-b', targetSeat: 'p1', category: 'harassment' });
    const id = reports[0]?.id ?? '';
    const who = await subjectsOf(server, id);
    if (who === null) throw new Error('expected a report');
    await staffGet(server, '/reports');
    await staffGet(server, '/reports?status=open&limit=5');
    await staffGet(server, `/reports/${id}`);
    await staffGet(server, `/people/${who.target}/history`);
    await staffGet(server, '/policy');
    await http(server, `/admin/reports/${id}/suggest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: '{}' });
    await decideHttp(server, { reportId: id, verdict: 'upheld', reason: 'private note', actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 2 }] });
    // Rejected calls too: a 401 and a 404.
    // The gap, sanction and term routes. A chat restriction under no rule opens a gap; a second one is revoked.
    const json = { 'content-type': 'application/json', 'x-admin-token': ADMIN };
    const staffPost = (path: string, body: unknown): Promise<Reply> =>
      http(server, `/admin${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) });
    const gapped = await staffPost('/sanctions', { subject: who.target, kind: 'chat', durationMs: 60_000, rule: 'uncovered', gapNote: 'a private gap note', reason: 'r' });
    const plain = await staffPost('/sanctions', { subject: who.target, kind: 'chat', durationMs: 60_000, rule: 4, reason: 'r' });
    await staffGet(server, '/gaps');
    await staffPost(`/gaps/${String(gapped.json.groupId)}/close`, { status: 'not_a_rule' });
    await staffPost(`/sanctions/${String(plain.json.groupId)}/revoke`, { reason: 'mistake' });
    await staffGet(server, '/terms');
    await staffPost('/terms/check', { term: 'vlemmo', language: 'en' });
    await staffGet(server, '/policy');
    // Rejected calls too: a 401 and a 404.
    await staffGet(server, `/reports/${id}`, 'wrong');
    await staffGet(server, '/reports/no-such-report');
    await staffGet(server, '/audit');
  });

  it('every one of the 13 staff routes answered 200 at least once', () => {
    const ok = new Set(staffLog.filter((e) => e.text !== '' && !e.text.includes('"error"')).map((e) => e.path.replace(/^(\/admin\/(?:reports|people|gaps|sanctions))\/[^/]+/, '$1/:id')));
    const want = [
      '/admin/reports', '/admin/reports/:id', '/admin/reports/:id/suggest', '/admin/reports/:id/decide', '/admin/people/:id/history',
      '/admin/sanctions', '/admin/sanctions/:id/revoke', '/admin/gaps', '/admin/gaps/:id/close',
      '/admin/terms', '/admin/terms/check', '/admin/policy', '/admin/audit',
    ];
    expect(want).toHaveLength(13);
    for (const route of want) expect(ok.has(route), route).toBe(true);
  });

  it('covers the report queue, the detail, a person, the policy, suggest, decide and the audit trail', () => {
    const paths = new Set(staffLog.map((e) => e.path.replace(/\/(reports|people)\/[^/]+/, '/$1/:id')));
    for (const route of ['/admin/reports', '/admin/reports/:id', '/admin/people/:id/history', '/admin/policy', '/admin/reports/:id/suggest', '/admin/reports/:id/decide', '/admin/audit', '/admin/gaps', '/admin/terms', '/admin/terms/check']) {
      expect(paths.has(route), route).toBe(true);
    }
    // Staff do see subject ids: the report detail names the people (a control for the id pattern below).
    expect(staffLog.some((e) => /"targetSubject":"s_/.test(e.text))).toBe(true);
  });

  it('no key hash (32+ hex), raw client key, admin token or address in any staff response; subject ids are allowed', () => {
    for (const { path, text } of staffLog) {
      expect(text, path).not.toMatch(HASH_RE);
      expect(text, path).not.toMatch(RAW_KEY_RE);
      expect(text, path).not.toMatch(IPV4_RE);
      expect(text, path).not.toContain(ADMIN);
    }
  });

  it('the staff scan would catch a leak (positive controls)', () => {
    const subjectOnly = JSON.stringify({ report: { targetSubject: 's_AAAAAAAAAAAAAAAAAAAAAA' } });
    expect(subjectOnly).not.toMatch(HASH_RE);
    expect(JSON.stringify({ report: { clientKeyHash: 'f'.repeat(32) } })).toMatch(HASH_RE);
    expect(JSON.stringify({ report: { reporterKey: 'key-staff-b' } })).toMatch(RAW_KEY_RE);
    expect(JSON.stringify({ audit: [{ ip: '127.0.0.1' }] })).toMatch(IPV4_RE);
  });
});
