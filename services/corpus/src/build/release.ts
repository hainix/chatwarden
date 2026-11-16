import { VERSION } from '@chatwarden/matcher';
import { parseTermsRelease, CORPUS_ZIP_PASSWORD, type TermRow6, type TermsRelease } from '@chatwarden/matcher/corpus';
import type { Clock } from '../deps.js';
import { isoSeconds } from '../counters.js';
import type { D1Like } from '../env.js';
import { SUPPORTED_LANGUAGES } from '../wordkey.js';
import { diffTerms, type TermsDiff } from './diff.js';
import { GateFault, runGates, type GateCode, type GateCounts, type GateFailure } from './gates.js';
import { loadSnapshot, type Snapshot, type TermRecord } from './snapshot.js';
import { sha256Hex, summarise, type ReleaseSummary } from './summary.js';
import { ATTRIBUTION, LICENSE_SPDX, LICENSE_TXT, termsReadme } from './texts.js';
import { positiveTemplates } from './templates.js';
import { writeReleaseZip } from './zip.js';

// The release builder (design 6.4 to 6.7, 13). `buildTermsRelease` reads the database into a snapshot and builds from it: the rows, the lines
// (templates and the dictionary gate and the reviewers'), the manifest and the zip. It then reads its own output back with the kit's parser and
// runs the gates over what the kit read. Nothing here signs, uploads or writes to the database, and every time comes from the injected clock.

/** The most terms that may be new in one release without `allowBulk` (design 7, "a month"). */
export const BULK_LIMIT = 200;
const MAX_ROW_LINES = 50;
const MAX_ROW_LINE = 200;
const MAX_FILE_LINES = 2000;
const MAX_FILE_LINE = 500;
const MAX_POSITIVE_FILE_LINES = 2000;
const VERSION_RE = /^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0|[1-9]\d{0,2})$/;
const SELECTABLE = new Set(['accepted', 'provisional']);

export type BuildErrorCode = 'bad_options' | 'bad_row' | 'bulk_guard' | 'gate_failed' | 'bad_pack' | 'self_check';

const MESSAGES: Record<BuildErrorCode, string> = {
  bad_options: 'the build options are not valid',
  bad_row: 'a term row cannot be published as it stands',
  bulk_guard: 'more terms are new in this release than the bulk guard allows; read the diff and pass allowBulk',
  gate_failed: 'a published term fails the gates; dispute or fix it before building',
  bad_pack: 'the built release does not load in the kit',
  self_check: 'the built release was not read back by the kit',
};

/** A build refusal: a fixed message and a closed code. `ids` (row ids only, never words) names the rows a gate or a check is about. */
export class BuildError extends Error {
  readonly code: BuildErrorCode;
  readonly ids: string[];
  constructor(code: BuildErrorCode, ids: readonly string[] = []) {
    super(MESSAGES[code]);
    this.name = 'BuildError';
    this.code = code;
    this.ids = [...ids];
  }
}

export interface BuildOptions {
  clock: Clock;
  /** CalVer `YYYY.MM.PATCH`. */
  version: string;
  /** The index sequence this release will be published at (at least 1). */
  sequence: number;
  /** The version this release follows, or null for the first. */
  previous: string | null;
  /** The languages the release lists (default: all the supported ones). */
  languages?: readonly string[];
  /** Allow more than 200 new terms. */
  allowBulk?: boolean;
  /** The rows of the previous release, for the diff. */
  previousTerms?: readonly TermRow6[];
  /** The oldest kit that reads the release (default: this matcher's version). */
  minKit?: string;
}

export interface BuildResult {
  /** The archive's entries by name, in archive order. */
  files: Map<string, Uint8Array>;
  zip: Uint8Array;
  summary: ReleaseSummary;
  /** What the kit read back from the zip. */
  release: TermsRelease;
  /** Terms the gates kept out of this release. */
  held: GateFailure[];
  diff: TermsDiff;
  gate: GateCounts;
}

