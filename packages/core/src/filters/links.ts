import type { ResolvedLinks } from '../filters.js';
import { dotAt, isSpaceCode, stripHidden } from './chars.js';
import { INVITE_PACK, SHORTENER_PACK, STRONG_TLDS, WEAK_TLDS } from './lists.js';

// The link scanner: text in, link candidates out. One forward pass with no backtracking and a step count, no regular expression built from
// data, nothing fetched, resolved or previewed, and nothing thrown. A candidate is found by its shape (a scheme, `www.`, a bare host ending
// in a link ending, an IPv4 address, an integer host); a host is then read the way a browser reads it (the last `@` wins, a port goes, an
// escaped letter is decoded) and judged against the owner's lists.

/** At most this many characters of a line are read. */
export const SCAN_CAP = 2000;
/** At most this many candidates are returned; the rest are ignored. */
export const MAX_CANDIDATES = 20;
/** The longest authority read; a longer one is a parse failure (a host is at most 253 characters). */
const AUTHORITY_CAP = 600;
const PATH_KEEP = 256;

/** Test hook: how many characters the scanner has looked at, so a test can show the work is linear. */
export const __scanSteps = { n: 0 };

/** Where a link is, on the ORIGINAL text, and what it points at. `host` is null when the host does not parse (the link still counts). */
export interface LinkCandidate {
  start: number;
  end: number;
  host: string | null;
  shape: 'host' | 'ip' | 'ipv6' | 'invalid';
  /** From the first `/`, `?` or `#` after the host, at most 256 characters. */
  path: string;
  /** The scheme in lower case (`hxxp` read as `http`), or null. */
  scheme: string | null;
}

export interface ParsedHost {
  host: string;
  ok: boolean;
  shape: LinkCandidate['shape'];
}

/** One character that may sit in a host label outside ASCII: a letter, a number or a mark of any script. */
const NON_ASCII_LABEL = /^[\p{L}\p{N}\p{M}]$/u;

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isHex = (c: number): boolean => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isAsciiAlnum = (c: number): boolean => isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** The length of the label character at `i` (a letter, digit, `-`, `_`, a non-ASCII letter, or a `%XX` escape), or 0. */
function labelUnit(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (Number.isNaN(c)) return 0;
  if (c < 0x80) {
    if (isAsciiAlnum(c) || c === 0x2d || c === 0x5f) return 1;
    if (c === 0x25 && isHex(s.charCodeAt(i + 1)) && isHex(s.charCodeAt(i + 2))) return 3;
    return 0;
  }
  const cp = s.codePointAt(i)!;
  if (cp === 0x3002 || cp === 0xff0e || cp === 0xff61) return 0;
  const ch = String.fromCodePoint(cp);
  return NON_ASCII_LABEL.test(ch) ? ch.length : 0;
}

/** `s` with every dot written in a defanged or look-alike form turned into `.`. */
function normalizeDots(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const d = dotAt(s, i);
    if (d !== null) {
      out += '.';
      i += d.len;
    } else {
      out += s.charAt(i);
      i++;
    }
  }
  return out;
}

const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
};

const INVALID: ParsedHost = { host: '', ok: false, shape: 'invalid' };

/** A label of an all-numeric host: decimal digits, or `0x` and hex digits. */
function numericLabel(label: string): boolean {
  if (label.length === 0) return false;
  if (label.startsWith('0x')) {
    if (label.length === 2) return false;
    for (let i = 2; i < label.length; i++) if (!isHex(label.charCodeAt(i))) return false;
    return true;
  }
  for (let i = 0; i < label.length; i++) if (!isDigit(label.charCodeAt(i))) return false;
  return true;
}

/**
 * Read the host out of an authority (`user:pw@host:port`) the way a browser does: the text after the LAST `@`, the port dropped, `%XX`
 * decoded only when the result is a letter, digit, `-` or `.`, NFKC and lower case, one trailing dot dropped. `ok` is false when what is
 * left is not labels of letters, digits, `-` and `_` (a label is 1 to 63 characters, the host at most 253). Never throws.
 */
