import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chatwarden, KitEvent } from '@chatwarden/core';
import {
  ATTEMPT_TIMEOUT_MS,
  MAX_RETRIES,
  QUEUE_MAX,
  webhooksOut,
} from '../../src/webhooks/out.js';
import type { WebhookEndpoint } from '../../src/webhooks/out.js';
import { DELIVERY_HEADER, ReplayCache, SIGNATURE_HEADER, TIMESTAMP_HEADER, sign, verify } from '../../src/webhooks/sign.js';
import { world } from '../world.js';
import type { Logged } from '../world.js';

const NOW = 1_800_000_000_000;
const SECRET = 'outgoing-secret-at-least-32-characters-long';
const SECRET_B = 'second-endpoint-secret-also-32-characters-ok';
const URL_A = 'https://hooks.example.test/chatwarden/ingest?token=URL-TOKEN-XYZ';
const URL_B = 'https://other.example.test/hook';
const CHAT_LINE = 'CHAT-LINE-TEXT hello there';
const NOTE = 'REPORTER-NOTE-TEXT';

afterEach(() => {
  vi.useRealTimers();
});

const clock = { now: () => Date.now() };

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string>; body: string; signal: AbortSignal };
}
type Step = number | Error | 'hang' | { status: number; headers?: Record<string, string> } | 'throw-sync';

