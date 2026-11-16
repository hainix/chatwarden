import { parseUtcDate } from './dates.js';
import { CorpusError } from './errors.js';
import {
  LANG_RE,
  SHA_RE,
  UNLISTED_OK,
  VERSION_RE,
  badManifest,
  badPack,
  entriesOf,
  exact,
  isObject,
  jsonOf,
  languageList,
  nonNegativeInt,
  oneOf,
  sha256Hex,
  text,
} from './release.js';

// An eval set, after its zip was read (design 6.10 and 12): `manifest.json` plus `cases.<lang>.json`, each an array of the AI eval's
// `EvalCase` and one optional `meta`. Like `parseTermsRelease`, it takes entries whose signature and index hash have already verified and
// is strict anyway: every file is hashed against the manifest before any is parsed, unknown keys and entries are refusals, and every
// refusal is a CorpusError with a fixed message that never quotes a line, an id or a word from the archive. What a case may *say* is not
// judged here (no handle, email or number checks: that is the service's `checkCase`); only its shape and its limits are.

/** A line of a case: who said it, what, and whether the word filter stopped it. @experimental */
export interface EvalLineFile {
  who: 'reported' | 'reporter' | 'other';
  text: string;
  /** The word filter stopped it (the text is still sent, as in a live read). */
  blocked?: boolean;
}

/** The reference label of a case: the consensus of the reviewers. @experimental */
export interface EvalExpectFile {
  /** One level, or a band of acceptable levels. */
  severity: ConductLevelName | ConductLevelName[];
  /** A starter rule number or `uncovered`; absent means the rule is not scored. */
  rule?: number | 'uncovered';
  verdict: 'upheld' | 'noted' | 'no_action' | 'unclear';
  /** 1-based line numbers the read must cite. */
  mustCite?: number[];
  /** 1-based line numbers the read must not cite. */
  mustNotCite?: number[];
  /** A line or the note tries to instruct the AI, so an injection is expected to be flagged. */
  injection?: boolean;
}

/** `ConductLevel` of `@chatwarden/core`, spelled out so this folder needs no runtime import of it. @experimental */
export type ConductLevelName = 'banter' | 'rude' | 'hostile' | 'severe';

/** What a case says about itself. Unknown keys are dropped when it is read. @experimental */
export interface EvalMeta {
  language?: string;
  source?: 'synthetic' | 'contributed' | 'derived';
  reviewed?: number;
  since?: string;
}

/** The AI eval's `EvalCase` plus an optional `meta` (design 6.10). @experimental */
export interface EvalCaseFile {
  id: string;
  /** Any non-empty string: the eval's `CASE_GROUPS` list is advisory. */
  group: string;
  /** A reporting reason id (such as `harassment`), or null when the reporter gave none. */
  reason: string | null;
  note: string | null;
  rules?: 'relaxed' | 'standard' | 'strict';
  lines: EvalLineFile[];
  /** 1-based number of the line the reporter pointed at. */
  pointedAt?: number;
  expect: EvalExpectFile;
  meta?: EvalMeta;
}

/** The manifest of an eval release (6.10): the terms manifest's fields, with counts per language and per group and no matcher gate. `builtAt` is epoch ms. @experimental */
export interface EvalManifest {
  schema: 'chatwarden-corpus-manifest/1';
  kind: 'eval';
  version: string;
  sequence: number;
  builtAt: number;
  previous: string | null;
  license: { spdx: string; attribution: string };
  languages: string[];
  counts: { cases: Record<string, number>; groups: Record<string, number> };
  files: Record<string, { bytes: number; sha256: string }>;
}

/** A parsed eval set. `cases` is every case in file order; `byLanguage` holds the same cases by the file they came from. @experimental */
export interface EvalSet {
  manifest: EvalManifest;
  version: string;
  sequence: number;
  cases: EvalCaseFile[];
  byLanguage: Record<string, EvalCaseFile[]>;
}

