import { CorpusError } from './errors.js';
import { CORPUS_ZIP_PASSWORD } from './keys.js';
import { asBytes, isBytes } from './sign.js';

// A zip reader for the release archive (design 6.4). Pure and isomorphic: bytes in, a Map of names to bytes out, and
// `DecompressionStream('deflate-raw')` for the deflate. It runs only on bytes whose signature has verified, but it is written as
// if they had not: every offset and size is checked against the buffer before it is used, the central directory is the authority
// (each local header is cross-checked against it), an entry's declared size is a promise that is held to, not trusted, and the
// total that can ever be allocated is bounded by the limits below. Every failure is a CorpusError('bad_zip', 'unpack') with a
// fixed message: nothing from the archive reaches an error.

/** What the reader refuses to go beyond. @experimental */
export interface ZipLimits {
  /** Most entries. */
  entries: number;
  /** Most bytes in the archive (and so in the compressed data). */
  compressed: number;
  /** Most bytes all the entries may expand to, together. */
  expanded: number;
  /** Longest entry name. */
  name: number;
}

/** The limits of design 6.4. A caller may tighten them with `options.limits`; none can be raised above these. @experimental */
export const ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({ entries: 32, compressed: 8 * 1024 * 1024, expanded: 32 * 1024 * 1024, name: 64 });

const bad = (): CorpusError => new CorpusError('bad_zip', 'unpack');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_SIZE = 22;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const MAX_COMMENT = 0xffff;
/** Encrypted (0), the two deflate option bits (1, 2), a data descriptor (3) and UTF-8 names (11): the only flags let through. */
const ALLOWED_FLAGS = 0x080f;
const FLAG_ENCRYPTED = 0x01;
const FLAG_DESCRIPTOR = 0x08;
const NAME_CHARS = /^[A-Za-z0-9._-]+$/;

function effectiveLimits(given: Partial<ZipLimits> | undefined): ZipLimits {
  const pick = (key: keyof ZipLimits): number => {
    let v: unknown;
    try {
      v = given?.[key];
    } catch {
      v = undefined;
    }
    return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? Math.min(v, ZIP_LIMITS[key]) : ZIP_LIMITS[key];
  };
  return { entries: pick('entries'), compressed: pick('compressed'), expanded: pick('expanded'), name: pick('name') };
}

// CRC-32 (the zip polynomial) and the traditional PKWARE cipher's key schedule share this table.
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

/** ZipCrypto decryption: three 32-bit keys seeded from the password and stepped by every plaintext byte. */
function decrypt(data: Uint8Array, password: Uint8Array): Uint8Array {
  let k0 = 0x12345678;
  let k1 = 0x23456789;
  let k2 = 0x34567890;
  const step = (b: number): void => {
    k0 = ((TABLE[(k0 ^ b) & 0xff] as number) ^ (k0 >>> 8)) >>> 0;
    k1 = (k1 + (k0 & 0xff)) >>> 0;
    k1 = (Math.imul(k1, 134775813) + 1) >>> 0;
    k2 = ((TABLE[(k2 ^ (k1 >>> 24)) & 0xff] as number) ^ (k2 >>> 8)) >>> 0;
  };
  for (let i = 0; i < password.length; i += 1) step(password[i] as number);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    const t = (k2 | 2) & 0xffff;
    const plain = (data[i] as number) ^ (((t * (t ^ 1)) >>> 8) & 0xff);
    out[i] = plain;
    step(plain);
  }
  return out;
}

/** Bounds-checked little-endian reads over one buffer. Reading outside it is a refusal, never an `undefined`. */
class View {
  private readonly b: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.b = bytes;
  }
  get length(): number {
    return this.b.length;
  }
  private need(offset: number, size: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > this.b.length) throw bad();
  }
  u16(offset: number): number {
    this.need(offset, 2);
    return (this.b[offset] as number) | ((this.b[offset + 1] as number) << 8);
  }
  u32(offset: number): number {
    this.need(offset, 4);
    return ((this.b[offset] as number) | ((this.b[offset + 1] as number) << 8) | ((this.b[offset + 2] as number) << 16) | ((this.b[offset + 3] as number) << 24)) >>> 0;
  }
  slice(offset: number, size: number): Uint8Array {
    this.need(offset, size);
    return this.b.subarray(offset, offset + size);
  }
}

interface Entry {
  name: string;
  flags: number;
  method: number;
  time: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  dataStart: number;
}

