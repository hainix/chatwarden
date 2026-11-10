import { ownLineIdsByPerson } from './notices.js';
import type { SubjectIndex } from './subjects.js';
import type { ReportRecord, Store, SubjectId } from './types.js';

/** The page size when `limit` is missing or not a number. */
export const REPORT_PAGE_DEFAULT = 50;
/** The largest page; a bigger `limit` is clamped to this. */
export const REPORT_PAGE_MAX = 200;

const STATUSES: ReadonlyArray<ReportRecord['status']> = ['open', 'actioned', 'dismissed'];

/**
 * A report query that cannot be answered: an unknown `status`, a `before` cursor that is not one we issued, or a `person`
 * that is not a subject id (or one combined with a `status` / `before`, which a person query does not take).
 */
export class ReportQueryError extends Error {
  readonly field: 'status' | 'before' | 'person';
  constructor(field: 'status' | 'before' | 'person') {
    super(
      field === 'status'
        ? 'reports.list: unknown status'
        : field === 'person'
          ? 'reports.list: invalid person'
          : 'reports.list: invalid cursor',
    );
    this.name = 'ReportQueryError';
    this.field = field;
  }
}

/**
 * A report as the staff queue shows it: the whole {@link ReportRecord} (status, bad-faith mark, evidence and the
 * actioned fields included) plus the staff refs. A staff ref is the CANONICAL subject id of the person, read at query
 * time, so a report filed before a merge shows the surviving person. The stored `reporterSubject` / `targetSubject`
 * stay as they were filed.
 *
 * - `targetPerson`, `reporterPerson`: the canonical person.
 * - `people`: canonical, the same length and order as the stored list, so `excerpt[].p` still indexes it. After a
 *   merge two entries can name the same person.
 * - `ownLineIds`: for each distinct person in `people`, the ids of the excerpt lines they wrote themselves (the same
 *   rule as `ownLines`, without its five-line cap); an empty array when they wrote none. Offer these to the excerpt
 *   picker; `decide` accepts at most five per action.
 *
 * Carries subject ids: staff channels only, never send to a player.
 */
export interface StaffReport extends ReportRecord {
  targetPerson: SubjectId;
  reporterPerson: SubjectId;
  ownLineIds: Record<SubjectId, string[]>;
}

/** What `reports.list` takes. Every field is optional. */
export interface ReportQuery {
  /** Only reports in this state. Omit for all. */
  status?: ReportRecord['status'];
  /** Page size: default 50, clamped to 1..200 (never rejected). */
  limit?: number;
  /** The `next` of the previous page. Omit or null for the first page. */
  before?: string | null;
  /**
   * Only reports filed AGAINST this person (a staff ref; a merged alias finds the same person). A person query is one
   * page, newest first: `limit` applies, `next` is always null, and it does not combine with `status` or `before`
   * (`ReportQueryError`).
   */
  person?: SubjectId;
}

/**
 * One page of the staff queue, newest first. `next` is an opaque cursor to pass back as `before`, or null when this
 * page was not full (nothing more). A full page always carries a cursor, so the page after an exactly-full last one is
 * empty with `next` null.
 */
export interface ReportPage {
  items: StaffReport[];
  next: string | null;
}

export const b64urlEncode = (text: string): string => {
  let bin = '';
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const b64urlDecode = (cursor: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length % 4 === 1) return null;
  try {
    const bin = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
};

/** The opaque cursor for "older than this report": base64url of `createdAt:id`. */
export function encodeReportCursor(createdAt: number, id: string): string {
  return b64urlEncode(`${createdAt}:${id}`);
}

/** Read a cursor made by {@link encodeReportCursor}; throws {@link ReportQueryError} for anything else. */
export function decodeReportCursor(cursor: string): { createdAt: number; id: string } {
  const text = typeof cursor === 'string' ? b64urlDecode(cursor) : null;
  const at = text === null ? -1 : text.indexOf(':');
  if (text === null || at < 1 || at === text.length - 1) throw new ReportQueryError('before');
  const time = text.slice(0, at);
  const createdAt = Number(time);
  if (!/^\d{1,16}$/.test(time) || !Number.isSafeInteger(createdAt)) throw new ReportQueryError('before');
  return { createdAt, id: text.slice(at + 1) };
}

const clampLimit = (limit: unknown): number => {
  if (typeof limit !== 'number' || Number.isNaN(limit)) return REPORT_PAGE_DEFAULT;
  return Math.min(REPORT_PAGE_MAX, Math.max(1, Math.floor(limit)));
};

/** A stored record as the staff queue shows it (see {@link StaffReport}). Copies; the record is not touched. */
export function staffReport(record: ReportRecord, subjects: SubjectIndex): StaffReport {
  return {
    ...structuredClone(record),
    people: record.people.map((p) => subjects.canonical(p)),
    targetPerson: subjects.canonical(record.targetSubject),
    reporterPerson: subjects.canonical(record.reporterSubject),
    ownLineIds: ownLineIdsByPerson(record, subjects),
  };
}

/** One page of the staff queue. Throws {@link ReportQueryError} for an unknown status or a bad cursor. */
export function listStaffReports(store: Store, subjects: SubjectIndex, q: ReportQuery = {}): ReportPage {
  if (q.person !== undefined) {
    if (typeof q.person !== 'string' || q.person === '') throw new ReportQueryError('person');
    if (q.status !== undefined) throw new ReportQueryError('status');
    if (q.before !== undefined && q.before !== null) throw new ReportQueryError('before');
    const rows = store.listReportsByPerson(subjects.aliasesOf(q.person), clampLimit(q.limit));
    return { items: rows.map((r) => staffReport(r, subjects)), next: null };
  }
  if (q.status !== undefined && !STATUSES.includes(q.status)) throw new ReportQueryError('status');
  const cursor = q.before === undefined || q.before === null ? null : decodeReportCursor(q.before);
  const limit = clampLimit(q.limit);
  const rows = store.listReports({
    ...(q.status === undefined ? {} : { status: q.status }),
    ...(cursor === null ? {} : { before: cursor.createdAt, beforeId: cursor.id }),
    limit,
  });
  const last = rows[rows.length - 1];
  return {
    items: rows.map((r) => staffReport(r, subjects)),
    next: rows.length === limit && last !== undefined ? encodeReportCursor(last.createdAt, last.id) : null,
  };
}