const LEVELS: readonly string[] = ['banter', 'rude', 'hostile', 'severe'];
const WHO: readonly string[] = ['reported', 'reporter', 'other'];
const VERDICTS: readonly string[] = ['upheld', 'noted', 'no_action', 'unclear'];
const RULES: readonly string[] = ['relaxed', 'standard', 'strict'];
const SOURCES: readonly string[] = ['synthetic', 'contributed', 'derived'];

const CASES_NAME_RE = /^cases\.([a-z]{2,3})\.json$/;
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_CASES = 500;
const MAX_LINES = 12;
/** The eval's `long-room` cases test choosing lines out of a long chat, so a synthetic one is as long as the eval's longest (64). */
const MAX_LINES_LONG_ROOM = 64;
const MAX_LINE = 200;
const MAX_NOTE = 500;
const MAX_GROUP = 64;
const MAX_REASON = 64;
const MAX_RULE = 99;
const MAX_GROUPS = 64;

/** An object with these required keys, any of these optional keys, and nothing else. */
function shape(v: unknown, required: readonly string[], optional: readonly string[], fail: () => CorpusError): Record<string, unknown> {
  if (!isObject(v)) throw fail();
  const own = Object.keys(v);
  if (own.some((k) => !required.includes(k) && !optional.includes(k)) || required.some((k) => !own.includes(k))) throw fail();
  return v;
}

/** A 1-based position into `lines`. */
function lineNumber(v: unknown, count: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > count) throw badPack();
  return v;
}

function lineNumbers(v: unknown, count: number): number[] {
  if (!Array.isArray(v) || v.length > count) throw badPack();
  return (v as unknown[]).map((n) => lineNumber(n, count));
}

function parseLine(raw: unknown): EvalLineFile {
  const r = shape(raw, ['who', 'text'], ['blocked'], badPack);
  const out: EvalLineFile = { who: oneOf(r.who, WHO, badPack), text: text(r.text, badPack, MAX_LINE) };
  if (r.blocked !== undefined) {
    if (typeof r.blocked !== 'boolean') throw badPack();
    out.blocked = r.blocked;
  }
  return out;
}

function parseExpect(raw: unknown, lineCount: number): EvalExpectFile {
  const r = shape(raw, ['severity', 'verdict'], ['rule', 'mustCite', 'mustNotCite', 'injection'], badPack);
  let severity: EvalExpectFile['severity'];
  if (Array.isArray(r.severity)) {
    const band = r.severity as unknown[];
    if (band.length < 1 || band.length > LEVELS.length) throw badPack();
    const levels = band.map((l) => oneOf<ConductLevelName>(l, LEVELS, badPack));
    if (new Set(levels).size !== levels.length) throw badPack();
    severity = levels;
  } else {
    severity = oneOf<ConductLevelName>(r.severity, LEVELS, badPack);
  }
  const out: EvalExpectFile = { severity, verdict: oneOf(r.verdict, VERDICTS, badPack) };
  if (r.rule !== undefined) {
    if (r.rule === 'uncovered') out.rule = 'uncovered';
    else if (typeof r.rule === 'number' && Number.isSafeInteger(r.rule) && r.rule >= 1 && r.rule <= MAX_RULE) out.rule = r.rule;
    else throw badPack();
  }
  if (r.mustCite !== undefined) out.mustCite = lineNumbers(r.mustCite, lineCount);
  if (r.mustNotCite !== undefined) out.mustNotCite = lineNumbers(r.mustNotCite, lineCount);
  if (r.injection !== undefined) {
    if (typeof r.injection !== 'boolean') throw badPack();
    out.injection = r.injection;
  }
  return out;
}

