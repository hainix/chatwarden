import { parseUtcDate } from './dates.js';
import { CorpusError } from './errors.js';
import { asBytes, isBytes } from './sign.js';

// The signed index (design 6.2): what exists, which is latest, what has been revoked. `parseIndex` runs only on bytes whose signature
// verified, but it is strict anyway: it reads each field once, builds fresh objects, and every refusal is a CorpusError with a fixed
// message (it never echoes the input).

/** What a release carries: a term list or an eval set. @experimental */
export type CorpusKind = 'terms' | 'eval';

/** A copy of a release that is hosted somewhere else (a Zenodo record). The signature, not the host, is what is trusted. @experimental */
export interface CorpusMirror {
  kind: string;
  doi?: string;
  url: string;
}

/** The counts for one language in a release entry: `terms` and `exceptions` for a term list, `cases` for an eval set. @experimental */
export type CorpusLanguageCounts = Readonly<Record<string, number>>;

/** One release on the index. `zip` and `sig` are paths below the base URL. @experimental */
export interface CorpusReleaseEntry {
  kind: CorpusKind;
  version: string;
  /** Epoch ms. */
  publishedAt: number;
  minKit: string;
  languages: Readonly<Record<string, CorpusLanguageCounts>>;
  bytes: number;
  sha256: string;
  zip: string;
  sig: string;
  mirrors: readonly CorpusMirror[];
  notes?: string;
}

/** Why a release was pulled; a closed list. @experimental */
export type CorpusRevokeReason = 'bad_release' | 'key_compromise' | 'legal';

/** @experimental */
export interface CorpusRevokedRelease {
  kind: CorpusKind;
  version: string;
  reason: CorpusRevokeReason;
}

/** A parsed, checked index. Dates are epoch ms. @experimental */
export interface CorpusIndex {
  schema: string;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
  keyId: string;
  revokedKeyIds: readonly string[];
  revokedReleases: readonly CorpusRevokedRelease[];
  latest: Readonly<Partial<Record<CorpusKind, string>>>;
  releases: readonly CorpusReleaseEntry[];
}

/** The largest index the loader reads. */
export const INDEX_MAX_BYTES = 256 * 1024;
const ZIP_MAX_BYTES = 8 * 1024 * 1024;
const MAX_RELEASES = 5000;

const bad = (): CorpusError => new CorpusError('bad_index', 'index');

const KINDS: readonly string[] = ['terms', 'eval'];
const REASONS: readonly string[] = ['bad_release', 'key_compromise', 'legal'];
const VERSION_RE = /^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0|[1-9]\d{0,2})$/;
const KIT_RE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;
const KEY_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const COUNT_KEY_RE = /^[a-z][A-Za-z]{0,15}$/;
const MIRROR_KIND_RE = /^[a-z][a-z0-9_-]{0,15}$/;
const PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const URL_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[\x21-\x7e]*)?$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A UTC timestamp as epoch ms; anything that is not a real one is a refusal. */
function parseDate(v: unknown): number {
  const t = parseUtcDate(v);
  if (t === null) throw bad();
  return t;
}

const version = (v: unknown): string => {
  if (typeof v !== 'string' || !VERSION_RE.test(v)) throw bad();
  return v;
};

const kindOf = (v: unknown): CorpusKind => {
  if (typeof v !== 'string' || !KINDS.includes(v)) throw bad();
  return v as CorpusKind;
};

const nonNegativeInt = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw bad();
  return v;
};

/** A path below the base URL: plain segments only, no scheme, no `..`, no query, no leading or double slash. */
function safePath(v: unknown): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 200 || !PATH_RE.test(v)) throw bad();
  if (v.split('/').some((s) => s === '.' || s === '..')) throw bad();
  return v;
}

function parseMirror(v: unknown): CorpusMirror {
  if (!isObject(v)) throw bad();
  const kind = v.kind;
  const doi = v.doi;
  const url = v.url;
  if (typeof kind !== 'string' || !MIRROR_KIND_RE.test(kind)) throw bad();
  if (typeof url !== 'string' || url.length > 500 || !URL_RE.test(url)) throw bad();
  if (doi === undefined || doi === null) return { kind, url };
  if (typeof doi !== 'string' || doi.length < 1 || doi.length > 100 || /\s/.test(doi)) throw bad();
  return { kind, doi, url };
}

