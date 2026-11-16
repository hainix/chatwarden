import { webcrypto } from 'node:crypto';
import type { AccessConfig } from '../src/access.js';
import type { Clock } from '../src/deps.js';

// A fake Cloudflare Access for tests: an RSA key pair generated at run time (nothing here is a real key), a JWKS endpoint behind an injected
// fetch that counts its calls, and a token builder that can break each claim in turn.

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const b64u = (bytes: Uint8Array | string): string => Buffer.from(typeof bytes === 'string' ? enc.encode(bytes) : bytes).toString('base64url');

export const TEAM = 'chatwarden-test.cloudflareaccess.com';
export const AUD = 'aud-tag-0123456789abcdef';

export interface AccessKey {
  kid: string;
  pair: webcrypto.CryptoKeyPair;
  jwk: webcrypto.JsonWebKey & { kid: string };
}

export async function makeRsaKey(kid: string): Promise<AccessKey> {
  const pair = (await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  return { kid, pair, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

export interface TokenOptions {
  /** Claims to set; `undefined` removes the claim. */
  claims?: Record<string, unknown>;
  /** The key to sign with (default: the first key). */
  key?: AccessKey;
  /** The header's kid, alg and any extra fields. */
  header?: Record<string, unknown>;
  /** Replace the signature with these bytes (base64url text). */
  signature?: string;
}

export interface FakeAccess {
  config: AccessConfig;
  keys: AccessKey[];
  /** The URLs the verifier fetched, in order. */
  calls: string[];
  /** Makes the JWKS endpoint fail. */
  failing: boolean;
  /** What the endpoint serves (default: the public halves of `keys`). */
  serve: { keys: unknown[] } | null;
  token(options?: TokenOptions): Promise<string>;
}

export async function makeAccess(clock: Clock, keys?: AccessKey[]): Promise<FakeAccess> {
  const ring = keys ?? [await makeRsaKey('kid-one')];
  const calls: string[] = [];
  const state = {
    config: undefined as unknown as AccessConfig,
    keys: ring,
    calls,
    failing: false,
    serve: null as { keys: unknown[] } | null,
    async token(options: TokenOptions = {}): Promise<string> {
      const key = options.key ?? state.keys[0];
      if (key === undefined) throw new Error('no key');
      const now = Math.floor(clock.now() / 1000);
      const claims: Record<string, unknown> = { iss: `https://${TEAM}`, aud: [AUD], email: 'alice@example.test', sub: 'user-1', type: 'app', iat: now, nbf: now - 10, exp: now + 3600, ...options.claims };
      for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
      const header = { alg: 'RS256', kid: key.kid, typ: 'JWT', ...options.header };
      const head = b64u(JSON.stringify(header));
      const body = b64u(JSON.stringify(claims));
      const sig = options.signature ?? b64u(new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', key.pair.privateKey, enc.encode(`${head}.${body}`))));
      return `${head}.${body}.${sig}`;
    },
  };
  state.config = {
    teamDomain: TEAM,
    aud: AUD,
    fetch: ((url: string) => {
      calls.push(String(url));
      if (state.failing) return Promise.reject(new Error('network down'));
      return Promise.resolve(new Response(JSON.stringify(state.serve ?? { keys: state.keys.map((k) => k.jwk) }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }) as typeof fetch,
  };
  return state;
}