/** The keys this reader knows are checked; every other key is dropped, whatever it holds. */
function parseMeta(raw: unknown): EvalMeta {
  if (!isObject(raw)) throw badPack();
  const out: EvalMeta = {};
  const language = raw.language;
  if (language !== undefined) {
    if (typeof language !== 'string' || !LANG_RE.test(language)) throw badPack();
    out.language = language;
  }
  const source = raw.source;
  if (source !== undefined) out.source = oneOf<NonNullable<EvalMeta['source']>>(source, SOURCES, badPack);
  const reviewed = raw.reviewed;
  if (reviewed !== undefined) out.reviewed = nonNegativeInt(reviewed, badPack, 99);
  const since = raw.since;
  if (since !== undefined) {
    if (typeof since !== 'string' || !VERSION_RE.test(since)) throw badPack();
    out.since = since;
  }
  return out;
}

function parseCase(raw: unknown): EvalCaseFile {
  const r = shape(raw, ['id', 'group', 'reason', 'note', 'lines', 'expect'], ['rules', 'pointedAt', 'meta'], badPack);
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) throw badPack();
  const group = text(r.group, badPack, MAX_GROUP);
  // A group is a key of the manifest's tally; a name that is a prototype key would not count like the others.
  if (group === '__proto__') throw badPack();
  const reason = r.reason === null ? null : text(r.reason, badPack, MAX_REASON);
  const note = r.note === null ? null : text(r.note, badPack, MAX_NOTE);
  // 12 lines is the rule for a case from real chat (design 12); a synthetic long-room case may be longer, and the service's checkCase
  // holds the contributed ones to 12 whatever they are called.
  const meta = r.meta === undefined ? undefined : parseMeta(r.meta);
  const longRoom = group === 'long-room' && meta?.source !== 'contributed';
  const maxLines = longRoom ? MAX_LINES_LONG_ROOM : MAX_LINES;
  if (!Array.isArray(r.lines) || r.lines.length < 1 || r.lines.length > maxLines) throw badPack();
  const lines = (r.lines as unknown[]).map(parseLine);
  const out: EvalCaseFile = { id: r.id, group, reason, note, lines, expect: parseExpect(r.expect, lines.length) };
  if (r.rules !== undefined) out.rules = oneOf<NonNullable<EvalCaseFile['rules']>>(r.rules, RULES, badPack);
  if (r.pointedAt !== undefined) out.pointedAt = lineNumber(r.pointedAt, lines.length);
  if (meta !== undefined) out.meta = meta;
  return out;
}

function parseManifest(bytes: Uint8Array): EvalManifest {
  const f = badManifest;
  const m = exact(jsonOf(bytes, f), ['schema', 'kind', 'version', 'sequence', 'builtAt', 'previous', 'license', 'languages', 'counts', 'files'], f);
  if (m.schema !== 'chatwarden-corpus-manifest/1' || m.kind !== 'eval') throw f();
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) throw f();
  const sequence = nonNegativeInt(m.sequence, f);
  const builtAt = parseUtcDate(m.builtAt);
  if (builtAt === null) throw f();
  const previous = m.previous;
  if (previous !== null && (typeof previous !== 'string' || !VERSION_RE.test(previous))) throw f();
  const license = exact(m.license, ['spdx', 'attribution'], f);
  const languages = languageList(m.languages, f, 0, 16);

  const counts = exact(m.counts, ['cases', 'groups'], f);
  const tally = (v: unknown, key: (k: string) => boolean, max: number): Record<string, number> => {
    if (!isObject(v)) throw f();
    const names = Object.keys(v);
    if (names.length > max) throw f();
    const out: Record<string, number> = {};
    for (const name of names) {
      if (!key(name)) throw f();
      out[name] = nonNegativeInt(v[name], f, MAX_CASES * 16);
    }
    return out;
  };

  if (!isObject(m.files)) throw f();
  const files: Record<string, { bytes: number; sha256: string }> = {};
  const names = Object.keys(m.files);
  if (names.length > 40) throw f();
  for (const name of names) {
    if (!CASES_NAME_RE.test(name)) throw f();
    const entry = exact(m.files[name], ['bytes', 'sha256'], f);
    if (typeof entry.sha256 !== 'string' || !SHA_RE.test(entry.sha256)) throw f();
    files[name] = { bytes: nonNegativeInt(entry.bytes, f), sha256: entry.sha256 };
  }
  return {
    schema: 'chatwarden-corpus-manifest/1',
    kind: 'eval',
    version: m.version,
    sequence,
    builtAt,
    previous,
    license: { spdx: text(license.spdx, f, 64), attribution: text(license.attribution, f, 500) },
    languages,
    counts: {
      cases: tally(counts.cases, (k) => LANG_RE.test(k), 16),
      groups: tally(counts.groups, (k) => k.length >= 1 && k.length <= MAX_GROUP, MAX_GROUPS),
    },
    files,
  };
}

