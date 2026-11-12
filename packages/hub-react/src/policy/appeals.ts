import type { AppealSettings } from '@chatwarden/core';
import type { Problems } from './panels.js';

// The draft of the "Appeals" panel: what the owner types or switches, what it means in the kit's own terms, and the checks the kit makes again on its side. Pure:
// nothing here reads the page or sends anything.

export interface AppealsDraft {
  enabled: boolean;
  /** Appeals one player may file in a rolling week, as typed. */
  perWeek: string;
  /** The person who made a decision may decide its appeal (for a team of one). */
  self: boolean;
}

/** The kit's range for the weekly limit and its default (core `appeals.ts`). */
const WEEK = [1, 20] as const;
const WEEK_DEFAULT = 3;

/** What the kit reports in force (`effective.appeals`); an older server sends none, which reads as off with the defaults. */
type Appeals = Partial<{ enabled: boolean; perPlayerPerWeek: number; allowSelfReview: boolean }> | undefined;

export const appealsDraftOf = (a: Appeals): AppealsDraft => ({
  enabled: a?.enabled === true,
  perWeek: String(typeof a?.perPlayerPerWeek === 'number' ? a.perPlayerPerWeek : WEEK_DEFAULT),
  self: a?.allowSelfReview === true,
});

/** The weekly limit as a number, or null when what was typed is not a whole number in range. */
export function weeklyLimit(text: string): number | null {
  const s = text.trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= WEEK[0] && n <= WEEK[1] ? n : null;
}

/** The fields that cannot be sent, by the field's key. */
export function appealsProblems(d: AppealsDraft): Problems {
  return weeklyLimit(d.perWeek) === null ? { perWeek: { key: 'hub.settings.appeals.error.limit', params: { min: WEEK[0], max: WEEK[1] } } } : {};
}

/** The appeals section to save: every field named, so a setting the owner left alone is still the same after a change in the code. Only for a draft with no problems. */
export function appealsLayer(d: AppealsDraft): AppealSettings {
  return { enabled: d.enabled, perPlayerPerWeek: weeklyLimit(d.perWeek) as number, allowSelfReview: d.self };
}

/** Is the draft different from what is in force? (A typed `03` is the same limit as 3.) */
export const appealsDirty = (d: AppealsDraft, effective: Appeals): boolean => {
  const saved = appealsDraftOf(effective);
  const same = (x: AppealsDraft): string => JSON.stringify([x.enabled, weeklyLimit(x.perWeek) ?? x.perWeek.trim(), x.self]);
  return same(d) !== same(saved);
};

/** The field a refusal's layer path names, as the draft's key; null for a path that is not one of the fields. */
export function appealsFieldKey(path: string): string | null {
  if (path === 'layer.appeals.perPlayerPerWeek') return 'perWeek';
  if (path === 'layer.appeals.enabled') return 'enabled';
  if (path === 'layer.appeals.allowSelfReview') return 'self';
  return null;
}

/** The words for a rule's band: a rate is never a number outside the table, and no band is a colour. `null`: too few sanctions for a rate. */
export const BAND_TEXT = {
  normal: 'hub.settings.appeals.band.normal',
  elevated: 'hub.settings.appeals.band.elevated',
  high: 'hub.settings.appeals.band.high',
  none: 'hub.settings.appeals.band.none',
} as const;

export const bandOf = (band: 'normal' | 'elevated' | 'high' | null): keyof typeof BAND_TEXT => band ?? 'none';
