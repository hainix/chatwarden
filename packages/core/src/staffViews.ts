import { checkScope } from './contexts.js';
import { HISTORY_LOOKBACK_MS, historyOf } from './ladder.js';
import type { ActionRecord } from './ladder.js';
import type { Limits } from './limits.js';
import { reporterSuspendedUntil } from './reports.js';
import { findReason } from './reporting.js';
import type { ReportReason } from './reporting.js';
import { reporterAccuracyFor, summarizeOutcomes } from './reporterAccuracy.js';
import type { ReporterAccuracy } from './reporterAccuracy.js';
import { parseRuleRef } from './rules.js';
import type { RuleRef } from './rules.js';
import { SANCTION_SOURCES } from './sanctions.js';
import { b64urlDecode, b64urlEncode } from './staffReports.js';
import type { NameReason } from './names.js';
import type { SubjectIndex } from './subjects.js';
import type { ReportRecord, SanctionKind, SanctionRow, Source, Store, SubjectId } from './types.js';

// The staff READ views behind the moderator hub: sanction groups, a reporter's record and the blocked-message list. Pure
// functions over the store; nothing here writes. Every shape lists its fields by name, so a column added to a row can
// never leak into a response. They carry subject ids and raw chat lines: staff channels only, never send to a player.

const DAY_MS = 24 * 3_600_000;

// ---------------------------------------------------------------------------
// Sanction groups
// ---------------------------------------------------------------------------

/**
 * One sanction as the staff see it, built from the SUBJECT row of its group alone: never the IP row, and never a stored
 * identifier (no row id, no `value`, no hashed IP). A group is one view however many rows it has.
 *
 * - `rule`: the cited Community Rule (`parseRuleRef`); null on a row written before rules existed.
 * - `endsAt`: epoch ms the restriction stops applying, null when permanent. A warning or note has no end, so it is null too
 *   (`kind` tells the two apart; the stored row has `endsAt === startsAt` for those).
 * - `active`: see {@link isSanctionActive}. It is about time and revocation only, not about enforcement.
 * - `pending`: true when the sanction was written while enforcement was off (it applies nothing until enforcement is on).
 *   The hub can label such a row; it does not change `active`.
 * - `revokedAt`, `revokedBy`, `revokeReason`: who lifted it, when and why; all null while it stands. A group revoked
 *   before the actor was kept reads `revokedBy` and `revokeReason` as the store has them (the columns have existed since
 *   the first sanction migration, so in practice both are set).
 *
 * Carries staff-only text (`reason`, `actor`): never send to a player.
 */
