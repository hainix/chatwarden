import { dirname, join } from 'node:path';
import type { CorpusKey, CorpusMirror, CorpusRevokedRelease } from '@chatwarden/matcher/corpus';
import type { ReleaseSummary } from '../build/summary.js';
import { isoSeconds } from '../counters.js';
import { parseArgs, UsageError, valueOf } from './args.js';
import { ToolError } from './errors.js';
import type { ToolIo } from './io.js';
import { obtainSigningKey, KEY_ID_RE } from './keys.js';
import { defaultOutDir, guardOutDir } from './outdir.js';
import { publishRelease, refreshIndex, type PublishResult, type ReleaseStore } from './publishing.js';
import { recordSql } from './record.js';
import { signBytes } from './sign.js';
import { BUCKET_RE, nodeRunner, nodeScratch, wranglerStore } from './wrangler.js';

// `tools/publish.mjs` (design 6.1, 7): upload a signed release and the index that lists it. Needs the release summary the `release` tool wrote, the
// zip and its signature (made by `sign`) next to it, and the signing key (the index is signed here, with the passphrase typed at the prompt). It
// writes the SQL that records the release for the owner to apply, and never touches the database itself.
//
// With no `--release` it only re-signs the live index: `--refresh` (a fresh 90 days and the next sequence), `--revoke-key` and `--revoke-release`
// (a compromised key, a withdrawn release). Those three also work together with a release.

export const PUBLISH_USAGE = [
  'usage: publish --release <terms-VERSION.release.json> --key-id <id> [--key <pem file>] [--passphrase-env NAME] [--bucket NAME] [--trust id=publicKey[,id=publicKey]]',
  '       [--mirror <zenodo result file>] [--notes "sentence"] [--sequence N] [--dry-run] [--out <dir outside any git tree>]',
  '       [--refresh] [--revoke-key id[,id]] [--revoke-release kind:version:reason[,..]]   (with no --release: re-sign the live index, no release needed)',
].join('\n');

const KEY_PAIR_RE = /^([A-Za-z0-9_.:-]{1,64})=([A-Za-z0-9_-]{43})$/;
// A mirror is the permanent Zenodo archive only: its DOI is under the production prefix and its file is on zenodo.org (never the sandbox).
const DOI_RE = /^10\.5281\/[A-Za-z0-9._-]{1,100}$/;
const ZENODO_FILE_RE = /^https:\/\/zenodo\.org\/[\x21-\x7e]*$/;
const REVOKE_VERSION_RE = /^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0|[1-9]\d{0,2})$/;
const REVOKE_REASONS: readonly string[] = ['bad_release', 'key_compromise', 'legal'];
const decoder = new TextDecoder();

interface ReleaseFile {
  summary: ReleaseSummary;
  stamped: string[];
}

function readReleaseFile(bytes: Uint8Array): ReleaseFile {
  try {
    const raw = JSON.parse(decoder.decode(bytes)) as { summary?: ReleaseSummary; stamped?: unknown };
    const s = raw.summary;
    if (s === undefined || (s.kind !== 'terms' && s.kind !== 'eval') || typeof s.version !== 'string' || typeof s.sha256 !== 'string') throw new Error('shape');
    return { summary: s, stamped: Array.isArray(raw.stamped) ? (raw.stamped as string[]) : [] };
  } catch {
    throw new ToolError('bad_input', 'the release file is not one the release tool wrote');
  }
}

function readMirror(bytes: Uint8Array, summary: ReleaseSummary): Record<string, CorpusMirror[]> {
  try {
    const m = JSON.parse(decoder.decode(bytes)) as { kind?: unknown; version?: unknown; doi?: unknown; fileUrl?: unknown; sandbox?: unknown };
    if (m.kind !== summary.kind || m.version !== summary.version) throw new Error('other release');
    if (m.sandbox !== undefined) throw new Error('sandbox');
    if (typeof m.doi !== 'string' || !DOI_RE.test(m.doi)) throw new Error('doi');
    if (typeof m.fileUrl !== 'string' || !ZENODO_FILE_RE.test(m.fileUrl) || m.fileUrl.length > 500) throw new Error('url');
    return { [`${summary.kind}:${summary.version}`]: [{ kind: 'zenodo', doi: m.doi, url: m.fileUrl }] };
  } catch {
    throw new ToolError('bad_input', 'the mirror file is not a Zenodo result for this release (a zenodo.org https url and a 10.5281 DOI; a sandbox result is refused)');
  }
}

