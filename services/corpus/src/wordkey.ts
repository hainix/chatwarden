import { collapseLikePreset, foldTerm } from '@chatwarden/matcher';

// The word key: the one rule by which two spellings are one word. It is the kit's own (`loadTermPack` dedupes a pack by
// `collapseLikePreset(foldTerm(term))`, and so does the release builder), so a row the service keeps once is a row the kit reads once.

/** The languages the corpus serves in this release (design 13). Tags are the base tags; `pt-BR` and `pt-PT` are `pt`. */
export const SUPPORTED_LANGUAGES: readonly string[] = Object.freeze(['en', 'es', 'pt']);

/** A term is at most this many characters as written (design 6.6), and at least {@link MIN_KEY_LENGTH} once repeated letters collapse. */
export const MAX_TERM_LENGTH = 40;
export const MIN_KEY_LENGTH = 3;

/** The key of a word: accents off, lower case, repeated letters cut as the matcher reads them. The empty string for anything that is not a string. */
export function wordKey(term: string): string {
  if (typeof term !== 'string') return '';
  return collapseLikePreset(foldTerm(term));
}

/**
 * One word of plain letters as the person wrote it (accents allowed), or null. The same rule the share client applies before it sends:
 * letters and combining marks only, 40 characters at most, plain `a-z` once folded, and three letters or more once repeats collapse.
 * No trimming: a word with spaces around it is not what the client sends.
 */
export function plainWord(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_TERM_LENGTH) return null;
  if (!/^\p{L}[\p{L}\p{M}]*$/u.test(v)) return null;
  const folded = foldTerm(v);
  if (!/^[a-z]+$/.test(folded) || collapseLikePreset(folded).length < MIN_KEY_LENGTH) return null;
  return v;
}
