import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readZip } from '@chatwarden/matcher/corpus';
import { isoSeconds } from '../counters.js';
import type { ReleaseSummary } from '../build/summary.js';
import { parseArgs, UsageError, valueOf } from './args.js';
import { ToolError } from './errors.js';
import type { ToolIo } from './io.js';
import { doiSql } from './record.js';
import { publishToZenodo, zenodoMetadata, type ZenodoRelease, type ZenodoResult } from './zenodoClient.js';

// `tools/zenodo.mjs` (design 11): archive a signed release on Zenodo as a new version of the project's record. The token is read from the
// environment of the release machine (a variable's name, `ZENODO_TOKEN` unless `--token-env` says otherwise; never an argument) and is sent in a
// header only. The result is a small file the `publish` tool reads to add the mirror (`--mirror`), and the record id to use next time.

export const ZENODO_USAGE =
  'usage: zenodo --release <terms-VERSION.release.json> --record <deposition id of the latest version> [--key id=publicKey[,id=publicKey]] [--token-env NAME] [--creator "Name"] [--sandbox] [--dry-run]';

const KEY_PAIR_RE = /^([A-Za-z0-9_.:-]{1,64})=([A-Za-z0-9_-]{43})$/;
const decoder = new TextDecoder();

export async function main(argv: readonly string[], io: ToolIo, deps: { fetch?: typeof fetch } = {}): Promise<number> {
  try {
    const args = parseArgs(argv, { release: 'value', record: 'value', key: 'value', 'token-env': 'value', creator: 'value', sandbox: 'flag', 'dry-run': 'flag' });
    const releasePath = valueOf(args, 'release');
    const recordText = valueOf(args, 'record');
    if (releasePath === undefined || recordText === undefined) throw new UsageError('--release and --record are required');
    if (!/^[1-9]\d{0,12}$/.test(recordText)) throw new UsageError('--record must be the numeric id of the latest version of the record');
    const keys = (valueOf(args, 'key') ?? '').split(',').filter((p) => p !== '').map((pair) => {
      const m = KEY_PAIR_RE.exec(pair);
      if (m === null) throw new UsageError('--key must be id=publicKey (base64url), comma separated');
      return { id: m[1] as string, fingerprint: createHash('sha256').update(Buffer.from(m[2] as string, 'base64url')).digest('hex') };
    });

    let summary: ReleaseSummary;
    let release: ZenodoRelease;
    try {
      summary = (JSON.parse(decoder.decode(await io.read(releasePath))) as { summary: ReleaseSummary }).summary;
      const dir = dirname(releasePath);
      const stem = `${summary.kind}-${summary.version}`;
      const zip = await io.read(join(dir, `${stem}.zip`));
      const sig = await io.read(join(dir, `${stem}.zip.sig`));
      const manifest = (await readZip(zip)).get('manifest.json');
      if (manifest === undefined) throw new Error('no manifest');
      release = { kind: summary.kind, version: summary.version, zip, sig, manifest, keys };
    } catch {
      throw new ToolError('bad_file', 'the release file, its zip, the signature or the manifest could not be read (run release, then sign, first)');
    }
    const sandbox = args.sandbox === true;
    // The sandbox has its own result file: a sandbox run must never stand in for the real archive, nor be taken as a mirror.
    const resultPath = join(dirname(releasePath), `zenodo-${sandbox ? 'sandbox-' : ''}${release.kind}-${release.version}.json`);
    const today = isoSeconds(io.clock.now()).slice(0, 10);
    const creator = valueOf(args, 'creator');
    const stem = `${release.kind}-${release.version}`;

    if (args['dry-run'] === true) {
      io.out('dry run: nothing is sent. The files, then the metadata:');
      io.out(`  ${stem}.zip, ${stem}.zip.sig, ${stem}.manifest.json`);
      io.out(JSON.stringify(zenodoMetadata(release, { today, ...(creator === undefined ? {} : { creator }) }), null, 2));
      return 0;
    }
    if (io.exists(resultPath)) {
      try {
        const known = JSON.parse(decoder.decode(await io.read(resultPath))) as ZenodoResult;
        io.out(`already on ${sandbox ? 'the Zenodo SANDBOX' : 'Zenodo'}: ${known.doi} (the result file exists; delete it only if you really mean to start over)`);
        return 0;
      } catch {
        throw new ToolError('bad_file', 'a result file for this release exists but cannot be read; fix or remove it');
      }
    }
    const tokenName = valueOf(args, 'token-env') ?? 'ZENODO_TOKEN';
    const token = io.env[tokenName];
    if (token === undefined || token === '') throw new ToolError('no_token', 'no Zenodo token: set the environment variable (ZENODO_TOKEN, or the name given with --token-env) on the release machine');

    const result = await publishToZenodo(
      { fetch: deps.fetch ?? io.fetch, token, record: Number(recordText), today, ...(sandbox ? { baseUrl: 'https://sandbox.zenodo.org' } : {}), ...(creator === undefined ? {} : { creator }) },
      release,
    );
    await io.write(resultPath, `${JSON.stringify(sandbox ? { ...result, sandbox: true } : result, null, 2)}\n`);
    if (sandbox) {
      io.out(`archived ${release.kind} ${release.version} on the Zenodo SANDBOX: ${result.doi}`);
      io.out('this was a rehearsal: a sandbox archive is not permanent and publish --mirror refuses it. Run again without --sandbox for the real one.');
      return 0;
    }
    const sqlPath = join(dirname(releasePath), `doi-${release.kind}-${release.version}.sql`);
    await io.write(sqlPath, doiSql(release.kind, release.version, result.doi));
    io.out(`archived ${release.kind} ${release.version} on Zenodo: ${result.doi}`);
    io.out(`record the DOI in the database:   npx wrangler d1 execute chatwarden-corpus --remote --file ${sqlPath}`);
    io.out(`next time, use --record ${result.depositionId}. To put the mirror in the index: publish --mirror <the zenodo-... result file next to the release file>`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      io.err(ZENODO_USAGE);
    } else if (e instanceof ToolError) {
      io.err(`${e.code}: ${e.message}`);
    } else {
      io.err('failed: could not archive on Zenodo (no detail is printed: it could hold a token)');
    }
    return 1;
  }
}
