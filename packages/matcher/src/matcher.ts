import { DataSet, RegExpMatcher, englishRecommendedTransformers, parseRawPattern, type MatchPayload } from 'obscenity';
import {
  collapseLikePreset,
  foldForExceptions,
  foldPhrase,
  foldTerm,
  stripInvisible,
  type Folded,
} from './normalise.js';

/** A row of the term list: one whole word the matcher refuses. */
export interface TermRow { id: string; term: string; language: string; active: boolean }
/** A row of the exception list: a phrase whose match is suppressed. */
export interface ExceptionRow { id: string; phrase: string; language: string; active: boolean }
/** What a caller needs from a matcher: the id of the term row that matched, or null. */
export interface Matcher { match(text: string): { termId: string } | null }

/** Thrown for a malformed active term or exception row; the message names the row id. */
export class MatcherBuildError extends Error {
  /** `rowId` lets a caller log which row failed without logging the message, which quotes the term. */
  readonly rowId?: string;
  // No parameter property: erasableSyntaxOnly forbids it.
  constructor(message: string, rowId?: string) {
    super(message);
    this.name = 'MatcherBuildError';
    this.rowId = rowId;
  }
}

const MIN_TERM_LENGTH = 3;

/** Lowercase, strip accents, collapse like the preset, and require plain letters only: anything else
 *  would be read by obscenity as pattern syntax ([ ] ? | \) or could never match a whole word. The
 *  minimum length applies to the COLLAPSED form, because that is what gets matched: a term of one repeated
 *  letter collapses to a single letter and would otherwise block every standalone occurrence of it. */
function normaliseTerm(row: TermRow): string {
  const folded = foldTerm(row.term);
  if (!/^[a-z]+$/.test(folded)) {
    throw new MatcherBuildError(
      `malformed term in row ${row.id}: must be a single word of plain letters (got ${JSON.stringify(row.term)})`,
      row.id,
    );
  }
  const collapsed = collapseLikePreset(folded);
  if (collapsed.length < MIN_TERM_LENGTH) {
    throw new MatcherBuildError(
      `malformed term in row ${row.id}: ${JSON.stringify(row.term)} collapses to ${JSON.stringify(collapsed)}, below the ${MIN_TERM_LENGTH}-letter minimum`,
      row.id,
    );
  }
  return collapsed;
}

function normalisePhrase(row: ExceptionRow): string {
  // Same view as the text it is compared with (see stripInvisible), so an accented or decorated phrase still lines up.
  const phrase = foldPhrase(stripInvisible(row.phrase));
  if (phrase.length === 0) {
    throw new MatcherBuildError(`malformed exception in row ${row.id}: phrase is empty`, row.id);
  }
  return phrase;
}

/** Letters and digits are word characters. Digits are included on purpose: the transformers read them
 *  as letters ("3" is "e"), so "9glarn zorbak" must not count as a clean edge. */
const WORD_CHAR = /[\p{L}\p{N}]/u;
function isWordCharBefore(text: string, i: number): boolean {
  if (i <= 0) return false;
  const low = text.charCodeAt(i - 1);
  // A surrogate pair counts as one character: step back over both halves.
  const cp = text.codePointAt(i - 1 >= 1 && low >= 0xdc00 && low <= 0xdfff ? i - 2 : i - 1);
  return cp !== undefined && WORD_CHAR.test(String.fromCodePoint(cp));
}
function isWordCharAt(text: string, i: number): boolean {
  if (i >= text.length) return false;
  const cp = text.codePointAt(i);
  return cp !== undefined && WORD_CHAR.test(String.fromCodePoint(cp));
}

/** True when the hit's range lies inside an occurrence of an exception phrase that is word-bounded on
 *  both sides. obscenity's own whitelist is a raw substring search, so "unglarn zorbak" would borrow
 *  "glarn zorbak" and "tarvo lakes" would borrow "tarvo lake"; this does the bounding itself. */
function isExcepted(hit: MatchPayload, folded: Folded, phrases: readonly string[]): boolean {
  for (const phrase of phrases) {
    for (let at = folded.text.indexOf(phrase); at !== -1; at = folded.text.indexOf(phrase, at + 1)) {
      const last = at + phrase.length;
      if (isWordCharBefore(folded.text, at) || isWordCharAt(folded.text, last)) continue;
      if (hit.startIndex >= folded.start[at]! && hit.endIndex <= folded.end[last - 1]!) return true;
    }
  }
  return false;
}

/** The preset's leetspeak table maps the punctuation marks ! | ( / $ @ to letters (i i c l s a), so
 *  "zorbak!" becomes "zorbaki" and "(zorbak)" becomes "czorbakc": no longer whole words. Matching the
 *  text a second time with those marks turned into spaces closes the hole, while the first pass still
 *  catches in-word leetspeak like "fenr!sk". The second pass can only add blocks, never remove one. */
const LEET_PUNCTUATION = /[!|(/$@]/;
const LEET_PUNCTUATION_ALL = /[!|(/$@]/g;

/** Builds a precision-first, whole-word matcher from term and exception rows. Inactive rows are skipped
 *  (and not validated); a malformed active row throws MatcherBuildError. All terms inactive gives a
 *  matcher that never matches. */
export function buildMatcher(terms: readonly TermRow[], exceptions: readonly ExceptionRow[]): Matcher {
  const dataset = new DataSet<{ rowId: string }>();
  for (const row of terms) {
    if (!row.active) continue;
    const word = normaliseTerm(row);
    dataset.addPhrase((phrase) =>
      phrase.setMetadata({ rowId: row.id }).addPattern(parseRawPattern(`|${word}|`)),
    );
  }
  const phrases: string[] = [];
  for (const row of exceptions) {
    if (!row.active) continue;
    phrases.push(normalisePhrase(row));
  }

  if (terms.every((t) => !t.active)) return { match: () => null };

  // No whitelistedTerms: exceptions are applied by isExcepted (word-bounded), not by obscenity.
  const matcher = new RegExpMatcher({
    blacklistedTerms: dataset.build().blacklistedTerms,
    ...englishRecommendedTransformers,
  });

  return {
    match(raw: string) {
      // Everything below, hit ranges and exception edges included, works on this one view, so a hidden
      // character can neither split a term nor make an exception phrase look cleanly bounded.
      const text = stripInvisible(raw);
      const passes = LEET_PUNCTUATION.test(text) ? [text, text.replace(LEET_PUNCTUATION_ALL, ' ')] : [text];
      // Exceptions are matched against the ORIGINAL text in both passes (pass 2 only swaps single
      // characters for spaces, so its indices still line up), so a phrase may itself contain ! | ( / $ @.
      const folded = phrases.length > 0 ? foldForExceptions(text) : null;
      for (const pass of passes) {
        for (const hit of matcher.getAllMatches(pass, true)) {
          if (folded && isExcepted(hit, folded, phrases)) continue;
          return { termId: dataset.getPayloadWithPhraseMetadata(hit).phraseMetadata!.rowId };
        }
      }
      return null;
    },
  };
}
