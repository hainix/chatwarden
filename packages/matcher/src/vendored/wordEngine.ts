// The matching engine `buildMatcher` runs on: obscenity's English-preset reading of text, plus its whole-word RegExp matching,
// cut down to what the matcher calls. Copied from obscenity 0.4.6 (MIT, see ./THIRD-PARTY-NOTICES) instead of imported, for one
// reason: obscenity's root module also loads `preset/english`, its ready-made English word list (real slurs), and a bundler cannot
// drop it (the package is CommonJS and has no `sideEffects` flag), so importing ANYTHING from `obscenity` put that list into every
// browser bundle of the matcher. This file never carries the list: the words come from the term pack.
//
// What is kept, and why it is exact:
//   - the transformer chain of `englishRecommendedBlacklistMatcherTransformers`, in its order and with its options: look-alike
//     characters to letters, leetspeak to letters, ASCII uppercase to lowercase, runs of one character cut to 1 (2 for b e o l s g);
//   - obscenity's one-code-point-at-a-time reading and its map from transformed indices back to the original text;
//   - the `|word|` pattern: `\b` + the word with its RegExp specials escaped + `\b`, flags `gs`;
//   - `RegExpMatcher.getAllMatches(text, true)`: hits sorted by start, end, then term.
// What is dropped: the whitelist (the matcher passes none and applies its exceptions itself), the censor, the pattern parser
// (only `|word|` is ever built), stateful-transformer plumbing, and everything else of the package.
// packages/matcher/test/wordEngine.test.ts holds this file against obscenity itself, on a table of tricky inputs and on a few
// thousand generated lines; any drift fails there.
import { confusables } from './confusables.js';

/** One hit, with the same fields obscenity's `MatchPayload` has. `termId` is the position of the word in the list given to
 *  `compileWords`. `endIndex` is inclusive. Indices are UTF-16 offsets into the text as given. */
export interface EngineHit {
  termId: number;
  startIndex: number;
  endIndex: number;
  matchLength: number;
}

const isHighSurrogate = (c: number): boolean => 0xd800 <= c && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => 0xdc00 <= c && c <= 0xdfff;

/** equivalent code point -> the letter it stands for. A later entry (or later character) wins, as in obscenity. */
function remapTable(mapping: ReadonlyMap<string, string>): Map<number, number> {
  const table = new Map<number, number>();
  for (const [original, equivalents] of mapping) {
    const target = original.codePointAt(0)!;
    for (const eq of equivalents) table.set(eq.codePointAt(0)!, target);
  }
  return table;
}

/** obscenity's leetspeak dictionary. */
const LEET = new Map<string, string>([
  ['a', '@4'],
  ['c', '('],
  ['e', '3'],
  ['g', '6'],
  ['i', '1|!'],
  ['l', '/'],
  ['o', '0'],
  ['s', '$5'],
  ['t', '7'],
  ['z', '2'],
]);

const CONFUSABLE_TO_LETTER = remapTable(confusables);
const LEET_TO_LETTER = remapTable(LEET);

/** Letters whose run is cut to two (every other character: to one), the thresholds of the English preset. */
const KEEP_TWO = new Set([...'beolsg'].map((c) => c.codePointAt(0)!));

/** The chain, one code point at a time. Returns the transformed code point, or undefined when the character is dropped. */
class Chain {
  private lastChar = -1;
  private remaining = -1;

  step(char: number): number | undefined {
    let c = CONFUSABLE_TO_LETTER.get(char) ?? char;
    c = LEET_TO_LETTER.get(c) ?? c;
    if (c >= 65 && c <= 90) c ^= 0x20; // ASCII uppercase -> lowercase
    // Collapse duplicates: threshold 1, or 2 for the kept-two letters.
    if (c === this.lastChar) return this.remaining-- > 0 ? c : undefined;
    const threshold = KEEP_TWO.has(c) ? 2 : 1;
    this.remaining = threshold - 1;
    this.lastChar = c;
    return c;
  }
}

/** The text as the matcher reads it, with where each of its UTF-16 units came from: `toOrig[i]` is the index, in `input`, of
 *  the character that produced `text[i]`. A fresh chain per call, so a run never carries over between texts. */
export function transformLikePreset(input: string): { text: string; toOrig: number[] } {
  const chain = new Chain();
  const toOrig: number[] = [];
  let text = '';
  for (let pos = 0; pos < input.length; ) {
    const start = pos;
    const unit = input.charCodeAt(pos++);
    let char = unit;
    // A well-formed pair is one character; a lone surrogate stays a character of its own.
    if (isHighSurrogate(unit) && pos < input.length && isLowSurrogate(input.charCodeAt(pos))) {
      char = (unit - 0xd800) * 0x400 + input.charCodeAt(pos) - 0xdc00 + 0x10000;
      pos++;
    }
    const out = chain.step(char);
    if (out === undefined) continue;
    text += String.fromCodePoint(out);
    while (toOrig.length < text.length) toOrig.push(start);
  }
  return { text, toOrig };
}

const REGEXP_SPECIALS = new Set([...'[.*+?^${}()|[\\]'].map((c) => c.codePointAt(0)!));

/** `|word|` as a RegExp: a word boundary, the word, a word boundary. */
function wordRegExp(word: string): RegExp {
  let body = '';
  for (const ch of word) body += (REGEXP_SPECIALS.has(ch.codePointAt(0)!) ? '\\' : '') + ch;
  return new RegExp(`\\b${body}\\b`, 'gs');
}

function compareHits(a: EngineHit, b: EngineHit): number {
  if (a.startIndex !== b.startIndex) return a.startIndex < b.startIndex ? -1 : 1;
  if (a.endIndex !== b.endIndex) return a.endIndex < b.endIndex ? -1 : 1;
  return a.termId === b.termId ? 0 : a.termId < b.termId ? -1 : 1;
}

/** Compiles whole-word terms (each already in the preset's collapsed form). The term at position `i` gets `termId` `i`. */
export function compileWords(words: readonly string[]): { getAllMatches(input: string): EngineHit[] } {
  const terms = words.map((word, termId) => {
    if (word.length === 0) throw new Error(`Pattern with ID ${termId} potentially matches empty string; this is unsupported.`);
    return { termId, regExp: wordRegExp(word) };
  });
  return {
    /** Every hit, sorted by start, end, then term, as `RegExpMatcher.getAllMatches(input, true)` returns them. */
    getAllMatches(input: string): EngineHit[] {
      const { text, toOrig } = transformLikePreset(input);
      const hits: EngineHit[] = [];
      for (const { termId, regExp } of terms) {
        for (const match of text.matchAll(regExp)) {
          const startIndex = toOrig[match.index]!;
          let endIndex = toOrig[match.index + match[0].length - 1]!;
          // The last character is a surrogate pair: the range covers both halves.
          if (endIndex < input.length - 1 && isHighSurrogate(input.charCodeAt(endIndex)) && isLowSurrogate(input.charCodeAt(endIndex + 1))) endIndex++;
          hits.push({ termId, startIndex, endIndex, matchLength: [...match[0]].length });
        }
      }
      return hits.sort(compareHits);
    },
  };
}