function parseLanguages(v: unknown): Record<string, CorpusLanguageCounts> {
  if (!isObject(v)) throw bad();
  const out: Record<string, CorpusLanguageCounts> = {};
  for (const tag of Object.keys(v)) {
    if (!LANG_RE.test(tag)) throw bad();
    const counts = v[tag];
    if (!isObject(counts)) throw bad();
    const row: Record<string, number> = {};
    for (const key of Object.keys(counts)) {
      if (!COUNT_KEY_RE.test(key)) throw bad();
      row[key] = nonNegativeInt(counts[key]);
    }
    out[tag] = row;
  }
  return out;
}

function parseRelease(v: unknown): CorpusReleaseEntry {
  if (!isObject(v)) throw bad();
  const kind = kindOf(v.kind);
  const ver = version(v.version);
  const publishedAt = parseDate(v.publishedAt);
  const minKit = v.minKit;
  if (typeof minKit !== 'string' || !KIT_RE.test(minKit)) throw bad();
  const languages = parseLanguages(v.languages);
  const bytes = v.bytes;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > ZIP_MAX_BYTES) throw bad();
  const sha256 = v.sha256;
  if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) throw bad();
  const zip = safePath(v.zip);
  const sig = safePath(v.sig);
  const rawMirrors = v.mirrors === undefined ? [] : v.mirrors;
  if (!Array.isArray(rawMirrors) || rawMirrors.length > 16) throw bad();
  const mirrors = rawMirrors.map(parseMirror);
  const notes = v.notes;
  const entry: CorpusReleaseEntry = { kind, version: ver, publishedAt, minKit, languages, bytes, sha256, zip, sig, mirrors };
  if (notes !== undefined && notes !== null) {
    if (typeof notes !== 'string' || notes.length > 500) throw bad();
    entry.notes = notes;
  }
  return entry;
}

function parseRevokedRelease(v: unknown): CorpusRevokedRelease {
  if (!isObject(v)) throw bad();
  const kind = kindOf(v.kind);
  const ver = version(v.version);
  const reason = v.reason;
  if (typeof reason !== 'string' || !REASONS.includes(reason)) throw bad();
  return { kind, version: ver, reason: reason as CorpusRevokeReason };
}

function parseIndexInner(input: unknown, now: unknown): CorpusIndex {
  if (typeof now !== 'number' || !Number.isFinite(now)) throw bad();
  let json: unknown = input;
  if (typeof input === 'string') {
    if (input.length > INDEX_MAX_BYTES) throw new CorpusError('too_large', 'index');
    json = JSON.parse(input);
  } else if (isBytes(input)) {
    if (input.byteLength > INDEX_MAX_BYTES) throw new CorpusError('too_large', 'index');
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(asBytes(input)));
  }
  if (!isObject(json)) throw bad();

  const schema = json.schema;
  if (typeof schema !== 'string' || schema !== 'chatwarden-corpus-index/1') throw bad();
  const sequence = json.sequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) throw bad();
  const issuedAt = parseDate(json.issuedAt);
  const expiresAt = parseDate(json.expiresAt);
  if (expiresAt <= issuedAt) throw bad();
  const keyId = json.keyId;
  if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) throw bad();

  const rawRevokedKeys = json.revokedKeyIds;
  if (!Array.isArray(rawRevokedKeys) || rawRevokedKeys.length > 64) throw bad();
  const revokedKeyIds = rawRevokedKeys.map((k: unknown) => {
    if (typeof k !== 'string' || !KEY_ID_RE.test(k)) throw bad();
    return k;
  });
  const rawRevokedReleases = json.revokedReleases;
  if (!Array.isArray(rawRevokedReleases) || rawRevokedReleases.length > MAX_RELEASES) throw bad();
  const revokedReleases = rawRevokedReleases.map(parseRevokedRelease);

  const rawReleases = json.releases;
  if (!Array.isArray(rawReleases) || rawReleases.length < 1 || rawReleases.length > MAX_RELEASES) throw bad();
  const releases = rawReleases.map(parseRelease);
  const seen = new Set<string>();
  for (const r of releases) {
    const id = `${r.kind}:${r.version}`;
    if (seen.has(id)) throw bad();
    seen.add(id);
  }

  const rawLatest = json.latest;
  if (!isObject(rawLatest)) throw bad();
  const latest: Partial<Record<CorpusKind, string>> = {};
  for (const kind of ['terms', 'eval'] as const) {
    const v = rawLatest[kind];
    if (v === undefined) continue;
    const ver = version(v);
    if (!seen.has(`${kind}:${ver}`)) throw bad();
    latest[kind] = ver;
  }
  if (latest.terms === undefined && latest.eval === undefined) throw bad();

  // Checked last, so a malformed index is bad_index even when it is also old.
  if (now >= expiresAt) throw new CorpusError('index_expired', 'index');
  return { schema, sequence, issuedAt, expiresAt, keyId, revokedKeyIds, revokedReleases, latest, releases };
}

