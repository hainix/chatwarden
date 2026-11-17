import type { ResolvedPersonalInfo } from '../filters.js';
import { dotAt } from './chars.js';
import type { FilterSpan } from './fold.js';
import { CONTACT_LEADS, STREET_WORDS, STRONG_TLDS, WEAK_TLDS } from './lists.js';

// Personal details in a line: an email address, a phone number, a card number, a "find me on" line, and (as a heuristic that can only
// count or flag) a street address. Every detector is a hand-written forward scan, linear in the line, with no regular expression built
// from data. A detector only says where; what to do about it is the settings' business.

/** At most this many characters of a line are read. */
export const PERSONAL_LINE_CAP = 2000;
/** At most this many details are returned for one line. */
export const PERSONAL_MATCH_CAP = 50;

/** Test hook: how many characters the detectors have looked at, so a test can show the work is linear. */
export const __personalSteps = { n: 0 };

export type PersonalDetail = 'phone' | 'email' | 'card' | 'contact' | 'address';
export interface PersonalMatch {
  detail: PersonalDetail;
  span: FilterSpan;
}

/** One character that is a letter of any script (a single reviewed literal; only asked about characters outside ASCII). */
const LETTER = /^\p{L}$/u;

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isAsciiLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAsciiAlnum = (c: number): boolean => isDigit(c) || isAsciiLetter(c);

/** A letter or digit at `i` (any script), for "is this glued to a word?". */
function wordAt(t: string, i: number): boolean {
  if (i < 0 || i >= t.length) return false;
  const c = t.charCodeAt(i);
  if (c < 0x80) return isAsciiAlnum(c);
  const cp = t.codePointAt(i)!;
  // The low half of a surrogate pair is looked at as its whole character.
  if (c >= 0xdc00 && c <= 0xdfff) return i > 0 && wordAt(t, i - 1);
  return LETTER.test(String.fromCodePoint(cp));
}

const isSpace = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0;

function tldOk(label: string): boolean {
  const l = label.toLowerCase();
  return STRONG_TLDS.has(l) || WEAK_TLDS.has(l);
}

// ---------------------------------------------------------------------------------------------------------------
// Email

const isLocalChar = (c: number): boolean => isAsciiAlnum(c) || c === 0x2e || c === 0x5f || c === 0x2b || c === 0x2d || c === 0x25;
const LOCAL_MAX = 64;
const DOMAIN_MAX = 255;

/** The domain labels read from `from` on: `name.name.tld` with plain dots. Returns where the last label ends, or -1. */
function plainDomainEnd(t: string, from: number): number {
  let k = from;
  while (k < t.length && k - from < DOMAIN_MAX) {
    __personalSteps.n++;
    const c = t.charCodeAt(k);
    if (isAsciiAlnum(c) || c === 0x2d || c === 0x2e) k++;
    else break;
  }
  while (k > from && (t.charCodeAt(k - 1) === 0x2e || t.charCodeAt(k - 1) === 0x2d)) k--;
  const labels = t.slice(from, k).split('.');
  if (labels.length < 2) return -1;
  for (const label of labels) if (label.length === 0 || label.length > 63) return -1;
  return tldOk(labels[labels.length - 1]!) ? k : -1;
}

/** `[at]`, `(at)` or `{at}` at `i` (any case): 4, else 0. */
function atWordAt(t: string, i: number): number {
  const open = t.charCodeAt(i);
  if (!(open === 0x5b || open === 0x28 || open === 0x7b)) return 0;
  if (t.slice(i + 1, i + 3).toLowerCase() !== 'at') return 0;
  const close = t.charCodeAt(i + 3);
  return (open === 0x5b && close === 0x5d) || (open === 0x28 && close === 0x29) || (open === 0x7b && close === 0x7d) ? 4 : 0;
}

function skipSpaces(t: string, i: number): number {
  let k = i;
  while (k < t.length && k - i < 3 && isSpace(t.charCodeAt(k))) k++;
  return k;
}

