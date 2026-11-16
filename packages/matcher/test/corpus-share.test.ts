import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkStamp, createCommunityShare, mintStamp, signedMessage, type CommunityShare, type ShareInput } from '../src/corpus/index.js';
import { leadingZeroBitsAfter } from '../src/corpus/sha256.js';
import { FakeSchedule, settle } from './corpus-loader-world.js';

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

// 2026-12-02T10:30:00Z
const T = Date.UTC(2026, 11, 2, 10, 30, 0);
const clock = (t = T) => ({ t, now() { return this.t; } });

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  init: RequestInit;
}

/** Identifiers a careless implementation could leak: none of these may appear anywhere in what is sent, returned or logged. */
const SECRETS = ['CLIENTKEY-secret-9f3a', 'subj_secret_41', 'seat-7-secret', 'acct_secret_12', '203.0.113.77', 'room-secret-lobby', 'a secret chat line zorbak you', 'Player_Handle_Secret', 'evidence-buffer-secret'];

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

async function world(over: { endpoint?: string; kit?: string; stampBits?: number; clock?: { now(): number }; fetchImpl?: typeof fetch; sign?: (m: Uint8Array) => Promise<string> } = {}): Promise<World> {
  const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const publicKey = b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const sign = vi.fn(over.sign ?? (async (m: Uint8Array) => b64u(new Uint8Array(await subtle.sign('Ed25519', pair.privateKey, m)))));
  const sent: Sent[] = [];
  let next: Response | (() => Promise<Response>) = new Response(JSON.stringify({ id: 'sub_abc123', status: 'received' }), { status: 202 });
  const warn = vi.fn();
  const schedule = new FakeSchedule();
  const fetchImpl: typeof fetch =
    over.fetchImpl ??
    (async (input, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const body = init?.body === undefined || init.body === null ? null : new Uint8Array(init.body as Uint8Array);
      sent.push({ url: String(input), method: init?.method ?? 'GET', headers, body, init: init ?? {} });
      return typeof next === 'function' ? next() : next.clone();
    });
  const share = createCommunityShare({
    ...(over.endpoint === undefined ? {} : { endpoint: over.endpoint }),
    ...(over.kit === undefined ? {} : { kit: over.kit }),
    // Most tests do not need the real work; the ones about the stamp ask for the design's 16 bits.
    stampBits: over.stampBits ?? 8,
    sign,
    publicKey,
    fetch: fetchImpl,
    clock: over.clock ?? clock(),
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

const input = (over: Partial<ShareInput> & Record<string, unknown> = {}): ShareInput => ({ term: 'zorbak', language: 'en', category: 'slur', target: 'ethnicity', note: null, ...over }) as ShareInput;
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const sentBody = (w: World): Record<string, unknown> => JSON.parse(dec.decode(w.sent[0]!.body!)) as Record<string, unknown>;

describe('payload', () => {
  it('exactly the allowed keys, in a snapshot; extra keys on the input (client key, subject, line, hits) are not sent', async () => {
    const w = await world({ kit: '0.1.11' });
    const hostile = input({
      clientKey: SECRETS[0],
      subject: SECRETS[1],
      seat: SECRETS[2],
      accountId: SECRETS[3],
      ip: SECRETS[4],
      room: SECRETS[5],
      line: SECRETS[6],
      handle: SECRETS[7],
      hits: [SECRETS[6]],
      evidence: SECRETS[8],
      schema: 'something-else',
      day: '1999-01-01',
      kit: '9.9.9',
      __proto__: { injected: true },
    });
    const res = await w.share.share(hostile);
    expect(res).toEqual({ ok: true, status: 'received', id: 'sub_abc123' });
    expect(w.sent).toHaveLength(1);
    expect(Object.keys(sentBody(w))).toEqual(['schema', 'term', 'language', 'category', 'target', 'note', 'day', 'kit']);
    expect(sentBody(w)).toMatchInlineSnapshot(`
      {
        "category": "slur",
        "day": "2026-12-02",
        "kit": "0.1.11",
        "language": "en",
        "note": null,
        "schema": "chatwarden-corpus-submission/1",
        "target": "ethnicity",
        "term": "zorbak",
      }
    `);
    // The serialised text is in the same key order, with no whitespace.
    expect(dec.decode(w.sent[0]!.body!)).toBe('{"schema":"chatwarden-corpus-submission/1","term":"zorbak","language":"en","category":"slur","target":"ethnicity","note":null,"day":"2026-12-02","kit":"0.1.11"}');
  });

  it('a getter or a proxy on the input is read once and cannot smuggle a key', async () => {
    const w = await world();
    let reads = 0;
    const tricky = {
      get term() {
        reads += 1;
        return 'zorbak';
      },
      language: 'en',
      category: 'abuse',
    };
    const res = await w.share.share(tricky as unknown as ShareInput);
    expect(res.ok).toBe(true);
    expect(reads).toBe(1);
    expect(sentBody(w)).toMatchObject({ term: 'zorbak', target: 'none', note: null });
    const proxy = new Proxy(input(), { ownKeys: () => ['term', 'language', 'category', 'clientKey'], get: (t, k) => (k === 'clientKey' ? SECRETS[0] : Reflect.get(t, k)) });
    expect((await w.share.share(proxy as ShareInput)).ok).toBe(true);
    expect(dec.decode(w.sent[1]!.body!)).not.toContain(SECRETS[0]);
    const boom = new Proxy({}, { get: () => { throw new Error('boom'); } });
    expect(await w.share.share(boom as unknown as ShareInput)).toEqual({ ok: false, code: 'invalid' });
    expect(w.sent).toHaveLength(2);
  });

  it('no seeded identifier appears in the body, the headers, a result, an error or a log line: client key, subject id, seat, account, IP, room, a chat line, a handle', async () => {
    const seeded = input({ clientKey: SECRETS[0], subject: SECRETS[1], seat: SECRETS[2], accountId: SECRETS[3], ip: SECRETS[4], room: SECRETS[5], line: SECRETS[6], handle: SECRETS[7], evidence: SECRETS[8] });
    const answers: [string, () => Response | Promise<Response>][] = [
      ['202', () => json(202, { id: 'sub_1', status: 'received' })],
      ['known', () => json(200, { status: 'known', termId: 'CWT-2026-00042' })],
      ['duplicate', () => json(200, { status: 'duplicate' })],
      ['400', () => json(400, { error: 'invalid', message: `bad ${SECRETS[6]}` })],
      ['401', () => json(401, { error: 'signature', detail: SECRETS[4] })],
      ['429', () => json(429, { note: SECRETS[1] }, { 'retry-after': '30' })],
      ['500', () => json(500, `stack trace with ${SECRETS[5]}`)],
      ['html', () => new Response(`<html>${SECRETS[7]}</html>`, { status: 200 })],
      ['throw', () => Promise.reject(new TypeError(`connect ECONNREFUSED ${SECRETS[4]}:443 ${SECRETS[5]}`))],
    ];
    for (const [label, answer] of answers) {
      const w = await world();
      w.respond(answer as () => Promise<Response>);
      const res = await w.share.share(seeded);
      const everything = JSON.stringify({ res, sent: w.sent.map((s) => ({ ...s, body: s.body === null ? null : dec.decode(s.body), init: undefined })), logs: w.warn.mock.calls }) + String(w.sign.mock.calls.map((c) => dec.decode(c[0] as Uint8Array)));
      for (const secret of SECRETS) expect(everything, `${label}: ${secret}`).not.toContain(secret);
      // The headers are exactly these four, whatever the answer was.
      expect(Object.keys(w.sent[0]!.headers).sort()).toEqual(['content-type', 'x-cw-key', 'x-cw-sig', 'x-cw-stamp']);
      expect(w.sent[0]!.headers['content-type']).toBe('application/json');
      expect(w.sent[0]!.headers['x-cw-key']).toBe(w.publicKey);
      // The request carries no ambient identity.
      expect(w.sent[0]!.init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
      // A failed share logs a closed code and nothing else.
      for (const call of w.warn.mock.calls) {
        expect(call[0]).toBe('corpus.share_failed');
        expect(Object.keys(call[1] as object)).toEqual(['code']);
      }
    }
    // An error inside the caller's own sign function: the result and the log still carry no text of it.
    const w = await world({ sign: async () => { throw new Error(`HSM refused for ${SECRETS[3]}`); } });
    const res = await w.share.share(seeded);
    expect(res).toEqual({ ok: false, code: 'rejected' });
    expect(JSON.stringify(w.warn.mock.calls)).not.toContain(SECRETS[3]);
    expect(w.sent).toHaveLength(0);
  });
});

describe('what is checked before anything is sent', () => {
  it('day is a calendar day from the injected clock, never a time', async () => {
    const cases: [number, string][] = [
      [Date.UTC(2026, 11, 2, 23, 59, 59, 999), '2026-12-02'],
      [Date.UTC(2026, 11, 3, 0, 0, 0, 0), '2026-12-03'],
      [Date.UTC(2027, 0, 1, 0, 0, 0, 0), '2027-01-01'],
      [Date.UTC(2028, 1, 29, 12, 0, 0, 0), '2028-02-29'],
    ];
    for (const [t, day] of cases) {
      const w = await world({ clock: clock(t) });
      await w.share.share(input());
      const body = sentBody(w);
      expect(body.day).toBe(day);
      expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(dec.decode(w.sent[0]!.body!)).not.toMatch(/\d{2}:\d{2}/);
    }
    // The clock is read at each call, and a clock that gives nonsense sends nothing.
    const moving = clock(Date.UTC(2026, 11, 2, 12));
    const w = await world({ clock: moving });
    await w.share.share(input());
    moving.t = Date.UTC(2026, 11, 5, 12);
    await w.share.share(input({ term: 'vlemmo' }));
    expect(w.sent.map((s) => (JSON.parse(dec.decode(s.body!)) as { day: string }).day)).toEqual(['2026-12-02', '2026-12-05']);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1e18, 1e18]) {
      const b = await world({ clock: clock(bad) });
      expect(await b.share.share(input())).toEqual({ ok: false, code: 'invalid' });
      expect(b.sent).toHaveLength(0);
    }
  });

  it('note: 200 characters ok, 201 refused; a URL, an @name, a 5-digit run: refused; null ok', async () => {
    const ok = ['x'.repeat(200), null, undefined, '', '   ', 'heard in a match, aimed at a team', 'cost 1234 gold', 'one 2 three 4 five 5', 'wait... what', 'a.b', 'end of line.Yes', '1.2.3.4'.slice(0, 3)];
    for (const note of ok) {
      const w = await world();
      const res = await w.share.share(input({ note }));
      expect(res.ok, JSON.stringify(note)).toBe(true);
      expect((sentBody(w).note === null || typeof sentBody(w).note === 'string') && String(sentBody(w).note ?? '').length <= 200).toBe(true);
    }
    const bad: unknown[] = [
      'x'.repeat(201),
      'see http://example.test/a',
      'see https://example.test',
      'ftp://x.test',
      'visit www.example.test now',
      'look at example.com/page',
      'try example.com',
      'mail me at name@example.test',
      '@someone said it',
      'a @ b',
      'ping 12345',
      'id 1234567890',
      'room 98765 again',
      'two\nlines',
      `tab${String.fromCharCode(9)}here`,
      `nul${String.fromCharCode(0)}here`,
      5,
      {},
      ['a'],
      true,
    ];
    for (const note of bad) {
      const w = await world();
      expect(await w.share.share(input({ note: note as string })), JSON.stringify(note)).toEqual({ ok: false, code: 'invalid' });
      expect(w.sent, JSON.stringify(note)).toHaveLength(0);
    }
    // The note is sent trimmed, as typed otherwise.
    const w = await world();
    await w.share.share(input({ note: '  said in chat to a new player  ' }));
    expect(sentBody(w).note).toBe('said in chat to a new player');
  });

  it('the word, language, category and target are checked: plain letters in one word, a language tag, the closed lists', async () => {
    const good: [Partial<ShareInput>, Record<string, unknown>][] = [
      [{ term: '  Zorbak ' }, { term: 'Zorbak' }],
      [{ term: 'z\u00f3rbak' }, { term: 'z\u00f3rbak' }],
      [{ term: 'zorbak'.repeat(6) + 'zorb' }, {}],
      [{ language: 'ES' }, { language: 'es' }],
      [{ language: 'pt-BR' }, { language: 'pt' }],
      [{ language: 'pt_br' }, { language: 'pt' }],
      [{ category: 'abuse', target: undefined }, { category: 'abuse', target: 'none' }],
      [{ category: 'sexual', target: 'gender' }, { target: 'gender' }],
      [{ category: 'other', target: 'other' }, { category: 'other' }],
    ];
    for (const [over, expected] of good) {
      const w = await world();
      const res = await w.share.share(input(over));
      expect(res.ok, JSON.stringify(over)).toBe(true);
      expect(sentBody(w), JSON.stringify(over)).toMatchObject(expected);
    }
    const bad: Partial<ShareInput>[] = [
      { term: '' }, { term: '   ' }, { term: 'two words' }, { term: 'ab' }, { term: 'aab' }, { term: 'zorbak'.repeat(7) }, { term: 'zorbak1' }, { term: 'zor-bak' }, { term: 'zor_bak' },
      { term: '\uff5aorbak' }, { term: 'zorbak!' }, { term: 'http://zorbak' }, { term: 'zor\u200bbak' }, { term: 5 as unknown as string }, { term: null as unknown as string }, { term: undefined as unknown as string },
      { language: '' }, { language: 'english' }, { language: 'e' }, { language: '12' }, { language: 'en/../x' }, { language: 5 as unknown as string },
      { category: 'hate' as 'slur' }, { category: '' as 'slur' }, { category: undefined as unknown as 'slur' }, { category: 'SLUR' as 'slur' },
      { target: 'race' }, { target: '' }, { target: 'none ' }, { target: 5 as unknown as string },
    ];
    for (const over of bad) {
      const w = await world();
      expect(await w.share.share(input(over)), JSON.stringify(over)).toEqual({ ok: false, code: 'invalid' });
      expect(w.sent, JSON.stringify(over)).toHaveLength(0);
    }
    for (const notInput of [null, undefined, 'zorbak', 5, []]) {
      const w = await world();
      expect(await w.share.share(notInput as unknown as ShareInput)).toEqual({ ok: false, code: 'invalid' });
      expect(w.sent).toHaveLength(0);
    }
  });
});

describe('the signature and the stamp', () => {
  it('the signature verifies over signedMessage(submission, body); a changed body fails; the stamp meets the bit count', async () => {
    const w = await world({ stampBits: 16 });
    await w.share.share(input());
    const sent = w.sent[0]!;
    const body = sent.body!;
    // The very bytes that were sent are the bytes that were signed: sign() was called once, with the message built from them.
    expect(w.sign).toHaveBeenCalledTimes(1);
    expect(w.sign.mock.calls[0]![0]).toEqual(signedMessage('submission', body));
    expect(await w.verify(signedMessage('submission', body), sent.headers['x-cw-sig']!)).toBe(true);
    const changed = body.slice();
    changed[changed.length - 3] = (changed[changed.length - 3] as number) ^ 1;
    expect(await w.verify(signedMessage('submission', changed), sent.headers['x-cw-sig']!)).toBe(false);
    expect(await w.verify(signedMessage('zip', body), sent.headers['x-cw-sig']!)).toBe(false);
    expect(await w.verify(body, sent.headers['x-cw-sig']!)).toBe(false);
    expect(sent.headers['x-cw-sig']).toMatch(/^[A-Za-z0-9_-]{86}$/);
    // The stamp is minted over those same bytes, at 16 bits.
    const stamp = sent.headers['x-cw-stamp']!;
    expect(stamp).toMatch(/^16:[A-Za-z0-9_-]{1,32}$/);
    expect(checkStamp(body, stamp, 16)).toBe(true);
    expect(checkStamp(changed, stamp, 16)).toBe(false);
    // Computed independently with node:crypto.
    const nonce = stamp.slice(3);
    const digest = createHash('sha256').update(body).update(nonce).digest();
    expect(digest[0]).toBe(0);
    expect(digest[1]).toBe(0);
    // The body is sent once and as bytes, not as text that could be re-serialised.
    expect(w.sent[0]!.body).toBeInstanceOf(Uint8Array);
    // The public key is the caller's, as given.
    expect(sent.headers['x-cw-key']).toBe(w.publicKey);
  });

  it('mintStamp and checkStamp: the bit count is met exactly, one bit short is refused, and malformed stamps are refused', () => {
    const body = enc.encode('{"a":"body that is signed"}');
    for (const bits of [0, 1, 4, 8, 12, 16]) {
      const stamp = mintStamp(body, bits);
      expect(stamp.startsWith(`${bits}:`), String(bits)).toBe(true);
      expect(checkStamp(body, stamp, bits), String(bits)).toBe(true);
      const zeros = leadingZeroBitsAfter(body)(enc.encode(stamp.slice(stamp.indexOf(':') + 1)));
      expect(zeros).toBeGreaterThanOrEqual(bits);
      // A stamp minted for fewer bits does not meet a higher requirement, one bit short included.
      if (bits > 0) expect(checkStamp(body, mintStamp(body, bits - 1), bits)).toBe(false);
    }
    // A stamp that CLAIMS 16 bits but whose hash has fewer is refused: find a nonce that has exactly 12 zero bits and claim 16.
    const real = leadingZeroBitsAfter(body);
    let n = 0;
    while (real(enc.encode(n.toString(36))) !== 12) n += 1;
    expect(checkStamp(body, `12:${n.toString(36)}`, 12)).toBe(true);
    expect(checkStamp(body, `16:${n.toString(36)}`, 16)).toBe(false);
    expect(checkStamp(body, `13:${n.toString(36)}`, 13)).toBe(false);
    // The requirement is the caller's, not the stamp's claim.
    expect(checkStamp(body, `12:${n.toString(36)}`, 13)).toBe(false);
    // One bit of the body changes the work.
    const other = body.slice();
    other[5] = (other[5] as number) ^ 1;
    expect(checkStamp(other, mintStamp(body, 16), 16)).toBe(false);
    for (const bad of ['', 'x', '16', '16:', ':abc', '16:a b', '16:a:b', '-1:a', '1.5:a', '99:a', 'sixteen:a', '016:a', `16:${'a'.repeat(33)}`, '16:\u00e9']) {
      expect(checkStamp(body, bad, 0), JSON.stringify(bad)).toBe(false);
    }
    for (const notStamp of [null, undefined, 16, {}, ['16:a']]) expect(checkStamp(body, notStamp as unknown as string, 0)).toBe(false);
    expect(() => mintStamp(body, -1)).toThrow(RangeError);
    expect(() => mintStamp(body, 1.5)).toThrow(RangeError);
    expect(() => mintStamp(body, 40)).toThrow(RangeError);
    expect(() => mintStamp(body, Number.NaN)).toThrow(RangeError);
    expect(() => mintStamp('text' as unknown as Uint8Array, 8)).toThrow(TypeError);
    expect(() => checkStamp(body, '8:a', 40)).toThrow(RangeError);
  });

  it('the resumable hash agrees with node:crypto for every prefix length around the block edges, and for random data', () => {
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 300, 1000]) {
      const prefix = new Uint8Array(randomBytes(n));
      for (const m of [0, 1, 7, 8, 55, 56, 64]) {
        const suffix = new Uint8Array(randomBytes(m));
        const expected = createHash('sha256').update(prefix).update(suffix).digest();
        let zeros = 0;
        for (const byte of expected) {
          if (byte === 0) zeros += 8;
          else {
            zeros += Math.clz32(byte) - 24;
            break;
          }
        }
        expect(leadingZeroBitsAfter(prefix)(suffix), `${n}+${m}`).toBe(zeros);
      }
    }
    // A view into a larger buffer is read from its own start.
    const big = new Uint8Array(randomBytes(300));
    const view = big.subarray(70, 200);
    const direct = leadingZeroBitsAfter(view.slice())(enc.encode('n'));
    expect(leadingZeroBitsAfter(view)(enc.encode('n'))).toBe(direct);
  });

  it('minting at 16 bits takes well under a second for a real body, and is deterministic', () => {
    const body = enc.encode('{"schema":"chatwarden-corpus-submission/1","term":"zorbak","language":"en","category":"slur","target":"none","note":null,"day":"2026-12-02","kit":"0.1.11"}');
    const started = performance.now();
    const stamp = mintStamp(body, 16);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(mintStamp(body, 16)).toBe(stamp);
    expect(checkStamp(body, stamp, 16)).toBe(true);
  });
});

