// Small pure helpers for showing people, times and waits. Times use Intl, with the hub's `locale`; none holds English.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How many characters of a person ref the hub ever shows. The full ref is a staff id and stays out of the page. */
export const PERSON_TAG_LENGTH = 8;

/** The short tag for a person: the first 8 characters of their ref. */
export function personTag(ref: string): string {
  return Array.from(ref).slice(0, PERSON_TAG_LENGTH).join('');
}

function safeLocale(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/**
 * "5 minutes ago", "3 days ago", in the locale. Under a minute, and any time in the future (a clock that is a little off),
 * reads as the locale's word for now ("now" in English): `numeric: 'auto'` gives it.
 */
export function relativeTime(at: number, now: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(safeLocale(locale), { numeric: 'auto' });
  const ago = now - at;
  if (ago < MIN) return rtf.format(0, 'second');
  if (ago < HOUR) return rtf.format(-Math.round(ago / MIN), 'minute');
  if (ago < DAY) return rtf.format(-Math.round(ago / HOUR), 'hour');
  return rtf.format(-Math.round(ago / DAY), 'day');
}

/** A date and time for a tooltip: `Jan 15, 2027, 8:00 AM`. Pass a time zone in tests; the default is the viewer's. */
export function absoluteTime(at: number, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(safeLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);
}

/** An elapsed time in the largest whole unit up to days: `<1m`, `5m`, `2h`, `3d`. */
export function formatDuration(ms: number, locale: string): string {
  const loc = safeLocale(locale);
  const unit = (value: number, u: 'minute' | 'hour' | 'day'): string =>
    new Intl.NumberFormat(loc, { style: 'unit', unit: u, unitDisplay: 'narrow', maximumFractionDigits: 0 }).format(value);
  if (ms < MIN) return `<${unit(1, 'minute')}`;
  if (ms < HOUR) return unit(Math.floor(ms / MIN), 'minute');
  if (ms < DAY * 2) return unit(Math.floor(ms / HOUR), 'hour');
  return unit(Math.floor(ms / DAY), 'day');
}

export type WaitTone = 'fresh' | 'aging' | 'stale';

/** How worried to look about a wait: under an hour is fresh, under a day aging, a day or more stale. */
export function waitTone(ms: number): WaitTone {
  if (ms < HOUR) return 'fresh';
  if (ms < DAY) return 'aging';
  return 'stale';
}

/** The clock time of a moment, `8:05:09 AM`. Pass a time zone in tests; the default is the viewer's. */
export function timeOfDay(at: number, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(safeLocale(locale), { timeStyle: 'medium', ...(timeZone === undefined ? {} : { timeZone }) }).format(at);
}

/** A list read aloud in the locale: `a, b, and c`. */
export function listOf(items: readonly string[], locale: string): string {
  return new Intl.ListFormat(safeLocale(locale), { style: 'long', type: 'conjunction' }).format(items);
}
