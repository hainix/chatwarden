import { VERSION } from '@chatwarden/matcher';
import { CORPUS_ZIP_PASSWORD, parseEvalSet, type EvalSet } from '@chatwarden/matcher/corpus';
import { checkCase, type CaseCode } from '../checkCase.js';
import type { Clock } from '../deps.js';
import { isoSeconds } from '../counters.js';
import { SUPPORTED_LANGUAGES } from '../wordkey.js';
import { BuildError } from './release.js';
import { sha256Hex, summarise, type ReleaseSummary } from './summary.js';
import { ATTRIBUTION, evalReadme, LICENSE_SPDX, LICENSE_TXT } from './texts.js';
import { writeReleaseZip } from './zip.js';

// The eval and calibration set builder (design 6.10, 12): `cases.<lang>.json` for each language, a manifest with the counts per language and per
// group (and no matcher gate), and the zip. A case is kept out of the release, by id and a closed code, when it is not a case the kit reads, when
// its id is used twice, when fewer than three reviewers labelled it, or when it fails `checkCase`. The set is read back with the kit's own
// `parseEvalSet` before it is returned.

const VERSION_RE = /^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0|[1-9]\d{0,2})$/;
const CASE_KEYS = ['id', 'group', 'reason', 'note', 'rules', 'pointedAt', 'lines', 'expect', 'meta'];
const LINE_KEYS = ['who', 'text', 'blocked'];
const EXPECT_KEYS = ['severity', 'rule', 'verdict', 'mustCite', 'mustNotCite', 'injection'];
const META_KEYS = ['language', 'source', 'reviewed', 'since'];
export const MIN_REVIEWED = 3;

export type EvalHoldCode = CaseCode | 'unreviewed' | 'duplicate_id' | 'bad_case';

export interface EvalHold {
  /** The case's id, or `#<position>` for something that has none. */
  id: string;
  language: string;
  code: EvalHoldCode;
}

export interface EvalBuildOptions {
  clock: Clock;
  version: string;
  sequence: number;
  previous: string | null;
  languages?: readonly string[];
  /** Matches the corpus's terms: a line marked `blocked` must be blocked by it. */
  corpus: { match(text: string): { termId: string } | null };
  /** Reviewers a reference label needs (default 3). */
  minReviewed?: number;
  minKit?: string;
}

export interface EvalBuildResult {
  files: Map<string, Uint8Array>;
  zip: Uint8Array;
  summary: ReleaseSummary;
  set: EvalSet;
  held: EvalHold[];
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const json = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The keys of `o` in the order of `known`, then any others (so the kit's strict reader still sees, and refuses, an unknown key). */
function ordered(o: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of known) if (o[k] !== undefined) out[k] = o[k];
  for (const k of Object.keys(o).sort(byCodeUnit)) if (!known.includes(k) && o[k] !== undefined) out[k] = o[k];
  return out;
}

/** The case in canonical key order, its meta reduced to what the kit knows, `language` and `since` set. Null if it has no shape to work with. */
function canonical(raw: unknown, language: string, version: string): Record<string, unknown> | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.lines) || !raw.lines.every((l) => isObject(l) && typeof l.text === 'string') || !isObject(raw.expect)) return null;
  const meta = isObject(raw.meta) ? raw.meta : {};
  if (meta.language !== undefined && meta.language !== language) return null;
  const out = ordered(raw, CASE_KEYS);
  out.lines = (raw.lines as Record<string, unknown>[]).map((l) => ordered(l, LINE_KEYS));
  out.expect = ordered(raw.expect, EXPECT_KEYS);
  out.meta = ordered({ language, source: meta.source, reviewed: meta.reviewed, since: meta.since ?? version }, META_KEYS);
  return out;
}

interface Parts {
  manifest: Record<string, unknown>;
  files: Map<string, Uint8Array>;
}

