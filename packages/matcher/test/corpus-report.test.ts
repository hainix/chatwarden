import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCommunityShare, signedMessage, type CommunityShare, type ReportInput } from '../src/corpus/index.js';
import { FakeSchedule } from './corpus-loader-world.js';

// "Report a problem with this community term" (design 10.6): one signed POST of a term id and a closed kind. No free text, no word, no
// stamp. Same discipline as the share client: a deadline, an abort, a bounded answer, closed codes, nothing the service says passed on.

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

// 2026-12-02T10:30:00Z
const T = Date.UTC(2026, 11, 2, 10, 30, 0);

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  init: RequestInit;
}

const SECRETS = ['CLIENTKEY-secret-9f3a', 'subj_secret_41', '203.0.113.77', 'room-secret-lobby', 'a secret chat line zorbak you', 'free text from a person'];

interface World {
  share: CommunityShare;
  sent: Sent[];
  warn: ReturnType<typeof vi.fn>;
  publicKey: string;
  sign: ReturnType<typeof vi.fn>;
  verify(message: Uint8Array, signature: string): Promise<boolean>;
  respond: (r: Response | (() => Promise<Response>)) => void;
  schedule: FakeSchedule;
}

async function world(over: { kit?: string; clockAt?: number; fetchImpl?: typeof fetch; sign?: (m: Uint8Array) => Promise<string>; endpoint?: string } = {}): Promise<World> {
  const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const publicKey = b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const sign = vi.fn(over.sign ?? (async (m: Uint8Array) => b64u(new Uint8Array(await subtle.sign('Ed25519', pair.privateKey, m)))));
  const sent: Sent[] = [];
  let next: Response | (() => Promise<Response>) = new Response(JSON.stringify({ id: 'rep_abc123', status: 'received' }), { status: 202 });
  const warn = vi.fn();
  const schedule = new FakeSchedule();
  const fetchImpl: typeof fetch =
    over.fetchImpl ??
    (async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const body = init?.body === undefined || init.body === null ? null : new Uint8Array(init.body as Uint8Array);
      sent.push({ url: String(url), method: init?.method ?? 'GET', headers, body, init: init ?? {} });
      return typeof next === 'function' ? next() : next.clone();
    });
  const share = createCommunityShare({
    ...(over.endpoint === undefined ? {} : { endpoint: over.endpoint }),
    ...(over.kit === undefined ? {} : { kit: over.kit }),
    stampBits: 8,
    sign,
    publicKey,
    fetch: fetchImpl,
    clock: { now: () => over.clockAt ?? T },
    logger: { warn },
    schedule,
  });
  return {
    share,
    sent,
    warn,
    publicKey,
    sign,
    schedule,
    respond: (r) => {
      next = r;
    },
    verify: async (message, signature) => subtle.verify('Ed25519', pair.publicKey, Buffer.from(signature, 'base64url'), message),
  };
}

const input = (over: Record<string, unknown> = {}): ReportInput => ({ termId: 'CWT-2026-00042', kind: 'innocent_sense', ...over }) as ReportInput;
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const sentBody = (w: World): Record<string, unknown> => JSON.parse(dec.decode(w.sent[0]!.body!)) as Record<string, unknown>;

describe('signedMessage knows the report kind', () => {
  it('a report signature differs from a submission signature over the same bytes, and an unknown kind is still refused', () => {
    const bytes = enc.encode('{}');
    expect(signedMessage('report', bytes)).not.toEqual(signedMessage('submission', bytes));
    expect(dec.decode(signedMessage('report', bytes))).toBe('chatwarden-corpus/1\u0000report\u0000{}');
    expect(() => signedMessage('reports' as 'report', bytes)).toThrow(RangeError);
  });
});

