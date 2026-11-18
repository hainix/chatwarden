import { MatcherBuildError } from './matcherError.js';
import { foldKana, nfkcVisible, normaliseUnspaced } from './normalise.js';

// Terms in scripts written without spaces: Han, Hiragana, Katakana, Thai, Lao, Khmer and Myanmar. A text is cut into RUNS of letters of those scripts (anything else, spaces, punctuation, digits, Latin letters and
// emoji included, ends a run). A `segment` term must occupy whole segments of the run as Node's ICU (`Intl.Segmenter`, in the term's language) cuts it; a `contains` term hits anywhere inside a run. Both read
// text the way `normaliseUnspaced` does and map every hit back to the exact range of the text as typed. The Latin engine is not touched: a matcher with no unspaced term, and a line with no unspaced letter, never get here.

/** The scripts this path reads, in the order they are listed in the docs. */
export const UNSPACED_SCRIPTS = ['Han', 'Hiragana', 'Katakana', 'Thai', 'Lao', 'Khmer', 'Myanmar'] as const;
export type UnspacedScript = (typeof UNSPACED_SCRIPTS)[number];

/** The language tags a row of an unspaced term may carry: they pick the segmenter. */
export const UNSPACED_LANGUAGES = ['zh', 'ja', 'th', 'lo', 'km', 'my'] as const;
export type UnspacedLanguage = (typeof UNSPACED_LANGUAGES)[number];

export type TermMode = 'word' | 'segment' | 'contains';

/** A term is 2 to 24 code points for `segment`, 3 to 24 for `contains`; an exception phrase 1 to 48. */
export const UNSPACED_TERM_MAX = 24;
const MIN_SEGMENT = 2;
const MIN_CONTAINS = 3;
const EXCEPTION_MAX = 48;

const SCRIPT_RE: Readonly<Record<UnspacedScript, RegExp>> = {
  Han: /\p{Script=Han}/u,
  Hiragana: /\p{Script=Hiragana}/u,
  Katakana: /\p{Script=Katakana}/u,
  Thai: /\p{Script=Thai}/u,
  Lao: /\p{Script=Lao}/u,
  Khmer: /\p{Script=Khmer}/u,
  Myanmar: /\p{Script=Myanmar}/u,
};
/** Digits, punctuation, symbols, separators and controls of those scripts are not letters: they end a run and cannot be in a term. */
const NOT_LETTER = /[\p{N}\p{P}\p{S}\p{Z}\p{C}]/u;
const MARK = /\p{M}/u;
const FOREIGN_LETTER = /(?=\p{L})(?!\p{Script=Latin})/u;
const PROLONGED_SOUND = 0x30fc;

/** The unspaced script a character (one code point as a string) is a letter of, or null. The Katakana-Hiragana prolonged sound mark is both: it reads as Katakana. */
export function scriptOf(ch: string): UnspacedScript | null {
  const cp = ch.codePointAt(0) as number;
  // The lowest of these scripts begins at U+0E01 (Thai): everything below is not one.
  if (cp < 0xe00) return null;
  if (cp === PROLONGED_SOUND) return 'Katakana';
  if (NOT_LETTER.test(ch)) return null;
  for (const script of UNSPACED_SCRIPTS) if (SCRIPT_RE[script].test(ch)) return script;
  return null;
}

/** The kinds of letter a text holds: letters of an unspaced script, and letters of any other script besides Latin (which this path cannot read). */
export function scanLetters(text: string): { unspaced: boolean; foreign: boolean } {
  let unspaced = false;
  let foreign = false;
  for (const ch of text) {
    if (scriptOf(ch) !== null) unspaced = true;
    else if (FOREIGN_LETTER.test(ch)) foreign = true;
  }
  return { unspaced, foreign };
}

/** Is this term made only of letters of the unspaced scripts (after NFKC)? A term of only a prolonged sound mark, an empty term and anything with a space, digit or punctuation is not. */
export function isUnspacedTerm(term: string): boolean {
  if (typeof term !== 'string') return false;
  const text = normaliseUnspaced(term);
  if (text === '') return false;
  let real = false;
  for (const ch of text) {
    const script = scriptOf(ch);
    if (script === null) return false;
    if (ch.codePointAt(0) !== PROLONGED_SOUND) real = true;
  }
  return real;
}

const fail = (id: string, reason: string, detail = reason): never => {
  throw new MatcherBuildError(`malformed row ${id}: ${detail}`, id, reason);
};

