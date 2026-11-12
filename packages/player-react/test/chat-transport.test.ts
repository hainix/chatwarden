import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerError } from '../src/client.js';
import { sseTransport } from '../src/chat/transport.js';
import type { ChatClosedWhy, ChatConnection, ChatStatus, SseTransportOptions } from '../src/chat/transport.js';
import type { ChatFrame, WireLine } from '../src/chat/wire.js';

// A fake `fetch`: each call takes the next scripted answer. A stream answer exposes its controller so a test pushes the bytes.

const enc = new TextEncoder();

interface Attempt {
  url: string;
  init: RequestInit;
  signal: AbortSignal;
  push(text: string | Uint8Array): void;
  end(): void;
  fail(): void;
}

type Step = { status?: number; headers?: Record<string, string>; stream?: boolean; text?: string; noBody?: boolean } | Error;

function fakeFetch(steps: Step[] = []) {
  const queue = [...steps];
  const attempts: Attempt[] = [];
  const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const step = queue.shift() ?? { status: 200, stream: true };
    if (step instanceof Error) return Promise.reject(step);
    const signal = init?.signal as AbortSignal;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    const attempt: Attempt = {
      url: String(url),
      init: init ?? {},
      signal,
      push: (t) => {
        try {
          controller.enqueue(typeof t === 'string' ? enc.encode(t) : t);
        } catch {
          // closed or errored: a late push is a no-op
        }
      },
      end: () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      },
      fail: () => {
        try {
          controller.error(new TypeError('network error'));
        } catch {
          // already closed
        }
      },
    };
    attempts.push(attempt);
    signal.addEventListener('abort', () => {
      try {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      } catch {
        // already closed
      }
    });
    const headers = new Headers(step.headers ?? {});
    const status = step.status ?? 200;
    if (step.noBody === true) return Promise.resolve(new Response(null, { status, headers }));
    if (step.stream === false || status !== 200) {
      return Promise.resolve(new Response(step.text ?? '', { status, headers }));
    }
    return Promise.resolve(new Response(body, { status, headers }));
  });
  return { fetch: fetchFn as unknown as typeof fetch, fn: fetchFn, attempts, queue };
}

const line = (id: string, text = `line ${id}`, extra: Partial<WireLine> = {}): WireLine => ({ id, at: 1_800_000_000_000 + Number(id), name: 'tarvo', text, ...extra });
const helloFrame = (over: Record<string, unknown> = {}): ChatFrame =>
  ({ type: 'hello', v: 1, epoch: 'e1', room: 'lobby', you: { name: 'snerp' }, maxLength: 200, summary: 'Be kind.', restriction: null, lines: [], muted: [], ...over }) as ChatFrame;