/** The extra field is a list of (id, length, bytes). It must tile exactly, and may name neither zip64 (0x0001) nor AES (0x9901). */
function checkExtra(extra: Uint8Array): void {
  let p = 0;
  while (p < extra.length) {
    if (p + 4 > extra.length) throw bad();
    const id = (extra[p] as number) | ((extra[p + 1] as number) << 8);
    const size = (extra[p + 2] as number) | ((extra[p + 3] as number) << 8);
    if (id === 0x0001 || id === 0x9901) throw bad();
    p += 4 + size;
    if (p > extra.length) throw bad();
  }
}

/** The name as written: plain ASCII from the allowed set, no `..`, within the length limit. */
function entryName(bytes: Uint8Array, max: number): string {
  if (bytes.length < 1 || bytes.length > max) throw bad();
  let name = '';
  for (let i = 0; i < bytes.length; i += 1) name += String.fromCharCode(bytes[i] as number);
  if (!NAME_CHARS.test(name) || name === '.' || name.includes('..')) throw bad();
  return name;
}

/** Find the end-of-central-directory record: the last signature whose comment length reaches exactly the end of the file. */
function findEnd(view: View): number {
  const last = view.length - EOCD_SIZE;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let p = last; p >= first; p -= 1) {
    if (view.u32(p) !== SIG_EOCD) continue;
    if (p + EOCD_SIZE + view.u16(p + 20) === view.length) return p;
  }
  throw bad();
}

/** The directory's entries, and where the directory starts (the end of the file data). */
function readDirectory(view: View, limits: ZipLimits): { entries: Entry[]; start: number } {
  const end = findEnd(view);
  if (end >= 20 && view.u32(end - 20) === SIG_ZIP64_LOCATOR) throw bad();
  const disk = view.u16(end + 4);
  const cdDisk = view.u16(end + 6);
  const onDisk = view.u16(end + 8);
  const total = view.u16(end + 10);
  const cdSize = view.u32(end + 12);
  const cdOffset = view.u32(end + 16);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw bad();
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw bad();
  if (total > limits.entries) throw bad();
  // The directory is the stretch right before the end record, nothing more and nothing less.
  if (cdOffset + cdSize !== end) throw bad();
  const entries: Entry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (view.u32(p) !== SIG_CENTRAL) throw bad();
    const flags = view.u16(p + 8);
    const method = view.u16(p + 10);
    const time = view.u16(p + 12);
    const crc = view.u32(p + 16);
    const csize = view.u32(p + 20);
    const usize = view.u32(p + 24);
    const nameLength = view.u16(p + 28);
    const extraLength = view.u16(p + 30);
    const commentLength = view.u16(p + 32);
    const entryDisk = view.u16(p + 34);
    const offset = view.u32(p + 42);
    if (entryDisk !== 0) throw bad();
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw bad();
    if ((flags & ~ALLOWED_FLAGS) !== 0) throw bad();
    if (method !== 0 && method !== 8) throw bad();
    const name = entryName(view.slice(p + CENTRAL_SIZE, nameLength), limits.name);
    checkExtra(view.slice(p + CENTRAL_SIZE + nameLength, extraLength));
    // The comment is read for its bounds only.
    view.slice(p + CENTRAL_SIZE + nameLength + extraLength, commentLength);
    entries.push({ name, flags, method, time, crc, csize, usize, offset, dataStart: 0 });
    p += CENTRAL_SIZE + nameLength + extraLength + commentLength;
  }
  if (p !== end) throw bad();
  return { entries, start: cdOffset };
}

/** Check the local header of an entry against the directory's record of it, and fix where its data starts. */
function checkLocal(view: View, e: Entry, directoryStart: number): void {
  if (e.offset + LOCAL_SIZE > directoryStart) throw bad();
  if (view.u32(e.offset) !== SIG_LOCAL) throw bad();
  const flags = view.u16(e.offset + 6);
  const method = view.u16(e.offset + 8);
  const crc = view.u32(e.offset + 14);
  const csize = view.u32(e.offset + 18);
  const usize = view.u32(e.offset + 22);
  const nameLength = view.u16(e.offset + 26);
  const extraLength = view.u16(e.offset + 28);
  if (flags !== e.flags || method !== e.method) throw bad();
  const name = view.slice(e.offset + LOCAL_SIZE, nameLength);
  if (nameLength !== e.name.length) throw bad();
  for (let i = 0; i < nameLength; i += 1) if (name[i] !== e.name.charCodeAt(i)) throw bad();
  checkExtra(view.slice(e.offset + LOCAL_SIZE + nameLength, extraLength));
  const hasDescriptor = (e.flags & FLAG_DESCRIPTOR) !== 0;
  // With a descriptor the local header may leave these at zero; without one they must agree with the directory.
  const agrees = (local: number, central: number): boolean => local === central || (hasDescriptor && local === 0);
  if (!agrees(crc, e.crc) || !agrees(csize, e.csize) || !agrees(usize, e.usize)) throw bad();
  e.dataStart = e.offset + LOCAL_SIZE + nameLength + extraLength;
  if (e.dataStart + e.csize > directoryStart) throw bad();
}