export interface SanctionGroupView {
  groupId: string;
  refCode: string;
  kind: SanctionKind;
  rule: RuleRef | null;
  startsAt: number;
  endsAt: number | null;
  reason: string;
  actor: string;
  source: Source;
  automated: boolean;
  active: boolean;
  pending: boolean;
  revokedAt: number | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

/** A {@link SanctionGroupView} with the canonical person it is about (a staff ref). */
export interface PersonSanctionView extends SanctionGroupView {
  person: SubjectId;
}

/** One page of {@link PersonSanctionView}, newest first. `next` is an opaque cursor, or null when the page was not full. */
export interface SanctionPage {
  items: PersonSanctionView[];
  next: string | null;
}

/** What `cw.sanctions.list` takes. Every field is optional. */
export interface SanctionListInput {
  /** The `next` of the previous page. Omit or null for the first page. */
  cursor?: string | null;
  /** Page size: default 50, clamped to 1..200 (never rejected). */
  limit?: number;
  /** Only sanctions from this source. */
  source?: Source;
  /** Only the sanctions made from a report filed in a room of one of these staff scopes (a direct or an automatic sanction is never one of them); an empty list lists nothing. */
  scope?: readonly string[];
}

/** The page size when `limit` is missing or not a number. */
export const SANCTION_PAGE_DEFAULT = 50;
/** The largest page; a bigger `limit` is clamped to this. */
export const SANCTION_PAGE_MAX = 200;
/** The most sanction groups `cw.sanctions.forPerson` returns (the newest). */
export const PERSON_SANCTIONS_MAX = 200;

/** A sanction list query that cannot be answered: a cursor that is not one we issued, or an unknown source. The message never echoes the input. */
export class SanctionQueryError extends Error {
  readonly field: 'cursor' | 'source';
  constructor(field: 'cursor' | 'source') {
    super(`sanctions.list: invalid ${field}`);
    this.name = 'SanctionQueryError';
    this.field = field;
  }
}

/**
 * Is this sanction in force at `now`? A revoked row never is, nor is one that has not started (`startsAt` after `now`). A restriction (chat, area, ban) applies strictly before its
 * `endsAt` and, with no end, until it is revoked. A warning or note restricts nothing and has no end, so it counts for as
 * long as the escalation ladder counts it: 90 days from its `startsAt` (`HISTORY_LOOKBACK_MS`, inclusive). A row without
 * `revokedAt` (a load that does not carry it) reads as not revoked.
 */
export function isSanctionActive(row: SanctionRow, now: number): boolean {
  if (row.revokedAt !== undefined && row.revokedAt !== null) return false;
  if (row.startsAt > now) return false;
  if (isRecordKind(row.kind)) return row.startsAt >= now - HISTORY_LOOKBACK_MS;
  return row.endsAt === null || row.endsAt > now;
}

const isRecordKind = (kind: SanctionKind): boolean => kind === 'warning' || kind === 'note';

/** The rule text a row stores, as a RuleRef; null when there is none or it cannot be read. */
function ruleOf(text: string | null): RuleRef | null {
  if (text === null) return null;
  try {
    return parseRuleRef(text);
  } catch {
    return null;
  }
}

/** The staff view of one subject row. Lists each field by name. */
export function sanctionGroupView(row: SanctionRow, now: number): SanctionGroupView {
  return {
    groupId: row.groupId,
    refCode: row.refCode,
    kind: row.kind,
    rule: ruleOf(row.rule),
    startsAt: row.startsAt,
    endsAt: isRecordKind(row.kind) ? null : row.endsAt,
    reason: row.reason,
    actor: row.actor,
    source: row.source,
    automated: row.automated,
    active: isSanctionActive(row, now),
    pending: row.pending,
    revokedAt: row.revokedAt ?? null,
    revokedBy: row.revokedBy ?? null,
    revokeReason: row.revokeReason ?? null,
  };
}

/**
 * A person's sanctions, newest first: the last 90 days (the escalation window, by `startsAt`) plus every permanent one
 * that has not been revoked, across every alias merged into them. Every group still in force (not revoked, no end or an
 * end in the future, of any age) is always included; the rest of the window fills what is left of
 * {@link PERSON_SANCTIONS_MAX}, newest first.
 */
export function sanctionsOfPerson(store: Store, subjects: SubjectIndex, person: SubjectId, now: number, scope?: readonly string[]): SanctionGroupView[] {
  const aliases = subjects.aliasesOf(person);
  const scoped = scope === undefined ? {} : { scope };
  const inForce = store.listSubjectSanctions({ subjects: aliases, activeAt: now, ...scoped, limit: PERSON_SANCTIONS_MAX });
  const taken = new Set(inForce.map((r) => r.id));
  const window = store.listSubjectSanctions({
    subjects: aliases,
    since: now - HISTORY_LOOKBACK_MS,
    alsoPermanent: true,
    ...scoped,
    limit: PERSON_SANCTIONS_MAX,
  });
  const room = Math.max(0, PERSON_SANCTIONS_MAX - inForce.length);
  const rest = window.filter((r) => !taken.has(r.id)).slice(0, room);
  return [...inForce, ...rest]
    .sort((a, b) => b.startsAt - a.startsAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((r) => sanctionGroupView(r, now));
}

/** What a scoped moderator sees of a person: see {@link scopedHistoryOf}. No account id, signal, link or other room's report. */
export interface ScopedHistory {
  /** The person's actions over the last 90 days that were made from a report in scope. */
  history: ActionRecord[];
  /** The reports filed against the person in scope, newest first. */
  reports: Array<{ id: string; createdAt: number; category: ReportRecord['category'] }>;
  /** The person's sanctions that came from a report in scope (the same window and cap as `cw.sanctions.forPerson`). */
  sanctions: SanctionGroupView[];
  /** The handle on the newest report in scope that recorded one, or null. */
  handle: string | null;
}

/** The person as a moderator limited to `scope` may see them: only reports filed in a room of one of the scopes and the sanctions that came from those reports. */
export function scopedHistoryOf(store: Store, subjects: SubjectIndex, person: SubjectId, scope: readonly string[], now: number, limit = 50): ScopedHistory {
  const aliases = subjects.aliasesOf(person);
  const filed = store.listReportsByPerson(aliases, limit, scope).filter((r) => r.scope !== null && scope.includes(r.scope));
  return {
    history: historyOf(store, subjects, person, now, scope),
    reports: filed.map((r) => ({ id: r.id, createdAt: r.createdAt, category: r.category })),
    sanctions: sanctionsOfPerson(store, subjects, person, now, scope),
    handle: filed.find((r) => r.targetHandle !== '')?.targetHandle ?? null,
  };
}

const clampPage = (limit: unknown): number => {
  if (typeof limit !== 'number' || Number.isNaN(limit)) return SANCTION_PAGE_DEFAULT;
  return Math.min(SANCTION_PAGE_MAX, Math.max(1, Math.floor(limit)));
};

/** The opaque cursor for "older than this row": base64url of `startsAt:id`. */
function encodeSanctionCursor(startsAt: number, id: string): string {
  return b64urlEncode(`${startsAt}:${id}`);
}

function decodeSanctionCursor(cursor: unknown): { startsAt: number; id: string } {
  const text = typeof cursor === 'string' ? b64urlDecode(cursor) : null;
  const at = text === null ? -1 : text.indexOf(':');
  if (text === null || at < 1 || at === text.length - 1) throw new SanctionQueryError('cursor');
  const time = text.slice(0, at);
  const startsAt = Number(time);
  if (!/^\d{1,16}$/.test(time) || !Number.isSafeInteger(startsAt)) throw new SanctionQueryError('cursor');
  return { startsAt, id: text.slice(at + 1) };
}

/**
 * Every person's sanctions, newest first, one page at a time. Not windowed. Throws {@link SanctionQueryError} for an
 * unknown `source` or a cursor that is not one of ours. As with reports, a full page always carries a cursor, so the page
 * after an exactly-full last one is empty with `next` null.
 */
export function listSanctionGroups(store: Store, subjects: SubjectIndex, q: SanctionListInput, now: number): SanctionPage {
  const input: Partial<SanctionListInput> = typeof q === 'object' && q !== null ? q : {};
  if (input.source !== undefined && !(SANCTION_SOURCES as readonly unknown[]).includes(input.source)) {
    throw new SanctionQueryError('source');
  }
  const cursor = input.cursor === undefined || input.cursor === null ? null : decodeSanctionCursor(input.cursor);
  const limit = clampPage(input.limit);
  const scope = input.scope === undefined ? undefined : checkScope(input.scope, 'sanctions.list: scope');
  const rows = store.listSubjectSanctions({
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(scope === undefined ? {} : { scope }),
    ...(cursor === null ? {} : { before: cursor.startsAt, beforeId: cursor.id }),
    limit,
  });
  const last = rows[rows.length - 1];
  return {
    items: rows.map((r) => ({ ...sanctionGroupView(r, now), person: subjects.canonical(r.value) })),
    next: rows.length === limit && last !== undefined ? encodeSanctionCursor(last.startsAt, last.id) : null,
  };
}

/** How many of the newest groups the by-ref fallback reads for a store with no `sanctionGroupByRef`. */
export const BY_REF_FALLBACK_GROUPS = 1000;

/**
 * One group's staff view with its canonical person, found by a normalised ref code (`M-XXXXX`), or null. A store with
 * `sanctionGroupByRef` answers from its index; one without is read through the newest {@link BY_REF_FALLBACK_GROUPS} groups.
 * Built from the group's SUBJECT row only: an IP row is never read.
 */
export function sanctionByRef(store: Store, subjects: SubjectIndex, code: string, now: number): PersonSanctionView | null {
  const view = (r: SanctionRow): PersonSanctionView => ({ ...sanctionGroupView(r, now), person: subjects.canonical(r.value) });
  if (typeof store.sanctionGroupByRef === 'function') {
    const groupId = store.sanctionGroupByRef(code);
    if (groupId === null) return null;
    const row = store.listSubjectSanctions({ groupId, limit: 5 }).find((r) => r.groupId === groupId && r.refCode === code);
    return row === undefined ? null : view(row);
  }
  let before: { startsAt: number; id: string } | null = null;
  let seen = 0;
  while (seen < BY_REF_FALLBACK_GROUPS) {
    const page = store.listSubjectSanctions({
      limit: Math.min(200, BY_REF_FALLBACK_GROUPS - seen),
      ...(before === null ? {} : { before: before.startsAt, beforeId: before.id }),
    });
    const hit = page.find((r) => r.refCode === code);
    if (hit !== undefined) return view(hit);
    const last = page[page.length - 1];
    if (last === undefined || page.length < Math.min(200, BY_REF_FALLBACK_GROUPS - seen)) return null;
    seen += page.length;
    before = { startsAt: last.startsAt, id: last.id };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The reporter's record
// ---------------------------------------------------------------------------

/**
 * How the reports a person FILED stand: `reports` is the total, `open`, `actioned` and `dismissed` its split, `badFaith`
 * how many of the dismissals carry the bad-faith mark (all that are still stored), and `suspendedUntil` the epoch ms their
 * reporting suspension ends, or null when they are not suspended. Suspension is the intake rule: `suspendAfter` bad-faith
 * dismissals inside `suspendWindowMs`. Counts folded over every alias of the person. Staff only.
 *
 * `reasonDecided` counts the decided (actioned or dismissed) reports they filed that named a reason, and `reasonMatched` how many
 * of those the decision bore out: the decision cited, against the reported person, a rule in that reason's `rules`. A dismissal
 * never matches. A reason no longer in the profile's list, or one that maps to no rule (`other` by default), cannot be judged and is
 * left out of both; a switched-off one still counts. Read from the newest 200 decided reports. It is read against the reasons in force now, so editing a reason's rules changes the count. A reporter's reason is a
 * hint, so this is a signal for moderators and nothing more: it is never used to refuse a report.
 */
export interface ReporterRecord {
  reports: number;
  open: number;
  actioned: number;
  dismissed: number;
  badFaith: number;
  suspendedUntil: number | null;
  reasonMatched: number;
  reasonDecided: number;
  /**
   * How their reports filed in the last 30 days turned out (see {@link ReporterAccuracy}): a ranking hint and a line on the case.
   * Null when the store cannot tell (it has no `reporterOutcomes`); otherwise always set, with `falseRate` null below the minimum
   * sample. Staff only: never send to a player.
   */
  accuracy?: ReporterAccuracy | null;
}

export function reporterRecord(
  store: Store,
  subjects: SubjectIndex,
  limits: Limits['reports'],
  person: SubjectId,
  now: number,
  reasons: readonly ReportReason[] = [],
): ReporterRecord {
  const root = subjects.canonical(person);
  const aliases = subjects.aliasesOf(root);
  const tally = store.reporterTally(aliases);
  let reasonDecided = 0;
  let reasonMatched = 0;
  for (const d of store.loadReporterDecisions?.(aliases) ?? []) {
    const reason = findReason(reasons, d.reason);
    // A reason that is gone, or one with no rules (`other`, say), cannot be judged: it is left out of both counts.
    if (reason === undefined || reason.rules.length === 0) continue;
    reasonDecided++;
    const target = subjects.canonical(d.target);
    if (d.actions.some((a) => typeof a.rule === 'number' && subjects.canonical(a.subject) === target && reason.rules.includes(a.rule))) {
      reasonMatched++;
    }
  }
  const marks: number[] = [];
  for (const m of store.loadBadFaithMarks(now - limits.suspendWindowMs)) {
    if (subjects.canonical(m.reporter) === root) marks.push(m.actionedAt);
  }
  return {
    reports: tally.open + tally.actioned + tally.dismissed,
    open: tally.open,
    actioned: tally.actioned,
    dismissed: tally.dismissed,
    badFaith: tally.badFaith,
    suspendedUntil: reporterSuspendedUntil(marks, limits),
    reasonMatched,
    reasonDecided,
    accuracy:
      store.reporterOutcomes === undefined
        ? null
        : (reporterAccuracyFor(store, subjects, [root], now).get(root) ?? summarizeOutcomes({ actioned: 0, noAction: 0, badFaith: 0 })),
  };
}

// ---------------------------------------------------------------------------
// Blocked messages
// ---------------------------------------------------------------------------

/** The most blocked messages one call lists. */
export const BLOCKED_MAX = 500;
/** The most kept blocked names `blocked.names` lists: what the store will return in one read (a store clamps its limit to 200). */
export const BLOCKED_NAMES_MAX = 200;

/** The look-back windows of the blocked list, in days. */
export const BLOCKED_DAYS = [1, 7, 30] as const;
export type BlockedDays = (typeof BLOCKED_DAYS)[number];

/**
 * One blocked chat line: the strike the slur filter recorded. `text` is the line exactly as the person typed it, and
 * `person` the canonical subject (a staff ref). Strikes are purged after 30 days. Carries chat text and a subject id:
 * staff channels only, never send to a player.
 */
export interface BlockedItem {
  id: string;
  at: number;
  roomId: string;
  termId: string;
  person: SubjectId;
  text: string;
}

function sinceOf(days: unknown, now: number): number {
  if (!(BLOCKED_DAYS as readonly unknown[]).includes(days)) throw new RangeError('blocked: days must be 1, 7 or 30');
  return now - (days as number) * DAY_MS;
}

/** The blocked lines of the last `days` days (1, 7 or 30; `RangeError` otherwise), newest first, at most {@link BLOCKED_MAX}. */
export function blockedItems(store: Store, subjects: SubjectIndex, days: unknown, now: number): BlockedItem[] {
  return store.listStrikes(sinceOf(days, now), BLOCKED_MAX).map((s) => ({
    id: s.id,
    at: s.at,
    roomId: s.roomId,
    termId: s.termId,
    person: subjects.canonical(s.subject),
    text: s.rawLine,
  }));
}

/**
 * How many strikes each term earned in the last `days` days (1, 7 or 30; `RangeError` otherwise). Terms with none are
 * absent. The record has no prototype: read it with `counts[id]` or `Object.hasOwn`, never `counts.hasOwnProperty`.
 */
export function blockedCountsByTerm(store: Store, days: unknown, now: number): Record<string, number> {
  // A null-prototype record, so a term id such as `__proto__` is an ordinary key and reads back as one.
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const r of store.countStrikesByTerm(sinceOf(days, now))) out[r.termId] = r.count;
  return out;
}

/** One term flagged for review (0.2.1): a term id (never the term text), how many automatic restrictions it caused were overturned on appeal, and when the last was. */
export interface TermReviewFlag {
  termId: string;
  overturned: number;
  lastAt: number;
}

/**
 * The terms whose restrictions were overturned often enough to review (`cw.terms.reviewFlags`). `days` is an integer 1 to 365 (default 90) and `min` an integer 1 to 1000
 * (default 2), else `RangeError`. From the store's overturn counts (never from strikes, which retention deletes sooner); a store without them gives `[]`. Sorted by
 * `overturned` descending, then `lastAt` descending, then term id.
 */
export function termReviewFlags(store: Store, q: { days?: unknown; min?: unknown } | undefined, now: number): TermReviewFlag[] {
  // Only an absent key (or undefined) asks for the default; `null`, a string and the rest are the caller's value and are checked as one.
  const raw = (key: 'days' | 'min'): unknown => (q !== undefined && q !== null && typeof q === 'object' && Object.hasOwn(q, key) ? q[key] : undefined);
  const d = raw('days') === undefined ? 90 : raw('days');
  const m = raw('min') === undefined ? 2 : raw('min');
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 365) throw new RangeError('terms.reviewFlags: days must be a whole number from 1 to 365');
  if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > 1000) throw new RangeError('terms.reviewFlags: min must be a whole number from 1 to 1000');
  const rows = store.overturnedTermCounts?.(now - d * DAY_MS) ?? [];
  return rows
    .filter((r) => r.overturned >= m)
    .map((r) => ({ termId: r.termId, overturned: r.overturned, lastAt: r.lastAt }))
    .sort((a, b) => b.overturned - a.overturned || b.lastAt - a.lastAt || (a.termId < b.termId ? -1 : a.termId > b.termId ? 1 : 0));
}

/**
 * How many granted appeals overturned a decision that came from each filter key's reports, over the last 7, 30 or 90 days (default 90; another value is a `RangeError`)
 * (`cw.filters.overturned`). An object with no prototype, so a key such as `__proto__` is only a key; a key with none is absent; `{}` for a store without the counts.
 */
export function filterOverturnedCounts(store: Store, q: { days?: unknown } | undefined, now: number): Record<string, number> {
  const asked = q !== undefined && q !== null && typeof q === 'object' && Object.hasOwn(q, 'days') && q.days !== undefined;
  const days: unknown = asked ? (q as { days?: unknown }).days : 90;
  if (days !== 7 && days !== 30 && days !== 90) throw new RangeError('filters.overturned: days must be 7, 30 or 90');
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const r of store.overturnedFilterCounts?.(now - days * DAY_MS) ?? []) if (r.overturned > 0) out[r.filterKey] = r.overturned;
  return out;
}

/**
 * One kept blocked name (`names.keepBlocked`): the name as it was typed, the term the matcher reported (null for a profanity hit), why it was
 * refused, and the person when the caller was found (a staff ref; null for a caller the kit did not hold). Carries a name and a subject id: staff
 * channels only, never send to a player.
 */
export interface BlockedNameItem {
  id: string;
  at: number;
  person: SubjectId | null;
  name: string;
  termId: string | null;
  reason: NameReason;
}

/** The kept blocked names of the last `days` days (1, 7 or 30; `RangeError` otherwise), newest first, at most {@link BLOCKED_NAMES_MAX}. Empty for a store that keeps none. */
export function blockedNameItems(store: Store, subjects: SubjectIndex, days: unknown, now: number): BlockedNameItem[] {
  const since = sinceOf(days, now);
  return (store.listBlockedNames?.(since, BLOCKED_NAMES_MAX) ?? []).map((r) => ({
    id: r.id,
    at: r.at,
    person: r.subject === null ? null : subjects.canonical(r.subject),
    name: r.name,
    termId: r.termId,
    reason: r.reason,
  }));
}