/** A fake fetch. `plan(n)` decides call n (0-based): a status, an Error to reject with, 'hang' (until aborted) or a status with headers. */
function fakeFetch(plan: Step[] | ((n: number) => Step) = () => 200) {
  const calls: Call[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(url), init: init as Call['init'] };
    const n = calls.length;
    calls.push(call);
    const step = typeof plan === 'function' ? plan(n) : (plan[Math.min(n, plan.length - 1)] as Step);
    if (step === 'throw-sync') throw new TypeError('sync boom');
    if (step === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        call.init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    if (step instanceof Error) return Promise.reject(step);
    const { status, headers } = typeof step === 'number' ? { status: step, headers: undefined } : step;
    return Promise.resolve(new Response(null, { status, ...(headers === undefined ? {} : { headers }) }));
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const bodyOf = (c: Call) => JSON.parse(c.init.body) as { id: string; type: string; at: number; data: Record<string, unknown> };
const stamps = (c: Call) => c.init.headers[TIMESTAMP_HEADER] as string;

/** A fake kit with only what webhooksOut uses, so a test can raise any event, any number of times. */
function fakeKit(get: Chatwarden['reports']['get'] = () => null) {
  const listeners = new Set<{ type: string; fn: (e: KitEvent) => unknown }>();
  const kit = {
    on: (type: string, fn: (e: KitEvent) => unknown) => {
      const entry = { type, fn };
      listeners.add(entry);
      return () => void listeners.delete(entry);
    },
    reports: { get },
  } as unknown as Pick<Chatwarden, 'on' | 'reports'>;
  return {
    kit,
    listeners,
    emit(e: KitEvent) {
      for (const l of [...listeners]) if (l.type === '*' || l.type === e.type) void l.fn(e);
    },
  };
}
const closed = (n: number): KitEvent => ({ type: 'report.closed', reportId: `r${n}`, verdict: 'upheld', at: NOW + n });
const created = (id = 'r1'): KitEvent => ({ type: 'report.created', reportId: id, createdAt: NOW, category: 'harassment', roomTags: { mode: 'ranked' } });

const endpointA = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({ url: URL_A, secret: SECRET, events: '*', ...over });

describe('construction: endpoints are validated once', () => {
  const kit = () => fakeKit().kit;
  const build = (e: Partial<WebhookEndpoint>) => () => webhooksOut(kit(), { endpoints: [endpointA(e)], fetch: fakeFetch().fetch });

  it.each([
    ['https', 'https://hooks.example.test/x'],
    ['https with a port and query', 'https://hooks.example.test:8443/x?y=1'],
    ['http://localhost', 'http://localhost/x'],
    ['http://localhost with a port', 'http://localhost:3000/hook'],
    ['http://127.0.0.1', 'http://127.0.0.1:8080/hook'],
  ])('accepts %s', (_n, url) => {
    expect(build({ url })).not.toThrow();
  });

  it.each([
    ['plain http', 'http://hooks.example.test/x'],
    ['http on a lookalike localhost', 'http://localhost.evil.test/x'],
    ['http on a localhost subdomain', 'http://a.localhost/x'],
    ['http on another loopback form', 'http://127.0.0.2/x'],
    ['http on ::1', 'http://[::1]/x'],
    ['http on 0.0.0.0', 'http://0.0.0.0/x'],
    ['ftp', 'ftp://hooks.example.test/x'],
    ['file', 'file:///etc/passwd'],
    ['a scheme-less host', 'hooks.example.test/x'],
    ['garbage', 'not a url'],
    ['empty', ''],
    ['credentials in the url', 'https://user:pass@hooks.example.test/x'],
    ['a username only', 'https://user@hooks.example.test/x'],
    ['javascript:', 'javascript:alert(1)'],
  ])('refuses %s with a RangeError that does not echo the url', (_n, url) => {
    let caught: unknown;
    try {
      build({ url })();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RangeError);
    if (url !== '') expect(String((caught as Error).message)).not.toContain(url);
  });

  it('refuses a non-string url', () => {
    expect(build({ url: 5 as never })).toThrow(RangeError);
    expect(build({ url: undefined as never })).toThrow(RangeError);
  });

  it('refuses a secret under 32 characters, never echoing it', () => {
    const short = 'y'.repeat(31);
    let caught: unknown;
    try {
      build({ secret: short })();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect(String((caught as Error).message)).not.toContain(short);
    expect(build({ secret: 'y'.repeat(32) })).not.toThrow();
    expect(build({ secret: undefined as never })).toThrow(RangeError);
  });

  it('refuses unknown events, an empty list, a non-list, and an empty or missing endpoint list', () => {
    expect(build({ events: ['report.created', 'nope' as never] })).toThrow(RangeError);
    expect(build({ events: [] })).toThrow(RangeError);
    expect(build({ events: 'report.created' as never })).toThrow(RangeError);
    expect(() => webhooksOut(kit(), { endpoints: [] })).toThrow(RangeError);
    expect(() => webhooksOut(kit(), {} as never)).toThrow(RangeError);
    expect(() => webhooksOut(kit(), { endpoints: 'x' as never })).toThrow(RangeError);
  });

  it('subscribes nothing when construction fails (no half-built state)', () => {
    const k = fakeKit();
    expect(() =>
      webhooksOut(k.kit, { endpoints: [endpointA(), endpointA({ url: 'http://bad.example.test/x' })], fetch: fakeFetch().fetch }),
    ).toThrow(RangeError);
    expect(k.listeners.size).toBe(0);
  });

  it('exposes the documented limits', () => {
    expect(MAX_RETRIES).toBe(5);
    expect(QUEUE_MAX).toBe(1000);
    expect(ATTEMPT_TIMEOUT_MS).toBe(10_000);
  });
});

describe('one delivery', () => {
  it('POSTs { id, type, at, data } as JSON, signed, with a delivery id header', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpointA()], fetch: f.fetch, clock });
    k.emit(created());
    await tick(0);

    expect(f.calls).toHaveLength(1);
    const call = f.calls[0] as Call;
    expect(call.url).toBe(URL_A);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['content-type']).toBe('application/json');
    const payload = bodyOf(call);
    expect(Object.keys(payload).sort()).toEqual(['at', 'data', 'id', 'type']);
    expect(payload.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(payload.type).toBe('report.created');
    expect(payload.at).toBe(NOW);
    expect(payload.data).toEqual(created());
    expect(call.init.headers[DELIVERY_HEADER]).toBe(payload.id);
    expect(stamps(call)).toBe(String(NOW / 1000));
    expect(call.init.headers[SIGNATURE_HEADER]).toBe(sign(SECRET, NOW / 1000, call.init.body));
    // A receiver using the same primitives accepts it, once.
    const seen = new ReplayCache();
    expect(verify(SECRET, call.init.headers, call.init.body, NOW, seen)).toBe(true);
    expect(verify(SECRET, call.init.headers, call.init.body, NOW, seen)).toBe(false);
    // No redirect is followed, and the attempt can be aborted.
    expect(call.init.redirect).toBe('manual');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a different delivery gets a different id', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpointA()], fetch: f.fetch, clock });
    k.emit(closed(1));
    k.emit(closed(2));
    await tick(0);
    expect(f.calls).toHaveLength(2);
    expect(bodyOf(f.calls[0] as Call).id).not.toBe(bodyOf(f.calls[1] as Call).id);
  });

  it('a 2xx is a success: no retry, no log', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    for (const status of [200, 201, 202, 204]) {
      const k = fakeKit();
      const f = fakeFetch(() => status);
      const logged: Logged = [];
      webhooksOut(k.kit, { endpoints: [endpointA()], fetch: f.fetch, clock, logger: { warn: (e, d) => void logged.push([e, d]) } });
      k.emit(closed(1));
      await tick(120_000);
      expect(f.calls).toHaveLength(1);
      expect(logged).toEqual([]);
    }
  });

  it('works end to end on the real kit: a stored report raises report.created, delivered signed', async () => {
    const w = await world();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fakeFetch();
    const out = webhooksOut(w.cw, { endpoints: [endpointA({ events: ['report.created'] })], fetch: f.fetch, clock });
    w.cw.rooms.seat('room-1', 'a', { clientKey: 'key-aaaaaaaaaaaaaaaa-1', ip: '198.51.100.1' }, 'Alice');
    w.cw.rooms.seat('room-1', 'b', { clientKey: 'key-bbbbbbbbbbbbbbbb-2', ip: '198.51.100.2' }, 'Bob');
    w.cw.chat.accept('room-1', 'a', CHAT_LINE);
    const res = await w.cw.reports.submit({ roomId: 'room-1', reporterSeat: 'b', targetSeat: 'a', category: 'harassment', note: NOTE });
    expect(res.ok).toBe(true);
    await tick(0);
    expect(f.calls).toHaveLength(1);
    const payload = bodyOf(f.calls[0] as Call);
    expect(payload.type).toBe('report.created');
    expect((payload.data as { reportId: string }).reportId).toBe((res as { reportId: string }).reportId);
    // No chat text and no reporter note unless the adopter opted in.
    expect(f.calls[0]?.init.body).not.toContain('CHAT-LINE-TEXT');
    expect(f.calls[0]?.init.body).not.toContain(NOTE);
    expect(payload.data).not.toHaveProperty('excerpt');
    out.dispose();
  });
});

