import type { Clock, Logger } from '@chatwarden/core';
import type { LiveTerms, SyncResult, SyncSummary } from '../liveTerms.js';
import type { TermPack } from '../termPack.js';
import { readBounded } from './bounded.js';
import { CorpusError, type CorpusErrorCode, type CorpusStage } from './errors.js';
import { parseEvalSet, type EvalSet } from './evalset.js';
import { INDEX_MAX_BYTES, chooseRelease, parseIndex, revokedKeyIdsOf, type CorpusIndex, type CorpusKind, type CorpusReleaseEntry } from './index-file.js';
import { CORPUS_BASE_URL, CORPUS_KEYS, type CorpusKey } from './keys.js';
import { parseTermsRelease, sha256Hex, type TermsRelease } from './release.js';
import { releaseToPack, selectedLanguages, type PackSelection } from './select.js';
import { isBytes, verifySignature } from './sign.js';
import { ZIP_LIMITS, readZip } from './zip.js';

// The loader: design 8.1 and 9. Isomorphic (WebCrypto, an injected `fetch`, an injected cache and timer; no Node-only import, no clock of
// its own). One refresh at a time. Everything unverified stays out of the cache, the pack and the live list: a download is hashed
// against the index, its signature is checked, and only then is it unzipped, parsed and turned into a pack. The disk is untrusted: a
// cached release is verified again every time it is read. Nothing here throws out of refresh(), status() or start(), and a failure
// leaves the list in use exactly as it was. Errors and logs carry a stage and a code, never a term, a URL, a path or a key.
// The same loader reads an eval set (`kind: 'eval'`, design 6.10 and 12): the download, the verification and the cache are the same;
// what is read from the archive is an `EvalSet` (`release()`), there is no pack to apply, and its cache names are its own.

/** A timer the loader can be given: run `fn` once after `ms` milliseconds, and return a function that cancels it. */
export interface Schedule {
  after(ms: number, fn: () => void): () => void;
}

/** The place a loader keeps what it verified (design 8.2). The disk is untrusted; a cache that cannot write rejects. */
export interface CorpusCache {
  read(name: string): Promise<Uint8Array | null>;
  /** Atomic: all or nothing. */
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

export type CorpusLoaderOptions = {
  kind?: CorpusKind;
  select: PackSelection;
  cache: CorpusCache;
  clock: Clock;
  baseUrl?: string;
  /** Base URLs that serve the same paths as `baseUrl`, tried after it. */
  mirrors?: readonly string[];
  keys?: readonly CorpusKey[];
  fetch?: typeof fetch;
  /** A verified release baked into an image; verified exactly like a download, and used only while nothing better is verified. */
  seed?: { zip: Uint8Array; sig: Uint8Array };
  apply?: 'manual' | 'auto';
  /** The kit's version, checked against a release's `minKit`. Omit it and `minKit` is not enforced. */
  kit?: string;
  logger?: Logger;
  /** The live list. With it, `pending` reports what applying would change and `apply: 'auto'` applies to it; `applyTo` names one otherwise. */
  terms?: Pick<LiveTerms, 'syncPack'>;
  /** The timer for request timeouts and for `start()`. Default: `setTimeout`, unref'd where the platform has it. */
  schedule?: Schedule;
} & ({ pin: string; follow?: never } | { follow: 'stable'; pin?: never });

export type CorpusState = 'none' | 'ready' | 'stale' | 'offline' | 'failed';

export interface CorpusStatus {
  state: CorpusState;
  /** The version in the live list. */
  applied: string | null;
  /** The newest verified version waiting to be applied. */
  available: string | null;
  lastCheckedAt: number | null;
  lastError: { code: CorpusErrorCode; stage: CorpusStage; at: number } | null;
  /** What applying the verified pack would change. */
  pending: SyncSummary | null;
}

export interface RefreshResult {
  status: CorpusStatus;
  changed: boolean;
}

/**
 * What `createCorpusLoader({ kind: 'eval' })` returns: the same refresh, status and start, with `release()` answering the verified
 * {@link EvalSet} (only the selected languages' cases; its manifest is whole). There is nothing to apply.
 */
export interface CorpusEvalLoader extends Omit<CorpusLoader, 'release' | 'pack' | 'applyTo'> {
  release(): EvalSet | null;
}

export interface CorpusLoader {
  /** Never rejects. A second call while one is running returns the same promise. */
  refresh(): Promise<RefreshResult>;
  status(): CorpusStatus;
  /** The verified, selected pack, or null when nothing is verified. */
  pack(): TermPack | null;
  release(): TermsRelease | null;
  /** Apply the verified pack to a live list (actor `corpus:<version>` unless given). Null when nothing is verified. */
  applyTo(terms: Pick<LiveTerms, 'syncPack'>, actor?: string): SyncResult | null;
  /** Refresh every `everyMs` (default 24 hours, plus or minus 10 percent) until the returned function is called. Does not refresh now. */
  start(options?: { everyMs?: number; schedule?: Schedule; random?: () => number }): () => void;
}

const INDEX_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const SIG_MAX_BYTES = 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION_RE = /^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0|[1-9]\d{0,2})$/;
const KEY_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const KIT_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+].*)?$/;
/** Enough that no real `minKit` is above it: used when the caller does not say which kit this is. */
const ANY_KIT = '999999999.0.0';