export function parseHost(authority: string): ParsedHost {
  try {
    if (typeof authority !== 'string' || authority.length === 0 || authority.length > AUTHORITY_CAP) return INVALID;
    let a = authority.slice(authority.lastIndexOf('@') + 1);
    a = normalizeDots(a);
    if (a.startsWith('[')) {
      const close = a.indexOf(']');
      if (close < 0) return INVALID;
      const inner = a.slice(1, close);
      const rest = a.slice(close + 1);
      let colons = 0;
      for (let i = 0; i < inner.length; i++) {
        const c = inner.charCodeAt(i);
        if (c === 0x3a) colons++;
        else if (!isHex(c) && c !== 0x2e) return INVALID;
      }
      if (colons < 2 || inner.length > 45) return INVALID;
      if (rest.length > 0) {
        if (rest.charCodeAt(0) !== 0x3a) return INVALID;
        for (let i = 1; i < rest.length; i++) if (!isDigit(rest.charCodeAt(i))) return INVALID;
      }
      return { host: inner.toLowerCase(), ok: true, shape: 'ipv6' };
    }
    const colon = a.indexOf(':');
    if (colon >= 0) {
      for (let i = colon + 1; i < a.length; i++) if (!isDigit(a.charCodeAt(i))) return INVALID;
      a = a.slice(0, colon);
    }
    let decoded = '';
    for (let i = 0; i < a.length; i++) {
      const c = a.charCodeAt(i);
      if (c === 0x25) {
        if (!isHex(a.charCodeAt(i + 1)) || !isHex(a.charCodeAt(i + 2))) return INVALID;
        const code = Number.parseInt(a.slice(i + 1, i + 3), 16);
        const ldh = isAsciiAlnum(code) || code === 0x2d || code === 0x2e;
        if (!ldh) return INVALID;
        decoded += String.fromCharCode(code);
        i += 2;
      } else {
        decoded += a.charAt(i);
      }
    }
    let host = decoded.normalize('NFKC').toLowerCase();
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (host.length === 0 || host.length > 253) return INVALID;
    const labels = host.split('.');
    for (const label of labels) {
      if (label.length === 0 || label.length > 63) return INVALID;
      for (let i = 0; i < label.length; ) {
        const u = labelUnit(label, i);
        // A `%` that survived is not a label character here (only decoded escapes are).
        if (u === 0 || label.charCodeAt(i) === 0x25) return INVALID;
        i += u;
      }
    }
    const numeric = labels.length <= 4 && labels.every(numericLabel);
    return { host, ok: true, shape: numeric ? 'ip' : 'host' };
  } catch {
    return INVALID;
  }
}

/** Read a label starting at `i`: the index after its last character. */
function readLabel(s: string, i: number): number {
  let j = i;
  for (;;) {
    const u = j < s.length ? labelUnit(s, j) : 0;
    if (u === 0) return j;
    __scanSteps.n++;
    j += u;
  }
}

interface Chain {
  end: number;
  labels: number;
  firstEnd: number;
  lastStart: number;
}

/** The dotted run of labels that starts at `i`: `a.b.c`, with the defanged dots read as dots. */
function readChain(s: string, i: number): Chain {
  let j = i;
  let labels = 0;
  let firstEnd = i;
  let lastStart = i;
  for (;;) {
    const start = j;
    j = readLabel(s, j);
    if (j === start) break;
    labels++;
    if (labels === 1) firstEnd = j;
    lastStart = start;
    const d = j < s.length ? dotAt(s, j) : null;
    if (d === null) break;
    const next = j + d.len;
    if (next >= s.length || labelUnit(s, next) === 0) break;
    // `(dot)` and `[dot]` are read as a dot only before a strong ending (`evil(dot)com`), never between two plain words.
    if (d.word && !STRONG_TLDS.has(peekLabel(s, next))) break;
    __scanSteps.n++;
    j = next;
  }
  return { end: j, labels, firstEnd, lastStart };
}

/** The label at `i` in lower case, up to 12 characters (longer is returned as 13 characters so it is never found in a list). */
function peekLabel(s: string, i: number): string {
  let out = '';
  for (let j = i; j < s.length && out.length < 13; j++) {
    const c = s.charCodeAt(j);
    if (!(isAsciiAlnum(c) || c === 0x2d)) {
      if (labelUnit(s, j) > 0) return out + '#';
      break;
    }
    out += s.charAt(j).toLowerCase();
  }
  return out;
}

