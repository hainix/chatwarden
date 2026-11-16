import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KitRequest } from '../src/types.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from '../src/webhooks/sign.js';
import { coopWorld } from './coop-world.js';
import type { CoopWorld } from './coop-world.js';

// K5 C5: the optional signal route. A Coop plugin posts the lines of a thread, signed with the kit's own HMAC scheme; the adopter's `read` answers a severity.
// Nothing in the request or the answer identifies a person.

const SECRET = 'snerp-signal-secret-0123456789abcdef';
const UNAUTHORIZED = { status: 401, body: { error: 'unauthorized', message: 'Authentication is required.' } };

afterEach(() => {
  vi.useRealTimers();
});

interface Sig {
  secret?: string;
  /** Unix seconds (default: the world clock). */
  timestamp?: number;
  headers?: Record<string, string | undefined>;
  sendRaw?: string;
}

let n = 0;
/** A request signed as the kit signs (`x-chatwarden-timestamp`, `x-chatwarden-signature`). Each call changes the body a little so no two share a signature. */
const signed = (c: Pick<CoopWorld, 'w'>, body: unknown, o: Sig = {}): KitRequest => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const ts = o.timestamp ?? Math.floor(c.w.clock.now() / 1000);
  const headers: Record<string, string> = { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: sign(o.secret ?? SECRET, ts, raw) };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  return { method: 'POST', path: '/coop/signal', query: {}, headers, body: undefined, rawBody: o.sendRaw ?? raw };
};
const lines = (extra = '') => ({ lines: [{ label: 'reporter', text: `please stop zorbak ${++n}${extra}` }, { label: 'reported', text: 'vlemmo' }] });

