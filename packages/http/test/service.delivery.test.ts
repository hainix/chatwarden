import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NoticeDelivery } from '@chatwarden/core';
import * as http from '@chatwarden/http';
import { createDeliveryWebhook } from '../src/service/deliveryWebhook.js';
import type { DeliveryWebhookOptions } from '../src/service/deliveryWebhook.js';

// The delivery webhook (0.2.1): the kit hands a sanction or an appeal outcome to `notices.deliver`; this posts it, signed, to the game's own receiver. The signature is over the body alone;
// `x-chatwarden-delivery` is the notice id (the same on every retry, so a receiver deduplicates); retries wait 1, 3 and 6 minutes; the log holds classes only. All time is a fake: the
// timers are injected and run by the test.

const SECRET = 's'.repeat(40);
const URL_OK = 'https://game.example/hooks/notices';
const MIN = 60_000;

/** A delivery as the kit hands it. The strings below are seeded: none of them may reach a log. */
const delivery = (over: Partial<Record<string, unknown>> = {}): NoticeDelivery =>
  ({
    noticeId: 'notice-0001',
    kind: 'sanction',
    to: { accountId: 'acct-seeded-0001' },
    locale: 'en',
    subject: 'You have been banned SEEDED-SUBJECT',
    text: 'Your chat is off. SEEDED-TEXT https://game.example/appeal?t=SEEDED-LINK',
    html: '<p>SEEDED-HTML</p>',
    appealUrl: 'https://game.example/appeal?t=SEEDED-LINK',
    sanction: { kind: 'chat', until: null, rule: 2, source: 'moderator', automated: false },
    ...over,
  }) as unknown as NoticeDelivery;
const SEEDED = ['acct-seeded-0001', 'SEEDED-SUBJECT', 'SEEDED-TEXT', 'SEEDED-LINK', 'SEEDED-HTML', SECRET, URL_OK, 'game.example'];

/** A fake clock and timers: `run(ms)` moves the clock and fires every timer due, in order. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: unknown): void => void timers.delete(id as number),
    /** Advance by `ms`, firing what falls due; a firing may arm another. */
    async run(ms: number): Promise<void> {
      const target = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry;
        if (due === undefined) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await flush();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: string | undefined;
  hasSignal: boolean;
}
type Reply = number | Error | 'hang' | { status: number; retryAfter?: string };

/** A fake fetch: each call takes the next scripted reply (the last repeats). */
function fakeFetch(script: Reply[]) {
  const sent: Sent[] = [];
  const fn = ((url: string, init: RequestInit) => {
    const reply = script[Math.min(sent.length, script.length - 1)] as Reply;
    sent.push({
      url: String(url),
      method: String(init.method),
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: String(init.body),
      redirect: init.redirect,
      hasSignal: init.signal instanceof AbortSignal,
    });
    if (reply instanceof Error) return Promise.reject(reply);
    if (reply === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted SEEDED-TEXT'), { name: 'AbortError' })));
      });
    }
    const status = typeof reply === 'number' ? reply : reply.status;
    return Promise.resolve(new Response(null, { status: status === 204 || status === 304 ? status : status, headers: typeof reply === 'object' && 'retryAfter' in reply && reply.retryAfter !== undefined ? { 'retry-after': reply.retryAfter } : {} }));
  }) as unknown as typeof fetch;
  return { fn, sent };
}

type Logged = Array<[string, Record<string, unknown> | undefined]>;
function make(script: Reply[], over: Partial<DeliveryWebhookOptions> = {}) {
  const timers = fakeTimers();
  const { fn, sent } = fakeFetch(script);
  const logged: Logged = [];
  const hook = createDeliveryWebhook({
    url: URL_OK,
    secret: SECRET,
    fetch: fn,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    logger: { warn: (event, detail) => void logged.push([event, detail]) },
    ...over,
  });
  return { hook, timers, sent, logged };
}

