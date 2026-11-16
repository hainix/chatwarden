import { createPublicKey, verify } from 'node:crypto';
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

/** The header Coop sends the signature in (the docs say the casing may vary). */
const SIGNATURE_HEADER = 'coop-signature';
/** The longest header value read: an RSA signature of a 4096 bit key is 684 base64 characters. */
const HEADER_MAX = 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/;
const TIME_RE = /^\d{1,20}$/;
/** How many `v1=` values of one header are tried. */
const V1_MAX = 3;

/** The signature header's value, whatever the casing of its name. Undefined when it is absent, not a string, empty or over-long. */
function signatureHeader(headers: Readonly<Record<string, string | undefined>>): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== SIGNATURE_HEADER) continue;
    const value = headers[name];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length >= 1 && trimmed.length <= HEADER_MAX ? trimmed : undefined;
  }
  return undefined;
}

/** The signature bytes a text may stand for: base64 and, when it looks like hex, hex too. */
function candidates(text: string): Buffer[] {
  const out: Buffer[] = [];
  if (BASE64_RE.test(text)) out.push(Buffer.from(text, 'base64'));
  if (HEX_RE.test(text)) out.push(Buffer.from(text, 'hex'));
  return out;
}

/**
 * Check a Coop callback signature over the exact body. True only when `Coop-Signature` (any casing of the name) is the RSASSA-PKCS1-v1_5 / SHA-256 signature, in
 * base64, of `rawBody` under the public key `publicKeyPem` (K5 design 8.4 step 2). The docs' other shape, `t=<timestamp>,v1=<signature>`, is also accepted: `v1` must
 * verify over the body, or over `<t>.<body>` (UNVERIFIED which Coop 1.2.2 sends; the extra branch is the hedge). The scheme carries no usable time, so a replay is
 * made harmless by the idempotent decision, not by freshness. Never throws; every failure is false.
 */
export function verifyCoopSignature(publicKeyPem: string, headers: Readonly<Record<string, string | undefined>>, rawBody: string): boolean {
  try {
    if (typeof rawBody !== 'string') return false;
    const key = coopPublicKey(publicKeyPem);
    if (key === null) return false;
    const value = signatureHeader(headers);
    if (value === undefined) return false;
    const body = Buffer.from(rawBody, 'utf8');
    const check = (data: Buffer, signature: Buffer): boolean => {
      try {
        return signature.length > 0 && verify('sha256', data, key, signature);
      } catch {
        return false;
      }
    };
    if (!value.startsWith('t=')) {
      // The plain shape is base64 only.
      return BASE64_RE.test(value) && check(body, Buffer.from(value, 'base64'));
    }
    let t: string | undefined;
    const v1: string[] = [];
    for (const part of value.split(',')) {
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k === 't' && t === undefined) t = v;
      else if (k === 'v1' && v1.length < V1_MAX) v1.push(v);
    }
    if (t === undefined || !TIME_RE.test(t)) return false;
    const timed = Buffer.from(`${t}.${rawBody}`, 'utf8');
    return v1.some((v) => candidates(v).some((sig) => check(body, sig) || check(timed, sig)));
  } catch {
    return false;
  }
}