describe('the report payload', () => {
  it('is exactly schema, termId, kind, day and kit, in that order; extra keys on the input are never sent', async () => {
    const w = await world({ kit: '0.1.11' });
    const res = await w.share.report(
      input({ term: 'zorbak', note: SECRETS[5], line: SECRETS[4], clientKey: SECRETS[0], subject: SECRETS[1], ip: SECRETS[2], room: SECRETS[3], day: '1999-01-01', kit: '9.9.9', schema: 'x' }),
    );
    expect(res).toEqual({ ok: true, id: 'rep_abc123' });
    expect(Object.keys(sentBody(w))).toEqual(['schema', 'termId', 'kind', 'day', 'kit']);
    expect(sentBody(w)).toEqual({ schema: 'chatwarden-corpus-report/1', termId: 'CWT-2026-00042', kind: 'innocent_sense', day: '2026-12-02', kit: '0.1.11' });
    const everything = JSON.stringify({ sent: w.sent.map((s) => ({ ...s, body: dec.decode(s.body!), init: undefined })) });
    for (const secret of [...SECRETS, 'zorbak']) expect(everything).not.toContain(secret);
  });

  it.each(['innocent_sense', 'wrong_category', 'removal'] as const)('%s is a kind', async (kind) => {
    const w = await world();
    expect((await w.share.report(input({ kind }))).ok).toBe(true);
    expect(sentBody(w).kind).toBe(kind);
  });

  it('refuses before anything is signed or sent: a kind outside the list, a term id that is not one, a missing or odd input', async () => {
    const w = await world();
    const bad: unknown[] = [
      input({ kind: 'spam' }),
      input({ kind: undefined }),
      input({ kind: 'INNOCENT_SENSE' }),
      input({ kind: ['removal'] }),
      input({ termId: 'zorbak' }),
      input({ termId: 'cwt-2026-00042' }),
      input({ termId: 'CWT-2026-0042' }),
      input({ termId: 'CWT-2026-000420' }),
      input({ termId: 'CWT-2026-00042 ' }),
      input({ termId: '../CWT-2026-00042' }),
      input({ termId: 'CWT-2026-00042\n' }),
      input({ termId: 42 }),
      input({ termId: undefined }),
      {},
      null,
      undefined,
      'removal',
      42,
    ];
    for (const b of bad) expect(await w.share.report(b as ReportInput), JSON.stringify(b)).toEqual({ ok: false, code: 'invalid' });
    expect(w.sent).toHaveLength(0);
    expect(w.sign).not.toHaveBeenCalled();
  });

  it('a getter that throws or changes between reads cannot break it or smuggle a key', async () => {
    const w = await world();
    const throwing = {
      get termId(): string {
        throw new Error(SECRETS[5]);
      },
      kind: 'removal',
    };
    expect(await w.share.report(throwing as unknown as ReportInput)).toEqual({ ok: false, code: 'invalid' });
    let reads = 0;
    const flipping = {
      get termId(): string {
        reads += 1;
        return reads === 1 ? 'CWT-2026-00042' : 'zorbak';
      },
      kind: 'removal',
    };
    const res = await w.share.report(flipping as unknown as ReportInput);
    expect(res.ok).toBe(true);
    expect(reads).toBe(1);
    expect(sentBody(w).termId).toBe('CWT-2026-00042');
  });

  it('the day is a calendar day from the injected clock, never a time; a clock that gives nothing is invalid', async () => {
    const w = await world({ clockAt: Date.UTC(2027, 0, 1, 23, 59, 59) });
    await w.share.report(input());
    expect(sentBody(w).day).toBe('2027-01-01');
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = await world({ clockAt: at });
      expect(await bad.share.report(input())).toEqual({ ok: false, code: 'invalid' });
      expect(bad.sent).toHaveLength(0);
    }
  });
});

