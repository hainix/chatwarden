import type { QueueGroup } from './queue.js';

// The rules of the background refresh, apart from React so they can be tested directly: how often to ask, and how to fold a fresh
// queue into the one on screen without moving anything under the moderator's cursor.

/** While the tab is visible, ask `GET /changes` this often. */
export const POLL_VISIBLE_MS = 5_000;
/** While it is hidden (another tab, a locked screen), this often. */
export const POLL_HIDDEN_MS = 30_000;
/** Once the connection banner is up, a visible tab asks this often: a server that is down does not need a call every 5 seconds. */
export const POLL_FAILING_MS = 15_000;
/** This many failures in a row show the connection banner (one is a blip). */
export const BANNER_AFTER_FAILURES = 2;

/** How long to wait before the next poll. */
export function pollDelay({ visible, failures }: { visible: boolean; failures: number }): number {
  if (!visible) return POLL_HIDDEN_MS;
  return failures >= BANNER_AFTER_FAILURES ? POLL_FAILING_MS : POLL_VISIBLE_MS;
}

/** A row on screen: the case, and whether it has closed since (it stays, marked, while the cursor is on it). */
export interface ShownRow {
  group: QueueGroup;
  gone: boolean;
}

/**
 * Folds a fresh queue into the rows on screen. Order is the order on screen, always. Then:
 * - a case still open takes its fresh data in place (a claim arrives, a report is added);
 * - a case that has closed is dropped, unless `keep(person)` says the cursor is on it, in which case it stays, marked `gone`,
 *   with its last data;
 * - a case not on screen yet is not added: it is counted in `incoming`, for the "N new" pill.
 * Running it again with the same fresh queue changes nothing more, so it can be re-run when the cursor moves away.
 */
export function reconcile(
  shown: readonly ShownRow[],
  fresh: readonly QueueGroup[],
  keep: (person: string) => boolean,
): { rows: ShownRow[]; incoming: number } {
  const byPerson = new Map(fresh.map((g) => [g.person, g]));
  const onScreen = new Set(shown.map((r) => r.group.person));
  const rows: ShownRow[] = [];
  for (const row of shown) {
    const now = byPerson.get(row.group.person);
    if (now !== undefined) rows.push({ group: now, gone: false });
    else if (keep(row.group.person)) rows.push({ group: row.group, gone: true });
  }
  let incoming = 0;
  for (const g of fresh) if (!onScreen.has(g.person)) incoming += 1;
  return { rows, incoming };
}

/** Takes the fresh queue as it is, in its own order: the first load, and the moment the moderator asks for the new cases. */
export function adopt(fresh: readonly QueueGroup[]): ShownRow[] {
  return fresh.map((group) => ({ group, gone: false }));
}