const sse = (f: ChatFrame): string => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`;

function collect(over: Partial<SseTransportOptions> = {}, steps: Step[] = [], room = 'lobby') {
  const ff = fakeFetch(steps);
  const frames: ChatFrame[] = [];
  const statuses: string[] = [];
  const transport = sseTransport({ baseUrl: '/chat', fetch: ff.fetch, random: () => 0.5, ...over });
  const conn: ChatConnection = transport.open(room, {
    frame: (f) => frames.push(f),
    status: (s: ChatStatus, why?: ChatClosedWhy) => statuses.push(why === undefined ? s : `${s}:${why}`),
  });
  return { ...ff, frames, statuses, conn, transport };
}

/** Let promises and zero-delay timers settle. */
const tick = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('opens the stream with the configured headers and credentials; a missing baseUrl throws a TypeError like fetchTransport', () => {
  it('requests the room stream with accept, headers, credentials and an abort signal', async () => {
    const t = collect({ baseUrl: 'https://game.example/chat', headers: { 'x-chatwarden-key': 'k-1', authorization: 'Bearer t' }, credentials: 'include' });
    await tick();
    expect(t.fn).toHaveBeenCalledTimes(1);
    const a = t.attempts[0] as Attempt;
    expect(a.url).toBe('https://game.example/chat/rooms/lobby/stream');
    expect(a.init.method ?? 'GET').toBe('GET');
    expect(a.init.headers).toEqual({ 'x-chatwarden-key': 'k-1', authorization: 'Bearer t', accept: 'text/event-stream' });
    expect(a.init.credentials).toBe('include');
    expect(a.signal).toBeInstanceOf(AbortSignal);
    expect(a.signal.aborted).toBe(false);
    t.conn.close();
  });

  it('leaves credentials out when none are configured', async () => {
    const t = collect();
    await tick();
    expect(t.attempts[0]?.init).not.toHaveProperty('credentials');
    t.conn.close();
  });

  it('accept is always the event stream, whatever case a header uses', async () => {
    const t = collect({ headers: { Accept: 'application/json', 'X-Other': '1' } });
    await tick();
    const h = t.attempts[0]?.init.headers as Record<string, string>;
    expect(h.accept).toBe('text/event-stream');
    expect(Object.keys(h).filter((k) => k.toLowerCase() === 'accept')).toEqual(['accept']);
    expect(h['X-Other']).toBe('1');
    t.conn.close();
  });

  it('a trailing slash on baseUrl is dropped; "/" and "" mean the server root', async () => {
    for (const [base, expected] of [['/chat/', '/chat/rooms/lobby/stream'], ['/chat///', '/chat/rooms/lobby/stream'], ['/', '/rooms/lobby/stream'], ['', '/rooms/lobby/stream']] as const) {
      const t = collect({ baseUrl: base });
      await tick();
      expect(t.attempts[0]?.url, base).toBe(expected);
      t.conn.close();
    }
  });

  it('the room id is encoded', async () => {
    const t = collect({}, [], 'a b/c?d#e');
    await tick();
    expect(t.attempts[0]?.url).toBe('/chat/rooms/a%20b%2Fc%3Fd%23e/stream');
    t.conn.close();
  });

  it('uses the global fetch, looked up when the stream opens, when none is given', async () => {
    const ff = fakeFetch();
    vi.stubGlobal('fetch', ff.fetch);
    try {
      const conn = sseTransport({ baseUrl: '/chat' }).open('lobby', { frame: () => undefined, status: () => undefined });
      await tick();
      expect(ff.fn).toHaveBeenCalledTimes(1);
      conn.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a missing or non-string baseUrl throws a TypeError, as fetchTransport does', () => {
    expect(() => sseTransport({} as unknown as SseTransportOptions)).toThrow(TypeError);
    expect(() => sseTransport({ baseUrl: 7 } as unknown as SseTransportOptions)).toThrow(TypeError);
    expect(() => sseTransport(undefined as unknown as SseTransportOptions)).toThrow(TypeError);
  });

  it('reports connecting at once, before any answer', () => {
    const t = collect();
    expect(t.statuses).toEqual(['connecting']);
    t.conn.close();
  });
});

describe('frames split across chunks, a multi-byte character split across chunks, a hello then lines', () => {
  it('delivers hello then lines in order, and open on the first hello', async () => {
    const t = collect();
    await tick();
    const a = t.attempts[0] as Attempt;
    a.push(sse(helloFrame({ lines: [line('1')] })));
    await tick();
    a.push(sse({ type: 'line', line: line('2') }));
    a.push(sse({ type: 'line', line: line('3') }));
    await tick();
    expect(t.statuses).toEqual(['connecting', 'open']);
    expect(t.frames.map((f) => f.type)).toEqual(['hello', 'line', 'line']);
    expect(t.frames.map((f) => (f.type === 'line' ? f.line.id : ''))).toEqual(['', '2', '3']);
    t.conn.close();
  });

  it('a frame split at every byte is read the same', async () => {
    const whole = sse(helloFrame({ lines: [line('1', 'héllo \u{1F600} wörld')] })) + sse({ type: 'line', line: line('2', 'ünï\u{1F680}') });
    const bytes = enc.encode(whole);
    for (let i = 1; i < bytes.length; i += 1) {
      const t = collect();
      await tick();
      const a = t.attempts[0] as Attempt;
      a.push(bytes.slice(0, i));
      await tick();
      a.push(bytes.slice(i));
      await tick();
      expect(t.frames, `split at byte ${i}`).toHaveLength(2);
      const last = t.frames[1];
      expect(last?.type === 'line' ? last.line.text : '').toBe('ünï\u{1F680}');
      const first = t.frames[0];
      expect(first?.type === 'hello' ? first.lines[0]?.text : '').toBe('héllo \u{1F600} wörld');
      t.conn.close();
    }
  });

  it('one byte at a time', async () => {
    const t = collect();
    await tick();
    const a = t.attempts[0] as Attempt;
    for (const b of enc.encode(sse(helloFrame()) + sse({ type: 'line', line: line('2', '\u{1F600}') }))) a.push(new Uint8Array([b]));
    await tick();
    expect(t.frames.map((f) => f.type)).toEqual(['hello', 'line']);
    t.conn.close();
  });

  it('CRLF framing is read', async () => {
    const t = collect();
    await tick();
    t.attempts[0]?.push(sse(helloFrame()).replaceAll('\n', '\r\n') + sse({ type: 'notices' }).replaceAll('\n', '\r\n'));
    await tick();
    expect(t.frames.map((f) => f.type)).toEqual(['hello', 'notices']);
    t.conn.close();
  });

  it('heartbeats and comments deliver nothing', async () => {
    const t = collect();
    await tick();
    const a = t.attempts[0] as Attempt;
    a.push(`${sse(helloFrame())}: ping\n\n: ping\n\n`);
    await tick(20_000);
    a.push(': ping\n\n');
    await tick();
    expect(t.frames).toHaveLength(1);
    expect(t.statuses).toEqual(['connecting', 'open']);
    t.conn.close();
  });

  it('an unknown frame, a bad JSON event and a malformed frame are ignored and the stream goes on', async () => {
    const t = collect();
    await tick();
    const a = t.attempts[0] as Attempt;
    a.push(sse(helloFrame()));
    a.push('event: confetti\ndata: {"type":"confetti"}\n\n');
    a.push('event: line\ndata: {not json\n\n');
    a.push('event: line\ndata: {"type":"line","line":{"id":5}}\n\n');
    a.push('event: line\ndata: [1,2]\n\n');
    a.push('event: line\ndata: null\n\n');
    a.push(sse({ type: 'line', line: line('7') }));
    await tick();
    expect(t.frames.map((f) => f.type)).toEqual(['hello', 'line']);
    expect(t.statuses).toEqual(['connecting', 'open']);
    t.conn.close();
  });

  it('an oversize event (over 64 KiB) is dropped and the next frame still arrives', async () => {
    const t = collect();
    await tick();
    const a = t.attempts[0] as Attempt;
    a.push(sse(helloFrame()));
    a.push(`event: line\ndata: {"type":"line","line":{"id":"9","at":1,"name":"a","text":"${'x'.repeat(70_000)}"}}\n\n`);
    a.push(sse({ type: 'line', line: line('10') }));
    await tick();
    expect(t.frames.map((f) => (f.type === 'line' ? f.line.id : f.type))).toEqual(['hello', '10']);
    t.conn.close();
  });

  it('an over-long text inside the limit is cut by the reader', async () => {
    const t = collect();
    await tick();
    const a = t.attempts[0] as Attempt;
    a.push(sse(helloFrame()));
    a.push(sse({ type: 'line', line: line('11', 'y'.repeat(5000)) }));
    await tick();
    const f = t.frames[1];
    expect(f?.type === 'line' ? f.line.text.length : 0).toBe(1000);
    t.conn.close();
  });

  it('a frame with __proto__ keys is read without pollution', async () => {
    const t = collect();
    await tick();
    const a = t.attempts[0] as Attempt;
    a.push(sse(helloFrame()));
    a.push('event: line\ndata: {"type":"line","__proto__":{"polluted":1},"line":{"id":"3","at":3,"name":"a","text":"b","__proto__":{"polluted":1}}}\n\n');
    await tick();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(t.frames).toHaveLength(2);
    t.conn.close();
  });

  it('a handler that throws does not break the stream or cause a reconnect', async () => {
    const ff = fakeFetch();
    let n = 0;
    const conn = sseTransport({ baseUrl: '/chat', fetch: ff.fetch, random: () => 0.5 }).open('lobby', {
      frame: () => {
        n += 1;
        if (n === 1) throw new Error('handler');
      },
      status: () => undefined,
    });
    await tick();
    ff.attempts[0]?.push(sse(helloFrame()) + sse({ type: 'notices' }));
    await tick();
    expect(n).toBe(2);
    expect(ff.fn).toHaveBeenCalledTimes(1);
    conn.close();
  });
});

describe('reconnect: delays are jittered between 0 and initial, 2x initial, ... capped at maxMs (seeded random); reset after a hello; no timer left after close()', () => {
  const failing = (n: number): Step[] => Array.from({ length: n }, () => new TypeError('Failed to fetch'));

  it('the delay before attempt n is random() times min(maxMs, initial * 2^n)', async () => {
    const t = collect({ retry: { initialMs: 1000, maxMs: 8000 } }, failing(6));
    await tick();
    expect(t.fn).toHaveBeenCalledTimes(1);
    expect(t.statuses).toEqual(['connecting', 'reconnecting']);
    // random() is 0.5: 500, 1000, 2000, 4000, 4000, 4000
    const delays = [500, 1000, 2000, 4000, 4000];
    let calls = 1;
    for (const d of delays) {
      await tick(d - 1);
      expect(t.fn, `before ${d}`).toHaveBeenCalledTimes(calls);
      await tick(1);
      calls += 1;
      expect(t.fn, `at ${d}`).toHaveBeenCalledTimes(calls);
    }
    t.conn.close();
  });

  it('uses the seeded random sequence it is given', async () => {
    const seq = [0.1, 0.9, 0.25, 0.75];
    let i = 0;
    const t = collect({ retry: { initialMs: 1000, maxMs: 30_000 }, random: () => seq[i++ % seq.length] as number }, failing(4));
    await tick();
    // caps 1000, 2000, 4000: delays 100, 1800, 1000
    const expected = [100, 1800, 1000];
    let calls = 1;
    for (const d of expected) {
      await tick(d - 1);
      expect(t.fn).toHaveBeenCalledTimes(calls);
      await tick(1);
      calls += 1;
      expect(t.fn).toHaveBeenCalledTimes(calls);
    }
    t.conn.close();
  });

  it('the largest random() just under 1 still waits less than the cap; 0 retries at once', async () => {
    const hi = collect({ retry: { initialMs: 1000, maxMs: 30_000 }, random: () => 0.999 }, failing(2));
    await tick();
    await tick(998);
    expect(hi.fn).toHaveBeenCalledTimes(1);
    await tick(2);
    expect(hi.fn).toHaveBeenCalledTimes(2);
    hi.conn.close();
    const zero = collect({ random: () => 0 }, failing(2));
    await tick();
    await tick(0);
    expect(zero.fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    zero.conn.close();
  });

  it('defaults to a first delay up to 1 000 ms, doubling to a largest of 30 000 ms', async () => {
    const t = collect({ random: () => 0.999 }, failing(9));
    await tick();
    // 999, 1998, 3996, 7992, 15984, then 29970 (the 30 000 cap) twice
    let calls = 1;
    for (const d of [999, 1998, 3996, 7992, 15_984, 29_970, 29_970]) {
      await tick(d - 1);
      expect(t.fn, `before ${d}`).toHaveBeenCalledTimes(calls);
      await tick(1);
      calls += 1;
      expect(t.fn, `at ${d}`).toHaveBeenCalledTimes(calls);
    }
    t.conn.close();
  });

  it('a stream that ends reconnects after the first delay; a stream that errors does too', async () => {
    const t = collect({ retry: { initialMs: 1000, maxMs: 8000 } });
    await tick();
    t.attempts[0]?.push(sse(helloFrame()));
    await tick();
    t.attempts[0]?.end();
    await tick();
    expect(t.statuses).toEqual(['connecting', 'open', 'reconnecting']);
    await tick(500);
    expect(t.fn).toHaveBeenCalledTimes(2);
    t.attempts[1]?.push(sse(helloFrame()));
    await tick();
    t.attempts[1]?.fail();
    await tick();
    expect(t.statuses).toEqual(['connecting', 'open', 'reconnecting', 'open', 'reconnecting']);
    await tick(500);
    expect(t.fn).toHaveBeenCalledTimes(3);
    t.conn.close();
  });

  it('the delay resets after a hello', async () => {
    const t = collect({ retry: { initialMs: 1000, maxMs: 30_000 } }, failing(3));
    await tick();
    await tick(500); // attempt 2 (cap 1000)
    await tick(1000); // attempt 3 (cap 2000, 0.5)
    await tick(2000); // attempt 4 (cap 4000, 0.5): this one answers
    expect(t.fn).toHaveBeenCalledTimes(4);
    t.attempts[0]?.push(sse(helloFrame()));
    await tick();
    t.attempts[0]?.end();
    await tick();
    // back to the first delay (500), not 4000
    await tick(499);
    expect(t.fn).toHaveBeenCalledTimes(4);
    await tick(1);
    expect(t.fn).toHaveBeenCalledTimes(5);
    t.conn.close();
  });

  it('a connection that never said hello keeps doubling even when the stream ends cleanly', async () => {
    const t = collect({ retry: { initialMs: 1000, maxMs: 30_000 } });
    await tick();
    t.attempts[0]?.end();
    await tick(500);
    expect(t.fn).toHaveBeenCalledTimes(2);
    t.attempts[1]?.end();
    await tick(999);
    expect(t.fn).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(t.fn).toHaveBeenCalledTimes(3);
    t.conn.close();
  });

  it('no timer is left after close(), during a back-off, a live stream or the wait for a hello', async () => {
    const waiting = collect({}, failing(1));
    await tick();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    waiting.conn.close();
    expect(vi.getTimerCount()).toBe(0);

    const live = collect();
    await tick();
    live.attempts[0]?.push(sse(helloFrame()));
    await tick();
    live.conn.close();
    expect(vi.getTimerCount()).toBe(0);

    const noHello = collect();
    await tick();
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the hello timer
    noHello.conn.close();
    expect(vi.getTimerCount()).toBe(0);
    await tick(120_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retry options are sanitised: a bad value falls back to the default, maxMs is never below initialMs', async () => {
    const t = collect({ retry: { initialMs: Number.NaN, maxMs: -5 }, random: () => 0.999 }, failing(2));
    await tick();
    await tick(1000);
    expect(t.fn).toHaveBeenCalledTimes(2);
    t.conn.close();
    const small = collect({ retry: { initialMs: 4000, maxMs: 100 }, random: () => 0.999 }, failing(2));
    await tick();
    await tick(3990);
    expect(small.fn).toHaveBeenCalledTimes(1);
    await tick(10);
    expect(small.fn).toHaveBeenCalledTimes(2);
    small.conn.close();
  });
});

describe('401 and 403 close without retry; 429 honours retry-after; 500 retries; a network error retries; a hello that never comes is retried', () => {
  it('401 is closed(unauthorized): no retry, no timer', async () => {
    const t = collect({}, [{ status: 401, text: '{"error":"unauthorized","message":"No."}' }]);
    await tick();
    await tick(600_000);
    expect(t.statuses).toEqual(['connecting', 'closed:unauthorized']);
    expect(t.fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('403 is closed(forbidden): no retry', async () => {
    const t = collect({}, [{ status: 403 }]);
    await tick();
    await tick(600_000);
    expect(t.statuses).toEqual(['connecting', 'closed:forbidden']);
    expect(t.fn).toHaveBeenCalledTimes(1);
  });

  it('a 401 after the stream was open is closed(unauthorized) too', async () => {
    const t = collect({}, [{ stream: true }, { status: 401 }]);
    await tick();
    t.attempts[0]?.push(sse(helloFrame()));
    await tick();
    t.attempts[0]?.end();
    await tick(500);
    await tick();
    expect(t.statuses).toEqual(['connecting', 'open', 'reconnecting', 'closed:unauthorized']);
    await tick(600_000);
    expect(t.fn).toHaveBeenCalledTimes(2);
  });

  it('429 waits retry-after seconds when that is longer than the back-off', async () => {
    const t = collect({ retry: { initialMs: 1000, maxMs: 30_000 } }, [{ status: 429, headers: { 'retry-after': '7' } }]);
    await tick();
    expect(t.statuses).toEqual(['connecting', 'reconnecting']);
    await tick(6999);
    expect(t.fn).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(t.fn).toHaveBeenCalledTimes(2);
    t.conn.close();
  });

  it('429 waits at least the back-off when retry-after is shorter, missing or not a number', async () => {
    for (const headers of [{ 'retry-after': '0' }, { 'retry-after': '1' }, {}, { 'retry-after': 'soon' }, { 'retry-after': '-4' }, { 'retry-after': '1.5' }] as Array<Record<string, string>>) {
      const t = collect({ retry: { initialMs: 4000, maxMs: 30_000 }, random: () => 0.999 }, [{ status: 429, headers }]);
      await tick();
      await tick(3995);
      expect(t.fn, JSON.stringify(headers)).toHaveBeenCalledTimes(1);
      await tick(5);
      expect(t.fn, JSON.stringify(headers)).toHaveBeenCalledTimes(2);
      t.conn.close();
    }
  });

  it('429 retry-after has a ceiling, so a huge value cannot park the chat for days or overflow the timer', async () => {
    const t = collect({}, [{ status: 429, headers: { 'retry-after': '99999999' } }]);
    await tick();
    await tick(599_999);
    expect(t.fn).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(t.fn).toHaveBeenCalledTimes(2);
    t.conn.close();
  });

  it.each([500, 502, 503, 504, 404, 400, 408])('%i retries with back-off', async (status) => {
    const t = collect({ retry: { initialMs: 1000, maxMs: 30_000 } }, [{ status, text: '<html>bad gateway</html>' }]);
    await tick();
    expect(t.statuses).toEqual(['connecting', 'reconnecting']);
    await tick(500);
    expect(t.fn).toHaveBeenCalledTimes(2);
    t.conn.close();
  });

  it('a network error retries', async () => {
    const t = collect({}, [new TypeError('Failed to fetch')]);
    await tick();
    expect(t.statuses).toEqual(['connecting', 'reconnecting']);
    await tick(500);
    expect(t.fn).toHaveBeenCalledTimes(2);
    t.conn.close();
  });

  it('a 200 with no body retries', async () => {
    const t = collect({}, [{ status: 200, noBody: true }]);
    await tick();
    await tick(500);
    expect(t.fn).toHaveBeenCalledTimes(2);
    t.conn.close();
  });

  it('a hello that never comes (10 s after the response starts) aborts the attempt and retries', async () => {
    const t = collect({ retry: { initialMs: 1000, maxMs: 30_000 } });
    await tick();
    await tick(9_999);
    expect(t.attempts[0]?.signal.aborted).toBe(false);
    await tick(1);
    expect(t.attempts[0]?.signal.aborted).toBe(true);
    expect(t.statuses).toEqual(['connecting', 'reconnecting']);
    await tick(500);
    expect(t.fn).toHaveBeenCalledTimes(2);
    t.conn.close();
  });

  it('heartbeats do not count as a hello: the wait still ends at 10 s', async () => {
    const t = collect();
    await tick();
    t.attempts[0]?.push(': ping\n\n');
    await tick(10_000);
    expect(t.attempts[0]?.signal.aborted).toBe(true);
    t.conn.close();
  });

  it('a hello just in time keeps the connection; nothing aborts at 10 s or later', async () => {
    const t = collect();
    await tick();
    await tick(9_999);
    t.attempts[0]?.push(sse(helloFrame()));
    await tick();
    await tick(60_000);
    expect(t.attempts[0]?.signal.aborted).toBe(false);
    expect(t.fn).toHaveBeenCalledTimes(1);
    expect(t.statuses).toEqual(['connecting', 'open']);
    t.conn.close();
  });

  it('a malformed frame is not a hello: the wait for a hello goes on', async () => {
    const t = collect();
    await tick();
    t.attempts[0]?.push('event: hello\ndata: {"type":"hello"}\n\n');
    await tick(10_000);
    expect(t.attempts[0]?.signal.aborted).toBe(true);
    t.conn.close();
  });

  it('there is no Last-Event-ID: a reconnect asks for the same stream and the snapshot in the new hello does the resuming', async () => {
    const t = collect();
    await tick();
    t.attempts[0]?.push(`id: 41\n${sse(helloFrame({ lines: [line('41')] }))}`);
    await tick();
    t.attempts[0]?.end();
    await tick(500);
    expect(t.attempts[1]?.url).toBe(t.attempts[0]?.url);
    expect(JSON.stringify(t.attempts[1]?.init.headers).toLowerCase()).not.toContain('last-event-id');
    t.conn.close();
  });

  it('the new connection after a reconnect delivers its own hello and lines', async () => {
    const t = collect();
    await tick();
    t.attempts[0]?.push(sse(helloFrame({ lines: [line('1')] })));
    await tick();
    t.attempts[0]?.fail();
    await tick(500);
    t.attempts[1]?.push(sse(helloFrame({ lines: [line('1'), line('2')] })));
    await tick();
    expect(t.statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);
    expect(t.frames.filter((f) => f.type === 'hello')).toHaveLength(2);
    t.conn.close();
  });

  it('a server that closes right after the response (no body) is retried, not treated as final', async () => {
    const t = collect({}, [{ stream: true }]);
    await tick();
    t.attempts[0]?.end();
    await tick(500);
    expect(t.fn).toHaveBeenCalledTimes(2);
    expect(t.statuses).toEqual(['connecting', 'reconnecting']);
    t.conn.close();
  });
});

describe('a bye banned is closed(banned) and not retried; a bye shutdown is closed(shutdown)', () => {
  it.each(['banned', 'room_closed', 'shutdown'] as const)('bye %s: the frame is delivered, the status closes with why, nothing retries', async (reason) => {
    const t = collect();
    await tick();
    t.attempts[0]?.push(sse(helloFrame()) + sse({ type: 'bye', reason, ...(reason === 'banned' ? { until: 1_800_003_600_000 } : {}) }));
    await tick();
    expect(t.statuses).toEqual(['connecting', 'open', `closed:${reason}`]);
    expect(t.frames.at(-1)).toMatchObject({ type: 'bye', reason });
    t.attempts[0]?.end();
    await tick(600_000);
    expect(t.fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.attempts[0]?.signal.aborted).toBe(true);
  });

  it('a banned player gets a 200 with one bye and an ended stream (no hello): closed(banned), no retry', async () => {
    const t = collect();
    await tick();
    t.attempts[0]?.push(sse({ type: 'bye', reason: 'banned', until: null }));
    t.attempts[0]?.end();
    await tick(600_000);
    expect(t.statuses).toEqual(['connecting', 'closed:banned']);
    expect(t.fn).toHaveBeenCalledTimes(1);
  });

  it('frames after a bye in the same chunk are ignored', async () => {
    const t = collect();
    await tick();
    t.attempts[0]?.push(sse(helloFrame()) + sse({ type: 'bye', reason: 'shutdown' }) + sse({ type: 'line', line: line('9') }));
    await tick();
    expect(t.frames.map((f) => f.type)).toEqual(['hello', 'bye']);
  });

  it('an online event after a bye does not reconnect', async () => {
    const t = collect();
    await tick();
    t.attempts[0]?.push(sse({ type: 'bye', reason: 'banned' }));
    await tick();
    window.dispatchEvent(new Event('online'));
    await tick(1000);
    expect(t.fn).toHaveBeenCalledTimes(1);
  });
});

describe('an online event retries immediately; close() aborts the request and ignores frames that arrive after', () => {
  it('online during a back-off retries at once and cancels the timer', async () => {
    const t = collect({ retry: { initialMs: 30_000, maxMs: 30_000 }, random: () => 0.999 }, [new TypeError('x')]);
    await tick();
    expect(t.fn).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('online'));
    await tick();
    expect(t.fn).toHaveBeenCalledTimes(2);
    t.attempts[0]?.push(sse(helloFrame()));
    await tick(60_000);
    expect(t.fn).toHaveBeenCalledTimes(2); // the old timer did not fire a third
    t.conn.close();
  });

  it('online while the stream is open does nothing', async () => {
    const t = collect();
    await tick();
    t.attempts[0]?.push(sse(helloFrame()));
    await tick();
    window.dispatchEvent(new Event('online'));
    await tick(1000);
    expect(t.fn).toHaveBeenCalledTimes(1);
    expect(t.attempts[0]?.signal.aborted).toBe(false);
    t.conn.close();
  });

  it('online while an attempt hangs without a hello abandons it and retries at once', async () => {
    const t = collect();
    await tick();
    window.dispatchEvent(new Event('online'));
    await tick();
    expect(t.attempts[0]?.signal.aborted).toBe(true);
    expect(t.fn).toHaveBeenCalledTimes(2);
    // the abandoned attempt does not schedule a retry of its own
    t.attempts[1]?.push(sse(helloFrame()));
    await tick(120_000);
    expect(t.fn).toHaveBeenCalledTimes(2);
    t.conn.close();
  });

  it('after close(), online does nothing (the listener is removed)', async () => {
    const t = collect({}, [new TypeError('x')]);
    await tick();
    t.conn.close();
    window.dispatchEvent(new Event('online'));
    await tick(1000);
    expect(t.fn).toHaveBeenCalledTimes(1);
  });

  it('a closed(unauthorized) connection removes its online listener too', async () => {
    const t = collect({}, [{ status: 401 }]);
    await tick();
    window.dispatchEvent(new Event('online'));
    await tick(1000);
    expect(t.fn).toHaveBeenCalledTimes(1);
  });

  it('works without a window (a non-browser host): no listener, no error', async () => {
    const win = globalThis.window;
    vi.stubGlobal('window', undefined);
    try {
      const t = collect({}, [new TypeError('x')]);
      await tick(500);
      expect(t.fn).toHaveBeenCalledTimes(2);
      t.conn.close();
    } finally {
      vi.stubGlobal('window', win);
      vi.unstubAllGlobals();
    }
  });

  it('close() aborts the request and says nothing more', async () => {
    const t = collect();
    await tick();
    t.attempts[0]?.push(sse(helloFrame()));
    await tick();
    t.conn.close();
    expect(t.attempts[0]?.signal.aborted).toBe(true);
    const framesBefore = t.frames.length;
    const statusesBefore = [...t.statuses];
    t.attempts[0]?.push(sse({ type: 'line', line: line('5') }));
    t.attempts[0]?.end();
    await tick(600_000);
    expect(t.frames).toHaveLength(framesBefore);
    expect(t.statuses).toEqual(statusesBefore);
    expect(t.fn).toHaveBeenCalledTimes(1);
  });

  it('frames already read in the same chunk as close() are not delivered after it', async () => {
    const ff = fakeFetch();
    const seen: string[] = [];
    const conn: ChatConnection = sseTransport({ baseUrl: '/chat', fetch: ff.fetch }).open('lobby', {
      frame: (f) => {
        seen.push(f.type);
        if (f.type === 'hello') conn.close();
      },
      status: () => undefined,
    });
    await tick();
    ff.attempts[0]?.push(sse(helloFrame()) + sse({ type: 'notices' }) + sse({ type: 'line', line: line('2') }));
    await tick();
    expect(seen).toEqual(['hello']);
  });

  it('close() before the answer arrives: the late response is ignored and its body is released', async () => {
    let resolve!: (r: Response) => void;
    const fetchFn = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const frames: string[] = [];
    const statuses: string[] = [];
    const cancel = vi.fn();
    const conn = sseTransport({ baseUrl: '/chat', fetch: fetchFn as unknown as typeof fetch }).open('lobby', { frame: (f) => frames.push(f.type), status: (s) => statuses.push(s) });
    conn.close();
    resolve(new Response(new ReadableStream({ start: (c) => c.enqueue(enc.encode(sse(helloFrame()))), cancel }), { status: 200 }));
    await tick(600_000);
    expect(cancel).toHaveBeenCalled();
    expect(frames).toEqual([]);
    expect(statuses).toEqual(['connecting']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('close() is safe to call twice and before anything happened', async () => {
    const t = collect();
    t.conn.close();
    t.conn.close();
    await tick(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a request that fails because close() aborted it does not schedule a retry', async () => {
    const fetchFn = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const statuses: string[] = [];
    const conn = sseTransport({ baseUrl: '/chat', fetch: fetchFn as unknown as typeof fetch }).open('lobby', { frame: () => undefined, status: (s) => statuses.push(s) });
    await tick();
    conn.close();
    await tick(600_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['connecting']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('two connections are independent: closing one leaves the other running', async () => {
    const ff = fakeFetch();
    const tr = sseTransport({ baseUrl: '/chat', fetch: ff.fetch });
    const a: string[] = [];
    const b: string[] = [];
    const ca = tr.open('one', { frame: (f) => a.push(f.type), status: () => undefined });
    tr.open('two', { frame: (f) => b.push(f.type), status: () => undefined });
    await tick();
    ca.close();
    ff.attempts[1]?.push(sse(helloFrame({ room: 'two' })));
    await tick();
    expect(ff.attempts[0]?.signal.aborted).toBe(true);
    expect(ff.attempts[1]?.signal.aborted).toBe(false);
    expect(b).toEqual(['hello']);
    expect(a).toEqual([]);
  });
});

// ---- The calls up: POST JSON through fetchTransport's calls ----

type Reply = { status?: number; headers?: Record<string, string>; json?: unknown; text?: string } | Error;

function post(reply: Reply, over: Partial<SseTransportOptions> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (reply instanceof Error) return Promise.reject(reply);
    const body = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? '');
    const headers = { 'content-type': reply.json !== undefined ? 'application/json; charset=utf-8' : 'text/html', ...reply.headers };
    return Promise.resolve(new Response(body, { status: reply.status ?? 200, headers }));
  });
  const transport = sseTransport({ baseUrl: '/chat', fetch: fetchFn as unknown as typeof fetch, ...over });
  // Open a connection that never needs to answer; the calls go through its methods.
  const conn = transport.open('lobby', { frame: () => undefined, status: () => undefined });
  fetchFn.mockClear();
  calls.length = 0;
  return { conn, calls, fetchFn };
}

describe('send resolves with SendResult for 200 delivered and 200 refused; a 429 rejects with PlayerError carrying retryAfter; a dropped connection rejects with code network', () => {
  it('delivered', async () => {
    const mine = { id: '43', at: 1_800_000_012_000, name: 'snerp', text: 'hello', mine: true };
    const { conn, calls } = post({ json: { ok: true, line: mine } }, { headers: { 'x-chatwarden-key': 'k' }, credentials: 'include' });
    await expect(conn.send('hello')).resolves.toEqual({ ok: true, line: mine });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/chat/rooms/lobby/lines');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ text: 'hello' });
    expect((calls[0]?.init.headers as Record<string, string>)['x-chatwarden-key']).toBe('k');
    expect(calls[0]?.init.credentials).toBe('include');
    conn.close();
  });

  it('refused, with every field the answer may carry, and no more', async () => {
    const { conn } = post({ json: { ok: false, refused: { reason: 'restricted', until: 1_800_003_600_000, byModerator: true, rule: 4, noticeId: 'n_9c1', text: 'leaked', seat: 'S' } } });
    await expect(conn.send('hi')).resolves.toEqual({ ok: false, refused: { reason: 'restricted', until: 1_800_003_600_000, byModerator: true, rule: 4, noticeId: 'n_9c1' } });
    conn.close();
  });

  it('refused with a reason this version does not know is still a refusal', async () => {
    const { conn } = post({ json: { ok: false, refused: { reason: 'tomorrow_reason' } } });
    await expect(conn.send('hi')).resolves.toEqual({ ok: false, refused: { reason: 'tomorrow_reason' } });
    conn.close();
  });

  it('pacing refusals keep retryAfterMs', async () => {
    const { conn } = post({ json: { ok: false, refused: { reason: 'slow_mode', retryAfterMs: 2500 } } });
    await expect(conn.send('hi')).resolves.toEqual({ ok: false, refused: { reason: 'slow_mode', retryAfterMs: 2500 } });
    conn.close();
  });

  it('a 429 rejects with a PlayerError carrying retryAfter', async () => {
    const { conn } = post({ status: 429, headers: { 'retry-after': '3' }, json: { error: 'rate_limited', message: 'Slow down.' } });
    const err = await conn.send('hi').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlayerError);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 3 });
    conn.close();
  });

  it.each([
    [400, 'invalid_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [413, 'payload_too_large'],
  ])('a %i kit error rejects with its code', async (status, code) => {
    const { conn } = post({ status, json: { error: code, message: 'No.' } });
    await expect(conn.send('hi')).rejects.toMatchObject({ name: 'PlayerError', status, code });
    conn.close();
  });

  it('a proxy error page rejects with http_<status> and never echoes the body', async () => {
    const { conn } = post({ status: 502, text: '<html>secret upstream</html>' });
    const err = (await conn.send('hi').catch((e: unknown) => e)) as PlayerError;
    expect(err.code).toBe('http_502');
    expect(err.message).not.toContain('secret');
    conn.close();
  });

  it('a dropped connection rejects with code network', async () => {
    const { conn } = post(new TypeError('Failed to fetch'));
    await expect(conn.send('hi')).rejects.toMatchObject({ name: 'PlayerError', status: 0, code: 'network' });
    conn.close();
  });

  it.each([
    ['not an object', { json: 'ok' }],
    ['no ok', { json: {} }],
    ['ok true without a line', { json: { ok: true } }],
    ['ok true with a bad line', { json: { ok: true, line: { id: 1 } } }],
    ['ok false without refused', { json: { ok: false } }],
    ['ok false with a reasonless refusal', { json: { ok: false, refused: {} } }],
    ['an empty body', { text: '' }],
  ] as Array<[string, Reply]>)('an answer that is %s rejects with bad_response', async (_n, reply) => {
    const { conn } = post(reply);
    await expect(conn.send('hi')).rejects.toMatchObject({ name: 'PlayerError', code: 'bad_response' });
    conn.close();
  });

  it('works after the stream was closed (the calls do not depend on it)', async () => {
    const { conn } = post({ json: { ok: true, line: line('1', 'hi', { mine: true }) } });
    conn.close();
    await expect(conn.send('hi')).resolves.toMatchObject({ ok: true });
  });
});

describe('report maps the answer to ReportResult and never needs a report id', () => {
  it('a taken report', async () => {
    const { conn, calls } = post({ json: { ok: true, remaining: 4 } });
    await expect(conn.report('42', { reason: 'harassment', note: 'It was bad.' })).resolves.toEqual({ ok: true, reportId: '', remaining: 4 });
    expect(calls[0]?.url).toBe('/chat/rooms/lobby/report');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ lineId: '42', reason: 'harassment', note: 'It was bad.' });
    conn.close();
  });

  it('a report with no draft fields sends only the line id', async () => {
    const { conn, calls } = post({ json: { ok: true, remaining: 9 } });
    await conn.report('42', {});
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ lineId: '42' });
    conn.close();
  });

  it('a hostile report id in the answer is not passed on', async () => {
    const { conn } = post({ json: { ok: true, remaining: 1, reportId: 'rep_secret' } });
    await expect(conn.report('1', {})).resolves.toEqual({ ok: true, reportId: '', remaining: 1 });
    conn.close();
  });

  it.each(['duplicate', 'rate', 'self', 'not_player', 'off', 'suspended', 'reason_required', 'reason_unknown', 'not_found'])('a %s refusal', async (refused) => {
    const { conn } = post({ json: { ok: false, refused } });
    await expect(conn.report('1', {})).resolves.toEqual({ ok: false, refused });
    conn.close();
  });

  it('a refusal keeps remaining when it is a number', async () => {
    const { conn } = post({ json: { ok: false, refused: 'rate', remaining: 0 } });
    await expect(conn.report('1', {})).resolves.toEqual({ ok: false, refused: 'rate', remaining: 0 });
    conn.close();
  });

  it('a bad remaining is dropped', async () => {
    const { conn } = post({ json: { ok: false, refused: 'rate', remaining: 'lots' } });
    await expect(conn.report('1', {})).resolves.toEqual({ ok: false, refused: 'rate' });
    conn.close();
  });

  it('a taken report with no valid remaining is a bad_response', async () => {
    const { conn } = post({ json: { ok: true } });
    await expect(conn.report('1', {})).rejects.toMatchObject({ code: 'bad_response' });
    conn.close();
  });

  it('a non-2xx rejects with the kit error, and a dropped connection with network', async () => {
    const a = post({ status: 429, headers: { 'retry-after': '12' }, json: { error: 'rate_limited', message: 'Slow.' } });
    await expect(a.conn.report('1', {})).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 12 });
    a.conn.close();
    const b = post(new Error('down'));
    await expect(b.conn.report('1', {})).rejects.toMatchObject({ code: 'network' });
    b.conn.close();
  });

  it('an answer that is not a report outcome is a bad_response', async () => {
    for (const reply of [{ json: [] }, { json: { ok: 'yes' } }, { json: { ok: false } }, { json: { ok: false, refused: 7 } }, { json: null }] as Reply[]) {
      const { conn } = post(reply);
      await expect(conn.report('1', {})).rejects.toMatchObject({ code: 'bad_response' });
      conn.close();
    }
  });
});

describe('mute resolves true and false', () => {
  it('mute by line id', async () => {
    const { conn, calls } = post({ json: { ok: true } });
    await expect(conn.mute({ lineId: '42' }, true)).resolves.toBe(true);
    expect(calls[0]?.url).toBe('/chat/rooms/lobby/mute');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ lineId: '42', on: true });
    conn.close();
  });

  it('unmute by ref', async () => {
    const { conn, calls } = post({ json: { ok: true } });
    await expect(conn.mute({ ref: 'm_1' }, false)).resolves.toBe(true);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ ref: 'm_1', on: false });
    conn.close();
  });

  it('ok false resolves false (nothing changed)', async () => {
    const { conn } = post({ json: { ok: false } });
    await expect(conn.mute({ lineId: '1' }, true)).resolves.toBe(false);
    conn.close();
  });

  it('a non-boolean ok is a bad_response; a kit error and a dropped connection reject', async () => {
    const a = post({ json: { ok: 'yes' } });
    await expect(a.conn.mute({ lineId: '1' }, true)).rejects.toMatchObject({ code: 'bad_response' });
    a.conn.close();
    const b = post({ status: 403, json: { error: 'forbidden', message: 'No.' } });
    await expect(b.conn.mute({ lineId: '1' }, true)).rejects.toMatchObject({ code: 'forbidden' });
    b.conn.close();
    const c = post(new TypeError('x'));
    await expect(c.conn.mute({ lineId: '1' }, true)).rejects.toMatchObject({ code: 'network' });
    c.conn.close();
  });

  it('the room id is encoded in every call', async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn((url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ ok: false, refused: { reason: 'x' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const conn = sseTransport({ baseUrl: '/chat', fetch: fetchFn as unknown as typeof fetch }).open('a b/c', { frame: () => undefined, status: () => undefined });
    await conn.send('hi');
    await conn.mute({ lineId: '1' }, true);
    await conn.report('1', {}).catch(() => undefined);
    expect(calls.filter((u) => !u.endsWith('/stream'))).toEqual(['/chat/rooms/a%20b%2Fc/lines', '/chat/rooms/a%20b%2Fc/mute', '/chat/rooms/a%20b%2Fc/report']);
    conn.close();
  });
});

describe('the POST calls send content-type application/json', () => {
  it.each([
    ['send', (c: ChatConnection) => c.send('hi'), { json: { ok: true, line: line('1', 'hi', { mine: true }) } }],
    ['mute', (c: ChatConnection) => c.mute({ lineId: '1' }, true), { json: { ok: true } }],
    ['report', (c: ChatConnection) => c.report('1', {}), { json: { ok: true, remaining: 1 } }],
  ] as Array<[string, (c: ChatConnection) => Promise<unknown>, Reply]>)('%s', async (_n, call, reply) => {
    const { conn, calls } = post(reply, { headers: { 'content-type': 'text/plain' } });
    await call(conn);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('application/json');
    expect(typeof calls[0]?.init.body).toBe('string');
    conn.close();
  });
});
