import type { DeskSettings, ResolvedDesk } from '@chatwarden/core';
import type { Problem } from '../decision.js';
import type { Problems } from './panels.js';

// The draft of the "The desk" panel: three switches (staff comments and a second look, Insights, the report surge) and the surge's three numbers, as text. The kit's ranges are
// written here so a number can be refused in words before it is sent; the kit checks them again. Pure.

export interface DeskDraft {
  workflow: boolean;
  insights: boolean;
  surge: boolean;
  reports: string;
  minutes: string;
  days: string;
}

/** The kit's ranges (core `desk.ts`). */
const REPORTS = [3, 100] as const;
const MINUTES = [1, 120] as const;
const DAYS = [1, 30] as const;

/** The draft the desk settings in force make. */
export function deskDraftOf(desk: ResolvedDesk | undefined): DeskDraft {
  const d = desk ?? { workflow: false, insights: false, surge: { enabled: false, reports: 5, windowMinutes: 10, newAccountDays: 2 } };
  return { workflow: d.workflow, insights: d.insights, surge: d.surge.enabled, reports: String(d.surge.reports), minutes: String(d.surge.windowMinutes), days: String(d.surge.newAccountDays) };
}

/** A whole number the owner typed in the kit's range, or null (plain digits only: `4.5`, `1e2` and `abc` are not). */
const whole = (s: string, [lo, hi]: readonly [number, number]): number | null => {
  const text = s.trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const n = Number(text);
  return n >= lo && n <= hi ? n : null;
};

const ranged = (key: Problem['key'], [lo, hi]: readonly [number, number]): Problem => ({ key, params: { min: String(lo), max: String(hi) } });

/** What the kit would refuse, by field key. A switched-off surge is not checked: its numbers are only sent when they are valid. */
export function deskProblems(d: DeskDraft): Problems {
  const out: Record<string, Problem> = {};
  if (!d.surge) return out;
  if (whole(d.reports, REPORTS) === null) out['reports'] = ranged('hub.settings.desk.error.reports', REPORTS);
  if (whole(d.minutes, MINUTES) === null) out['minutes'] = ranged('hub.settings.desk.error.minutes', MINUTES);
  if (whole(d.days, DAYS) === null) out['days'] = ranged('hub.settings.desk.error.days', DAYS);
  return out;
}

/** The section a save carries: the two switches and the surge with each number that is valid (an invalid one of a switched-off surge is left to the default). */
export function deskSection(d: DeskDraft): DeskSettings {
  const reports = whole(d.reports, REPORTS);
  const minutes = whole(d.minutes, MINUTES);
  const days = whole(d.days, DAYS);
  return {
    workflow: d.workflow,
    insights: d.insights,
    surge: { enabled: d.surge, ...(reports === null ? {} : { reports }), ...(minutes === null ? {} : { windowMinutes: minutes }), ...(days === null ? {} : { newAccountDays: days }) },
  };
}

/** What the draft means, with a switched-off surge's numbers left out, so two drafts that mean the same compare equal. */
const meaning = (d: DeskDraft): unknown => [d.workflow, d.insights, d.surge ? [d.reports.trim(), d.minutes.trim(), d.days.trim()] : null];

export const deskDirty = (d: DeskDraft, effective: ResolvedDesk | undefined): boolean => JSON.stringify(meaning(d)) !== JSON.stringify(meaning(deskDraftOf(effective)));

/** The field a refusal's layer path names, or null. */
export function deskFieldKey(path: string): string | null {
  switch (path) {
    case 'layer.desk.workflow':
      return 'workflow';
    case 'layer.desk.insights':
      return 'insights';
    case 'layer.desk.surge':
    case 'layer.desk.surge.enabled':
      return 'surge';
    case 'layer.desk.surge.reports':
      return 'reports';
    case 'layer.desk.surge.windowMinutes':
      return 'minutes';
    case 'layer.desk.surge.newAccountDays':
      return 'days';
    default:
      return null;
  }
}

/** The first field with a problem, top to bottom. */
export const firstDeskField = (_d: DeskDraft, problems: Problems): string | null => ['reports', 'minutes', 'days'].find((k) => problems[k] !== undefined) ?? null;
