import {
  buildMatcher,
  MatcherBuildError,
  type ExceptionRow,
  type TermRow,
} from './matcher.js';
import { collapseLikePreset, foldTerm } from './normalise.js';

/**
 * A term pack: the starter list an adopter ships, with the lines that prove it works.
 * `positive` lines must be blocked by their term; `negative` lines must never be blocked.
 * `negativeCorpus` is lines known to be fine (the "would have blocked" check runs a candidate term
 * against them); `knownLosses` are lines the list accepts blocking, so that check leaves them out.
 */
export interface TermPack {
  id: string;
  version: string;
  terms: (TermRow & { positive: string[]; negative: string[] })[];
  exceptions: ExceptionRow[];
  negativeCorpus: string[];
  knownLosses: string[];
}

// Every message below names a path (`terms[3]`) or a row id, never a term, a phrase or a line: a pack's
// content is the very thing logs must not carry, and these errors get logged.

const TOP_KEYS = ['id', 'version', 'terms', 'exceptions', 'negativeCorpus', 'knownLosses'];
const TERM_KEYS = ['id', 'term', 'language', 'active', 'positive', 'negative'];
const EXCEPTION_KEYS = ['id', 'phrase', 'language', 'active'];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function stringList(v: unknown, path: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`${path} must be an array of strings`);
  }
  return [...(v as string[])];
}

/** The fields every row has: a non-empty id, a non-empty language and an optional boolean `active`. */
function rowBase(row: unknown, path: string, allowed: string[]): Record<string, unknown> & { id: string; language: string; active: boolean } {
  if (!isObject(row)) throw new Error(`${path} must be an object`);
  if (Object.keys(row).some((k) => !allowed.includes(k))) throw new Error(`${path} has an unknown key`);
  if (!isText(row.id)) throw new Error(`${path}.id must be a non-empty string`);
  if (typeof row.language !== 'string' || row.language.trim().length === 0) {
    throw new Error(`${path}.language must be a non-empty string`);
  }
  if (row.active !== undefined && typeof row.active !== 'boolean') {
    throw new Error(`${path}.active must be a boolean when present`);
  }
  return { ...row, id: row.id, language: row.language, active: row.active ?? true };
}

/**
 * Validates untrusted JSON as a {@link TermPack} and returns a copy. Strict: unknown keys are rejected,
 * every row id is unique across terms and exceptions, languages are non-empty, and the terms and
 * exceptions must build. Throws an Error whose message never quotes a term. Fetching a pack and
 * checking its signature happen elsewhere (K7).
 */
export function loadTermPack(json: unknown): TermPack {
  if (!isObject(json)) throw new Error('pack must be an object');
  if (Object.keys(json).some((k) => !TOP_KEYS.includes(k))) throw new Error('pack has an unknown top-level key');
  for (const key of TOP_KEYS) {
    if (json[key] === undefined) throw new Error(`pack.${key} is required`);
  }
  if (!isText(json.id)) throw new Error('pack.id must be a non-empty string');
  if (!isText(json.version)) throw new Error('pack.version must be a non-empty string');
  if (!Array.isArray(json.terms)) throw new Error('pack.terms must be an array');
  if (!Array.isArray(json.exceptions)) throw new Error('pack.exceptions must be an array');

  const terms = json.terms.map((raw: unknown, i: number): TermPack['terms'][number] => {
    const path = `terms[${i}]`;
    const row = rowBase(raw, path, TERM_KEYS);
    if (!isText(row.term)) throw new Error(`${path}.term must be a non-empty string`);
    return {
      id: row.id,
      term: row.term,
      language: row.language,
      active: row.active,
      positive: stringList(row.positive ?? undefined, `${path}.positive`),
      negative: stringList(row.negative ?? undefined, `${path}.negative`),
    };
  });
  const exceptions = json.exceptions.map((raw: unknown, i: number): ExceptionRow => {
    const path = `exceptions[${i}]`;
    const row = rowBase(raw, path, EXCEPTION_KEYS);
    if (!isText(row.phrase)) throw new Error(`${path}.phrase must be a non-empty string`);
    return { id: row.id, phrase: row.phrase, language: row.language, active: row.active };
  });
  const negativeCorpus = stringList(json.negativeCorpus, 'pack.negativeCorpus');
  const knownLosses = stringList(json.knownLosses, 'pack.knownLosses');

  const seen = new Set<string>();
  for (const row of [...terms, ...exceptions]) {
    if (seen.has(row.id)) throw new Error(`duplicate row id "${row.id}"`);
    seen.add(row.id);
  }

  // Not rethrown with `cause`: the build error's message quotes the term.
  let unbuildable: string | undefined;
  try {
    buildMatcher(terms, exceptions);
  } catch (err) {
    if (!(err instanceof MatcherBuildError)) throw err;
    unbuildable = `row ${err.rowId ?? '?'} is malformed: ${err.reason ?? 'invalid'}`;
  }
  if (unbuildable !== undefined) throw new Error(unbuildable);

  const byWord = new Map<string, number>();
  terms.forEach((t, i) => {
    const key = collapseLikePreset(foldTerm(t.term));
    const first = byWord.get(key);
    if (first !== undefined) throw new Error(`terms[${i}] reads as the same word as terms[${first}]`);
    byWord.set(key, i);
  });

  return { id: json.id, version: json.version, terms, exceptions, negativeCorpus, knownLosses };
}