describe('the event filter', () => {
  it('delivers only the listed events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpointA({ events: ['report.closed'] })], fetch: f.fetch, clock });
    k.emit(created());
    k.emit(closed(1));
    k.emit({ type: 'gap.created', groupId: 'g', refCode: 'RC', at: NOW });
    await tick(0);
    expect(f.calls.map((c) => bodyOf(c).type)).toEqual(['report.closed']);
  });

  it("'*' delivers every event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpointA({ events: '*' })], fetch: f.fetch, clock });
    k.emit(created());
    k.emit(closed(1));
    k.emit({ type: 'auto.restricted', groupId: 'g', refCode: 'RC', second: false });
    await tick(0);
    expect(f.calls.map((c) => bodyOf(c).type)).toEqual(['report.created', 'report.closed', 'auto.restricted']);
  });

  it('two endpoints get their own events, each signed with its own secret', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, {
      endpoints: [
        endpointA({ events: ['report.created'] }),
        { url: URL_B, secret: SECRET_B, events: ['report.created', 'report.closed'] },
      ],
      fetch: f.fetch,
      clock,
    });
    k.emit(created());
    k.emit(closed(1));
    await tick(0);
    const toA = f.calls.filter((c) => c.url === URL_A);
    const toB = f.calls.filter((c) => c.url === URL_B);
    expect(toA.map((c) => bodyOf(c).type)).toEqual(['report.created']);
    expect(toB.map((c) => bodyOf(c).type)).toEqual(['report.created', 'report.closed']);
    expect(verify(SECRET, (toA[0] as Call).init.headers, (toA[0] as Call).init.body, NOW, new ReplayCache())).toBe(true);
    expect(verify(SECRET_B, (toA[0] as Call).init.headers, (toA[0] as Call).init.body, NOW, new ReplayCache())).toBe(false);
    expect(verify(SECRET_B, (toB[0] as Call).init.headers, (toB[0] as Call).init.body, NOW, new ReplayCache())).toBe(true);
    // Each endpoint has its own delivery id for the same event.
    expect(bodyOf(toA[0] as Call).id).not.toBe(bodyOf(toB[0] as Call).id);
  });
});

