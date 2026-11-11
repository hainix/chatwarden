import { HISTORY_LOOKBACK_MS } from './ladder.js';
import type { Limits } from './limits.js';
import { reporterSuspendedUntil } from './reports.js';
import { findReason } from './reporting.js';
import type { ReportReason } from './reporting.js';
import { parseRuleRef } from './rules.js';
import type { RuleRef } from './rules.js';
import { SANCTION_SOURCES } from './sanctions.js';
import { b64urlDecode, b64urlEncode } from './staffReports.js';
import type { SubjectIndex } from './subjects.js';
import type { SanctionKind, SanctionRow, Source, Store, SubjectId } from './types.js';

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
export function sanctionsOfPerson(store: Store, subjects: SubjectIndex, person: SubjectId, now: number): SanctionGroupView[] {
  const aliases = subjects.aliasesOf(person);
  const inForce = store.listSubjectSanctions({ subjects: aliases, activeAt: now, limit: PERSON_SANCTIONS_MAX });
  const taken = new Set(inForce.map((r) => r.id));
  const window = store.listSubjectSanctions({
    subjects: aliases,
    since: now - HISTORY_LOOKBACK_MS,
    alsoPermanent: true,
    limit: PERSON_SANCTIONS_MAX,
  });
  const room = Math.max(0, PERSON_SANCTIONS_MAX - inForce.length);
  const rest = window.filter((r) => !taken.has(r.id)).slice(0, room);
  return [...inForce, ...rest]
    .sort((a, b) => b.startsAt - a.startsAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((r) => sanctionGroupView(r, now));
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
  const rows = store.listSubjectSanctions({
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(cursor === null ? {} : { before: cursor.startsAt, beforeId: cursor.id }),
    limit,
  });
  const last = rows[rows.length - 1];
  return {
    items: rows.map((r) => ({ ...sanctionGroupView(r, now), person: subjects.canonical(r.value) })),
    next: rows.length === limit && last !== undefined ? encodeSanctionCursor(last.startsAt, last.id) : null,
  };
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
 * never matches. A reason no longer in the profile's list cannot be judged and is left out of both; a switched-off one still
 * counts. It is read against the reasons in force now, so editing a reason's rules changes the count. A reporter's reason is a
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
    if (reason === undefined) continue;
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
  };
}

// ---------------------------------------------------------------------------
// Blocked messages
// ---------------------------------------------------------------------------

/** The most blocked messages one call lists. */
export const BLOCKED_MAX = 500;

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
