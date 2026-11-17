import { bool, given, plain, wholeIn } from './settingsCheck.js';

// The desk settings: staff comments and "ask for a look" (workflow), the Insights page (insights) and the report-surge window.
// Pure data and validation. Everything is off until set, so a profile without `desk` changes nothing.

/**
 * What a report surge is: `reports` reports against one person inside `windowMinutes`, from accounts younger than `newAccountDays`.
 * Every field optional on input.
 * @experimental
 */
export interface SurgeSettings {
  /** Name a surge on a case. Default false. */
  enabled?: boolean;
  /** Reports that make a surge, 3 to 100. Default 5. */
  reports?: number;
  /** The window they must fall inside, in minutes, 1 to 120. Default 10. */
  windowMinutes?: number;
  /** A reporter's account must be younger than this many days to count towards the surge, 1 to 30. Default 2. */
  newAccountDays?: number;
}

/**
 * How the moderators' desk behaves. Every field optional.
 * @experimental
 */
export interface DeskSettings {
  /** Staff comments and "ask for a look": off, the routes answer 404 and the hub shows nothing of them. Default false. */
  workflow?: boolean;
  /** The Insights page and the daily line counter that feeds its report rate. Default false. */
  insights?: boolean;
  /** Name a report surge on a case. */
  surge?: SurgeSettings;
}

/**
 * What the kit reads: every field filled in.
 * @experimental
 */
export interface ResolvedDesk {
  workflow: boolean;
  insights: boolean;
  surge: { enabled: boolean; reports: number; windowMinutes: number; newAccountDays: number };
}

const KEYS = ['workflow', 'insights', 'surge'] as const;
const SURGE_KEYS = ['enabled', 'reports', 'windowMinutes', 'newAccountDays'] as const;

/**
 * Validate and fill. Throws ProfileError naming the field (`desk.surge.reports`), never echoing the value. `path` names the settings in
 * the error (default `desk`). The result is a new object that shares nothing with the input; each value is read from `input` once.
 * @experimental
 */
export function resolveDesk(input: DeskSettings | undefined, path = 'desk'): ResolvedDesk {
  const out: ResolvedDesk = { workflow: false, insights: false, surge: { enabled: false, reports: 5, windowMinutes: 10, newAccountDays: 2 } };
  if (input === undefined) return out;
  const o = plain(input, KEYS, path);
  const workflow = given(o, 'workflow');
  if (workflow !== undefined) out.workflow = bool(workflow, `${path}.workflow`);
  const insights = given(o, 'insights');
  if (insights !== undefined) out.insights = bool(insights, `${path}.insights`);
  const surge = given(o, 'surge');
  if (surge !== undefined) {
    const sp = `${path}.surge`;
    const s = plain(surge, SURGE_KEYS, sp);
    const enabled = given(s, 'enabled');
    if (enabled !== undefined) out.surge.enabled = bool(enabled, `${sp}.enabled`);
    const reports = given(s, 'reports');
    if (reports !== undefined) out.surge.reports = wholeIn(reports, 3, 100, `${sp}.reports`);
    const windowMinutes = given(s, 'windowMinutes');
    if (windowMinutes !== undefined) out.surge.windowMinutes = wholeIn(windowMinutes, 1, 120, `${sp}.windowMinutes`);
    const newAccountDays = given(s, 'newAccountDays');
    if (newAccountDays !== undefined) out.surge.newAccountDays = wholeIn(newAccountDays, 1, 30, `${sp}.newAccountDays`);
  }
  return out;
}
