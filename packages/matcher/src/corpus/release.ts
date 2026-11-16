import { collapseLikePreset, foldTerm } from '../normalise.js';
import { parseUtcDate } from './dates.js';
import { CorpusError } from './errors.js';
import { sha256Hex } from './sha256.js';
import { asBytes, isBytes } from './sign.js';

export { sha256Hex } from './sha256.js';

// A terms release, after its zip was read (design 6.5 to 6.7). `parseTermsRelease` takes the entries of an archive whose signature
// and index hash have already verified and turns them into typed rows. It is strict anyway: every file is checked against the
// manifest's hash before any of them is parsed, unknown keys and unknown entries are refusals, and every refusal is a CorpusError
// with a fixed message. A message never carries a term, a phrase, a line or an id from the archive.

/** A term row of `terms.json`. @experimental */
export interface TermRow6 {
  id: string;
  term: string;
  languages: string[];
  category: 'slur' | 'abuse' | 'sexual' | 'other';
  target: 'none' | 'ethnicity' | 'religion' | 'gender' | 'sexuality' | 'disability' | 'nationality' | 'other';
  severity: 'rude' | 'hostile' | 'severe';
  status: 'provisional' | 'accepted' | 'disputed' | 'withdrawn';
  defaultActive: boolean;
  collidesWith: string[];
  since: string;
  approvals: number;
  positive: string[];
  negative: string[];
}

/** A row of `exceptions.json`. @experimental */
export interface ExceptionRow6 {
  id: string;
  phrase: string;
  languages: string[];
  status: TermRow6['status'];
}

/** `negative.<lang>.json`: known-innocent lines and known losses for one language. @experimental */
export interface NegativeFile {
  schema: 'chatwarden-corpus-negative/1';
  language: string;
  lines: string[];
  knownLosses: string[];
}

/** The manifest of a terms release (6.5). `builtAt` is epoch ms. @experimental */
export interface ReleaseManifest {
  schema: 'chatwarden-corpus-manifest/1';
  kind: 'terms';
  version: string;
  sequence: number;
  builtAt: number;
  previous: string | null;
  license: { spdx: string; attribution: string };
  languages: string[];
  counts: {
    terms: Record<string, number>;
    exceptions: Record<string, number>;
    status: { accepted: number; provisional: number; disputed: number; withdrawn: number };
  };
  files: Record<string, { bytes: number; sha256: string }>;
  gate: { matcher: string; positiveLines: number; negativeLines: number; crossLanguageLines: number; passed: true };
}

/** A parsed terms release. `positive` is the pack-wide `positive.json` (empty when the release has none). @experimental */
export interface TermsRelease {
  manifest: ReleaseManifest;
  version: string;
  sequence: number;
  terms: TermRow6[];
  exceptions: ExceptionRow6[];
  negative: Record<string, NegativeFile>;
  positive: string[];
}

const badManifest = (): CorpusError => new CorpusError('bad_manifest', 'unpack');
const badPack = (): CorpusError => new CorpusError('bad_pack', 'validate');

const CATEGORIES: readonly string[] = ['slur', 'abuse', 'sexual', 'other'];
const TARGETS: readonly string[] = ['none', 'ethnicity', 'religion', 'gender', 'sexuality', 'disability', 'nationality', 'other'];
const SEVERITIES: readonly string[] = ['rude', 'hostile', 'severe'];
const STATUSES: readonly string[] = ['provisional', 'accepted', 'disputed', 'withdrawn'];

const VERSION_RE = /^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0|[1-9]\d{0,2})$/;
const TERM_ID_RE = /^CWT-\d{4}-\d{5}$/;
const EXCEPTION_ID_RE = /^CWX-\d{4}-\d{5}$/;
const LANG_RE = /^[a-z]{2,3}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const NEGATIVE_NAME_RE = /^negative\.([a-z]{2,3})\.json$/;
const UNLISTED_OK: readonly string[] = ['manifest.json', 'LICENSE.txt', 'README.txt'];

