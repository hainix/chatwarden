import {
  parseEvalSet,
  parseIndex,
  parseTermsRelease,
  readZip,
  verifySignature,
  type CorpusKey,
  type CorpusMirror,
  type CorpusRevokedRelease,
} from '@chatwarden/matcher/corpus';
import type { Clock } from '../deps.js';
import { isoSeconds } from '../counters.js';
import type { R2Like } from '../env.js';
import { sha256Hex, type ReleaseSummary } from '../build/summary.js';
import { ToolError } from './errors.js';

// Publishing (design 6.1, 6.2, 7): upload the release files first and `index.json` last, with the next sequence, a fresh `issuedAt` and
// `expiresAt` (+90 days), and check with the kit's own verifier everything that was uploaded. Nothing is made visible to a reader before it has
// been read back and verified, and a failure part-way leaves the previous index live: the files of a new version are not reachable from any
// index until the last upload, and the signature and the index are replaced as a pair (the old pair is put back if the second of them fails).

const PREFIX = 'v1/';
const DAY_MS = 24 * 60 * 60 * 1000;
const FRESH_DAYS = 90;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const FIVE_MINUTES = 'public, max-age=300';

export interface PutMeta {
  contentType: string;
  cacheControl: string;
  contentDisposition?: string;
}

/** The release bucket as the publisher sees it. `read` answers null only for an object that is not there; any other failure rejects. */
export interface ReleaseStore {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array, meta: PutMeta): Promise<void>;
}

/** A store over an R2 binding (the Worker's, or the tests' fake). */
export function r2Store(r2: R2Like): ReleaseStore {
  return {
    read: async (key) => {
      const body = await r2.get(key);
      return body === null ? null : new Uint8Array(await body.arrayBuffer());
    },
    write: async (key, bytes, meta) => {
      await r2.put(key, bytes, {
        httpMetadata: { contentType: meta.contentType, cacheControl: meta.cacheControl, ...(meta.contentDisposition === undefined ? {} : { contentDisposition: meta.contentDisposition }) },
      });
    },
  };
}

export interface PublishInput {
  store: ReleaseStore;
  clock: Clock;
  summary: ReleaseSummary;
  zip: Uint8Array;
  /** The signature file of the zip (made by `sign`). */
  zipSig: Uint8Array | string;
  /** Signs the bytes of the new index as an `index` and answers the signature file's text. */
  signIndex: (bytes: Uint8Array) => Promise<string> | string;
  /** The id of the key that signs the index. */
  keyId: string;
  /** The public keys to verify with: the signing key's, and any older key an existing index may have been signed with. */
  keys: readonly CorpusKey[];
  /** Mirrors to add, by `kind:version` (an existing release may gain one: its entry is rewritten, the files are not). */
  mirrors?: Readonly<Record<string, readonly CorpusMirror[]>>;
  notes?: string;
  /** The sequence to publish at; refused unless above the live index's. Default: one above it. */
  sequence?: number;
  revokedKeyIds?: readonly string[];
  revokedReleases?: readonly CorpusRevokedRelease[];
  /** Build, sign and verify the new index but upload nothing: the result holds it. */
  dryRun?: boolean;
}

