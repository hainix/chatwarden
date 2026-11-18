// Small pure helpers for showing days, times and waits. Times use Intl with the component's `locale`; none holds English.
// `dayText`, `untilText` and `timeLeft` live in core's `@chatwarden/core/notice-copy` (the moderator hub draws the same notice) and are re-exported here.

export { dayText, timeLeft, untilText } from '@chatwarden/core/notice-copy';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function safeLocale(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/** A time of day with no date (`2:30 PM`), in the locale. Pass a time zone for a fixed one; the default is the viewer's. An unknown zone is ignored. */
export function clockText(at: number, locale: string, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { timeStyle: 'short' };
  let out: string;
  try {
    out = new Intl.DateTimeFormat(safeLocale(locale), { ...options, ...(timeZone === undefined ? {} : { timeZone }) }).format(at);
  } catch {
    out = new Intl.DateTimeFormat(safeLocale(locale), options).format(at);
  }
  // ICU puts a narrow no-break space before "PM": a plain space reads the same and compares.
  return out.replace(/[\u202f\u00a0]/g, ' ');
}

/** A date with no time (`Jan 15, 2027`). Pass a time zone for a fixed one; the default is the viewer's. An unknown zone is ignored. */
export function dateText(at: number, locale: string, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };
  try {
    return new Intl.DateTimeFormat(safeLocale(locale), { ...options, ...(timeZone === undefined ? {} : { timeZone }) }).format(at);
  } catch {
    return new Intl.DateTimeFormat(safeLocale(locale), options).format(at);
  }
}

/** A whole number of one unit, bare and in the locale's words ("3 seconds", "3 Sekunden"). */
function bare(n: number, unit: 'second' | 'minute' | 'hour' | 'day', locale: string): string {
  return new Intl.NumberFormat(safeLocale(locale), { style: 'unit', unit, unitDisplay: 'long' }).format(n);
}

/**
 * A short wait (`ms` left, not an end time) as a BARE duration in the locale's words ("3 seconds"): whole seconds, a part of a second
 * counting as a whole one, up to 120 seconds; then whole minutes (rounded up) up to 120, then hours up to two days, then days. Null for zero,
 * a negative or a value that is not a finite number.
 *
 * One convention for every wait sentence the kit words (the pace words and the chat box's refusal words): the value is bare and the sentence
 * has its own "in", as in "You can send another message in {left}." A translation that follows it never reads "in in 3 seconds".
 */
export function secondsLeft(ms: number, locale: string): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || !(ms > 0)) return null;
  if (ms <= 120_000) return bare(Math.ceil(ms / 1000), 'second', locale);
  if (ms <= 120 * MIN) return bare(Math.ceil(ms / MIN), 'minute', locale);
  if (ms < 2 * DAY) return bare(Math.ceil(ms / HOUR), 'hour', locale);
  return bare(Math.ceil(ms / DAY), 'day', locale);
}