describe('the request', () => {
  it('is a POST of the delivery as json, with content-type json, no redirect following, and an abort signal', async () => {
    const { hook, sent } = make([200]);
    const d = delivery();
    hook.deliver(d);
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: URL_OK, method: 'POST', redirect: 'manual', hasSignal: true });
    expect(sent[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent[0]?.body as string)).toEqual(JSON.parse(JSON.stringify(d)));
  });

  it('the signature is sha256= plus the HMAC computed independently over the exact body bytes sent; the delivery header is the notice id', async () => {
    const { hook, sent } = make([200]);
    const d = delivery({ noticeId: 'notice-sig-9' });
    hook.deliver(d);
    await flush();
    const s = sent[0] as Sent;
    const expected = `sha256=${createHmac('sha256', SECRET).update(s.body, 'utf8').digest('hex')}`;
    expect(s.headers['x-chatwarden-signature']).toBe(expected);
    expect(s.headers['x-chatwarden-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(s.headers['x-chatwarden-delivery']).toBe('notice-sig-9');
    // the body is the delivery as given (fixed when deliver was called)
    expect(s.body).toBe(JSON.stringify(d));
    // no timestamp header: the signature covers the body alone
    expect(Object.keys(s.headers)).not.toContain('x-chatwarden-timestamp');
  });

  it('another secret gives another signature, and another body too (control)', async () => {
    const a = make([200]);
    const b = make([200], { secret: 'z'.repeat(40) });
    a.hook.deliver(delivery());
    b.hook.deliver(delivery());
    await flush();
    expect(a.sent[0]?.headers['x-chatwarden-signature']).not.toBe(b.sent[0]?.headers['x-chatwarden-signature']);
  });

  it('the body is fixed when deliver is called: changing the object afterwards changes nothing', async () => {
    const { hook, sent } = make([500, 200]);
    const d = delivery() as unknown as { subject: string };
    hook.deliver(d as never);
    d.subject = 'CHANGED';
    await flush();
    expect(sent[0]?.body).not.toContain('CHANGED');
  });
});

describe('delivery and retries', () => {
  it('a 2xx is sent once and nothing is left waiting', async () => {
    for (const status of [200, 201, 202, 204]) {
      const { hook, sent, timers, logged } = make([status]);
      hook.deliver(delivery());
      await flush();
      await timers.run(60 * MIN);
      expect(sent, String(status)).toHaveLength(1);
      expect(timers.pending()).toBe(0);
      expect(logged).toEqual([]);
    }
  });

  it('a 500 retries after 1, then 3, then 6 minutes (4 attempts in all), then drops with one log; the headers repeat on each attempt', async () => {
    const { hook, sent, timers, logged } = make([500]);
    hook.deliver(delivery({ noticeId: 'notice-retry' }));
    await flush();
    expect(sent).toHaveLength(1);
    await timers.run(MIN - 1);
    expect(sent).toHaveLength(1);
    await timers.run(1);
    expect(sent).toHaveLength(2);
    await timers.run(3 * MIN - 1);
    expect(sent).toHaveLength(2);
    await timers.run(1);
    expect(sent).toHaveLength(3);
    await timers.run(6 * MIN - 1);
    expect(sent).toHaveLength(3);
    await timers.run(1);
    expect(sent).toHaveLength(4);
    await timers.run(60 * MIN);
    expect(sent).toHaveLength(4);
    expect(timers.pending()).toBe(0);
    // the same bytes, signature and delivery id each time
    for (const s of sent) {
      expect(s.body).toBe(sent[0]?.body);
      expect(s.headers['x-chatwarden-signature']).toBe(sent[0]?.headers['x-chatwarden-signature']);
      expect(s.headers['x-chatwarden-delivery']).toBe('notice-retry');
    }
    expect(logged).toEqual([['chatwarden.delivery_webhook_failed', { status: 500, attempts: 4 }]]);
  });

  it('a success on a retry stops the chain and logs nothing', async () => {
    const { hook, sent, timers, logged } = make([503, 502, 200]);
    hook.deliver(delivery());
    await flush();
    await timers.run(MIN);
    await timers.run(3 * MIN);
    expect(sent).toHaveLength(3);
    await timers.run(60 * MIN);
    expect(sent).toHaveLength(3);
    expect(logged).toEqual([]);
  });

  it('a thrown fetch and a timeout are retried; the log says the error class, not the message', async () => {
    const boom = Object.assign(new TypeError('connect failed to game.example SEEDED-TEXT'), {});
    const { hook, sent, timers, logged } = make([boom]);
    hook.deliver(delivery());
    await flush();
    await timers.run(MIN);
    await timers.run(3 * MIN);
    await timers.run(6 * MIN);
    expect(sent).toHaveLength(4);
    expect(logged).toEqual([['chatwarden.delivery_webhook_failed', { error: 'TypeError', attempts: 4 }]]);
  });

  it('an attempt that hangs is aborted after 10 seconds and retried', async () => {
    const { hook, sent, timers, logged } = make(['hang', 200]);
    hook.deliver(delivery());
    await flush();
    expect(sent).toHaveLength(1);
    await timers.run(10_000);
    await flush();
    await timers.run(MIN);
    expect(sent).toHaveLength(2);
    await timers.run(10 * MIN);
    expect(logged).toEqual([]);
  });

  it('408 and 429 are retried; a 429 retry-after is not honoured (the schedule is the schedule)', async () => {
    for (const reply of [408, { status: 429, retryAfter: '3600' }] as Reply[]) {
      const { hook, sent, timers } = make([reply, 200]);
      hook.deliver(delivery());
      await flush();
      expect(sent).toHaveLength(1);
      await timers.run(MIN);
      expect(sent).toHaveLength(2);
    }
  });

  it('a 400, a 401, a 404, a 410 and a 302 are final after one attempt, each logged once with the status', async () => {
    for (const status of [400, 401, 404, 410, 301, 302, 307]) {
      const { hook, sent, timers, logged } = make([status]);
      hook.deliver(delivery());
      await flush();
      await timers.run(60 * MIN);
      expect(sent, String(status)).toHaveLength(1);
      expect(logged, String(status)).toEqual([['chatwarden.delivery_webhook_failed', { status, attempts: 1 }]]);
    }
  });

  it('every 5xx is retried', async () => {
    for (const status of [500, 502, 503, 504, 599]) {
      const { hook, sent, timers } = make([status, 200]);
      hook.deliver(delivery());
      await flush();
      await timers.run(MIN);
      expect(sent, String(status)).toHaveLength(2);
    }
  });

  it('a custom schedule is used: [5, 10] makes three attempts', async () => {
    const { hook, sent, timers, logged } = make([500], { retryDelaysMs: [5_000, 10_000] });
    hook.deliver(delivery());
    await flush();
    await timers.run(5_000);
    await timers.run(10_000);
    await timers.run(60 * MIN);
    expect(sent).toHaveLength(3);
    expect(logged).toEqual([['chatwarden.delivery_webhook_failed', { status: 500, attempts: 3 }]]);
  });

  it('each delivery has its own chain: two deliveries retry independently with their own ids', async () => {
    const { hook, sent, timers } = make([500]);
    hook.deliver(delivery({ noticeId: 'n-a' }));
    hook.deliver(delivery({ noticeId: 'n-b' }));
    await flush();
    expect(sent.map((s) => s.headers['x-chatwarden-delivery']).sort()).toEqual(['n-a', 'n-b']);
    await timers.run(MIN);
    expect(sent).toHaveLength(4);
    expect(sent.filter((s) => s.headers['x-chatwarden-delivery'] === 'n-a')).toHaveLength(2);
  });
});

