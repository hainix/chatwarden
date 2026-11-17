import { foldWord, letterCount } from './fold.js';

// Phrase rules: a list of patterns written in a fixed vocabulary (a word, `a|b` alternatives, `word*` a prefix, `*` one word of any
// kind, `~` zero to three words), never a regular expression. This file holds the grammar; matching is below it.

export const PATTERN_MAX_CHARS = 80;
export const PATTERN_MAX_TOKENS = 6;
export const PATTERN_MAX_SKIPS = 2;
export const PATTERN_MAX_ALTS = 8;
/** The first word of a pattern must hold at least this many letters: a two-letter word would match half of every language. */
export const PATTERN_MIN_FIRST_LETTERS = 3;

/** One alternative of a word token: the folded word, and whether it is a prefix (`gold*`). */
export interface PatternAlt {
  word: string;
  prefix: boolean;
}

/** A parsed token: a word (with its alternatives), `*` (exactly one word) or `~` (zero to three words). */
export type PatternToken = { kind: 'alt'; alts: PatternAlt[] } | { kind: 'one' } | { kind: 'skip' };

export type ParsedPattern = { ok: true; tokens: PatternToken[] } | { ok: false; reason: string };

/** What a word of a pattern may be written with: letters, digits and the few look-alike symbols; zero-width characters are ignored. */
const WORD_BODY = /^[\p{L}\p{N}\p{M}@$.'\u{ad}\u{200b}-\u{200f}\u{2060}-\u{2064}\u{feff}]+$/u;

const fail = (reason: string): ParsedPattern => ({ ok: false, reason });

/**
 * Parse one pattern. Never throws and never echoes the pattern: a refusal carries only the rule that was broken. The words are folded
 * the way a line is, so `G0LD` and `gold` are one pattern.
 */
export function parsePattern(raw: unknown): ParsedPattern {
  if (typeof raw !== 'string') return fail('must be text');
  const text = raw.trim();
  if (text.length === 0) return fail('must not be empty');
  if (text.length > PATTERN_MAX_CHARS) return fail(`must be at most ${PATTERN_MAX_CHARS} characters`);
  const words = text.split(/\s+/u);
  if (words.length > PATTERN_MAX_TOKENS) return fail(`must have at most ${PATTERN_MAX_TOKENS} words`);
  const tokens: PatternToken[] = [];
  let skips = 0;
  for (const word of words) {
    if (word === '*') {
      tokens.push({ kind: 'one' });
      continue;
    }
    if (word === '~') {
      skips++;
      tokens.push({ kind: 'skip' });
      continue;
    }
    const parts = word.split('|');
    if (parts.length > PATTERN_MAX_ALTS) return fail(`must have at most ${PATTERN_MAX_ALTS} alternatives in a word`);
    const alts: PatternAlt[] = [];
    for (const part of parts) {
      const prefix = part.endsWith('*');
      const body = prefix ? part.slice(0, -1) : part;
      if (body.length === 0) return fail('must not have an empty word or alternative');
      if (body.includes('*') || body.includes('~')) return fail('may use * only as a whole word or at the end of a word, and ~ only as a whole word');
      // A bracket, a plus, a question mark or a backslash is regular-expression syntax that is not supported: refused, not quietly read as a word.
      if (!WORD_BODY.test(body)) return fail('must be made of letters and digits only (no regular-expression syntax)');
      const folded = foldWord(body);
      if (folded === null) return fail('must be made of single words of letters and digits');
      alts.push({ word: folded, prefix });
    }
    tokens.push({ kind: 'alt', alts });
  }
  if (skips > PATTERN_MAX_SKIPS) return fail(`must have at most ${PATTERN_MAX_SKIPS} ~`);
  const first = tokens[0]!;
  if (first.kind !== 'alt') return fail('must start with a word, not * or ~');
  for (const alt of first.alts) {
    if (letterCount(alt.word) < PATTERN_MIN_FIRST_LETTERS) return fail(`must start with a word of at least ${PATTERN_MIN_FIRST_LETTERS} letters`);
  }
  return { ok: true, tokens };
}
