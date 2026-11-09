// Text normalisation for the matcher: everything that turns what a person typed, or what a moderator
// entered, into the form the matcher compares. Pure functions, no state.

/** Mirrors the repeated-letter thresholds of obscenity's englishRecommendedBlacklistMatcherTransformers
 *  (threshold 1, except b/e/o/l/s/g at 2). The preset collapses the INPUT before matching, so a pattern
 *  that still holds a collapsible double could never match. The patterns are therefore collapsed the same
 *  way. The preset does not export its table, hence this copy; the doubled-letter tests in
 *  matcher.test.ts (vlemmo, drakkuun) fail loudly if the two ever drift. */
const KEEP_TWO = new Set(['b', 'e', 'o', 'l', 's', 'g']);
export function collapseLikePreset(word: string): string {
  let out = '';
  let prev = '';
  let run = 0;
  for (const ch of word) {
    run = ch === prev ? run + 1 : 1;
    prev = ch;
    if (run <= (KEEP_TWO.has(ch) ? 2 : 1)) out += ch;
  }
  return out;
}

/** Characters that render as nothing (or as a blank) but are not Cf or marks: Hangul fillers, the braille
 *  blank, the combining grapheme joiner and the variation selectors. */
// eslint-disable-next-line no-misleading-character-class -- the combining grapheme joiner is listed on purpose
const BLANK_FILLERS = /[\u3164\uFFA0\u115F\u1160\u2800\u034F\uFE00-\uFE0F]/g;

/** The text as the matcher reads it: NFKD-normalised, with combining marks (\p{M}), format characters
 *  (\p{Cf}: zero-width space/joiners, soft hyphen, bidi controls, BOM, word joiner) and the blank fillers
 *  above removed. Without it a term split by a zero-width character is not a whole word and walks past the
 *  matcher. Matching-only: the text that is delivered or stored is never altered. Separators ("zor-bak",
 *  "z o r b a k") are NOT removed on purpose: that precision-first residual is a report away. */
export function stripInvisible(text: string): string {
  return text.normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').replace(BLANK_FILLERS, '');
}

/** The text of a term as the matcher reads it before collapsing: accents stripped, trimmed, lowercase.
 *  A term store keeps rows in this form. */
export function foldTerm(term: string): string {
  return term.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
}

/** Text prepared for exception matching: ASCII-lowercased and with runs of whitespace collapsed to one
 *  space, plus, per folded character, the range of ORIGINAL indices it came from (so a hit's range, which
 *  obscenity reports against the original text, can be compared with an exception occurrence). */
export interface Folded { text: string; start: number[]; end: number[] }
export function foldForExceptions(text: string): Folded {
  let out = '';
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      let j = i;
      while (j + 1 < text.length && /\s/.test(text[j + 1]!)) j++;
      out += ' ';
      start.push(i);
      end.push(j);
      i = j;
    } else {
      out += ch >= 'A' && ch <= 'Z' ? ch.toLowerCase() : ch;
      start.push(i);
      end.push(i);
    }
  }
  return { text: out, start, end };
}

/** An exception phrase as the matcher reads it (trimmed, ASCII-lowercased, whitespace runs collapsed). A
 *  term store keeps rows in this form. */
export function foldPhrase(phrase: string): string {
  return foldForExceptions(phrase.trim()).text;
}
