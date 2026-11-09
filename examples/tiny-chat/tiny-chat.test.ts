import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { StoredReport } from '@chatwarden/core';
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

const servers: TinyChat[] = [];
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  for (const s of servers) await s.close();
});

async function boot(opts: Parameters<typeof startServer>[0] = {}): Promise<TinyChat> {
  const server = await startServer({ port: 0, secret: 'test-secret-not-for-production', ...opts });
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
    expect(await a.next('refused')).toEqual({ type: 'refused', reason: 'blocked' });
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

async function http(server: TinyChat, path: string, init?: RequestInit): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, init);
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}
const decideHttp = (server: TinyChat, body: unknown, token: string | null = ADMIN): Promise<Reply> =>
  http(server, '/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { 'x-admin-token': token }) },
    body: JSON.stringify(body),
  });
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
    verdict: 'fair',
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

  it('POST /decide needs the admin token: none, wrong and a different-length one are all 401, and nothing is decided', async () => {
    for (const token of [null, 'wrong', `${ADMIN}x`, '']) {
      const res = await decideHttp(server, decision(), token);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ ok: false, refused: 'unauthorized' });
    }
    await settle();
    expect(a.frames.filter((f) => f.type === 'notices')).toEqual([]);
    expect(server.chatwarden.notices.pending({ clientKey: 'key-na' })).toEqual([]);
  });

  it('a warning with the reported lines: the target gets the notice with their OWN lines, masked; the reporter an outcome', async () => {
    const res = await decideHttp(server, decision());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, replay: false });
    expect(res.json.refCodes).toHaveLength(1);

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

    const rec = await http(server, '/record?key=key-na');
    expect(rec.status).toBe(200);
    const items = rec.json.items as Array<Record<string, unknown>>;
    expect(items.map((n) => n.id)).toEqual([warningId]);
    expect(items[0]).toMatchObject({ kind: 'warning', rule: 2 });
  });

  it('the reporter record never lists a report outcome; an unknown key and a missing key are handled', async () => {
    expect((await http(server, '/record?key=key-nb')).json).toEqual({ ok: true, items: [] });
    expect((await http(server, '/record?key=nobody')).json).toEqual({ ok: true, items: [] });
    const none = await http(server, '/record');
    expect(none.status).toBe(400);
    expect(none.json).toEqual({ ok: false, refused: 'bad_request' });
    expect((await http(server, '/record?key=')).status).toBe(400);
  });

  it('the notices, the record and every response leak no identifier, key, reason or moderator', () => {
    const frames = everyone.flatMap((c) => c.raw);
    // The scan is not vacuous: it covers notice frames, acks and a record body.
    expect(frames.some((t) => t.includes('"type":"notices"'))).toBe(true);
    expect(frames.some((t) => t.includes('"type":"acked"'))).toBe(true);
    expect(bodies.some((t) => t.includes('"items"'))).toBe(true);
    expect(bodies.some((t) => t.includes('refCodes'))).toBe(true);
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
      verdict: 'fair',
      reason: 'r',
      actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 2, lineIds: [yLine] }],
    });
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ ok: false, refused: 'invalid' });
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

  it('POST /decide is off (404) when no admin token is configured, even with a header', async () => {
    delete process.env.TINY_CHAT_ADMIN_TOKEN;
    const server = await boot();
    const res = await decideHttp(server, { reportId: 'r', verdict: 'fair', reason: 'r', actions: [] }, 'anything');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ ok: false, refused: 'off' });
  });

  it('the admin token can come from TINY_CHAT_ADMIN_TOKEN', async () => {
    process.env.TINY_CHAT_ADMIN_TOKEN = 'from-env-token';
    const server = await boot();
    const wrong = await decideHttp(server, { reportId: 'r', verdict: 'fair', reason: 'r', actions: [] }, ADMIN);
    expect(wrong.status).toBe(401);
    const right = await decideHttp(server, { reportId: 'r', verdict: 'fair', reason: 'r', actions: [] }, 'from-env-token');
    expect(right.status).toBe(404);
    expect(right.json).toEqual({ ok: false, refused: 'not_found' });
  });

  it('answers 400 for a malformed body, 422 for an unknown seat, 422 for an invalid decision and 404 for an unknown report', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ adminToken: ADMIN, onReport: (r) => void reports.push(r) });
    const a = await join(server, 'key-e1');
    await join(server, 'key-e2');
    a.say('hello');
    await a.next('chat');
    await reportHttp(server, { key: 'key-e2', targetSeat: 'p1', category: 'spam' });
    const reportId = reports[0]?.id;
    const good = { reportId, verdict: 'fair', reason: 'r', actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 2 }] };

    expect((await decideHttp(server, { verdict: 'fair' })).status).toBe(400);
    expect((await decideHttp(server, { ...good, verdict: 'maybe' })).status).toBe(400);
    expect((await decideHttp(server, { ...good, actions: 'x' })).status).toBe(400);
    const noSeat = await decideHttp(server, { ...good, actions: [{ seat: 'p99', kind: 'warning', durationMs: null, rule: 2 }] });
    expect([noSeat.status, noSeat.json]).toEqual([422, { ok: false, refused: 'no_such_seat' }]);
    const noSeatField = await decideHttp(server, { ...good, actions: [{ kind: 'warning', durationMs: null, rule: 2 }] });
    expect(noSeatField.status).toBe(422);
    const badRule = await decideHttp(server, { ...good, actions: [{ seat: 'p1', kind: 'warning', durationMs: null, rule: 99 }] });
    expect([badRule.status, badRule.json]).toEqual([422, { ok: false, refused: 'invalid' }]);
    const unknown = await decideHttp(server, { ...good, reportId: 'nope' });
    expect([unknown.status, unknown.json]).toEqual([404, { ok: false, refused: 'not_found' }]);
    // Nothing above decided anything; the real one still can.
    expect((await decideHttp(server, good)).status).toBe(200);
  });

  it('a subject smuggled into an action is ignored: the seat decides who is sanctioned', async () => {
    const reports: StoredReport[] = [];
    const server = await boot({ adminToken: ADMIN, onReport: (r) => void reports.push(r) });
    const a = await join(server, 'key-s1');
    const b = await join(server, 'key-s2');
    a.say('hello');
    await a.next('chat');
    await reportHttp(server, { key: 'key-s2', targetSeat: 'p1', category: 'spam' });
    const bSubject = server.chatwarden.rooms.subjectAt('lobby', 'p2');
    const res = await decideHttp(server, {
      reportId: reports[0]?.id,
      verdict: 'fair',
      reason: 'r',
      actions: [{ seat: 'p1', subject: bSubject, kind: 'warning', durationMs: null, rule: 2 }],
    });
    expect(res.status).toBe(200);
    const mine = await a.next('notices');
    expect(noticesOf(mine)[0]).toMatchObject({ kind: 'warning' });
    // B is only the reporter: an outcome, not a warning.
    expect(noticesOf(await b.next('notices')).map((n) => n.kind)).toEqual(['report_outcome']);
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
      verdict: 'fair',
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
      verdict: 'fair',
      actor: 'mod',
      reason: 'r',
      actions: [{ subject, kind: 'warning', durationMs: null, rule: 2 }],
    });
    if (!res.ok) throw new Error('expected ok');
    await a.next('notices');
    expect(((await http(server, '/record?key=key-r1')).json.items as unknown[]).length).toBe(1);
    expect(await server.chatwarden.sanctions.revoke(res.groups[0]?.groupId ?? '', 'mod', 'mistake')).toBe(true);
    expect((await http(server, '/record?key=key-r1')).json).toEqual({ ok: true, items: [] });
    expect(server.chatwarden.notices.pendingWarning({ clientKey: 'key-r1' })).toBe(false);
  });
});
