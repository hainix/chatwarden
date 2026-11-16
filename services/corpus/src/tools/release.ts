import { parseTermsRelease, readZip } from '@chatwarden/matcher/corpus';
import { ToolError } from './errors.js';
import { BuildError, buildTermsRelease, nextSequence, nextVersion } from '../build/release.js';
import { renderDiff } from '../build/diff.js';
import { parseArgs, UsageError, valueOf } from './args.js';
import type { ToolIo } from './io.js';
import { openDump } from './localD1.js';
import { defaultOutDir, guardOutDir } from './outdir.js';

// `tools/release.mjs`: build a terms release from a copy of the database (design 7). It reads a SQL dump, never the live database, writes the
// zip and a small summary next to it, and prints the diff: counts and ids, no word unless `--show-words`. It does not sign, upload or record.

const SPEC = { dump: 'value', out: 'value', previous: 'value', version: 'value', sequence: 'value', languages: 'value', 'allow-bulk': 'flag', 'show-words': 'flag' } as const;

export const RELEASE_USAGE = `usage: release --dump <d1-export.sql> [--out <dir outside any git tree>] [--previous <last-terms-zip>] [--version YYYY.MM.N] [--sequence N] [--languages en,es,pt] [--allow-bulk] [--show-words]`;

const decoder = new TextDecoder();

export async function main(argv: readonly string[], io: ToolIo): Promise<number> {
  try {
    const args = parseArgs(argv, SPEC);
    const dump = valueOf(args, 'dump');
    if (dump === undefined) throw new UsageError('--dump is required');
    const out = valueOf(args, 'out') ?? defaultOutDir(io);
    guardOutDir(out, io);
    const db = openDump(decoder.decode(await io.read(dump)));
    const version = valueOf(args, 'version') ?? (await nextVersion(db, io.clock));
    const sequenceText = valueOf(args, 'sequence');
    const sequence = sequenceText === undefined ? await nextSequence(db) : Number(sequenceText);
    const last = await db.prepare("SELECT version FROM releases WHERE kind = 'terms' ORDER BY sequence DESC LIMIT 1").first<{ version: string }>();
    const languagesText = valueOf(args, 'languages');
    const previousPath = valueOf(args, 'previous');
    const previousTerms = previousPath === undefined ? undefined : parseTermsRelease(await readZip(await io.read(previousPath))).terms;
    const result = await buildTermsRelease(db, {
      clock: io.clock,
      version,
      sequence,
      previous: last?.version ?? null,
      allowBulk: args['allow-bulk'] === true,
      ...(languagesText === undefined ? {} : { languages: languagesText.split(',') }),
      ...(previousTerms === undefined ? {} : { previousTerms }),
    });
    await io.ensureDir(out);
    const zipPath = `${out}/terms-${version}.zip`;
    await io.write(zipPath, result.zip);
    await io.write(`${out}/terms-${version}.release.json`, `${JSON.stringify({ summary: result.summary, held: result.held, stamped: result.stamped }, null, 2)}\n`);
    const words = args['show-words'] === true ? new Map(result.release.terms.map((t) => [t.id, t.term])) : undefined;
    io.out(renderDiff(result.diff, words).trimEnd());
    if (result.unrecorded.length > 0) {
      io.out('');
      io.out(`warning: ${result.unrecorded.length} term(s) of the previous release have no since in the database (its record SQL was not applied): ${result.unrecorded.join(', ')}`);
    }
    if (result.positiveUncovered > 0) io.out(`note: ${result.positiveUncovered} row(s) have no pack-wide positive line (the kit reads at most 2000 in a file); their own lines are still in the release.`);
    io.out('');
    io.out(`built ${zipPath} (${result.summary.bytes} bytes, sha-256 ${result.summary.sha256}), index sequence ${sequence}`);
    io.out('next: read the diff, then sign it (tools/sign.mjs).');
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      io.err(RELEASE_USAGE);
    } else if (e instanceof ToolError) {
      io.err(`${e.code}: ${e.message}`);
    } else if (e instanceof BuildError) {
      io.err(`${e.code}: ${e.message}${e.ids.length > 0 ? ` (${e.ids.join(', ')})` : ''}`);
    } else {
      io.err('failed: could not build the release (no detail is printed: it could hold a word)');
    }
    return 1;
  }
}