/** The languages a set of scripts may be written in: Han alone is Chinese or Japanese, any kana makes it Japanese, and each of the others has its own. */
function languagesOf(scripts: ReadonlySet<UnspacedScript>): readonly UnspacedLanguage[] | null {
  const cjk = ['Han', 'Hiragana', 'Katakana'] as const;
  const onlyCjk = [...scripts].every((s) => (cjk as readonly string[]).includes(s));
  if (onlyCjk) return scripts.has('Hiragana') || scripts.has('Katakana') ? ['ja'] : ['zh', 'ja'];
  if (scripts.size !== 1) return null;
  const only = [...scripts][0] as UnspacedScript;
  return only === 'Thai' ? ['th'] : only === 'Lao' ? ['lo'] : only === 'Khmer' ? ['km'] : ['my'];
}

/** Checks that `text` (already normalised) is letters of one family of scripts and that `language` is one of the six and fits them. Never quotes the text. */
function checkScriptAndLanguage(id: string, text: string, language: unknown): void {
  const scripts = new Set<UnspacedScript>();
  let foreign = false;
  let other = false;
  for (const ch of text) {
    const script = scriptOf(ch);
    if (script !== null) scripts.add(script);
    else if (FOREIGN_LETTER.test(ch)) foreign = true;
    else other = true;
  }
  if (foreign) fail(id, 'this script is not supported yet', 'this script is not supported yet (Han, Hiragana, Katakana, Thai, Lao, Khmer and Myanmar are)');
  if (other || scripts.size === 0) fail(id, 'must be one word of letters in one script, with no space, punctuation or digit');
  const fits = languagesOf(scripts);
  if (fits === null) fail(id, 'must be written in one script (Han, Hiragana and Katakana may be mixed for Japanese)');
  if (typeof language !== 'string' || !(UNSPACED_LANGUAGES as readonly string[]).includes(language)) fail(id, 'the language must be one of zh, ja, th, lo, km or my');
  if (!(fits as readonly string[]).includes(language as string)) fail(id, 'the language does not fit the script');
}

/** A Latin term (plain a-z) takes no mode but `word`; `segment` and `contains` are for terms in an unspaced script. Never quotes the term. */
export function checkLatinMode(id: string, matchMode: unknown): void {
  if (matchMode === undefined || matchMode === null || matchMode === 'word') return;
  if (matchMode === 'segment' || matchMode === 'contains') fail(id, 'segment and contains are for terms in a script written without spaces');
  fail(id, 'the match mode must be word, segment or contains');
}

/** An unspaced term as the matcher keeps it. */
export interface UnspacedTerm {
  id: string;
  /** Normalised: NFKC, hidden characters off, hiragana as katakana. */
  term: string;
  language: UnspacedLanguage;
  mode: 'segment' | 'contains';
}

/**
 * Reads a term row that has letters of an unspaced script (or of a script this path cannot read) in it. Throws MatcherBuildError naming the row and never quoting the term, for: a script that is not supported yet, a
 * space, punctuation or digit, a mix of scripts that is not Han, Hiragana and Katakana, a language outside zh, ja, th, lo, km and my or one that does not fit the script, the mode `word` or one that is not one of the
 * three, and a length outside 2 to 24 code points (3 for `contains`).
 */
export function readUnspacedTerm(id: string, term: unknown, language: unknown, matchMode: unknown): UnspacedTerm {
  if (typeof term !== 'string') fail(id, 'the term must be text');
  const text = normaliseUnspaced(term as string);
  checkScriptAndLanguage(id, text, language);
  let mode: 'segment' | 'contains';
  if (matchMode === undefined || matchMode === null || matchMode === 'segment') mode = 'segment';
  else if (matchMode === 'contains') mode = 'contains';
  else if (matchMode === 'word') return fail(id, 'word is for terms in plain letters; a term in a script written without spaces is segment or contains');
  else return fail(id, 'the match mode must be word, segment or contains');
  const length = [...text].length;
  const min = mode === 'contains' ? MIN_CONTAINS : MIN_SEGMENT;
  if (length < min || length > UNSPACED_TERM_MAX) fail(id, `must be ${min} to ${UNSPACED_TERM_MAX} characters`);
  return { id, term: text, language: language as UnspacedLanguage, mode };
}

/** An unspaced exception as the matcher keeps it. */
export interface UnspacedException {
  id: string;
  phrase: string;
  language: UnspacedLanguage;
}

