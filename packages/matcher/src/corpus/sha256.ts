import { isBytes } from './sign.js';

// A synchronous SHA-256 (FIPS 180-4), because the release parser is synchronous and WebCrypto's digest is not. It hashes the files of a
// release that has already been verified, so it is a consistency check, not the signature; it is still checked against node:crypto
// in the tests. Pure and isomorphic.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
  0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
  0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const;

/** One 64-byte block of `view` at `block`, folded into the state `h`. `w` is scratch space. */
function compress(h: Uint32Array, w: Uint32Array, view: DataView, block: number): void {
  for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4, false);
  for (let i = 16; i < 64; i += 1) {
    const a = w[i - 15] as number;
    const b = w[i - 2] as number;
    const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
    const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
    w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
  }
  let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number];
  for (let i = 0; i < 64; i += 1) {
    const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[i] as number) + (w[i] as number)) >>> 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  h[0] = ((h[0] as number) + a) >>> 0;
  h[1] = ((h[1] as number) + b) >>> 0;
  h[2] = ((h[2] as number) + c) >>> 0;
  h[3] = ((h[3] as number) + d) >>> 0;
  h[4] = ((h[4] as number) + e) >>> 0;
  h[5] = ((h[5] as number) + f) >>> 0;
  h[6] = ((h[6] as number) + g) >>> 0;
  h[7] = ((h[7] as number) + hh) >>> 0;
}

/** The message, a 1 bit, zeros, and the bit length as 64 bits, to a multiple of 64 bytes; `before` is how many bytes were already hashed. */
function pad(message: Uint8Array, before: number): { view: DataView; total: number } {
  const length = message.length;
  const total = (((length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(total);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const all = before + length;
  view.setUint32(total - 8, Math.floor(all / 0x20000000), false);
  view.setUint32(total - 4, (all << 3) >>> 0, false);
  return { view, total };
}

/** The SHA-256 of `bytes` as 64 lower-case hex characters. */
export function sha256Hex(bytes: Uint8Array): string {
  if (!isBytes(bytes)) throw new TypeError('sha256Hex: bytes must be a Uint8Array');
  const h = new Uint32Array(INITIAL);
  const w = new Uint32Array(64);
  const { view, total } = pad(bytes, 0);
  for (let block = 0; block < total; block += 64) compress(h, w, view, block);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += (h[i] as number).toString(16).padStart(8, '0');
  return out;
}

/**
 * For proof of work: the number of leading zero bits of SHA-256(`prefix` followed by `suffix`), with the work on `prefix` done once.
 * Returns a function of the suffix; every call costs about one or two blocks however long the prefix is.
 */
export function leadingZeroBitsAfter(prefix: Uint8Array): (suffix: Uint8Array) => number {
  if (!isBytes(prefix)) throw new TypeError('leadingZeroBitsAfter: prefix must be a Uint8Array');
  const done = prefix.length - (prefix.length % 64);
  const state = new Uint32Array(INITIAL);
  const w = new Uint32Array(64);
  if (done > 0) {
    const view = new DataView(prefix.buffer.slice(prefix.byteOffset, prefix.byteOffset + done));
    for (let block = 0; block < done; block += 64) compress(state, w, view, block);
  }
  const rest = prefix.slice(done);
  return (suffix) => {
    const message = new Uint8Array(rest.length + suffix.length);
    message.set(rest);
    message.set(suffix, rest.length);
    const { view, total } = pad(message, done);
    const h = new Uint32Array(state);
    for (let block = 0; block < total; block += 64) compress(h, w, view, block);
    let zeros = 0;
    for (let i = 0; i < 8; i += 1) {
      const word = h[i] as number;
      if (word === 0) {
        zeros += 32;
        continue;
      }
      return zeros + Math.clz32(word);
    }
    return zeros;
  };
}
