// Stand-ins for the matcher and the profanity filter, over a list of words you give. They block or star WHOLE words, ignoring case; they are not the real
// matcher and do not resist evasion. Pass your own `matcher` to a test kit to test your own term list.
import type { Matcher, ProfanityFilter } from '@chatwarden/core';

/** A letter, a digit or an underscore: what a whole word may not be touching. */
const WORD_CHAR = '[\\p{L}\\p{N}_]';

/** The characters that mean something in a regular expression, escaped so a word is always taken literally. */
const escape = (word: string): string => word.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

interface Compiled {
  pattern: RegExp;
  /** The id of a word, by its lower-cased text: the position in the list given. */
  ids: Map<string, string>;
}

function compile(words: readonly string[]): Compiled | null {
  if (!Array.isArray(words)) throw new TypeError('A word list is an array of strings.');
  const ids = new Map<string, string>();
  for (const word of words) {
    if (typeof word !== 'string' || word.trim() === '') throw new TypeError('Every word is a non-empty string.');
    const key = word.toLowerCase();
    if (!ids.has(key)) ids.set(key, `test:${ids.size + 1}`);
  }
  if (ids.size === 0) return null;
  // The longest word first, so where two overlap the longer wins.
  const alternation = [...ids.keys()].sort((a, b) => b.length - a.length).map(escape).join('|');
  return { pattern: new RegExp(`(?<!${WORD_CHAR})(?:${alternation})(?!${WORD_CHAR})`, 'giu'), ids };
}

/**
 * A matcher that blocks whole words, case-insensitively, with spans for masking. The words are yours (invented ones in the docs). A hit carries a stable
 * id for its word (`test:1`, `test:2`...), never the word. Not the real matcher: it does not resist evasion.
 */
export function wordMatcher(words: readonly string[]): Matcher {
  const compiled = compile(words);
  const spans = (text: string): Array<{ start: number; end: number; termId: string }> => {
    if (compiled === null) return [];
    return [...text.matchAll(compiled.pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length, termId: compiled.ids.get(m[0].toLowerCase()) ?? 'test:0' }));
  };
  return {
    match(text) {
      const first = spans(text)[0];
      return first === undefined ? null : { termId: first.termId };
    },
    spans,
  };
}

/**
 * A profanity filter that stars whole words, one star for each character (`hit` is true when any matched). Not the real filter.
 */
export function wordFilter(words: readonly string[]): ProfanityFilter {
  const compiled = compile(words);
  return {
    apply(text) {
      if (compiled === null) return { hit: false, text };
      let hit = false;
      const starred = text.replace(compiled.pattern, (found) => {
        hit = true;
        return '*'.repeat(found.length);
      });
      return { hit, text: starred };
    },
  };
}
