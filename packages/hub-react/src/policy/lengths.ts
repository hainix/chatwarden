import { DEFAULT_DURATIONS } from '@chatwarden/core';
import { DURATIONS } from '../decision.js';
import type { SanctionKind } from '../types.js';
import { lengthValue, nearestLength, resolveLength } from './length.js';
import type { LengthMenu } from './LengthField.js';

/** What the profile offers for a length: its list, and whether a moderator may type their own. */
export interface LengthPolicy {
  durations: readonly number[];
  custom: boolean;
}

/** The lengths of a profile (read defensively: an older kit leaves the two fields out), or undefined while the profile is not read. */
export function lengthsOf(profile: { durations?: readonly number[]; customDuration?: boolean } | undefined): LengthPolicy | undefined {
  return profile === undefined ? undefined : { durations: profile.durations ?? DEFAULT_DURATIONS, custom: profile.customDuration ?? true };
}

/** What a form offers when it does not know the profile: the four lengths it always had, and no custom one. */
export const LEGACY_LENGTHS: LengthPolicy = { durations: DURATIONS.flatMap((d) => (d.ms === null ? [] : [d.ms])), custom: false };

/** The menu for one kind: permanent is left out of a ban for a role that may not give one. */
export const menuOf = (lengths: LengthPolicy | undefined, kind: SanctionKind | '', canPermanent: boolean): LengthMenu => {
  const l = lengths ?? LEGACY_LENGTHS;
  return { durations: l.durations, permanent: kind !== 'ban' || canPermanent, custom: l.custom };
};

const DAY = 86_400_000;

/**
 * The value to hold in a length field so it is on the menu: what it already holds when that is offered, else the length nearest to a
 * day (a form starts on 24 hours, which a profile may not list), else a custom length (it needs a number), else nothing (`''`).
 */
export function snapLength(value: string, menu: LengthMenu): string {
  if (value === 'permanent') {
    if (menu.permanent) return value;
  } else if (value === 'custom') {
    if (menu.custom) return value;
  } else {
    const r = resolveLength({ value, amount: '', unit: 'hours' });
    if (r.ok && r.ms !== null && menu.durations.includes(r.ms)) return value;
  }
  const near = nearestLength(menu.durations, DAY);
  if (near !== null) return lengthValue(near);
  // Nothing listed: never default to permanent (a destructive length nobody chose). A custom length needs a typed number, so it blocks
  // the send; with no custom either, the field is left unset and says so.
  return menu.custom ? 'custom' : '';
}
