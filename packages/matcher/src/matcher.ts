import {
  collapseLikePreset,
  foldForExceptions,
  foldPhrase,
  foldTerm,
  stripInvisible,
  type Folded,
} from './normalise.js';
import { matchName } from './names.js';
import { mergeSpans, stripWithMap, toOriginal, type Span } from './spans.js';
import { compileWords, type EngineHit } from './vendored/wordEngine.js';

/** A row of the term list: one whole word the matcher refuses. */
export interface TermRow { id: string; term: string; language: string; active: boolean }
/** A row of the exception list: a phrase whose match is suppressed. */
export interface ExceptionRow { id: string; phrase: string; language: string; active: boolean }
export type { Span } from './spans.js';
/** What a caller needs from a matcher: the id of the term row that matched, or null. `spans`, when present,
 *  gives every match as a range on the ORIGINAL text (`end` exclusive, overlapping ranges merged, hidden
 *  characters inside a hit included), so a caller can mask it. It is empty exactly when `match` is null. */
export interface Matcher {
  match(text: string): { termId: string } | null;
  spans?(text: string): Span[];
  /** `match` for a NAME (a handle, a table or deck name): the name is also read split into words, so
   *  `Zorbak_99` is caught. See `matchName`. */
  matchName?(name: string): { termId: string } | null;
}

/** Thrown for a malformed active term or exception row; the message names the row id. */
export class MatcherBuildError extends Error {
  /** `rowId` lets a caller log which row failed without logging the message, which quotes the term. */
  readonly rowId?: string;
  /** A short fixed description of what is wrong. Unlike the message it never quotes the term, so it is safe to
   *  log or show next to a row id. */
  readonly reason?: string;
  // No parameter property: erasableSyntaxOnly forbids it.
  constructor(message: string, rowId?: string, reason?: string) {
    super(message);
    this.name = 'MatcherBuildError';
    this.rowId = rowId;
    this.reason = reason;
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
      'must be a single word of plain letters',
    );
  }
  const collapsed = collapseLikePreset(folded);
  if (collapsed.length < MIN_TERM_LENGTH) {
    throw new MatcherBuildError(
      `malformed term in row ${row.id}: ${JSON.stringify(row.term)} collapses to ${JSON.stringify(collapsed)}, below the ${MIN_TERM_LENGTH}-letter minimum`,
      row.id,
      `must have at least ${MIN_TERM_LENGTH} letters once repeated letters are collapsed`,
    );
  }
  return collapsed;
}

function normalisePhrase(row: ExceptionRow): string {
  // Same view as the text it is compared with (see stripInvisible), so an accented or decorated phrase still lines up.
  const phrase = foldPhrase(stripInvisible(row.phrase));
  if (phrase.length === 0) {
    throw new MatcherBuildError(`malformed exception in row ${row.id}: phrase is empty`, row.id, 'phrase is empty');
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
function isExcepted(hit: EngineHit, folded: Folded, phrases: readonly string[]): boolean {
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
  // The engine numbers its words by position, so the row ids are kept in the same order.
  const words: string[] = [];
  const rowIds: string[] = [];
  for (const row of terms) {
    if (!row.active) continue;
    words.push(normaliseTerm(row));
    rowIds.push(row.id);
  }
  const phrases: string[] = [];
  for (const row of exceptions) {
    if (!row.active) continue;
    phrases.push(normalisePhrase(row));
  }

  if (terms.every((t) => !t.active)) return { match: () => null, spans: () => [], matchName: () => null };

  // The engine reads text the way obscenity's English preset does (see ./vendored/wordEngine.ts) and has no whitelist:
  // exceptions are applied by isExcepted (word-bounded), not by the engine.
  const engine = compileWords(words);

  /** Every non-excepted hit of the text, as the matcher reads it (`stripInvisible` already applied), in
   *  the order the passes find them. Lazy, so `match` can stop at the first. */
  function* hits(text: string): Generator<{ startIndex: number; endIndex: number; termId: string }> {
    const passes = LEET_PUNCTUATION.test(text) ? [text, text.replace(LEET_PUNCTUATION_ALL, ' ')] : [text];
    // Exceptions are matched against the ORIGINAL text in both passes (pass 2 only swaps single
    // characters for spaces, so its indices still line up), so a phrase may itself contain ! | ( / $ @.
    const folded = phrases.length > 0 ? foldForExceptions(text) : null;
    for (const pass of passes) {
      for (const hit of engine.getAllMatches(pass)) {
        if (folded && isExcepted(hit, folded, phrases)) continue;
        yield {
          startIndex: hit.startIndex,
          endIndex: hit.endIndex,
          termId: rowIds[hit.termId]!,
        };
      }
    }
  }

  const built: Matcher = {
    match(raw: string) {
      // Everything below, hit ranges and exception edges included, works on this one view, so a hidden
      // character can neither split a term nor make an exception phrase look cleanly bounded.
      for (const hit of hits(stripInvisible(raw))) return { termId: hit.termId };
      return null;
    },
    spans(raw: string) {
      // stripInvisible changes indices, so the view keeps where each of its characters came from.
      const view = stripWithMap(raw);
      const found: Span[] = [];
      for (const hit of hits(view.text)) {
        found.push({ ...toOriginal(view, hit.startIndex, hit.endIndex), termId: hit.termId });
      }
      return mergeSpans(found);
    },
    matchName(name: string) {
      return matchName(built, name);
    },
  };
  return built;
}