/**
 * Reads an exception row: `null` when the phrase has no letter of an unspaced script (it is a Latin phrase, read as before). A phrase that does must be nothing but letters of one script (no space, Latin letter or punctuation:
 * a mix of Latin and Han is refused naming the row), 1 to 48 characters, in a language that fits.
 */
export function readUnspacedException(id: string, phrase: unknown, language: unknown): UnspacedException | null {
  if (typeof phrase !== 'string') return null;
  const text = normaliseUnspaced(phrase);
  if (!scanLetters(text).unspaced) return null;
  checkScriptAndLanguage(id, text, language);
  const length = [...text].length;
  if (length < 1 || length > EXCEPTION_MAX) fail(id, `an exception must be 1 to ${EXCEPTION_MAX} characters`);
  return { id, phrase: text, language: language as UnspacedLanguage };
}

// ---- reading a text -----------------------------------------------------------------------------------------------------------------------------------------------

/** The text as the unspaced path reads it, and where every unit of it came from in the text as typed. */
export interface UnspacedView {
  /** NFKC, hidden characters removed. Segmented as it is, so the dictionary sees ordinary text. */
  text: string;
  /** `text` with hiragana read as katakana: the same length, so an index means the same place in both. Terms are matched on this. */
  folded: string;
  /** For each UTF-16 unit of `text`: where the character that produced it starts in the text as typed. */
  from: number[];
  /** ... and where it ends (exclusive). A cluster's units all share its range. */
  to: number[];
  /** True for the first unit of each grapheme cluster: a hit starts and ends on these, so a base letter is never read without its tone mark. */
  clusterStart: boolean[];
}

// Characters that continue the cluster before them: marks, the half-width sound marks, Thai and Lao sara am, and variation selectors.
const isExtender = (cp: number): boolean =>
  cp >= 0x300 && (cp === 0xff9e || cp === 0xff9f || cp === 0x0e33 || cp === 0x0eb3 || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) || MARK.test(String.fromCodePoint(cp)));

/**
 * Cuts `raw` into clusters (a letter and the marks that follow it; any other character is its own), reads each one on its own (NFKC, hidden characters off) and keeps, for every output unit, the range of its cluster in `raw`.
 * A hidden character that is not a mark (a zero-width space) is a cluster that reads as nothing, so it never extends a hit at either end, while one between two letters of a hit is inside its range.
 */
export function unspacedView(raw: string): UnspacedView {
  let text = '';
  let folded = '';
  const from: number[] = [];
  const to: number[] = [];
  const clusterStart: boolean[] = [];
  for (let i = 0; i < raw.length; ) {
    let j = i + (raw.codePointAt(i)! > 0xffff ? 2 : 1);
    while (j < raw.length) {
      const cp = raw.codePointAt(j)!;
      if (!isExtender(cp)) break;
      j += cp > 0xffff ? 2 : 1;
    }
    const piece = j - i === 1 && raw.charCodeAt(i) < 0x80 ? raw[i]! : nfkcVisible(raw.slice(i, j));
    for (let k = 0; k < piece.length; k += 1) {
      from.push(i);
      to.push(j);
      clusterStart.push(k === 0);
    }
    text += piece;
    folded += foldKana(piece);
    i = j;
  }
  return { text, folded, from, to, clusterStart };
}

/** The runs of the view's text: ranges `[start, end)` of letters of the unspaced scripts (and the marks that follow one). */
export function runsOf(text: string): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const n = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + n);
    const inside = scriptOf(ch) !== null || (start !== -1 && cp >= 0x300 && MARK.test(ch));
    if (inside && start === -1) start = i;
    else if (!inside && start !== -1) {
      runs.push([start, i]);
      start = -1;
    }
    i += n;
  }
  if (start !== -1) runs.push([start, text.length]);
  return runs;
}

/** Whether this runtime has `Intl.Segmenter` (a stub may remove it; asked at build time). */
export const hasSegmenter = (): boolean => typeof Intl === 'object' && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function';

/** Quick test: does a text have any letter an unspaced script could hold? Everything below U+0E00 cannot be one. */
const MAY_HOLD = /[\u0e00-\u{10ffff}]/u;
export const mayHoldUnspaced = (raw: string): boolean => MAY_HOLD.test(raw);

// ---- the matcher ----------------------------------------------------------------------------------------------------------------------------------------------------

/** A hit as ranges on the text as typed (`end` exclusive). */
export interface UnspacedHit {
  start: number;
  end: number;
  termId: string;
}

