// Test helper for the corpus tests: generates Ed25519 key pairs with WebCrypto, signs the way the release tools do, and builds
// indexes and signature files. Everything here is generated at run time: no key in this file is a real key, and no term is real.
import { createHash, webcrypto } from 'node:crypto';
import { prng, writeZip } from './corpus-zip-writer.js';

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

// --- a synthetic terms release (design 6.5 to 6.7), with invented words only ---

export type Json = Record<string, unknown>;

/** One term row as the design's table shows it. */
export const termRow = (over: Json = {}): Json => ({
  id: 'CWT-2026-00001',
  term: 'zorbak',
  languages: ['en'],
  category: 'slur',
  target: 'none',
  severity: 'severe',
  status: 'accepted',
  defaultActive: true,
  collidesWith: [],
  since: '2026.12.0',
  approvals: 2,
  positive: ['you zorbak', 'ZORBAK!!'],
  negative: ['zorbakian', 'szorbak'],
  ...over,
});

/** Eight rows that between them use every status, category, severity and language, a collision and a default-off row. */
export function exampleTerms(): Json[] {
  return [
    termRow(),
    termRow({ id: 'CWT-2026-00002', term: 'vlemmo', category: 'abuse', severity: 'hostile', positive: ['you vlemmo', 'VLEMMO'], negative: ['vlemmoid', 'uvlemmo'] }),
    termRow({ id: 'CWT-2026-00003', term: 'quissel', category: 'abuse', severity: 'rude', status: 'provisional', approvals: 1, positive: ['you quissel'], negative: ['quisselx'] }),
    termRow({ id: 'CWT-2026-00004', term: 'drakkuun', languages: ['es'], severity: 'severe', status: 'provisional', approvals: 1, collidesWith: ['en'], positive: ['eres drakkuun'], negative: ['drakkuunes'] }),
    termRow({ id: 'CWT-2026-00005', term: 'fenrisk', languages: ['es', 'pt'], category: 'sexual', severity: 'hostile', positive: ['fenrisk!'], negative: ['fenrisko'] }),
    termRow({ id: 'CWT-2026-00006', term: 'tarvo', languages: ['pt'], category: 'other', severity: 'hostile', status: 'disputed', approvals: 2, positive: ['tarvo'], negative: ['tarvos'] }),
    termRow({ id: 'CWT-2026-00007', term: 'snerp', category: 'slur', severity: 'severe', status: 'withdrawn', positive: ['snerp'], negative: ['snerpy'] }),
    termRow({ id: 'CWT-2026-00008', term: 'glarn', defaultActive: false, positive: ['you glarn'], negative: ['glarny'] }),
  ];
}

export function exampleExceptions(): Json[] {
  return [
    { id: 'CWX-2026-00007', phrase: 'snerp glarn', languages: ['en'], status: 'accepted' },
    { id: 'CWX-2026-00008', phrase: 'tarvo lake', languages: ['pt'], status: 'provisional' },
    { id: 'CWX-2026-00009', phrase: 'quissel bay', languages: ['en'], status: 'withdrawn' },
  ];
}

export const exampleNegative = (language: string, over: Json = {}): Json => ({
  schema: 'chatwarden-corpus-negative/1',
  language,
  lines: [`a plain ${language} sentence`, `another ${language} sentence`],
  knownLosses: [],
  ...over,
});

export interface ReleaseParts {
  terms?: unknown;
  exceptions?: unknown;
  negative?: Record<string, unknown>;
  /** null leaves positive.json out. */
  positive?: unknown;
  /** Replaces top-level fields of the manifest; files and counts are computed unless given here. */
  manifest?: Json;
  /** Entries of the zip that are not listed in the manifest (and so unverified). */
  unlisted?: Record<string, Uint8Array | string>;
  /** Names left out of the zip, and out of the manifest. */
  omit?: string[];
  /** Byte-level changes applied after the hashes were taken (a tampered entry). */
  tamper?: Record<string, (bytes: Uint8Array) => Uint8Array>;
  /** Raw text instead of JSON for an entry. */
  raw?: Record<string, string>;
}