/** `id[,id]` of key ids. */
function parseRevokedKeys(text: string): string[] {
  const ids = text.split(',');
  if (ids.some((id) => !KEY_ID_RE.test(id))) throw new ToolError('bad_input', '--revoke-key takes key ids (letters, digits and _ . : -), comma separated');
  return ids;
}

/** `kind:version:reason[,..]`. */
function parseRevokedReleases(text: string): CorpusRevokedRelease[] {
  return text.split(',').map((item) => {
    const [kind, version, reason, ...extra] = item.split(':');
    if (extra.length > 0 || (kind !== 'terms' && kind !== 'eval') || version === undefined || !REVOKE_VERSION_RE.test(version) || reason === undefined || !REVOKE_REASONS.includes(reason)) {
      throw new ToolError('bad_input', `--revoke-release takes kind:version:reason (kind terms or eval, version YYYY.MM.N, reason ${REVOKE_REASONS.join(', ')}), comma separated`);
    }
    return { kind, version, reason } as CorpusRevokedRelease;
  });
}

export async function main(argv: readonly string[], io: ToolIo, deps: { store?: ReleaseStore } = {}): Promise<number> {
  try {
    const args = parseArgs(argv, {
      release: 'value',
      'key-id': 'value',
      key: 'value',
      'passphrase-env': 'value',
      bucket: 'value',
      trust: 'value',
      mirror: 'value',
      notes: 'value',
      sequence: 'value',
      'dry-run': 'flag',
      out: 'value',
      refresh: 'flag',
      'revoke-key': 'value',
      'revoke-release': 'value',
    });
    const releasePath = valueOf(args, 'release');
    const keyId = valueOf(args, 'key-id');
    if (keyId === undefined) throw new UsageError('--key-id is required');
    const revokeKeysText = valueOf(args, 'revoke-key');
    const revokeReleasesText = valueOf(args, 'revoke-release');
    const refresh = args.refresh === true;
    if (releasePath === undefined && !refresh && revokeKeysText === undefined && revokeReleasesText === undefined) throw new UsageError('--release is required (or --refresh, --revoke-key or --revoke-release to re-sign the live index)');
    if (releasePath === undefined && (valueOf(args, 'mirror') !== undefined || valueOf(args, 'notes') !== undefined)) throw new UsageError('--mirror and --notes belong to a release: give --release');
    if (!KEY_ID_RE.test(keyId)) throw new ToolError('bad_id', 'the key id may use letters, digits and _ . : - only, up to 64 characters');
    const revokedKeyIds = revokeKeysText === undefined ? [] : parseRevokedKeys(revokeKeysText);
    if (revokedKeyIds.includes(keyId)) throw new ToolError('bad_input', 'the key that signs the index cannot revoke itself (the kit ignores it): sign with the standby key and revoke the other');
    const revokedReleases = revokeReleasesText === undefined ? [] : parseRevokedReleases(revokeReleasesText);
    const sequenceText = valueOf(args, 'sequence');
    if (sequenceText !== undefined && !/^[1-9]\d{0,8}$/.test(sequenceText)) throw new UsageError('--sequence must be a whole number');
    const bucket = valueOf(args, 'bucket') ?? 'chatwarden-releases';
    if (!BUCKET_RE.test(bucket)) throw new UsageError('--bucket is not a valid R2 bucket name');
    const dry = args['dry-run'] === true;
    const dryOut = valueOf(args, 'out') ?? defaultOutDir(io);
    if (dry) guardOutDir(dryOut, io);

    let release: ReleaseFile | undefined;
    let zip: Uint8Array | undefined;
    let zipSig: Uint8Array | undefined;
    if (releasePath !== undefined) {
      try {
        release = readReleaseFile(await io.read(releasePath));
        const dir = dirname(releasePath);
        zip = await io.read(join(dir, `${release.summary.kind}-${release.summary.version}.zip`));
        zipSig = await io.read(join(dir, `${release.summary.kind}-${release.summary.version}.zip.sig`));
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError('bad_file', 'the release file, its zip or the zip signature could not be read (run release, then sign, first)');
      }
    }
    const mirrorPath = valueOf(args, 'mirror');
    let mirrors: Record<string, CorpusMirror[]> | undefined;
    if (mirrorPath !== undefined && release !== undefined) {
      let bytes: Uint8Array;
      try {
        bytes = await io.read(mirrorPath);
      } catch {
        throw new ToolError('bad_file', 'the mirror file could not be read');
      }
      mirrors = readMirror(bytes, release.summary);
    }
    const loaded = await obtainSigningKey(io, { keyFile: valueOf(args, 'key'), passphraseEnv: valueOf(args, 'passphrase-env') });
    const keys: CorpusKey[] = [{ id: keyId, publicKey: loaded.publicKey }];
    const trust = valueOf(args, 'trust');
    if (trust !== undefined) {
      for (const pair of trust.split(',')) {
        const m = KEY_PAIR_RE.exec(pair);
        if (m === null) throw new UsageError('--trust must be id=publicKey (base64url), comma separated');
        keys.push({ id: m[1] as string, publicKey: m[2] as string });
      }
    }
    const store = deps.store ?? wranglerStore({ bucket, run: nodeRunner, scratch: nodeScratch });
    const common = {
      store,
      clock: io.clock,
      signIndex: (bytes: Uint8Array) => signBytes('index', bytes, loaded.key, keyId),
      keyId,
      keys,
      dryRun: dry,
      ...(revokedKeyIds.length === 0 ? {} : { revokedKeyIds }),
      ...(revokedReleases.length === 0 ? {} : { revokedReleases }),
      ...(sequenceText === undefined ? {} : { sequence: Number(sequenceText) }),
    };

    let result: PublishResult;
    if (release === undefined || zip === undefined || zipSig === undefined) {
      result = await refreshIndex(common);
    } else {
      result = await publishRelease({
        ...common,
        summary: release.summary,
        zip,
        zipSig,
        refresh,
        ...(mirrors === undefined ? {} : { mirrors }),
        ...(valueOf(args, 'notes') === undefined ? {} : { notes: valueOf(args, 'notes') as string }),
      });
    }

    if (dry) {
      if (!result.published) {
        io.out('dry run: nothing to publish (this release is already live with these bytes).');
        return 0;
      }
      await io.ensureDir(dryOut);
      await io.write(join(dryOut, 'index.json'), result.indexBytes);
      await io.write(join(dryOut, 'index.json.sig'), result.indexSig);
      io.out(`dry run: the new index (sequence ${result.sequence}) and its signature were written to ${dryOut}; nothing was uploaded and no SQL was written.`);
      return 0;
    }
    if (release === undefined) {
      io.out(`refreshed the index at sequence ${result.sequence} (a new 90 days${revokedKeyIds.length + revokedReleases.length > 0 ? ', with the revocations' : ''}); only the signature and the index were uploaded.`);
      io.out('then check what the public sees:   node services/corpus/tools/verify-live.mjs --key <id>=<publicKey>');
      return 0;
    }
    if (!result.published) {
      io.out('nothing to publish: this release is already live with these bytes.');
      return 0;
    }
    const sqlPath = join(dirname(releasePath as string), `record-${release.summary.kind}-${release.summary.version}.sql`);
    await io.write(
      sqlPath,
      recordSql({ kind: release.summary.kind, version: release.summary.version, sequence: result.sequence, sha256: release.summary.sha256, keyId, publishedAt: isoSeconds(io.clock.now()), stamped: release.stamped }),
    );
    io.out(`published ${release.summary.kind} ${release.summary.version} at index sequence ${result.sequence} (${result.uploaded.length} files uploaded, the index last).`);
    io.out(`next: tell the database:   npx wrangler d1 execute chatwarden-corpus --remote --file ${sqlPath}`);
    io.out('then check what the public sees (a minute after the upload):   node services/corpus/tools/verify-live.mjs --key <id>=<publicKey>');
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      io.err(PUBLISH_USAGE);
    } else if (e instanceof ToolError) {
      io.err(`${e.code}: ${e.message}`);
    } else if (e instanceof RangeError) {
      io.err('bad_input: a value in the release file is not the shape it must be');
    } else {
      io.err('failed: could not publish (no detail is printed: it could hold a path or a token)');
    }
    return 1;
  }
}
