import { buildMatcher } from '@chatwarden/matcher';
import { checkCase } from '../checkCase.js';
import { BuildError, nextSequence, nextVersion } from '../build/release.js';
import { buildEvalRelease } from '../build/eval.js';
import { SUPPORTED_LANGUAGES } from '../wordkey.js';
import { parseArgs, UsageError, valueOf } from './args.js';
import { ToolError } from './errors.js';
import type { ToolIo } from './io.js';
import { openDump } from './localD1.js';
import { defaultOutDir, guardOutDir } from './outdir.js';

// `tools/eval.mjs` (design 6.10, 12): build an eval and calibration release from a folder of `cases.<lang>.json` and a copy of the database (the
// corpus's terms, for the unknown-term check), or check one case before a reviewer sees it. The release it writes is read by the same `sign`,
// `publish` and `zenodo` tools as a term list. Nothing printed holds a line of a case: ids, codes and counts.

export const EVAL_USAGE = [
  'usage: eval build --cases <folder with cases.<lang>.json> --dump <d1-export.sql> [--out <dir>] [--version YYYY.MM.N] [--sequence N] [--languages en,es,pt]',
  '       eval check --case <case.json> [--source <source case.json>] [--dump <d1-export.sql>]',
].join('\n');

const decoder = new TextDecoder();

async function corpusOf(io: ToolIo, dumpPath: string) {
  let text: string;
  try {
    text = decoder.decode(await io.read(dumpPath));
  } catch {
    throw new ToolError('bad_file', 'the database export could not be read');
  }
  const db = openDump(text);
  const rows = (await db.prepare('SELECT id, term FROM terms ORDER BY id').all<{ id: string; term: string }>()).results;
  return { db, matcher: buildMatcher(rows.map((r) => ({ id: r.id, term: r.term, language: 'en', active: true })), []) };
}

async function readJson(io: ToolIo, path: string): Promise<unknown> {
  try {
    return JSON.parse(decoder.decode(await io.read(path)));
  } catch {
    throw new ToolError('bad_file', 'a file could not be read as JSON');
  }
}

async function build(argv: readonly string[], io: ToolIo): Promise<void> {
  const args = parseArgs(argv, { cases: 'value', dump: 'value', out: 'value', version: 'value', sequence: 'value', languages: 'value' });
  const dir = valueOf(args, 'cases');
  const dumpPath = valueOf(args, 'dump');
  if (dir === undefined || dumpPath === undefined) throw new UsageError('--cases and --dump are required');
  const out = valueOf(args, 'out') ?? defaultOutDir(io);
  guardOutDir(out, io);
  const languages = valueOf(args, 'languages')?.split(',') ?? [...SUPPORTED_LANGUAGES];
  const { db, matcher } = await corpusOf(io, dumpPath);
  const cases: Record<string, unknown[]> = {};
  for (const l of languages) {
    const path = `${dir}/cases.${l}.json`;
    if (!io.exists(path)) continue;
    const list = await readJson(io, path);
    if (!Array.isArray(list)) throw new ToolError('bad_input', 'a cases file is not a list of cases');
    cases[l] = list;
  }
  if (Object.keys(cases).length === 0) throw new ToolError('bad_input', 'no cases.<language>.json file was found in that folder');
  const version = valueOf(args, 'version') ?? (await nextVersion(db, io.clock, 'eval'));
  const sequenceText = valueOf(args, 'sequence');
  const sequence = sequenceText === undefined ? await nextSequence(db) : Number(sequenceText);
  const last = await db.prepare("SELECT version FROM releases WHERE kind = 'eval' ORDER BY sequence DESC LIMIT 1").first<{ version: string }>();
  const result = buildEvalRelease(cases, { clock: io.clock, version, sequence, previous: last?.version ?? null, languages, corpus: matcher });
  await io.ensureDir(out);
  await io.write(`${out}/eval-${version}.zip`, result.zip);
  await io.write(`${out}/eval-${version}.release.json`, `${JSON.stringify({ summary: result.summary, held: result.held, stamped: [] }, null, 2)}\n`);
  io.out(`eval ${version}: ${result.set.cases.length} cases (${languages.map((l) => `${l} ${result.set.byLanguage[l]?.length ?? 0}`).join(', ')}), index sequence ${sequence}`);
  if (result.held.length > 0) {
    io.out('held out of this release (fix them and build again):');
    for (const h of result.held) io.out(`  ${h.id}: ${h.code} (${h.language})`);
  }
  io.out(`built ${out}/eval-${version}.zip (sha-256 ${result.summary.sha256}). next: sign it (tools/sign.mjs), then publish.`);
}

async function check(argv: readonly string[], io: ToolIo): Promise<boolean> {
  const args = parseArgs(argv, { case: 'value', source: 'value', dump: 'value' });
  const casePath = valueOf(args, 'case');
  if (casePath === undefined) throw new UsageError('--case is required');
  const sourcePath = valueOf(args, 'source');
  const dumpPath = valueOf(args, 'dump');
  const corpus = dumpPath === undefined ? undefined : (await corpusOf(io, dumpPath)).matcher;
  const verdict = checkCase(await readJson(io, casePath), sourcePath === undefined ? undefined : await readJson(io, sourcePath), corpus === undefined ? {} : { corpus });
  if (verdict.ok) {
    io.out(`ok: the case passes the privacy rules${corpus === undefined ? ' (the unknown-term check needs --dump)' : ''}.`);
    return true;
  }
  io.out(`refused: ${verdict.codes.join(', ')}`);
  return false;
}

export async function main(argv: readonly string[], io: ToolIo): Promise<number> {
  try {
    const [sub, ...rest] = argv;
    if (sub === 'build') {
      await build(rest, io);
      return 0;
    }
    if (sub === 'check') return (await check(rest, io)) ? 0 : 1;
    throw new UsageError('the first argument is build or check');
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      io.err(EVAL_USAGE);
    } else if (e instanceof BuildError) {
      io.err(`${e.code}: ${e.message}`);
    } else if (e instanceof ToolError) {
      io.err(`${e.code}: ${e.message}`);
    } else {
      io.err('failed: could not build the eval release (no detail is printed: it could hold a line of a case)');
    }
    return 1;
  }
}