const MAX_TERMS = 50_000;
const MAX_EXCEPTIONS = 10_000;
const MAX_TERM_LENGTH = 40;
const MAX_ROW_LINES = 50;
const MAX_ROW_LINE = 200;
const MAX_FILE_LINES = 2000;
const MAX_FILE_LINE = 500;
const MAX_PHRASE = 100;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An object whose keys are exactly `keys`: no more, no fewer. Each is read once by the caller. */
function exact(v: unknown, keys: readonly string[], fail: () => CorpusError): Record<string, unknown> {
  if (!isObject(v)) throw fail();
  const own = Object.keys(v);
  if (own.length !== keys.length || own.some((k) => !keys.includes(k))) throw fail();
  return v;
}

function nonNegativeInt(v: unknown, fail: () => CorpusError, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) throw fail();
  return v;
}

function oneOf<T extends string>(v: unknown, list: readonly string[], fail: () => CorpusError): T {
  if (typeof v !== 'string' || !list.includes(v)) throw fail();
  return v as T;
}

function text(v: unknown, fail: () => CorpusError, max: number): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > max) throw fail();
  return v;
}

/** A list of distinct base language tags. */
function languageList(v: unknown, fail: () => CorpusError, min: number, max: number): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw fail();
  const out: string[] = [];
  for (const tag of v as unknown[]) {
    if (typeof tag !== 'string' || !LANG_RE.test(tag) || out.includes(tag)) throw fail();
    out.push(tag);
  }
  return out;
}

function lineList(v: unknown, fail: () => CorpusError, maxCount: number, maxLength: number): string[] {
  if (!Array.isArray(v) || v.length > maxCount) throw fail();
  return (v as unknown[]).map((line) => text(line, fail, maxLength));
}

function jsonOf(bytes: Uint8Array, fail: () => CorpusError): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(asBytes(bytes)));
  } catch {
    throw fail();
  }
}

function parseManifest(bytes: Uint8Array): ReleaseManifest {
  const f = badManifest;
  const m = exact(jsonOf(bytes, f), ['schema', 'kind', 'version', 'sequence', 'builtAt', 'previous', 'license', 'languages', 'counts', 'files', 'gate'], f);
  if (m.schema !== 'chatwarden-corpus-manifest/1') throw f();
  if (m.kind !== 'terms') throw f();
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) throw f();
  const sequence = nonNegativeInt(m.sequence, f);
  const builtAt = parseUtcDate(m.builtAt);
  if (builtAt === null) throw f();
  const previous = m.previous;
  if (previous !== null && (typeof previous !== 'string' || !VERSION_RE.test(previous))) throw f();
  const license = exact(m.license, ['spdx', 'attribution'], f);
  const licenseOut = { spdx: text(license.spdx, f, 64), attribution: text(license.attribution, f, 500) };
  const languages = languageList(m.languages, f, 0, 16);

  const counts = exact(m.counts, ['terms', 'exceptions', 'status'], f);
  const perLanguage = (v: unknown): Record<string, number> => {
    if (!isObject(v)) throw f();
    const out: Record<string, number> = {};
    for (const tag of Object.keys(v)) {
      if (!LANG_RE.test(tag)) throw f();
      out[tag] = nonNegativeInt(v[tag], f);
    }
    return out;
  };
  const status = exact(counts.status, STATUSES, f);
  const statusOut = {
    accepted: nonNegativeInt(status.accepted, f),
    provisional: nonNegativeInt(status.provisional, f),
    disputed: nonNegativeInt(status.disputed, f),
    withdrawn: nonNegativeInt(status.withdrawn, f),
  };
  const countsOut = { terms: perLanguage(counts.terms), exceptions: perLanguage(counts.exceptions), status: statusOut };

  if (!isObject(m.files)) throw f();
  const files: Record<string, { bytes: number; sha256: string }> = {};
  const names = Object.keys(m.files);
  if (names.length > 40) throw f();
  for (const name of names) {
    if (!isDataName(name)) throw f();
    const entry = exact(m.files[name], ['bytes', 'sha256'], f);
    const hash = entry.sha256;
    if (typeof hash !== 'string' || !SHA_RE.test(hash)) throw f();
    files[name] = { bytes: nonNegativeInt(entry.bytes, f), sha256: hash };
  }
  if (files['terms.json'] === undefined || files['exceptions.json'] === undefined) throw f();

  const gate = exact(m.gate, ['matcher', 'positiveLines', 'negativeLines', 'crossLanguageLines', 'passed'], f);
  if (gate.passed !== true) throw f();
  const gateOut = {
    matcher: text(gate.matcher, f, 32),
    positiveLines: nonNegativeInt(gate.positiveLines, f),
    negativeLines: nonNegativeInt(gate.negativeLines, f),
    crossLanguageLines: nonNegativeInt(gate.crossLanguageLines, f),
    passed: true as const,
  };
  return {
    schema: 'chatwarden-corpus-manifest/1',
    kind: 'terms',
    version: m.version,
    sequence,
    builtAt,
    previous,
    license: licenseOut,
    languages,
    counts: countsOut,
    files,
    gate: gateOut,
  };
}