export interface Unspaced {
  /** The id of the first term that hits, or null. */
  first(raw: string): string | null;
  /** Every hit, as ranges on `raw`, in the order they were found (not merged). */
  hits(raw: string): UnspacedHit[];
}

const bucketOf = <T extends { text: string }>(items: readonly T[]): Map<number, T[]> => {
  const out = new Map<number, T[]>();
  for (const item of items) {
    const first = item.text.codePointAt(0) as number;
    const list = out.get(first);
    if (list === undefined) out.set(first, [item]);
    else list.push(item);
  }
  return out;
};

/**
 * Builds the unspaced half of a matcher, or null when there is no unspaced term. Throws MatcherBuildError when a `segment` term or an unspaced exception exists and this runtime has no `Intl.Segmenter` (a missing
 * capability is not silently weaker). Segmenters are made when a line first needs one and kept for this matcher, one per language.
 */
export function buildUnspaced(terms: readonly UnspacedTerm[], exceptions: readonly UnspacedException[]): Unspaced | null {
  if (terms.length === 0) return null;
  const needsSegmenter = terms.find((t) => t.mode === 'segment') ?? (exceptions.length > 0 ? terms[0] : undefined);
  if (needsSegmenter !== undefined && !hasSegmenter()) {
    throw new MatcherBuildError(
      `row ${needsSegmenter.id}: matching in a script written without spaces needs Intl.Segmenter, which this runtime does not have`,
      needsSegmenter.id,
      'needs Intl.Segmenter, which this runtime does not have',
    );
  }
  const byFirst = bucketOf(terms.map((t) => ({ ...t, text: t.term })));
  const exceptionsByFirst = bucketOf(exceptions.map((e) => ({ ...e, text: e.phrase })));
  const segmenters = new Map<string, Intl.Segmenter>();
  const segmenterOf = (language: string): Intl.Segmenter => {
    let found = segmenters.get(language);
    if (found === undefined) {
      found = new Intl.Segmenter(language, { granularity: 'word' });
      segmenters.set(language, found);
    }
    return found;
  };

  function search(raw: string, firstOnly: boolean): UnspacedHit[] {
    if (!mayHoldUnspaced(raw)) return [];
    const view = unspacedView(raw);
    const { folded, clusterStart } = view;
    const found: UnspacedHit[] = [];
    for (const [a, b] of runsOf(view.text)) {
      const edges = new Map<string, Set<number>>();
      const edgesOf = (language: string): Set<number> => {
        let set = edges.get(language);
        if (set === undefined) {
          set = new Set([a, b]);
          for (const s of segmenterOf(language).segment(view.text.slice(a, b))) {
            set.add(a + s.index);
            set.add(a + s.index + s.segment.length);
          }
          edges.set(language, set);
        }
        return set;
      };
      const onCluster = (at: number): boolean => at === view.text.length || clusterStart[at] === true;
      // Every occurrence of an exception phrase in this run whose own edges are segment edges: what a hit may sit inside.
      let covers: Array<[number, number]> | null = null;
      const coverage = (): Array<[number, number]> => {
        if (covers !== null) return covers;
        covers = [];
        for (let i = a; i < b; i += 1) {
          const list = exceptionsByFirst.get(folded.codePointAt(i) as number);
          if (list === undefined || !clusterStart[i]) continue;
          for (const e of list) {
            const end = i + e.phrase.length;
            if (end <= b && folded.startsWith(e.phrase, i) && onCluster(end) && edgesOf(e.language).has(i) && edgesOf(e.language).has(end)) covers.push([i, end]);
          }
        }
        return covers;
      };
      for (let i = a; i < b; i += 1) {
        if (!clusterStart[i]) continue;
        const list = byFirst.get(folded.codePointAt(i) as number);
        if (list === undefined) continue;
        for (const t of list) {
          const end = i + t.term.length;
          if (end > b || !folded.startsWith(t.term, i) || !onCluster(end)) continue;
          if (t.mode === 'segment') {
            const e = edgesOf(t.language);
            if (!e.has(i) || !e.has(end)) continue;
          }
          if (exceptions.length > 0 && coverage().some(([x, y]) => x <= i && end <= y)) continue;
          found.push({ start: view.from[i] as number, end: view.to[end - 1] as number, termId: t.id });
          if (firstOnly) return found;
        }
      }
    }
    return found;
  }

  return {
    first: (raw) => search(raw, true)[0]?.termId ?? null,
    hits: (raw) => search(raw, false),
  };
}