describe('what the service answers', () => {
  const cases: [string, Response | (() => Promise<Response>), Record<string, unknown>][] = [
    ['202 received', json(202, { id: 'sub_a1B2', status: 'received' }), { ok: true, status: 'received', id: 'sub_a1B2' }],
    ['202 with no id', json(202, { status: 'received' }), { ok: true, status: 'received' }],
    ['200 known (the id is the public term id)', json(200, { status: 'known', termId: 'CWT-2026-00042' }), { ok: true, status: 'known', id: 'CWT-2026-00042' }],
    ['200 duplicate', json(200, { status: 'duplicate' }), { ok: true, status: 'duplicate' }],
    ['400 invalid', json(400, { error: 'invalid' }), { ok: false, code: 'invalid' }],
    ['400 too_large', json(400, { error: 'too_large' }), { ok: false, code: 'too_large' }],
    ['400 unsupported_language', json(400, { error: 'unsupported_language' }), { ok: false, code: 'unsupported_language' }],
    ['400 stamp (the work was not enough: a bug here, not the person)', json(400, { error: 'stamp' }), { ok: false, code: 'rejected' }],
    ['400 with an error we do not know', json(400, { error: 'new_thing' }), { ok: false, code: 'rejected' }],
    ['400 with no JSON', json(400, 'nope'), { ok: false, code: 'rejected' }],
    ['401', json(401, { error: 'signature' }), { ok: false, code: 'rejected' }],
    ['403', json(403, {}), { ok: false, code: 'rejected' }],
    ['404', json(404, {}), { ok: false, code: 'rejected' }],
    ['413', json(413, {}), { ok: false, code: 'too_large' }],
    ['429 with retry-after in seconds', json(429, {}, { 'retry-after': '120' }), { ok: false, code: 'rate_limited', retryAfterMs: 120_000 }],
    ['429 with no retry-after', json(429, {}), { ok: false, code: 'rate_limited' }],
    ['429 with a retry-after that is a date', json(429, {}, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), { ok: false, code: 'rate_limited' }],
    ['429 with a huge retry-after (capped at a day)', json(429, {}, { 'retry-after': '99999999' }), { ok: false, code: 'rate_limited', retryAfterMs: 86_400_000 }],
    ['429 with a negative retry-after', json(429, {}, { 'retry-after': '-5' }), { ok: false, code: 'rate_limited' }],
    ['500', json(500, 'oops'), { ok: false, code: 'offline' }],
    ['503', json(503, {}), { ok: false, code: 'offline' }],
    ['a body that is not JSON on a 200', new Response('<html>portal</html>', { status: 200 }), { ok: false, code: 'rejected' }],
    ['a 200 with an unknown status', json(200, { status: 'maybe' }), { ok: false, code: 'rejected' }],
    ['a 202 with the wrong status', json(202, { status: 'known' }), { ok: false, code: 'rejected' }],
    ['a JSON array', json(200, ['received']), { ok: false, code: 'rejected' }],
    ['a JSON null', json(200, 'null'), { ok: false, code: 'rejected' }],
    ['an id that is not an id', json(202, { id: '<script>', status: 'received' }), { ok: true, status: 'received' }],
    ['a body over the cap (8 KiB)', new Response('x'.repeat(9000), { status: 202 }), { ok: false, code: 'rejected' }],
    ['a thrown fetch', () => Promise.reject(new TypeError('fetch failed')), { ok: false, code: 'offline' }],
    ['a fetch that rejects with a string', () => Promise.reject('refused'), { ok: false, code: 'offline' }],
    ['a fetch that throws synchronously', () => { throw new Error('sync'); }, { ok: false, code: 'offline' }],
    ['a "response" that is not one', () => Promise.resolve({ nothing: true } as unknown as Response), { ok: false, code: 'offline' }],
  ];
  it.each(cases)('%s maps to a ShareResult with no service text', async (_label, answer, expected) => {
    const w = await world();
    w.respond(answer);
    const res = await w.share.share(input());
    expect(res).toEqual(expected);
    // Nothing the service said is in the result: only closed codes and the ids above.
    expect(Object.keys(res).every((k) => ['ok', 'status', 'id', 'code', 'retryAfterMs'].includes(k))).toBe(true);
    expect('message' in res).toBe(false);
    if (!res.ok) expect(w.warn).toHaveBeenCalledWith('corpus.share_failed', { code: res.code });
    else expect(w.warn).not.toHaveBeenCalled();
  });

  it('a request that hangs is offline after 15 seconds, and its timer is cancelled when it does not', async () => {
    const w = await world({ fetchImpl: () => new Promise<Response>(() => {}) });
    const pending = w.share.share(input());
    await vi.waitFor(() => expect(w.schedule.delays).toEqual([15_000]));
    w.schedule.advance(15_000);
    expect(await pending).toEqual({ ok: false, code: 'offline' });
    const ok = await world();
    await ok.share.share(input());
    expect(ok.schedule.timers).toHaveLength(0);
    await settle(1);
  });

  it('two shares at once are independent: each has its own body, signature and stamp', async () => {
    const w = await world();
    const [a, b] = await Promise.all([w.share.share(input({ term: 'zorbak' })), w.share.share(input({ term: 'vlemmo' }))]);
    expect(a.ok && b.ok).toBe(true);
    expect(w.sent).toHaveLength(2);
    const terms = w.sent.map((s) => (JSON.parse(dec.decode(s.body!)) as { term: string }).term).sort();
    expect(terms).toEqual(['vlemmo', 'zorbak']);
    for (const s of w.sent) {
      expect(await w.verify(signedMessage('submission', s.body!), s.headers['x-cw-sig']!)).toBe(true);
      expect(checkStamp(s.body!, s.headers['x-cw-stamp']!, 8)).toBe(true);
    }
  });

  it('posts to the endpoint given (a trailing slash is fine) at /v1/submissions, and to the project service by default', async () => {
    const custom = await world({ endpoint: 'https://corpus.example.test/' });
    await custom.share.share(input());
    expect(custom.sent[0]!.url).toBe('https://corpus.example.test/v1/submissions');
    const dflt = await world();
    await dflt.share.share(input());
    expect(dflt.sent[0]!.url).toBe('https://corpus.chatwarden.dev/v1/submissions');
    const local = await world({ endpoint: 'http://localhost:8787' });
    await local.share.share(input());
    expect(local.sent[0]!.url).toBe('http://localhost:8787/v1/submissions');
  });
});