describe('the log holds classes only', () => {
  it('no body, url, account id, text, link or secret in any logged value, on every path', async () => {
    const paths: Array<[string, Reply[]]> = [
      ['final 4xx', [400]],
      ['dropped after retries', [500]],
      ['network error', [new TypeError('SEEDED-TEXT acct-seeded-0001 game.example')]],
    ];
    for (const [name, script] of paths) {
      const { hook, timers, logged } = make(script);
      hook.deliver(delivery());
      await flush();
      await timers.run(60 * MIN);
      expect(logged.length, name).toBeGreaterThan(0);
      const text = JSON.stringify(logged);
      for (const secret of SEEDED) expect(text, `${name}: ${secret}`).not.toContain(secret);
      for (const [, detail] of logged) for (const v of Object.values(detail ?? {})) expect(['string', 'number', 'boolean']).toContain(typeof v);
    }
  });

  it('a creation error and a dispose log hold no value either', async () => {
    const { hook, logged } = make([500]);
    hook.deliver(delivery());
    await flush();
    hook.dispose();
    expect(JSON.stringify(logged)).not.toMatch(/SEEDED|game\.example/);
  });
});

describe('creation errors', () => {
  const make2 = (o: Partial<DeliveryWebhookOptions>) => createDeliveryWebhook({ url: URL_OK, secret: SECRET, ...o });

  it('http to a non-local host, credentials in the url, a non-url and a short secret each throw RangeError without echoing the value', () => {
    const cases: Array<[Partial<DeliveryWebhookOptions>, RegExp]> = [
      [{ url: 'http://game.example/hook' }, /delivery url/],
      [{ url: 'https://user:pw-SEEDED@game.example/hook' }, /delivery url/],
      [{ url: 'https://:pw-SEEDED@game.example/hook' }, /delivery url/],
      [{ url: 'ftp://game.example/hook' }, /delivery url/],
      [{ url: 'not a url' }, /delivery url/],
      [{ url: '' }, /delivery url/],
      [{ url: 5 as never }, /delivery url/],
      [{ secret: 'short-SEEDED' }, /delivery secret/],
      [{ secret: 'x'.repeat(31) }, /delivery secret/],
      [{ secret: 5 as never }, /delivery secret/],
    ];
    for (const [over, pattern] of cases) {
      let message = '';
      try {
        make2(over);
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
        message = (err as Error).message;
      }
      expect(message, JSON.stringify(over)).toMatch(pattern);
      expect(message).not.toContain('SEEDED');
      expect(message).not.toContain('game.example');
    }
  });

  it('https anywhere, and http for localhost and 127.0.0.1 only, are accepted; 32 characters is enough', () => {
    for (const url of ['https://game.example/hook', 'https://game.example:8443/a?b=c', 'http://localhost:9000/hook', 'http://127.0.0.1/hook']) expect(() => make2({ url }), url).not.toThrow();
    expect(() => make2({ secret: 'x'.repeat(32) })).not.toThrow();
    for (const url of ['http://localhost.evil.example/hook', 'http://127.0.0.2/hook', 'http://[::1]/hook']) expect(() => make2({ url }), url).toThrow(RangeError);
  });

  it('a bad retry schedule is a RangeError', () => {
    for (const retryDelaysMs of [[-1], [0], [1.5], ['x'], [Number.NaN], 5, 'a'] as unknown[]) expect(() => make2({ retryDelaysMs: retryDelaysMs as never }), JSON.stringify(retryDelaysMs)).toThrow(RangeError);
    expect(() => make2({ retryDelaysMs: [] })).not.toThrow();
  });
});

