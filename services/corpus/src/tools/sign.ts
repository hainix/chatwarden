import { sign as nodeSign, type KeyObject } from 'node:crypto';
import { signedMessage, verifySignature } from '@chatwarden/matcher/corpus';
import { parseArgs, UsageError, valueOf } from './args.js';
import { ToolError } from './errors.js';
import type { ToolIo } from './io.js';
import { KEY_ID_RE, obtainSigningKey } from './keys.js';

// `tools/sign.mjs` (design 6.3, 7): sign a release zip or an index. The signed message is the kit's own `signedMessage(kind, bytes)`, so a
// signature made for a zip is never valid as an index, a submission or a report. The tool checks its own signature with the kit's verifier before
// it writes anything.

export const SIGN_USAGE = 'usage: sign --kind <zip|index> --file <path> --key-id <id> [--key <pem file>] [--passphrase-env NAME] [--out <sig path>]';

/** The signature file (a JSON text) for `bytes` as a `kind`. Only a zip or an index is signed. */
export function signBytes(kind: 'zip' | 'index', bytes: Uint8Array, key: KeyObject, keyId: string): string {
  if (kind !== 'zip' && kind !== 'index') throw new RangeError('signBytes: kind must be zip or index');
  const sig = nodeSign(null, signedMessage(kind, bytes), key).toString('base64url');
  return `${JSON.stringify({ schema: 'chatwarden-corpus-sig/1', alg: 'Ed25519', keyId, sig })}\n`;
}

export async function main(argv: readonly string[], io: ToolIo): Promise<number> {
  try {
    const args = parseArgs(argv, { kind: 'value', file: 'value', 'key-id': 'value', key: 'value', 'passphrase-env': 'value', out: 'value' });
    const kind = valueOf(args, 'kind');
    const file = valueOf(args, 'file');
    const keyId = valueOf(args, 'key-id');
    if (kind === undefined || file === undefined || keyId === undefined) throw new UsageError('--kind, --file and --key-id are required');
    if (kind !== 'zip' && kind !== 'index') throw new ToolError('bad_kind', 'only a zip or an index is signed');
    if (!KEY_ID_RE.test(keyId)) throw new ToolError('bad_id', 'the key id may use letters, digits and _ . : - only, up to 64 characters');
    let bytes: Uint8Array;
    try {
      bytes = await io.read(file);
    } catch {
      throw new ToolError('bad_file', 'the file to sign could not be read');
    }
    const loaded = await obtainSigningKey(io, { keyFile: valueOf(args, 'key'), passphraseEnv: valueOf(args, 'passphrase-env') });
    const sig = signBytes(kind, bytes, loaded.key, keyId);
    try {
      await verifySignature(kind, bytes, sig, [{ id: keyId, publicKey: loaded.publicKey }]);
    } catch {
      throw new ToolError('bad_signature', 'the signature did not verify against its own public key; nothing was written');
    }
    const out = valueOf(args, 'out') ?? `${file}.sig`;
    await io.write(out, sig);
    io.out(`signed as ${kind} with key ${keyId} (fingerprint ${loaded.fingerprint}); signature written to ${out}`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      io.err(SIGN_USAGE);
    } else if (e instanceof ToolError) {
      io.err(`${e.code}: ${e.message}`);
    } else {
      io.err('failed: could not sign');
    }
    return 1;
  }
}
