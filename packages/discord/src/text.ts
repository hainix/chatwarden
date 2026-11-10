import { cutText } from './forum.js';

// Text helpers for the staff posts. Everything an adopter wrote (a rule title, a room tag) goes through `safeText`
// before it is placed in a post: it is one line, free of invisible characters, cut, and escaped so it can neither
// format the post nor mention anyone.

const ZERO_WIDTH_SPACE = '\u200B';

/** One line: whitespace collapsed, then control and invisible (Cc, Cf) characters removed (they can reorder or hide text). */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').replace(/[\p{Cf}\p{Cc}]/gu, '').trim();

/**
 * Escape Discord markdown and mention syntax: a backslash before each of `\ * _ ~ ` | > # [ ] ( ) < :` (the colon so a
 * typed `https://...` is not a link), and a zero-width space after `@` so `@everyone` and `@here` read as plain text.
 * (`allowed_mentions` forbids the ping as well; this stops the look of one.)
 */
export const esc = (text: string): string => text.replace(/[\\*_~`|>#[\]()<:]/g, '\\$&').replace(/@/g, `@${ZERO_WIDTH_SPACE}`);

/** Adopter-supplied text, ready to put in a post: one line, cut to `max` characters, then escaped (the cut comes first so it never splits an escape pair). */
export const safeText = (value: unknown, max: number): string => esc(cutText(oneLine(String(value)), max));

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * A length in plain words, rounded to the minute: "15 minutes", "1 hour 30 minutes", "24 hours" (under 48 hours), then
 * "7 days", "2 days 1 hour".
 */
export function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (!(minutes >= 1)) return 'under a minute';
  const parts: string[] = [];
  if (minutes < 48 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours > 0) parts.push(plural(hours, 'hour'));
    if (rest > 0) parts.push(plural(rest, 'minute'));
  } else {
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    parts.push(plural(days, 'day'));
    if (hours > 0) parts.push(plural(hours, 'hour'));
  }
  return parts.join(' ');
}

/** The report categories as staff read them. */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  harassment: 'Harassment',
  hate: 'Hate speech',
  cheating: 'Cheating',
  spam: 'Spam',
  disruption: 'Disruption',
  other: 'Other',
});

export const VERDICT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  upheld: 'Upheld',
  noted: 'Noted',
  no_action: 'No action',
  bad_faith: 'Dismissed as bad faith',
});

export const KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  chat: 'Chat restriction',
  area: 'Area ban',
  ban: 'Ban',
  warning: 'Warning',
  note: 'Note',
});

/** A label from a closed table, or undefined for a key the table does not hold (never a prototype property). */
export const labelOf = (table: Readonly<Record<string, string>>, key: unknown): string | undefined =>
  typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