/** The names a release may hold besides its manifest, licence and readme. */
const isDataName = (name: string): boolean =>
  name === 'terms.json' || name === 'exceptions.json' || name === 'positive.json' || NEGATIVE_NAME_RE.test(name);

function parseTerm(raw: unknown): TermRow6 {
  const f = badPack;
  const r = exact(raw, ['id', 'term', 'languages', 'category', 'target', 'severity', 'status', 'defaultActive', 'collidesWith', 'since', 'approvals', 'positive', 'negative'], f);
  if (typeof r.id !== 'string' || !TERM_ID_RE.test(r.id)) throw f();
  const term = text(r.term, f, MAX_TERM_LENGTH);
  // One word of plain letters once folded, and at least three of them once repeats collapse: what the matcher itself accepts.
  const folded = foldTerm(term);
  if (!/^[a-z]+$/.test(folded) || collapseLikePreset(folded).length < 3) throw f();
  if (typeof r.defaultActive !== 'boolean') throw f();
  if (typeof r.since !== 'string' || !VERSION_RE.test(r.since)) throw f();
  return {
    id: r.id,
    term,
    languages: languageList(r.languages, f, 1, 8),
    category: oneOf(r.category, CATEGORIES, f),
    target: oneOf(r.target, TARGETS, f),
    severity: oneOf(r.severity, SEVERITIES, f),
    status: oneOf(r.status, STATUSES, f),
    defaultActive: r.defaultActive,
    collidesWith: languageList(r.collidesWith, f, 0, 8),
    since: r.since,
    approvals: nonNegativeInt(r.approvals, f, 99),
    positive: lineList(r.positive, f, MAX_ROW_LINES, MAX_ROW_LINE),
    negative: lineList(r.negative, f, MAX_ROW_LINES, MAX_ROW_LINE),
  };
}

function parseException(raw: unknown): ExceptionRow6 {
  const f = badPack;
  const r = exact(raw, ['id', 'phrase', 'languages', 'status'], f);
  if (typeof r.id !== 'string' || !EXCEPTION_ID_RE.test(r.id)) throw f();
  const phrase = text(r.phrase, f, MAX_PHRASE);
  if (phrase.trim().length === 0) throw f();
  for (let i = 0; i < phrase.length; i += 1) {
    const c = phrase.charCodeAt(i);
    if (c < 32 || c === 127) throw f();
  }
  return { id: r.id, phrase, languages: languageList(r.languages, f, 1, 8), status: oneOf(r.status, STATUSES, f) };
}

function parseNegative(bytes: Uint8Array, language: string): NegativeFile {
  const f = badPack;
  const n = exact(jsonOf(bytes, f), ['schema', 'language', 'lines', 'knownLosses'], f);
  if (n.schema !== 'chatwarden-corpus-negative/1' || n.language !== language) throw f();
  return {
    schema: 'chatwarden-corpus-negative/1',
    language,
    lines: lineList(n.lines, f, MAX_FILE_LINES, MAX_FILE_LINE),
    knownLosses: lineList(n.knownLosses, f, MAX_FILE_LINES, MAX_FILE_LINE),
  };
}

