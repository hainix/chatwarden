import { INNOCENT_TOP_RANK, innocentRank, ordinaryIn, wordsContaining } from './dictionary.js';
import type { D1Like } from './env.js';
import { MIN_KEY_LENGTH, SUPPORTED_LANGUAGES, plainWord, wordKey } from './wordkey.js';

// The shared gate logic (design 10.1 step 4, 13). Cheap checks only: they run on arrival and again in the release builder. Every refusal is a
// closed code; no code, message or result ever holds the word. Nothing here throws for odd input (a database failure is the one exception: it
// propagates as the database's error, which never carries the word either).

export { SUPPORTED_LANGUAGES };

export const CATEGORIES: readonly string[] = ['slur', 'abuse', 'sexual', 'other'];
export const TARGETS: readonly string[] = ['none', 'ethnicity', 'religion', 'gender', 'sexuality', 'disability', 'nationality', 'other'];
export const NOTE_MAX = 200;
/** The most negative lines the cross-language gate returns for one term. */
export const MAX_NEGATIVES = 200;

// The share client's rule (corpus/share.ts), here as the service's own: a scheme, `www.`, or a bare host under a common top-level domain.
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|gg|me|tv|co|ly|xyz|info|app|gl|to|us|uk|de|fr|es|pt|br|ru|cn|jp|ca|au)\b/i;
// A control character, plus what could make a reviewer's screen lie: C1 controls, line and paragraph separators, and the bidi controls.
// eslint-disable-next-line no-control-regex -- control characters in a note are refused
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/;

/**
 * The note, cleaned: null for none (missing, null or blank), the trimmed text for a good note, undefined for a refusal. Design 6.8: at most
 * 200 characters, no control character, no `@`, no run of more than 4 digits, no URL. The `@`, digit and URL checks run on the NFKC form,
 * so a full-width `@` or a compatibility digit does not get round them.
 */
export function readNote(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '') return null;
  if (t.length > NOTE_MAX || CONTROL_RE.test(t)) return undefined;
  const n = t.normalize('NFKC');
  if (n.includes('@') || /\p{Nd}{5,}/u.test(n) || URL_RE.test(n)) return undefined;
  return t;
}

/** Why a submission is refused at arrival. `invalid` and `unsupported_language` are `400`s; `known_innocent` is a decline. */
export type ArrivalCode = 'invalid' | 'unsupported_language' | 'known_innocent';

export type ArrivalResult =
  | { ok: true; wordKey: string; term: string; language: string; category: string; target: string; note: string | null }
  | { ok: false; code: ArrivalCode };

const refuse = (code: ArrivalCode): ArrivalResult => ({ ok: false, code });

/** The fields of a submission, cleaned. */
export interface Fields {
  wordKey: string;
  term: string;
  language: string;
  category: string;
  target: string;
  note: string | null;
}

/**
 * The checks that need no database: the fields against the closed lists, the term against the plain-word rule, the note against the note
 * rules, the language against the supported ones. Each field is read once. Never throws.
 */
export function readFields(input: unknown): { ok: true; fields: Fields } | { ok: false; code: 'invalid' | 'unsupported_language' } {
  let term: unknown;
  let language: unknown;
  let category: unknown;
  let target: unknown;
  let note: unknown;
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'invalid' };
    const o = input as Record<string, unknown>;
    term = o.term;
    language = o.language;
    category = o.category;
    target = o.target;
    note = o.note;
  } catch {
    return { ok: false, code: 'invalid' };
  }
  const word = plainWord(term);
  if (word === null) return { ok: false, code: 'invalid' };
  if (typeof language !== 'string' || !/^[a-z]{2,3}$/.test(language)) return { ok: false, code: 'invalid' };
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) return { ok: false, code: 'invalid' };
  const aim = target === undefined ? 'none' : target;
  if (typeof aim !== 'string' || !TARGETS.includes(aim)) return { ok: false, code: 'invalid' };
  const text = readNote(note);
  if (text === undefined) return { ok: false, code: 'invalid' };
  if (!SUPPORTED_LANGUAGES.includes(language)) return { ok: false, code: 'unsupported_language' };
  return { ok: true, fields: { wordKey: wordKey(word), term: word, language, category, target: aim, note: text } };
}

/** Whether a word key is in the top-ranked ordinary words of its language. */
export async function isKnownInnocent(db: D1Like, language: string, key: string): Promise<boolean> {
  const rank = await innocentRank(db, language, key);
  return rank !== null && rank <= INNOCENT_TOP_RANK;
}

/** The arrival gate: {@link readFields}, then the top-ranked innocent words of the language. */
export async function arrivalGate(input: unknown, db: D1Like): Promise<ArrivalResult> {
  const read = readFields(input);
  if (!read.ok) return refuse(read.code);
  const { fields } = read;
  if (await isKnownInnocent(db, fields.language, fields.wordKey)) return refuse('known_innocent');
  return { ok: true, ...fields };
}

/** What the cross-language gate finds for a candidate term. */
export interface CrossLanguage {
  /** Supported languages (other than the term's own) in which this spelling is an ordinary word, sorted. */
  collidesWith: string[];
  /** Dictionary words, in any supported language, that equal or contain the term (as word keys): lines that must never be blocked. */
  negatives: string[];
}

/**
 * The cross-language gate (design 13). The matcher does not use `language`, so a term that is an ordinary word of another installed language
 * would block that language's chat: `collidesWith` names those languages (the loader turns the row off when one is installed), and
 * `negatives` lists the dictionary words that equal the term after collapsing, or contain it, for the builder's gate to prove are not blocked.
 * A candidate that is not a plain word of three letters or more answers empty.
 */
export async function crossLanguageGate(candidate: { term: string; languages: readonly string[] }, db: D1Like): Promise<CrossLanguage> {
  const empty: CrossLanguage = { collidesWith: [], negatives: [] };
  let key: string;
  let own: string[];
  try {
    key = wordKey(candidate.term);
    own = Array.isArray(candidate.languages) ? candidate.languages.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return empty;
  }
  if (key.length < MIN_KEY_LENGTH || !/^[a-z]+$/.test(key)) return empty;
  const [collidesWith, negatives] = await Promise.all([ordinaryIn(db, key, own), wordsContaining(db, key, MAX_NEGATIVES)]);
  return { collidesWith, negatives };
}
