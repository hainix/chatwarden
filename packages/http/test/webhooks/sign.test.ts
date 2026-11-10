import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MIN_SECRET_LENGTH,
  REPLAY_CACHE_SIZE,
  ReplayCache,
  SIGNATURE_HEADER,
  SIGNATURE_WINDOW_MS,
  TIMESTAMP_HEADER,
  sign,
  verify,
} from '../../src/webhooks/sign.js';

const SECRET = 'a-webhook-secret-of-at-least-32-chars!';
const NOW = 1_800_000_000_000;
const TS = NOW / 1000;
const BODY = '{"action":"decide","input":{"reportId":"r1"}}';

const headersFor = (secret: string, ts: number | string, body: string): Record<string, string> => ({
  [TIMESTAMP_HEADER]: String(ts),
  [SIGNATURE_HEADER]: sign(secret, ts, body),
});

const cache = () => new ReplayCache();

describe('the wire constants', () => {
  it('uses the documented headers, window, secret floor and cache size', () => {
    expect(TIMESTAMP_HEADER).toBe('x-chatwarden-timestamp');
    expect(SIGNATURE_HEADER).toBe('x-chatwarden-signature');
    expect(SIGNATURE_WINDOW_MS).toBe(300_000);
    expect(MIN_SECRET_LENGTH).toBe(32);
    expect(REPLAY_CACHE_SIZE).toBe(10_000);
  });
});