/** The default timer: `setTimeout`, unref'd where the platform has it so a pending refresh never keeps a program alive. */
export const systemSchedule: Schedule = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms) as unknown as { unref?: () => void };
    timer.unref?.();
    return () => clearTimeout(timer as unknown as Parameters<typeof clearTimeout>[0]);
  },
};

/** What is on disk, as far as it can be believed: every field is checked, and a bad one is as if it were absent. */
interface DiskState {
  maxSequence: number;
  applied: string | null;
  release: string | null;
  revokedKeyIds: string[];
}

interface Verified {
  version: string;
  sequence: number;
  /** A terms release and its pack, or (for an eval loader) an eval set and no pack. */
  release: TermsRelease | null;
  evalSet: EvalSet | null;
  pack: TermPack | null;
  signer: string;
  fromSeed?: boolean;
}

interface IndexCopy {
  bytes: Uint8Array;
  sig: Uint8Array;
  etag: string | null;
}

const err = (code: CorpusErrorCode, stage: CorpusStage): CorpusError => new CorpusError(code, stage);

/** Anything that is not already a CorpusError (a bug, a hostile object) becomes one, so nothing reaches the caller raw. */
function asCorpusError(e: unknown, code: CorpusErrorCode, stage: CorpusStage): CorpusError {
  return e instanceof CorpusError ? e : err(code, stage);
}

/** `YYYY.MM.PATCH` as numbers, for ordering two releases. */
function versionParts(v: string): [number, number, number] {
  const [y, m, p] = v.split('.').map(Number);
  return [y as number, m as number, p as number];
}
function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

function parseDiskState(bytes: Uint8Array | null): DiskState {
  const empty: DiskState = { maxSequence: 0, applied: null, release: null, revokedKeyIds: [] };
  if (bytes === null) return empty;
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return empty;
    const o = json as Record<string, unknown>;
    const version = (v: unknown): string | null => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);
    const ids = Array.isArray(o.revokedKeyIds) ? o.revokedKeyIds.filter((x): x is string => typeof x === 'string' && KEY_ID_RE.test(x)).slice(0, 64) : [];
    const seq = o.maxSequence;
    return {
      maxSequence: typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : 0,
      applied: version(o.applied),
      release: version(o.release),
      revokedKeyIds: ids,
    };
  } catch {
    return empty;
  }
}

/** The sibling signature URL of a mirror's zip URL: `.sig` after the path, before any query. */
function sigUrlOf(zipUrl: string): string {
  const q = zipUrl.indexOf('?');
  return q === -1 ? `${zipUrl}.sig` : `${zipUrl.slice(0, q)}.sig${zipUrl.slice(q)}`;
}

/**
 * Make a loader for the shared term list. Throws a `RangeError` (naming the option, never a value) for a configuration that can never
 * work: neither or both of `pin` and `follow`, a missing cache or clock, a bad `kit` or `apply`, a `kind` that is neither `terms` nor
 * `eval`, or a `select` with no language.
 */