describe('excerpts', () => {
  async function filedReport() {
    const w = await world();
    w.cw.rooms.seat('room-1', 'a', { clientKey: 'key-aaaaaaaaaaaaaaaa-1', ip: '198.51.100.1' }, 'Alice');
    w.cw.rooms.seat('room-1', 'b', { clientKey: 'key-bbbbbbbbbbbbbbbb-2', ip: '198.51.100.2' }, 'Bob');
    return w;
  }
  const submit = (w: Awaited<ReturnType<typeof filedReport>>) =>
    w.cw.reports.submit({ roomId: 'room-1', reporterSeat: 'b', targetSeat: 'a', category: 'harassment', note: NOTE });

  it('includeExcerpts adds the report excerpt to report.created, from the staff report API', async () => {
    const w = await filedReport();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fakeFetch();
    webhooksOut(w.cw, { endpoints: [endpointA({ events: ['report.created'], includeExcerpts: true })], fetch: f.fetch, clock });
    w.cw.chat.accept('room-1', 'a', CHAT_LINE);
    await submit(w);
    await tick(0);
    const payload = bodyOf(f.calls[0] as Call);
    const excerpt = payload.data.excerpt as Array<Record<string, unknown>>;
    expect(excerpt).toHaveLength(1);
    expect(excerpt[0]).toMatchObject({ seatId: 'a', handle: 'Alice', text: CHAT_LINE });
    expect(Object.keys(excerpt[0] as object).sort()).toEqual(['blocked', 'handle', 'lineId', 'seatId', 'text', 'ts']);
    // The reporter's note is never part of it.
    expect(f.calls[0]?.init.body).not.toContain(NOTE);
  });

  it('includeExcerpts false or absent adds nothing', async () => {
    const w = await filedReport();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fakeFetch();
    webhooksOut(w.cw, {
      endpoints: [endpointA({ events: ['report.created'], includeExcerpts: false }), { url: URL_B, secret: SECRET_B, events: ['report.created'] }],
      fetch: f.fetch,
      clock,
    });
    w.cw.chat.accept('room-1', 'a', CHAT_LINE);
    await submit(w);
    await tick(0);
    expect(f.calls).toHaveLength(2);
    for (const c of f.calls) {
      expect(c.init.body).not.toContain('CHAT-LINE-TEXT');
      expect(bodyOf(c).data).not.toHaveProperty('excerpt');
    }
  });

  it('includeExcerpts affects report.created only: no other event type ever carries an excerpt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const get = vi.fn(() => null);
    const k = fakeKit(get);
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpointA({ includeExcerpts: true })], fetch: f.fetch, clock });
    k.emit(closed(1));
    k.emit({ type: 'sanction.revoked', groupId: 'g', refCode: 'RC', at: NOW });
    await tick(0);
    expect(f.calls).toHaveLength(2);
    expect(get).not.toHaveBeenCalled();
    for (const c of f.calls) expect(bodyOf(c).data).not.toHaveProperty('excerpt');
  });

  it('a report that cannot be read still delivers the event, without the excerpt (class logged)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const logged: Logged = [];
    const k = fakeKit(() => {
      throw new TypeError('store exploded with CHAT-LINE-TEXT');
    });
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpointA({ includeExcerpts: true })], fetch: f.fetch, clock, logger: { warn: (e, d) => void logged.push([e, d]) } });
    k.emit(created());
    await tick(0);
    expect(f.calls).toHaveLength(1);
    expect(bodyOf(f.calls[0] as Call).data).not.toHaveProperty('excerpt');
    expect(logged).toEqual([['chatwarden.webhook_excerpt_failed', { error: 'TypeError' }]]);
    expect(JSON.stringify(logged)).not.toContain('CHAT-LINE-TEXT');
  });

  it('an unknown report (null) delivers without an excerpt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit(() => null);
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpointA({ includeExcerpts: true })], fetch: f.fetch, clock });
    k.emit(created());
    await tick(0);
    expect(bodyOf(f.calls[0] as Call).data).not.toHaveProperty('excerpt');
  });
});