const unique = (lines: readonly string[]): string[] => [...new Set(lines)];
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Merges records that fold to one word (the database's unique key makes this a defence, not a case): the lowest id wins and the rest is united into it. */
export function dedupeByWordKey(records: readonly TermRecord[]): TermRecord[] {
  const groups = new Map<string, TermRecord[]>();
  for (const r of [...records].sort((a, b) => byCodeUnit(a.id, b.id))) groups.set(r.wordKey, [...(groups.get(r.wordKey) ?? []), r]);
  const out: TermRecord[] = [];
  for (const group of groups.values()) {
    const [first, ...rest] = group as [TermRecord, ...TermRecord[]];
    if (rest.length === 0) {
      out.push(first);
      continue;
    }
    const all = group;
    out.push({
      ...first,
      languages: unique(all.flatMap((r) => r.languages)).sort(byCodeUnit),
      storedCollidesWith: unique(all.flatMap((r) => r.storedCollidesWith)).sort(byCodeUnit),
      freshCollidesWith: unique(all.flatMap((r) => r.freshCollidesWith)).sort(byCodeUnit),
      approvals: Math.max(...all.map((r) => r.approvals)),
      since: all.map((r) => r.since).filter((s): s is string => s !== null).sort(byCodeUnit)[0] ?? null,
      positiveLines: unique(all.flatMap((r) => r.positiveLines)),
      negativeLines: unique(all.flatMap((r) => r.negativeLines)),
      dictionary: first.dictionary,
    });
  }
  return out;
}

function checkOptions(o: BuildOptions): readonly string[] {
  const languages = o.languages ?? SUPPORTED_LANGUAGES;
  const ok =
    typeof o.version === 'string' && VERSION_RE.test(o.version) &&
    typeof o.sequence === 'number' && Number.isSafeInteger(o.sequence) && o.sequence >= 1 &&
    (o.previous === null || (typeof o.previous === 'string' && VERSION_RE.test(o.previous))) &&
    Array.isArray(languages) && languages.length > 0 && new Set(languages).size === languages.length && languages.every((l) => SUPPORTED_LANGUAGES.includes(l)) &&
    typeof o.clock?.now === 'function';
  if (!ok) throw new BuildError('bad_options');
  return languages;
}

interface Draft {
  record: TermRecord;
  row: TermRow6;
}

function draftOf(record: TermRecord, version: string, languages: readonly string[]): Draft {
  if (record.languages.length === 0 || record.languages.some((l) => !languages.includes(l))) throw new BuildError('bad_row', [record.id]);
  const own = new Set(record.languages);
  const collidesWith = unique([...record.storedCollidesWith, ...record.freshCollidesWith]).filter((l) => !own.has(l) && languages.includes(l)).sort(byCodeUnit);
  const reviewerPositive = [...record.positiveLines].sort(byCodeUnit).filter((l) => l.length > 0 && l.length <= MAX_ROW_LINE);
  const reviewerNegative = [...record.negativeLines].sort(byCodeUnit).filter((l) => l.length > 0 && l.length <= MAX_ROW_LINE);
  const status = record.status as TermRow6['status'];
  const row: TermRow6 = {
    id: record.id,
    term: record.term,
    languages: [...record.languages].sort(byCodeUnit),
    category: record.category as TermRow6['category'],
    target: record.target as TermRow6['target'],
    severity: record.severity as TermRow6['severity'],
    status,
    defaultActive: record.defaultActive,
    collidesWith,
    since: record.since ?? version,
    approvals: Math.min(99, Math.max(0, record.approvals)),
    positive: unique([...positiveTemplates(record.term), ...reviewerPositive]).slice(0, MAX_ROW_LINES),
    negative: unique([...reviewerNegative, ...record.dictionary.map((d) => d.word)]).filter((l) => l.length <= MAX_ROW_LINE).slice(0, MAX_ROW_LINES),
  };
  return { record, row };
}

const json = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

interface Layout {
  files: Map<string, Uint8Array>;
  positiveOwner: Map<string, string>;
}

/** The archive's entries for these rows (the manifest first; `gate` is what the manifest says the gates found). */
function layout(drafts: readonly Draft[], snapshot: Snapshot, o: BuildOptions, languages: readonly string[], gate: GateCounts | null): Layout {
  const rows = drafts.map((d) => d.row);
  const perLanguage = (): Record<string, number> => Object.fromEntries(languages.map((l) => [l, rows.filter((r) => r.languages.includes(l)).length]));
  const data = new Map<string, Uint8Array>();
  data.set('terms.json', json(rows));
  data.set('exceptions.json', json([]));
  for (const l of languages) {
    const lines = unique((snapshot.negativeCorpus[l] ?? []).filter((x) => x.length > 0 && x.length <= MAX_FILE_LINE)).sort(byCodeUnit).slice(0, MAX_FILE_LINES);
    data.set(`negative.${l}.json`, json({ schema: 'chatwarden-corpus-negative/1', language: l, lines, knownLosses: [] }));
  }
  // The pack-wide lines: one sentence for each row that is on for a game with every language installed.
  const positiveOwner = new Map<string, string>();
  for (const { row } of drafts) {
    if (!SELECTABLE.has(row.status) || !row.defaultActive || row.collidesWith.some((l) => languages.includes(l))) continue;
    const line = row.positive.find((l) => l === `you ${row.term}`) ?? row.positive[0];
    if (line !== undefined && !positiveOwner.has(line) && positiveOwner.size < MAX_POSITIVE_FILE_LINES) positiveOwner.set(line, row.id);
  }
  data.set('positive.json', json({ schema: 'chatwarden-corpus-positive/1', lines: [...positiveOwner.keys()] }));
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const name of [...data.keys()].sort(byCodeUnit)) {
    const bytes = data.get(name) as Uint8Array;
    files[name] = { bytes: bytes.length, sha256: sha256Hex(bytes) };
  }
  const status = { accepted: 0, provisional: 0, disputed: 0, withdrawn: 0 };
  for (const r of rows) status[r.status] += 1;
  const manifest = {
    schema: 'chatwarden-corpus-manifest/1',
    kind: 'terms',
    version: o.version,
    sequence: o.sequence,
    builtAt: isoSeconds(o.clock.now()),
    previous: o.previous,
    license: { spdx: LICENSE_SPDX, attribution: ATTRIBUTION },
    languages: [...languages],
    counts: { terms: perLanguage(), exceptions: Object.fromEntries(languages.map((l) => [l, 0])), status },
    files,
    gate: { matcher: VERSION, positiveLines: gate?.positiveLines ?? 0, negativeLines: gate?.negativeLines ?? 0, crossLanguageLines: gate?.crossLanguageLines ?? 0, passed: true },
  };
  const out = new Map<string, Uint8Array>();
  out.set('manifest.json', json(manifest));
  for (const [name, bytes] of data) out.set(name, bytes);
  out.set('LICENSE.txt', new TextEncoder().encode(LICENSE_TXT));
  out.set('README.txt', new TextEncoder().encode(termsReadme(o.version)));
  return { files: out, positiveOwner };
}