function layout(byLanguage: Record<string, Record<string, unknown>[]>, languages: readonly string[], o: EvalBuildOptions): Parts {
  const data = new Map<string, Uint8Array>();
  for (const l of languages) data.set(`cases.${l}.json`, json(byLanguage[l] ?? []));
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const name of [...data.keys()].sort(byCodeUnit)) files[name] = { bytes: (data.get(name) as Uint8Array).length, sha256: sha256Hex(data.get(name) as Uint8Array) };
  const groups: Record<string, number> = {};
  for (const l of languages) for (const c of byLanguage[l] ?? []) groups[c.group as string] = (groups[c.group as string] ?? 0) + 1;
  const manifest = {
    schema: 'chatwarden-corpus-manifest/1',
    kind: 'eval',
    version: o.version,
    sequence: o.sequence,
    builtAt: isoSeconds(o.clock.now()),
    previous: o.previous,
    license: { spdx: LICENSE_SPDX, attribution: ATTRIBUTION },
    languages: [...languages],
    counts: {
      cases: Object.fromEntries(languages.map((l) => [l, (byLanguage[l] ?? []).length])),
      groups: Object.fromEntries(Object.keys(groups).sort(byCodeUnit).map((g) => [g, groups[g]])),
    },
    files,
  };
  const out = new Map<string, Uint8Array>();
  out.set('manifest.json', json(manifest));
  for (const [name, bytes] of data) out.set(name, bytes);
  out.set('LICENSE.txt', new TextEncoder().encode(LICENSE_TXT));
  out.set('README.txt', new TextEncoder().encode(evalReadme(o.version)));
  return { manifest, files: out };
}

function readBack(files: ReadonlyMap<string, Uint8Array>, o: EvalBuildOptions): EvalSet {
  return parseEvalSet(files, { version: o.version, sequence: o.sequence });
}

/** Builds an eval release from `cases` by language (each an array of cases in the AI eval's shape plus `meta`). Throws a {@link BuildError}. */
export function buildEvalRelease(cases: Record<string, readonly unknown[]>, o: EvalBuildOptions): EvalBuildResult {
  const languages = o.languages ?? SUPPORTED_LANGUAGES;
  const ok =
    typeof o.version === 'string' && VERSION_RE.test(o.version) &&
    typeof o.sequence === 'number' && Number.isSafeInteger(o.sequence) && o.sequence >= 1 &&
    (o.previous === null || (typeof o.previous === 'string' && VERSION_RE.test(o.previous))) &&
    Array.isArray(languages) && languages.length > 0 && new Set(languages).size === languages.length && languages.every((l) => SUPPORTED_LANGUAGES.includes(l)) &&
    typeof o.clock?.now === 'function' && typeof o.corpus?.match === 'function';
  if (!ok) throw new BuildError('bad_options');
  if (Object.keys(cases).some((l) => !languages.includes(l))) throw new BuildError('bad_options');
  const minReviewed = o.minReviewed ?? MIN_REVIEWED;

  const held: EvalHold[] = [];
  const ids = new Set<string>();
  const kept: Record<string, Record<string, unknown>[]> = {};
  for (const language of languages) {
    const accepted: Record<string, unknown>[] = [];
    for (const [index, raw] of (cases[language] ?? []).entries()) {
      const id = isObject(raw) && typeof raw.id === 'string' ? raw.id : `#${index}`;
      const hold = (code: EvalHoldCode): void => void held.push({ id, language, code });
      const c = canonical(raw, language, o.version);
      if (c === null) {
        hold('bad_case');
        continue;
      }
      if (ids.has(id)) {
        hold('duplicate_id');
        continue;
      }
      const reviewed = (c.meta as { reviewed?: unknown }).reviewed;
      if (typeof reviewed !== 'number' || reviewed < minReviewed) {
        hold('unreviewed');
        continue;
      }
      const check = checkCase(c, undefined, { corpus: o.corpus });
      if (!check.ok) {
        hold(check.codes[0] as CaseCode);
        continue;
      }
      // The kit's own reader has the last word on the shape of this one case.
      try {
        readBack(layout({ [language]: [c] }, [language], o).files, { ...o, version: o.version });
      } catch {
        hold('bad_case');
        continue;
      }
      ids.add(id);
      accepted.push(c);
    }
    kept[language] = accepted.sort((a, b) => byCodeUnit(a.id as string, b.id as string));
  }
  held.sort((a, b) => byCodeUnit(a.id, b.id) || byCodeUnit(a.language, b.language));

  const { files } = layout(kept, languages, o);
  let set: EvalSet;
  try {
    set = readBack(files, o);
  } catch {
    throw new BuildError('self_check');
  }
  const zip = writeReleaseZip([...files].map(([name, data]) => ({ name, data })), { password: CORPUS_ZIP_PASSWORD, time: o.clock.now() });
  const counts: Record<string, Record<string, number>> = {};
  for (const l of languages) counts[l] = { cases: (set.byLanguage[l] ?? []).length };
  return { files, zip, summary: summarise({ kind: 'eval', version: o.version, sequence: o.sequence, minKit: o.minKit ?? VERSION, languages: counts, zip }), set, held };
}
