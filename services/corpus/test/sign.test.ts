import { signedMessage, verifySignature, type CorpusKey } from '@chatwarden/matcher/corpus';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSigningKey, loadSigningKey } from '../src/tools/keys.js';
import { main as keygen } from '../src/tools/keygen.js';
import { main as sign, signBytes } from '../src/tools/sign.js';
import { makeToolWorld, type ToolWorld } from './tool-world.js';

// Keys and signatures (design 7). Keys are generated here, in the test; the kit's own verifier is the judge of every signature.

const PASS = 'correct horse battery staple 7';
const bytes = new TextEncoder().encode('the bytes of a release zip, invented');

let tw: ToolWorld;
beforeEach(() => {
  tw = makeToolWorld({ secrets: [PASS, PASS] });
});
afterEach(() => tw.cleanup());

const ringOf = (k: { keyId: string; publicKey: string }): CorpusKey[] => [{ id: k.keyId, publicKey: k.publicKey }];
const b64uDecode = (text: string): Buffer => Buffer.from(text, 'base64url');
const codeOf = (f: () => unknown): string | null => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  }
  return null;
};

describe('generateSigningKey and loadSigningKey', () => {
  it('make an encrypted PKCS#8 key whose public half is the raw 32-byte key the kit imports, and whose fingerprint is the SHA-256 of it', () => {
    const k = generateSigningKey('k1', PASS);
    expect(k.pem.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')).toBe(true);
    expect(b64uDecode(k.publicKey)).toHaveLength(32);
    expect(k.fingerprint).toBe(createHash('sha256').update(b64uDecode(k.publicKey)).digest('hex'));
    const loaded = loadSigningKey(k.pem, PASS);
    expect(loaded.publicKey).toBe(k.publicKey);
    expect(loaded.fingerprint).toBe(k.fingerprint);
  });

  it('a wrong passphrase, a plain (unencrypted) key and garbage are all the same refusal, and say nothing about why', () => {
    const k = generateSigningKey('k1', PASS);
    for (const [pem, pass] of [[k.pem, 'wrong'], [k.pem, ''], ['not a key', PASS], ['', PASS]] as const) {
      expect(codeOf(() => loadSigningKey(pem, pass))).toBe('bad_key');
    }
  });

  it('two keys differ, and the key id is checked', () => {
    expect(generateSigningKey('k1', PASS).publicKey).not.toBe(generateSigningKey('k1', PASS).publicKey);
    for (const id of ['', 'a b', 'k/1', 'x'.repeat(65)]) expect(() => generateSigningKey(id, PASS)).toThrow(RangeError);
  });
});

describe('keygen refuses a path inside a git tree, writes mode 0600, and the private key never appears in stdout', () => {
  const run = (...argv: string[]) => keygen(argv, tw.io);

  it('writes the key, prints the public key, its fingerprint and the line for keys.ts, and nothing of the private key or the passphrase', async () => {
    const path = join(tw.dir, 'k1.pem');
    expect(await run('--id', 'k1', '--out', path)).toBe(0);
    const pem = readFileSync(path, 'utf8');
    expect(pem.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')).toBe(true);
    const loaded = loadSigningKey(pem, PASS);
    const printed = tw.everything();
    expect(printed).toContain(loaded.publicKey);
    expect(printed).toContain(loaded.fingerprint);
    expect(printed).toContain(`{ id: 'k1', publicKey: '${loaded.publicKey}' }`);
    expect(printed).not.toContain(PASS);
    expect(printed).not.toMatch(/BEGIN|PRIVATE KEY/);
    expect(printed.replace(/\s/g, '')).not.toContain(pem.split('\n')[1]!.trim());
    expect(tw.asked).toHaveLength(2);
  });

  it('writes the file exclusively with mode 0600 (and the mode holds on disk where the platform has modes)', async () => {
    const path = join(tw.dir, 'k1.pem');
    await run('--id', 'k1', '--out', path);
    expect(tw.writes).toEqual([{ path, mode: 0o600, exclusive: true }]);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses a path inside a git working tree (a .git folder), and one inside a worktree (a .git file), and writes nothing', async () => {
    const repo = join(tw.dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'deep', 'er'), { recursive: true });
    expect(await run('--id', 'k1', '--out', join(repo, 'deep', 'er', 'k1.pem'))).toBe(1);
    expect(tw.err.join('\n')).toContain('inside a git working tree');
    const wt = join(tw.dir, 'worktree');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: elsewhere');
    expect(await run('--id', 'k1', '--out', join(wt, 'k1.pem'))).toBe(1);
    expect(existsSync(join(repo, 'deep', 'er', 'k1.pem'))).toBe(false);
    expect(existsSync(join(wt, 'k1.pem'))).toBe(false);
    expect(tw.writes).toEqual([]);
    expect(tw.asked).toEqual([]); // refused before it asked for a passphrase
  });

  it('never overwrites a key that exists', async () => {
    const path = join(tw.dir, 'k1.pem');
    writeFileSync(path, 'an old key');
    expect(await run('--id', 'k1', '--out', path)).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('an old key');
    expect(tw.err.join('\n')).toContain('already exists');
  });

  it('asks twice and refuses a passphrase that does not match or is short, and a missing terminal', async () => {
    const path = join(tw.dir, 'k1.pem');
    const mismatch = makeToolWorld({ secrets: [PASS, 'something else entirely 99'] });
    expect(await keygen(['--id', 'k1', '--out', path], mismatch.io)).toBe(1);
    expect(mismatch.err.join('\n')).toContain('did not match');
    mismatch.cleanup();
    const short = makeToolWorld({ secrets: ['short', 'short'] });
    expect(await keygen(['--id', 'k1', '--out', path], short.io)).toBe(1);
    expect(short.err.join('\n')).toContain('at least 12');
    expect(short.everything()).not.toMatch(/short', 'short|"short"/);
    short.cleanup();
    const none = makeToolWorld({ secrets: [] });
    expect(await keygen(['--id', 'k1', '--out', path], none.io)).toBe(1);
    expect(none.err.join('\n')).toContain('terminal');
    none.cleanup();
    expect(existsSync(path)).toBe(false);
  });

  it('ignores a passphrase in the environment unless --passphrase-env names it, and never takes one as an argument', async () => {
    const withEnv = makeToolWorld({ secrets: [PASS, PASS], env: { CORPUS_KEY_PASSPHRASE: 'an environment passphrase 123' } });
    expect(await keygen(['--id', 'k1', '--out', join(withEnv.dir, 'a.pem')], withEnv.io)).toBe(0);
    expect(withEnv.asked).toHaveLength(2);
    loadSigningKey(readFileSync(join(withEnv.dir, 'a.pem'), 'utf8'), PASS);
    const named = makeToolWorld({ secrets: [], env: { MY_PASS: 'an environment passphrase 123' } });
    expect(await keygen(['--id', 'k2', '--out', join(named.dir, 'b.pem'), '--passphrase-env', 'MY_PASS'], named.io)).toBe(0);
    loadSigningKey(readFileSync(join(named.dir, 'b.pem'), 'utf8'), 'an environment passphrase 123');
    expect(named.everything()).not.toContain('an environment passphrase 123');
    expect(await keygen(['--id', 'k3', '--out', join(named.dir, 'c.pem'), '--passphrase', 'x'], named.io)).toBe(1);
    withEnv.cleanup();
    named.cleanup();
  });

  it('needs an id and a path', async () => {
    expect(await run('--out', join(tw.dir, 'x.pem'))).toBe(1);
    expect(await run('--id', 'k1')).toBe(1);
    expect(await run('--id', 'bad id', '--out', join(tw.dir, 'x.pem'))).toBe(1);
  });
});

describe('a signature made by sign verifies with the kit\u2019s verifySignature and fails for another kind', () => {
  const key = generateSigningKey('k1', PASS);
  const loaded = loadSigningKey(key.pem, PASS);

  it('signs the domain-separated message: the kit verifies a zip signature as a zip and refuses it as an index', async () => {
    const sig = signBytes('zip', bytes, loaded.key, 'k1');
    expect(await verifySignature('zip', bytes, sig, ringOf(key))).toEqual({ keyId: 'k1' });
    await expect(verifySignature('index', bytes, sig, ringOf(key))).rejects.toMatchObject({ code: 'bad_signature' });
    const idx = signBytes('index', bytes, loaded.key, 'k1');
    expect(await verifySignature('index', bytes, idx, ringOf(key))).toEqual({ keyId: 'k1' });
    await expect(verifySignature('zip', bytes, idx, ringOf(key))).rejects.toMatchObject({ code: 'bad_signature' });
  });

  it('is the signature file of design 6.3, exactly: schema, alg, keyId and a 64-byte base64url sig', () => {
    const file = JSON.parse(signBytes('zip', bytes, loaded.key, 'k1')) as Record<string, string>;
    expect(Object.keys(file)).toEqual(['schema', 'alg', 'keyId', 'sig']);
    expect(file).toMatchObject({ schema: 'chatwarden-corpus-sig/1', alg: 'Ed25519', keyId: 'k1' });
    expect(b64uDecode(file.sig as string)).toHaveLength(64);
    expect(Buffer.byteLength(signBytes('zip', bytes, loaded.key, 'k1'))).toBeLessThan(1024);
  });

  it('is not a signature over the bare bytes: the message is the kit\u2019s signedMessage', async () => {
    const message = signedMessage('zip', bytes);
    const { createPublicKey, verify } = await import('node:crypto');
    const sig = Buffer.from((JSON.parse(signBytes('zip', bytes, loaded.key, 'k1')) as { sig: string }).sig, 'base64url');
    const pub = createPublicKey(loaded.key);
    expect(verify(null, message, pub, sig)).toBe(true);
    expect(verify(null, bytes, pub, sig)).toBe(false);
  });

  it('fails for a flipped byte, for another key and for a revoked or unknown key id', async () => {
    const sig = signBytes('zip', bytes, loaded.key, 'k1');
    const flipped = bytes.slice();
    flipped[3] = (flipped[3] as number) ^ 1;
    await expect(verifySignature('zip', flipped, sig, ringOf(key))).rejects.toMatchObject({ code: 'bad_signature' });
    const other = generateSigningKey('k1', PASS);
    await expect(verifySignature('zip', bytes, sig, ringOf(other))).rejects.toMatchObject({ code: 'bad_signature' });
    await expect(verifySignature('zip', bytes, sig, [{ id: 'k9', publicKey: key.publicKey }])).rejects.toMatchObject({ code: 'unknown_key' });
  });

  it('only a zip or an index is signed: a submission or a report never is', () => {
    for (const kind of ['submission', 'report', 'terms', '']) expect(() => signBytes(kind as 'zip', bytes, loaded.key, 'k1')).toThrow(RangeError);
  });
});

describe('sign (the tool)', () => {
  let keyPath: string;
  let file: string;
  let pub: string;
  beforeEach(() => {
    const k = generateSigningKey('k1', PASS);
    pub = k.publicKey;
    keyPath = join(tw.dir, 'k1.pem');
    writeFileSync(keyPath, k.pem);
    file = join(tw.dir, 'terms-2026.12.0.zip');
    writeFileSync(file, bytes);
  });

  it('writes <file>.sig next to the file, and the kit verifies it', async () => {
    tw = makeToolWorld({ secrets: [PASS] });
    expect(await sign(['--kind', 'zip', '--file', file, '--key-id', 'k1', '--key', keyPath], tw.io)).toBe(0);
    const sig = readFileSync(`${file}.sig`, 'utf8');
    expect(await verifySignature('zip', new Uint8Array(readFileSync(file)), sig, [{ id: 'k1', publicKey: pub }])).toEqual({ keyId: 'k1' });
    expect(tw.out.join('\n')).toContain('signed');
    expect(tw.everything()).not.toContain(PASS);
  });

  it('signs an index with --kind index to --out, and the signature is not valid as a zip signature', async () => {
    tw = makeToolWorld({ secrets: [PASS] });
    const out = join(tw.dir, 'index.json.sig');
    expect(await sign(['--kind', 'index', '--file', file, '--key-id', 'k1', '--key', keyPath, '--out', out], tw.io)).toBe(0);
    await expect(verifySignature('zip', new Uint8Array(readFileSync(file)), readFileSync(out, 'utf8'), [{ id: 'k1', publicKey: pub }])).rejects.toMatchObject({ code: 'bad_signature' });
  });

  it('takes the key from a file named by an environment variable, or from the PEM text in one, and the passphrase from a named variable', async () => {
    const byPath = makeToolWorld({ secrets: [PASS], env: { CORPUS_SIGNING_KEY_FILE: keyPath } });
    expect(await sign(['--kind', 'zip', '--file', file, '--key-id', 'k1'], byPath.io)).toBe(0);
    const byPem = makeToolWorld({ env: { CORPUS_SIGNING_KEY: readFileSync(keyPath, 'utf8'), P: PASS } });
    expect(await sign(['--kind', 'zip', '--file', file, '--key-id', 'k1', '--passphrase-env', 'P', '--out', join(tw.dir, 'two.sig')], byPem.io)).toBe(0);
    expect(byPem.asked).toEqual([]);
    for (const w of [byPath, byPem]) {
      expect(w.everything()).not.toContain(PASS);
      expect(w.everything()).not.toMatch(/BEGIN|PRIVATE KEY/);
      w.cleanup();
    }
    expect(await verifySignature('zip', new Uint8Array(readFileSync(file)), readFileSync(join(tw.dir, 'two.sig'), 'utf8'), [{ id: 'k1', publicKey: pub }])).toEqual({ keyId: 'k1' });
  });

  it('with no key, a wrong passphrase, no terminal, a missing file or a bad kind: exit 1 and a fixed line that holds neither passphrase nor path nor key', async () => {
    const cases: [string[], ToolWorld][] = [
      [['--kind', 'zip', '--file', file, '--key-id', 'k1'], makeToolWorld({ secrets: [PASS] })], // no key given
      [['--kind', 'zip', '--file', file, '--key-id', 'k1', '--key', keyPath], makeToolWorld({ secrets: ['the wrong passphrase 42'] })],
      [['--kind', 'zip', '--file', file, '--key-id', 'k1', '--key', keyPath], makeToolWorld({ secrets: [] })],
      [['--kind', 'zip', '--file', join(tw.dir, 'missing.zip'), '--key-id', 'k1', '--key', keyPath], makeToolWorld({ secrets: [PASS] })],
      [['--kind', 'submission', '--file', file, '--key-id', 'k1', '--key', keyPath], makeToolWorld({ secrets: [PASS] })],
      [['--kind', 'zip', '--file', file, '--key-id', 'bad id', '--key', keyPath], makeToolWorld({ secrets: [PASS] })],
    ];
    for (const [argv, w] of cases) {
      expect(await sign(argv, w.io), argv.join(' ')).toBe(1);
      const text = w.everything();
      expect(text).not.toContain(PASS);
      expect(text).not.toContain('the wrong passphrase 42');
      expect(text).not.toContain(keyPath);
      expect(text).not.toMatch(/BEGIN|PRIVATE KEY/);
      expect(w.err.length).toBeGreaterThan(0);
      w.cleanup();
    }
    expect(existsSync(`${file}.sig`)).toBe(false);
  });

  it('signing twice gives the same file (Ed25519 is deterministic), so running it again is harmless', async () => {
    tw = makeToolWorld({ secrets: [PASS, PASS] });
    expect(await sign(['--kind', 'zip', '--file', file, '--key-id', 'k1', '--key', keyPath], tw.io)).toBe(0);
    const first = readFileSync(`${file}.sig`, 'utf8');
    expect(await sign(['--kind', 'zip', '--file', file, '--key-id', 'k1', '--key', keyPath], tw.io)).toBe(0);
    expect(readFileSync(`${file}.sig`, 'utf8')).toBe(first); // Ed25519 is deterministic, so the same input is the same signature
  });
});
