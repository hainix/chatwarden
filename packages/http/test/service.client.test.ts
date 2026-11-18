import { describe, expect, it } from 'vitest';
import { ServiceError, createServiceClient } from '../src/service/client.js';
import type { ServiceClient } from '../src/service/client.js';
import { KEY_A } from './serviceKit.js';
import { serviceWorld } from './serviceWorld.js';

// S6: the typed client of the service API: one method per route, a bearer on every call, an Idempotency-Key per call that is reused across its own retries, a bounded retry on network errors
// and 5xx (never on 4xx), and a refusal is returned, not thrown.

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | Error | (() => Response);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function scripted(replies: Reply[]) {
  const sent: Sent[] = [];
  const slept: number[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ method: String(init.method), url, headers, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const next = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : (next as Response).clone();
  }) as unknown as typeof fetch;
  const client = createServiceClient({ baseUrl: 'https://svc.test/', key: KEY_A, fetch: fetchImpl, sleep: async (ms) => void slept.push(ms) });
  return { client, sent, slept };
}

const WHO = { clientKey: 'client-key-0001' };

describe('every method hits its route with the bearer', () => {
  const cases: Array<[string, (c: ServiceClient) => Promise<unknown>, string, string, unknown]> = [
    ['handshake', (c) => c.handshake(), 'GET', '/v1', undefined],
    ['seat', (c) => c.seat('r:1', 's@1', { who: WHO, handle: 'alice', tags: { context: 'kids' } }), 'PUT', '/v1/rooms/r%3A1/seats/s%401', { who: WHO, handle: 'alice', tags: { context: 'kids' } }],
    ['unseat', (c) => c.unseat('r', 's'), 'DELETE', '/v1/rooms/r/seats/s', undefined],
    ['closeRoom', (c) => c.closeRoom('r'), 'DELETE', '/v1/rooms/r', undefined],
    ['line', (c) => c.line('r', 's', 'hello'), 'POST', '/v1/rooms/r/seats/s/lines', { text: 'hello' }],
    ['phrase', (c) => c.phrase('r', 's', 'gg'), 'POST', '/v1/rooms/r/seats/s/phrases', { phraseId: 'gg' }],
    ['mutes', (c) => c.mutes('r', 's'), 'GET', '/v1/rooms/r/seats/s/mutes', undefined],
    ['mute', (c) => c.mute('r', 's', 't'), 'PUT', '/v1/rooms/r/seats/s/mutes/t', undefined],
    ['block', (c) => c.mute('r', 's', 't', 'block'), 'PUT', '/v1/rooms/r/seats/s/mutes/t', { kind: 'block' }],
    ['unmute', (c) => c.unmute('r', 's', 't'), 'DELETE', '/v1/rooms/r/seats/s/mutes/t', undefined],
    ['report', (c) => c.report('r', 's', { target: 't', lineId: 'l1', reason: 'harassment', note: 'n', entity: { kind: 'clan', ref: 'c1', label: 'x' } }), 'POST', '/v1/rooms/r/seats/s/reports', { target: 't', lineId: 'l1', reason: 'harassment', note: 'n', entity: { kind: 'clan', ref: 'c1', label: 'x' } }],
    ['pendingNotices', (c) => c.pendingNotices(WHO), 'POST', '/v1/notices/pending', { who: WHO }],
    ['ack', (c) => c.ack('n1', WHO), 'POST', '/v1/notices/n1/ack', { who: WHO }],
    ['record', (c) => c.record(WHO), 'POST', '/v1/record', { who: WHO }],
    ['restriction', (c) => c.restriction(WHO, { roomId: 'r', seatId: 's' }), 'POST', '/v1/restriction', { who: WHO, roomId: 'r', seatId: 's' }],
    ['checkName', (c) => c.checkName('Plenk', { kind: 'entity', who: WHO }), 'POST', '/v1/names/check', { name: 'Plenk', kind: 'entity', who: WHO }],
    ['checkDoor', (c) => c.checkDoor('join', WHO), 'POST', '/v1/doors/check', { kind: 'join', who: WHO }],
    ['blocksBetween', (c) => c.blocksBetween(WHO, [{ clientKey: 'other-key-0002' }]), 'POST', '/v1/blocks/between', { who: WHO, others: [{ clientKey: 'other-key-0002' }] }],
  ];

  it.each(cases)('%s', async (_name, call, method, path, body) => {
    const { client, sent } = scripted([json({ ok: true })]);
    await call(client);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method, url: `https://svc.test${path}` });
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${KEY_A}`);
    expect(sent[0]?.body).toEqual(body);
    if (body !== undefined) expect(sent[0]?.headers['content-type']).toMatch(/^application\/json/);
  });

  it('the base URL may end in a slash or not, and an id with a slash or a space is encoded into one path segment', async () => {
    const { client, sent } = scripted([json({ ok: true })]);
    await client.unseat('a b', 'c/d');
    expect(sent[0]?.url).toBe('https://svc.test/v1/rooms/a%20b/seats/c%2Fd');
  });
});

describe('the Idempotency-Key', () => {
  it('is sent on lines, phrases and reports only, and is different for each call', async () => {
    const { client, sent } = scripted([json({ ok: true })]);
    await client.line('r', 's', 'one');
    await client.line('r', 's', 'two');
    await client.phrase('r', 's', 'gg');
    await client.report('r', 's', { target: 't' });
    await client.seat('r', 's', { who: WHO, handle: 'h' });
    await client.checkName('x');
    const keys = sent.map((s) => s.headers['idempotency-key']);
    expect(keys.slice(0, 4).every((k) => typeof k === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(k))).toBe(true);
    expect(new Set(keys.slice(0, 4)).size).toBe(4);
    expect(keys.slice(4)).toEqual([undefined, undefined]);
  });

  it('is reused across the retries of its own call', async () => {
    const { client, sent } = scripted([json({ error: 'internal' }, 500), new TypeError('network down'), json({ ok: true, line: { id: 'l', text: 'hi' }, hiddenFor: [] })]);
    const answer = await client.line('r', 's', 'hi');
    expect(answer).toMatchObject({ ok: true });
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((s) => s.headers['idempotency-key'])).size).toBe(1);
  });

  it('a generator can be given (a game with its own ids)', async () => {
    const sent: string[] = [];
    const client = createServiceClient({
      baseUrl: 'https://svc.test',
      key: KEY_A,
      idempotencyKey: () => 'my-own-key',
      fetch: (async (_u: string, init: RequestInit) => (sent.push(new Headers(init.headers).get('idempotency-key') ?? ''), json({ ok: true }))) as unknown as typeof fetch,
    });
    await client.line('r', 's', 'x');
    expect(sent).toEqual(['my-own-key']);
  });
});

describe('retries', () => {
  it('a 5xx is retried up to three times with backoff on the fake clock, then thrown', async () => {
    const { client, sent, slept } = scripted([json({ error: 'internal' }, 503)]);
    await expect(client.handshake()).rejects.toMatchObject({ name: 'ServiceError', status: 503 });
    expect(sent).toHaveLength(4);
    expect(slept).toEqual([100, 200, 400]);
  });

  it('a network error is retried the same way and then thrown as a ServiceError with status 0', async () => {
    const { client, sent, slept } = scripted([new TypeError('socket closed')]);
    const err = await client.handshake().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).status).toBe(0);
    expect(sent).toHaveLength(4);
    expect(slept).toHaveLength(3);
  });

  it('a retry that succeeds returns the answer', async () => {
    const { client, sent } = scripted([json({ error: 'internal' }, 500), json({ api: 1, kit: '0.2.0', mode: 'service', processes: 'single', capabilities: {}, warnings: [] })]);
    expect((await client.handshake()).api).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('a 4xx is never retried: 400, 401, 404, 409 and 429 are one call and a ServiceError with the code', async () => {
    for (const [status, code] of [[400, 'invalid_request'], [401, 'unauthorized'], [404, 'not_found'], [409, 'in_progress'], [429, 'rate_limited']] as const) {
      const { client, sent, slept } = scripted([json({ error: code, message: 'fixed' }, status, status === 429 ? { 'retry-after': '3' } : {})]);
      const err = (await client.line('r', 's', 'x').catch((e: unknown) => e)) as ServiceError;
      expect(err, String(status)).toBeInstanceOf(ServiceError);
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(sent, String(status)).toHaveLength(1);
      expect(slept).toEqual([]);
      if (status === 429) expect(err.retryAfterMs).toBe(3000);
    }
  });

  it('the retry count is configurable and zero means one attempt', async () => {
    const sent: number[] = [];
    const client = createServiceClient({ baseUrl: 'https://svc.test', key: KEY_A, retries: 0, sleep: async () => undefined, fetch: (async () => (sent.push(1), json({ error: 'internal' }, 500))) as unknown as typeof fetch });
    await expect(client.handshake()).rejects.toBeInstanceOf(ServiceError);
    expect(sent).toHaveLength(1);
  });

  it('a body that is not JSON (a proxy page) is a ServiceError, not a crash, and its text is not in the message', async () => {
    const { client } = scripted([new Response('<html>secret proxy page</html>', { status: 502 })]);
    const err = (await client.handshake().catch((e: unknown) => e)) as ServiceError;
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.message).not.toContain('secret proxy page');
  });
});

describe('a refusal is an answer', () => {
  it('a refused line is returned, not thrown, with its reason', async () => {
    const { client } = scripted([json({ ok: false, refused: { reason: 'blocked', rule: 1 } })]);
    expect(await client.line('r', 's', 'x')).toEqual({ ok: false, refused: { reason: 'blocked', rule: 1 } });
  });

  it('a refusal reason the client does not know is returned as unknown, keeping the original beside it', async () => {
    const { client } = scripted([json({ ok: false, refused: { reason: 'a_reason_from_a_newer_kit', retryAfterMs: 5 } })]);
    const answer = await client.line('r', 's', 'x');
    expect(answer).toEqual({ ok: false, refused: { reason: 'unknown', rawReason: 'a_reason_from_a_newer_kit', retryAfterMs: 5 } });
  });

  it('a report refusal string the client does not know is unknown too; a known one stays', async () => {
    const { client } = scripted([json({ ok: false, refused: 'rate', remaining: 0 }), json({ ok: false, refused: 'something_new' })]);
    expect(await client.report('r', 's', { target: 't' })).toEqual({ ok: false, refused: 'rate', remaining: 0 });
    expect(await client.report('r', 's', { target: 't' })).toEqual({ ok: false, refused: 'unknown', rawRefused: 'something_new' });
  });

  it('a field the client does not know in an answer is passed on, not dropped (additive changes within v1)', async () => {
    const { client } = scripted([json({ ok: true, line: { id: 'l', text: 'hi', newer: 1 }, hiddenFor: [], extra: true })]);
    expect(await client.line('r', 's', 'hi')).toMatchObject({ ok: true, extra: true });
  });
});

describe('construction', () => {
  it('a missing base URL or key, or a key with a space, is a TypeError that does not repeat the key', () => {
    expect(() => createServiceClient({ baseUrl: '', key: KEY_A })).toThrow(TypeError);
    expect(() => createServiceClient({ baseUrl: 'https://x', key: '' })).toThrow(TypeError);
    expect(() => createServiceClient({ baseUrl: 'https://x', key: 'has a space in it for sure 0123456789' })).toThrow(/key/);
    try {
      createServiceClient({ baseUrl: 'https://x', key: 'bad key with spaces and 0123456789012345' });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('bad key');
    }
  });

  it('no key is in an error message or a ServiceError', async () => {
    const { client } = scripted([json({ error: 'unauthorized', message: 'Authentication is required.' }, 401)]);
    const err = (await client.handshake().catch((e: unknown) => e)) as ServiceError;
    expect(JSON.stringify({ message: err.message, status: err.status, code: err.code })).not.toContain(KEY_A);
  });
});

describe('against the real service over toFetch', () => {
  it('the whole conversation of curl.sh runs and ends in the expected state', async () => {
    const w = await serviceWorld();
    const client = createServiceClient({
      baseUrl: 'http://svc.test',
      key: KEY_A,
      sleep: async () => undefined,
      fetch: (async (url: string, init: RequestInit) => {
        const u = new URL(url);
        return fetchOver(w, u, init);
      }) as unknown as typeof fetch,
    });
    const alice = { clientKey: 'curl-alice-key-0001' };
    const bob = { clientKey: 'curl-bob-key-0002' };

    expect(await client.handshake()).toMatchObject({ api: 1, mode: 'service' });
    expect(await client.seat('arena', 'a', { who: alice, handle: 'alice' })).toEqual({ ok: true, restriction: null });
    expect(await client.seat('arena', 'b', { who: bob, handle: 'bob' })).toEqual({ ok: true, restriction: null });
    const clean = await client.line('arena', 'a', 'good luck, have fun');
    expect(clean).toMatchObject({ ok: true, line: { text: 'good luck, have fun' }, hiddenFor: [] });
    w.advance(2000);
    const slur = await client.line('arena', 'a', 'you zorbak');
    expect(slur).toEqual({ ok: false, refused: { reason: 'blocked', rule: 1 } });
    const lineId = clean.ok ? clean.line.id : '';
    expect(await client.report('arena', 'b', { target: 'a', lineId, reason: 'harassment' })).toMatchObject({ ok: true, remaining: 9 });
    expect(await client.pendingNotices(alice)).toEqual({ notices: [] });
    expect(await client.restriction(alice)).toEqual({ restricted: false, until: null, kind: null });
    expect(await client.checkDoor('join', alice)).toEqual({ ok: true });
    expect(await client.checkName('Plenk the Brave')).toEqual({ ok: true });
    expect(await client.mute('arena', 'b', 'a')).toEqual({ ok: true });
    expect(await client.mutes('arena', 'b')).toEqual({ muted: ['a'], blocked: [] });
    expect(await client.unseat('arena', 'a')).toEqual({ ok: true });
    expect(await client.closeRoom('arena')).toEqual({ ok: true });

    // the state it ends in: one report stored with the evidence, one strike, no seat left
    expect(w.real.reports.list({}).items).toHaveLength(1);
    expect(w.real.blocked.list({ days: 1 })).toHaveLength(1);
    expect(w.real.rooms.list().some((r) => r.roomId === 'arena')).toBe(false);
  });

  it('a wrong key is a ServiceError 401 with the code unauthorized', async () => {
    const w = await serviceWorld();
    const client = createServiceClient({ baseUrl: 'http://svc.test', key: 'wrong-key-0123456789abcdef0123456789', sleep: async () => undefined, fetch: ((url: string, init: RequestInit) => fetchOver(w, new URL(url), init)) as unknown as typeof fetch });
    await expect(client.handshake()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });
});

/** The service world's `toFetch` handler, called as a `fetch` would be. */
async function fetchOver(w: Awaited<ReturnType<typeof serviceWorld>>, url: URL, init: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const res = await w.fetchJson(String(init.method), url.pathname.replace(/^\/v1/, ''), init.body === undefined ? undefined : JSON.parse(String(init.body)), headers);
  return new Response(res.body === undefined ? null : JSON.stringify(res.body), { status: res.status, headers: res.headers });
}
