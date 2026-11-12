// Randomness for the chat code, from the platform's `crypto.getRandomValues` (a browser and Node 19+ both have it). No `node:` import.

function bytesOf(length: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues === undefined) throw new Error('chat: this runtime has no crypto.getRandomValues');
  return c.getRandomValues(new Uint8Array(length));
}

/** `bytes` random bytes as lower-case hex. */
export function randomHex(bytes: number): string {
  let out = '';
  for (const b of bytesOf(bytes)) out += b.toString(16).padStart(2, '0');
  return out;
}

const REF_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A random token of `length` characters from `a-z0-9`. */
export function randomToken(length: number): string {
  let out = '';
  for (const b of bytesOf(length)) out += REF_ALPHABET.charAt(b % REF_ALPHABET.length);
  return out;
}
