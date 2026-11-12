import { useHub } from './context.js';

// Which optional features this hub shows, and to whom. A feature the server has off, or a role without its permission, draws nothing: the pages are what
// 0.1.7 drew. The server is the second lock (every route is a 404 or a 403 for what is off or not allowed).

export interface Features {
  /** Appeals are on and the role may read them: the Appeals view, its number, Simple's line. */
  appeals: boolean;
  /** Appeals can be decided by this role (needs `appeals` too). */
  decideAppeals: boolean;
  /** A moderator may ask for a new name and this role may apply sanctions: the last option of the Sanction form. */
  renames: boolean;
}

export function useFeatures(): Features {
  const { me, can } = useHub();
  const appeals = me.features?.appeals === true && can('appeals.read');
  return { appeals, decideAppeals: appeals && can('appeals.decide'), renames: me.features?.renames === true && can('sanctions.apply') };
}
