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
