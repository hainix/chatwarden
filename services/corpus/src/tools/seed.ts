import { parseArgs, UsageError, valueOf } from './args.js';
import { ToolError } from './errors.js';
import type { ToolIo } from './io.js';
import { insideGitTree } from './keygen.js';
import { openDump } from './localD1.js';
import { CATEGORIES, TARGETS } from '../gates.js';
import { SUPPORTED_LANGUAGES, plainWord, wordKey } from '../wordkey.js';
import { isoSeconds } from '../counters.js';

// `tools/seed.mjs` (owner action 5, plan "first real corpus release", step 4): turn the owner's exported lists into SQL for `wrangler d1 execute`.
// - `--terms`: the seed terms become `provisional` rows, each with a source (in the audit row's actor). Each also gets a submission and one approval
//   vote, as the review page's own first approval would write, so that a later dispute and restore gives the status those votes earn.
// - `--dictionary` and `--negatives`: the ordinary-word list of a language (ranked by position, most common first) and its known-innocent lines,
//   which the gates and the release builder need.
// The real lists live outside the repository and so does the SQL this writes (a path inside a git working tree is refused). Nothing printed holds a
// word: counts, positions and codes.

export const SEED_USAGE =
  'usage: seed [--terms <seed.json> --dump <d1-export.sql>] [--dictionary <lang>=<words.txt>] [--negatives <lang>=<lines.txt>] --out <import.sql>';

const SEVERITIES = ['rude', 'hostile', 'severe'];
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{1,40}$/;
const KEYS = ['term', 'languages', 'category', 'target', 'severity', 'defaultActive', 'source'];
const MAX_ENTRIES = 20_000;
const CHUNK = 200;
const MAX_LINE = 500;

export type SeedErrorCode = 'invalid_file' | 'invalid_entry' | 'invalid_line' | 'bad_language';

/** A refusal of the input. `indices` are positions in the file (never content); the message is fixed. */
export class SeedError extends Error {
  readonly code: SeedErrorCode;
  readonly indices: number[];
  constructor(code: SeedErrorCode, indices: readonly number[] = []) {
    super(
      code === 'invalid_entry'
        ? `${indices.length} entries are not valid (positions: ${indices.slice(0, 20).join(', ')}${indices.length > 20 ? ', ...' : ''}); nothing was written`
        : code === 'invalid_line'
          ? 'a line holds a control character; nothing was written'
          : code === 'bad_language'
            ? 'the language is not one the service supports'
            : 'the file is not a list of entries the tool reads',
    );
    this.name = 'SeedError';
    this.code = code;
    this.indices = [...indices];
  }
}

/** A SQL string literal: quotes doubled, and no control character (so nothing can end the statement). */
function lit(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are refused
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new SeedError('invalid_line');
  return `'${text.replaceAll("'", "''")}'`;
}

export interface SeedPlan {
  sql: string;
  imported: number;
  skipped: { index: number; reason: 'known_word' | 'duplicate_in_file' }[];
  first: string | null;
  last: string | null;
}

interface Entry {
  term: string;
  languages: string[];
  category: string;
  target: string;
  severity: string;
  defaultActive: boolean;
  source: string;
}

function readEntry(raw: unknown): Entry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !KEYS.includes(k))) return null;
  const term = plainWord(o.term);
  const languages = o.languages;
  if (term === null || !Array.isArray(languages) || languages.length < 1 || languages.length > SUPPORTED_LANGUAGES.length) return null;
  if (new Set(languages).size !== languages.length || languages.some((l) => typeof l !== 'string' || !SUPPORTED_LANGUAGES.includes(l))) return null;
  if (typeof o.category !== 'string' || !CATEGORIES.includes(o.category)) return null;
  const target = o.target === undefined ? 'none' : o.target;
  if (typeof target !== 'string' || !TARGETS.includes(target)) return null;
  if (o.category === 'slur' && target === 'none') return null;
  if (typeof o.severity !== 'string' || !SEVERITIES.includes(o.severity)) return null;
  if (o.defaultActive !== undefined && typeof o.defaultActive !== 'boolean') return null;
  if (typeof o.source !== 'string' || !SOURCE_RE.test(o.source)) return null;
  return { term, languages: [...(languages as string[])], category: o.category, target, severity: o.severity, defaultActive: o.defaultActive !== false, source: o.source };
}

/**
 * The SQL for the seed terms. `existing.next` is the next free number of the year (ids are never reused) and `existing.keys` the word keys the
 * database already holds. Throws a {@link SeedError} for the whole file if any entry is not valid.
 */
