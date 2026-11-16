import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORPUS_BASE_URL,
  CORPUS_KEYS,
  CORPUS_REVOKED_KEY_IDS,
  CORPUS_ZIP_PASSWORD,
  CorpusError,
  signedMessage,
  verifySignature,
  type CorpusKey,
} from '../src/corpus/index.js';
import { b64u, fromB64u, makeKey, messageFor, sigFileBytes, sigFileFor, type TestKey } from './corpus-world.js';

const enc = new TextEncoder();
const BYTES = enc.encode('{"schema":"chatwarden-corpus-index/1","note":"invented words only: zorbak"}');
const asKey = (k: TestKey): CorpusKey => ({ id: k.id, publicKey: k.publicKey });

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** The last character of an 86-character signature carries 4 spare bits; flipping the lowest gives text that decodes to the same 64 bytes. */
const spareBitFlipped = (c: string): string => ALPHABET[ALPHABET.indexOf(c) ^ 1] as string;

async function fails(promise: Promise<unknown>): Promise<CorpusError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(CorpusError);
    return e as CorpusError;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.doUnmock('../src/corpus/keys.js');
  vi.resetModules();
});

describe('the constants', () => {
  it('ship no keys until the owner adds them: an empty frozen list, an empty frozen revoked list, the documented base URL and password', () => {
    expect(CORPUS_KEYS).toEqual([]);
    expect(Object.isFrozen(CORPUS_KEYS)).toBe(true);
    expect(CORPUS_REVOKED_KEY_IDS).toEqual([]);
    expect(Object.isFrozen(CORPUS_REVOKED_KEY_IDS)).toBe(true);
    expect(CORPUS_BASE_URL).toBe('https://releases.chatwarden.dev/v1');
    expect(CORPUS_ZIP_PASSWORD).toBe('chatwarden-terms');
  });
});

describe('signedMessage', () => {
  it('signedMessage: prefix, separators and kind are exactly as specified; different kinds give different bytes', () => {
    const body = new Uint8Array([1, 2, 3]);
    const m = signedMessage('zip', body);
    const expected = new Uint8Array([...enc.encode('chatwarden-corpus/1'), 0, ...enc.encode('zip'), 0, 1, 2, 3]);
    expect([...m]).toEqual([...expected]);
    expect([...m]).toEqual([...messageFor('zip', body)]);
    const seen = new Set((['index', 'zip', 'submission'] as const).map((k) => Buffer.from(signedMessage(k, body)).toString('hex')));
    expect(seen.size).toBe(3);
    // an empty body is the two separators and nothing else; the input is copied, not aliased
    expect([...signedMessage('index', new Uint8Array(0))]).toEqual([...enc.encode('chatwarden-corpus/1'), 0, ...enc.encode('index'), 0]);
    body[0] = 9;
    expect(m[m.length - 3]).toBe(1);
  });

  it('a kind outside the three, or bytes that are not bytes, is a programming error (RangeError / TypeError), never a signed message', () => {
    expect(() => signedMessage('terms' as 'zip', BYTES)).toThrow(RangeError);
    expect(() => signedMessage('zip\u0000index' as 'zip', BYTES)).toThrow(RangeError);
    expect(() => signedMessage('zip', 'text' as unknown as Uint8Array)).toThrow(TypeError);
  });
});

