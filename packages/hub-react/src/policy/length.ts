import type { Problem } from '../decision.js';
import type { HubText } from '../i18n.js';

// A length of time as a moderator picks or types it: from the profile's list, permanent, or a number of hours or days. The bounds
// are the kit's: a whole number of minutes from 1 minute up to 365 days. Pure, so the same rules serve the decision form, the
// sanction form and the settings screen.

export const MIN_LENGTH_MS = 60_000;
export const MAX_LENGTH_MS = 365 * 86_400_000;
/** The most lengths a profile lists (the kit's `MAX_DURATIONS`). */
export const MAX_LISTED = 50;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type LengthUnit = 'hours' | 'days';
export const LENGTH_UNITS: readonly LengthUnit[] = ['hours', 'days'];
const UNIT_MS: Record<LengthUnit, number> = { hours: HOUR, days: DAY };

/** The four keys the menus used before the lengths came from the profile. They still read, and name those four lengths. */
const OLD_KEYS: Readonly<Record<string, number>> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

type LengthResult = { ok: true; ms: number } | { ok: false; problem: Problem };
const fail = (key: HubText): { ok: false; problem: Problem } => ({ ok: false, problem: { key } });

/** A typed number and its unit as milliseconds, or the plain reason it cannot be a length. */
export function parseAmount(amount: string, unit: LengthUnit): LengthResult {
  const text = amount.trim();
  if (text === '') return fail('hub.length.error.empty');
  if (!/^\d+(\.\d+)?$/.test(text)) return fail('hub.length.error.number');
  const ms = Math.round(Number(text) * UNIT_MS[unit]);
  if (!Number.isFinite(ms)) return fail('hub.length.error.number');
  if (ms < MIN_LENGTH_MS) return fail('hub.length.error.short');
  if (ms > MAX_LENGTH_MS) return fail('hub.length.error.long');
  if (ms % MIN_LENGTH_MS !== 0) return fail('hub.length.error.whole');
  return { ok: true, ms };
}

/** A length field: what the menu holds (`lengthValue`, `permanent` or `custom`), and for `custom` the number and unit typed. */
export interface LengthDraft {
  value: string;
  amount: string;
  unit: LengthUnit;
}

/** What a length field says: milliseconds (null for permanent), or why it says nothing yet. Never reads a bad value as permanent. */
export function resolveLength(l: LengthDraft): { ok: true; ms: number | null } | { ok: false; problem: Problem } {
  if (l.value === 'permanent') return { ok: true, ms: null };
  if (l.value === 'custom') return parseAmount(l.amount, l.unit);
  const old = OLD_KEYS[l.value];
  if (old !== undefined) return { ok: true, ms: old };
  if (/^[1-9]\d{0,15}$/.test(l.value)) {
    const ms = Number(l.value);
    if (ms <= MAX_LENGTH_MS) return { ok: true, ms };
    return fail('hub.length.error.long');
  }
  return fail('hub.length.error.number');
}

/** The menu value for a length: the old key for the four it had, else the milliseconds as text; `permanent` for null. */
export function lengthValue(ms: number | null): string {
  if (ms === null) return 'permanent';
  const old = Object.entries(OLD_KEYS).find(([, v]) => v === ms);
  return old === undefined ? String(ms) : old[0];
}

/** A length that is on the menu and nearest `target` (the shorter on a tie); null when the menu is empty. */
export function nearestLength(options: readonly number[], target: number): number | null {
  let best: number | null = null;
  for (const o of options) {
    if (best === null || Math.abs(o - target) < Math.abs(best - target) || (Math.abs(o - target) === Math.abs(best - target) && o < best)) best = o;
  }
  return best;
}

/** The list with `ms` put in its place; refused when it is out of range, already there, or the list is full. Never changes the list it was given. */
export function addDuration(list: readonly number[], ms: number): { ok: true; list: number[] } | { ok: false; problem: Problem } {
  if (!Number.isSafeInteger(ms) || ms < MIN_LENGTH_MS) return fail('hub.length.error.short');
  if (ms > MAX_LENGTH_MS) return fail('hub.length.error.long');
  if (list.includes(ms)) return fail('hub.length.error.duplicate');
  if (list.length >= MAX_LISTED) return fail('hub.length.error.tooMany');
  return { ok: true, list: [...list, ms].sort((a, b) => a - b) };
}

export const removeDuration = (list: readonly number[], ms: number): number[] => list.filter((x) => x !== ms);
