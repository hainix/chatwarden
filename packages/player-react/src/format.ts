// Small pure helpers for showing days, times and waits. Times use Intl with the component's `locale`; none holds English.

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

/** Some runtimes put a narrow no-break space before "PM". A plain space reads the same and survives a copy. */
const plain = (text: string): string => text.replace(/[\u202f\u00a0]/g, ' ');

/**
 * A UTC day from the kit (`2027-01-15`) as the locale writes a date (`Jan 15, 2027`), in UTC whatever the viewer's zone: the kit
 * names the day in UTC, so a notice never shows a different day than the moderator's tools. A value that is not a day comes back
 * as it was; it is never shown as "Invalid Date".
 */
export function dayText(day: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m === null) return day;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return day;
  return new Intl.DateTimeFormat(safeLocale(locale), { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

/** A date and time: `Jan 15, 2027, 8:30 PM`. Pass a time zone for a fixed one; the default is the viewer's. An unknown zone is ignored. */
export function untilText(at: number, locale: string, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return plain(new Intl.DateTimeFormat(safeLocale(locale), { ...options, ...(timeZone === undefined ? {} : { timeZone }) }).format(at));
  } catch {
    return plain(new Intl.DateTimeFormat(safeLocale(locale), options).format(at));
  }
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

/**
 * How long is left until `at`, as the locale says it ("in 3 hours"): minutes under an hour (a part of a minute counts as a whole
 * one, so a live restriction never reads "in 0 minutes"), hours under two days, then days. Null when `at` is now or has passed.
 */
export function timeLeft(at: number, now: number, locale: string): string | null {
  const left = at - now;
  if (!(left > 0)) return null;
  const rtf = new Intl.RelativeTimeFormat(safeLocale(locale), { numeric: 'always' });
  if (left < HOUR) return rtf.format(Math.max(1, Math.ceil(left / MIN)), 'minute');
  if (left < 2 * DAY) return rtf.format(Math.round(left / HOUR), 'hour');
  return rtf.format(Math.round(left / DAY), 'day');
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
 * @experimental
 */
export function secondsLeft(ms: number, locale: string): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || !(ms > 0)) return null;
  if (ms <= 120_000) return bare(Math.ceil(ms / 1000), 'second', locale);
  if (ms <= 120 * MIN) return bare(Math.ceil(ms / MIN), 'minute', locale);
  if (ms < 2 * DAY) return bare(Math.ceil(ms / HOUR), 'hour', locale);
  return bare(Math.ceil(ms / DAY), 'day', locale);
}
