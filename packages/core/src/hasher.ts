// Identity hashing. HMAC-SHA256 over `${kind}:${input}`, first 32 hex characters,
// byte-compatible with Moxgate's identity hasher. The internal kind strings
// 'playerKey' and 'ipHash' are Moxgate's and must not change, or existing
// hashes stop matching.
import { createHmac } from 'node:crypto';
import type { Hasher, Identifiers, RawWho } from './types.js';

// 128 bits of the HMAC: plenty to avoid collisions, short enough to index.
const HASH_HEX_LEN = 32;

/** Build a {@link Hasher} keyed with `secret`. Throws on an empty secret. */
export function makeHasher(secret: string): Hasher {
  if (!secret) throw new Error('makeHasher: secret must be non-empty');
  // The kind prefix keeps the two spaces apart: a client key that happened to
  // equal an IP string must not produce the same value in both columns.
  const mac = (kind: string, input: string): string =>
    createHmac('sha256', secret).update(`${kind}:${input}`).digest('hex').slice(0, HASH_HEX_LEN);
  return {
    clientKey: (raw) => mac('playerKey', raw),
    ip: (raw) => mac('ipHash', raw),
  };
}

/**
 * Turn what the adopter knows about a speaker into storable {@link Identifiers}.
 * An empty or missing value becomes null, and the IP `'unknown'` (which would
 * tie every address-less caller together) becomes null. The account id is
 * returned as given and is never hashed.
 */
export function hashWho(h: Hasher, who: RawWho): Identifiers {
  return {
    clientKey: who.clientKey ? h.clientKey(who.clientKey) : null,
    accountId: who.accountId || null,
    ipHash: who.ip && who.ip !== 'unknown' ? h.ip(who.ip) : null,
  };
}