describe('sign', () => {
  it('is v1= plus lowercase hex HMAC-SHA256 over "<timestamp>.<body>"', () => {
    const expected = createHmac('sha256', SECRET).update(`${TS}.${BODY}`).digest('hex');
    expect(sign(SECRET, TS, BODY)).toBe(`v1=${expected}`);
    expect(sign(SECRET, TS, BODY)).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it('takes the timestamp as a number or its decimal string alike', () => {
    expect(sign(SECRET, TS, BODY)).toBe(sign(SECRET, String(TS), BODY));
  });

  it('changes with the secret, the timestamp and any byte of the body', () => {
    const base = sign(SECRET, TS, BODY);
    expect(sign(`${SECRET}x`, TS, BODY)).not.toBe(base);
    expect(sign(SECRET, TS + 1, BODY)).not.toBe(base);
    expect(sign(SECRET, TS, `${BODY} `)).not.toBe(base);
    expect(sign(SECRET, TS, '')).toMatch(/^v1=/);
  });

  it('signs a multi-byte body over its UTF-8 bytes', () => {
    const body = '{"t":"é日本"}';
    const expected = createHmac('sha256', SECRET).update(Buffer.from(`${TS}.${body}`, 'utf8')).digest('hex');
    expect(sign(SECRET, TS, body)).toBe(`v1=${expected}`);
  });

  it('refuses a secret shorter than 32 characters (RangeError, never echoing it)', () => {
    const short = 'x'.repeat(31);
    expect(() => sign(short, TS, BODY)).toThrow(RangeError);
    try {
      sign(short, TS, BODY);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(short);
    }
    expect(() => sign('x'.repeat(32), TS, BODY)).not.toThrow();
    expect(() => sign(undefined as never, TS, BODY)).toThrow(RangeError);
    expect(() => sign(12345 as never, TS, BODY)).toThrow(RangeError);
  });
});

describe('verify: the happy path and the window', () => {
  it('accepts a good signature, then refuses the same one as a replay', () => {
    const seen = cache();
    const h = headersFor(SECRET, TS, BODY);
    expect(verify(SECRET, h, BODY, NOW, seen)).toBe(true);
    expect(verify(SECRET, h, BODY, NOW, seen)).toBe(false);
    expect(verify(SECRET, h, BODY, NOW + 1000, seen)).toBe(false);
  });

  it('accepts exactly 300 s old and exactly 300 s ahead, refuses 301 s either way', () => {
    for (const [delta, ok] of [
      [-300, true],
      [300, true],
      [-301, false],
      [301, false],
      [0, true],
    ] as const) {
      const ts = TS + delta;
      expect(verify(SECRET, headersFor(SECRET, ts, BODY), BODY, NOW, cache())).toBe(ok);
    }
  });

  it('judges the window in milliseconds (299.999 s passes, 300.001 s does not)', () => {
    const h = headersFor(SECRET, TS, BODY);
    expect(verify(SECRET, h, BODY, NOW + 300_000, cache())).toBe(true);
    expect(verify(SECRET, h, BODY, NOW + 300_001, cache())).toBe(false);
  });

  it('refuses a wrong secret, a changed body and a body with a different timestamp', () => {
    const h = headersFor(SECRET, TS, BODY);
    expect(verify(`${SECRET}-other`, h, BODY, NOW, cache())).toBe(false);
    expect(verify(SECRET, h, `${BODY} `, NOW, cache())).toBe(false);
    expect(verify(SECRET, { ...h, [TIMESTAMP_HEADER]: String(TS + 1) }, BODY, NOW, cache())).toBe(false);
  });

  it('a refused request is not remembered (a good one after a bad one still passes)', () => {
    const seen = cache();
    const good = headersFor(SECRET, TS, BODY);
    expect(verify(SECRET, { ...good, [SIGNATURE_HEADER]: `v1=${'0'.repeat(64)}` }, BODY, NOW, seen)).toBe(false);
    expect(verify(SECRET, good, BODY, NOW, seen)).toBe(true);
  });
});

describe('verify: malformed headers all fail closed', () => {
  const good = headersFor(SECRET, TS, BODY);
  const sig = good[SIGNATURE_HEADER] as string;

  it('a missing timestamp or signature', () => {
    expect(verify(SECRET, {}, BODY, NOW, cache())).toBe(false);
    expect(verify(SECRET, { [SIGNATURE_HEADER]: sig }, BODY, NOW, cache())).toBe(false);
    expect(verify(SECRET, { [TIMESTAMP_HEADER]: String(TS) }, BODY, NOW, cache())).toBe(false);
  });

  it.each(['', 'abc', '1e9', '-5', '12.5', ' 1800000000', '1800000000 ', '0x10', '+1800000000', '1800000000abc', 'NaN', 'Infinity'])(
    'a non-numeric or odd timestamp %j',
    (ts) => {
      expect(verify(SECRET, { ...good, [TIMESTAMP_HEADER]: ts }, BODY, NOW, cache())).toBe(false);
    },
  );

  it.each([
    ['no prefix', (s: string) => s.slice(3)],
    ['wrong version', (s: string) => `v2=${s.slice(3)}`],
    ['uppercase hex', (s: string) => `v1=${s.slice(3).toUpperCase()}`],
    ['63 hex', (s: string) => s.slice(0, -1)],
    ['65 hex', (s: string) => `${s}0`],
    ['non-hex', () => `v1=${'g'.repeat(64)}`],
    ['empty', () => ''],
    ['prefix only', () => 'v1='],
    ['trailing space', (s: string) => `${s} `],
    ['two signatures', (s: string) => `${s},${s}`],
  ])('a malformed signature: %s', (_name, mutate) => {
    expect(verify(SECRET, { ...good, [SIGNATURE_HEADER]: mutate(sig) }, BODY, NOW, cache())).toBe(false);
  });

  it('a non-string header value never throws', () => {
    expect(verify(SECRET, { [TIMESTAMP_HEADER]: 5 as never, [SIGNATURE_HEADER]: sig }, BODY, NOW, cache())).toBe(false);
    expect(verify(SECRET, { [TIMESTAMP_HEADER]: String(TS), [SIGNATURE_HEADER]: null as never }, BODY, NOW, cache())).toBe(false);
  });

  it('a non-finite now fails closed', () => {
    expect(verify(SECRET, good, BODY, Number.NaN, cache())).toBe(false);
  });

  it('a body that is not a string fails closed', () => {
    expect(verify(SECRET, good, undefined as never, NOW, cache())).toBe(false);
  });

  it('a secret under 32 characters throws (a programming error, not a bad request)', () => {
    expect(() => verify('short', good, BODY, NOW, cache())).toThrow(RangeError);
  });
});

describe('ReplayCache', () => {
  it('holds a signature until its timestamp leaves the window, then forgets it', () => {
    const seen = new ReplayCache();
    const h = headersFor(SECRET, TS, BODY);
    expect(verify(SECRET, h, BODY, NOW, seen)).toBe(true);
    expect(seen.size).toBe(1);
    // Still inside the window: held. Past it the timestamp check refuses anyway; the entry is swept on the next add.
    expect(seen.has(h[SIGNATURE_HEADER] as string, NOW + 300_000)).toBe(true);
    expect(seen.has(h[SIGNATURE_HEADER] as string, NOW + 300_001)).toBe(false);
    expect(seen.size).toBe(0);
  });

  it('sweeps expired entries when another is added', () => {
    const seen = new ReplayCache();
    seen.add('a', NOW + 1000, NOW);
    seen.add('b', NOW + 2000, NOW);
    seen.add('c', NOW + 99_999, NOW + 5000);
    expect(seen.size).toBe(1);
    expect(seen.has('c', NOW + 5000)).toBe(true);
  });

  it('is an LRU capped at 10000 by default: the least recently used goes first', () => {
    const seen = new ReplayCache();
    for (let i = 0; i < REPLAY_CACHE_SIZE; i++) seen.add(`s${i}`, NOW + 1_000_000, NOW);
    expect(seen.size).toBe(10_000);
    seen.add('extra', NOW + 1_000_000, NOW);
    expect(seen.size).toBe(10_000);
    expect(seen.has('s0', NOW)).toBe(false);
    expect(seen.has('s1', NOW)).toBe(true);
    expect(seen.has('extra', NOW)).toBe(true);
  });

  it('a hit refreshes recency', () => {
    const seen = new ReplayCache(3);
    seen.add('a', NOW + 9999, NOW);
    seen.add('b', NOW + 9999, NOW);
    seen.add('c', NOW + 9999, NOW);
    expect(seen.has('a', NOW)).toBe(true); // a is now the newest
    seen.add('d', NOW + 9999, NOW);
    expect(seen.has('b', NOW)).toBe(false); // b was the least recently used
    expect(seen.has('a', NOW)).toBe(true);
    expect(seen.has('c', NOW)).toBe(true);
    expect(seen.has('d', NOW)).toBe(true);
  });

  it('adding a signature already held does not grow it', () => {
    const seen = new ReplayCache(3);
    seen.add('a', NOW + 9999, NOW);
    seen.add('a', NOW + 9999, NOW);
    expect(seen.size).toBe(1);
  });

  it('refuses a bad capacity', () => {
    expect(() => new ReplayCache(0)).toThrow(RangeError);
    expect(() => new ReplayCache(1.5)).toThrow(RangeError);
    expect(() => new ReplayCache(-1)).toThrow(RangeError);
    expect(() => new ReplayCache(Number.NaN)).toThrow(RangeError);
  });

  it('through verify: 10001 distinct signatures evict the first, whose replay then passes (bounded memory)', () => {
    const seen = new ReplayCache();
    const first = headersFor(SECRET, TS, 'body-0');
    expect(verify(SECRET, first, 'body-0', NOW, seen)).toBe(true);
    for (let i = 1; i <= REPLAY_CACHE_SIZE; i++) {
      expect(verify(SECRET, headersFor(SECRET, TS, `body-${i}`), `body-${i}`, NOW, seen)).toBe(true);
    }
    expect(seen.size).toBe(REPLAY_CACHE_SIZE);
    expect(verify(SECRET, first, 'body-0', NOW, seen)).toBe(true);
    // The newest are still held.
    const last = `body-${REPLAY_CACHE_SIZE}`;
    expect(verify(SECRET, headersFor(SECRET, TS, last), last, NOW, seen)).toBe(false);
  });
});