export function createCorpusLoader(options: CorpusLoaderOptions & { kind: 'eval' }): CorpusEvalLoader;
export function createCorpusLoader(options: CorpusLoaderOptions & { kind?: 'terms' }): CorpusLoader;
export function createCorpusLoader(options: CorpusLoaderOptions): CorpusLoader | CorpusEvalLoader;
export function createCorpusLoader(options: CorpusLoaderOptions): CorpusLoader | CorpusEvalLoader {
  const o = options as CorpusLoaderOptions & { pin?: unknown; follow?: unknown };
  if (o === null || typeof o !== 'object') throw new RangeError('createCorpusLoader: options are required');
  if ((o.pin === undefined) === (o.follow === undefined)) throw new RangeError('createCorpusLoader: give pin or follow, not both and not neither');
  if (o.pin !== undefined && (typeof o.pin !== 'string' || !VERSION_RE.test(o.pin))) throw new RangeError('createCorpusLoader: pin must be a release version such as 2026.12.0');
  if (o.follow !== undefined && o.follow !== 'stable') throw new RangeError("createCorpusLoader: follow must be 'stable'");
  if (o.kind !== undefined && o.kind !== 'terms' && o.kind !== 'eval') throw new RangeError("createCorpusLoader: kind must be 'terms' or 'eval'");
  if (o.cache === null || typeof o.cache !== 'object' || typeof o.cache.read !== 'function' || typeof o.cache.write !== 'function' || typeof o.cache.remove !== 'function') {
    throw new RangeError('createCorpusLoader: cache must have read, write and remove');
  }
  if (o.clock === null || typeof o.clock !== 'object' || typeof o.clock.now !== 'function') throw new RangeError('createCorpusLoader: clock must have now()');
  if (o.kit !== undefined && (typeof o.kit !== 'string' || !KIT_RE.test(o.kit))) throw new RangeError('createCorpusLoader: kit must be a version such as 0.1.11');
  if (o.apply !== undefined && o.apply !== 'manual' && o.apply !== 'auto') throw new RangeError("createCorpusLoader: apply must be 'manual' or 'auto'");
  if (o.select === null || typeof o.select !== 'object') throw new RangeError('createCorpusLoader: select is required');

  const kind: CorpusKind = o.kind ?? 'terms';
  const pin = o.pin as string | undefined;
  const cache = o.cache;
  const clock = o.clock;
  const keys: readonly CorpusKey[] = o.keys ?? CORPUS_KEYS;
  const schedule: Schedule = o.schedule ?? systemSchedule;
  const mode = o.apply ?? 'manual';
  const kit = o.kit ?? ANY_KIT;
  const select = o.select;
  const bases = [o.baseUrl ?? CORPUS_BASE_URL, ...(o.mirrors ?? [])].map((b) => String(b).replace(/\/+$/, ''));
  let target: Pick<LiveTerms, 'syncPack'> | undefined = kind === 'terms' ? o.terms : undefined;
  // An eval set has its own state file, so a term list and an eval set can share one cache folder.
  const stateName = kind === 'terms' ? 'state.json' : 'state-eval.json';
  // Only an eval loader needs the languages (a term list's selection is checked when the pack is built).
  const evalLanguages = kind === 'eval' ? selectedLanguages(select) : [];

  const warn = (event: string, detail: Record<string, string | number | boolean>): void => {
    try {
      const out: unknown = o.logger === undefined ? console.warn(event, detail) : o.logger.warn(event, detail);
      if (typeof (out as { then?: unknown } | null | undefined)?.then === 'function') (out as PromiseLike<unknown>).then(undefined, () => undefined);
    } catch {
      // a logger that throws must not break a refresh
    }
  };

  // --- what the loader knows ---
  let verified: Verified | null = null;
  let applied: string | null = null;
  let pending: SyncSummary | null = null;
  let lastCheckedAt: number | null = null;
  let lastError: CorpusStatus['lastError'] = null;
  let state: CorpusState = 'none';
  let maxSequence = 0;
  const revoked = new Set<string>();
  let diskLoaded = false;
  let seedTried = false;
  let earlyError: CorpusError | null = null;
  let memIndex: IndexCopy | null = null;
  let lastCommit = '';
  let inflight: Promise<RefreshResult> | null = null;
  /** The queue of state.json writes: one at a time, each built from the values at the moment it runs, so an older write never lands last. */
  let writes: Promise<void> = Promise.resolve();
  /** The release state.json names (the one in the cache folder), as far as this loader knows. */
  let diskRelease: string | null = null;
  /** The ratchet (highest sequence, revoked key ids) as last written or read, to know when it has moved. */
  let persistedRatchet = '0|';
  /** Whether the verified pack has been handed to the live list since this loader was made. */
  let installed = false;
  /** The newest index that verified (from this run or from the disk), for the checks on a cached release. */
  let lastIndex: CorpusIndex | null = null;

  const zipName = (v: string): string => `releases/${kind}-${v}.zip`;

  // --- cache access: a failure to read is a miss; a failure to write is `cache_failed` ---
  async function safeRead(name: string): Promise<Uint8Array | null> {
    try {
      const got = await cache.read(name);
      return isBytes(got) ? got : null;
    } catch {
      return null;
    }
  }
  /** Write state.json after everything queued before it. Rejects with `cache_failed`; the queue goes on either way. */
  function writeState(release?: string | null): Promise<void> {
    const job = writes.then(async () => {
      const named = release === undefined ? diskRelease : release;
      await put(stateName, stateBytes(named));
      diskRelease = named;
      persistedRatchet = ratchetKey();
    });
    writes = job.catch(() => undefined);
    return job;
  }
  async function put(name: string, bytes: Uint8Array): Promise<void> {
    try {
      await cache.write(name, bytes);
    } catch {
      throw err('cache_failed', 'cache');
    }
  }
  const ratchetKey = (): string => `${maxSequence}|${[...revoked].join(',')}`;
  function stateBytes(release: string | null): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ maxSequence, applied, checkedAt: lastCheckedAt, release, revokedKeyIds: [...revoked].slice(0, 64) }),
    );
  }

  // --- network ---
  async function readCapped(res: Response, cap: number, stage: CorpusStage): Promise<Uint8Array> {
    const bytes = await readBounded(res, cap);
    if (bytes === null) throw err('too_large', stage);
    return bytes;
  }

  /** One GET with a deadline of its own. A 304 (only asked for with an ETag) comes back with `bytes: null`. */
  function getOne(url: string, spec: { cap: number; timeoutMs: number; stage: CorpusStage }, etag: string | null): Promise<{ bytes: Uint8Array | null; etag: string | null }> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let cancel: () => void = () => undefined;
    const timeout = new Promise<never>((_, reject) => {
      cancel = schedule.after(spec.timeoutMs, () => {
        reject(err('timeout', spec.stage));
        try {
          controller?.abort();
        } catch {
          // nothing to abort
        }
      });
    });
    const work = (async (): Promise<{ bytes: Uint8Array | null; etag: string | null }> => {
      try {
        const doFetch = o.fetch ?? globalThis.fetch;
        const res = await doFetch(url, { method: 'GET', headers: etag === null ? {} : { 'if-none-match': etag }, ...(controller === null ? {} : { signal: controller.signal }) });
        if (res === null || typeof res !== 'object' || typeof res.status !== 'number') throw err('offline', spec.stage);
        if (res.status === 304 && etag !== null) return { bytes: null, etag };
        if (!res.ok) {
          try {
            await res.body?.cancel();
          } catch {
            // nothing to release
          }
          throw err('offline', spec.stage);
        }
        const bytes = await readCapped(res, spec.cap, spec.stage);
        return { bytes, etag: res.headers?.get?.('etag') ?? null };
      } catch (e) {
        throw asCorpusError(e, 'offline', spec.stage);
      }
    })();
    work.catch(() => undefined);
    return Promise.race([work, timeout]).finally(() => cancel());
  }

  /** The first URL that answers (and, with `accept`, whose bytes are acceptable). A body that was refused is `hash_mismatch` if nothing else is accepted. */
  async function fetchFirst(
    urls: string[],
    spec: { cap: number; timeoutMs: number; stage: CorpusStage; etag?: string | null; accept?: (bytes: Uint8Array) => boolean },
  ): Promise<{ bytes: Uint8Array | null; etag: string | null }> {
    let last: CorpusError | null = null;
    let mismatch = false;
    for (const [i, url] of urls.entries()) {
      try {
        const got = await getOne(url, spec, i === 0 ? (spec.etag ?? null) : null);
        if (got.bytes !== null && spec.accept !== undefined && !spec.accept(got.bytes)) {
          mismatch = true;
          continue;
        }
        return got;
      } catch (e) {
        last = asCorpusError(e, 'offline', spec.stage);
      }
    }
    throw mismatch ? err('hash_mismatch', spec.stage) : (last ?? err('offline', spec.stage));
  }

  // --- verification of a release's bytes (from the network, the disk or the seed) ---
  async function verifyRelease(
    zip: Uint8Array,
    sig: Uint8Array,
    expected: { version?: string; sequence?: number },
    afterSignature?: () => void,
  ): Promise<Verified> {
    const { keyId } = await verifySignature('zip', zip, sig, keys, { revokedKeyIds: [...revoked] });
    afterSignature?.();
    const files = await readZip(zip);
    if (kind === 'eval') {
      const set = parseEvalSet(files, expected);
      // Only the selected languages' cases are kept; the manifest still says what the whole release holds.
      const byLanguage: EvalSet['byLanguage'] = {};
      for (const tag of evalLanguages) if (set.byLanguage[tag] !== undefined) byLanguage[tag] = set.byLanguage[tag];
      const cases = set.manifest.languages.flatMap((l) => byLanguage[l] ?? []);
      return { version: set.version, sequence: set.sequence, release: null, evalSet: { ...set, cases, byLanguage }, pack: null, signer: keyId };
    }
    const release = parseTermsRelease(files, expected);
    let pack: TermPack;
    try {
      pack = releaseToPack(release, select);
    } catch (e) {
      throw asCorpusError(e, 'bad_pack', 'validate');
    }
    return { version: release.version, sequence: release.sequence, release, evalSet: null, pack, signer: keyId };
  }

  /** The cached copy of a release, verified again; null (with `earlyError` set when it was there but wrong) if it cannot be used. */
  async function loadCachedRelease(version: string, index: CorpusIndex | null): Promise<Verified | null> {
    const zip = await safeRead(zipName(version));
    const sig = await safeRead(`${zipName(version)}.sig`);
    if (zip === null || sig === null) return null;
    try {
      const entry = index?.releases.find((r) => r.kind === kind && r.version === version);
      if (index !== null && index.revokedReleases.some((r) => r.kind === kind && r.version === version)) throw err('revoked_release', 'index');
      // The signature first (a tampered file is a bad signature), then the index's hash of it, then the contents.
      return await verifyRelease(zip, sig, { version, ...(index === null ? {} : { sequence: index.sequence }) }, () => {
        if (entry !== undefined && (entry.bytes !== zip.length || entry.sha256 !== sha256Hex(zip))) throw err('hash_mismatch', 'verify');
      });
    } catch (e) {
      earlyError = asCorpusError(e, 'bad_signature', 'verify');
      return null;
    }
  }

  async function loadDisk(): Promise<void> {
    const disk = parseDiskState(await safeRead(stateName));
    maxSequence = Math.max(maxSequence, disk.maxSequence);
    for (const id of disk.revokedKeyIds) revoked.add(id);
    applied = disk.applied;
    diskRelease = disk.release;
    let index: CorpusIndex | null = null;
    const indexBytes = await safeRead('index.json');
    const indexSig = await safeRead('index.json.sig');
    if (indexBytes !== null && indexSig !== null) {
      try {
        const { keyId } = await verifySignature('index', indexBytes, indexSig, keys, { revokedKeyIds: [...revoked] });
        const parsed = parseIndex(indexBytes, 0);
        if (parsed.keyId !== keyId) throw err('bad_signature', 'verify');
        index = parsed;
        lastIndex = parsed;
        maxSequence = Math.max(maxSequence, parsed.sequence);
        for (const id of revokedKeyIdsOf(parsed, keyId)) revoked.add(id);
        memIndex = { bytes: indexBytes, sig: indexSig, etag: null };
      } catch (e) {
        earlyError = asCorpusError(e, 'bad_signature', 'verify');
      }
    }
    // What the folder says (state.json, and the index beside it) is on disk already; only what is learned after this needs writing.
    persistedRatchet = ratchetKey();
    const version = pin ?? disk.release;
    if (version !== null && version !== undefined) {
      const loaded = await loadCachedRelease(version, index);
      if (loaded !== null) verified = loaded;
    }
  }

  async function loadSeed(): Promise<void> {
    const seed = o.seed;
    if (seed === undefined) return;
    try {
      if (!isBytes(seed.zip) || !isBytes(seed.sig)) throw err('bad_zip', 'unpack');
      const out = await verifyRelease(seed.zip, seed.sig, {});
      if (pin !== undefined && out.version !== pin) throw err('no_such_version', 'unpack');
      verified = { ...out, fromSeed: true };
    } catch (e) {
      earlyError = asCorpusError(e, 'bad_signature', 'verify');
    }
  }

  // --- the index ---
  async function fetchIndex(): Promise<{ index: CorpusIndex; copy: IndexCopy; signer: string }> {
    const urls = (path: string): string[] => bases.map((b) => `${b}/${path}`);
    const got = await fetchFirst(urls('index.json'), { cap: INDEX_MAX_BYTES, timeoutMs: INDEX_TIMEOUT_MS, stage: 'index', etag: memIndex?.etag ?? null });
    let copy: IndexCopy;
    if (got.bytes === null) {
      if (memIndex === null) throw err('offline', 'index');
      copy = memIndex;
    } else {
      const sig = await fetchFirst(urls('index.json.sig'), { cap: SIG_MAX_BYTES, timeoutMs: INDEX_TIMEOUT_MS, stage: 'index' });
      copy = { bytes: got.bytes, sig: sig.bytes as Uint8Array, etag: got.etag };
    }
    const { keyId } = await verifySignature('index', copy.bytes, copy.sig, keys, { revokedKeyIds: [...revoked] });
    // Parsed with no expiry (now 0) so a replayed old index is told apart by its sequence first; expiry is checked right after.
    const index = parseIndex(copy.bytes, 0);
    if (index.keyId !== keyId) throw err('bad_signature', 'verify');
    if (index.sequence < maxSequence) throw err('rollback', 'index');
    if (clock.now() >= index.expiresAt) throw err('index_expired', 'index');
    maxSequence = Math.max(maxSequence, index.sequence);
    for (const id of revokedKeyIdsOf(index, keyId)) revoked.add(id);
    memIndex = copy;
    lastIndex = index;
    return { index, copy, signer: keyId };
  }

  /** The write of design 9 step 9: the release (when it is new), the index, then state.json last. All or nothing for the loader's view. */
  async function commit(entry: CorpusReleaseEntry, fresh: { zip: Uint8Array; sig: Uint8Array } | null, copy: IndexCopy): Promise<void> {
    const key = `${maxSequence}|${entry.version}|${applied}|${[...revoked].join(',')}|${sha256Hex(copy.bytes)}`;
    if (fresh === null && key === lastCommit) return;
    if (fresh !== null) {
      await put(zipName(entry.version), fresh.zip);
      await put(`${zipName(entry.version)}.sig`, fresh.sig);
    }
    await put('index.json', copy.bytes);
    await put('index.json.sig', copy.sig);
    await writeState(entry.version);
    lastCommit = key;
  }

  async function step(): Promise<void> {
    if (keys.length === 0) throw err('no_trusted_keys', 'verify');
    if (!diskLoaded) {
      diskLoaded = true;
      await loadDisk();
    }
    if (verified === null && !seedTried) {
      seedTried = true;
      await loadSeed();
    }
    const { index, copy } = await fetchIndex();
    // A key the index revokes is not trusted any more, and neither is what it signed (the loader moves to the re-release).
    if (verified !== null && revoked.has(verified.signer)) verified = null;
    if (verified !== null && index.revokedReleases.some((r) => r.kind === kind && r.version === verified?.version)) verified = null;
    const entry = chooseRelease(index, { kind, kit, ...(pin === undefined ? { follow: 'stable' as const } : { pin }) });
    // Following never goes back to an older release; a pin is the adopter's own choice and may.
    if (pin === undefined && verified !== null && compareVersions(entry.version, verified.version) < 0) throw err('rollback', 'index');
    if (verified !== null && verified.version === entry.version && !verified.fromSeed) {
      await commit(entry, null, copy);
      return;
    }
    const cached = await loadCachedRelease(entry.version, index);
    if (cached !== null) {
      await commit(entry, null, copy);
      verified = cached;
      return;
    }
    // Download: the base URL, then each mirror; the bytes must be what the index says before anything else is done with them.
    const zipUrls = [...bases.map((b) => `${b}/${entry.zip}`), ...entry.mirrors.map((m) => m.url)];
    const sigUrls = [...bases.map((b) => `${b}/${entry.sig}`), ...entry.mirrors.map((m) => sigUrlOf(m.url))];
    const cap = Math.min(ZIP_LIMITS.compressed, entry.bytes);
    const zip = await fetchFirst(zipUrls, {
      cap,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      stage: 'download',
      accept: (b) => b.length === entry.bytes && sha256Hex(b) === entry.sha256,
    });
    const sig = await fetchFirst(sigUrls, { cap: SIG_MAX_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS, stage: 'download' });
    const zipBytes = zip.bytes as Uint8Array;
    const sigBytes = sig.bytes as Uint8Array;
    const next = await verifyRelease(zipBytes, sigBytes, { version: entry.version, sequence: index.sequence });
    if (pin === undefined && verified !== null && next.sequence < verified.sequence) throw err('rollback', 'index');
    await commit(entry, { zip: zipBytes, sig: sigBytes }, copy);
    verified = next;
  }

  // --- applying ---
  function tryApply(terms: Pick<LiveTerms, 'syncPack'>, v: Verified, actor: string, dryRun: boolean): SyncResult {
    try {
      if (v.pack === null) return { ok: false, code: 'build_failed' };
      const r = terms.syncPack(v.pack, { actor, dryRun });
      return r !== null && typeof r === 'object' && typeof r.ok === 'boolean' ? r : { ok: false, code: 'build_failed' };
    } catch {
      return { ok: false, code: 'build_failed' };
    }
  }

  /**
   * After a restart with a newer release waiting (apply `manual`): the live list still holds the app's own pack, so the release state.json
   * says is applied is read back from the cache (verified again, like any read) and handed over for real. The newer one is only dry-run.
   * Returns the error to report when the applied version cannot be had, or null.
   */
  async function installApplied(live: Pick<LiveTerms, 'syncPack'>): Promise<CorpusError | null> {
    if (applied === null) return null;
    const saved = earlyError;
    try {
      const cached = await loadCachedRelease(applied, lastIndex);
      if (cached === null || cached.pack === null) return earlyError ?? err('cache_failed', 'cache');
      const r = tryApply(live, cached, `corpus:${cached.version}`, false);
      if (!r.ok) return err('bad_pack', 'validate');
      installed = true;
      return null;
    } finally {
      earlyError = saved;
    }
  }

  function persist(): void {
    writeState().catch(() => warn('corpus.refresh_failed', { stage: 'cache', code: 'cache_failed' }));
  }

  // --- refresh ---
  async function run(): Promise<RefreshResult> {
    await writes;
    const before = { version: verified?.version ?? null, applied };
    earlyError = null;
    lastCheckedAt = clock.now();
    let failure: CorpusError | null = null;
    try {
      await step();
    } catch (e) {
      failure = asCorpusError(e, 'bad_pack', 'validate');
    }
    // A verified index raised the ratchet (or named revoked keys) but the run did not get to commit: record that anyway, so a restart
    // cannot accept an older replayed index. A write that fails changes nothing else.
    if (failure !== null && ratchetKey() !== persistedRatchet) await writeState().catch(() => undefined);
    // The cached file or the seed that would not verify is the news when there is no network and nothing else to use.
    if (failure !== null && (failure.code === 'offline' || failure.code === 'timeout') && verified === null && earlyError !== null) failure = earlyError;
    if (failure === null) {
      earlyError = null;
    }
    const live = target;
    if (kind === 'terms' && verified !== null && live !== undefined && verified.version !== applied) {
      const actor = `corpus:${verified.version}`;
      if (mode === 'auto') {
        const r = tryApply(live, verified, actor, false);
        if (r.ok) {
          applied = verified.version;
          pending = null;
          installed = true;
          persist();
        } else if (failure === null) {
          failure = err('bad_pack', 'validate');
        }
      } else {
        // The usual restart: the applied release is in, a newer one waits. The applied pack goes in first, once per start.
        if (!installed && applied !== null) {
          const lost = await installApplied(live);
          if (lost !== null && failure === null) failure = lost;
        }
        const r = tryApply(live, verified, actor, true);
        pending = r.ok ? r.summary : null;
        if (!r.ok && failure === null) failure = err('bad_pack', 'validate');
      }
    } else if (kind === 'terms' && verified !== null && live !== undefined && !installed) {
      // The release is already applied (state.json says so) but this loader has not handed its pack to the live list: the canary and
      // check() would still read the app's own pack, and a store that did not survive the restart would stay empty. The sync of a
      // version that is already in is a no-op for the rows, so it is done once per start whatever `apply` is.
      const r = tryApply(live, verified, `corpus:${verified.version}`, false);
      if (r.ok) installed = true;
      else if (failure === null) failure = err('bad_pack', 'validate');
      pending = null;
    } else if (verified === null || verified.version === applied) {
      pending = null;
    }
    lastError = failure === null ? null : { code: failure.code, stage: failure.stage, at: lastCheckedAt };
    if (failure === null) state = verified === null ? 'none' : 'ready';
    else if (failure.code === 'index_expired') state = verified === null ? 'failed' : 'stale';
    else if (failure.code === 'offline' || failure.code === 'timeout') state = verified === null ? 'none' : 'offline';
    else state = 'failed';
    if (failure !== null) warn('corpus.refresh_failed', { stage: failure.stage, code: failure.code });
    const changed = before.version !== (verified?.version ?? null) || before.applied !== applied;
    return { status: status(), changed };
  }

  function status(): CorpusStatus {
    return {
      state,
      applied,
      available: verified !== null && verified.version !== applied ? verified.version : null,
      lastCheckedAt,
      lastError: lastError === null ? null : { ...lastError },
      pending: pending === null ? null : { ...pending },
    };
  }

  function refresh(): Promise<RefreshResult> {
    if (inflight !== null) return inflight;
    const p: Promise<RefreshResult> = run()
      .catch((): RefreshResult => ({ status: status(), changed: false }))
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
    return p;
  }

  return {
    refresh,
    status,
    pack: () => verified?.pack ?? null,
    // For an eval loader this answers the EvalSet; the overloads of createCorpusLoader say so, and nothing else can reach it.
    release: () => (kind === 'eval' ? (verified?.evalSet ?? null) : (verified?.release ?? null)) as TermsRelease | null,
    applyTo(terms, actor) {
      if (verified === null || verified.pack === null) return null;
      target ??= terms;
      const r = tryApply(terms, verified, typeof actor === 'string' && actor !== '' ? actor : `corpus:${verified.version}`, false);
      if (r.ok) {
        applied = verified.version;
        pending = null;
        installed = true;
        persist();
      }
      return r;
    },
    start(opts = {}) {
      const every = typeof opts.everyMs === 'number' && Number.isFinite(opts.everyMs) && opts.everyMs > 0 ? opts.everyMs : DAY_MS;
      const rand = opts.random ?? Math.random;
      const timer = opts.schedule ?? schedule;
      let stopped = false;
      let cancel: (() => void) | null = null;
      const arm = (): void => {
        if (stopped) return;
        let f = 0.5;
        try {
          const v = rand();
          if (Number.isFinite(v)) f = Math.min(1, Math.max(0, v));
        } catch {
          // a bad random source gets the middle of the range
        }
        try {
          cancel = timer.after(Math.max(1, Math.round(every * (0.9 + 0.2 * f))), tick);
        } catch {
          cancel = null;
        }
      };
      const tick = (): void => {
        cancel = null;
        if (stopped) return;
        void refresh().then(arm, arm);
      };
      arm();
      return () => {
        stopped = true;
        try {
          cancel?.();
        } catch {
          // already gone
        }
        cancel = null;
      };
    },
  };
}