describe('dispose, the bound and the hook contract', () => {
  it('dispose clears every timer, aborts nothing it cannot, logs how many it dropped; later deliver calls do nothing', async () => {
    const { hook, sent, timers, logged } = make([500]);
    hook.deliver(delivery({ noticeId: 'n-a' }));
    hook.deliver(delivery({ noticeId: 'n-b' }));
    await flush();
    expect(timers.pending()).toBe(2);
    hook.dispose();
    expect(timers.pending()).toBe(0);
    expect(logged).toEqual([['chatwarden.delivery_webhook_dropped', { count: 2 }]]);
    hook.deliver(delivery({ noticeId: 'n-c' }));
    await flush();
    await timers.run(60 * MIN);
    expect(sent).toHaveLength(2);
    hook.dispose();
    expect(logged).toHaveLength(1);
  });

  it('1001 waiting deliveries drop the oldest, counted in one throttled log line', async () => {
    const { hook, timers, logged } = make([500]);
    for (let i = 0; i < 1000; i++) hook.deliver(delivery({ noticeId: `n-${i}` }));
    await flush();
    expect(timers.pending()).toBe(1000);
    expect(logged).toEqual([]);
    hook.deliver(delivery({ noticeId: 'n-1000' }));
    expect(logged).toEqual([['chatwarden.delivery_webhook_dropped', { count: 1 }]]);
    expect(timers.pending()).toBe(1000);
    // more drops inside the minute are counted, not logged each time
    for (let i = 0; i < 5; i++) hook.deliver(delivery({ noticeId: `x-${i}` }));
    expect(logged).toHaveLength(1);
  });

  it('deliver never throws and returns undefined, whatever it is given; a hook that looks async cannot reject', async () => {
    const { hook, sent } = make([200]);
    const weird: unknown[] = [null, undefined, 5, 'text', {}, { noticeId: 5 }, { noticeId: '' }, { noticeId: 'x'.repeat(100) }, [], () => 1, { get noticeId(): string { throw new Error('getter'); } }];
    for (const d of weird) {
      let out: unknown = 'unset';
      expect(() => {
        out = hook.deliver(d as never);
      }, String(d)).not.toThrow();
      expect(out).toBeUndefined();
    }
    await flush();
    // a circular body cannot be serialised: dropped quietly
    const circular: Record<string, unknown> = { noticeId: 'n-circ' };
    circular.self = circular;
    expect(() => hook.deliver(circular as never)).not.toThrow();
    expect(sent.length).toBeLessThanOrEqual(1);
  });

  it('a fetch that throws synchronously does not escape', async () => {
    const timers = fakeTimers();
    const logged: Logged = [];
    const hook = createDeliveryWebhook({
      url: URL_OK,
      secret: SECRET,
      fetch: (() => {
        throw new Error('sync boom SEEDED-TEXT');
      }) as unknown as typeof fetch,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      logger: { warn: (event, detail) => void logged.push([event, detail]) },
    });
    expect(() => hook.deliver(delivery())).not.toThrow();
    await flush();
    await timers.run(MIN);
    expect(JSON.stringify(logged)).not.toContain('SEEDED');
  });

  it('works with the real timers and the global fetch defaults (nothing injected): deliver returns at once', () => {
    const hook = createDeliveryWebhook({ url: 'http://127.0.0.1:1/hook', secret: SECRET, retryDelaysMs: [], logger: { warn: () => undefined } });
    expect(hook.deliver(delivery())).toBeUndefined();
    hook.dispose();
  });
});

describe('the package surface', () => {
  it('createDeliveryWebhook is exported from @chatwarden/http (the Node adapters), not from the browser-safe service index', async () => {
    expect(http.createDeliveryWebhook).toBe(createDeliveryWebhook);
    const service = (await import('../src/service/index.js')) as Record<string, unknown>;
    expect(service.createDeliveryWebhook).toBeUndefined();
  });
});
