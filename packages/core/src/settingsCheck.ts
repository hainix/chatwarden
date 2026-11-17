import { normalizeStatement, statementLength } from './appeals.js';
import { ProfileError } from './profileError.js';

// Small checks shared by the settings sections of this release (desk, safety, rooms) and the reporting evidence link. Each throws
// ProfileError with the path and never echoes the value.

export function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** An own, defined value: a key left out, `undefined` and an inherited property all read as "not given". */
export function given(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** `o` must be a plain object with no key outside `allowed`; a refusal names the key. */
export function plain(o: unknown, allowed: readonly string[], path: string, what = 'must be an object'): Record<string, unknown> {
  if (!isPlain(o)) throw new ProfileError(path, what);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ProfileError(`${path}.${k}`, 'is not a known setting');
  return o;
}

export function wholeIn(v: unknown, lo: number, hi: number, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < lo || v > hi) throw new ProfileError(path, `must be a whole number from ${lo} to ${hi}`);
  return v;
}

export function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new ProfileError(path, 'must be true or false');
  return v;
}

/**
 * A text of `min` to `max` code points once cleaned (control, bidi and zero-width characters, NUL and lone surrogates removed, as for an
 * appeal statement). `oneLine` turns the newlines that remain into spaces. Returns the cleaned text.
 */
export function cleanText(v: unknown, path: string, min: 0 | 1, max: number, oneLine: boolean): string {
  const fail = (): never => {
    throw new ProfileError(path, min === 1 ? `must be text of 1 to ${max} characters` : `must be text of at most ${max} characters`);
  };
  // normalizeStatement answers '' for a raw text past its own cap (20 000 units), so a longer one is refused here as too long.
  if (typeof v !== 'string' || v.length > 20_000) return fail();
  const cleaned = normalizeStatement(v);
  const text = oneLine ? cleaned.replace(/\s*\n\s*/g, ' ') : cleaned;
  if (statementLength(text) > max || (min === 1 && text === '')) return fail();
  return text;
}

const URL_CHARS_BAD = /[\p{Cc}\s]/u;

/**
 * An https link target as written (never trimmed: a space anywhere refuses it): the literal scheme `https://`, a host, no credentials, no whitespace or control
 * characters, at most `max` characters. `placeholder` (`{ref}`) must then occur exactly that many times (0 or 1), never in the host.
 */
export function httpsUrl(v: unknown, path: string, max: number, placeholder = false): string {
  const fail = (reason: string): never => {
    throw new ProfileError(path, reason);
  };
  if (typeof v !== 'string') return fail(`must be an https link of at most ${max} characters`);
  const t = v;
  if (t === '' || t.length > max || URL_CHARS_BAD.test(t)) return fail(`must be an https link of at most ${max} characters with no spaces`);
  if (!/^https:\/\//i.test(t)) return fail('must start with https://');
  const authority = t.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority === '') return fail('must name a host');
  if (placeholder) {
    const count = t.split('{ref}').length - 1;
    if (count !== 1) return fail('must contain {ref} exactly once');
    if (authority.includes('{') || authority.includes('}')) return fail('must not put {ref} in the host');
  }
  let url: URL;
  try {
    url = new URL(placeholder ? t.replace('{ref}', 'x') : t);
  } catch {
    return fail('must be a valid https link');
  }
  if (url.protocol !== 'https:' || url.hostname === '') return fail('must be a valid https link');
  if (url.username !== '' || url.password !== '') return fail('must not hold a user name or password');
  return t;
}