describe('retries', () => {
  async function run(plan: Step[] | ((n: number) => Step), over: { random?: () => number; logged?: Logged } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch(plan);
    const logged = over.logged ?? [];
    const out = webhooksOut(k.kit, {
      endpoints: [endpointA()],
      fetch: f.fetch,
      clock,
      random: over.random ?? (() => 0.5),
      logger: { warn: (e, d) => void logged.push([e, d]) },
    });
    return { k, f, out, logged };
  }

  it('a 5xx is retried 5 times with 1, 2, 4, 8, 16 s backoff, then given up: 6 calls in all', async () => {
    const { k, f, logged } = await run(() => 503);
    k.emit(closed(1));
    await tick(0);
    expect(f.calls).toHaveLength(1);
    for (const [i, wait] of [1000, 2000, 4000, 8000, 16_000].entries()) {
      await tick(wait - 1);
      expect(f.calls).toHaveLength(i + 1);
      await tick(1);
      expect(f.calls).toHaveLength(i + 2);
    }
    expect(f.calls).toHaveLength(6);
    await tick(10 * 60_000);
    expect(f.calls).toHaveLength(6);
    expect(logged).toEqual([['chatwarden.webhook_failed', { type: 'report.closed', status: 503, attempts: 6 }]]);
  });

  it('every attempt carries the same delivery id and body, and a fresh, valid, increasing timestamp and signature', async () => {
    const { k, f } = await run(() => 500, { random: () => 0 }); // the shortest backoff, so two attempts can share a second
    k.emit(closed(1));
    await tick(0);
    await tick(800);
    await tick(1600);
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(f.calls.map((c) => c.init.headers[DELIVERY_HEADER]));
    const bodies = new Set(f.calls.map((c) => c.init.body));
    expect(ids.size).toBe(1);
    expect(bodies.size).toBe(1);
    const times = f.calls.map((c) => Number(stamps(c)));
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1] as number);
    const sigs = new Set(f.calls.map((c) => c.init.headers[SIGNATURE_HEADER]));
    expect(sigs.size).toBe(f.calls.length);
    for (const c of f.calls) {
      expect(c.init.headers[SIGNATURE_HEADER]).toBe(sign(SECRET, stamps(c), c.init.body));
    }
  });

  it('jitter is plus or minus 20 percent of the backoff', async () => {
    for (const [random, expected] of [
      [0, 800],
      [0.5, 1000],
      [1, 1200],
    ] as const) {
      const { k, f } = await run(() => 500, { random: () => random });
      k.emit(closed(1));
      await tick(0);
      await tick(expected - 1);
      expect(f.calls).toHaveLength(1);
      await tick(1);
      expect(f.calls).toHaveLength(2);
      vi.clearAllTimers();
    }
  });

  it('jitter with the default random stays inside the band over many tries', async () => {
    const delays: number[] = [];
    for (let i = 0; i < 40; i++) {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const k = fakeKit();
      const f = fakeFetch(() => 500);
      const out = webhooksOut(k.kit, { endpoints: [endpointA()], fetch: f.fetch, clock });
      k.emit(closed(1));
      await tick(0);
      let waited = 0;
      while (f.calls.length < 2 && waited < 2000) {
        await tick(10);
        waited += 10;
      }
      delays.push(waited);
      out.dispose();
    }
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(800);
      expect(d).toBeLessThanOrEqual(1210);
    }
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it('retries after a network error, and gives up with the error class logged (no message)', async () => {
    const { k, f, logged } = await run(() => new TypeError('fetch failed: connect ECONNREFUSED hooks.example.test URL-TOKEN-XYZ'));
    k.emit(closed(1));
    await tick(120_000);
    expect(f.calls).toHaveLength(6);
    expect(logged).toEqual([['chatwarden.webhook_failed', { type: 'report.closed', error: 'TypeError', attempts: 6 }]]);
    expect(JSON.stringify(logged)).not.toContain('URL-TOKEN-XYZ');
    expect(JSON.stringify(logged)).not.toContain('ECONNREFUSED');
  });

  it('a fetch that throws synchronously is a network error', async () => {
    const { k, f, logged } = await run(() => 'throw-sync');
    k.emit(closed(1));
    await tick(120_000);
    expect(f.calls).toHaveLength(6);
    expect(logged[0]?.[1]).toMatchObject({ error: 'TypeError', attempts: 6 });
  });

  it('a timeout aborts the attempt at 10 s and is retried', async () => {
    const { k, f, logged } = await run((n) => (n < 2 ? 'hang' : 200));
    k.emit(closed(1));
    await tick(0);
    expect(f.calls).toHaveLength(1);
    await tick(9999);
    expect((f.calls[0] as Call).init.signal.aborted).toBe(false);
    await tick(1);
    expect((f.calls[0] as Call).init.signal.aborted).toBe(true);
    // 1 s backoff after the timeout, then the second attempt hangs too, then the third succeeds.
    await tick(1000);
    expect(f.calls).toHaveLength(2);
    await tick(ATTEMPT_TIMEOUT_MS + 2000);
    expect(f.calls).toHaveLength(3);
    await tick(120_000);
    expect(f.calls).toHaveLength(3);
    expect(logged).toEqual([]);
  });

  it('gives up after six timeouts and logs the error class', async () => {
    const { k, f, logged } = await run(() => 'hang');
    k.emit(closed(1));
    await tick(10 * 60_000);
    expect(f.calls).toHaveLength(6);
    expect(logged).toEqual([['chatwarden.webhook_failed', { type: 'report.closed', error: 'AbortError', attempts: 6 }]]);
  });

  it('stops retrying once an attempt succeeds', async () => {
    const { k, f, logged } = await run((n) => (n < 2 ? 502 : 200));
    k.emit(closed(1));
    await tick(120_000);
    expect(f.calls).toHaveLength(3);
    expect(logged).toEqual([]);
  });

  it.each([400, 401, 403, 404, 410, 422])('a %i is final: not retried, logged once with the status', async (status) => {
    const { k, f, logged } = await run(() => status);
    k.emit(closed(1));
    await tick(120_000);
    expect(f.calls).toHaveLength(1);
    expect(logged).toEqual([['chatwarden.webhook_failed', { type: 'report.closed', status, attempts: 1 }]]);
  });

  it('a redirect is not followed and not retried', async () => {
    const { k, f, logged } = await run(() => ({ status: 302, headers: { location: 'https://evil.example.test/' } }));
    k.emit(closed(1));
    await tick(120_000);
    expect(f.calls).toHaveLength(1);
    expect(logged).toEqual([['chatwarden.webhook_failed', { type: 'report.closed', status: 302, attempts: 1 }]]);
  });

  it.each([500, 502, 503, 504, 599])('a %i is retried', async (status) => {
    const { k, f } = await run((n) => (n === 0 ? status : 200));
    k.emit(closed(1));
    await tick(1000);
    expect(f.calls).toHaveLength(2);
  });

  describe('429', () => {
    it('honours retry-after in seconds instead of the backoff', async () => {
      const { k, f } = await run((n) => (n === 0 ? { status: 429, headers: { 'retry-after': '5' } } : 200));
      k.emit(closed(1));
      await tick(0);
      await tick(4999);
      expect(f.calls).toHaveLength(1);
      await tick(1);
      expect(f.calls).toHaveLength(2);
    });

    it('caps retry-after at 60 s', async () => {
      const { k, f } = await run((n) => (n === 0 ? { status: 429, headers: { 'retry-after': '3600' } } : 200));
      k.emit(closed(1));
      await tick(0);
      await tick(59_999);
      expect(f.calls).toHaveLength(1);
      await tick(1);
      expect(f.calls).toHaveLength(2);
    });

    it('retry-after: 0 retries at once', async () => {
      const { k, f } = await run((n) => (n === 0 ? { status: 429, headers: { 'retry-after': '0' } } : 200));
      k.emit(closed(1));
      await tick(0);
      expect(f.calls).toHaveLength(2);
    });

    it('accepts an HTTP date for retry-after', async () => {
      const when = new Date(NOW + 7000).toUTCString();
      const { k, f } = await run((n) => (n === 0 ? { status: 429, headers: { 'retry-after': when } } : 200));
      k.emit(closed(1));
      await tick(0);
      await tick(5999);
      expect(f.calls).toHaveLength(1);
      await tick(1100);
      expect(f.calls).toHaveLength(2);
    });

    it.each(['abc', '-5', '1.5', '', '5s'])('an unusable retry-after %j falls back to the backoff', async (value) => {
      const { k, f } = await run((n) => (n === 0 ? { status: 429, headers: { 'retry-after': value } } : 200));
      k.emit(closed(1));
      await tick(0);
      await tick(999);
      expect(f.calls).toHaveLength(1);
      await tick(1);
      expect(f.calls).toHaveLength(2);
    });

    it('a 429 with no retry-after uses the backoff, and uses the whole retry budget', async () => {
      const { k, f, logged } = await run(() => 429);
      k.emit(closed(1));
      await tick(10 * 60_000);
      expect(f.calls).toHaveLength(6);
      expect(logged).toEqual([['chatwarden.webhook_failed', { type: 'report.closed', status: 429, attempts: 6 }]]);
    });

    it('retry-after on a 503 is ignored (only a 429 honours it)', async () => {
      const { k, f } = await run((n) => (n === 0 ? { status: 503, headers: { 'retry-after': '30' } } : 200));
      k.emit(closed(1));
      await tick(1000);
      expect(f.calls).toHaveLength(2);
    });
  });
});

