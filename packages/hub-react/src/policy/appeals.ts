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
  /** How long a signed appeal link works, in milliseconds, as the select holds it (a value of the list, or the stored one when it is not on the list). */
  linkMs: string;
  /** The support contact shown on the appeal page, as typed; blank is none. */
  contact: string;
  /** The person is emailed the outcome (through the game's own hook: the kit never sends email). */
  emails: boolean;
}

/** The kit's range for the weekly limit and its default (core `appeals.ts`). */
const WEEK = [1, 20] as const;
const WEEK_DEFAULT = 3;
/** The link's default (30 days) and the days the select offers. The kit accepts one hour to 365 days; a stored value that is not on the list stays selectable as it is. */
const DAY_MS = 86_400_000;
const LINK_DEFAULT_MS = 30 * DAY_MS;
export const LINK_DAYS: readonly number[] = [1, 7, 14, 30, 90, 180, 365];
/** The longest support contact, in characters (core `appeals.ts`). */
export const CONTACT_MAX = 200;

/** What the kit reports in force (`effective.appeals`); an older server sends none, which reads as off with the defaults. */
type Appeals = Partial<{ enabled: boolean; perPlayerPerWeek: number; allowSelfReview: boolean; linkTtlMs: number; contact: string | null; emailsOutcome: boolean }> | undefined;

export const appealsDraftOf = (a: Appeals): AppealsDraft => ({
  enabled: a?.enabled === true,
  perWeek: String(typeof a?.perPlayerPerWeek === 'number' ? a.perPlayerPerWeek : WEEK_DEFAULT),
  self: a?.allowSelfReview === true,
  linkMs: String(typeof a?.linkTtlMs === 'number' ? a.linkTtlMs : LINK_DEFAULT_MS),
  contact: typeof a?.contact === 'string' ? a.contact : '',
  emails: a?.emailsOutcome === true,
});

/** The link length in force (or the default), as milliseconds. */
const linkInForce = (effective: Appeals): number => (typeof effective?.linkTtlMs === 'number' ? effective.linkTtlMs : LINK_DEFAULT_MS);
/** The link length the select holds, or null when it is not a number (it cannot be: the select offers numbers only). */
const linkOf = (d: AppealsDraft): number | null => {
  const n = Number(d.linkMs);
  return Number.isFinite(n) && n > 0 ? n : null;
};
/** The contact as it would be saved: trimmed, and null for blank. */
const contactOf = (d: AppealsDraft): string | null => (d.contact.trim() === '' ? null : d.contact.trim());
/** The contact is one line of at most 200 characters with no control character (the kit also refuses bidirectional and zero-width ones and says so). */
export function contactFits(text: string): boolean {
  const t = text.trim();
  if ([...t].length > CONTACT_MAX) return false;
  return ![...t].some((ch) => ch.charCodeAt(0) < 32 || (ch.charCodeAt(0) >= 127 && ch.charCodeAt(0) <= 159));
}


/** The weekly limit as a number, or null when what was typed is not a whole number in range. */
export function weeklyLimit(text: string): number | null {
  const s = text.trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= WEEK[0] && n <= WEEK[1] ? n : null;
}

/** The limit in force (or the default), for a draft whose typed limit is no use. */
const keptLimit = (effective: Appeals): number => {
  const n = effective?.perPlayerPerWeek;
  return typeof n === 'number' && n >= WEEK[0] && n <= WEEK[1] ? n : WEEK_DEFAULT;
};

/**
 * The fields that cannot be sent, by the field's key. The limit is checked only while appeals are on: with them off its field is disabled, so a bad value
 * typed before the switch was turned off must not hold the form (the limit in force is kept instead).
 */
export function appealsProblems(d: AppealsDraft): Problems {
  return {
    ...(d.enabled && weeklyLimit(d.perWeek) === null ? { perWeek: { key: 'hub.settings.appeals.error.limit' as const, params: { min: WEEK[0], max: WEEK[1] } } } : {}),
    // The contact field is never disabled, so it is checked whether appeals are on or not.
    ...(contactFits(d.contact) ? {} : { contact: { key: 'hub.settings.appeals.contact.error' as const, params: { max: CONTACT_MAX } } }),
  };
}

/**
 * The appeals section to save: the three first fields always named, so a setting the owner left alone is still the same after a change in the code. The link length,
 * the contact and the email switch are named only when they changed or were already in the saved layer (`saved`), so a value that comes from the code stays the code's;
 * `words`, which this form has no control for, is carried over from the saved layer as it was. Only for a draft with no problems; with appeals off and a bad limit typed,
 * the limit in force is kept.
 */
export function appealsLayer(d: AppealsDraft, effective?: Appeals, saved?: AppealSettings): AppealSettings {
  const out: AppealSettings = { enabled: d.enabled, perPlayerPerWeek: weeklyLimit(d.perWeek) ?? keptLimit(effective), allowSelfReview: d.self };
  const had = (key: keyof AppealSettings): boolean => saved !== undefined && Object.hasOwn(saved, key);
  const link = linkOf(d) ?? linkInForce(effective);
  if (link !== linkInForce(effective) || had('linkTtlMs')) out.linkTtlMs = link;
  const contact = contactOf(d);
  if (contact !== (effective?.contact ?? null) || had('contact')) out.contact = contact;
  if (d.emails !== (effective?.emailsOutcome === true) || had('emailsOutcome')) out.emailsOutcome = d.emails;
  if (saved !== undefined && had('words') && saved.words !== undefined) out.words = saved.words;
  return out;
}

/** Is the draft different from what is in force? (A typed `03` is the same limit as 3.) */
export const appealsDirty = (d: AppealsDraft, effective: Appeals): boolean => {
  const saved = appealsDraftOf(effective);
  // With appeals off a bad limit is not a change (the limit in force is what would be saved).
  const same = (x: AppealsDraft): string => JSON.stringify([x.enabled, weeklyLimit(x.perWeek) ?? (x.enabled ? x.perWeek.trim() : keptLimit(effective)), x.self, linkOf(x), contactOf(x), x.emails]);
  return same(d) !== same(saved);
};

/** The field a refusal's layer path names, as the draft's key; null for a path that is not one of the fields. */
export function appealsFieldKey(path: string): string | null {
  if (path === 'layer.appeals.perPlayerPerWeek') return 'perWeek';
  if (path === 'layer.appeals.enabled') return 'enabled';
  if (path === 'layer.appeals.allowSelfReview') return 'self';
  if (path === 'layer.appeals.linkTtlMs') return 'link';
  if (path === 'layer.appeals.contact') return 'contact';
  if (path === 'layer.appeals.emailsOutcome') return 'emails';
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