function readBack(files: ReadonlyMap<string, Uint8Array>, o: BuildOptions): TermsRelease {
  try {
    return parseTermsRelease(files, { version: o.version, sequence: o.sequence });
  } catch {
    throw new BuildError('self_check');
  }
}

/** Builds a release from a snapshot of the database. Throws a {@link BuildError}. */
export function buildFromSnapshot(snapshot: Snapshot, o: BuildOptions): BuildResult {
  const languages = checkOptions(o);
  const records = dedupeByWordKey(snapshot.terms);
  let drafts = records.map((r) => draftOf(r, o.version, languages));
  const fresh = drafts.filter((d) => d.record.since === null).length;
  if (fresh > BULK_LIMIT && o.allowBulk !== true) throw new BuildError('bulk_guard');

  const byId = new Map(records.map((r) => [r.id, r]));
  const held: GateFailure[] = [];
  for (;;) {
    const { files, positiveOwner } = layout(drafts, snapshot, o, languages, null);
    const release = readBack(files, o);
    let report;
    try {
      report = runGates({ release, records: byId, negativeCorpus: snapshot.negativeCorpus, positiveOwner, languages });
    } catch (e) {
      if (e instanceof GateFault) throw new BuildError('bad_pack');
      throw e;
    }
    if (report.failures.length === 0) {
      const done = layout(drafts, snapshot, o, languages, report.counts);
      const final = readBack(done.files, o);
      const zip = writeReleaseZip([...done.files].map(([name, data]) => ({ name, data })), { password: CORPUS_ZIP_PASSWORD, time: o.clock.now() });
      const counts: Record<string, Record<string, number>> = {};
      for (const l of languages) counts[l] = { terms: final.manifest.counts.terms[l] as number, exceptions: final.manifest.counts.exceptions[l] as number };
      held.sort((a, b) => byCodeUnit(a.id, b.id));
      return {
        files: done.files,
        zip,
        summary: summarise({ kind: 'terms', version: o.version, sequence: o.sequence, minKit: o.minKit ?? VERSION, languages: counts, zip }),
        release: final,
        held,
        diff: diffTerms(o.previous, o.previousTerms ?? null, final.terms, held),
        gate: report.counts,
      };
    }
    // A term that was already published may not quietly leave the list; one that never was is held back, and the gates run again without it.
    const published = report.failures.filter((f) => byId.get(f.id)?.since !== null && byId.get(f.id)?.since !== undefined);
    if (published.length > 0) throw new BuildError('gate_failed', published.map((f) => f.id));
    const out = new Set(report.failures.map((f) => f.id));
    for (const f of report.failures) held.push({ id: f.id, code: f.code as GateCode });
    drafts = drafts.filter((d) => !out.has(d.row.id));
  }
}

/** Reads the database and builds. */
export async function buildTermsRelease(db: D1Like, o: BuildOptions): Promise<BuildResult> {
  const languages = checkOptions(o);
  return buildFromSnapshot(await loadSnapshot(db, languages), o);
}

/** The next CalVer version for the month the clock is in: `YYYY.MM.0`, or the next patch when this month already has one. */
export async function nextVersion(db: D1Like, clock: Clock): Promise<string> {
  const month = isoSeconds(clock.now()).slice(0, 7).replace('-', '.');
  const rows = (await db.prepare("SELECT version FROM releases WHERE kind = 'terms' AND version LIKE ?").bind(`${month}.%`).all<{ version: string }>()).results;
  const patches = rows.map((r) => Number(r.version.slice(month.length + 1))).filter((n) => Number.isInteger(n));
  return `${month}.${patches.length === 0 ? 0 : Math.max(...patches) + 1}`;
}

/** The next index sequence: one above the highest release recorded (any kind), or 1. */
export async function nextSequence(db: D1Like): Promise<number> {
  const row = await db.prepare('SELECT MAX(sequence) AS top FROM releases').first<{ top: number | null }>();
  return (row?.top ?? 0) + 1;
}
