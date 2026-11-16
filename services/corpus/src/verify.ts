import { signedMessage } from '@chatwarden/matcher/corpus';
import { b64uDecode, hex } from './b64.js';

// Who signed a request. An installation is a random Ed25519 key that identifies a server process's file, not a person (design 10.2). The
// signature covers `signedMessage(kind, bytes)`: the kind separates a submission from a report, so one cannot be replayed as the other.

const KEY_BYTES = 32;
const SIG_BYTES = 64;
const encoder = new TextEncoder();

export type Auth = { ok: true; installation: string } | { ok: false };

/** sha256 of the raw public key, hex: the name the service files an installation under. */
export async function installationId(rawKey: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', rawKey)));
}

/**
 * Checks the `x-cw-key` and `x-cw-sig` headers against `bytes` as a `kind`. Never throws: a missing, malformed or wrong signature is `{ ok: false }`.
 * The key must be exactly 32 bytes of canonical base64url and the signature exactly 64.
 */
export async function authenticate(headers: Headers, kind: 'submission' | 'report', bytes: Uint8Array): Promise<Auth> {
  try {
    const raw = b64uDecode(headers.get('x-cw-key'), KEY_BYTES);
    const sig = b64uDecode(headers.get('x-cw-sig'), SIG_BYTES);
    if (raw === null || sig === null) return { ok: false };
    const key = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify']);
    if (!(await crypto.subtle.verify('Ed25519', key, sig, signedMessage(kind, bytes)))) return { ok: false };
    return { ok: true, installation: await installationId(raw) };
  } catch {
    return { ok: false };
  }
}

/** The bytes a status request signs: the id, as UTF-8. */
export const idBytes = (id: string): Uint8Array => encoder.encode(id);