/** Where the authority that starts at `a` ends: label characters, dots, `@` and `:`, an ipv6 literal in brackets; a trailing dot, colon or `@` is left out. */
function readAuthority(s: string, a: number): number {
  let k = a;
  if (s.charCodeAt(k) === 0x5b && dotAt(s, k) === null) {
    let m = k + 1;
    while (m < s.length && m - k < 60 && s.charCodeAt(m) !== 0x5d && !isSpaceCode(s.charCodeAt(m))) {
      __scanSteps.n++;
      m++;
    }
    k = s.charCodeAt(m) === 0x5d ? m + 1 : m;
  }
  while (k < s.length) {
    __scanSteps.n++;
    const code = s.charCodeAt(k);
    const u = labelUnit(s, k);
    if (u > 0) {
      k += u;
      continue;
    }
    const d = dotAt(s, k);
    if (d !== null) {
      k += d.len;
      continue;
    }
    if (code === 0x40 || code === 0x3a) {
      k++;
      continue;
    }
    break;
  }
  while (k > a) {
    const c = s.charCodeAt(k - 1);
    if (c === 0x2e || c === 0x3a || c === 0x40) k--;
    else break;
  }
  return k;
}

/** Where the path that starts at `p` ends: to white space or a quote or angle bracket, less the punctuation that closes a sentence. */
function readPath(s: string, p: number): number {
  const first = s.charCodeAt(p);
  if (!(first === 0x2f || first === 0x3f || first === 0x23 || first === 0x5c)) return p;
  let q = p;
  let opens = 0;
  let closes = 0;
  while (q < s.length) {
    __scanSteps.n++;
    const c = s.charCodeAt(q);
    if (isSpaceCode(c) || c === 0x22 || c === 0x3c || c === 0x3e) break;
    if (c === 0x28) opens++;
    else if (c === 0x29) closes++;
    q++;
  }
  while (q > p + 1) {
    const c = s.charCodeAt(q - 1);
    if (c === 0x2e || c === 0x2c || c === 0x3b || c === 0x3a || c === 0x21 || c === 0x3f || c === 0x27 || c === 0x2a || c === 0x5d || c === 0x7d) q--;
    else if (c === 0x29 && closes > opens) {
      closes--;
      q--;
    } else break;
  }
  return q;
}

/** Four decimal numbers from 0 to 255. */
function isIPv4(text: string): boolean {
  const parts = normalizeDots(text).split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return false;
    for (let i = 0; i < part.length; i++) if (!isDigit(part.charCodeAt(i))) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

const isSchemeText = (t: string): boolean => {
  if (t.length === 0 || t.length > 20) return false;
  const first = t.charCodeAt(0);
  if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (!(isAsciiAlnum(c) || c === 0x2b || c === 0x2d || c === 0x2e)) return false;
  }
  return true;
};

/**
 * The link candidates in `text`, in order, at most 20. `start` and `end` index the ORIGINAL text, so a mask covers the hidden characters
 * and defanged dots inside a link. Reads at most 2 000 characters. Never fetches, resolves or throws.
 */
export function scanLinks(text: string): LinkCandidate[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  try {
    return scan(text.length > SCAN_CAP ? text.slice(0, SCAN_CAP) : text);
  } catch {
    return [];
  }
}

function scan(original: string): LinkCandidate[] {
  const { text: s, map } = stripHidden(original);
  // The pass that strips hidden characters reads every character once.
  __scanSteps.n += original.length;
  const out: LinkCandidate[] = [];
  const n = s.length;
  /** Add the candidate whose authority is `s[authStart, authEnd)`; returns where it ends (after its path). */
  const push = (start: number, authStart: number, authEnd: number, scheme: string | null): number => {
    const parsed = parseHost(s.slice(authStart, authEnd));
    const pathEnd = readPath(s, authEnd);
    const last = pathEnd > authEnd ? pathEnd : authEnd;
    out.push({
      start: map[start]!,
      end: map[last - 1]! + 1,
      host: parsed.ok ? parsed.host : null,
      shape: parsed.shape,
      path: s.slice(authEnd, pathEnd).slice(0, PATH_KEEP),
      scheme: scheme === null ? null : scheme === 'hxxp' ? 'http' : scheme === 'hxxps' ? 'https' : scheme,
    });
    return last;
  };
  let i = 0;
  while (i < n && out.length < MAX_CANDIDATES) {
    __scanSteps.n++;
    if (labelUnit(s, i) === 0) {
      i += 1;
      continue;
    }
    const chain = readChain(s, i);
    let next = Math.max(chain.end, i + 1);

    // 1. A scheme: `name://`, any name.
    if (s.startsWith('://', chain.end) && chain.end - i <= 20 && isSchemeText(s.slice(i, chain.end))) {
      const authStart = chain.end + 3;
      const authEnd = readAuthority(s, authStart);
      if (authEnd > authStart) {
        next = Math.max(next, push(i, authStart, authEnd, s.slice(i, chain.end).toLowerCase()));
      } else {
        next = authStart;
      }
      i = next;
      continue;
    }

    // An email address is never a link: the domain after an `@` that follows a local part.
    if (i >= 2 && s.charCodeAt(i - 1) === 0x40 && (isAsciiAlnum(s.charCodeAt(i - 2)) || s.charCodeAt(i - 2) === 0x2e || s.charCodeAt(i - 2) === 0x5f || s.charCodeAt(i - 2) === 0x2b || s.charCodeAt(i - 2) === 0x2d || s.charCodeAt(i - 2) > 0x7f)) {
      i = next;
      continue;
    }

    if (chain.labels >= 2) {
      const last = s.slice(chain.lastStart, chain.end).toLowerCase();
      const first = s.slice(i, chain.firstEnd).toLowerCase();
      let hit = first === 'www' || STRONG_TLDS.has(last) || isIPv4(s.slice(i, chain.end));
      if (!hit && WEAK_TLDS.has(last)) {
        // `t.me/abc`: a weak ending counts only when a path follows (after an optional port). Looked at in place, so a run of weak
        // hosts cannot make the scan read the same tail again and again.
        let j = chain.end;
        if (s.charCodeAt(j) === 0x3a) {
          j++;
          while (isDigit(s.charCodeAt(j))) j++;
        }
        hit = s.charCodeAt(j) === 0x2f && readPath(s, j) - j >= 2;
      }
      if (hit) next = Math.max(next, push(i, i, readAuthority(s, i), null));
    }
    i = next;
  }
  return out;
}

