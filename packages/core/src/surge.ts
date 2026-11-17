import type { ResolvedDesk } from './desk.js';
import { isOriginReport } from './types.js';
import type { ReportRecord, SubjectId } from './types.js';

// The report-surge chip (0.2.0, `desk.surge`): "12 reports in 10 minutes from 12 players, 10 of them accounts under 2 days old". A HINT on a case, computed on read from reports the kit already holds.
// It changes no order, no decision input, no event and no refusal; it is never stored, never raised and never a reason to set a report aside: a report from a new account is as valid as any.

/** The most reports and the most distinct reporters one read looks at. */
export const SURGE_MAX_REPORTS = 200;
export const SURGE_MAX_REPORTERS = 100;

/**
 * A surge on a case: how many reports reached the person inside `windowMinutes`, from how many distinct players, and how many of those players' accounts are younger than `newAccountDays`
 * (`null` when the game wired no account-age hook). Counts only. @experimental
 */
export interface ReportSurge {
  reports: number;
  reporters: number;
  windowMinutes: number;
  newAccounts: number | null;
  newAccountDays: number;
}

export interface SurgeDeps {
  /** The reports filed against any of these subjects, newest first, at most `limit`. */
  listReportsByPerson: (subjects: readonly SubjectId[], limit: number) => ReportRecord[];
  /** The person and every subject merged into them. */
  aliasesOf: (subject: SubjectId) => SubjectId[];
  /** The person a stored subject id is now. */
  canonical: (subject: SubjectId) => SubjectId;
  /** A player's account age in days, or null when unknown. Absent: no age is known to anyone (`newAccounts` is null). */
  ageOf?: (subject: SubjectId) => number | null;
}

/**
 * The surge on a person, or `null` when `desk.surge` is off or fewer than `reports` reports (any status, a chat filter's flag excluded: nobody filed it) were filed against them within the
 * last `windowMinutes` (a report exactly that old still counts). Reads at most {@link SURGE_MAX_REPORTS} reports and {@link SURGE_MAX_REPORTERS} reporters; a merged alias counts as one person.
 * @experimental
 */
export function surgeOf(person: SubjectId, now: number, settings: ResolvedDesk['surge'], deps: SurgeDeps): ReportSurge | null {
  if (!settings.enabled) return null;
  const since = now - settings.windowMinutes * 60_000;
  const inWindow = deps
    .listReportsByPerson(deps.aliasesOf(person), SURGE_MAX_REPORTS)
    .filter((r) => !isOriginReport(r) && r.createdAt >= since);
  if (inWindow.length < settings.reports) return null;
  const reporters = new Set<SubjectId>();
  for (const r of inWindow) {
    if (reporters.size >= SURGE_MAX_REPORTERS) break;
    reporters.add(deps.canonical(r.reporterSubject));
  }
  let newAccounts: number | null = null;
  if (deps.ageOf !== undefined) {
    newAccounts = 0;
    for (const reporter of reporters) {
      const age = deps.ageOf(reporter);
      if (age !== null && age < settings.newAccountDays) newAccounts += 1;
    }
  }
  return { reports: inWindow.length, reporters: reporters.size, windowMinutes: settings.windowMinutes, newAccounts, newAccountDays: settings.newAccountDays };
}
