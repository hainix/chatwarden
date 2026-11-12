import type { SubjectIndex } from './subjects.js';
import type { Store, SubjectId } from './types.js';

// Reporter accuracy: how often the reports a person filed turned out to be unfounded, over a window, once there is a big enough
// sample to say. It is a RANKING hint and a line on the case (staff only). It never refuses a report, never counts toward a
// suspension and never reaches a player: the figure is built from decisions, and a player is not told who reported or how often.
// The window is on the FILING time (`created_at`), so the read uses the reporter index and needs no join. Computed from one
// grouped store query (`Store.reporterOutcomes`), so a queue page of 200 reporters is one statement.

/** The window the rate is read over: 30 days of filing time, the same as the reporting suspension window. @experimental */
export const REPORTER_ACCURACY_WINDOW_MS = 30 * 86_400_000;

/** Fewer decided reports than this and there is no rate: nobody is shown a line or ranked down. @experimental */
export const REPORTER_ACCURACY_MIN_DECIDED = 5;

/** From this false-report rate up, the case shows a line about the reporter. @experimental */
export const REPORTER_FALSE_RATE_NOTICEABLE = 0.6;

/** From this false-report rate up, the reporter's reports rank lower (never hidden). @experimental */
export const REPORTER_FALSE_RATE_HABITUAL = 0.8;

/** The most people one {@link reporterAccuracyFor} call reads; more is a `RangeError`. @experimental */
export const REPORTER_ACCURACY_BATCH_MAX = 200;

/**
 * How a reporter's decided reports (filed in the last `windowMs`) turned out. `decided` is `actioned + noAction + badFaith`;
 * `unfounded` is `noAction + badFaith` (a dismissal, with or without the bad-faith mark: the strongest false report counts too).
 * `noted` and `upheld` are both founded: something was found. `falseRate` is `unfounded / decided`, null below
 * {@link REPORTER_ACCURACY_MIN_DECIDED} decided. Open reports are never counted.
 * Staff only: never send to a player.
 * @experimental
 */
export interface ReporterAccuracy {
  decided: number;
  noAction: number;
  badFaith: number;
  unfounded: number;
  falseRate: number | null;
  /** `falseRate >= REPORTER_FALSE_RATE_NOTICEABLE`. */
  noticeable: boolean;
  /** `falseRate >= REPORTER_FALSE_RATE_HABITUAL`. */
  habitual: boolean;
  /** {@link REPORTER_ACCURACY_WINDOW_MS}, so a screen can say "in the last 30 days". */
  windowMs: number;
}

/** The pure part: outcome counts in, the summary out. @experimental */
export function summarizeOutcomes(c: { actioned: number; noAction: number; badFaith: number }): ReporterAccuracy {
  const decided = c.actioned + c.noAction + c.badFaith;
  const unfounded = c.noAction + c.badFaith;
  const falseRate = decided >= REPORTER_ACCURACY_MIN_DECIDED ? unfounded / decided : null;
  return {
    decided,
    noAction: c.noAction,
    badFaith: c.badFaith,
    unfounded,
    falseRate,
    noticeable: falseRate !== null && falseRate >= REPORTER_FALSE_RATE_NOTICEABLE,
    habitual: falseRate !== null && falseRate >= REPORTER_FALSE_RATE_HABITUAL,
    windowMs: REPORTER_ACCURACY_WINDOW_MS,
  };
}

/**
 * The accuracy of each person as a reporter, keyed by canonical person. Each person is made canonical and expanded to every merged
 * alias; ONE `store.reporterOutcomes` call reads them all; the rows are folded by `canonical(row.reporter)`. A person with no decided
 * report in the window is absent from the map. A store without `reporterOutcomes` gives an empty map. More than
 * {@link REPORTER_ACCURACY_BATCH_MAX} people (after removing duplicates) is a `RangeError`.
 */
export function reporterAccuracyFor(
  store: Store,
  subjects: SubjectIndex,
  people: readonly SubjectId[],
  now: number,
): Map<SubjectId, ReporterAccuracy> {
  const roots = [...new Set(people.map((p) => subjects.canonical(p)))];
  if (roots.length > REPORTER_ACCURACY_BATCH_MAX) throw new RangeError(`reporterAccuracy: at most ${REPORTER_ACCURACY_BATCH_MAX} people per call`);
  const out = new Map<SubjectId, ReporterAccuracy>();
  if (roots.length === 0 || store.reporterOutcomes === undefined) return out;
  const all = [...new Set(roots.flatMap((p) => subjects.aliasesOf(p)))];
  const folded = new Map<SubjectId, { actioned: number; noAction: number; badFaith: number }>();
  for (const row of store.reporterOutcomes(all, now - REPORTER_ACCURACY_WINDOW_MS)) {
    const root = subjects.canonical(row.reporter);
    const c = folded.get(root) ?? { actioned: 0, noAction: 0, badFaith: 0 };
    c.actioned += row.actioned;
    c.noAction += row.noAction;
    c.badFaith += row.badFaith;
    folded.set(root, c);
  }
  for (const root of roots) {
    const c = folded.get(root);
    if (c !== undefined && c.actioned + c.noAction + c.badFaith > 0) out.set(root, summarizeOutcomes(c));
  }
  return out;
}
