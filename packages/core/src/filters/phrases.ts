import type { ResolvedPhraseRule } from '../filters.js';
import { foldChunks, foldWord, letterCount } from './fold.js';
import type { Chunk, FilterSpan } from './fold.js';

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

// ---------------------------------------------------------------------------------------------------------------
// Compiling and matching

/** At most this many characters of a line are read. */
export const PHRASE_LINE_CAP = 2000;
/** At most this many matches are returned for one line. */
export const PHRASE_MATCH_CAP = 50;
/** `~` stands for at most this many words. */
const SKIP_MAX = 3;
/** The longest first-word prefix that is looked up. */
const PREFIX_LOOKUP_MAX = 64;

/** Test hook: how many comparisons the matcher has made, so a test can show the work does not grow with the number of patterns. */
export const __phraseSteps = { n: 0 };

interface CompiledPattern {
  ruleId: string;
  tokens: PatternToken[];
}

/** The patterns of a set of rules, indexed by the first word. */
export interface CompiledPhrases {
  /** How many patterns compiled (a pattern that could not be read is left out, never thrown on). */
  readonly count: number;
  readonly exact: ReadonlyMap<string, readonly CompiledPattern[]>;
  readonly prefix: ReadonlyMap<string, readonly CompiledPattern[]>;
  /** The distinct lengths of the prefix keys, ascending. */
  readonly prefixLens: readonly number[];
}

const compiledBy = new WeakMap<readonly ResolvedPhraseRule[], CompiledPhrases>();

function bucket(map: Map<string, CompiledPattern[]>, key: string, p: CompiledPattern): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [p]);
  else if (list[list.length - 1] !== p) list.push(p);
}

/**
 * Compile the rules' patterns once; the result is cached by the identity of `rules`, so a settings change (a new array) compiles again
 * and a line costs no compile. A pattern that does not parse is skipped. Never throws.
 */
export function compilePhrases(rules: readonly ResolvedPhraseRule[]): CompiledPhrases {
  const cached = compiledBy.get(rules);
  if (cached !== undefined) return cached;
  const exact = new Map<string, CompiledPattern[]>();
  const prefix = new Map<string, CompiledPattern[]>();
  const lens = new Set<number>();
  let count = 0;
  try {
    for (const rule of rules) {
      if (!Array.isArray(rule.phrases)) continue;
      for (const raw of rule.phrases) {
        const parsed = parsePattern(raw);
        if (!parsed.ok) continue;
        const first = parsed.tokens[0];
        if (first === undefined || first.kind !== 'alt') continue;
        const p: CompiledPattern = { ruleId: rule.id, tokens: parsed.tokens };
        count++;
        for (const alt of first.alts) {
          if (alt.prefix) {
            bucket(prefix, alt.word, p);
            lens.add(Math.min(alt.word.length, PREFIX_LOOKUP_MAX));
          } else {
            bucket(exact, alt.word, p);
          }
        }
      }
    }
  } catch {
    // A malformed rule list compiles to what was read so far.
  }
  const compiled: CompiledPhrases = { count, exact, prefix, prefixLens: [...lens].sort((a, b) => a - b) };
  compiledBy.set(rules, compiled);
  return compiled;
}

function altMatches(token: Extract<PatternToken, { kind: 'alt' }>, word: string): boolean {
  for (const alt of token.alts) {
    __phraseSteps.n++;
    if (alt.prefix ? word.startsWith(alt.word) : word === alt.word) return true;
  }
  return false;
}

/** The index just after the last word the pattern consumed when it matches starting at `pos`, or -1. At most 16 paths. */
function matchFrom(tokens: readonly PatternToken[], ti: number, chunks: readonly Chunk[], pos: number): number {
  if (ti === tokens.length) return pos;
  const t = tokens[ti]!;
  if (t.kind === 'alt') return pos < chunks.length && altMatches(t, chunks[pos]!.folded) ? matchFrom(tokens, ti + 1, chunks, pos + 1) : -1;
  if (t.kind === 'one') {
    __phraseSteps.n++;
    return pos < chunks.length ? matchFrom(tokens, ti + 1, chunks, pos + 1) : -1;
  }
  for (let k = 0; k <= SKIP_MAX && pos + k <= chunks.length; k++) {
    __phraseSteps.n++;
    const end = matchFrom(tokens, ti + 1, chunks, pos + k);
    if (end >= 0) return end;
  }
  return -1;
}

/**
 * Every place a pattern of `compiled` matches in `text`, in text order, at most 50: the rule's id and the range of the matched words on
 * the original text. A line costs one lookup per word plus the tail comparisons of the patterns that share its first word. Reads at most
 * 2 000 characters. Never throws.
 */
export function matchPhrases(compiled: CompiledPhrases, text: string): Array<{ ruleId: string; span: FilterSpan }> {
  if (typeof text !== 'string' || text.length === 0 || compiled.count === 0) return [];
  try {
    const chunks = foldChunks(text.length > PHRASE_LINE_CAP ? text.slice(0, PHRASE_LINE_CAP) : text);
    const out: Array<{ ruleId: string; span: FilterSpan }> = [];
    const tryPatterns = (list: readonly CompiledPattern[] | undefined, idx: number, seen: Set<CompiledPattern>): void => {
      if (list === undefined) return;
      for (const p of list) {
        if (out.length >= PHRASE_MATCH_CAP) return;
        if (seen.has(p)) continue;
        __phraseSteps.n++;
        const end = matchFrom(p.tokens, 0, chunks, idx);
        if (end > idx) {
          seen.add(p);
          out.push({ ruleId: p.ruleId, span: { start: chunks[idx]!.start, end: chunks[end - 1]!.end } });
        }
      }
    };
    for (let idx = 0; idx < chunks.length && out.length < PHRASE_MATCH_CAP; idx++) {
      __phraseSteps.n++;
      const word = chunks[idx]!.folded;
      const seen = new Set<CompiledPattern>();
      tryPatterns(compiled.exact.get(word), idx, seen);
      for (const len of compiled.prefixLens) {
        if (len > word.length) break;
        tryPatterns(compiled.prefix.get(word.slice(0, len)), idx, seen);
      }
    }
    return out;
  } catch {
    return [];
  }
}
