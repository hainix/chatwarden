import { useHub } from './context.js';
import type { ChoiceLimits } from './decision.js';

// Which optional features this hub shows, and to whom. A feature the server has off, or a role without its permission, draws nothing: the pages are what
// 0.1.7 drew. The server is the second lock (every route is a 404 or a 403 for what is off or not allowed).

export interface Features {
  /** Appeals are on and the role may read them: the Appeals view, its number, Simple's line. */
  appeals: boolean;
  /** A moderator may ask for a new name and this role may apply sanctions: the last option of the Sanction form. */
  renames: boolean;
  /** The server wired the shared term list and this role may read terms: the Settings section, and the Share disclosure's question to the server. */
  community: boolean;
  /** `desk.workflow` is on: the staff comment thread and the second look ("Ask a senior to look"). The server's word; the permission is checked where each control is. */
  workflow: boolean;
  /** `desk.insights` is on and the role may read it: the Insights page, its Overview link and its command-bar entry. */
  insights: boolean;
}

/** What a scoped caller may apply when the server did not say (an older server): what a kit's default is. */
const FALLBACK_LIMITS: ChoiceLimits = { kinds: ['warning', 'chat'], maxDurationMs: 7 * 86_400_000 };

/**
 * What the caller may apply, or undefined for a caller with no scope (the permissions are their only limit). A scoped caller's forms offer only these kinds and lengths, no IP and no request for a new name:
 * what the server would refuse (`invalid_sanction`, 403) is never offered. The server is the second lock.
 */
export function useScopedLimits(): ChoiceLimits | undefined {
  const { me } = useHub();
  return me.scope === undefined ? undefined : (me.scopedLimits ?? FALLBACK_LIMITS);
}

export function useFeatures(): Features {
  const { me, can } = useHub();
  const appeals = me.features?.appeals === true && can('appeals.read');
  return { appeals, renames: me.scope === undefined && me.features?.renames === true && can('sanctions.apply'), community: me.features?.community === true && can('terms.read'), workflow: me.features?.workflow === true, insights: me.features?.insights === true && can('insights.read') };
}