describe('the report request', () => {
  it('posts to /v1/reports with the key and a signature over signedMessage(report, body); no stamp; no ambient identity', async () => {
    const w = await world({ endpoint: 'https://corpus.example.test/' });
    await w.share.report(input());
    const [s] = w.sent;
    expect(s!.url).toBe('https://corpus.example.test/v1/reports');
    expect(s!.method).toBe('POST');
    expect(Object.keys(s!.headers).sort()).toEqual(['content-type', 'x-cw-key', 'x-cw-sig']);
    expect(s!.headers['content-type']).toBe('application/json');
    expect(s!.headers['x-cw-key']).toBe(w.publicKey);
    expect(s!.init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    expect(await w.verify(signedMessage('report', s!.body!), s!.headers['x-cw-sig']!)).toBe(true);
    // The same bytes under another kind do not verify: a share signature cannot be replayed as a report, nor the other way round.
    expect(await w.verify(signedMessage('submission', s!.body!), s!.headers['x-cw-sig']!)).toBe(false);
    expect(await w.verify(signedMessage('report', enc.encode('{}')), s!.headers['x-cw-sig']!)).toBe(false);
  });

  it('the bytes that were signed are the bytes that were sent, and the body is far under 2 KiB', async () => {
    const w = await world();
    await w.share.report(input());
    expect(w.sign).toHaveBeenCalledTimes(1);
    expect(dec.decode((w.sign.mock.calls[0]![0] as Uint8Array).slice(-w.sent[0]!.body!.length))).toBe(dec.decode(w.sent[0]!.body!));
    expect(w.sent[0]!.body!.length).toBeLessThan(300);
  });

  it('two reports at once are independent', async () => {
    const w = await world();
    const [a, b] = await Promise.all([w.share.report(input({ kind: 'removal' })), w.share.report(input({ termId: 'CWT-2026-00043', kind: 'wrong_category' }))]);
    expect(a.ok && b.ok).toBe(true);
    const bodies = w.sent.map((s) => JSON.parse(dec.decode(s.body!)) as Record<string, unknown>).sort((x, y) => String(x.termId).localeCompare(String(y.termId)));
    expect(bodies.map((x) => [x.termId, x.kind])).toEqual([
      ['CWT-2026-00042', 'removal'],
      ['CWT-2026-00043', 'wrong_category'],
    ]);
  });
});

describe('what the service answers to a report', () => {
  const cases: [string, Response | (() => Promise<Response>), Record<string, unknown>][] = [
    ['202 received', json(202, { id: 'rep_a1B2', status: 'received' }), { ok: true, id: 'rep_a1B2' }],
    ['202 with no id', json(202, { status: 'received' }), { ok: true }],
    ['200 duplicate (one open report a day collapses)', json(200, { status: 'duplicate' }), { ok: true }],
    ['an id that is not an id', json(202, { id: '<script>', status: 'received' }), { ok: true }],
    ['400 invalid', json(400, { error: 'invalid' }), { ok: false, code: 'invalid' }],
    ['400 with an error we do not know', json(400, { error: 'new_thing' }), { ok: false, code: 'rejected' }],
    ['400 with no JSON', json(400, 'nope'), { ok: false, code: 'rejected' }],
    ['401', json(401, { error: 'signature' }), { ok: false, code: 'rejected' }],
    ['403', json(403, {}), { ok: false, code: 'rejected' }],
    ['404 (a term the service does not know)', json(404, {}), { ok: false, code: 'rejected' }],
    ['413', json(413, {}), { ok: false, code: 'rejected' }],
    ['429 with retry-after in seconds', json(429, {}, { 'retry-after': '120' }), { ok: false, code: 'rate_limited', retryAfterMs: 120_000 }],
    ['429 with no retry-after', json(429, {}), { ok: false, code: 'rate_limited' }],
    ['429 with a retry-after that is a date', json(429, {}, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), { ok: false, code: 'rate_limited' }],
    ['429 with a huge retry-after (capped at a day)', json(429, {}, { 'retry-after': '99999999' }), { ok: false, code: 'rate_limited', retryAfterMs: 86_400_000 }],
    ['500', json(500, 'oops'), { ok: false, code: 'offline' }],
    ['503', json(503, {}), { ok: false, code: 'offline' }],
    ['a 200 that is a web page', new Response('<html>portal</html>', { status: 200 }), { ok: false, code: 'rejected' }],
    ['a 200 with an unknown status', json(200, { status: 'maybe' }), { ok: false, code: 'rejected' }],
    ['a 202 with the wrong status', json(202, { status: 'duplicate' }), { ok: false, code: 'rejected' }],
    ['a JSON array', json(200, ['received']), { ok: false, code: 'rejected' }],
    ['a body over the cap (8 KiB)', new Response('x'.repeat(9000), { status: 202 }), { ok: false, code: 'rejected' }],
    ['a thrown fetch', () => Promise.reject(new TypeError('fetch failed')), { ok: false, code: 'offline' }],
    ['a fetch that throws synchronously', () => { throw new Error('sync'); }, { ok: false, code: 'offline' }],
    ['a "response" that is not one', () => Promise.resolve({ nothing: true } as unknown as Response), { ok: false, code: 'offline' }],
  ];
  it.each(cases)('%s maps to a closed result with no service text', async (_label, answer, expected) => {
    const w = await world();
    w.respond(answer);
    const res = await w.share.report(input());
    expect(res).toEqual(expected);
    expect(Object.keys(res).every((k) => ['ok', 'id', 'code', 'retryAfterMs'].includes(k))).toBe(true);
    if (!res.ok) expect(w.warn).toHaveBeenCalledWith('corpus.report_failed', { code: res.code });
    else expect(w.warn).not.toHaveBeenCalled();
  });

  it('no seeded text appears in a result or a log line, whatever the service says or the transport throws', async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => json(202, { id: 'rep_1', status: 'received', note: SECRETS[5] }),
      () => json(400, { error: 'invalid', message: `bad ${SECRETS[4]}` }),
      () => json(401, { detail: SECRETS[2] }),
      () => json(429, { note: SECRETS[1] }, { 'retry-after': '30' }),
      () => json(500, `stack with ${SECRETS[3]}`),
      () => Promise.reject(new TypeError(`connect ECONNREFUSED ${SECRETS[2]}:443`)),
    ];
    for (const answer of answers) {
      const w = await world();
      w.respond(answer as () => Promise<Response>);
      const res = await w.share.report(input());
      const everything = JSON.stringify({ res, logs: w.warn.mock.calls });
      for (const secret of SECRETS) expect(everything).not.toContain(secret);
      for (const call of w.warn.mock.calls) expect(Object.keys(call[1] as object)).toEqual(['code']);
    }
    const w = await world({ sign: async () => { throw new Error(`HSM refused for ${SECRETS[0]}`); } });
    expect(await w.share.report(input())).toEqual({ ok: false, code: 'rejected' });
    expect(JSON.stringify(w.warn.mock.calls)).not.toContain(SECRETS[0]);
    expect(w.sent).toHaveLength(0);
  });

  it('a logger that throws, or returns a rejecting promise, never breaks a report', async () => {
    const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const publicKey = b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
    for (const warn of [() => { throw new Error('log'); }, () => Promise.reject(new Error('log'))]) {
      const share = createCommunityShare({
        sign: async (m) => b64u(new Uint8Array(await subtle.sign('Ed25519', pair.privateKey, m))),
        publicKey,
        fetch: async () => json(500, {}),
        clock: { now: () => T },
        logger: { warn },
        schedule: new FakeSchedule(),
      });
      expect(await share.report(input())).toEqual({ ok: false, code: 'offline' });
    }
  });
});

