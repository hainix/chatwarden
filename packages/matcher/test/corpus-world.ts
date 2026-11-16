// Test helper for the corpus tests: generates Ed25519 key pairs with WebCrypto, signs the way the release tools do, and builds
// indexes and signature files. Everything here is generated at run time: no key in this file is a real key, and no term is real.
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const enc = new TextEncoder();

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
export const fromB64u = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64url'));

/** The message a signature covers, written out independently of src/corpus/sign.ts (so a drift in either shows). */
export function messageFor(kind: string, bytes: Uint8Array): Uint8Array {
  const prefix = enc.encode('chatwarden-corpus/1');
  const k = enc.encode(kind);
  const out = new Uint8Array(prefix.length + 1 + k.length + 1 + bytes.length);
  out.set(prefix, 0);
  out[prefix.length] = 0;
  out.set(k, prefix.length + 1);
  out[prefix.length + 1 + k.length] = 0;
  out.set(bytes, prefix.length + 1 + k.length + 1);
  return out;
}

export interface TestKey {
  id: string;
  /** The `CorpusKey` shape: raw public key, base64url. */
  publicKey: string;
  sign(kind: string, bytes: Uint8Array): Promise<Uint8Array>;
  /** A signature over the bare bytes, with no prefix and no kind (what a careless signer would produce). */
  signBare(bytes: Uint8Array): Promise<Uint8Array>;
}

/** A fresh Ed25519 key pair under `id`. */
export async function makeKey(id: string): Promise<TestKey> {
  const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return {
    id,
    publicKey: b64u(raw),
    sign: async (kind, bytes) => new Uint8Array(await subtle.sign('Ed25519', pair.privateKey, messageFor(kind, bytes))),
    signBare: async (bytes) => new Uint8Array(await subtle.sign('Ed25519', pair.privateKey, bytes)),
  };
}

/** The signature file object (6.3) for `bytes` of `kind`, signed by `key`. */
export async function sigFileFor(key: TestKey, kind: 'index' | 'zip', bytes: Uint8Array): Promise<{ schema: string; alg: string; keyId: string; sig: string }> {
  return { schema: 'chatwarden-corpus-sig/1', alg: 'Ed25519', keyId: key.id, sig: b64u(await key.sign(kind, bytes)) };
}

export const sigFileBytes = (file: unknown): Uint8Array => enc.encode(JSON.stringify(file));

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  Buffer.from(new Uint8Array(await subtle.digest('SHA-256', bytes))).toString('hex');

/** The design's example index (6.2), with the made-up numbers; `over` replaces top-level fields. */
export function exampleIndex(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'chatwarden-corpus-index/1',
    sequence: 14,
    issuedAt: '2026-12-01T00:00:00Z',
    expiresAt: '2027-03-01T00:00:00Z',
    keyId: 'k1',
    revokedKeyIds: [],
    revokedReleases: [{ kind: 'terms', version: '2026.11.0', reason: 'bad_release' }],
    latest: { terms: '2026.12.0', eval: '2026.12.0' },
    releases: [
      {
        kind: 'terms',
        version: '2026.11.0',
        publishedAt: '2026-11-01T00:00:00Z',
        minKit: '0.1.7',
        languages: { en: { terms: 2, exceptions: 1 } },
        bytes: 900,
        sha256: 'a'.repeat(64),
        zip: 'terms/2026.11.0/terms-2026.11.0.zip',
        sig: 'terms/2026.11.0/terms-2026.11.0.zip.sig',
        mirrors: [],
      },
      {
        kind: 'terms',
        version: '2026.12.0',
        publishedAt: '2026-12-01T00:00:00Z',
        minKit: '0.1.7',
        languages: { en: { terms: 3, exceptions: 1 }, es: { terms: 2, exceptions: 0 } },
        bytes: 1234,
        sha256: 'b'.repeat(64),
        zip: 'terms/2026.12.0/terms-2026.12.0.zip',
        sig: 'terms/2026.12.0/terms-2026.12.0.zip.sig',
        mirrors: [{ kind: 'zenodo', doi: '10.5281/zenodo.0000000', url: 'https://zenodo.org/records/0000000/files/terms-2026.12.0.zip?download=1' }],
        notes: 'Plain sentences; never a term.',
      },
      {
        kind: 'eval',
        version: '2026.12.0',
        publishedAt: '2026-12-01T00:00:00Z',
        minKit: '0.1.10',
        languages: { en: { cases: 40 } },
        bytes: 5000,
        sha256: 'c'.repeat(64),
        zip: 'eval/2026.12.0/eval-2026.12.0.zip',
        sig: 'eval/2026.12.0/eval-2026.12.0.zip.sig',
        mirrors: [],
      },
    ],
    ...over,
  };
}

/** `exampleIndex()` with one release entry replaced (by position) through `patch`. */
export function indexWithRelease(i: number, patch: Record<string, unknown>): Record<string, unknown> {
  const base = exampleIndex();
  const releases = (base.releases as Record<string, unknown>[]).map((r, n) => (n === i ? { ...r, ...patch } : r));
  return { ...base, releases };
}

export const indexBytes = (index: unknown): Uint8Array => enc.encode(JSON.stringify(index));
