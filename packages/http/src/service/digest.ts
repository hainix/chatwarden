// SHA-256 and a constant-time comparison from the platform's Web Crypto: no `node:` import, so the service runs in any runtime that has `crypto.subtle`.

interface SubtleLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

const encoder = new TextEncoder();

/** The SHA-256 of `text` (UTF-8): 32 bytes. */
export async function sha256(text: string): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  if (subtle === undefined) throw new Error('service: this runtime has no Web Crypto');
  return new Uint8Array(await subtle.digest('SHA-256', encoder.encode(text)));
}

/** Bytes as lower-case hex. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** The SHA-256 of `text` as 64 hex characters. */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(await sha256(text));
}

/** Equal digests, in time that does not depend on where they differ. Different lengths are never equal. */
export function equalDigests(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