describe('verifySignature', () => {
  it('verifySignature: a valid signature verifies for its kind and fails for the other two kinds', async () => {
    const k1 = await makeKey('k1');
    const keys = [asKey(k1)];
    const zipSig = await sigFileFor(k1, 'zip', BYTES);
    expect(await verifySignature('zip', BYTES, zipSig, keys)).toEqual({ keyId: 'k1' });
    expect((await fails(verifySignature('index', BYTES, zipSig, keys))).code).toBe('bad_signature');
    // the third kind: the same signature over the 'submission' message does not verify either
    const pub = await webcrypto.subtle.importKey('raw', fromB64u(k1.publicKey), 'Ed25519', false, ['verify']);
    expect(await webcrypto.subtle.verify('Ed25519', pub, fromB64u(zipSig.sig), signedMessage('submission', BYTES))).toBe(false);
    expect(await webcrypto.subtle.verify('Ed25519', pub, fromB64u(zipSig.sig), signedMessage('zip', BYTES))).toBe(true);
    // and the other way round: an index signature is no zip signature, a submission signature is neither
    const indexSig = await sigFileFor(k1, 'index', BYTES);
    expect(await verifySignature('index', BYTES, indexSig, keys)).toEqual({ keyId: 'k1' });
    expect((await fails(verifySignature('zip', BYTES, indexSig, keys))).code).toBe('bad_signature');
    const submissionSig = { ...zipSig, sig: b64u(await k1.sign('submission', BYTES)) };
    expect((await fails(verifySignature('index', BYTES, submissionSig, keys))).code).toBe('bad_signature');
    expect((await fails(verifySignature('zip', BYTES, submissionSig, keys))).code).toBe('bad_signature');
    // a signature over the bare bytes (no prefix, no kind) is refused for both
    const bare = { ...zipSig, sig: b64u(await k1.signBare(BYTES)) };
    expect((await fails(verifySignature('index', BYTES, bare, keys))).code).toBe('bad_signature');
    expect((await fails(verifySignature('zip', BYTES, bare, keys))).code).toBe('bad_signature');
  });

  it('verifySignature: one flipped bit in the bytes, the signature or the key id fails', async () => {
    const k1 = await makeKey('k1');
    const k2 = await makeKey('k2');
    const keys = [asKey(k1), asKey(k2)];
    const good = await sigFileFor(k1, 'zip', BYTES);
    expect(await verifySignature('zip', BYTES, good, keys)).toEqual({ keyId: 'k1' });
    // every single bit of a small body, one at a time
    const small = enc.encode('abc');
    const smallSig = await sigFileFor(k1, 'zip', small);
    for (let i = 0; i < small.length * 8; i += 1) {
      const flipped = small.slice();
      flipped[i >> 3] = (flipped[i >> 3] as number) ^ (1 << (i & 7));
      expect((await fails(verifySignature('zip', flipped, smallSig, keys))).code, `bit ${i}`).toBe('bad_signature');
    }
    // a signature bit (first, middle, last)
    const sig = fromB64u(good.sig);
    for (const bit of [0, 255, 511]) {
      const s = sig.slice();
      s[bit >> 3] = (s[bit >> 3] as number) ^ (1 << (bit & 7));
      expect((await fails(verifySignature('zip', BYTES, { ...good, sig: b64u(s) }, keys))).code, `sig bit ${bit}`).toBe('bad_signature');
    }
    // the key id: flipped to a key that exists (so the other key checks and fails), and to ones that do not
    expect((await fails(verifySignature('zip', BYTES, { ...good, keyId: 'k2' }, keys))).code).toBe('bad_signature');
    expect((await fails(verifySignature('zip', BYTES, { ...good, keyId: 'k3' }, keys))).code).toBe('unknown_key');
    expect((await fails(verifySignature('zip', BYTES, { ...good, keyId: 'K1' }, keys))).code).toBe('unknown_key');
    // control: empty bytes still sign and verify
    const none = await sigFileFor(k1, 'zip', new Uint8Array(0));
    expect(await verifySignature('zip', new Uint8Array(0), none, keys)).toEqual({ keyId: 'k1' });
  });

  it('a wrong key, an unknown key id, a revoked key id fail with their own codes', async () => {
    const k1 = await makeKey('k1');
    const imposter = await makeKey('k1');
    const k2 = await makeKey('k2');
    const keys = [asKey(k1), asKey(k2)];
    // a different key under a trusted id: bad_signature
    expect((await fails(verifySignature('zip', BYTES, await sigFileFor(imposter, 'zip', BYTES), keys))).code).toBe('bad_signature');
    // an id the keyring has never held
    const stranger = await makeKey('k9');
    expect((await fails(verifySignature('zip', BYTES, await sigFileFor(stranger, 'zip', BYTES), keys))).code).toBe('unknown_key');
    // revoked by the caller (an index that verified under another key), though the key is in the keyring and the signature is good
    const good = await sigFileFor(k2, 'zip', BYTES);
    expect((await fails(verifySignature('zip', BYTES, good, keys, { revokedKeyIds: ['k2'] }))).code).toBe('revoked_key');
    expect(await verifySignature('zip', BYTES, good, keys, { revokedKeyIds: ['k1'] })).toEqual({ keyId: 'k2' });
    // revoked and also gone from the keyring: still revoked_key, the more useful answer
    expect((await fails(verifySignature('zip', BYTES, good, [asKey(k1)], { revokedKeyIds: ['k2'] }))).code).toBe('revoked_key');
    // a revoked list that is not a list of strings is ignored, never a throw
    expect(await verifySignature('zip', BYTES, good, keys, { revokedKeyIds: 'k2' as unknown as string[] })).toEqual({ keyId: 'k2' });
  });

  it('a key id the kit itself revokes (CORPUS_REVOKED_KEY_IDS) is revoked_key whatever the index says', async () => {
    const k1 = await makeKey('k1');
    vi.resetModules();
    vi.doMock('../src/corpus/keys.js', async (original) => ({
      ...(await original<typeof import('../src/corpus/keys.js')>()),
      CORPUS_REVOKED_KEY_IDS: Object.freeze(['k1']),
    }));
    const fresh = await import('../src/corpus/sign.js');
    const err = await fresh.verifySignature('zip', BYTES, await sigFileFor(k1, 'zip', BYTES), [asKey(k1)]).then(
      () => null,
      (e: unknown) => e as CorpusError,
    );
    expect(err?.code).toBe('revoked_key');
    expect(err?.stage).toBe('verify');
  });

  it('verifySignature: alg other than Ed25519, a 63-byte and a 65-byte signature, non-base64url text, null, an array, a getter that throws, a proxy: CorpusError and nothing else', async () => {
    const k1 = await makeKey('k1');
    const keys = [asKey(k1)];
    const good = await sigFileFor(k1, 'zip', BYTES);
    const sig = fromB64u(good.sig);
    const throwing = { schema: good.schema, alg: good.alg, keyId: 'k1' };
    Object.defineProperty(throwing, 'sig', {
      enumerable: true,
      get: () => {
        throw new Error('zorbak getter');
      },
    });
    const trap = (): never => {
      throw new Error('vlemmo trap');
    };
    const hostileProxy = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
    const std = Buffer.from(sig).toString('base64');
    const cases: Array<[string, unknown]> = [
      ['alg RS256', { ...good, alg: 'RS256' }],
      ['alg lower case', { ...good, alg: 'ed25519' }],
      ['alg missing', { ...good, alg: undefined }],
      ['alg a number', { ...good, alg: 25519 }],
      ['schema other', { ...good, schema: 'chatwarden-corpus-sig/2' }],
      ['schema missing', { ...good, schema: undefined }],
      ['63-byte signature', { ...good, sig: b64u(sig.slice(0, 63)) }],
      ['65-byte signature', { ...good, sig: b64u(new Uint8Array([...sig, 0])) }],
      ['empty signature', { ...good, sig: '' }],
      ['standard base64 with padding', { ...good, sig: std }],
      ['padded base64url', { ...good, sig: `${good.sig}==` }],
      ['text outside the alphabet', { ...good, sig: `${good.sig.slice(0, 80)}!!!!!!` }],
      ['spaces in the signature', { ...good, sig: ` ${good.sig}` }],
      ['sig a number', { ...good, sig: 7 }],
      ['sig an array', { ...good, sig: [...sig] }],
      ['keyId a number', { ...good, keyId: 1 }],
      ['keyId empty', { ...good, keyId: '' }],
      ['keyId 10 000 characters', { ...good, keyId: 'k'.repeat(10_000) }],
      ['non-canonical base64url (spare bits set)', { ...good, sig: `${good.sig.slice(0, -1)}${spareBitFlipped(good.sig.slice(-1))}` }],
      ['null', null],
      ['undefined', undefined],
      ['an array', [good]],
      ['an empty array', []],
      ['a number', 42],
      ['true', true],
      ['a string that is not JSON', 'zorbak'],
      ['a function', () => good],
      ['an object with a throwing getter', throwing],
      ['a proxy that throws on every trap', hostileProxy],
      ['a Uint8Array of garbage', new Uint8Array([0xff, 0xfe, 0, 1, 2])],
      ['a Uint8Array of an empty object', enc.encode('{}')],
      ['JSON text of an array', JSON.stringify([good])],
      ['an object with no prototype and no keys', Object.create(null)],
      ['a symbol-keyed object', { [Symbol('x')]: 1 }],
    ];
    for (const [name, input] of cases) {
      const err = await fails(verifySignature('zip', BYTES, input, keys));
      expect(['bad_signature', 'unknown_key'], name).toContain(err.code);
      expect(err.stage, name).toBe('verify');
      expect(err.message, name).not.toMatch(/zorbak|vlemmo/);
    }
    // a proxy over a valid file is read once per field: it cannot show the check one value and the verify another
    const reads: Record<string, number> = {};
    const counting = new Proxy({ ...good }, { get: (t, p) => ((reads[String(p)] = (reads[String(p)] ?? 0) + 1), (t as Record<string | symbol, unknown>)[p]) });
    expect(await verifySignature('zip', BYTES, counting, keys)).toEqual({ keyId: 'k1' });
    expect(Object.values(reads).every((n) => n === 1)).toBe(true);
    // bytes that are not bytes, a kind that is not a kind, a key list that is not a list: still a CorpusError
    for (const bytes of [null, undefined, 'text', 12, [1, 2, 3], {}]) {
      expect((await fails(verifySignature('zip', bytes as unknown as Uint8Array, good, keys))).code).toBe('bad_signature');
    }
    expect((await fails(verifySignature('terms' as 'zip', BYTES, good, keys))).code).toBe('bad_signature');
    expect((await fails(verifySignature('zip', BYTES, good, 'k1' as unknown as CorpusKey[]))).code).toBe('no_trusted_keys');
    // the same signature as bytes or as JSON text (the seed's form) verifies; text over 1 KiB is refused unread
    expect(await verifySignature('zip', BYTES, sigFileBytes(good), keys)).toEqual({ keyId: 'k1' });
    expect(await verifySignature('zip', BYTES, JSON.stringify(good), keys)).toEqual({ keyId: 'k1' });
    expect((await fails(verifySignature('zip', BYTES, ' '.repeat(2048) + JSON.stringify(good), keys))).code).toBe('bad_signature');
    // a view over a bigger buffer (a subarray) is read as the view, not the buffer
    const padded = new Uint8Array(BYTES.length + 10);
    padded.set(BYTES, 5);
    expect(await verifySignature('zip', padded.subarray(5, 5 + BYTES.length), good, keys)).toEqual({ keyId: 'k1' });
  });

  it('a key entry that is malformed is skipped, not a throw: the next one is tried; if none works, bad_signature', async () => {
    const k1 = await makeKey('k1');
    const good = await sigFileFor(k1, 'zip', BYTES);
    const junk: CorpusKey[] = [
      { id: 'k1', publicKey: 'AAAA' },
      { id: 'k1', publicKey: '!!!' },
      { id: 'k1', publicKey: 12 as unknown as string },
      null as unknown as CorpusKey,
      { id: 'k1', publicKey: b64u(new Uint8Array(33)) },
    ];
    expect((await fails(verifySignature('zip', BYTES, good, junk))).code).toBe('bad_signature');
    expect(await verifySignature('zip', BYTES, good, [...junk, asKey(k1)])).toEqual({ keyId: 'k1' });
  });

  it('verifySignature: an empty key list is no_trusted_keys; the first of two keys that matches wins; the second is tried when the first does not match', async () => {
    const k1 = await makeKey('k1');
    const k2 = await makeKey('k2');
    const good1 = await sigFileFor(k1, 'zip', BYTES);
    const good2 = await sigFileFor(k2, 'zip', BYTES);
    // no keys (the default list is empty): nothing to trust, and that wins over a bad signature file
    expect((await fails(verifySignature('zip', BYTES, good1, []))).code).toBe('no_trusted_keys');
    expect((await fails(verifySignature('zip', BYTES, good1))).code).toBe('no_trusted_keys');
    expect((await fails(verifySignature('zip', BYTES, null, []))).code).toBe('no_trusted_keys');
    // two keys: each signature picks its own
    const keys = [asKey(k1), asKey(k2)];
    expect(await verifySignature('zip', BYTES, good1, keys)).toEqual({ keyId: 'k1' });
    expect(await verifySignature('zip', BYTES, good2, keys)).toEqual({ keyId: 'k2' });
    // two entries under one id (a re-keyed id during rotation): the first that matches wins, the second is tried when the first does not
    const twin = [
      { id: 'k1', publicKey: k1.publicKey },
      { id: 'k1', publicKey: k2.publicKey },
    ];
    expect(await verifySignature('zip', BYTES, good1, twin)).toEqual({ keyId: 'k1' });
    expect(await verifySignature('zip', BYTES, { ...good2, keyId: 'k1' }, twin)).toEqual({ keyId: 'k1' });
    expect((await fails(verifySignature('zip', BYTES, { ...good2, keyId: 'k1' }, [twin[0] as CorpusKey]))).code).toBe('bad_signature');
  });
});

