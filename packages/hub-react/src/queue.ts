import { liveClaim } from './claims.js';
import type { Claim, ReportCategory, ReportSummary } from './types.js';

/**
 * Everything waiting on one reported person. The unit of work in the queue is a person, not a report: the kit's queue is a flat,
 * paged list of reports, and this is the view the hub builds from it.
 * @experimental
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
  /** Distinct reasons the reporters gave, in the order the newest reports first gave them (`id` null: no reason given). A hint, never the truth. */
  reasons: ReportedReason[];
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
  /** The newest handle a report recorded for each of those reporters; a reporter none recorded one for has no entry (name them by their tag). */
  reporterHandles: Record<string, string>;
  /** When the oldest report in the group was filed, and the newest. */
  firstAt: number;
  latestAt: number;
  /** When the oldest report still open was filed, or null when none is open. */
  oldestOpenAt: number | null;
  /** Report ids, newest first. */
  reportIds: string[];
  /** The same reports, newest first, with what a moderator can tell them apart by. */
  entries: Array<{ id: string; category: ReportCategory; reason: string | null; reasonLabel: string | null; createdAt: number }>;
  /** Who holds the case (the person's open reports share one claim), or null. It may have lapsed: read it with `liveClaim`. */
  claim: Claim | null;
  /** The other staff who have the case open, sorted. A hint, never a lock. */
  viewing: string[];
}

/** What a reporter said a report was for: a reason id and its label now, or both null for a report that gave none. */
export interface ReportedReason {
  id: string | null;
  label: string | null;
}

/** @experimental */
export type QueueSort = 'latest' | 'oldest' | 'reports';

const newestFirst = (a: ReportSummary, b: ReportSummary): number => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * Groups queue rows by the person they are about. Pure: it does not change `items`, and the same set of reports gives the same
 * groups whatever order they arrived in. A report seen twice (pages that overlap) counts once.
 * - `latest` (default): the group with the newest report first.
 * - `oldest`: the longest-waiting first (by the oldest open report; a group with none open uses its oldest report).
 * - `reports`: the most reports first.
 * A tie is broken by the person ref, so the order is stable.
 * @experimental
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
    const reasons: ReportedReason[] = [];
    const rooms = new Set<string>();
    const reporters = new Set<string>();
    const reporterPersons: string[] = [];
    // No prototype: a reporter's ref is an opaque string, and `__proto__` or `constructor` must be a key like any other.
    const reporterHandles: Record<string, string> = Object.create(null) as Record<string, string>;
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
      // A server from before reasons sends none at all: that reads as no reason.
      const reason = r.reportedReason ?? null;
      if (!reasons.some((x) => x.id === reason)) reasons.push({ id: reason, label: reason === null ? null : (r.reportedReasonLabel ?? reason) });
      if (r.roomId !== '') rooms.add(r.roomId);
      reporters.add(r.reporterPerson);
      if (!reporterPersons.includes(r.reporterPerson)) reporterPersons.push(r.reporterPerson);
      // Newest first, so the first handle seen for a reporter is their latest. An older server sends none at all.
      const reporterHandle = r.reporterHandle ?? null;
      if (reporterHandle !== null && !Object.hasOwn(reporterHandles, r.reporterPerson)) reporterHandles[r.reporterPerson] = reporterHandle;
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
      reasons,
      reports: list.length,
      open,
      actioned,
      dismissed,
      rooms: [...rooms],
      reporters: reporters.size,
      reporterPersons,
      reporterHandles,
      firstAt: (list[list.length - 1] as ReportSummary).createdAt,
      latestAt: (list[0] as ReportSummary).createdAt,
      oldestOpenAt,
      reportIds: list.map((r) => r.id),
      entries: list.map((r) => ({ id: r.id, category: r.category, reason: r.reportedReason ?? null, reasonLabel: r.reportedReason == null ? null : (r.reportedReasonLabel ?? r.reportedReason), createdAt: r.createdAt })),
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

const NONE: ReadonlySet<string> = new Set();

/**
 * The next report to open about a person once `exceptId` is decided: the oldest other open one, and how many are left.
 * @experimental
 */
export interface NextReport {
  id: string;
  category: ReportCategory;
  createdAt: number;
  /** How many other open reports the person has (this one counted out), the one to open included. */
  left: number;
}

/**
 * One case per person: the report to go on to after deciding `exceptId`, from the live queue (which holds open reports only). The
 * oldest other open report of the same person, or null when it was their last. Entries are newest first, so the oldest is the last.
 * This is the one place the rule lives: the notice, "Decide and take next" and Ctrl+Enter all ask it.
 * @experimental
 */
export function nextOpenReport(groups: readonly QueueGroup[], person: string, exceptId: string, decided: ReadonlySet<string> = NONE): NextReport | null {
  const group = groups.find((g) => g.person === person);
  if (group === undefined) return null;
  // `decided`: reports whose decision is on its way (held or sent) are still in the queue until it is read again, but are done with.
  const others = group.entries.filter((e) => e.id !== exceptId && !decided.has(e.id));
  const oldest = others[others.length - 1];
  return oldest === undefined ? null : { ...oldest, left: others.length };
}

/** @experimental */
export interface QueueFilter {
  claim: 'all' | 'unclaimed' | 'mine';
  /** @deprecated The hub no longer offers it (the reason a reporter chose is the filter); kept for embedders, and still applied and sent to take next. */
  category: ReportCategory | 'all';
  /** A reason id, `none` for reports that gave no reason, or `all` (also when left out). */
  reason?: string;
}

/**
 * The cases a moderator has asked to see: by who holds them (a lapsed claim is nobody) and by category and by reason (a person with any report
 * in it). Order is kept; the input is not changed.
 * @experimental
 */
export function filterGroups(groups: readonly QueueGroup[], filter: QueueFilter, me: string, now: number): QueueGroup[] {
  return groups.filter((g) => {
    if (filter.category !== 'all' && !g.categories.includes(filter.category)) return false;
    const reason = filter.reason ?? 'all';
    if (reason !== 'all' && !g.reasons.some((x) => (reason === 'none' ? x.id === null : x.id === reason))) return false;
    const held = liveClaim(g.claim, now);
    if (filter.claim === 'unclaimed') return held === null;
    if (filter.claim === 'mine') return held !== null && held.by === me;
    return true;
  });
}

/** @experimental */
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

/**
 * The Overview's numbers, from groups built from the open queue.
 * @experimental
 */
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