const asBytes = (v: unknown): Uint8Array => enc.encode(typeof v === 'string' ? v : JSON.stringify(v));
export const sha256HexNode = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The entries of a release (name to bytes) with a manifest whose hashes are right, unless parts says otherwise. */
export function releaseFiles(parts: ReleaseParts = {}): Map<string, Uint8Array> {
  const terms = parts.terms === undefined ? exampleTerms() : parts.terms;
  const exceptions = parts.exceptions === undefined ? exampleExceptions() : parts.exceptions;
  const negative = parts.negative ?? { en: exampleNegative('en'), es: exampleNegative('es', { knownLosses: ['una frase que se pierde'] }), pt: exampleNegative('pt') };
  const data = new Map<string, Uint8Array>();
  data.set('terms.json', asBytes(terms));
  data.set('exceptions.json', asBytes(exceptions));
  for (const [lang, file] of Object.entries(negative)) data.set(`negative.${lang}.json`, asBytes(file));
  if (parts.positive !== null) {
    data.set('positive.json', asBytes(parts.positive ?? { schema: 'chatwarden-corpus-positive/1', lines: ['a pack wide line that must block: you zorbak'] }));
  }
  for (const [name, text] of Object.entries(parts.raw ?? {})) data.set(name, enc.encode(text));
  for (const name of parts.omit ?? []) data.delete(name);
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const [name, bytes] of data) files[name] = { bytes: bytes.length, sha256: sha256HexNode(bytes) };
  const rows = Array.isArray(terms) ? (terms as Json[]) : [];
  const exRows = Array.isArray(exceptions) ? (exceptions as Json[]) : [];
  const count = (lang: string, list: Json[]): number => list.filter((r) => r !== null && typeof r === 'object' && Array.isArray(r.languages) && (r.languages as string[]).includes(lang)).length;
  const manifest: Json = {
    schema: 'chatwarden-corpus-manifest/1',
    kind: 'terms',
    version: '2026.12.0',
    sequence: 14,
    builtAt: '2026-12-01T00:00:00Z',
    previous: '2026.11.0',
    license: { spdx: 'CC-BY-4.0', attribution: 'Contains the Chatwarden community term list (chatwarden.dev), CC BY 4.0.' },
    languages: ['en', 'es', 'pt'],
    counts: {
      terms: Object.fromEntries(['en', 'es', 'pt'].map((l) => [l, count(l, rows)])),
      exceptions: Object.fromEntries(['en', 'es', 'pt'].map((l) => [l, count(l, exRows)])),
      status: Object.fromEntries(['accepted', 'provisional', 'disputed', 'withdrawn'].map((st) => [st, rows.filter((r) => r !== null && typeof r === 'object' && r.status === st).length])),
    },
    files,
    gate: { matcher: '0.1.11', positiveLines: 15, negativeLines: 40, crossLanguageLines: 90, passed: true },
    ...parts.manifest,
  };
  const out = new Map<string, Uint8Array>();
  out.set('manifest.json', asBytes(manifest));
  for (const [name, bytes] of data) out.set(name, parts.tamper?.[name]?.(bytes) ?? bytes);
  out.set('LICENSE.txt', enc.encode('CC BY 4.0 (a stand-in for the licence text)'));
  out.set('README.txt', enc.encode('This archive holds invented words only.'));
  for (const [name, content] of Object.entries(parts.unlisted ?? {})) out.set(name, typeof content === 'string' ? enc.encode(content) : content);
  const tamperManifest = parts.tamper?.['manifest.json'];
  if (tamperManifest !== undefined) out.set('manifest.json', tamperManifest(out.get('manifest.json') as Uint8Array));
  return out;
}

/** The same entries as a zip: deflated, ZipCrypto under the public password, the way the release builder writes it. */
export function releaseZip(parts: ReleaseParts = {}): Uint8Array {
  return writeZip([...releaseFiles(parts)].map(([name, data]) => ({ name, data, method: 8, password: 'chatwarden-terms' })));
}

// --- generated packs for the selection and benchmark tests ---

const ONSETS = ['z', 'v', 'q', 'x', 'j', 'w'];
const VOWELS = ['a', 'e', 'i', 'o', 'u'];

/**
 * `n` distinct invented words, made at run time from syllables of an onset in z v q x j w and a vowel (so a word is never a real
 * word, still less a slur), three or four syllables long. Two words never fold to the same collapsed form.
 */
export function inventedWords(n: number, seed = 1): string[] {
  const syllables = ONSETS.flatMap((o) => VOWELS.map((v) => o + v));
  const out: string[] = [];
  const seen = new Set<string>();
  const rand = prng(seed);
  const next = (k: number): number => Math.floor(rand() * k);
  while (out.length < n) {
    const len = 3 + next(2);
    let word = '';
    for (let i = 0; i < len; i += 1) word += syllables[next(syllables.length)];
    // the matcher reads a word once, after collapsing repeats; keep the collapsed form unique
    const key = word.replace(/(.)\1+/g, '$1');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

/** Term rows for `words`, cycling through statuses, severities and languages so a selection has something to select. */
export function generatedTerms(words: readonly string[], over: (i: number) => Json = () => ({})): Json[] {
  const statuses = ['accepted', 'accepted', 'provisional', 'accepted', 'disputed', 'accepted', 'withdrawn'];
  const severities = ['severe', 'hostile', 'hostile', 'rude', 'severe'];
  const categories = ['slur', 'abuse', 'sexual', 'other'];
  const langSets = [['en'], ['en'], ['es'], ['pt'], ['en', 'es'], ['es', 'pt']];
  return words.map((term, i) =>
    termRow({
      id: `CWT-2026-${String(i + 1).padStart(5, '0')}`,
      term,
      languages: langSets[i % langSets.length],
      category: categories[i % categories.length],
      severity: severities[i % severities.length],
      status: statuses[i % statuses.length],
      positive: [`you ${term}`, `${term.toUpperCase()}!!`, `what a ${term} that was`],
      negative: [`${term}ian`, `un${term}`],
      ...over(i),
    }),
  );
}