describe('CorpusError', () => {
  it('CorpusError: no message contains any string from the input', async () => {
    const words = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];
    const k1 = await makeKey('k1');
    const hostileBytes = enc.encode(words.join(' '));
    const inputs: unknown[] = [
      { schema: 'zorbak', alg: 'vlemmo', keyId: 'quissel', sig: 'drakkuun' },
      { schema: 'chatwarden-corpus-sig/1', alg: 'Ed25519', keyId: 'fenrisk', sig: 'tarvo' },
      { schema: 'chatwarden-corpus-sig/1', alg: 'Ed25519', keyId: 'k1', sig: 'snerp-glarn' },
      { schema: 'chatwarden-corpus-sig/1', alg: 'snerp', keyId: 'glarn', sig: b64u(new Uint8Array(64)) },
      words.join(' '),
      hostileBytes,
    ];
    const collected: string[] = [];
    for (const input of inputs) {
      for (const keys of [[asKey(k1)], []]) {
        const err = await fails(verifySignature('zip', hostileBytes, input, keys, { revokedKeyIds: ['quissel'] }));
        collected.push(err.message, String(err), err.code, err.stage, err.name, JSON.stringify(err), JSON.stringify(Object.getOwnPropertyNames(err)));
      }
    }
    for (const text of collected) for (const w of words) expect(text.toLowerCase(), text).not.toContain(w);
  });

  it('CorpusError: every code has one fixed, non-empty message that does not depend on the arguments, and a stage', () => {
    const codes = [
      'no_trusted_keys', 'offline', 'timeout', 'too_large', 'bad_index', 'unknown_key', 'revoked_key', 'bad_signature', 'rollback',
      'index_expired', 'no_such_version', 'revoked_release', 'kit_too_old', 'hash_mismatch', 'bad_zip', 'bad_manifest', 'bad_pack',
    ] as const;
    const messages = new Set<string>();
    for (const code of codes) {
      const a = new CorpusError(code, 'verify');
      const b = new CorpusError(code, 'unpack');
      expect(a.message.length).toBeGreaterThan(5);
      expect(a.message).toBe(b.message);
      expect(a.code).toBe(code);
      expect(a.stage).toBe('verify');
      expect(a.name).toBe('CorpusError');
      expect(a).toBeInstanceOf(Error);
      expect('cause' in a).toBe(false);
      messages.add(a.message);
    }
    expect(messages.size).toBe(codes.length);
  });
});