describe('the queue', () => {
  it('delivers one endpoint in order, one at a time: a delivery waits for the one before it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch((n) => (n === 0 ? 500 : 200));
    webhooksOut(k.kit, { endpoints: [endpointA()], fetch: f.fetch, clock, random: () => 0.5 });
    k.emit(closed(1));
    k.emit(closed(2));
    await tick(0);
    expect(f.calls).toHaveLength(1);
    await tick(1000);
    expect(f.calls.map((c) => (bodyOf(c).data as { reportId: string }).reportId)).toEqual(['r1', 'r1', 'r2']);
  });

  it('a failing endpoint never holds up another endpoint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch((n) => (n === 0 ? 'hang' : 200));
    webhooksOut(k.kit, { endpoints: [endpointA(), { url: URL_B, secret: SECRET_B, events: '*' }], fetch: f.fetch, clock });
    k.emit(closed(1));
    await tick(0);
    expect(f.calls.map((c) => c.url).sort()).toEqual([URL_A, URL_B].sort());
    expect(f.calls.some((c) => c.url === URL_B)).toBe(true);
  });

  it('is bounded at 1000 waiting: on overflow the oldest is dropped and logged as a count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: Call[] = [];
    const fetchFn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init as Call['init'] });
      // The first delivery is held open (past the timeout abort is ignored), everything else answers 200.
      return calls.length === 1 ? gate.then(() => new Response(null, { status: 200 })) : Promise.resolve(new Response(null, { status: 200 }));
    };
    const logged: Logged = [];
    webhooksOut(k.kit, { endpoints: [endpointA()], fetch: fetchFn as unknown as typeof fetch, clock, logger: { warn: (e, d) => void logged.push([e, d]) } });
    k.emit(closed(0)); // in flight
    await tick(0);
    expect(calls).toHaveLength(1);
    for (let i = 1; i <= QUEUE_MAX; i++) k.emit(closed(i)); // exactly fills the queue
    expect(logged).toEqual([]);
    k.emit(closed(QUEUE_MAX + 1)); // overflow: closed(1) is dropped
    expect(logged).toEqual([['chatwarden.webhook_dropped', { count: 1 }]]);
    k.emit(closed(QUEUE_MAX + 2)); // overflow again: closed(2) is dropped
    expect(logged).toHaveLength(2);
    expect(logged[1]).toEqual(['chatwarden.webhook_dropped', { count: 1 }]);

    release?.();
    await tick(0);
    for (let i = 0; i < QUEUE_MAX + 5; i++) await tick(0);
    const ids = calls.map((c) => (bodyOf(c).data as { reportId: string }).reportId);
    expect(ids).toHaveLength(1 + QUEUE_MAX);
    expect(ids[0]).toBe('r0');
    expect(ids).not.toContain('r1');
    expect(ids).not.toContain('r2');
    expect(ids[1]).toBe('r3');
    expect(ids.at(-1)).toBe(`r${QUEUE_MAX + 2}`);
  });

  it('the drop log carries a count and nothing else', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const logged: Logged = [];
    const f = fakeFetch(() => 'hang');
    webhooksOut(k.kit, { endpoints: [endpointA()], fetch: f.fetch, clock, logger: { warn: (e, d) => void logged.push([e, d]) } });
    for (let i = 0; i < QUEUE_MAX + 3; i++) k.emit(closed(i));
    await tick(0);
    const drops = logged.filter(([e]) => e === 'chatwarden.webhook_dropped');
    expect(drops).toHaveLength(2);
    for (const [, detail] of drops) expect(Object.keys(detail ?? {})).toEqual(['count']);
    expect(JSON.stringify(logged)).not.toContain('URL-TOKEN-XYZ');
  });
});

