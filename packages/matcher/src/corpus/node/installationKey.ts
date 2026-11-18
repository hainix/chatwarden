import { randomBytes, webcrypto } from 'node:crypto';
import { link, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { base64urlEncode } from '../sign.js';

// The installation key (design 8.2, 10.2): a random Ed25519 key a server keeps in its cache folder, which signs what it offers to the
// community list. It identifies one folder, not a person or a game; deleting the file makes a new installation. The file is the
// PKCS#8 private key (mode 0600, folder 0700); it is created once, atomically, and read again on every start.

const FILE = 'installation.key';
const MAX_KEY_FILE_BYTES = 256;
const failed = (): Error => new Error('corpus: the installation key could not be read or created');
const codeOf = (e: unknown): string | undefined => (typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined);

interface Loaded {
  publicKey: string;
  privateKey: webcrypto.CryptoKey;
}

/** The key in the file, or null when there is no usable one (absent, damaged, truncated, not an Ed25519 key). */
async function load(file: string): Promise<Loaded | null> {
  let raw: Uint8Array;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_KEY_FILE_BYTES) return null;
    const handle = await open(file, 'r');
    try {
      const buffer = new Uint8Array(info.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      raw = buffer.slice(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', raw, 'Ed25519', true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', privateKey);
    if (typeof jwk.x !== 'string' || jwk.x.length !== 43) return null;
    return { publicKey: jwk.x, privateKey };
  } catch {
    return null;
  }
}

/** Write a new key without ever showing another reader a half-written file: a temporary file, then a hard link (which fails if the
 *  name is taken) or, when the file system has no links or the existing file is damaged, a rename. */
async function create(dir: string, file: string): Promise<Loaded> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(pkcs8);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, file);
    } catch (e) {
      if (codeOf(e) === 'EEXIST') {
        const theirs = await load(file);
        if (theirs !== null) return theirs; // another start made the key first: use it
      }
      await rename(temporary, file); // a damaged file, or no hard links here
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  const mine = await load(file);
  if (mine === null) throw failed();
  return mine;
}

/**
 * The installation's key: `publicKey` (32 bytes, base64url) and `sign(message)` (Ed25519, 64 bytes, base64url). Generated on the first
 * call and kept in `dir/installation.key`; the next call, and the next start, read the same one. A damaged key file is replaced. Rejects
 * (with an error that names no path) when the folder cannot be written, because a share cannot work without a key.
 */
export async function installationKey(dir: string): Promise<{ publicKey: string; sign(message: Uint8Array): Promise<string> }> {
  if (typeof dir !== 'string' || dir === '' || dir.includes(String.fromCharCode(0))) throw new TypeError('corpus: dir must be a folder path');
  const file = join(dir, FILE);
  let key: Loaded | null;
  try {
    key = (await load(file)) ?? (await create(dir, file));
  } catch {
    throw failed();
  }
  const { privateKey, publicKey } = key;
  return {
    publicKey,
    async sign(message) {
      return base64urlEncode(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, message)));
    },
  };
}
