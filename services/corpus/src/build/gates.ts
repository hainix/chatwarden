import { buildMatcher, type Matcher } from '@chatwarden/matcher';
import { releaseToPack, type TermsRelease } from '@chatwarden/matcher/corpus';
import { wordKey } from '../wordkey.js';
import type { TermRecord } from './snapshot.js';

// The release gates (design 6.6, 7, 13), run with the real matcher over what the kit will read: the parsed release, not the builder's own rows.
// A release is judged the way a game's loader would use it, in every selection of the languages the release lists (`releaseToPack` is the
// kit's own selection, so a row is on or off exactly as it would be in a store): a row whose spelling is an ordinary word of an installed
// language is off, so it is not asked to leave that language's words alone, and it is asked to when that language is not installed.
//
// What is checked, and what a failure holds out of the release (a closed code, never a word):
// - `positive_not_blocked`: a row's own `positive` line that the row's term does not block.
// - `negative_blocked`: a row's own `negative` line (other than the word itself) that the row's term blocks.
// - `negative_corpus_blocked`: a line of the negative corpus of an installed language that the active pack blocks. The corpus is the whole
//   set in the database, not only the 2 000 lines a file carries; the file is checked by being a part of it.
// - `innocent_word_blocked`: a dictionary word that equals or contains a term, in an installed language, that the active pack blocks.
// Every line of `positive.json` must be blocked by the pack of all the release's languages.

export type GateCode = 'positive_not_blocked' | 'negative_blocked' | 'negative_corpus_blocked' | 'innocent_word_blocked';

export interface GateFailure {
  id: string;
  code: GateCode;
}

export interface GateCounts {
  positiveLines: number;
  negativeLines: number;
  crossLanguageLines: number;
}

export interface GateReport {
  failures: GateFailure[];
  counts: GateCounts;
}

export interface GateInput {
  release: TermsRelease;
  /** The database rows by id, for the dictionary words around each term. */
  records: ReadonlyMap<string, TermRecord>;
  /** The whole negative corpus by language. */
  negativeCorpus: Readonly<Record<string, readonly string[]>>;
  /** Which term each line of positive.json came from (a failing line holds that term). */
  positiveOwner: ReadonlyMap<string, string>;
  languages: readonly string[];
}

/** Thrown for a failure that no row can be held for (the pack does not load, a pack-wide line has no owner). The builder turns it into a BuildError. */
export class GateFault extends Error {
  constructor() {
    super('the gates could not be run');
    this.name = 'GateFault';
  }
}

const SELECTABLE = new Set(['accepted', 'provisional']);

/** Every non-empty set of the languages (up to four languages), or each one alone and all together. In a fixed order. */
export function languageSelections(languages: readonly string[]): string[][] {
  const n = languages.length;
  if (n === 0) return [];
  if (n > 4) return [...languages.map((l) => [l]), [...languages]];
  const out: string[][] = [];
  for (let mask = 1; mask < 1 << n; mask += 1) out.push(languages.filter((_, i) => (mask & (1 << i)) !== 0));
  return out;
}

export function runGates(input: GateInput): GateReport {
  const failures = new Map<string, GateCode>();
  const fail = (id: string, code: GateCode): void => {
    if (!failures.has(id)) failures.set(id, code);
  };
  let positiveLines = 0;
  let negativeLines = 0;

  // 1. Each row against its own term alone.
  for (const row of input.release.terms) {
    if (!SELECTABLE.has(row.status)) continue;
    const own = buildMatcher([{ id: row.id, term: row.term, language: 'en', active: true }], []);
    const key = wordKey(row.term);
    for (const line of row.positive) {
      positiveLines += 1;
      if (own.match(line) === null) fail(row.id, 'positive_not_blocked');
    }
    for (const line of row.negative) {
      if (wordKey(line) === key) continue; // the word itself, in a language where it is ordinary: the selections below judge it
      negativeLines += 1;
      if (own.match(line) !== null) fail(row.id, 'negative_blocked');
    }
  }

  // 2. The active pack of each selection of languages.
  const selections = languageSelections(input.languages);
  const all = selections[selections.length - 1] ?? [];
  const dictionary = new Map<string, Set<string>>();
  for (const row of input.release.terms) {
    for (const entry of input.records.get(row.id)?.dictionary ?? []) {
      const set = dictionary.get(entry.word) ?? new Set<string>();
      for (const l of entry.languages) set.add(l);
      dictionary.set(entry.word, set);
    }
  }
  let corpusLines = 0;
  let dictionaryLines = 0;
  for (const selected of selections) {
    let matcher: Matcher;
    try {
      const pack = releaseToPack(input.release, { languages: selected, minSeverity: 'rude' });
      matcher = buildMatcher(pack.terms, pack.exceptions);
    } catch {
      throw new GateFault();
    }
    const isAll = selected.length === all.length;
    const corpus = new Set(selected.flatMap((l) => input.negativeCorpus[l] ?? []));
    if (isAll) corpusLines = corpus.size;
    for (const line of corpus) {
      const hit = matcher.match(line);
      if (hit !== null) fail(hit.termId, 'negative_corpus_blocked');
    }
    let words = 0;
    for (const [word, languages] of dictionary) {
      if (![...languages].some((l) => selected.includes(l))) continue;
      words += 1;
      const hit = matcher.match(word);
      if (hit !== null) fail(hit.termId, 'innocent_word_blocked');
    }
    if (isAll) dictionaryLines = words;
    if (isAll) {
      for (const line of input.release.positive) {
        positiveLines += 1;
        if (matcher.match(line) === null) {
          const owner = input.positiveOwner.get(line);
          if (owner === undefined) throw new GateFault();
          fail(owner, 'positive_not_blocked');
        }
      }
    }
  }
  negativeLines += corpusLines;
  const list = [...failures].map(([id, code]) => ({ id, code })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { failures: list, counts: { positiveLines, negativeLines, crossLanguageLines: dictionaryLines } };
}