describe('dispose', () => {
  it('unsubscribes: later events are not delivered', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch();
    const out = webhooksOut(k.kit, { endpoints: [endpointA(), { url: URL_B, secret: SECRET_B, events: ['report.closed'] }], fetch: f.fetch, clock });
    expect(k.listeners.size).toBeGreaterThan(0);
    out.dispose();
    expect(k.listeners.size).toBe(0);
    k.emit(closed(1));
    await tick(60_000);
    expect(f.calls).toHaveLength(0);
  });

  it('clears the retry timers: nothing is sent after dispose', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch(() => 500);
    const out = webhooksOut(k.kit, { endpoints: [endpointA()], fetch: f.fetch, clock, random: () => 0.5 });
    k.emit(closed(1));
    await tick(0);
    expect(f.calls).toHaveLength(1);
    out.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await tick(10 * 60_000);
    expect(f.calls).toHaveLength(1);
  });

  it('drops the queue and aborts the attempt in flight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch(() => 'hang');
    const logged: Logged = [];
    const out = webhooksOut(k.kit, { endpoints: [endpointA()], fetch: f.fetch, clock, logger: { warn: (e, d) => void logged.push([e, d]) } });
    k.emit(closed(1));
    k.emit(closed(2));
    k.emit(closed(3));
    await tick(0);
    expect(f.calls).toHaveLength(1);
    out.dispose();
    expect((f.calls[0] as Call).init.signal.aborted).toBe(true);
    await tick(10 * 60_000);
    expect(f.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    // The abort caused by dispose is not a delivery failure.
    expect(logged).toEqual([]);
  });

  it('is idempotent', async () => {
    const k = fakeKit();
    const out = webhooksOut(k.kit, { endpoints: [endpointA()], fetch: fakeFetch().fetch, clock });
    expect(() => {
      out.dispose();
      out.dispose();
      out.dispose();
    }).not.toThrow();
    expect(k.listeners.size).toBe(0);
  });
});