export function planTerms(entries: unknown, existing: { next: number; keys: ReadonlySet<string> }, now: string, year: number): SeedPlan {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) throw new SeedError('invalid_file');
  const parsed = entries.map(readEntry);
  const bad = parsed.flatMap((e, i) => (e === null ? [i] : []));
  if (bad.length > 0) throw new SeedError('invalid_entry', bad);
  const seen = new Set<string>();
  const skipped: SeedPlan['skipped'] = [];
  const lines: string[] = ['-- Seed import: provisional terms, each with a submission and one approval vote behind it. Safe to apply twice.'];
  let next = existing.next;
  let first: string | null = null;
  let last: string | null = null;
  let imported = 0;
  const at = lit(now);
  const day = lit(now.slice(0, 10));
  for (const [index, e] of (parsed as Entry[]).entries()) {
    const key = wordKey(e.term);
    if (existing.keys.has(key)) {
      skipped.push({ index, reason: 'known_word' });
      continue;
    }
    if (seen.has(key)) {
      skipped.push({ index, reason: 'duplicate_in_file' });
      continue;
    }
    seen.add(key);
    if (next > 99_999) throw new SeedError('invalid_file');
    const id = `CWT-${year}-${String(next).padStart(5, '0')}`;
    next += 1;
    first ??= id;
    last = id;
    imported += 1;
    const reviewer = lit(`seed:${e.source}`);
    const sub = lit(`seed_${id}`);
    lines.push(
      `INSERT OR IGNORE INTO terms (id, word_key, term, languages, category, target, severity, status, default_active, collides_with, since, approvals, created_at, updated_at) VALUES (${lit(id)}, ${lit(key)}, ${lit(e.term)}, ${lit(JSON.stringify(e.languages))}, ${lit(e.category)}, ${lit(e.target)}, ${lit(e.severity)}, 'provisional', ${e.defaultActive ? 1 : 0}, '[]', NULL, 1, ${at}, ${at});`,
      `INSERT OR IGNORE INTO submissions (id, installation, word_key, term, language, category, target, note, status, reason, term_id, received_day, decided_at, held) SELECT ${sub}, 'seed', ${lit(key)}, ${lit(e.term)}, ${lit(e.languages[0] as string)}, ${lit(e.category)}, ${lit(e.target)}, NULL, 'accepted', NULL, ${lit(id)}, ${day}, ${at}, NULL WHERE EXISTS (SELECT 1 FROM terms WHERE id = ${lit(id)} AND word_key = ${lit(key)});`,
      `INSERT OR IGNORE INTO reviews (subject_kind, subject_id, reviewer, verdict, fluent, at) SELECT 'submission', ${sub}, ${reviewer}, 'approve', 0, ${at} WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ${sub} AND term_id = ${lit(id)});`,
      `INSERT INTO audit (at, actor, action, subject) SELECT ${at}, ${reviewer}, 'seed.import', ${lit(id)} WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ${sub}) AND NOT EXISTS (SELECT 1 FROM audit WHERE action = 'seed.import' AND subject = ${lit(id)});`,
    );
  }
  return { sql: `${lines.join('\n')}\n`, imported, skipped, first, last };
}

function textLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
}

/**
 * The SQL for a language's ordinary-word list: one word a line, most common first. A word is stored by its key; a line that is not a plain word
 * of three letters or more (a word of two letters can neither equal nor contain a term) is skipped; a repeated word keeps its first (best) rank.
 */
export function dictionarySql(language: string, text: string, options: { ranked?: boolean } = {}): { sql: string; imported: number } {
  if (!SUPPORTED_LANGUAGES.includes(language)) throw new SeedError('bad_language');
  const ranked = options.ranked !== false;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of textLines(text)) {
    const key = wordKey(line);
    if (!/^[a-z]{3,}$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  const out: string[] = [];
  for (let n = 0; n < keys.length; n += CHUNK) {
    const values = keys.slice(n, n + CHUNK).map((k, i) => `(${lit(language)}, ${lit(k)}, ${ranked ? n + i + 1 : 'NULL'})`).join(', ');
    out.push(
      `INSERT INTO innocent_words (language, word_key, rank) VALUES ${values} ON CONFLICT (language, word_key) DO UPDATE SET rank = CASE WHEN excluded.rank IS NULL THEN rank WHEN rank IS NULL THEN excluded.rank ELSE MIN(rank, excluded.rank) END;`,
    );
  }
  return { sql: out.length === 0 ? '' : `${out.join('\n')}\n`, imported: keys.length };
}

/** The SQL for a language's known-innocent lines (the negative corpus): trimmed, distinct, at most 500 characters. */
export function negativesSql(language: string, text: string): { sql: string; imported: number } {
  if (!SUPPORTED_LANGUAGES.includes(language)) throw new SeedError('bad_language');
  const lines = [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== ''))];
  for (const l of lines) lit(l); // refuses a control character anywhere, before anything is written
  const keep = lines.filter((l) => l.length <= MAX_LINE);
  const out: string[] = [];
  for (let n = 0; n < keep.length; n += CHUNK) {
    out.push(`INSERT OR IGNORE INTO negative_lines (language, line, origin) VALUES ${keep.slice(n, n + CHUNK).map((l) => `(${lit(language)}, ${lit(l)}, 'import')`).join(', ')};`);
  }
  return { sql: out.length === 0 ? '' : `${out.join('\n')}\n`, imported: keep.length };
}

