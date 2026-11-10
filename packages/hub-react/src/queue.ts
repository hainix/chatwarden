import { liveClaim } from './claims.js';
import type { Claim, ReportCategory, ReportSummary } from './types.js';

/**
 * Everything waiting on one reported person. The unit of work in the queue is a person, not a report: the kit's queue is a flat,
 * paged list of reports, and this is the view the hub builds from it.
 */
export interface QueueGroup {
  /** The reported person's staff ref (opaque). Show {@link personTag}, never this. */
  person: string;
  /** The newest handle a report recorded for them, or null when none did. */
  handle: string | null;
  /** Every handle the reports recorded, newest first. */
  handles: string[];
  /** Distinct categories, in the order the newest reports first gave them. */
  categories: ReportCategory[];
  reports: number;
  open: number;
  actioned: number;
  dismissed: number;
  /** Distinct rooms, leaving out a blank one. */
  rooms: string[];
  /** Distinct people who reported. */
  reporters: number;
  /** Their staff refs (show the short tag, never the ref), newest report first. */
  reporterPersons: string[];
  /** When the oldest report in the group was filed, and the newest. */
  firstAt: number;
  latestAt: number;
  /** When the oldest report still open was filed, or null when none is open. */
  oldestOpenAt: number | null;
  /** Report ids, newest first. */
  reportIds: string[];
  /** The same reports, newest first, with what a moderator can tell them apart by. */
  entries: Array<{ id: string; category: ReportCategory; createdAt: number }>;
  /** Who holds the case (the person's open reports share one claim), or null. It may have lapsed: read it with `liveClaim`. */
  claim: Claim | null;
  /** The other staff who have the case open, sorted. A hint, never a lock. */
  viewing: string[];
}

export type QueueSort = 'latest' | 'oldest' | 'reports';

const newestFirst = (a: ReportSummary, b: ReportSummary): number => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * Groups queue rows by the person they are about. Pure: it does not change `items`, and the same set of reports gives the same
 * groups whatever order they arrived in. A report seen twice (pages that overlap) counts once.
 * - `latest` (default): the group with the newest report first.
 * - `oldest`: the longest-waiting first (by the oldest open report; a group with none open uses its oldest report).
 * - `reports`: the most reports first.
 * A tie is broken by the person ref, so the order is stable.
 */
export function groupQueue(items: readonly ReportSummary[], options: { sort?: QueueSort } = {}): QueueGroup[] {
  const byId = new Map<string, ReportSummary>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  const byPerson = new Map<string, ReportSummary[]>();
  for (const item of [...byId.values()].sort(newestFirst)) {
    const list = byPerson.get(item.targetPerson);
    if (list === undefined) byPerson.set(item.targetPerson, [item]);
    else list.push(item);
  }

  const groups: QueueGroup[] = [];
  for (const [person, list] of byPerson) {
    const handles: string[] = [];
    const categories: ReportCategory[] = [];
    const rooms = new Set<string>();
    const reporters = new Set<string>();
    const reporterPersons: string[] = [];
    let open = 0;
    let actioned = 0;
    let dismissed = 0;
    let oldestOpenAt: number | null = null;
    let claim: Claim | null = null;
    const viewing = new Set<string>();
    for (const r of list) {
      // Claims and viewers belong to the case, and the server sends them only on open reports (and, from an older server, not at all).
      if (r.status === 'open') {
        if (claim === null && r.claim !== null && r.claim !== undefined) claim = { by: r.claim.by, since: r.claim.since, until: r.claim.until };
        for (const v of r.viewing ?? []) viewing.add(v);
      }
      if (r.targetHandle !== null && !handles.includes(r.targetHandle)) handles.push(r.targetHandle);
      if (!categories.includes(r.category)) categories.push(r.category);
      if (r.roomId !== '') rooms.add(r.roomId);
      reporters.add(r.reporterPerson);
      if (!reporterPersons.includes(r.reporterPerson)) reporterPersons.push(r.reporterPerson);
      if (r.status === 'open') {
        open += 1;
        oldestOpenAt = oldestOpenAt === null ? r.createdAt : Math.min(oldestOpenAt, r.createdAt);
      } else if (r.status === 'actioned') actioned += 1;
      else dismissed += 1;
    }
    groups.push({
      person,
      handle: handles[0] ?? null,
      handles,
      categories,
      reports: list.length,
      open,
      actioned,
      dismissed,
      rooms: [...rooms],
      reporters: reporters.size,
      reporterPersons,
      firstAt: (list[list.length - 1] as ReportSummary).createdAt,
      latestAt: (list[0] as ReportSummary).createdAt,
      oldestOpenAt,
      reportIds: list.map((r) => r.id),
      entries: list.map((r) => ({ id: r.id, category: r.category, createdAt: r.createdAt })),
      claim,
      viewing: [...viewing].sort(),
    });
  }

  const waitStart = (g: QueueGroup): number => g.oldestOpenAt ?? g.firstAt;
  const sort = options.sort ?? 'latest';
  const order: Record<QueueSort, (a: QueueGroup, b: QueueGroup) => number> = {
    latest: (a, b) => b.latestAt - a.latestAt,
    oldest: (a, b) => waitStart(a) - waitStart(b),
    reports: (a, b) => b.reports - a.reports || b.latestAt - a.latestAt,
  };
  return groups.sort((a, b) => order[sort](a, b) || (a.person < b.person ? -1 : a.person > b.person ? 1 : 0));
}

export interface QueueFilter {
  claim: 'all' | 'unclaimed' | 'mine';
  category: ReportCategory | 'all';
}

/**
 * The cases a moderator has asked to see: by who holds them (a lapsed claim is nobody) and by category (a person with any report
 * in it). Order is kept; the input is not changed.
 */
export function filterGroups(groups: readonly QueueGroup[], filter: QueueFilter, me: string, now: number): QueueGroup[] {
  return groups.filter((g) => {
    if (filter.category !== 'all' && !g.categories.includes(filter.category)) return false;
    const held = liveClaim(g.claim, now);
    if (filter.claim === 'unclaimed') return held === null;
    if (filter.claim === 'mine') return held !== null && held.by === me;
    return true;
  });
}

export interface QueueStats {
  /** People with something open. */
  people: number;
  /** Open reports. */
  reports: number;
  /** How long the oldest open report has waited, or null when nothing is open. */
  longestWaitMs: number | null;
  /** The group that report is in. */
  oldestGroup: QueueGroup | null;
}

/** The Overview's numbers, from groups built from the open queue. */
export function queueStats(groups: readonly QueueGroup[], now: number): QueueStats {
  let people = 0;
  let reports = 0;
  let oldestGroup: QueueGroup | null = null;
  for (const g of groups) {
    if (g.open === 0) continue;
    people += 1;
    reports += g.open;
    if (g.oldestOpenAt !== null && (oldestGroup === null || g.oldestOpenAt < (oldestGroup.oldestOpenAt as number))) oldestGroup = g;
  }
  return {
    people,
    reports,
    longestWaitMs: oldestGroup === null ? null : Math.max(0, now - (oldestGroup.oldestOpenAt as number)),
    oldestGroup,
  };
}
