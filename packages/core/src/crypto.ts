// Isomorphic crypto for @chatwarden/core: the same code runs in Node and in a browser.
//
// Randomness comes from the Web Crypto global (`globalThis.crypto.getRandomValues`), present in Node >= 19 and in
// every browser. SHA-256 and HMAC-SHA-256 use the node crypto built-in when this runtime has it (looked up through
// `process.getBuiltinModule`, so there is never a static or dynamic `import` of a node built-in and a browser
// bundler has nothing to resolve), and otherwise a small pure-JS implementation. Both paths give byte-identical
// output: identity hashes (see hasher.ts) are stored by Moxgate and must never change.
//
// Nothing in this file is exported from the package index; it is for the engine's own modules.

/** The slice of the node crypto built-in this file uses. Declared here so no type import of it is needed either. */
interface NodeCrypto {
  createHash(algorithm: 'sha256'): { update(data: string): { digest(encoding: 'hex'): string } };
  createHmac(algorithm: 'sha256', key: string): { update(data: string): { digest(encoding: 'hex'): string } };
}

let forcePure = false;
/** `undefined`: not looked up yet. `null`: looked up, this runtime has no usable node crypto. */
let nativeCache: NodeCrypto | null | undefined;

/**
 * Test seam: `true` makes every hash use the pure-JS code even where the built-in exists, `false` goes back to
 * detection. Either call also forgets the cached lookup.
 * @internal
 */
export function __forcePureJs(force: boolean): void {
  forcePure = force;
  nativeCache = undefined;
}

function native(): NodeCrypto | null {
  if (forcePure) return null;
  if (nativeCache === undefined) {
    nativeCache = null;
    try {
      const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
      const mod = proc?.getBuiltinModule?.('node:crypto') as Partial<NodeCrypto> | undefined;
      if (mod && typeof mod.createHash === 'function' && typeof mod.createHmac === 'function') {
        nativeCache = mod as NodeCrypto;
      }
    } catch {
      // No process, no getBuiltinModule, or it refused: use the pure-JS path.
    }
  }
  return nativeCache;
}

// ---------------------------------------------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------------------------------------------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** `getRandomValues` refuses more than 65536 bytes per call. */
const MAX_FILL = 65_536;

/** The one Web Crypto method used. Declared here because the build has no DOM lib. */
interface WebCrypto {
  getRandomValues(array: Uint8Array | Uint32Array): unknown;
}
function webCrypto(): WebCrypto {
  const c = (globalThis as { crypto?: WebCrypto }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('chatwarden: no secure random source (globalThis.crypto)');
  return c;
}

/** `bytes` random bytes as unpadded base64url: 16 bytes give 22 characters, like `randomBytes(16).toString('base64url')`. */
export function randomId(bytes = 16): string {
  if (!Number.isInteger(bytes) || bytes < 0) throw new RangeError('randomId: bytes must be a non-negative integer');
  const raw = new Uint8Array(bytes);
  for (let off = 0; off < bytes; off += MAX_FILL) webCrypto().getRandomValues(raw.subarray(off, Math.min(bytes, off + MAX_FILL)));
  let out = '';
  let i = 0;
  for (; i + 2 < bytes; i += 3) {
    const n = (raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!;
    out += B64URL[n >> 18]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  if (bytes - i === 1) {
    const n = raw[i]! << 16;
    out += B64URL[n >> 18]! + B64URL[(n >> 12) & 63]!;
  } else if (bytes - i === 2) {
    const n = (raw[i]! << 16) | (raw[i + 1]! << 8);
    out += B64URL[n >> 18]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

const TWO_32 = 4_294_967_296;

/**
 * A uniform integer in `[0, n)` for `1 <= n <= 2**32`. Rejection sampling over 32-bit draws: a draw in the uneven
 * tail (`>= floor(2**32 / n) * n`) is thrown away, so there is no modulo bias.
 */
export function randomIntBelow(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > TWO_32) throw new RangeError('randomIntBelow: n must be an integer in [1, 2**32]');
  const limit = Math.floor(TWO_32 / n) * n;
  const draw = new Uint32Array(1);
  for (;;) {
    webCrypto().getRandomValues(draw);
    const v = draw[0]!;
    if (v < limit) return v % n;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// SHA-256 and HMAC-SHA-256, pure JS (FIPS 180-4, RFC 2104)
// ---------------------------------------------------------------------------------------------------------------

/** Round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash value: the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const;

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 of `msg`: 32 bytes. */
export function __pureSha256(msg: Uint8Array): Uint8Array {
  const len = msg.length;
  // Pad: 0x80, zeros up to 56 mod 64, then the bit length as a 64-bit big-endian integer.
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor((len * 8) / TWO_32));
  view.setUint32(total - 4, (len * 8) >>> 0);

  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = w[i - 16]! + s0 + w[i - 7]! + s1; // Uint32Array stores modulo 2**32
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a; h[1] = h[1]! + b; h[2] = h[2]! + c; h[3] = h[3]! + d;
    h[4] = h[4]! + e; h[5] = h[5]! + f; h[6] = h[6]! + g; h[7] = h[7]! + hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
  return out;
}

const BLOCK = 64;

/** HMAC-SHA-256 (RFC 2104): a key longer than the 64-byte block is hashed first, a shorter one is zero-padded. */
export function __pureHmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const k = new Uint8Array(BLOCK);
  k.set(key.length > BLOCK ? __pureSha256(key) : key);
  const inner = new Uint8Array(BLOCK + data.length);
  const outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(data, BLOCK);
  outer.set(__pureSha256(inner), BLOCK);
  return __pureSha256(outer);
}

const utf8 = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

/** SHA-256 of the UTF-8 text, as 64 lowercase hex characters. */
export function sha256Hex(data: string): string {
  const nc = native();
  return nc ? nc.createHash('sha256').update(data).digest('hex') : toHex(__pureSha256(utf8.encode(data)));
}

/** HMAC-SHA-256 of the UTF-8 text under the UTF-8 key, as 64 lowercase hex characters. */
export function hmacSha256Hex(key: string, data: string): string {
  const nc = native();
  return nc ? nc.createHmac('sha256', key).update(data).digest('hex') : toHex(__pureHmacSha256(utf8.encode(key), utf8.encode(data)));
}
