import { CorpusError } from './errors.js';
import { CORPUS_KEYS, CORPUS_REVOKED_KEY_IDS, type CorpusKey } from './keys.js';

// Signatures. Pure and isomorphic: WebCrypto only, no Buffer, no atob. Every failure is a CorpusError with a fixed message.

const PREFIX = 'chatwarden-corpus/1';
const KINDS: readonly string[] = ['index', 'zip', 'submission', 'report'];
const SIG_FILE_SCHEMA = 'chatwarden-corpus-sig/1';
/** A signature file is a few hundred bytes; anything bigger is not read. */
const SIG_FILE_MAX = 1024;
const KEY_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP: Record<string, number> = Object.create(null) as Record<string, number>;
for (let i = 0; i < ALPHABET.length; i += 1) LOOKUP[ALPHABET.charAt(i)] = i;

/** Base64url without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += ALPHABET.charAt(n >> 18) + ALPHABET.charAt((n >> 12) & 63) + ALPHABET.charAt((n >> 6) & 63) + ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += ALPHABET.charAt(n >> 18) + ALPHABET.charAt((n >> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += ALPHABET.charAt(n >> 18) + ALPHABET.charAt((n >> 12) & 63) + ALPHABET.charAt((n >> 6) & 63);
  }
  return out;
}

/** Strict base64url: the alphabet only, no padding, and the one canonical spelling of the bytes. Null for anything else. */
export function base64urlDecode(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i += 1) {
    const v = LOOKUP[text.charAt(i)];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (acc >> bits) & 255;
      o += 1;
      acc &= (1 << bits) - 1;
    }
  }
  // The spare bits of the last character must be zero, so that one byte string has one spelling.
  if (acc !== 0) return null;
  return o === out.length ? out : null;
}

/** True for a Uint8Array (or a Buffer) from any realm; false for every other typed array, a DataView, an array and a string. */
export function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

/** A view over the same bytes made by this realm's Uint8Array, so later code never meets a foreign one. */
export const asBytes = (view: Uint8Array): Uint8Array => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/**
 * The message a signature covers: `UTF8('chatwarden-corpus/1') 0x00 UTF8(kind) 0x00 bytes`. The kind separates the artifacts, so a
 * valid signature over an index can never be replayed as a zip, a submission or a report.
 * @experimental
 */
export function signedMessage(kind: 'index' | 'zip' | 'submission' | 'report', bytes: Uint8Array): Uint8Array {
  if (typeof kind !== 'string' || !KINDS.includes(kind)) throw new RangeError('signedMessage: kind must be index, zip, submission or report');
  if (!isBytes(bytes)) throw new TypeError('signedMessage: bytes must be a Uint8Array');
  const encoder = new TextEncoder();
  const prefix = encoder.encode(PREFIX);
  const k = encoder.encode(kind);
  const out = new Uint8Array(prefix.length + 1 + k.length + 1 + bytes.length);
  out.set(prefix, 0);
  out.set(k, prefix.length + 1);
  out.set(bytes, prefix.length + 1 + k.length + 1);
  return out;
}

const bad = (): CorpusError => new CorpusError('bad_signature', 'verify');

/** The key id and the 64 signature bytes out of a signature file (an object, its JSON text, or the bytes of that text). */
function readSigFile(input: unknown): { keyId: string; sig: Uint8Array } {
  let file: unknown = input;
  if (typeof input === 'string') {
    if (input.length > SIG_FILE_MAX) throw bad();
    file = JSON.parse(input);
  } else if (isBytes(input)) {
    if (input.byteLength > SIG_FILE_MAX) throw bad();
    file = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(asBytes(input)));
  }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) throw bad();
  // Each field is read once into a local, so a getter or a proxy cannot show one value to the check and another to the verify.
  const o = file as Record<string, unknown>;
  const schema = o.schema;
  const alg = o.alg;
  const keyId = o.keyId;
  const sigText = o.sig;
  if (schema !== SIG_FILE_SCHEMA || alg !== 'Ed25519') throw bad();
  if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) throw bad();
  if (typeof sigText !== 'string') throw bad();
  const sig = base64urlDecode(sigText);
  if (sig === null || sig.length !== 64) throw bad();
  return { keyId, sig };
}

/** The strings in a list of unknown shape; anything else is ignored. */
function idsOf(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

/** The public key text of every keyring entry with this id, in order. A malformed entry (null, a throwing getter) is skipped. */
function candidatesFor(ring: readonly unknown[], keyId: string): { known: boolean; texts: string[] } {
  const texts: string[] = [];
  let known = false;
  for (const entry of ring) {
    try {
      const k = entry as Partial<CorpusKey> | null;
      if (k === null || typeof k !== 'object' || k.id !== keyId) continue;
      known = true;
      if (typeof k.publicKey === 'string') texts.push(k.publicKey);
    } catch {
      // skipped
    }
  }
  return { known, texts };
}

async function verifyInner(kind: unknown, bytes: unknown, sigFile: unknown, keys: unknown, options: unknown): Promise<{ keyId: string }> {
  const ring: readonly unknown[] = Array.isArray(keys) ? (keys as unknown[]) : [];
  if (ring.length === 0) throw new CorpusError('no_trusted_keys', 'verify');
  if (kind !== 'index' && kind !== 'zip') throw bad();
  if (!isBytes(bytes)) throw bad();
  const { keyId, sig } = readSigFile(sigFile);
  const extra = options !== null && typeof options === 'object' ? idsOf((options as { revokedKeyIds?: unknown }).revokedKeyIds) : [];
  if (CORPUS_REVOKED_KEY_IDS.includes(keyId) || extra.includes(keyId)) throw new CorpusError('revoked_key', 'verify');
  const { known, texts } = candidatesFor(ring, keyId);
  if (!known) throw new CorpusError('unknown_key', 'verify');
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw bad();
  const message = signedMessage(kind, asBytes(bytes));
  for (const text of texts) {
    try {
      const raw = base64urlDecode(text);
      if (raw === null || raw.length !== 32) continue;
      const key = await subtle.importKey('raw', raw, 'Ed25519', false, ['verify']);
      if (await subtle.verify('Ed25519', key, sig, message)) return { keyId };
    } catch {
      // a key that will not import, or a verify that throws, is a key that did not match
    }
  }
  throw bad();
}

/**
 * Check that `sigFile` (the signature file of design 6.3: an object, its JSON text or the bytes of that text) is a valid signature by
 * one of `keys` over `bytes` as a `kind`. Resolves `{ keyId }`; rejects with a {@link CorpusError} and nothing else:
 * `no_trusted_keys` (the list is empty), `revoked_key`, `unknown_key`, or `bad_signature` for every other failure, however hostile the input.
 * `options.revokedKeyIds` are ids an index that verified under a different key has revoked (see `revokedKeyIdsOf`); the kit's own
 * `CORPUS_REVOKED_KEY_IDS` always apply.
 * @experimental
 */
export async function verifySignature(
  kind: 'index' | 'zip',
  bytes: Uint8Array,
  sigFile: unknown,
  keys: readonly CorpusKey[] = CORPUS_KEYS,
  options?: { revokedKeyIds?: readonly string[] },
): Promise<{ keyId: string }> {
  try {
    return await verifyInner(kind, bytes, sigFile, keys, options);
  } catch (e) {
    if (e instanceof CorpusError) throw e;
    throw bad();
  }
}
