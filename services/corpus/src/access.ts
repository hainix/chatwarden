import { b64uToBytes } from './b64.js';
import type { Clock, LogEvent } from './deps.js';

// Cloudflare Access (design 10.3). `/admin/*` sits behind an Access application; Access adds a signed JWT in the `Cf-Access-Jwt-Assertion`
// header, and this module checks it the way Cloudflare's documentation says to: RS256 only, the key chosen by `kid` from the team's JWKS
// (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), the issuer equal to the team's origin, the audience equal to the application's
// tag, the times in range. The header, never the cookie. Any failure refuses (fail closed); the keys already held are used while the endpoint
// is down. Nothing here logs a token, a claim or an email.

export interface AccessConfig {
  /** The team's Access host, such as `example.cloudflareaccess.com`. */
  teamDomain: string;
  /** The application's audience tag. */
  aud: string;
  /** The network (default global `fetch`); the JWKS request is aborted after 5 seconds. */
  fetch?: typeof fetch;
}

export type AccessResult = { ok: true; email: string } | { ok: false };

export interface AccessVerifier {
  verify(token: string | null): Promise<AccessResult>;
}

const TOKEN_MAX = 8192;
const JWKS_MAX = 64 * 1024;
const JWKS_TTL_MS = 60 * 60 * 1000;
const KID_REFETCH_MS = 60 * 1000;
const TIMEOUT_MS = 5000;
const TEAM_RE = /^[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/;

const decoder = new TextDecoder('utf-8', { fatal: true });

/** The public half of an RSA key as a JWK, and the key WebCrypto makes of it. */
interface Jwk {
  kty: 'RSA';
  n: string;
  e: string;
  alg: 'RS256';
  ext: true;
}
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function jsonPart(part: string): Record<string, unknown> | null {
  const bytes = b64uToBytes(part);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Builds the verifier. Throws a `RangeError` naming the option for a configuration that cannot work. */
export function createAccessVerifier(config: AccessConfig, clock: Clock, log?: (event: LogEvent) => void): AccessVerifier {
  if (typeof config.teamDomain !== 'string' || !TEAM_RE.test(config.teamDomain)) throw new RangeError('createAccessVerifier: teamDomain must be a cloudflareaccess.com host');
  if (typeof config.aud !== 'string' || config.aud.length === 0) throw new RangeError('createAccessVerifier: aud is required');
  const issuer = `https://${config.teamDomain}`;
  const aud = config.aud;
  const net = config.fetch ?? globalThis.fetch;

  let keys = new Map<string, Jwk>();
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let kidRefetchAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;
  const imported = new Map<string, Key>();

  const note = (code: string): void => {
    try {
      log?.({ stage: 'access', code });
    } catch {
      // a logger that throws must not break a request
    }
  };

  async function load(): Promise<void> {
    fetchedAt = clock.now();
    try {
      const res = await net(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', credentials: 'omit' });
      if (!res.ok) throw new Error('status');
      const text = await res.text();
      if (text.length > JWKS_MAX) throw new Error('size');
      const body: unknown = JSON.parse(text);
      const list = (body as { keys?: unknown } | null)?.keys;
      if (!Array.isArray(list)) throw new Error('shape');
      const next = new Map<string, Jwk>();
      for (const k of list as unknown[]) {
        const o = k as { kid?: unknown; kty?: unknown; n?: unknown; e?: unknown } | null;
        if (o !== null && typeof o === 'object' && o.kty === 'RSA' && typeof o.kid === 'string' && typeof o.n === 'string' && typeof o.e === 'string') {
          next.set(o.kid, { kty: 'RSA', n: o.n, e: o.e, alg: 'RS256', ext: true });
        }
      }
      if (next.size === 0) throw new Error('empty');
      keys = next;
      imported.clear();
    } catch {
      // Keep the keys we hold, and try again in a minute rather than in an hour.
      fetchedAt = clock.now() - JWKS_TTL_MS + KID_REFETCH_MS;
      note('jwks');
    }
  }

  /** One fetch at a time; everyone waiting shares it. */
  function refresh(): Promise<void> {
    inflight ??= load().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function keyFor(kid: string): Promise<Key | null> {
    const now = clock.now();
    if (now - fetchedAt >= JWKS_TTL_MS) await refresh();
    if (!keys.has(kid) && now - kidRefetchAt >= KID_REFETCH_MS) {
      // A kid we do not know: Access may have rotated its keys. Look once a minute at most, so a stream of guesses costs nothing.
      kidRefetchAt = now;
      await refresh();
    }
    const cached = imported.get(kid);
    if (cached !== undefined) return cached;
    const jwk = keys.get(kid);
    if (jwk === undefined) return null;
    try {
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      imported.set(kid, key);
      return key;
    } catch {
      return null;
    }
  }

  async function verifyInner(token: string | null): Promise<AccessResult> {
    if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX) return { ok: false };
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) return { ok: false };
    const [h, p, s] = parts as [string, string, string];
    const header = jsonPart(h);
    if (header === null || header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) return { ok: false };
    const signature = b64uToBytes(s);
    if (signature === null) return { ok: false };
    const key = await keyFor(header.kid);
    if (key === null) return { ok: false };
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${h}.${p}`)))) return { ok: false };

    // Only now are the claims believed.
    const claims = jsonPart(p);
    if (claims === null || claims.iss !== issuer) return { ok: false };
    const audience = claims.aud;
    if (!(audience === aud || (Array.isArray(audience) && audience.includes(aud)))) return { ok: false };
    const now = Math.floor(clock.now() / 1000);
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now) return { ok: false };
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now)) return { ok: false };
    if (typeof claims.email !== 'string') return { ok: false };
    const email = claims.email.trim().toLowerCase();
    return email.length === 0 || email.length > 254 ? { ok: false } : { ok: true, email };
  }

  return {
    async verify(token) {
      try {
        return await verifyInner(token);
      } catch {
        return { ok: false };
      }
    },
  };
}