export interface PublishResult {
  /** False when the release was already live with these bytes and nothing was added. */
  published: boolean;
  sequence: number;
  indexBytes: Uint8Array;
  indexSig: string;
  /** The keys written, in order. */
  uploaded: string[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const textOf = (v: Uint8Array | string): string => (typeof v === 'string' ? v : decoder.decode(v));
const bytesOf = (v: Uint8Array | string): Uint8Array => (typeof v === 'string' ? encoder.encode(v) : v);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** `2026.12.1` is above `2026.12.0` and `2026.11.9`; versions are compared as numbers part by part. */
function versionAbove(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d > 0;
  }
  return false;
}

interface RawIndex {
  schema: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
  revokedKeyIds: string[];
  revokedReleases: CorpusRevokedRelease[];
  latest: Record<string, string>;
  releases: Record<string, unknown>[];
}

/** The live index, read and verified, or null when there is none. Anything that does not verify stops the publish: nothing is built on it. */
async function readLive(store: ReleaseStore, keys: readonly CorpusKey[]): Promise<{ raw: RawIndex; bytes: Uint8Array; sig: Uint8Array } | null> {
  let bytes: Uint8Array | null;
  let sig: Uint8Array | null;
  try {
    bytes = await store.read(`${PREFIX}index.json`);
    sig = await store.read(`${PREFIX}index.json.sig`);
  } catch {
    throw new ToolError('upload_failed', 'the live index could not be read');
  }
  if (bytes === null && sig === null) return null;
  if (bytes === null || sig === null) throw new ToolError('bad_index', 'the live index and its signature are not both there; fix the bucket by hand before publishing');
  try {
    await verifySignature('index', bytes, sig, keys);
    parseIndex(bytes, 0);
    return { raw: JSON.parse(decoder.decode(bytes)) as RawIndex, bytes, sig };
  } catch {
    throw new ToolError('bad_index', 'the live index does not verify with the keys given (add the older key with --trust, or fix the bucket)');
  }
}

/** Reads back what was put and checks it is the same bytes. */
async function readBack(store: ReleaseStore, key: string, expected: Uint8Array): Promise<void> {
  let got: Uint8Array | null;
  try {
    got = await store.read(key);
  } catch {
    throw new ToolError('verify_failed', 'an uploaded file could not be read back');
  }
  if (got === null || !same(got, expected)) throw new ToolError('verify_failed', 'an uploaded file does not read back the same');
}

export async function publishRelease(input: PublishInput): Promise<PublishResult> {
  const { store, summary } = input;
  const now = input.clock.now();
  const zipSigBytes = bytesOf(input.zipSig);

  // 1. What is about to go up is what the builder says it is, and it verifies: the hash, the signature, the zip, its manifest.
  if (sha256Hex(input.zip) !== summary.sha256 || input.zip.length !== summary.bytes) throw new ToolError('bad_input', 'the zip is not the one the release summary describes');
  try {
    await verifySignature('zip', input.zip, zipSigBytes, input.keys);
  } catch {
    throw new ToolError('bad_signature', 'the zip signature does not verify with the keys given');
  }

  // 2. The live index, verified; the next sequence; this version must not already be there with other bytes.
  const live = await readLive(store, input.keys);
  const liveSequence = live === null ? 0 : live.raw.sequence;
  if (input.sequence !== undefined && input.sequence <= liveSequence) throw new ToolError('sequence', 'the sequence must be above the live index\'s; it is never lowered');
  const sequence = input.sequence ?? liveSequence + 1;
  if (summary.sequence > sequence) throw new ToolError('sequence', 'the release was built for a higher index sequence than this publish would use');
  try {
    const files = await readZip(input.zip);
    if (summary.kind === 'terms') parseTermsRelease(files, { version: summary.version, sequence });
    else parseEvalSet(files, { version: summary.version, sequence });
  } catch {
    throw new ToolError('bad_input', 'the zip is not a release the kit reads, or does not match the summary');
  }
  const entries = live === null ? [] : live.raw.releases;
  const existing = entries.find((e) => e.kind === summary.kind && e.version === summary.version);
  if (existing !== undefined && existing.sha256 !== summary.sha256) throw new ToolError('version_exists', 'that version is already published with different bytes; a version never changes (publish a patch)');

  // 3. The new index: everything that was there, the mirrors merged, this release appended, the freshness and the sequence set.
  const extra = input.mirrors ?? {};
  const merge = (e: Record<string, unknown>): Record<string, unknown> => {
    const add = extra[`${String(e.kind)}:${String(e.version)}`];
    if (add === undefined || add.length === 0) return e;
    const have = (e.mirrors as CorpusMirror[] | undefined) ?? [];
    return { ...e, mirrors: [...have, ...add.filter((m) => !have.some((h) => h.url === m.url))] };
  };
  const merged = entries.map(merge);
  const unchanged = existing !== undefined && JSON.stringify(merged) === JSON.stringify(entries);
  if (unchanged) return { published: false, sequence: liveSequence, indexBytes: (live as NonNullable<typeof live>).bytes, indexSig: decoder.decode((live as NonNullable<typeof live>).sig), uploaded: [] };
  const releases = existing === undefined
    ? [
        ...merged,
        merge({
          kind: summary.kind,
          version: summary.version,
          publishedAt: isoSeconds(now),
          minKit: summary.minKit,
          languages: summary.languages,
          bytes: summary.bytes,
          sha256: summary.sha256,
          zip: summary.zip,
          sig: summary.sig,
          mirrors: [],
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        }),
      ]
    : merged;
  const latest: Record<string, string> = { ...(live?.raw.latest ?? {}) };
  if (existing === undefined && (latest[summary.kind] === undefined || versionAbove(summary.version, latest[summary.kind] as string))) latest[summary.kind] = summary.version;
  const revokedKeyIds = [...new Set([...(live?.raw.revokedKeyIds ?? []), ...(input.revokedKeyIds ?? [])])];
  const known = (live?.raw.revokedReleases ?? []).map((r) => `${r.kind}:${r.version}`);
  const revokedReleases = [...(live?.raw.revokedReleases ?? []), ...(input.revokedReleases ?? []).filter((r) => !known.includes(`${r.kind}:${r.version}`))];
  const index: RawIndex = {
    schema: 'chatwarden-corpus-index/1',
    sequence,
    issuedAt: isoSeconds(now),
    expiresAt: isoSeconds(now + FRESH_DAYS * DAY_MS),
    keyId: input.keyId,
    revokedKeyIds,
    revokedReleases,
    latest,
    releases: releases,
  };
  const indexBytes = encoder.encode(`${JSON.stringify(index)}\n`);
  const indexSig = await input.signIndex(indexBytes);
  try {
    await verifySignature('index', indexBytes, indexSig, input.keys);
    parseIndex(indexBytes, now);
  } catch {
    throw new ToolError('bad_index', 'the new index does not verify or does not parse (is it over the 256 KiB the kit reads?); nothing was uploaded');
  }

  if (input.dryRun === true) return { published: true, sequence, indexBytes, indexSig: textOf(indexSig), uploaded: [] };

  // 4. Upload: a robots file once, the release files, read back and verified; then the signature and the index as a pair.
  const uploaded: string[] = [];
  const put = async (key: string, bytes: Uint8Array, meta: PutMeta): Promise<void> => {
    try {
      await store.write(key, bytes, meta);
    } catch {
      throw new ToolError('upload_failed', 'an upload failed; the previous index is still live');
    }
    uploaded.push(key);
  };
  if (live === null && (await store.read('robots.txt').catch(() => 'error' as const)) === null) {
    await put('robots.txt', encoder.encode('User-agent: *\nDisallow: /\n'), { contentType: 'text/plain; charset=utf-8', cacheControl: FIVE_MINUTES });
  }
  if (existing === undefined) {
    const zipKey = `${PREFIX}${summary.zip}`;
    const sigKey = `${PREFIX}${summary.sig}`;
    const name = summary.zip.split('/').pop() as string;
    await put(zipKey, input.zip, { contentType: 'application/zip', cacheControl: IMMUTABLE, contentDisposition: `attachment; filename="${name}"` });
    await put(sigKey, zipSigBytes, { contentType: 'application/json', cacheControl: IMMUTABLE });
    await readBack(store, zipKey, input.zip);
    await readBack(store, sigKey, zipSigBytes);
  }
  const indexSigBytes = bytesOf(indexSig);
  const restore = async (): Promise<void> => {
    if (live === null) return;
    await store.write(`${PREFIX}index.json.sig`, live.sig, { contentType: 'application/json', cacheControl: FIVE_MINUTES }).catch(() => undefined);
    await store.write(`${PREFIX}index.json`, live.bytes, { contentType: 'application/json', cacheControl: FIVE_MINUTES }).catch(() => undefined);
  };
  await put(`${PREFIX}index.json.sig`, indexSigBytes, { contentType: 'application/json', cacheControl: FIVE_MINUTES });
  try {
    await put(`${PREFIX}index.json`, indexBytes, { contentType: 'application/json', cacheControl: FIVE_MINUTES });
    await readBack(store, `${PREFIX}index.json`, indexBytes);
    await readBack(store, `${PREFIX}index.json.sig`, indexSigBytes);
  } catch (e) {
    await restore();
    if (e instanceof ToolError) throw new ToolError(e.code, `${e.message}; the previous index and signature were put back`);
    throw e;
  }
  return { published: true, sequence, indexBytes, indexSig: textOf(indexSig), uploaded };
}
