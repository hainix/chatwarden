import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { ZIP_LIMITS } from '@chatwarden/matcher/corpus';

// The release zip writer (design 6.4): one flat archive, every entry deflated and encrypted with traditional PKWARE ZipCrypto under the public
// password. The password is scanner hygiene, not secrecy. Nothing here is random and nothing reads the clock: the 12 bytes of encryption header
// are taken from a hash of the entry, and the entry time is the caller's, so the same entries and time are the same bytes (the release build is
// deterministic). It writes only what the kit's reader (`@chatwarden/matcher/corpus` readZip) accepts: no zip64, no descriptor, no extra field,
// no comment, plain names. It is written independently of the reader, and the tests use the reader as the judge.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface ZipOptions {
  /** The ZipCrypto password (the corpus's public one). */
  password: string;
  /** The modification time of every entry, epoch ms, from the injected clock. DOS time has two-second steps and starts in 1980. */
  time: number;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = (TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The ZipCrypto key schedule: three 32-bit keys stepped by every plaintext byte. */
class Keys {
  private k0 = 0x12345678;
  private k1 = 0x23456789;
  private k2 = 0x34567890;
  constructor(password: Uint8Array) {
    for (const b of password) this.update(b);
  }
  private update(b: number): void {
    this.k0 = ((TABLE[(this.k0 ^ b) & 0xff] as number) ^ (this.k0 >>> 8)) >>> 0;
    this.k1 = (this.k1 + (this.k0 & 0xff)) >>> 0;
    this.k1 = (Math.imul(this.k1, 134775813) + 1) >>> 0;
    this.k2 = ((TABLE[(this.k2 ^ (this.k1 >>> 24)) & 0xff] as number) ^ (this.k2 >>> 8)) >>> 0;
  }
  encrypt(plain: number): number {
    const t = (this.k2 | 2) & 0xffff;
    const cipher = plain ^ (((t * (t ^ 1)) >>> 8) & 0xff);
    this.update(plain);
    return cipher;
  }
}

function dosDateTime(ms: number): { date: number; time: number } {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (!Number.isFinite(ms) || year < 1980 || year > 2107) throw new RangeError('writeReleaseZip: time must be a moment between 1980 and 2107');
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** Writes the archive, or throws a RangeError for anything the kit's reader would refuse (a name, a count, a size, a time, an empty password). */
export function writeReleaseZip(entries: readonly ZipEntry[], options: ZipOptions): Uint8Array {
  if (typeof options.password !== 'string' || options.password === '') throw new RangeError('writeReleaseZip: a password is required');
  if (entries.length > ZIP_LIMITS.entries) throw new RangeError('writeReleaseZip: too many entries');
  const { date, time } = dosDateTime(options.time);
  const password = new TextEncoder().encode(options.password);
  const seen = new Set<string>();
  const out: number[] = [];
  const central: number[] = [];
  let expanded = 0;
  for (const entry of entries) {
    if (!NAME_RE.test(entry.name) || entry.name === '.' || entry.name.includes('..')) throw new RangeError('writeReleaseZip: an entry name is not allowed');
    const lower = entry.name.toLowerCase();
    if (seen.has(lower)) throw new RangeError('writeReleaseZip: duplicate entry name');
    seen.add(lower);
    expanded += entry.data.length;
    if (expanded > ZIP_LIMITS.expanded) throw new RangeError('writeReleaseZip: the entries are larger than the reader allows');
    const crc = crc32(entry.data);
    const name = new TextEncoder().encode(entry.name);
    const header = createHash('sha256').update(name).update(Uint8Array.from(u32(crc))).digest().subarray(0, 12);
    header[11] = crc >>> 24;
    const keys = new Keys(password);
    const body = deflateRawSync(entry.data, { level: 9 });
    const payload = new Uint8Array(12 + body.length);
    for (let i = 0; i < 12; i += 1) payload[i] = keys.encrypt(header[i] as number);
    for (let i = 0; i < body.length; i += 1) payload[12 + i] = keys.encrypt(body[i] as number);
    const offset = out.length;
    const flags = 0x0001;
    out.push(...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(8), ...u16(time), ...u16(date), ...u32(crc), ...u32(payload.length), ...u32(entry.data.length), ...u16(name.length), ...u16(0), ...name);
    for (const b of payload) out.push(b);
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(8), ...u16(time), ...u16(date),
      ...u32(crc), ...u32(payload.length), ...u32(entry.data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
    );
  }
  const cdOffset = out.length;
  for (const b of central) out.push(b);
  out.push(...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(cdOffset), ...u16(0));
  const zip = Uint8Array.from(out);
  if (zip.length > ZIP_LIMITS.compressed) throw new RangeError('writeReleaseZip: the archive is larger than the reader allows');
  return zip;
}