/** Inflate `data` into exactly `size` bytes. More output than that, less, or a broken stream is a refusal; no more than `size` bytes are kept. */
async function inflate(data: Uint8Array, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  let filled = 0;
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const feed = (async () => {
    await writer.write(data);
    await writer.close();
  })();
  // A failure on the writing side shows up on the reading side too; this only keeps it from being an unhandled rejection.
  feed.catch(() => undefined);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (filled + value.length > size) throw bad();
      out.set(value, filled);
      filled += value.length;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    await writer.abort().catch(() => undefined);
    throw bad();
  }
  await feed.catch(() => undefined);
  if (filled !== size) throw bad();
  return out;
}

async function readEntry(view: View, e: Entry, password: Uint8Array): Promise<Uint8Array> {
  let data = view.slice(e.dataStart, e.csize);
  if ((e.flags & FLAG_ENCRYPTED) !== 0) {
    if (data.length < 12) throw bad();
    const plain = decrypt(data, password);
    // The twelfth header byte is the high byte of the CRC, or, when a descriptor follows, of the DOS time. Either passes: the CRC
    // below is the real check, this only turns most wrong passwords away early.
    const check = plain[11] as number;
    if (check !== e.crc >>> 24 && check !== ((e.time >>> 8) & 0xff)) throw bad();
    data = plain.subarray(12);
  }
  let bytes: Uint8Array;
  if (e.method === 0) {
    if (data.length !== e.usize) throw bad();
    bytes = data.slice();
  } else {
    bytes = await inflate(data, e.usize);
  }
  if (crc32(bytes) !== e.crc) throw bad();
  return bytes;
}

/**
 * Read a release archive into a Map of entry name to bytes (in directory order). Methods 0 (stored) and 8 (deflate), optionally
 * encrypted with traditional PKWARE ZipCrypto under `options.password` (default: the corpus's public password). Anything else, and
 * anything that does not hold together, rejects with `CorpusError('bad_zip', 'unpack')` and nothing else. Run it on bytes whose
 * signature has already verified.
 * @experimental
 */
export async function readZip(
  bytes: Uint8Array,
  options?: { password?: string; limits?: Partial<ZipLimits> },
): Promise<Map<string, Uint8Array>> {
  try {
    if (!isBytes(bytes)) throw bad();
    const limits = effectiveLimits(options?.limits);
    if (bytes.byteLength > limits.compressed) throw bad();
    const password = new TextEncoder().encode(typeof options?.password === 'string' ? options.password : CORPUS_ZIP_PASSWORD);
    const view = new View(asBytes(bytes));
    const { entries, start: cdStart } = readDirectory(view, limits);
    let compressed = 0;
    let expanded = 0;
    const seen = new Set<string>();
    for (const e of entries) {
      const lower = e.name.toLowerCase();
      if (seen.has(lower)) throw bad();
      seen.add(lower);
      compressed += e.csize;
      expanded += e.usize;
      if (compressed > limits.compressed || expanded > limits.expanded) throw bad();
      // A descriptor needs sizes in the directory: the reader never reads a descriptor, so a zero there is a claim it cannot check.
      if ((e.flags & FLAG_DESCRIPTOR) !== 0 && e.csize === 0) throw bad();
      checkLocal(view, e, cdStart);
    }
    // No two entries may share bytes (an overlap is how a small archive is made to read as a large one).
    const spans = entries.map((e) => [e.offset, e.dataStart + e.csize] as const).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i += 1) if ((spans[i] as readonly [number, number])[0] < (spans[i - 1] as readonly [number, number])[1]) throw bad();
    const out = new Map<string, Uint8Array>();
    for (const e of entries) out.set(e.name, await readEntry(view, e, password));
    return out;
  } catch (e) {
    if (e instanceof CorpusError) throw e;
    throw bad();
  }
}