describe('status(id)', () => {
  it('is a signed GET of the submission; the answer is the closed status and reason, and nothing else', async () => {
    const w = await world();
    w.respond(json(200, { status: 'declined', reason: 'known_innocent', reviewer: 'alice', note: 'free text that never leaves the service' }));
    const res = await w.share.status('sub_abc123');
    expect(res).toEqual({ status: 'declined', reason: 'known_innocent' });
    const sent = w.sent[0]!;
    expect(sent.method).toBe('GET');
    expect(sent.url).toBe('https://corpus.chatwarden.dev/v1/submissions/sub_abc123');
    expect(sent.body).toBeNull();
    expect(Object.keys(sent.headers).sort()).toEqual(['x-cw-key', 'x-cw-sig']);
    expect(sent.headers['x-cw-key']).toBe(w.publicKey);
    expect(await w.verify(signedMessage('submission', enc.encode('sub_abc123')), sent.headers['x-cw-sig']!)).toBe(true);
    expect(await w.verify(signedMessage('submission', enc.encode('sub_other')), sent.headers['x-cw-sig']!)).toBe(false);
    expect(sent.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    for (const status of ['received', 'in_review', 'accepted', 'merged'] as const) {
      w.respond(json(200, { status }));
      expect(await w.share.status('sub_abc123')).toEqual({ status });
    }
    for (const reason of ['known_innocent', 'not_a_term', 'duplicate', 'needs_context', 'other']) {
      w.respond(json(200, { status: 'declined', reason }));
      expect(await w.share.status('sub_abc123')).toEqual({ status: 'declined', reason });
    }
    // A reason outside the closed list is dropped, not passed on.
    w.respond(json(200, { status: 'declined', reason: 'the reviewer said zorbak is fine' }));
    expect(await w.share.status('sub_abc123')).toEqual({ status: 'declined' });
  });

  it('an unknown id is null; a malformed answer is null; so is every failure, and nothing throws', async () => {
    const w = await world();
    const nulls: (Response | (() => Promise<Response>))[] = [
      json(404, {}),
      json(401, {}),
      json(429, {}, { 'retry-after': '3' }),
      json(500, {}),
      json(200, 'not json'),
      json(200, { status: 'weird' }),
      json(200, {}),
      json(200, ['received']),
      json(200, 'null'),
      json(200, { status: 5 }),
      new Response('x'.repeat(9000), { status: 200 }),
      () => Promise.reject(new TypeError('network down')),
      () => { throw new Error('sync'); },
      () => Promise.resolve({} as Response),
    ];
    for (const answer of nulls) {
      w.respond(answer);
      expect(await w.share.status('sub_abc123')).toBeNull();
    }
    // A bad id is never sent anywhere (it could be a path).
    const before = w.sent.length;
    for (const id of ['', 'a/b', '../x', 'sub id', 'sub?x=1', 'sub#x', 'x'.repeat(65), String.fromCharCode(0), 5 as unknown as string, null as unknown as string]) {
      expect(await w.share.status(id), JSON.stringify(id)).toBeNull();
    }
    expect(w.sent).toHaveLength(before);
    // A failing sign function is a null, with no text.
    const broken = await world({ sign: async () => { throw new Error(`HSM refused for ${SECRETS[3]}`); } });
    expect(await broken.share.status('sub_abc123')).toBeNull();
    expect(broken.sent).toHaveLength(0);
    expect(JSON.stringify(broken.warn.mock.calls)).not.toContain(SECRETS[3]);
  });

  it('a status request that hangs is null after 15 seconds', async () => {
    const w = await world({ fetchImpl: () => new Promise<Response>(() => {}) });
    const pending = w.share.status('sub_abc123');
    await vi.waitFor(() => expect(w.schedule.delays).toEqual([15_000]));
    w.schedule.advance(15_000);
    expect(await pending).toBeNull();
  });
});

describe('createCommunityShare refuses a configuration that cannot work', () => {
  const base = { sign: async () => 'x', publicKey: 'A'.repeat(43), clock: clock() };
  it('with a RangeError that names the option', () => {
    expect(() => createCommunityShare({ ...base })).not.toThrow();
    expect(() => createCommunityShare({ ...base, sign: undefined } as never)).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, publicKey: 'short' })).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, publicKey: `${'A'.repeat(42)}!` })).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, publicKey: 5 } as never)).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, clock: undefined } as never)).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, clock: {} } as never)).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, endpoint: 'http://corpus.example.test' })).toThrow(RangeError); // plain http to a remote host
    expect(() => createCommunityShare({ ...base, endpoint: 'ftp://x' })).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, endpoint: 'https://x.test/path?q=1' })).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, endpoint: 'https://user:pw@x.test' })).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, endpoint: '' })).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, kit: 'next' })).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, kit: '0.1.11' })).not.toThrow();
    expect(() => createCommunityShare({ ...base, stampBits: 27 })).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, stampBits: 1.5 })).toThrow(RangeError);
    expect(() => createCommunityShare({ ...base, stampBits: 16 })).not.toThrow();
    expect(() => createCommunityShare({ ...base, endpoint: 'http://127.0.0.1:8787' })).not.toThrow();
    expect(() => createCommunityShare({ ...base, endpoint: 'http://localhost' })).not.toThrow();
    try {
      createCommunityShare({ ...base, endpoint: 'https://user:pw-secret@x.test' });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('pw-secret');
    }
  });
});

describe('the module', () => {
  it('has no Date.now, no Node-only import and none of the words that trip the browser bundle test', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/corpus/share.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Date\.now|new Date\(\)|performance\.now/);
    expect(source).not.toMatch(/\b(process|require)\b/);
    expect(source).not.toMatch(/node:/);
  });
});