function parsePositive(bytes: Uint8Array): string[] {
  const f = badPack;
  const p = exact(jsonOf(bytes, f), ['schema', 'lines'], f);
  if (p.schema !== 'chatwarden-corpus-positive/1') throw f();
  return lineList(p.lines, f, MAX_FILE_LINES, MAX_FILE_LINE);
}

/** Every entry of the archive is accounted for: the data files are listed with the right size and hash, and nothing else is there. */
function checkFiles(entries: Map<string, Uint8Array>, manifest: ReleaseManifest): void {
  for (const [name, bytes] of entries) {
    if (UNLISTED_OK.includes(name)) continue;
    if (!isDataName(name)) throw badManifest();
    const listed = manifest.files[name];
    if (listed === undefined || listed.bytes !== bytes.length || listed.sha256 !== sha256Hex(bytes)) throw badManifest();
  }
  for (const name of Object.keys(manifest.files)) if (!entries.has(name)) throw badManifest();
}

/** The entries as a plain Map of bytes (a copy), or a refusal if the input is not one. */
function entriesOf(files: unknown): Map<string, Uint8Array> {
  if (Object.prototype.toString.call(files) !== '[object Map]') throw badManifest();
  const out = new Map<string, Uint8Array>();
  for (const [name, bytes] of (files as ReadonlyMap<unknown, unknown>).entries()) {
    if (typeof name !== 'string' || !isBytes(bytes)) throw badManifest();
    out.set(name, asBytes(bytes).slice());
  }
  return out;
}

/**
 * Turn the entries of a verified terms archive into a {@link TermsRelease}, or throw a {@link CorpusError}: `bad_manifest` (stage
 * `unpack`) for the manifest, the hashes, the kind, the gate and what the index said it should be, `bad_pack` (stage `validate`) for
 * a row, a line or a file that does not meet the format. `expected` is what the index entry says: the manifest's `version` must equal
 * it and its `sequence` must not be above it. Every file is hashed before any is parsed.
 * @experimental
 */
export function parseTermsRelease(files: ReadonlyMap<string, Uint8Array>, expected?: { version?: string; sequence?: number }): TermsRelease {
  try {
    const entries = entriesOf(files);
    const manifestBytes = entries.get('manifest.json');
    if (manifestBytes === undefined) throw badManifest();
    const manifest = parseManifest(manifestBytes);
    if (expected !== undefined) {
      if (expected.version !== undefined && expected.version !== manifest.version) throw badManifest();
      if (expected.sequence !== undefined && manifest.sequence > expected.sequence) throw badManifest();
    }
    checkFiles(entries, manifest);

    const termsJson = jsonOf(entries.get('terms.json') as Uint8Array, badPack);
    if (!Array.isArray(termsJson) || termsJson.length > MAX_TERMS) throw badPack();
    const terms = (termsJson as unknown[]).map(parseTerm);
    const exceptionsJson = jsonOf(entries.get('exceptions.json') as Uint8Array, badPack);
    if (!Array.isArray(exceptionsJson) || exceptionsJson.length > MAX_EXCEPTIONS) throw badPack();
    const exceptions = (exceptionsJson as unknown[]).map(parseException);

    // A row id is never reused, and a word is one row for the whole corpus (the matcher reads a word once, whatever the language).
    const ids = new Set<string>();
    for (const row of [...terms, ...exceptions]) {
      if (ids.has(row.id)) throw badPack();
      ids.add(row.id);
    }
    const words = new Set<string>();
    for (const t of terms) {
      const key = collapseLikePreset(foldTerm(t.term));
      if (words.has(key)) throw badPack();
      words.add(key);
    }

    const negative: Record<string, NegativeFile> = {};
    for (const [name, bytes] of entries) {
      const m = NEGATIVE_NAME_RE.exec(name);
      if (m !== null) negative[m[1] as string] = parseNegative(bytes, m[1] as string);
    }
    const positiveBytes = entries.get('positive.json');
    const positive = positiveBytes === undefined ? [] : parsePositive(positiveBytes);
    return { manifest, version: manifest.version, sequence: manifest.sequence, terms, exceptions, negative, positive };
  } catch (e) {
    if (e instanceof CorpusError) throw e;
    throw badPack();
  }
}
