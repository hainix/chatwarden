import { isValidAuditActor } from './audit.js';
import { DECISION_REASON_MAX } from './decide.js';
import type { DecisionInput, DecisionResult } from './decide.js';
import type { SubjectIndex } from './subjects.js';
import type { CaseClaim } from './team.js';
import type { ReportRecord, Store, SubjectId } from './types.js';

// Bulk dismissal: "nothing wrong here" for every open report about one person (their case) or from one reporter, in one call.
// Each report is closed by the same path as a single decision (`no_action`, no actions, the standard reason), each in its own
// transaction, so every invariant of `decide` holds and each report gets its `report.closed` event. A bulk never uses `bad_faith`:
// that needs written evidence and counts toward a reporting suspension. The staff layer writes the audit trail around this call.

/** The most reports one {@link dismissMany} call closes; the answer says `more: true` past it. @experimental */
export const BULK_DISMISS_MAX = 200;

/**
 * Reports read when a store cannot list a reporter's open reports (no `listOpenReportsByReporter`) and the scan fallback is used.
 * With more open reports than this in the whole store, a reporter's sweep from such a store may find only some of theirs.
 * @experimental
 */
export const BULK_REPORTER_SCAN_MAX = 5_000;

/** What to dismiss: every open report about a person, or every open report from a reporter. A staff ref; aliases are folded. @experimental */
export type DismissScope = { person: SubjectId } | { reporter: SubjectId };

/** @experimental */
export interface DismissManyInput {
  scope: DismissScope;
  /** The audit trail's actor rule (`RangeError` otherwise, as `cases.*`). */
  actor: string;
  /** Optional, at most 500 characters after trimming; absent or blank is `NO_ACTION_DEFAULT_REASON`. */
  reason?: string;
  /** Count only: nothing is written. */
  dryRun?: boolean;
  /** Default false. For the staff layer only, after it has checked who may take a case over. */
  ignoreClaims?: boolean;
  /** Default and maximum {@link BULK_DISMISS_MAX}; a non-integer or a value below 1 is invalid. */
  limit?: number;
}

/**
 * The answer to `dismissMany`. Carries subject ids: staff channels only, never send to a player.
 * @experimental
 */
export type DismissManyResult =
  | {
      ok: true;
      dryRun: boolean;
      /** Open reports in scope this call would close (after claim exclusion), up to `limit`. */
      open: number;
      /** Closed by THIS call. */
      dismissed: number;
      /** Already closed by an identical earlier dismissal. */
      replayed: number;
      /** `claimed`: held by another moderator; `decided`: closed meanwhile by a different decision. */
      skipped: { claimed: number; decided: number };
      /** More open reports in scope than `limit`. */
      more: boolean;
      /** Dismissed plus replayed, for the staff layer's audit rows. */
      reportIds: string[];
      /** The canonical people whose reports this call dismissed, for releasing the actor's claims. */
      targets: SubjectId[];
    }
  | { ok: false; error: 'invalid' };

export interface DismissManyDeps {
  store: Store;
  subjects: SubjectIndex;
  /** The live claims among these people, keyed by canonical person. */
  holders: (people: readonly SubjectId[]) => Map<SubjectId, CaseClaim>;
  /** One decision, announced exactly as `cw.decide` announces it. */
  decide: (input: DecisionInput) => Promise<DecisionResult>;
}

const INVALID: DismissManyResult = Object.freeze({ ok: false, error: 'invalid' }) as DismissManyResult;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Newest first, like `listOpenReportsByPerson`. */
const newestFirst = (a: ReportRecord, b: ReportRecord): number => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The reporter's open reports from a store that cannot list them directly: a bounded keyed scan of every open report. */
function scanForReporter(store: Store, subjects: SubjectIndex, root: SubjectId, want: number): ReportRecord[] {
  const found: ReportRecord[] = [];
  let read = 0;
  let after: number | undefined;
  let afterId: string | undefined;
  while (read < BULK_REPORTER_SCAN_MAX) {
    const asked = Math.min(200, BULK_REPORTER_SCAN_MAX - read);
    const page = store.listOpenReports({
      limit: asked,
      ...(after === undefined ? {} : { after }),
      ...(afterId === undefined ? {} : { afterId }),
    });
    for (const r of page) if (subjects.canonical(r.reporterSubject) === root) found.push(r);
    read += page.length;
    const last = page[page.length - 1];
    if (last === undefined || page.length < asked) break;
    after = last.createdAt;
    afterId = last.id;
  }
  // The scan is oldest first; the by-reporter read is newest first, and so is this.
  return found.sort(newestFirst).slice(0, want);
}