describe('every report carries a deadline, and is aborted when it passes', () => {
  it('the request gets an AbortSignal, aborted at 15 seconds; a fetch that honours it ends as offline; its timer is cancelled when it answers', async () => {
    const signals: AbortSignal[] = [];
    const hang: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const w = await world({ fetchImpl: hang });
    const pending = w.share.report(input());
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(w.schedule.delays).toEqual([15_000]);
    expect(signals[0]?.aborted).toBe(false);
    w.schedule.advance(15_000);
    expect(await pending).toEqual({ ok: false, code: 'offline' });
    expect(signals[0]?.aborted).toBe(true);

    const ok = await world();
    expect((await ok.share.report(input())).ok).toBe(true);
    expect(ok.schedule.timers).toHaveLength(0);
    const signal = ok.sent[0]?.init.signal as AbortSignal;
    ok.schedule.advance(60_000);
    expect(signal.aborted).toBe(false);
  });

  it('a fetch that ignores the signal still ends at the deadline', async () => {
    let calls = 0;
    const w = await world({ fetchImpl: () => { calls += 1; return new Promise<Response>(() => {}); } });
    const pending = w.share.report(input());
    await vi.waitFor(() => expect(calls).toBe(1));
    w.schedule.advance(15_000);
    expect(await pending).toEqual({ ok: false, code: 'offline' });
  });

  it('a sign function that never answers is a refused report after the deadline, and nothing is sent', async () => {
    const w = await world({ sign: () => new Promise<string>(() => {}) });
    const pending = w.share.report(input());
    await vi.waitFor(() => expect(w.schedule.delays).toEqual([15_000]));
    w.schedule.advance(15_000);
    expect(await pending).toEqual({ ok: false, code: 'rejected' });
    expect(w.sent).toHaveLength(0);
  });

  it('the answer is read with a ceiling: a stream that never ends is cut at 8 KiB and refused, not held', async () => {
    let pulls = 0;
    const endless = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1024).fill(120));
        },
      }),
      { status: 202 },
    );
    const w = await world();
    w.respond(endless);
    expect(await w.share.report(input())).toEqual({ ok: false, code: 'rejected' });
    expect(pulls).toBeLessThan(40);
  });
});

describe('the module', () => {
  it('has no Date.now and no word that trips the browser bundle test, and the share and status calls are unchanged', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/corpus/share.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Date\.now|new Date\(\)|performance\.now/);
    expect(source).not.toMatch(/\b(process|require)\b/);
    const w = await world();
    expect(typeof w.share.share).toBe('function');
    expect(typeof w.share.status).toBe('function');
    expect(typeof w.share.report).toBe('function');
  });
});
