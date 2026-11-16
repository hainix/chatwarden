import { crossLanguageGate } from '../gates.js';
import type { D1Like } from '../env.js';
import { SUPPORTED_LANGUAGES } from '../wordkey.js';

// What the release builder reads from the database, as plain data (design 6.9). Reading is the only thing that touches D1; the build itself
// (release.ts, gates.ts) is a pure function of this snapshot, so it can be tested without a database and run on a copy of one.

/** One dictionary word that equals or contains a term, and the supported languages it is an ordinary word in. */
export interface DictionaryWord {
  word: string;
  languages: string[];
}

/** A term row as the database holds it, with what the cross-language gate says about it now. */
export interface TermRecord {
  id: string;
  wordKey: string;
  term: string;
  languages: string[];
  category: string;
  target: string;
  severity: string;
  status: string;
  defaultActive: boolean;
  /** What the row says (`terms.collides_with`). */
  storedCollidesWith: string[];
  /** What the dictionary says now (the other supported languages in which the word is ordinary). */
  freshCollidesWith: string[];
  since: string | null;
  approvals: number;
  /** Lines from `term_lines`, of any origin. */
  positiveLines: string[];
  negativeLines: string[];
  /** The dictionary words that equal or contain the term (best first), with their languages. */
  dictionary: DictionaryWord[];
}

export interface Snapshot {
  terms: TermRecord[];
  /** The whole negative corpus by language (`negative_lines`), sorted. */
  negativeCorpus: Record<string, string[]>;
}

interface TermRow {
  id: string;
  word_key: string;
  term: string;
  languages: string;
  category: string;
  target: string;
  severity: string;
  status: string;
  default_active: number;
  collides_with: string;
  since: string | null;
  approvals: number;
}

function jsonList(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Reads the terms, their lines, the dictionary words around each, and the negative corpus. Rows are in id order, so the snapshot is stable. */
export async function loadSnapshot(db: D1Like, languages: readonly string[] = SUPPORTED_LANGUAGES): Promise<Snapshot> {
  const rows = (await db.prepare('SELECT id, word_key, term, languages, category, target, severity, status, default_active, collides_with, since, approvals FROM terms ORDER BY id').all<TermRow>()).results;
  const lines = (await db.prepare('SELECT term_id, kind, line FROM term_lines ORDER BY term_id, kind, line').all<{ term_id: string; kind: string; line: string }>()).results;
  const byTerm = new Map<string, { positive: string[]; negative: string[] }>();
  for (const l of lines) {
    const entry = byTerm.get(l.term_id) ?? { positive: [], negative: [] };
    (l.kind === 'positive' ? entry.positive : entry.negative).push(l.line);
    byTerm.set(l.term_id, entry);
  }
  const wordLanguages = new Map<string, string[]>();
  const languagesOf = async (word: string): Promise<string[]> => {
    const known = wordLanguages.get(word);
    if (known !== undefined) return known;
    const res = await db.prepare('SELECT language FROM innocent_words WHERE word_key = ? ORDER BY language').bind(word).all<{ language: string }>();
    const list = res.results.map((r) => r.language);
    wordLanguages.set(word, list);
    return list;
  };
  const terms: TermRecord[] = [];
  for (const r of rows) {
    const own = jsonList(r.languages);
    const gate = await crossLanguageGate({ term: r.term, languages: own }, db);
    const dictionary: DictionaryWord[] = [];
    for (const word of gate.negatives) dictionary.push({ word, languages: await languagesOf(word) });
    const mine = byTerm.get(r.id);
    terms.push({
      id: r.id,
      wordKey: r.word_key,
      term: r.term,
      languages: own,
      category: r.category,
      target: r.target,
      severity: r.severity,
      status: r.status,
      defaultActive: r.default_active === 1,
      storedCollidesWith: jsonList(r.collides_with),
      freshCollidesWith: gate.collidesWith,
      since: r.since,
      approvals: r.approvals,
      positiveLines: mine?.positive ?? [],
      negativeLines: mine?.negative ?? [],
      dictionary,
    });
  }
  const negativeCorpus: Record<string, string[]> = {};
  for (const language of languages) {
    const res = await db.prepare('SELECT line FROM negative_lines WHERE language = ? ORDER BY line').bind(language).all<{ line: string }>();
    negativeCorpus[language] = res.results.map((x) => x.line);
  }
  return { terms, negativeCorpus };
}