type Read = (lines: ReadonlyArray<{ label: string; text: string }>) => number | Promise<number>;
const world = async (read: Read, over: Record<string, unknown> = {}, signalOver: Record<string, unknown> = {}) => {
  const calls: Array<ReadonlyArray<{ label: string; text: string }>> = [];
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const c = await coopWorld({
    options: {
      signal: { secret: SECRET, read: (l: ReadonlyArray<{ label: string; text: string }>) => (calls.push(l), read(l)), ...signalOver },
      schedule: (run: () => void, ms: number) => {
        const t = { run, ms, cancelled: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
      ...over,
    },
  });
  return { c, calls, timers };
};

describe('the signal route', () => {
  it('a signed request returns the severity, and read gets the labelled lines', async () => {
    const { c, calls } = await world(() => 42);
    const body = lines();
    const res = await c.send(signed(c, body));
    expect(res).toEqual({ status: 200, body: { severity: 42 } });
    expect(calls).toEqual([body.lines]);
    c.adapter.dispose();
  });

  it('the severity is a finite number clamped to 0..100; read may be sync or async', async () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [55.5, 55.5],
      [100, 100],
      [150, 100],
      [-20, 0],
      [Number.MAX_VALUE, 100],
    ];
    for (const [given, expected] of cases) {
      for (const make of [(v: number) => v, (v: number) => Promise.resolve(v)]) {
        const { c } = await world(() => make(given));
        expect((await c.send(signed(c, lines()))).body, String(given)).toEqual({ severity: expected });
        c.adapter.dispose();
      }
    }
  });

  it('unsigned, stale, future, replayed, wrong-secret and malformed requests are the same 401, and read never runs', async () => {
    const { c, calls } = await world(() => 1);
    const body = lines();
    const now = Math.floor(c.w.clock.now() / 1000);
    const attempts: KitRequest[] = [
      signed(c, body, { headers: { [SIGNATURE_HEADER]: undefined } }),
      signed(c, body, { headers: { [TIMESTAMP_HEADER]: undefined } }),
      signed(c, body, { timestamp: now - 301 }),
      signed(c, body, { timestamp: now + 301 }),
      signed(c, body, { secret: 'a-completely-different-secret-0123456789' }),
      signed(c, body, { headers: { [SIGNATURE_HEADER]: 'v1=nothex' } }),
      signed(c, body, { headers: { [SIGNATURE_HEADER]: `v1=${'0'.repeat(64)}` } }),
      signed(c, body, { sendRaw: JSON.stringify(lines()) }),
      { ...signed(c, body), headers: {} },
    ];
    for (const req of attempts) expect(await c.send(req)).toEqual(UNAUTHORIZED);
    expect(calls).toEqual([]);
    // A replay: the first passes, the same request again is a 401.
    const once = signed(c, lines());
    expect((await c.send(once)).status).toBe(200);
    expect(await c.send(once)).toEqual(UNAUTHORIZED);
    expect(calls).toHaveLength(1);
    c.adapter.dispose();
  });

  it('the body is verified before it is parsed', async () => {
    const { c, calls } = await world(() => 1);
    const parse = vi.spyOn(JSON, 'parse');
    for (const raw of ['{not json', '{"__proto__": {"x": 1}}', JSON.stringify(lines())]) {
      parse.mockClear();
      expect(await c.send(signed(c, raw, { secret: 'a-completely-different-secret-0123456789' }))).toEqual(UNAUTHORIZED);
      expect(parse.mock.calls.some(([arg]) => arg === raw)).toBe(false);
    }
    parse.mockRestore();
    expect(calls).toEqual([]);
    c.adapter.dispose();
  });

  it('rawBody absent is a 500 and a log; a body over 64 KiB is 413 before the signature', async () => {
    const { c } = await world(() => 1);
    const req = signed(c, lines());
    delete req.rawBody;
    expect(await c.send(req)).toEqual({ status: 500, body: { error: 'internal' } });
    expect(c.logged).toContainEqual(['chatwarden.coop_failed', { op: 'no_raw_body' }]);
    const big = JSON.stringify({ lines: [{ label: 'reporter', text: 'x'.repeat(70_000) }] });
    expect((await c.send(signed(c, big))).status).toBe(413);
    expect((await c.send(signed(c, big, { secret: 'a-completely-different-secret-0123456789' }))).status).toBe(413);
    c.adapter.dispose();
  });

  it('too many lines are capped at 50, an over-long text is cut to 400, the item text is appended and cut', async () => {
    const { c, calls } = await world(() => 7);
    const many = Array.from({ length: 80 }, (_, i) => ({ label: i % 2 === 0 ? 'reporter' : 'reported', text: `line ${i} ${'x'.repeat(10)}` }));
    expect((await c.send(signed(c, { lines: many }))).body).toEqual({ severity: 7 });
    expect(calls[0]).toHaveLength(50);
    expect(calls[0]![0]).toEqual(many[0]);
    expect(calls[0]![49]).toEqual(many[49]);

    await c.send(signed(c, { lines: [{ label: 'reporter', text: 'y'.repeat(1000) }], item: { text: 'z'.repeat(900) } }));
    expect(calls[1]![0]!.text).toHaveLength(400);
    expect(calls[1]![1]).toEqual({ label: 'item', text: 'z'.repeat(400) });
    c.adapter.dispose();
  });

  it('a missing label, a non-string text, a bad shape and a bad item are 400, and read never runs', async () => {
    const { c, calls } = await world(() => 7);
    const bad: unknown[] = [
      {},
      { lines: 'x' },
      { lines: {} },
      { lines: [] },
      { lines: [null] },
      { lines: ['text'] },
      { lines: [{ text: 'no label' }] },
      { lines: [{ label: '', text: 'empty label' }] },
      { lines: [{ label: 5, text: 'x' }] },
      { lines: [{ label: 'reporter' }] },
      { lines: [{ label: 'reporter', text: 5 }] },
      { lines: [{ label: 'reporter', text: { deep: 1 } }] },
      { lines: [{ label: 'reporter', text: 'ok' }], item: 'text' },
      { lines: [{ label: 'reporter', text: 'ok' }], item: { text: 5 } },
      [],
      'text',
      null,
    ];
    for (const body of bad) expect((await c.send(signed(c, JSON.stringify(body) + ' '))).status, JSON.stringify(body)).toBe(400);
    expect((await c.send(signed(c, '{nope'))).status).toBe(400);
    expect((await c.send(signed(c, '{"__proto__": {"x": 1}, "lines": [{"label": "reporter", "text": "x"}]}'))).status).toBe(400);
    expect(calls).toEqual([]);
    c.adapter.dispose();
  });

  it('an over-long label is cut, and an empty-looking text is allowed', async () => {
    const { c, calls } = await world(() => 7);
    await c.send(signed(c, { lines: [{ label: 'l'.repeat(100), text: '' }] }));
    expect(calls[0]).toEqual([{ label: 'l'.repeat(32), text: '' }]);
    c.adapter.dispose();
  });

  it('read throwing, hanging past 8 s (a fake timer), returning NaN or a non-number are 503 with an empty body', async () => {
    const results: Array<[string, Read]> = [
      ['throw', () => { throw new Error('ai down tarvo'); }],
      ['reject', () => Promise.reject(new Error('ai down tarvo'))],
      ['nan', () => Number.NaN],
      ['inf', () => Number.POSITIVE_INFINITY],
      ['string', () => '72' as unknown as number],
      ['null', () => null as unknown as number],
      ['object', () => ({ severity: 5 }) as unknown as number],
    ];
    for (const [name, read] of results) {
      const { c } = await world(read);
      const res = await c.send(signed(c, lines()));
      expect(res.status, name).toBe(503);
      expect(res.body, name).toBe('');
      expect(JSON.stringify(c.logged), name).not.toMatch(/tarvo|zorbak|vlemmo/);
      c.adapter.dispose();
    }
    const { c, timers } = await world(() => new Promise<number>(() => undefined));
    const pending = c.send(signed(c, lines()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const limit = timers.find((t) => t.ms === 8000);
    expect(limit).toBeDefined();
    limit!.run();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(res.body).toBe('');
    expect(timers.every((t) => t.cancelled || t === limit)).toBe(true);
    c.adapter.dispose();
  });

  it('a read that answers in time cancels its timer', async () => {
    const { c, timers } = await world(() => 3);
    await c.send(signed(c, lines()));
    expect(timers.length).toBeGreaterThan(0);
    expect(timers.every((t) => t.cancelled)).toBe(true);
    c.adapter.dispose();
  });

  it('failures are logged by class only', async () => {
    const { c } = await world(() => {
      throw new TypeError('has zorbak in it');
    });
    await c.send(signed(c, lines()));
    expect(c.logged).toEqual([['chatwarden.coop_failed', { op: 'signal', error: 'TypeError' }]]);
    c.adapter.dispose();
  });

  it('the limiter returns 429 with retry-after past the cap and lets the next window through', async () => {
    const { c, calls } = await world(() => 5, {}, { rateLimit: { max: 2, windowMs: 60_000 } });
    expect((await c.send(signed(c, lines()))).status).toBe(200);
    expect((await c.send(signed(c, lines()))).status).toBe(200);
    const third = await c.send(signed(c, lines()));
    expect(third.status).toBe(429);
    expect(third.headers?.['retry-after']).toMatch(/^\d+$/);
    expect(Number(third.headers?.['retry-after'])).toBeGreaterThan(0);
    expect(Number(third.headers?.['retry-after'])).toBeLessThanOrEqual(60);
    expect(calls).toHaveLength(2);
    c.w.clock.t += 60_000;
    expect((await c.send(signed(c, lines()))).status).toBe(200);
    c.adapter.dispose();
  });

  it('a request that failed verification does not use the limiter', async () => {
    const { c } = await world(() => 5, {}, { rateLimit: { max: 1, windowMs: 60_000 } });
    for (let i = 0; i < 5; i++) expect(await c.send(signed(c, lines(), { secret: 'a-completely-different-secret-0123456789' }))).toEqual(UNAUTHORIZED);
    expect((await c.send(signed(c, lines()))).status).toBe(200);
    c.adapter.dispose();
  });

  it('no identifier is accepted or echoed: extra keys are ignored and never reach read', async () => {
    const { c, calls } = await world(() => 9);
    const res = await c.send(
      signed(c, {
        lines: [{ label: 'reporter', text: 'hello', userId: 'u-1', handle: 'ZorbakFan', id: 'line-1', reportId: 'rpt-1' }],
        item: { text: 'there', subject: 'sub-1', id: 'item-1' },
        reportId: 'rpt-2',
        subject: 'sub-2',
        room: 'room-secret',
      }),
    );
    expect(res).toEqual({ status: 200, body: { severity: 9 } });
    expect(calls[0]).toEqual([
      { label: 'reporter', text: 'hello' },
      { label: 'item', text: 'there' },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/u-1|ZorbakFan|line-1|rpt-|sub-|room-secret|item-1/);
    expect(JSON.stringify(res)).not.toMatch(/u-1|ZorbakFan|rpt-|sub-/);
    c.adapter.dispose();
  });

  it('the answer carries nothing but the severity', async () => {
    const { c } = await world(() => 12);
    const res = await c.send(signed(c, lines()));
    expect(Object.keys(res.body as object)).toEqual(['severity']);
    expect(res.headers).toBeUndefined();
    c.adapter.dispose();
  });

  it('the route is absent when signal is not set', async () => {
    const c = await coopWorld();
    expect(Object.keys(c.adapter.routes)).toEqual(['POST /coop/actions']);
    const res = await c.send(signed(c, lines()));
    expect(res.status).toBe(404);
    c.adapter.dispose();
  });

  it('with signal set the route table has both routes', async () => {
    const { c } = await world(() => 1);
    expect(Object.keys(c.adapter.routes).sort()).toEqual(['POST /coop/actions', 'POST /coop/signal']);
    c.adapter.dispose();
  });

  it('after dispose the route is the same 401 and read is not called; a request in flight is not answered with a score', async () => {
    const { c, calls } = await world(() => 1);
    c.adapter.dispose();
    expect(await c.send(signed(c, lines()))).toEqual(UNAUTHORIZED);
    expect(calls).toEqual([]);
  });
});