const LANG_FILE_RE = /^([a-z]{2,3})=(.+)$/;
const decoder = new TextDecoder();

export async function main(argv: readonly string[], io: ToolIo): Promise<number> {
  try {
    const args = parseArgs(argv, { terms: 'value', dump: 'value', dictionary: 'value', negatives: 'value', out: 'value' });
    const termsPath = valueOf(args, 'terms');
    const dictionary = valueOf(args, 'dictionary');
    const negatives = valueOf(args, 'negatives');
    const out = valueOf(args, 'out');
    if (out === undefined) throw new UsageError('--out is required');
    if (termsPath === undefined && dictionary === undefined && negatives === undefined) throw new UsageError('give at least one of --terms, --dictionary, --negatives');
    if (termsPath !== undefined && valueOf(args, 'dump') === undefined) throw new UsageError('--terms needs --dump (an export of the database, so ids are never reused)');
    if (insideGitTree(out, io)) throw new ToolError('in_git_tree', 'refusing to write the real lists as SQL inside a git working tree: choose a folder outside every repository');
    if (io.exists(out)) throw new ToolError('exists', 'a file already exists there; it is never overwritten');
    const read = async (path: string): Promise<string> => {
      try {
        return decoder.decode(await io.read(path));
      } catch {
        throw new ToolError('bad_file', 'an input file could not be read');
      }
    };
    const langFile = (spec: string): { language: string; path: string } => {
      const m = LANG_FILE_RE.exec(spec);
      if (m === null) throw new UsageError('--dictionary and --negatives take <language>=<file>');
      return { language: m[1] as string, path: m[2] as string };
    };
    const parts: string[] = [];
    const report: string[] = [];
    if (termsPath !== undefined) {
      let entries: unknown;
      try {
        entries = JSON.parse(await read(termsPath));
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new SeedError('invalid_file');
      }
      const db = openDump(await read(valueOf(args, 'dump') as string));
      const year = Number(isoSeconds(io.clock.now()).slice(0, 4));
      const rows = (await db.prepare('SELECT id, word_key FROM terms').all<{ id: string; word_key: string }>()).results;
      const taken = rows.map((r) => Number(new RegExp(`^CWT-${year}-(\\d{5})$`).exec(r.id)?.[1] ?? 0));
      const plan = planTerms(entries, { next: Math.max(0, ...taken) + 1, keys: new Set(rows.map((r) => r.word_key)) }, isoSeconds(io.clock.now()), year);
      parts.push(plan.sql);
      report.push(`${plan.imported} terms (${plan.skipped.length} skipped)`);
    }
    if (dictionary !== undefined) {
      const { language, path } = langFile(dictionary);
      const d = dictionarySql(language, await read(path));
      parts.push(d.sql);
      report.push(`${d.imported} dictionary words (${language})`);
    }
    if (negatives !== undefined) {
      const { language, path } = langFile(negatives);
      const n = negativesSql(language, await read(path));
      parts.push(n.sql);
      report.push(`${n.imported} negative lines (${language})`);
    }
    try {
      await io.write(out, parts.join('\n'), { mode: 0o600, exclusive: true });
    } catch {
      throw new ToolError('exists', 'the SQL file could not be written there');
    }
    io.out(`wrote ${report.join(', ')}.`);
    io.out('read it, then apply it:   npx wrangler d1 execute chatwarden-corpus --remote --file <that file>');
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      io.err(SEED_USAGE);
    } else if (e instanceof SeedError) {
      io.err(`${e.code}: ${e.message}`);
    } else if (e instanceof ToolError) {
      io.err(`${e.code}: ${e.message}`);
    } else {
      io.err('failed: could not prepare the import (no detail is printed: it could hold a word)');
    }
    return 1;
  }
}
