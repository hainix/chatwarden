import type { D1Like } from './env.js';
import { SUPPORTED_LANGUAGES, wordKey } from './wordkey.js';

// The innocent-word dictionary (table `innocent_words`): ordinary words per language, by word key, with an optional frequency rank
// (1 is the most common). The repo holds no dictionary; the owner imports one into D1 with `loadInnocentWords`. Two uses: a word in the
// top ranks of a language is auto-declined on arrival, and the cross-language gate asks which languages a spelling is ordinary in.

/** A word whose rank in its own language is this or better (lower) is "known innocent": a common word is never a term. */
export const INNOCENT_TOP_RANK = 5000;

const BATCH = 100;

/** The rank of a word key in a language: the number, or null for a word with no rank or one that is not in the dictionary. */
export async function innocentRank(db: D1Like, language: string, key: string): Promise<number | null> {
  const row = await db.prepare('SELECT rank FROM innocent_words WHERE language = ? AND word_key = ?').bind(language, key).first<{ rank: number | null }>();
  return row === null ? null : row.rank;
}

/** The supported languages (other than `except`) in which `key` is an ordinary word, sorted. */
export async function ordinaryIn(db: D1Like, key: string, except: readonly string[]): Promise<string[]> {
  const languages = SUPPORTED_LANGUAGES.filter((l) => !except.includes(l));
  if (languages.length === 0) return [];
  const marks = languages.map(() => '?').join(',');
  const res = await db.prepare(`SELECT DISTINCT language FROM innocent_words WHERE word_key = ? AND language IN (${marks}) ORDER BY language`).bind(key, ...languages).all<{ language: string }>();
  return res.results.map((r) => r.language);
}

/**
 * Dictionary words (any supported language) that equal or contain `key`: the key itself first, then by best rank (unranked last), then
 * alphabetically; at most `limit`. `key` must be plain letters (the caller checks); it is bound, never spliced into the statement.
 */
export async function wordsContaining(db: D1Like, key: string, limit: number): Promise<string[]> {
  const marks = SUPPORTED_LANGUAGES.map(() => '?').join(',');
  const res = await db
    .prepare(
      `SELECT word_key, MIN(rank) AS best FROM innocent_words WHERE language IN (${marks}) AND instr(word_key, ?) > 0
       GROUP BY word_key ORDER BY (word_key = ?) DESC, (best IS NULL), best, word_key LIMIT ?`,
    )
    .bind(...SUPPORTED_LANGUAGES, key, key, limit)
    .all<{ word_key: string }>();
  return res.results.map((r) => r.word_key);
}

/**
 * Imports words into a language's dictionary. Each word is stored under its key; a word that is not plain letters once its accents are
 * off is skipped; a key seen twice keeps its best rank. Returns how many distinct keys were stored.
 */
export async function loadInnocentWords(db: D1Like, language: string, words: readonly { word: string; rank?: number }[]): Promise<number> {
  if (!SUPPORTED_LANGUAGES.includes(language)) throw new RangeError('loadInnocentWords: language is not supported');
  const best = new Map<string, number | null>();
  for (const { word, rank } of words) {
    const key = wordKey(word);
    if (!/^[a-z]+$/.test(key)) continue;
    const r = typeof rank === 'number' && Number.isInteger(rank) && rank >= 1 ? rank : null;
    const had = best.get(key);
    best.set(key, had === undefined ? r : had === null ? r : r === null ? had : Math.min(had, r));
  }
  const rows = [...best];
  const upsert =
    'INSERT INTO innocent_words (language, word_key, rank) VALUES (?, ?, ?) ON CONFLICT (language, word_key) DO UPDATE SET rank = ' +
    'CASE WHEN excluded.rank IS NULL THEN rank WHEN rank IS NULL THEN excluded.rank ELSE MIN(rank, excluded.rank) END';
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.batch(rows.slice(i, i + BATCH).map(([key, rank]) => db.prepare(upsert).bind(language, key, rank)));
  }
  return rows.length;
}
