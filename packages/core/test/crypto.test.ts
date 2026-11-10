import { createHash, createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __forcePureJs,
  __pureHmacSha256,
  __pureSha256,
  hmacSha256Hex,
  randomId,
  randomIntBelow,
  sha256Hex,
} from '../src/crypto.js';
import * as core from '../src/index.js';

const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const rep = (byte: number, n: number): Uint8Array => new Uint8Array(n).fill(byte);
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

afterEach(() => {
  __forcePureJs(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SHA-256 (NIST vectors)', () => {
  const vectors: Array<[string, string, string]> = [
    ['empty', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'abc', ABC],
    [
      '448-bit message',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      '896-bit message',
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
    ['one million "a"', 'a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ];
  it.each(vectors)('%s', (_n, input, expected) => {
    expect(hex(__pureSha256(enc.encode(input)))).toBe(expected);
    __forcePureJs(true);
    expect(sha256Hex(input)).toBe(expected);
    __forcePureJs(false);
    expect(sha256Hex(input)).toBe(expected);
  });
});

describe('HMAC-SHA256 (RFC 4231 vectors)', () => {
  const t = (s: string): Uint8Array => enc.encode(s);
  const cases: Array<[string, Uint8Array, Uint8Array, string]> = [
    ['case 1', rep(0x0b, 20), t('Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
    ['case 2', t('Jefe'), t('what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
    ['case 3', rep(0xaa, 20), rep(0xdd, 50), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'],
    [
      'case 4',
      fromHex('0102030405060708090a0b0c0d0e0f10111213141516171819'),
      rep(0xcd, 50),
      '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b',
    ],
    ['case 5 (truncated to 128 bits)', rep(0x0c, 20), t('Test With Truncation'), 'a3b6167473100ee06e0c796c2955552b'],
    [
      'case 6 (key larger than block size)',
      rep(0xaa, 131),
      t('Test Using Larger Than Block-Size Key - Hash Key First'),
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    ],
    [
      'case 7 (key and data larger than block size)',
      rep(0xaa, 131),
      t(
        'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.',
      ),
      '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
    ],
  ];
  it.each(cases)('%s', (_n, key, data, expected) => {
    expect(hex(__pureHmacSha256(key, data)).slice(0, expected.length)).toBe(expected);
    // and the string API, for the cases whose bytes are valid single-byte UTF-8
    const ascii = (b: Uint8Array): boolean => b.every((x) => x < 0x80);
    if (ascii(key) && ascii(data)) {
      const k = new TextDecoder().decode(key);
      const d = new TextDecoder().decode(data);
      for (const pure of [true, false]) {
        __forcePureJs(pure);
        expect(hmacSha256Hex(k, d).slice(0, expected.length)).toBe(expected);
      }
    }
  });
});

/** mulberry32: a small seeded PRNG so the parity inputs are the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random string mixing ASCII, controls, 2-4 byte code points and the odd lone surrogate. */
function randomString(rnd: () => number, maxLen: number): string {
  const len = Math.floor(rnd() * (maxLen + 1));
  let s = '';
  for (let i = 0; i < len; i++) {
    const r = rnd();
    if (r < 0.55) s += String.fromCharCode(32 + Math.floor(rnd() * 95));
    else if (r < 0.7) s += String.fromCharCode(Math.floor(rnd() * 32));
    else if (r < 0.82) s += String.fromCharCode(0xa0 + Math.floor(rnd() * 0x700));
    else if (r < 0.92) s += String.fromCodePoint(0x1f300 + Math.floor(rnd() * 0x300));
    else if (r < 0.97) s += String.fromCharCode(0x800 + Math.floor(rnd() * 0xd000));
    else s += String.fromCharCode(0xd800 + Math.floor(rnd() * 0x800)); // possibly a lone surrogate
  }
  return s;
}

describe('parity: pure JS agrees with node:crypto', () => {
  it('2000 seeded random (key, data) pairs, keys and data up to several blocks', () => {
    const rnd = seeded(0xc47a);
    __forcePureJs(true);
    for (let i = 0; i < 2000; i++) {
      const data = randomString(rnd, 300);
      const key = randomString(rnd, i % 4 === 0 ? 200 : 40) || 'k';
      expect(sha256Hex(data), `sha ${i}`).toBe(createHash('sha256').update(data).digest('hex'));
      expect(hmacSha256Hex(key, data), `hmac ${i}`).toBe(createHmac('sha256', key).update(data).digest('hex'));
    }
  });

  it('every length 0..200, around the 55/56/63/64/119/120 padding boundaries', () => {
    __forcePureJs(true);
    for (let n = 0; n <= 200; n++) {
      const s = 'x'.repeat(n);
      expect(sha256Hex(s), `len ${n}`).toBe(createHash('sha256').update(s).digest('hex'));
      const key = s || 'k';
      expect(hmacSha256Hex(key, 'msg'), `key len ${n}`).toBe(createHmac('sha256', key).update('msg').digest('hex'));
    }
  });

  it('keys of 63, 64 and 65 bytes (the hash-the-key threshold) and longer', () => {
    __forcePureJs(true);
    for (const n of [63, 64, 65, 128, 129, 1024]) {
      const key = 'K'.repeat(n);
      expect(hmacSha256Hex(key, 'data')).toBe(createHmac('sha256', key).update('data').digest('hex'));
    }
  });

  it('a multi-byte key that crosses 64 bytes only after UTF-8 encoding', () => {
    __forcePureJs(true);
    const key = 'é'.repeat(40); // 40 characters, 80 bytes
    expect(hmacSha256Hex(key, 'ü💬')).toBe(createHmac('sha256', key).update('ü💬').digest('hex'));
  });

  it('over 1 MB of ASCII and of multi-byte text', () => {
    __forcePureJs(true);
    for (const big of ['0123456789abcdef'.repeat(70_000), 'ünï💬'.repeat(210_000)]) {
      expect(big.length).toBeGreaterThan(1_000_000);
      expect(sha256Hex(big)).toBe(createHash('sha256').update(big).digest('hex'));
      expect(hmacSha256Hex('secret', big)).toBe(createHmac('sha256', 'secret').update(big).digest('hex'));
    }
  });

  it('lone surrogates encode as U+FFFD on both paths', () => {
    __forcePureJs(true);
    for (const s of ['\ud800', 'a\udc00b', '\ud83d', '😀\ud83d']) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
    }
  });
});

describe('path selection', () => {
  it('uses node:crypto by default and the pure-JS code when forced (same answer)', () => {
    const spy = vi.spyOn(globalThis.process, 'getBuiltinModule');
    __forcePureJs(false);
    expect(sha256Hex('abc')).toBe(ABC);
    expect(spy).toHaveBeenCalledWith('node:crypto');
    spy.mockClear();
    __forcePureJs(true);
    expect(sha256Hex('abc')).toBe(ABC);
    expect(spy).not.toHaveBeenCalled();
  });

  it('caches the native module lookup', () => {
    __forcePureJs(false);
    const spy = vi.spyOn(globalThis.process, 'getBuiltinModule');
    sha256Hex('a');
    sha256Hex('b');
    hmacSha256Hex('k', 'd');
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('falls back to pure JS with no process global at all (a browser)', () => {
    vi.stubGlobal('process', undefined);
    __forcePureJs(false);
    expect(sha256Hex('abc')).toBe(ABC);
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    expect(randomId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('falls back when process lacks getBuiltinModule, or it throws or returns nothing', () => {
    const throwing = (): never => {
      throw new Error('nope');
    };
    for (const proc of [{}, { getBuiltinModule: () => undefined }, { getBuiltinModule: throwing }]) {
      vi.stubGlobal('process', proc);
      __forcePureJs(false);
      expect(sha256Hex('abc')).toBe(ABC);
      expect(hmacSha256Hex('k', 'd')).toBe(createHmac('sha256', 'k').update('d').digest('hex'));
    }
  });

  it('falls back when a shim returns an object that is not node:crypto', () => {
    vi.stubGlobal('process', { getBuiltinModule: () => ({}) });
    __forcePureJs(false);
    expect(sha256Hex('abc')).toBe(ABC);
  });
});

describe('randomId', () => {
  it('is 22 base64url characters with no padding by default, on both paths', () => {
    for (const pure of [false, true]) {
      __forcePureJs(pure);
      for (let i = 0; i < 200; i++) expect(randomId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it('honours the byte count: ceil(bytes * 4 / 3) characters', () => {
    for (const n of [1, 2, 3, 4, 15, 16, 17, 32, 100]) expect(randomId(n)).toHaveLength(Math.ceil((n * 4) / 3));
    expect(randomId(0)).toBe('');
  });

  it('encodes exactly like Buffer.toString("base64url") for the bytes drawn', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 250) & 0xff);
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => {
      a.set(bytes.subarray(0, a.length));
      return a;
    }) as never);
    expect(randomId(16)).toBe(Buffer.from(bytes).toString('base64url'));
    // all ones and all zeros exercise the '_' digit and the zero digit
    bytes.fill(0xff);
    expect(randomId(16)).toBe(Buffer.from(bytes).toString('base64url'));
    bytes.fill(0);
    expect(randomId(16)).toBe('A'.repeat(22));
  });

  it('values do not repeat, and the draw is spread across the whole alphabet', () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = randomId();
      seen.add(id);
      for (const c of id) chars.add(c);
    }
    expect(seen.size).toBe(2000);
    expect(chars.size).toBe(64);
  });

  it('rejects a negative or fractional byte count', () => {
    expect(() => randomId(-1)).toThrow(RangeError);
    expect(() => randomId(1.5)).toThrow(RangeError);
  });

  it('can draw more than the 64 KiB getRandomValues limit in one call', () => {
    expect(randomId(100_000)).toHaveLength(Math.ceil((100_000 * 4) / 3));
  });
});

describe('randomIntBelow', () => {
  it('stays in range for many n, including 1, 2, non-powers of two and 2**32', () => {
    for (const n of [1, 2, 3, 5, 7, 31, 32, 33, 1000, 65_536, 2 ** 31 + 1, 2 ** 32]) {
      for (let i = 0; i < 200; i++) {
        const v = randomIntBelow(n);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(n);
      }
    }
    expect(randomIntBelow(1)).toBe(0);
  });

  it('rejects n < 1, fractions, NaN, Infinity and n above 2**32', () => {
    for (const n of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32 + 1]) {
      expect(() => randomIntBelow(n), String(n)).toThrow(RangeError);
    }
  });

  it('is uniform: chi-square over 7 buckets (df 6) and over 31 buckets (the ref-code alphabet size)', () => {
    for (const [n, draws, limit] of [
      [7, 70_000, 40], // df 6: p ~ 4e-7 at 40
      [31, 93_000, 80], // df 30: p ~ 1e-6 at 80
    ] as const) {
      const counts = new Array<number>(n).fill(0);
      for (let i = 0; i < draws; i++) counts[randomIntBelow(n)]! += 1;
      const expected = draws / n;
      const chi = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
      expect(chi, `n=${n}`).toBeLessThan(limit);
      expect(counts.every((c) => c > 0)).toBe(true);
    }
  });

  it('removes modulo bias by rejecting draws in the uneven tail', () => {
    // n = 3: 2**32 mod 3 = 1, so the single draw 0xFFFFFFFF must be thrown away.
    const draws = [0xffffffff, 0xffffffff, 5];
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((a: Uint32Array) => {
      a[0] = draws.shift() ?? 0;
      return a;
    }) as never);
    expect(randomIntBelow(3)).toBe(5 % 3);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('accepts the highest unbiased draw', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((a: Uint32Array) => {
      a[0] = 0xfffffffe; // 4294967294 = 3 * 1431655764 + 2: inside the largest multiple of 3
      return a;
    }) as never);
    expect(randomIntBelow(3)).toBe(2);
  });

  it('a power of two never rejects', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((a: Uint32Array) => {
      a[0] = 0xffffffff;
      return a;
    }) as never);
    expect(randomIntBelow(256)).toBe(255);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('no secure random source', () => {
  it('randomId and randomIntBelow throw a clear error when globalThis.crypto is absent', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => randomId()).toThrow(/secure random/);
    expect(() => randomIntBelow(5)).toThrow(/secure random/);
  });

  it('...and when crypto exists but has no getRandomValues', () => {
    vi.stubGlobal('crypto', {});
    expect(() => randomId()).toThrow(/secure random/);
    expect(() => randomIntBelow(5)).toThrow(/secure random/);
  });

  it('...on the pure-JS path too (the random source is Web Crypto on both)', () => {
    __forcePureJs(true);
    vi.stubGlobal('crypto', undefined);
    expect(() => randomId()).toThrow(/secure random/);
    expect(() => randomIntBelow(2)).toThrow(/secure random/);
  });

  it('hashing needs no random source: sha256Hex still works without crypto', () => {
    vi.stubGlobal('crypto', undefined);
    expect(sha256Hex('abc')).toBe(ABC);
  });

  it('a zero-byte id draws nothing, so it does not need a source either', () => {
    vi.stubGlobal('crypto', undefined);
    expect(randomId(0)).toBe('');
  });
});

describe('portability guards', () => {
  it('@chatwarden/core src has no node: specifier anywhere', () => {
    const dir = new URL('../src/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      // The only mention allowed is the getBuiltinModule lookup in crypto.ts.
      const stripped = f === 'crypto.ts' ? text.replace(/getBuiltinModule\?\.\('node:crypto'\)/g, '') : text;
      expect(stripped, f).not.toMatch(/['"`]node:/);
      expect(stripped, f).not.toMatch(/\bfrom\s+['"](crypto|fs|path|os|util|buffer)['"]/);
    }
  });

  it('the test seam and the pure-JS internals are not on the public index', () => {
    const names = Object.keys(core);
    expect(names.filter((n) => n.startsWith('__'))).toEqual([]);
    for (const n of ['randomId', 'randomIntBelow', 'sha256Hex', 'hmacSha256Hex']) expect(names).not.toContain(n);
  });
});
