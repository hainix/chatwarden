import { dirname, parse, resolve } from 'node:path';
import { parseArgs, UsageError, valueOf } from './args.js';
import { ToolError } from './errors.js';
import type { ToolIo } from './io.js';
import { generateSigningKey, KEY_ID_RE, MIN_PASSPHRASE, readPassphrase } from './keys.js';

// `tools/keygen.mjs` (design 7): make a signing key on the owner's machine. The private key is written once, as an encrypted PEM, mode 0600,
// outside any git working tree; the public key and its fingerprint are printed. The private key and the passphrase are never printed.

export const KEYGEN_USAGE = 'usage: keygen --id <k1|k2|...> --out <path outside any git tree> [--passphrase-env NAME]';

/** Whether `path` is inside a git working tree: a `.git` folder (or file, in a linked worktree) in the folder it will be written to or any above. */
export function insideGitTree(path: string, io: ToolIo): boolean {
  let dir = dirname(resolve(path));
  for (;;) {
    if (io.exists(resolve(dir, '.git'))) return true;
    const up = dirname(dir);
    if (up === dir || dir === parse(dir).root) return false;
    dir = up;
  }
}

export async function main(argv: readonly string[], io: ToolIo): Promise<number> {
  try {
    const args = parseArgs(argv, { id: 'value', out: 'value', 'passphrase-env': 'value' });
    const id = valueOf(args, 'id');
    const out = valueOf(args, 'out');
    if (id === undefined || out === undefined) throw new UsageError('--id and --out are required');
    if (!KEY_ID_RE.test(id)) throw new ToolError('bad_id', 'the key id may use letters, digits and _ . : - only, up to 64 characters');
    if (insideGitTree(out, io)) throw new ToolError('in_git_tree', 'refusing to write a private key inside a git working tree: choose a folder outside every repository');
    if (io.exists(out)) throw new ToolError('exists', 'a file already exists there; a key is never overwritten');
    const envName = valueOf(args, 'passphrase-env');
    const passphrase = await readPassphrase(io, envName, 'New passphrase for the signing key: ');
    if (passphrase.length < MIN_PASSPHRASE) throw new ToolError('weak_passphrase', `the passphrase must have at least ${MIN_PASSPHRASE} characters`);
    if (envName === undefined && (await readPassphrase(io, undefined, 'Again: ')) !== passphrase) throw new ToolError('passphrase_mismatch', 'the two passphrases did not match');
    const key = generateSigningKey(id, passphrase);
    try {
      await io.write(out, key.pem, { mode: 0o600, exclusive: true });
    } catch {
      throw new ToolError('exists', 'the key could not be written there (does the folder exist, and is the file new?)');
    }
    io.out(`key ${id} written to the file you named (encrypted, mode 0600). Keep it offline; keep a second copy of a standby key somewhere else.`);
    io.out(`public key (base64url): ${key.publicKey}`);
    io.out(`fingerprint (sha-256 of the raw public key): ${key.fingerprint}`);
    io.out(`for packages/matcher/src/corpus/keys.ts:  { id: '${id}', publicKey: '${key.publicKey}' }`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      io.err(KEYGEN_USAGE);
    } else if (e instanceof ToolError) {
      io.err(`${e.code}: ${e.message}`);
    } else {
      io.err('failed: the key could not be made');
    }
    return 1;
  }
}