describe('in a vm context with only browser globals', () => {
  it('in a vm context with only browser globals, verifySignature works (WebCrypto only; no Buffer, no process)', async () => {
    const built = await build({
      entryPoints: [fileURLToPath(new URL('../src/corpus/index.ts', import.meta.url))],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'CW',
      platform: 'neutral',
      target: 'es2022',
      logLevel: 'silent',
    });
    const code = built.outputFiles[0]?.text ?? '';
    // the bundle names no Node builtin and no Node-only global
    expect(code).not.toMatch(/\bBuffer\b|\bprocess\b|\brequire\b|node:/);
    const k1 = await makeKey('k1');
    const good = await sigFileFor(k1, 'zip', BYTES);
    const context = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder });
    vm.runInContext(code, context);
    expect(vm.runInContext('typeof Buffer + typeof process + typeof require', context)).toBe('undefinedundefinedundefined');
    const script = `(async () => {
      const keys = [{ id: 'k1', publicKey: ${JSON.stringify(k1.publicKey)} }];
      const bytes = Uint8Array.from(${JSON.stringify([...BYTES])});
      const ok = await CW.verifySignature('zip', bytes, ${JSON.stringify(good)}, keys);
      bytes[0] ^= 1;
      let code = null;
      try { await CW.verifySignature('zip', bytes, ${JSON.stringify(good)}, keys); } catch (e) { code = e instanceof CW.CorpusError ? e.code : 'other'; }
      let empty = null;
      try { await CW.verifySignature('zip', bytes, ${JSON.stringify(good)}, []); } catch (e) { empty = e.code; }
      return JSON.stringify({ ok, code, empty });
    })()`;
    expect(JSON.parse((await vm.runInContext(script, context)) as string)).toEqual({ ok: { keyId: 'k1' }, code: 'bad_signature', empty: 'no_trusted_keys' });
    // bytes handed in from another realm (a host Uint8Array) are read as bytes too
    Object.assign(context, { hostBytes: BYTES });
    const cross = (await vm.runInContext(
      `(async () => { try { return JSON.stringify(await CW.verifySignature('zip', hostBytes, ${JSON.stringify(good)}, [{ id: 'k1', publicKey: ${JSON.stringify(k1.publicKey)} }])); } catch (e) { return 'err:' + e.code; } })()`,
      context,
    )) as string;
    expect(cross).toBe('{"keyId":"k1"}');
  });
});