/**
 * Read an index (its JSON text, the bytes of it, or an already parsed object) into a checked {@link CorpusIndex}, or throw a
 * {@link CorpusError}: `too_large` (over 256 KiB), `index_expired` (`now`, epoch ms, is at or past `expiresAt`) or `bad_index` for
 * everything else, including a getter that throws or a proxy. Call it on the bytes of an index whose signature verified.
 * @experimental
 */
export function parseIndex(json: unknown, now: number): CorpusIndex {
  try {
    return parseIndexInner(json, now);
  } catch (e) {
    if (e instanceof CorpusError) throw e;
    throw bad();
  }
}

/**
 * The key ids an index revokes, for `verifySignature`'s `options.revokedKeyIds`, leaving out the key that signed the index: an index
 * is believed about other keys, and a key does not get to revoke itself out of the check that just trusted it. The caller passes the
 * `keyId` that `verifySignature('index', ...)` returned.
 * @experimental
 */
export function revokedKeyIdsOf(index: CorpusIndex, signerKeyId: string): string[] {
  return [...new Set(index.revokedKeyIds)].filter((id) => id !== signerKeyId);
}

const kitNumbers = (text: unknown): [number, number, number] | null => {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+].*)?$/.exec(text);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
};

/** Negative when `a` is below `b`, compared part by part as numbers (so 0.1.10 is above 0.1.9). */
const compareKit = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
};

/** What {@link chooseRelease} takes: one of `pin` and `follow`, and the kit's own version. @experimental */
export type ChooseOptions = { kind: CorpusKind; kit: string } & ({ pin: string; follow?: never } | { follow: 'stable'; pin?: never });

/**
 * Pick the release a refresh should fetch: the pinned version, or the index's latest for `kind`. It must be on the index
 * (`no_such_version`), not revoked (`revoked_release`) and not need a newer kit than `kit` (`kit_too_old`, compared as numbers).
 * Giving both `pin` and `follow`, neither, or a `kit` that is not a version is a programming error (a `RangeError`).
 * @experimental
 */
export function chooseRelease(index: CorpusIndex, options: ChooseOptions): CorpusReleaseEntry {
  const { kind, pin, follow, kit } = options as { kind: unknown; pin?: unknown; follow?: unknown; kit: unknown };
  if (typeof kind !== 'string' || !KINDS.includes(kind)) throw new RangeError('chooseRelease: kind must be terms or eval');
  const kitParts = kitNumbers(kit);
  if (kitParts === null) throw new RangeError('chooseRelease: kit must be a version such as 0.1.10');
  if (pin !== undefined && follow !== undefined) throw new RangeError('chooseRelease: give pin or follow, not both');
  if (pin === undefined && follow === undefined) throw new RangeError('chooseRelease: give pin or follow');
  if (follow !== undefined && follow !== 'stable') throw new RangeError("chooseRelease: follow must be 'stable'");
  if (pin !== undefined && typeof pin !== 'string') throw new RangeError('chooseRelease: pin must be a version string');
  const k = kind as CorpusKind;
  const wanted = pin === undefined ? index.latest[k] : (pin as string);
  const entry = wanted === undefined ? undefined : index.releases.find((r) => r.kind === k && r.version === wanted);
  if (entry === undefined) throw new CorpusError('no_such_version', 'index');
  if (index.revokedReleases.some((r) => r.kind === k && r.version === wanted)) throw new CorpusError('revoked_release', 'index');
  const need = kitNumbers(entry.minKit);
  if (need === null || compareKit(need, kitParts) > 0) throw new CorpusError('kit_too_old', 'index');
  return entry;
}