export type LinkVerdict = 'deny' | 'invite' | 'shortener' | 'unlisted' | 'new_account';

/** `host` is `entry` or a subdomain of it; an entry that starts with `=` matches that host only. */
function matches(host: string, entry: string): boolean {
  if (entry.startsWith('=')) return host === entry.slice(1);
  return host === entry || host.endsWith(`.${entry}`);
}

const listed = (host: string, list: readonly string[]): boolean => {
  for (const entry of list) if (matches(host, entry)) return true;
  return false;
};

function isInvite(host: string, path: string): boolean {
  for (const [h, prefix] of INVITE_PACK) {
    if (!(host === h || host.endsWith(`.${h}`))) continue;
    if (prefix === null) return true;
    if (!path.startsWith(prefix)) continue;
    // `/invite` is a whole segment; `/+` is a marker whatever follows it.
    if (prefix.endsWith('+')) return true;
    const after = path.charAt(prefix.length);
    if (after === '' || after === '/' || after === '?' || after === '#') return true;
  }
  return false;
}

const isShortener = (host: string): boolean => {
  for (const s of SHORTENER_PACK) if (host === s || host.endsWith(`.${s}`)) return true;
  return false;
};

/**
 * What one link does under the owner's settings, in this order: on `deny` (the entry or a parent domain) it is `deny`; on `allow` it
 * passes (null); the built-in invite and shortener packs hit unless allowed; then a link on neither list is `unlisted` (when `unlisted` is
 * `'act'`), or `new_account` (when `unlisted` is `'allow'`, `newAccountDays` is set and the account is new), or passes. An IP, an ipv6
 * literal, an internationalised host and a host that did not parse are always `unlisted` unless listed exactly. `accountIsNew` may be a
 * function; it is called only when the answer can change the verdict, and a throw reads as not new. Never throws.
 */
export function judgeLink(c: LinkCandidate, cfg: ResolvedLinks, accountIsNew: boolean | (() => boolean)): LinkVerdict | null {
  try {
    const host = c.host;
    if (host === null || host.length === 0 || c.shape === 'invalid' || c.shape === 'ipv6') return 'unlisted';
    if (listed(host, cfg.deny)) return 'deny';
    if (listed(host, cfg.allow)) return null;
    if (c.shape === 'host') {
      if (cfg.invites && isInvite(host, c.path)) return 'invite';
      if (cfg.shorteners && isShortener(host)) return 'shortener';
    }
    // An IP address and an internationalised host (a look-alike of a brand) pass only when listed.
    if (c.shape !== 'host' || !isAscii(host)) return 'unlisted';
    if (cfg.unlisted === 'act') return 'unlisted';
    if (cfg.newAccountDays !== null) {
      let isNew = false;
      try {
        isNew = typeof accountIsNew === 'function' ? accountIsNew() === true : accountIsNew === true;
      } catch {
        isNew = false;
      }
      if (isNew) return 'new_account';
    }
    return null;
  } catch {
    return 'unlisted';
  }
}
