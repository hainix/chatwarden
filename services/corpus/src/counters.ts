import { hex } from './b64.js';
import type { Clock } from './deps.js';
import type { D1Like } from './env.js';

// Rate limits (design 6.9, 10.4). A counter row is a (key, day) pair: `inst:<hash of the installation key>` and `net:<keyed hash of the
// network and the day>`. The address itself is never written, and a counter is deleted two days after its day.

export const LIMITS = {
  perInstallationDaily: 20,
  perNetworkDaily: 60,
  /** Reads of a submission's status per network per day. */
  statusDaily: 600,
  /** Submissions waiting for a decision, per installation. */
  pending: 200,
  /** An installation whose last this-many decisions were all declines is locked for `lockDays`. */
  lockStreak: 10,
  lockDays: 7,
  /** Counter rows older than this many days are purged. */
  counterDays: 2,
  /** A note is deleted this many days after its submission was decided. */
  noteDays: 90,
} as const;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day of a time, `YYYY-MM-DD`. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A time as ISO 8601 to the second, so two stamps compare as text. */
export const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** `YYYY-MM-DD` that really is a calendar day. */
export function isDay(text: unknown): text is string {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const t = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(t) && dayOf(t) === text;
}

/** The day `n` days from a day. */
export const addDays = (day: string, n: number): string => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);

/** Whole seconds from `ms` to the next UTC midnight. */
export const secondsToNextDay = (ms: number): number => Math.ceil((Date.parse(`${dayOf(ms)}T00:00:00Z`) + DAY_MS - ms) / 1000);

const V4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/**
 * The network a request counts against: an IPv4 address as it is, an IPv6 address as its /64 (a person holds a whole /64, so the low
 * bits cost nothing to change), a v4-mapped address as its IPv4, and anything else as one shared bucket, `unknown`.
 */
export function networkPrefix(ip: unknown): string {
  if (typeof ip !== 'string') return 'unknown';
  const t = ip.trim().toLowerCase();
  if (V4.test(t)) return t;
  if (t.length === 0 || t.length > 45 || !/^[0-9a-f:.]+$/.test(t)) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (mapped !== null) return V4.test(mapped[1] as string) ? (mapped[1] as string) : 'unknown';
  const halves = t.split('::');
  if (halves.length > 2) return 'unknown';
  const head = halves[0] === '' ? [] : (halves[0] as string).split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? (halves[1] as string).split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return 'unknown';
  const groups = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return 'unknown';
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':');
}

/** The counter key of a network on a day: a keyed hash, so the address cannot be read back or looked up across days. */
export async function networkKey(secret: string, day: string, ip: unknown): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`net:${day}:${networkPrefix(ip)}`)));
  return `net:${hex(mac).slice(0, 32)}`;
}

/** Counts one hit of `key` on `day` and returns the count including this one. */
export async function hit(db: D1Like, key: string, day: string): Promise<number> {
  const row = await db
    .prepare('INSERT INTO counters (key, day, n) VALUES (?, ?, 1) ON CONFLICT (key, day) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(key, day)
    .first<{ n: number }>();
  return row === null ? 1 : row.n;
}

/** Deletes what has outlived its use: counters older than two days, and the notes of submissions decided 90 days ago or more. */
export async function purgeExpired(db: D1Like, clock: Clock): Promise<{ counters: number; notes: number }> {
  const now = clock.now();
  const counters = await db.prepare('DELETE FROM counters WHERE day < ?').bind(addDays(dayOf(now), -LIMITS.counterDays)).run();
  const notes = await db
    .prepare('UPDATE submissions SET note = NULL WHERE note IS NOT NULL AND decided_at IS NOT NULL AND decided_at <= ?')
    .bind(isoSeconds(now - LIMITS.noteDays * DAY_MS))
    .run();
  return { counters: counters.meta.changes, notes: notes.meta.changes };
}
