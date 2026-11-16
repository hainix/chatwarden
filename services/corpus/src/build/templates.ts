import { buildMatcher, foldTerm } from '@chatwarden/matcher';

// The positive-line templates (design 6.6): the lines a term must always block, made by the builder from the word itself, so a reviewer
// does not write them and the corpus holds no sentence of its own. A reviewer may add lines (term_lines, origin `reviewer`); these are the
// floor.
//
// THE CAP. At most MAX_GENERATED_POSITIVE lines a term. The kit's parser takes up to 50 a row, but the loader's canary reads every
// `positive` line of every term (and the matcher is rebuilt) whenever an exception is active, so its cost is linear in this number times the
// size of the list: at 5 000 terms, 8 lines is 40 000 lines, still a few milliseconds a hundred. Eight covers the five shapes of the design
// (bare, upper case, in a sentence, glued punctuation, a look-alike spelling) with a second spelling of each of two of them.

/** The most template lines generated for one term. Stated in design 6.6. */
export const MAX_GENERATED_POSITIVE = 8;

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * The template lines for a term as the person wrote it, in a fixed order, bare first, at most {@link MAX_GENERATED_POSITIVE}. Only lines that
 * the term itself blocks are returned (a template that a spelling defeats is dropped, not published).
 */
export function positiveTemplates(term: string): string[] {
  const folded = foldTerm(term);
  const last = folded.slice(-1);
  const middle = Math.max(1, Math.floor(folded.length / 2));
  const candidates = [
    term,
    folded.toUpperCase(),
    `you ${term}`,
    `${term}!!`,
    `what a ${term} that was`,
    `"${term}"`,
    `${folded}${last}${last}`,
    `${folded.slice(0, middle)}${ZERO_WIDTH_SPACE}${folded.slice(middle)}`,
  ];
  let matcher;
  try {
    matcher = buildMatcher([{ id: 'template', term, language: 'en', active: true }], []);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of candidates) {
    if (line.length > 200 || out.includes(line) || matcher.match(line) === null) continue;
    out.push(line);
    if (out.length === MAX_GENERATED_POSITIVE) break;
  }
  return out;
}
