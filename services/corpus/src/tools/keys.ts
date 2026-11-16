import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { ToolError } from './errors.js';
import type { ToolIo } from './io.js';

// Signing keys (design 7). An Ed25519 key pair made on the owner's machine: the private half is an encrypted PKCS#8 PEM (aes-256-cbc under a
// passphrase the owner types), the public half is the raw 32-byte key as base64url, the form `CORPUS_KEYS` holds. Nothing here prints, logs or
// returns a private key or a passphrase except the PEM that the caller writes to a file.

export const KEY_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MIN_PASSPHRASE = 12;

export interface GeneratedKey {
  keyId: string;
  /** The encrypted PKCS#8 PEM. */
  pem: string;
  /** The raw public key, base64url (what `CORPUS_KEYS` holds). */
  publicKey: string;
  /** SHA-256 of the raw public key, hex: what a person compares out of band. */
  fingerprint: string;
}

/** The raw 32 bytes of an Ed25519 public key. */
function rawPublic(key: KeyObject): Buffer {
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32);
}

export function describePublic(key: KeyObject): { publicKey: string; fingerprint: string } {
  const raw = rawPublic(key);
  return { publicKey: raw.toString('base64url'), fingerprint: createHash('sha256').update(raw).digest('hex') };
}

/** Makes a key pair. The id must be one the index and the signature file accept. */
export function generateSigningKey(keyId: string, passphrase: string): GeneratedKey {
  if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) throw new RangeError('generateSigningKey: the key id is not valid');
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) throw new RangeError('generateSigningKey: the passphrase is too short');
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }).toString();
  return { keyId, pem, ...describePublic(privateKey) };
}

export interface LoadedKey {
  key: KeyObject;
  publicKey: string;
  fingerprint: string;
}

/** Opens an encrypted PKCS#8 PEM. A wrong passphrase, an unencrypted key and anything else are the one refusal `bad_key`. */
export function loadSigningKey(pem: string, passphrase: string): LoadedKey {
  try {
    if (typeof pem !== 'string' || !pem.includes('ENCRYPTED PRIVATE KEY') || typeof passphrase !== 'string' || passphrase === '') throw new Error('refused');
    const key = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8', passphrase });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('refused');
    return { key, ...describePublic(key) };
  } catch {
    throw new ToolError('bad_key', 'the key could not be opened (wrong passphrase, or not an encrypted Ed25519 key)');
  }
}

/** Where a tool finds the signing key: a file (`--key`), or the environment (`CORPUS_SIGNING_KEY_FILE` names a file, `CORPUS_SIGNING_KEY` holds the PEM). */
export async function readKeyPem(io: ToolIo, keyFile: string | undefined): Promise<string> {
  try {
    if (keyFile !== undefined) return new TextDecoder().decode(await io.read(keyFile));
    const viaFile = io.env.CORPUS_SIGNING_KEY_FILE;
    if (viaFile !== undefined && viaFile !== '') return new TextDecoder().decode(await io.read(viaFile));
    const pem = io.env.CORPUS_SIGNING_KEY;
    if (pem !== undefined && pem !== '') return pem;
  } catch {
    throw new ToolError('no_key', 'the signing key could not be read');
  }
  throw new ToolError('no_key', 'no signing key: pass --key <file>, or set CORPUS_SIGNING_KEY_FILE (a path) or CORPUS_SIGNING_KEY (the PEM)');
}

/** The passphrase: from the variable `--passphrase-env` names when that is given, otherwise asked on the terminal (never an argument). */
export async function readPassphrase(io: ToolIo, envName: string | undefined, prompt: string): Promise<string> {
  if (envName !== undefined) {
    const value = io.env[envName];
    if (value === undefined || value === '') throw new ToolError('no_passphrase', 'the environment variable named by --passphrase-env is not set');
    return value;
  }
  try {
    return await io.secret(prompt);
  } catch {
    throw new ToolError('no_passphrase', 'a passphrase is needed and there is no terminal to ask on (use --passphrase-env NAME)');
  }
}

/** The key and its passphrase, the way every signing tool gets them. */
export async function obtainSigningKey(io: ToolIo, options: { keyFile?: string | undefined; passphraseEnv?: string | undefined }): Promise<LoadedKey> {
  const pem = await readKeyPem(io, options.keyFile);
  const passphrase = await readPassphrase(io, options.passphraseEnv, 'Passphrase of the signing key: ');
  return loadSigningKey(pem, passphrase);
}
