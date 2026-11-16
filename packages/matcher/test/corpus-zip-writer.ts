// A tiny zip writer for the corpus tests (test-only; not shipped). It writes stored and deflated entries, optional traditional PKWARE
// encryption (ZipCrypto), and lets a test override any header field to build a hostile or malformed archive. Written independently of
// src/corpus/zip.ts so that a mistake in one does not hide a mistake in the other.
import { deflateRawSync } from 'node:zlib';

const enc = new TextEncoder();

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZipCrypto's three-key stream cipher (APPNOTE 6.1). */
class Keys {
  k0 = 0x12345678;
  k1 = 0x23456789;
  k2 = 0x34567890;
  constructor(password: Uint8Array) {
    for (const b of password) this.update(b);
  }
  update(b: number): void {
    this.k0 = ((TABLE[(this.k0 ^ b) & 0xff] as number) ^ (this.k0 >>> 8)) >>> 0;
    this.k1 = (this.k1 + (this.k0 & 0xff)) >>> 0;
    this.k1 = (Math.imul(this.k1, 134775813) + 1) >>> 0;
    this.k2 = ((TABLE[(this.k2 ^ (this.k1 >>> 24)) & 0xff] as number) ^ (this.k2 >>> 8)) >>> 0;
  }
  stream(): number {
    const t = (this.k2 | 2) & 0xffff;
    return ((t * (t ^ 1)) >>> 8) & 0xff;
  }
  encrypt(plain: number): number {
    const c = plain ^ this.stream();
    this.update(plain);
    return c;
  }
}

/** A deterministic generator (mulberry32) for headers and fuzzing. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ZipEntrySpec {
  name: string;
  data?: Uint8Array | string;
  /** 0 stored, 8 deflated; any other number is written as is (and the payload is then `rawData` or the plain bytes). Default 0. */
  method?: number;
  /** Encrypt the payload with ZipCrypto under this password. */
  password?: string;
  /** Set bit 3 (a data descriptor) in both headers; the check byte then comes from the DOS time. The sizes stay in the headers. */
  descriptor?: boolean;
  /** OR-ed into the general purpose flags of both headers. */
  flags?: number;
  /** A payload already in its final (compressed) form, used instead of compressing `data`. */
  rawData?: Uint8Array;
  /** Central directory overrides. */
  crc?: number;
  csize?: number;
  usize?: number;
  centralName?: string;
  centralMethod?: number;
  centralFlags?: number;
  centralExtra?: Uint8Array;
  disk?: number;
  offset?: number;
  /** Local header overrides. */
  localCrc?: number;
  localCsize?: number;
  localUsize?: number;
  localMethod?: number;
  localFlags?: number;
  localExtra?: Uint8Array;
  localSignature?: number;
  /** The bytes of the check byte's source; defaults are fine. */
  time?: number;
  /** Corrupt the first byte of the 12-byte encryption header's check byte. */
  badCheckByte?: boolean;
}

export interface ZipOptions {
  comment?: Uint8Array | string;
  /** Overrides of the end-of-central-directory record. */
  eocd?: { disk?: number; cdDisk?: number; entriesDisk?: number; entries?: number; cdSize?: number; cdOffset?: number; commentLength?: number };
  /** A zip64 end-of-central-directory locator directly before the EOCD. */
  zip64Locator?: boolean;
  /** Bytes appended after the archive. */
  trailing?: Uint8Array;
}

const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const bytesOf = (data: Uint8Array | string | undefined): Uint8Array => (data === undefined ? new Uint8Array(0) : typeof data === 'string' ? enc.encode(data) : data);

const DOS_DATE = 0x5a21;