function scanEmails(t: string, out: PersonalMatch[]): void {
  for (let i = 0; i < t.length && out.length < PERSONAL_MATCH_CAP; i++) {
    __personalSteps.n++;
    const c = t.charCodeAt(i);
    if (c === 0x40) {
      let ls = i;
      while (ls > 0 && i - ls < LOCAL_MAX && isLocalChar(t.charCodeAt(ls - 1))) {
        __personalSteps.n++;
        ls--;
      }
      // A local part starts with a letter, digit or underscore, not a dot or a sign.
      while (ls < i && !(isAsciiAlnum(t.charCodeAt(ls)) || t.charCodeAt(ls) === 0x5f)) ls++;
      if (ls === i) continue;
      const end = plainDomainEnd(t, i + 1);
      if (end > 0) {
        out.push({ detail: 'email', span: { start: ls, end } });
        i = end - 1;
      }
      continue;
    }
    const at = atWordAt(t, i);
    if (at === 0) continue;
    // `name [at] host [dot] tld`: spaces around the words are allowed, a bare " at " is never read.
    let p = i;
    while (p > 0 && i - p < 3 && isSpace(t.charCodeAt(p - 1))) p--;
    let ls = p;
    while (ls > 0 && p - ls < LOCAL_MAX && isLocalChar(t.charCodeAt(ls - 1))) {
      __personalSteps.n++;
      ls--;
    }
    while (ls < p && !(isAsciiAlnum(t.charCodeAt(ls)) || t.charCodeAt(ls) === 0x5f)) ls++;
    if (ls === p) continue;
    let k = skipSpaces(t, i + at);
    const readLabel = (from: number): number => {
      let j = from;
      while (j < t.length && j - from < 63 && (isAsciiAlnum(t.charCodeAt(j)) || t.charCodeAt(j) === 0x2d)) {
        __personalSteps.n++;
        j++;
      }
      return j;
    };
    let labelEnd = readLabel(k);
    if (labelEnd === k) continue;
    let dots = 0;
    let lastStart = k;
    let end = labelEnd;
    while (end - i < DOMAIN_MAX) {
      const afterSpace = skipSpaces(t, end);
      const d = afterSpace < t.length ? dotAt(t, afterSpace) : null;
      if (d === null) break;
      k = skipSpaces(t, afterSpace + d.len);
      labelEnd = readLabel(k);
      if (labelEnd === k) break;
      dots++;
      lastStart = k;
      end = labelEnd;
    }
    if (dots >= 1 && tldOk(t.slice(lastStart, end))) {
      out.push({ detail: 'email', span: { start: ls, end } });
      i = end - 1;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Phone and card: runs of digits

/** The index after the last digit of the run of digits and separators that starts at `i` (the phone alphabet), or `i`. */
function phoneRunEnd(t: string, i: number): number {
  let j = i;
  let last = i;
  while (j < t.length) {
    __personalSteps.n++;
    const c = t.charCodeAt(j);
    if (isDigit(c)) {
      j++;
      last = j;
    } else if (c === 0x2b && j === i) {
      j++;
    } else if (c === 0x28) {
      if (!isDigit(t.charCodeAt(j + 1))) break;
      j++;
    } else if (c === 0x29) {
      j++;
    } else if (c === 0x20 || c === 0x2d || c === 0x2e) {
      const next = t.charCodeAt(j + 1);
      if (!(isDigit(next) || next === 0x28)) break;
      j++;
    } else {
      break;
    }
  }
  return last;
}

/** The digit groups of a run and the separator text between consecutive groups. */
function groupsOf(run: string): { groups: string[]; seps: string[] } {
  const groups: string[] = [];
  const seps: string[] = [];
  let i = 0;
  while (i < run.length) {
    if (isDigit(run.charCodeAt(i))) {
      let j = i;
      while (j < run.length && isDigit(run.charCodeAt(j))) j++;
      groups.push(run.slice(i, j));
      i = j;
    } else {
      let j = i;
      while (j < run.length && !isDigit(run.charCodeAt(j))) j++;
      if (groups.length > 0 && j < run.length) seps.push(run.slice(i, j));
      i = j;
    }
  }
  return { groups, seps };
}

/** Identical groups, groups that step by a constant, and round numbers are lists of numbers, not a phone number. */
function looksLikeList(groups: readonly string[]): boolean {
  const values = groups.map((g) => Number(g));
  if (values.every((v) => v === values[0])) return true;
  const step = values[1]! - values[0]!;
  if (values.every((v, i) => i === 0 || v - values[i - 1]! === step)) return true;
  return groups.every((g, i) => g.length >= 3 && values[i]! % 100 === 0);
}

function isPhone(run: string, mode: 'formatted' | 'any'): boolean {
  let digits = 0;
  for (let i = 0; i < run.length; i++) if (isDigit(run.charCodeAt(i))) digits++;
  if (run.charCodeAt(0) === 0x2b) return digits >= 8 && digits <= 15;
  if (digits < 9 || digits > 15) return false;
  if (mode === 'any') return true;
  const { groups, seps } = groupsOf(run);
  if (groups.length < 3 || groups.length > 5) return false;
  if (groups[0]!.length > 4) return false;
  for (let i = 1; i < groups.length; i++) if (groups[i]!.length < 2 || groups[i]!.length > 4) return false;
  // The separators between groups are used consistently; the brackets around an area code are not one.
  const plain = seps.filter((s) => !s.includes(')') && !s.includes('('));
  if (plain.some((s) => s !== plain[0])) return false;
  if (looksLikeList(groups)) return false;
  // 1.234.567.890: a number with thousands separators.
  if (plain.length > 0 && plain[0] === '.' && groups[0]!.length <= 3 && groups.slice(1).every((g) => g.length === 3)) return false;
  return true;
}

function scanPhones(t: string, mode: 'formatted' | 'any', out: PersonalMatch[]): void {
  let i = 0;
  while (i < t.length && out.length < PERSONAL_MATCH_CAP) {
    __personalSteps.n++;
    const c = t.charCodeAt(i);
    const starts = isDigit(c) || ((c === 0x2b || c === 0x28) && (isDigit(t.charCodeAt(i + 1)) || (c === 0x2b && t.charCodeAt(i + 1) === 0x28)));
    if (!starts) {
      i++;
      continue;
    }
    const end = phoneRunEnd(t, i);
    if (end === i) {
      i++;
      continue;
    }
    // A run glued to a letter is part of a word or an id.
    if (!wordAt(t, i - 1) && !wordAt(t, end) && isPhone(t.slice(i, end), mode)) out.push({ detail: 'phone', span: { start: i, end } });
    i = end;
  }
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 0x30;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function scanCards(t: string, out: PersonalMatch[]): void {
  let i = 0;
  while (i < t.length && out.length < PERSONAL_MATCH_CAP) {
    __personalSteps.n++;
    if (!isDigit(t.charCodeAt(i))) {
      i++;
      continue;
    }
    let j = i;
    let last = i;
    let digits = '';
    while (j < t.length) {
      __personalSteps.n++;
      const c = t.charCodeAt(j);
      if (isDigit(c)) {
        if (digits.length < 40) digits += t.charAt(j);
        j++;
        last = j;
      } else if ((c === 0x20 || c === 0x2d) && isDigit(t.charCodeAt(j + 1))) {
        j++;
      } else {
        break;
      }
    }
    if (digits.length >= 13 && digits.length <= 19 && !wordAt(t, i - 1) && !wordAt(t, last) && luhn(digits)) out.push({ detail: 'card', span: { start: i, end: last } });
    i = Math.max(last, i + 1);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Words: contact lines and addresses

interface Token {
  /** The token as written. */
  start: number;
  end: number;
  /** Without the punctuation round it. */
  from: number;
  to: number;
}

const isEdgePunct = (c: number): boolean => c === 0x2e || c === 0x2c || c === 0x3b || c === 0x3a || c === 0x21 || c === 0x3f || c === 0x28 || c === 0x29 || c === 0x5b || c === 0x5d || c === 0x22 || c === 0x27 || c === 0x7b || c === 0x7d;

function tokens(t: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < t.length && out.length < 1000) {
    __personalSteps.n++;
    if (isSpace(t.charCodeAt(i))) {
      i++;
      continue;
    }
    let j = i;
    while (j < t.length && !isSpace(t.charCodeAt(j))) {
      __personalSteps.n++;
      j++;
    }
    let from = i;
    let to = j;
    while (from < to && isEdgePunct(t.charCodeAt(from))) from++;
    while (to > from && isEdgePunct(t.charCodeAt(to - 1))) to--;
    out.push({ start: i, end: j, from, to });
    i = j;
  }
  return out;
}

const isHandleChar = (c: number): boolean => isAsciiAlnum(c) || c === 0x5f || c === 0x2e;

/** `@name`, `name#1234`, or 3 to 32 characters with a letter and a digit, `_`, `.` or `#`. */
function handleShaped(w: string): boolean {
  if (w.length < 2 || w.length > 33) return false;
  if (w.charCodeAt(0) === 0x40) {
    if (w.length < 3) return false;
    for (let i = 1; i < w.length; i++) if (!isHandleChar(w.charCodeAt(i))) return false;
    return true;
  }
  const hash = w.indexOf('#');
  if (hash >= 1) {
    const digits = w.length - hash - 1;
    if (digits < 2 || digits > 8) return false;
    for (let i = 0; i < hash; i++) if (!isHandleChar(w.charCodeAt(i))) return false;
    for (let i = hash + 1; i < w.length; i++) if (!isDigit(w.charCodeAt(i))) return false;
    return true;
  }
  if (w.length < 3 || w.length > 32) return false;
  let letter = false;
  let mark = false;
  for (let i = 0; i < w.length; i++) {
    const c = w.charCodeAt(i);
    if (isAsciiLetter(c)) letter = true;
    else if (isDigit(c) || c === 0x5f || c === 0x2e) mark = true;
    else if (c !== 0x2d) return false;
  }
  return letter && mark;
}

function scanContacts(t: string, toks: readonly Token[], out: PersonalMatch[]): void {
  for (let k = 0; k < toks.length && out.length < PERSONAL_MATCH_CAP; k++) {
    __personalSteps.n++;
    const lead = toks[k]!;
    if (lead.to - lead.from > 12 || !CONTACT_LEADS.has(t.slice(lead.from, lead.to).toLowerCase())) continue;
    for (let m = 1; m <= 3 && k + m < toks.length; m++) {
      const cand = toks[k + m]!;
      if (handleShaped(t.slice(cand.from, cand.to))) {
        out.push({ detail: 'contact', span: { start: lead.from, end: cand.to } });
        break;
      }
    }
  }
}

const isNumberWord = (w: string): boolean => {
  if (w.length < 1 || w.length > 5) return false;
  for (let i = 0; i < w.length; i++) if (!isDigit(w.charCodeAt(i))) return false;
  return true;
};

const isPlainWord = (w: string): boolean => {
  if (w.length < 2 || w.length > 24) return false;
  for (let i = 0; i < w.length; i++) {
    const c = w.charCodeAt(i);
    if (!(isAsciiLetter(c) || c === 0x27 || c === 0x2d)) return false;
  }
  return true;
};

function scanAddresses(t: string, toks: readonly Token[], out: PersonalMatch[]): void {
  const text = (k: number): string => (k < toks.length ? t.slice(toks[k]!.from, toks[k]!.to) : '');
  for (let k = 0; k < toks.length && out.length < PERSONAL_MATCH_CAP; k++) {
    __personalSteps.n++;
    if (!isNumberWord(text(k)) || !isPlainWord(text(k + 1))) continue;
    let street = -1;
    if (STREET_WORDS.has(text(k + 2).toLowerCase())) street = k + 2;
    else if (isPlainWord(text(k + 2)) && STREET_WORDS.has(text(k + 3).toLowerCase())) street = k + 3;
    if (street >= 0) out.push({ detail: 'address', span: { start: toks[k]!.from, end: toks[street]!.to } });
  }
}

/**
 * The personal details in `text` that the settings look for, in text order, at most 50: where each is, on the original text. `address` is
 * reported only when the settings turn it on; whether it may hide or refuse is the settings' rule (it may only count or flag), not this
 * scan's. Reads at most 2 000 characters. Never throws.
 */
export function scanPersonal(text: string, cfg: ResolvedPersonalInfo): PersonalMatch[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  try {
    const t = text.length > PERSONAL_LINE_CAP ? text.slice(0, PERSONAL_LINE_CAP) : text;
    const out: PersonalMatch[] = [];
    if (cfg.kinds.includes('email')) scanEmails(t, out);
    if (cfg.kinds.includes('phone')) scanPhones(t, cfg.phone, out);
    if (cfg.kinds.includes('card')) scanCards(t, out);
    if (cfg.kinds.includes('contact') || cfg.address !== null) {
      const toks = tokens(t);
      if (cfg.kinds.includes('contact')) scanContacts(t, toks, out);
      if (cfg.address !== null) scanAddresses(t, toks, out);
    }
    out.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
    return out.length > PERSONAL_MATCH_CAP ? out.slice(0, PERSONAL_MATCH_CAP) : out;
  } catch {
    return [];
  }
}
