import { stripInvisible } from '@chatwarden/matcher';

// checkCase (design 12): the privacy rules for an eval or calibration case that came from real chat, run before a reviewer sees it and again at
// build time. A case is a paraphrase kept in shape only: who said what in what order, how severe, which rule. It never carries who the people were,
// how to reach them, or the original wording. The answer is a list of closed codes; nothing returned or thrown ever quotes a line.
//
// - `identifier`: a speaker that is not one of `reported`, `reporter`, `other`; or text that holds an IP address, a number longer than 4 digits (an id,
//   an account, a phone-length run), a time of day, a date, a `name#1234` tag, a UUID or a long hex token.
// - `contact`: a URL, an email address, an `@` mention, a phone number, an invite or party code, a street address.
// - `too_long`: more than 12 lines, a line over 200 characters, a note over 500. The one exception is the repo's own `synthetic` `long-room` cases,
//   which may have 64 lines (the eval tests choosing lines out of a long chat); a contributed case never is.
// - `copy_of_source`: a line that equals a line of the source it was paraphrased from (ignoring case, spacing, punctuation and accents).
// - `unknown_term`: a line marked `blocked` that the corpus does not block, so a case never introduces a word the term review has not seen. Needs
//   `options.corpus`; without one this check is not made.
// What it cannot see is a name written in words; that is the reviewer's check ("after", design 12).

export type CaseCode = 'identifier' | 'contact' | 'too_long' | 'copy_of_source' | 'unknown_term';

export const MAX_CASE_LINES = 12;
export const MAX_LONG_ROOM_LINES = 64;
export const MAX_CASE_LINE = 200;
export const MAX_CASE_NOTE = 500;

const ORDER: readonly CaseCode[] = ['identifier', 'contact', 'too_long', 'copy_of_source', 'unknown_term'];
const SPEAKERS = ['reported', 'reporter', 'other'];

// What counts as a URL: the share client's rule (a scheme, `www.`, or a bare host under a common top-level domain).
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|gg|me|tv|co|ly|xyz|info|app|gl|to|us|uk|de|fr|es|pt|br|ru|cn|jp|ca|au)\b/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE = /(?:\+?\d[\s().-]*){7,}/;
const INVITE_RE = /\b(?:invite|join|party|lobby)\s*(?:code|link)\s*[:=]?\s*[a-z0-9]{4,}/i;
const ADDRESS_RE = /\b\d{1,5}\s+(?:[a-z]+\s+){1,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr)\b/i;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{0,4}\b/i;
const LONG_NUMBER_RE = /\p{Nd}{5,}/u;
const TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const TAG_RE = /\w+#\d{3,}/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const HEX_TOKEN_RE = /\b[0-9a-f]{16,}\b/i;

/** What the pattern checks read: compatibility forms folded (full-width digits and dots), hidden characters removed. */
const plain = (text: string): string => stripInvisible(text.normalize('NFKC'));

/** The comparison form for the copy check. */
const comparable = (text: string): string => plain(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

interface Line {
  who: unknown;
  text: string;
  blocked?: unknown;
}

function linesOf(v: unknown): Line[] | null {
  if (!Array.isArray(v)) return null;
  const out: Line[] = [];
  for (const raw of v as unknown[]) {
    if (typeof raw !== 'object' || raw === null || typeof (raw as { text?: unknown }).text !== 'string') return null;
    out.push(raw as Line);
  }
  return out;
}

/** What a case's source is made of: a case-like object's line texts, or a list of strings. */
function sourceLines(source: unknown): string[] {
  if (Array.isArray(source)) return source.filter((s): s is string => typeof s === 'string');
  if (typeof source === 'object' && source !== null) {
    const lines = linesOf((source as { lines?: unknown }).lines);
    return lines === null ? [] : lines.map((l) => l.text);
  }
  return [];
}

export interface CheckOptions {
  /** The corpus's matcher: with it a line marked `blocked` must be blocked by it. */
  corpus?: { match(text: string): { termId: string } | null };
}

export type CaseCheck = { ok: true } | { ok: false; codes: CaseCode[] };

export function checkCase(input: unknown, source?: unknown, options: CheckOptions = {}): CaseCheck {
  const found = new Set<CaseCode>();
  const lines = typeof input === 'object' && input !== null ? linesOf((input as { lines?: unknown }).lines) : null;
  if (lines === null) return { ok: false, codes: ['identifier'] };
  const c = input as { note?: unknown; reason?: unknown; group?: unknown; meta?: { source?: unknown } };

  // The repo's own long-room cases (synthetic) may be long; nothing else may.
  const longRoom = c.group === 'long-room' && typeof c.meta === 'object' && c.meta !== null && c.meta.source === 'synthetic';
  if (lines.length > (longRoom ? MAX_LONG_ROOM_LINES : MAX_CASE_LINES)) found.add('too_long');

  const texts = lines.map((l) => l.text);
  if (typeof c.note === 'string') texts.push(c.note);
  if (typeof c.note === 'string' && c.note.length > MAX_CASE_NOTE) found.add('too_long');
  // The reason and the group are published as free strings too: the same patterns run over them (after the lines and the note, so the line order holds).
  for (const extra of [c.reason, c.group]) if (typeof extra === 'string') texts.push(extra);
  for (const l of lines) {
    if (typeof l.who !== 'string' || !SPEAKERS.includes(l.who)) found.add('identifier');
    if (l.text.length > MAX_CASE_LINE) found.add('too_long');
  }
  for (const raw of texts) {
    const t = plain(raw);
    if (IPV4_RE.test(t) || IPV6_RE.test(t) || LONG_NUMBER_RE.test(t) || TIME_RE.test(t) || DATE_RE.test(t) || TAG_RE.test(t) || UUID_RE.test(t) || HEX_TOKEN_RE.test(t)) found.add('identifier');
    if (URL_RE.test(t) || EMAIL_RE.test(t) || t.includes('@') || PHONE_RE.test(t) || INVITE_RE.test(t) || ADDRESS_RE.test(t)) found.add('contact');
  }

  if (source !== undefined) {
    const theirs = new Set(sourceLines(source).map(comparable).filter((s) => s !== ''));
    if (texts.slice(0, lines.length).some((t) => theirs.has(comparable(t)))) found.add('copy_of_source');
  }
  const corpus = options.corpus;
  if (corpus !== undefined && lines.some((l) => l.blocked === true && corpus.match(l.text) === null)) found.add('unknown_term');

  return found.size === 0 ? { ok: true } : { ok: false, codes: ORDER.filter((code) => found.has(code)) };
}
