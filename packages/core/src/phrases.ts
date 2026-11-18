import type { Matcher, ProfanityFilter } from './types.js';

// Phrase books: the text a phrase-only room (a context with `chat.phrases`) may say. The game declares them in code and the kit checks them once, at start-up: the grammar, the sizes and each phrase through the
// matcher and the profanity filter, so a game's own phrase list cannot contain a slur. A refusal names the book and the phrase id, never the text.

/** One phrase: a stable id, the canonical text (the game's default language: what evidence, moderators and a client with no translation see) and an optional group that heads a section in the picker. */
export interface Phrase {
  /** 1 to 32 of `A-Za-z0-9_-`, unique in its book. */
  id: string;
  /** 1 to 100 characters, no control or bidi characters. */
  text: string;
  /** 1 to 24 characters. */
  group?: string;
}

/** The phrases of one book, in the order the picker shows them. */
export type PhraseBook = readonly Phrase[];

/** The game's books by id (`^[a-z][a-z0-9_-]{0,31}$`). At most 20, each of at most 300 phrases. */
export type PhraseBooks = Readonly<Record<string, PhraseBook>>;

/** The most books a game may declare. */
export const MAX_PHRASE_BOOKS = 20;
/** The most phrases a book may hold. */
export const MAX_PHRASES_PER_BOOK = 300;
/** The longest phrase text, in characters. */
export const PHRASE_TEXT_MAX = 100;
/** The longest phrase group, in characters. */
export const PHRASE_GROUP_MAX = 24;

const BOOK_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const PHRASE_ID = /^[A-Za-z0-9_-]{1,32}$/;
// Control characters (C0, DEL, C1) and the bidirectional controls: the marks, the embeddings and overrides, and the isolates.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const PHRASE_KEYS = ['id', 'text', 'group'];

/**
 * A phrase book that cannot be used. `book` is the book id and `phraseId` the phrase's (null when the fault is the book's own: its size or its id); the message names them and never carries a phrase's text.
 * An id that is not itself well formed is not echoed: the message gives the phrase's place in the book instead.
 */
export class PhraseBookError extends Error {
  readonly book: string;
  readonly phraseId: string | null;
  constructor(book: string, phraseId: string | null, problem: string) {
    super(`phrase book ${book === '' ? '(unnamed)' : `"${book}"`}${phraseId === null ? '' : `, phrase "${phraseId}"`}: ${problem}`);
    this.name = 'PhraseBookError';
    this.book = book;
    this.phraseId = phraseId;
  }
}

/** What a book's phrases are looked up through at start-up: the matcher and every profanity filter in force (the base profile's and each context's). */
export interface PhraseScreens {
  matcher?: Matcher | undefined;
  filters?: readonly ProfanityFilter[] | undefined;
}

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** The phrase's own id when it is well formed, else its place, so a malformed id is never echoed. */
const nameOf = (id: unknown, index: number): string => (typeof id === 'string' && PHRASE_ID.test(id) ? id : `#${index + 1}`);

/**
 * Check the game's phrase books and return them as a new, frozen object that shares nothing with `input`. `undefined` is no books. Throws {@link PhraseBookError} for the first fault: a book id outside its grammar,
 * more than {@link MAX_PHRASE_BOOKS} books, more than {@link MAX_PHRASES_PER_BOOK} phrases in one, a phrase with a bad id, a duplicate id in its book, text that is empty, over {@link PHRASE_TEXT_MAX}, or holds a
 * control or bidi character, a bad group, a key it does not know, or (with `screens`) text that the matcher hits or a profanity filter flags (or a screen that throws: a phrase that could not be checked is not trusted).
 */
export function checkPhraseBooks(input: unknown, screens: PhraseScreens = {}): PhraseBooks {
  if (input === undefined) return Object.freeze({});
  if (!isPlain(input)) throw new PhraseBookError('', null, 'phrases must be an object of books by id');
  const ids = Object.keys(input);
  if (ids.length > MAX_PHRASE_BOOKS) throw new PhraseBookError('', null, `at most ${MAX_PHRASE_BOOKS} books may be declared`);
  const out: Record<string, readonly Phrase[]> = {};
  for (const bookId of ids) {
    if (!BOOK_ID.test(bookId)) throw new PhraseBookError('', null, 'a book id must be a lowercase letter, then lowercase letters, digits, _ or -, up to 32 characters');
    const raw = input[bookId];
    if (!Array.isArray(raw)) throw new PhraseBookError(bookId, null, 'a book must be a list of phrases');
    if (raw.length > MAX_PHRASES_PER_BOOK) throw new PhraseBookError(bookId, null, `a book holds at most ${MAX_PHRASES_PER_BOOK} phrases`);
    const seen = new Set<string>();
    const phrases: Phrase[] = [];
    raw.forEach((item: unknown, i) => {
      if (!isPlain(item)) throw new PhraseBookError(bookId, nameOf(undefined, i), 'a phrase must be an object');
      const name = nameOf(item.id, i);
      const fail = (problem: string): never => {
        throw new PhraseBookError(bookId, name, problem);
      };
      for (const key of Object.keys(item)) if (!PHRASE_KEYS.includes(key)) fail('a phrase has only id, text and group');
      const { id, text, group } = item;
      if (typeof id !== 'string' || !PHRASE_ID.test(id)) fail('the id must be 1 to 32 of A-Z a-z 0-9 _ -');
      if (seen.has(id as string)) fail('the id is used twice in this book');
      seen.add(id as string);
      if (typeof text !== 'string' || text.trim() === '' || text.length > PHRASE_TEXT_MAX) fail(`the text must be 1 to ${PHRASE_TEXT_MAX} characters`);
      if (FORBIDDEN.test(text as string)) fail('the text holds a control or direction character');
      if (group !== undefined && (typeof group !== 'string' || group === '' || group.length > PHRASE_GROUP_MAX || FORBIDDEN.test(group))) fail(`the group must be 1 to ${PHRASE_GROUP_MAX} characters with no control character`);
      screen(screens, text as string, () => fail('the text is not allowed here (the matcher or the profanity filter hit it)'), () => fail('the text could not be checked'));
      phrases.push(Object.freeze(group === undefined ? { id: id as string, text: text as string } : { id: id as string, text: text as string, group: group as string }));
    });
    Object.defineProperty(out, bookId, { value: Object.freeze(phrases), enumerable: true, writable: true, configurable: true });
  }
  return Object.freeze(out);
}

/** Run one text through the screens: `hit` when one refuses it, `broken` when one throws or answers something that is not a verdict. */
function screen(screens: PhraseScreens, text: string, hit: () => never, broken: () => never): void {
  try {
    if (screens.matcher !== undefined && screens.matcher.match(text) !== null) return hit();
    for (const filter of screens.filters ?? []) {
      const verdict: unknown = filter.apply(text);
      if (typeof verdict !== 'object' || verdict === null || typeof (verdict as { hit?: unknown }).hit !== 'boolean') return broken();
      if ((verdict as { hit: boolean }).hit) return hit();
    }
  } catch (err) {
    // `hit` and `broken` throw PhraseBookError from inside the try: let those through, treat anything else as a screen that failed.
    if (err instanceof PhraseBookError) throw err;
    broken();
  }
}
