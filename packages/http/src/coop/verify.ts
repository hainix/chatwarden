import { createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// Coop signs every callback with an RSA key (K5 design 4.1 and 8.4); the kit holds the public half. This file builds that key object once per PEM.

/** The longest PEM accepted: a 4096 bit public key is under 1 000 characters. */
const PEM_MAX = 8192;
/** Keys built so far, by PEM text. An adopter has one key; the bound is only a guard. */
const KEYS_MAX = 8;
const keys = new Map<string, KeyObject>();

/**
 * The RSA public key object for a PEM (a SubjectPublicKeyInfo or PKCS#1 public key), built once per PEM. Null for anything else: not a string, too long,
 * a private key (only the public half belongs in a config), a key that does not parse, or a key that is not RSA. Never throws.
 */
export function coopPublicKey(pem: unknown): KeyObject | null {
  if (typeof pem !== 'string' || pem.length === 0 || pem.length > PEM_MAX) return null;
  const held = keys.get(pem);
  if (held !== undefined) return held;
  if (/PRIVATE/i.test(pem)) return null;
  try {
    const key = createPublicKey(pem);
    if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa') return null;
    if (keys.size >= KEYS_MAX) {
      const oldest = keys.keys().next();
      if (oldest.done !== true) keys.delete(oldest.value);
    }
    keys.set(pem, key);
    return key;
  } catch {
    return null;
  }
}