describe('what is logged and what is not', () => {
  it('never logs the url, the secret or the body, whatever fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const logged: Logged = [];
    const k = fakeKit();
    const plans: Step[] = [500, 404, new Error(`boom ${URL_A} ${SECRET}`), 'hang'];
    for (const plan of plans) {
      const f = fakeFetch(() => plan);
      const out = webhooksOut(k.kit, { endpoints: [endpointA()], fetch: f.fetch, clock, logger: { warn: (e, d) => void logged.push([e, d]) } });
      k.emit(created('REPORT-ID-IN-BODY'));
      await tick(10 * 60_000);
      out.dispose();
    }
    expect(logged.length).toBeGreaterThan(0);
    const text = JSON.stringify(logged);
    for (const secretish of [URL_A, 'URL-TOKEN-XYZ', 'hooks.example.test', SECRET, 'REPORT-ID-IN-BODY', 'harassment']) {
      expect(text).not.toContain(secretish);
    }
    for (const [event, detail] of logged) {
      expect(event).toMatch(/^chatwarden\.webhook_/);
      for (const key of Object.keys(detail ?? {})) expect(['type', 'status', 'error', 'attempts', 'count']).toContain(key);
    }
  });

  it('a throwing logger never breaks delivery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const k = fakeKit();
    const f = fakeFetch(() => 500);
    webhooksOut(k.kit, {
      endpoints: [endpointA()],
      fetch: f.fetch,
      clock,
      logger: {
        warn: () => {
          throw new Error('logger down');
        },
      },
    });
    k.emit(closed(1));
    await expect(tick(10 * 60_000)).resolves.not.toThrow();
    expect(f.calls).toHaveLength(6);
  });
});