/** Build the final payload (compressed, then encrypted) of one entry, and the numbers the headers carry. */
function payloadOf(spec: ZipEntrySpec, rand: () => number): { payload: Uint8Array; crc: number; usize: number; flags: number; time: number } {
  const plain = bytesOf(spec.data);
  const method = spec.method ?? 0;
  const crc = crc32(plain);
  let body = spec.rawData ?? (method === 8 ? new Uint8Array(deflateRawSync(plain)) : plain);
  let flags = (spec.flags ?? 0) | (spec.descriptor === true ? 0x08 : 0);
  const time = spec.time ?? 0x6000 + Math.floor(rand() * 0x1f00);
  if (spec.password !== undefined) {
    flags |= 0x01;
    const keys = new Keys(enc.encode(spec.password));
    const header = new Uint8Array(12);
    for (let i = 0; i < 11; i += 1) header[i] = Math.floor(rand() * 256);
    const check = spec.descriptor === true ? (time >>> 8) & 0xff : crc >>> 24;
    header[11] = spec.badCheckByte === true ? (check ^ 0xff) & 0xff : check;
    const out = new Uint8Array(12 + body.length);
    for (let i = 0; i < 12; i += 1) out[i] = keys.encrypt(header[i] as number);
    for (let i = 0; i < body.length; i += 1) out[12 + i] = keys.encrypt(body[i] as number);
    body = out;
  }
  return { payload: body, crc, usize: plain.length, flags, time };
}

export function writeZip(entries: ZipEntrySpec[], options: ZipOptions = {}): Uint8Array {
  const rand = prng(0xc0ffee);
  const out: number[] = [];
  const push = (...parts: Array<ArrayLike<number>>): void => {
    for (const p of parts) for (let i = 0; i < p.length; i += 1) out.push(p[i] as number);
  };
  const central: number[] = [];
  for (const spec of entries) {
    const { payload, crc, usize, flags, time } = payloadOf(spec, rand);
    const method = spec.method ?? 0;
    const name = enc.encode(spec.name);
    const centralName = enc.encode(spec.centralName ?? spec.name);
    const offset = out.length;
    const localExtra = spec.localExtra ?? new Uint8Array(0);
    const centralExtra = spec.centralExtra ?? new Uint8Array(0);
    const csize = payload.length;
    push(
      u32(spec.localSignature ?? 0x04034b50),
      u16(20),
      u16(spec.localFlags ?? flags),
      u16(spec.localMethod ?? method),
      u16(time),
      u16(DOS_DATE),
      u32(spec.localCrc ?? crc),
      u32(spec.localCsize ?? csize),
      u32(spec.localUsize ?? usize),
      u16(name.length),
      u16(localExtra.length),
      name,
      localExtra,
      payload,
    );
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(spec.centralFlags ?? flags),
      ...u16(spec.centralMethod ?? method),
      ...u16(time),
      ...u16(DOS_DATE),
      ...u32(spec.crc ?? crc),
      ...u32(spec.csize ?? csize),
      ...u32(spec.usize ?? usize),
      ...u16(centralName.length),
      ...u16(centralExtra.length),
      ...u16(0),
      ...u16(spec.disk ?? 0),
      ...u16(0),
      ...u32(0),
      ...u32(spec.offset ?? offset),
      ...centralName,
      ...centralExtra,
    );
  }
  const cdOffset = out.length;
  push(central);
  const comment = typeof options.comment === 'string' ? enc.encode(options.comment) : (options.comment ?? new Uint8Array(0));
  const e = options.eocd ?? {};
  if (options.zip64Locator === true) push(u32(0x07064b50), u32(0), u32(0), u32(1));
  push(
    u32(0x06054b50),
    u16(e.disk ?? 0),
    u16(e.cdDisk ?? 0),
    u16(e.entriesDisk ?? entries.length),
    u16(e.entries ?? entries.length),
    u32(e.cdSize ?? central.length),
    u32(e.cdOffset ?? cdOffset),
    u16(e.commentLength ?? comment.length),
    comment,
  );
  if (options.trailing !== undefined) push(options.trailing);
  return Uint8Array.from(out);
}

/** The deflate stream of `megabytes` MiB of zeros, made in pieces (so the test never holds the expanded bytes). A few hundred KB for hundreds of MiB. */
export async function deflatedZeros(megabytes: number): Promise<Uint8Array> {
  const { createDeflateRaw } = await import('node:zlib');
  const stream = createDeflateRaw();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const mib = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < megabytes; i += 1) {
    if (!stream.write(mib)) await new Promise<void>((r) => stream.once('drain', r));
  }
  stream.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}
