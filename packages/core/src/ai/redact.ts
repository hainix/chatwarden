// Redaction: the only path from player text to the prompt (design section 8). Pure and deterministic. The signal stays and the
// data goes: a speaker handle becomes its alias, and anything personal becomes a typed placeholder, so a read can still see
// that someone posted an address or a phone number without receiving it.

/** The longest note that is sent, in characters. */
export const AI_NOTE_MAX = 300;

const WORD = String.raw`[\p{L}\p{N}_]`;
const NOT_WORD_BEFORE = String.raw`(?<!${WORD})`;
const NOT_WORD_AFTER = String.raw`(?!${WORD})`;
const URL_TAIL = String.raw`[^\s<>"']*[^\s<>"'.,;:!?)\]]`;
const TLDS = 'com|net|org|io|gg|app|dev|xyz|info|biz|link|club|shop|store|online|site';
const H = '[0-9a-f]{1,4}';

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu;
const LINK = new RegExp(
  [
    String.raw`\b[a-z][a-z0-9+.-]*://${URL_TAIL}`, // a scheme URL
    String.raw`\bwww\.${URL_TAIL}`,
    String.raw`\b[a-z0-9-]+(?:\.[a-z][a-z0-9-]*)+/${URL_TAIL}`, // a bare domain with a path (also discord.gg/x, t.me/x)
    String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:${TLDS})\b`, // a bare domain with a common ending
  ].join('|'),
  'giu',
);
const IPV6 = new RegExp(
  [
    String.raw`(?:${H}:){7}${H}`,
    String.raw`(?:${H}:){1,7}:(?:${H}(?::${H}){0,6})?`,
    String.raw`::(?:${H}:){0,6}${H}`,
  ]
    .map((p) => String.raw`(?<![\w:])${p}(?![\w:])`)
    .join('|'),
  'giu',
);
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const IPV4 = new RegExp(String.raw`(?<![\w.])${OCTET}(?:\.${OCTET}){3}(?![\w]|\.\d)`, 'giu');
const TAG = new RegExp(String.raw`@?${NOT_WORD_BEFORE}[\p{L}\p{N}_]{2,32}#\d{4,6}${NOT_WORD_AFTER}`, 'giu');
const MENTION = new RegExp(String.raw`@(?!P\d+${NOT_WORD_AFTER})${WORD}+(?:[.-]${WORD}+)*`, 'giu');
const TOKEN = new RegExp(
  [
    String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`, // a UUID
    String.raw`(?<![\p{L}\p{N}])[0-9a-f]{20,}(?![\p{L}\p{N}])`, // a hex run
    // A base64-like run holding both a letter and a digit, so a long plain word is left alone.
    String.raw`(?<![\p{L}\p{N}+/_=])(?=[A-Za-z0-9+/_=]*\d)(?=[A-Za-z0-9+/_=]*[A-Za-z])[A-Za-z0-9+/_=]{20,}(?![\p{L}\p{N}+/_=])`,
  ].join('|'),
  'giu',
);
// Seven or more digits, with at most two separators between neighbours (a space, a dash, a dot, brackets).
const PHONE = /(?<![\p{L}\p{N}])\+?\(?\d(?:[\s().-]{0,2}\d){6,}(?![\p{L}\p{N}])/gu;

/** A code point that is dropped: control, bidirectional, zero-width and tag characters. Tab and newline become a space instead. */
function isInvisible(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0xad || // soft hyphen
    c === 0x34f ||
    c === 0x61c || // arabic letter mark
    c === 0x180e ||
    (c >= 0x200b && c <= 0x200f) || // zero-width space .. right-to-left mark
    (c >= 0x202a && c <= 0x202e) || // bidi embeddings and overrides
    (c >= 0x2060 && c <= 0x206f) || // word joiner, invisible operators, bidi isolates
    c === 0xfeff || // zero-width no-break space
    (c >= 0xe0000 && c <= 0xe007f) // tag characters
  );
}

function clean(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d || c === 0x85) out += ' ';
    else if (!isInvisible(c)) out += ch;
  }
  return out.replace(/\s+/gu, ' ').trim();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/gu, String.raw`\$&`);
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /^[\p{L}\p{N}_]$/u.test(ch);

/** One alternation for every handle: longest first, whole token, any case. */
function handlePattern(handles: readonly string[], aliasOf: (h: string) => string | null) {
  const byText = new Map<string, string>();
  const alts: Array<{ re: string; len: number }> = [];
  for (const raw of handles) {
    const h = clean(raw);
    if (h === '') continue;
    const alias = aliasOf(raw);
    if (alias === null) continue;
    const chars = [...h];
    const short = chars.length < 3;
    // A handle under 3 characters would eat ordinary words, so only an explicit @-mention of it is replaced.
    const text = short ? `@${h}` : h;
    const key = text.toLowerCase();
    if (!byText.has(key)) byText.set(key, short ? `@${alias}` : alias);
    const pre = short || !isWordChar(chars[0]) ? '' : NOT_WORD_BEFORE;
    const post = !isWordChar(chars[chars.length - 1]) ? '' : NOT_WORD_AFTER;
    alts.push({ re: `${pre}${escapeRe(text)}${post}`, len: [...text].length });
  }
  if (alts.length === 0) return null;
  alts.sort((a, b) => b.len - a.len);
  return { re: new RegExp(alts.map((a) => a.re).join('|'), 'giu'), byText };
}

/**
 * Redact one piece of player text for a provider. Order: control, bidi and zero-width characters are removed and whitespace
 * collapsed (so a zero-width character cannot hide an address); each speaker handle becomes its alias, whole token and in any
 * case; then `[email]`, `[link]`, `[ip]`, `[tag]` (`name#1234`), `[mention]`, `[token]` and `[phone]`. A handle under 3 characters
 * is replaced only as an @-mention. `aliasOf` returns the alias of a handle, or null to leave it. Pure and deterministic.
 * @experimental
 */
export function redactText(text: string, handles: readonly string[], aliasOf: (h: string) => string | null): string {
  let out = clean(text);
  const h = handlePattern(handles, aliasOf);
  if (h) out = out.replace(h.re, (m) => h.byText.get(clean(m).toLowerCase()) ?? m);
  return out
    .replace(EMAIL, '[email]')
    .replace(LINK, '[link]')
    .replace(IPV6, '[ip]')
    .replace(IPV4, '[ip]')
    .replace(TAG, '[tag]')
    .replace(MENTION, '[mention]')
    .replace(TOKEN, '[token]')
    .replace(PHONE, '[phone]');
}

/**
 * The reporter's note for a provider: redacted like a line, then cut to `max` characters (default 300) without splitting a
 * surrogate pair. Null when nothing is left.
 * @experimental
 */
export function redactNote(
  note: string | null | undefined,
  handles: readonly string[],
  aliasOf: (h: string) => string | null,
  max = AI_NOTE_MAX,
): string | null {
  if (note === null || note === undefined) return null;
  const out = redactText(note, handles, aliasOf);
  if (out === '') return null;
  const chars = [...out];
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : out;
}