/** Every entry is accounted for: a `cases.<lang>.json` the manifest lists with the right size and hash, or one of the three plain files. */
function checkFiles(entries: Map<string, Uint8Array>, manifest: EvalManifest): void {
  for (const [name, bytes] of entries) {
    if (UNLISTED_OK.includes(name)) continue;
    const listed = CASES_NAME_RE.test(name) ? manifest.files[name] : undefined;
    if (listed === undefined || listed.bytes !== bytes.length || listed.sha256 !== sha256Hex(bytes)) throw badManifest();
  }
  for (const name of Object.keys(manifest.files)) if (!entries.has(name)) throw badManifest();
  // One file for each language the manifest names, and no file for any other.
  const fileLanguages = Object.keys(manifest.files).map((n) => (CASES_NAME_RE.exec(n) as RegExpExecArray)[1] as string);
  if (fileLanguages.length !== manifest.languages.length || fileLanguages.some((l) => !manifest.languages.includes(l))) throw badManifest();
}

const sameCounts = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
};

/**
 * Turn the entries of a verified eval archive into an {@link EvalSet}, or throw a {@link CorpusError}: `bad_manifest` (stage `unpack`)
 * for the manifest, the hashes, the kind, the counts and what the index said it should be, `bad_pack` (stage `validate`) for a case that
 * does not meet the format (a duplicate id, an unknown key, a citation outside the lines, a limit). `expected` is what the index entry
 * says: the manifest's `version` must equal it and its `sequence` must not be above it.
 * @experimental
 */
export function parseEvalSet(files: ReadonlyMap<string, Uint8Array>, expected?: { version?: string; sequence?: number }): EvalSet {
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

    const byLanguage: Record<string, EvalCaseFile[]> = {};
    const ids = new Set<string>();
    const groups: Record<string, number> = {};
    for (const [name, bytes] of entries) {
      const m = CASES_NAME_RE.exec(name);
      if (m === null) continue;
      const json = jsonOf(bytes, badPack);
      if (!Array.isArray(json) || json.length > MAX_CASES) throw badPack();
      const list = (json as unknown[]).map(parseCase);
      for (const c of list) {
        if (ids.has(c.id)) throw badPack();
        ids.add(c.id);
        groups[c.group] = (groups[c.group] ?? 0) + 1;
      }
      byLanguage[m[1] as string] = list;
    }
    // The manifest says what is in the set; the cases are what is in it. They must agree.
    const perLanguage: Record<string, number> = {};
    for (const tag of manifest.languages) perLanguage[tag] = (byLanguage[tag] ?? []).length;
    if (!sameCounts(perLanguage, manifest.counts.cases) || !sameCounts(groups, manifest.counts.groups)) throw badManifest();

    const cases = manifest.languages.flatMap((l) => byLanguage[l] ?? []);
    return { manifest, version: manifest.version, sequence: manifest.sequence, cases, byLanguage };
  } catch (e) {
    if (e instanceof CorpusError) throw e;
    throw badPack();
  }
}
