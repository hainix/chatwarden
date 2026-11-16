// Base64url without padding, strict: the alphabet only, the exact length for the byte count, and the one canonical spelling of the bytes.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64uEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += ALPHABET.charAt(n >> 18) + ALPHABET.charAt((n >> 12) & 63) + ALPHABET.charAt((n >> 6) & 63) + ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += ALPHABET.charAt(n >> 18) + ALPHABET.charAt((n >> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += ALPHABET.charAt(n >> 18) + ALPHABET.charAt((n >> 12) & 63) + ALPHABET.charAt((n >> 6) & 63);
  }
  return out;
}

/** The `length` bytes that `text` spells, or null for anything else (padding, another alphabet, a wrong length, a non-canonical tail). */
export function b64uDecode(text: unknown, length: number): Uint8Array | null {
  if (typeof text !== 'string' || text.length !== Math.ceil((length * 4) / 3) || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const standard = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(standard);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out.length === length && b64uEncode(out) === text ? out : null;
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
