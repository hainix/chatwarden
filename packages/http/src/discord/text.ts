// Text helpers for the bot's answers. The escaping and the kind labels are copies of the feed's (`@chatwarden/discord`, `text.ts`): this subpath does not
// depend on that package, and a test (discord-roles.test.ts) reads the feed's table and fails if the two drift apart.

const ZERO_WIDTH_SPACE = '\u200B';
const ELLIPSIS = '\u2026';
/** The middle dot the feed puts between facts. */
export const DOT = ' \u00B7 ';

/** One line: whitespace collapsed, then control and invisible (Cc, Cf) characters removed (they can reorder or hide text). */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').replace(/[\p{Cf}\p{Cc}]/gu, '').trim();

/**
 * Escape Discord markdown and mention syntax: a backslash before each of `\ * _ ~ ` | > # [ ] ( ) < :`, and a zero-width space after `@` so
 * `@everyone` and `@here` read as plain text. (`allowed_mentions` forbids the ping as well; this stops the look of one.)
 */
export const esc = (text: string): string => text.replace(/[\\*_~`|>#[\]()<:]/g, '\\$&').replace(/@/g, `@${ZERO_WIDTH_SPACE}`);

/** `text` cut to at most `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

/** Adopter text, ready to put in an answer: one line, cut to `max` characters (with an ellipsis when it was cut), then escaped. */
export function safeText(value: unknown, max: number): string {
  const line = oneLine(String(value));
  return esc(line.length > max ? `${cutText(line, Math.max(max - 1, 0))}${ELLIPSIS}` : line);
}

/** The sanction kinds as staff read them. */
export const KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  chat: 'Chat restriction',
  area: 'Area ban',
  ban: 'Ban',
  warning: 'Warning',
  note: 'Note',
});

/** Where a sanction came from, in words. */
export const SOURCE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  moderator: 'a moderator',
  auto_filter: 'the chat filter',
  coop: 'Coop',
  ai: 'the AI read',
  api: 'the API',
});

/** A label from a closed table, or undefined for a key the table does not hold (never a prototype property). */
export const labelOf = (table: Readonly<Record<string, string>>, key: unknown): string | undefined =>
  typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;

/** The longest a link may be (Discord's limit on a button url). */
export const LINK_MAX = 512;

/**
 * A hub link as the URL parser writes it, or null when `hubLink` threw, gave something that is not an http(s) URL, or gave one over 512 characters
 * (dropped, never cut). Ids appear in an answer only inside this.
 */
export function hubUrl(hubLink: (kind: 'report' | 'person', id: string) => string, kind: 'report' | 'person', id: string): string | null {
  try {
    const url = new URL(hubLink(kind, id));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href.length > LINK_MAX ? null : url.href;
  } catch {
    return null;
  }
}