/**
 * Close the open reports in `input.scope`. Validation runs completely before the first read or write: any problem answers
 * `{ ok: false, error: 'invalid' }` (a bad actor is a `RangeError`). Then up to `limit + 1` open reports are read, the first `limit`
 * are the candidates, those whose person another moderator holds are skipped (unless `ignoreClaims`), and each remaining report is
 * decided in turn. A store failure rejects: reports closed before it stay closed, and running the call again finishes the rest.
 */
export async function dismissMany(deps: DismissManyDeps, input: DismissManyInput): Promise<DismissManyResult> {
  const { store, subjects } = deps;
  if (typeof input !== 'object' || input === null) return INVALID;
  if (!isValidAuditActor(input.actor)) throw new RangeError('reports: the actor is not a valid staff ref');
  const actor = input.actor;

  const scope: unknown = input.scope;
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) return INVALID;
  const keys = Object.keys(scope);
  const only = keys.length === 1 ? keys[0] : undefined;
  if (only !== 'person' && only !== 'reporter') return INVALID;
  const ref = (scope as Record<string, unknown>)[only];
  if (!nonEmpty(ref)) return INVALID;

  let reason: string | undefined;
  if (input.reason !== undefined) {
    if (typeof input.reason !== 'string') return INVALID;
    reason = input.reason.trim();
    if (reason.length > DECISION_REASON_MAX) return INVALID;
  }
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') return INVALID;
  if (input.ignoreClaims !== undefined && typeof input.ignoreClaims !== 'boolean') return INVALID;
  let limit = BULK_DISMISS_MAX;
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1) return INVALID;
    limit = Math.min(input.limit, BULK_DISMISS_MAX);
  }
  const dryRun = input.dryRun === true;

  // Read one more than asked for, to know whether there is more.
  const root = subjects.canonical(ref);
  let rows: ReportRecord[];
  if (only === 'person') {
    rows = store.listOpenReportsByPerson(subjects.aliasesOf(root), limit + 1);
  } else if (store.listOpenReportsByReporter !== undefined) {
    rows = store.listOpenReportsByReporter(subjects.aliasesOf(root), limit + 1);
  } else {
    rows = scanForReporter(store, subjects, root, limit + 1);
  }
  const more = rows.length > limit;
  const candidates = rows.slice(0, limit);

  // Another moderator's live claim keeps that case out of the sweep, counted so the caller can say so.
  let claimed = 0;
  let todo = candidates;
  if (input.ignoreClaims !== true && candidates.length > 0) {
    const held = deps.holders([...new Set(candidates.map((r) => subjects.canonical(r.targetSubject)))]);
    todo = candidates.filter((r) => {
      const claim = held.get(subjects.canonical(r.targetSubject));
      if (claim !== undefined && claim.by !== actor) {
        claimed += 1;
        return false;
      }
      return true;
    });
  }

  const result = {
    ok: true as const,
    dryRun,
    open: todo.length,
    dismissed: 0,
    replayed: 0,
    skipped: { claimed, decided: 0 },
    more,
    reportIds: [] as string[],
    targets: [] as SubjectId[],
  };
  if (dryRun) return result;

  const targets = new Set<SubjectId>();
  for (const r of todo) {
    const res = await deps.decide({
      reportId: r.id,
      verdict: 'no_action',
      actions: [],
      actor,
      ...(reason === undefined || reason === '' ? {} : { reason }),
      source: 'moderator',
    });
    if (res.ok) {
      result.reportIds.push(r.id);
      if (res.replay) {
        result.replayed += 1;
      } else {
        result.dismissed += 1;
        targets.add(subjects.canonical(r.targetSubject));
      }
    } else {
      // already_decided / not_found: somebody closed (or purged) it between our read and our write.
      result.skipped.decided += 1;
    }
  }
  result.targets = [...targets];
  return result;
}
