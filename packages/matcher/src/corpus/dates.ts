const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * A UTC timestamp `YYYY-MM-DDTHH:MM:SSZ` (milliseconds optional) that is a real moment, as epoch ms; null for anything else
 * (another shape, an offset, 30 February). Pure; the corpus files and the index use no other date form.
 */
export function parseUtcDate(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = DATE_RE.exec(v);
  if (m === null) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const t = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const back = new Date(t);
  // Date.UTC rolls 30 February over to March; a real calendar day reads back as itself.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return t;
}
