import type { SanctionKind } from '../types.js';

// What "Make it lighter..." offers, as the kit's own rule (core `reductionOf`) reads it: a reduction goes to a LOWER kind (warning, chat, area, ban: lightest
// first) for any length up to the original's, or to the SAME kind and strictly shorter. Permanent is the longest. A warning has no length and nothing lighter.
// The lengths are the profile's own list; the server checks again and refuses one the profile does not offer.

export type LighterKind = 'warning' | 'chat' | 'area' | 'ban';
const ORDER: readonly LighterKind[] = ['warning', 'chat', 'area', 'ban'];

/** The sanction as the picker sees it: its kind and its length in milliseconds (null: permanent, or a warning). */
export interface Given {
  kind: SanctionKind;
  length: number | null;
}

/** Lengths the profile offers that a reduction to `to` may take, shortest first; `null` stands for permanent (only a lower kind from a permanent sanction). */
export function lighterLengths(to: LighterKind, from: Given, offered: readonly number[]): Array<number | null> {
  if (to === 'warning') return [];
  const origin = ORDER.indexOf(from.kind as LighterKind);
  const target = ORDER.indexOf(to);
  if (origin <= 0 || target < 0 || target > origin) return [];
  const longest = from.length === null ? Infinity : from.length;
  const same = target === origin;
  const finite = [...new Set(offered)].filter((ms) => (same ? ms < longest : ms <= longest)).sort((a, b) => a - b);
  return !same && from.length === null ? [...finite, null] : finite;
}

/** The kinds a reduction may go to, lightest first: every lower kind, and the same kind when some offered length is shorter. */
export function lighterKinds(from: Given, offered: readonly number[]): LighterKind[] {
  const origin = ORDER.indexOf(from.kind as LighterKind);
  if (origin <= 0) return [];
  return ORDER.filter((kind, i) => i < origin || (i === origin && lighterLengths(kind, from, offered).length > 0));
}
