// Redaction: the only path from player text to the prompt (design section 8). Pure and deterministic. The signal stays and the
// data goes: a speaker handle becomes its alias, and anything personal becomes a typed placeholder, so a read can still see
// that someone posted an address or a phone number without receiving it. It is best effort: it catches the common shapes of
// personal data, not every disguise.

/** The longest note that is sent, in characters. */
export const AI_NOTE_MAX = 300;

const WORD = String.raw`[\p{L}\p{N}_]`;
const NOT_WORD_BEFORE = String.raw`(?<!${WORD})`;
const NOT_WORD_AFTER = String.raw`(?!${WORD})`;
const URL_TAIL = String.raw`[^\s<>"']*[^\s<>"'.,;:!?)\]]`;
const H = '[0-9a-f]{1,4}';

// "bob at example dot com", "bob (at) example (dot) com", "bob[at]example[dot]com".
const AT = String.raw`(?:\s*[(\[{]at[)\]}]\s*|\s+at\s+)`;
const DOT = String.raw`(?:\s*[(\[{]dot[)\]}]\s*|\s+dot\s+)`;
const SPELLED_EMAIL = new RegExp(String.raw`[\p{L}\p{N}._%+-]+${AT}[\p{L}\p{N}-]+(?:${DOT}[\p{L}\p{N}-]+)+`, 'giu');
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu;
const LINK = new RegExp(
  [
    String.raw`\b[a-z][a-z0-9+.-]*://${URL_TAIL}`, // a scheme URL
    String.raw`\bwww\.${URL_TAIL}`,
    String.raw`\b[a-z0-9-]+(?:\.[a-z][a-z0-9-]*)+/${URL_TAIL}`, // a bare domain with a path (also discord.gg/x, t.me/x)
    String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b`, // a bare domain: label.ending, any letters-only ending of 2 to 24
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
// The dots may be spaced out ("192 . 168 . 1 . 1").
const IPV4 = new RegExp(String.raw`(?<![\w.])${OCTET}(?:\s?\.\s?${OCTET}){3}(?![\w]|\.\d)`, 'giu');
const TAG = new RegExp(String.raw`@?${NOT_WORD_BEFORE}[\p{L}\p{N}_]{2,32}#\d{4,6}${NOT_WORD_AFTER}`, 'giu');
const MENTION = new RegExp(String.raw`@(?!P\d+${NOT_WORD_AFTER})${WORD}+(?:[.-]${WORD}+)*`, 'giu');
const TOKEN = new RegExp(
  [
    String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`, // a UUID
    String.raw`(?<![\p{L}\p{N}])[0-9a-f]{20,}(?![\p{L}\p{N}])`, // a hex run
    // A base64-like or hyphenated-key run (sk-ant-api03-...) holding both a letter and a digit, so a long plain word is left alone.
    String.raw`(?<![\p{L}\p{N}+/_=-])(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{20,}(?![\p{L}\p{N}+/_=-])`,
  ].join('|'),
  'giu',
);
// Seven or more digits, with at most two separators between neighbours (a space, a dash, a dot, brackets).
const PHONE = /(?<![\p{L}\p{N}])\+?\(?\d(?:[\s().-]{0,2}\d){6,}(?![\p{L}\p{N}])/gu;

/**
 * A code point that is dropped: control, bidirectional, zero-width, tag and other default-ignorable or blank-looking characters
 * (hangul and braille fillers, variation selectors). Tab and newline become a space instead in {@link cleanText}.
 */
export function isInvisible(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0xad || // soft hyphen
    c === 0x34f ||
    c === 0x61c || // arabic letter mark
    c === 0x115f || // hangul fillers
    c === 0x1160 ||
    c === 0x17b4 || // khmer inherent vowels
    c === 0x17b5 ||
    c === 0x180e ||
    (c >= 0x200b && c <= 0x200f) || // zero-width space .. right-to-left mark
    (c >= 0x202a && c <= 0x202e) || // bidi embeddings and overrides
    (c >= 0x2060 && c <= 0x206f) || // word joiner, invisible operators, bidi isolates
    c === 0x2800 || // braille blank
    c === 0x3164 ||
    (c >= 0xfe00 && c <= 0xfe0f) || // variation selectors
    c === 0xfeff || // zero-width no-break space
    c === 0xffa0 ||
    (c >= 0x1d173 && c <= 0x1d17a) || // musical formatting characters
    (c >= 0xe0000 && c <= 0xe007f) || // tag characters
    (c >= 0xe0100 && c <= 0xe01ef) // variation selectors supplement
  );
}

/**
 * One piece of text as one line of NFKC: compatibility forms folded (full-width letters and dots, composed and decomposed accents
 * agree), invisible characters removed, every run of whitespace one space, trimmed.
 */
export function cleanText(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFKC')) {
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
  const entries: Array<{ exact: RegExp; to: string }> = [];
  const alts: Array<{ re: string; len: number }> = [];
  for (const raw of handles) {
    const h = cleanText(raw);
    if (h === '') continue;
    const alias = aliasOf(raw);
    if (alias === null) continue;
    const chars = [...h];
    const short = chars.length < 3;
    // A handle under 3 characters would eat ordinary words, so only an explicit @-mention of it is replaced.
    const text = short ? `@${h}` : h;
    const to = short ? `@${alias}` : alias;
    const key = text.toLowerCase();
    if (!byText.has(key)) byText.set(key, to);
    entries.push({ exact: new RegExp(`^${escapeRe(text)}$`, 'iu'), to });
    const pre = short || !isWordChar(chars[0]) ? '' : NOT_WORD_BEFORE;
    const post = !isWordChar(chars[chars.length - 1]) ? '' : NOT_WORD_AFTER;
    alts.push({ re: `${pre}${escapeRe(text)}${post}`, len: [...text].length });
  }
  if (alts.length === 0) return null;
  alts.sort((a, b) => b.len - a.len);
  // The pattern folds case the way `iu` does, which is wider than toLowerCase (a long s matches s): look the match up by the same
  // fold, and never leave a matched handle in the text.
  const replace = (m: string): string => byText.get(m.toLowerCase()) ?? entries.find((e) => e.exact.test(m))?.to ?? entries[0]?.to ?? m;
  return { re: new RegExp(alts.map((a) => a.re).join('|'), 'giu'), replace };
}

/**
 * Redact one piece of player text for a provider. Order: the text is folded to NFKC, control, bidi, zero-width and filler
 * characters are removed and whitespace collapsed (so a hidden character cannot disguise an address or a handle); each speaker
 * handle becomes its alias, whole token and in any case; then `[email]` (also spelled out, "bob at host dot com"), `[link]` (URLs
 * and any bare domain), `[ip]` (the dots may be spaced), `[tag]` (`name#1234`), `[mention]`, `[token]` and `[phone]`. A handle under
 * 3 characters is replaced only as an @-mention. `aliasOf` returns the alias of a handle, or null to leave it. Pure and
 * deterministic.
 * @experimental
 */
export function redactText(text: string, handles: readonly string[], aliasOf: (h: string) => string | null): string {
  let out = cleanText(text);
  const h = handlePattern(handles, aliasOf);
  if (h) out = out.replace(h.re, h.replace);
  return out
    .replace(SPELLED_EMAIL, '[email]')
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
