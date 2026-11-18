import { parseRuleRef } from './rules.js';
import type { ChatDayRow, InsightRow } from './types.js';

// Insights (0.2.0, `desk.insights`): what the desk's own rows say about how the team is doing. Pure functions over rows the store hands back (`insightRows`, `chatCounts`,
// `countSanctionsByRule`). Counts and times only: the rows carry no person, handle, text or staff member, and nothing here adds one. The page shows the median and the longest
// wait together on purpose, and never a per-person number.

/** A figure of the decision time needs at least this many decided reports in the window; below it the median and the 90th percentile are `null`. */
export const INSIGHTS_MIN_DECIDED = 5;
/** The urgent median needs at least this many decided urgent reports. */
export const INSIGHTS_MIN_URGENT = 3;
/** The most report rows one read takes. A window that hits it is `partial`. */
export const INSIGHTS_ROW_CAP = 20_000;
/** How far back one read takes report rows, whatever the window: an open report older than this is not in the rows (the read says so with `partial`). */
export const INSIGHTS_READ_DAYS = 90;
/** The windows a read may ask for, in days. */
export const INSIGHTS_DAYS = [7, 30, 90] as const;

export type InsightsDays = (typeof INSIGHTS_DAYS)[number];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * One window of Insights. Every number is a count or a time in milliseconds. `from` and `to` are the window ends (epoch ms).
 * `decision` is the team's time from filing to a decision; `medianMs` and `p90Ms` are `null` below {@link INSIGHTS_MIN_DECIDED} decided reports. `wait` is the open reports'
 * age now: the longest, and how many fall in each band. `byReason` is the reason the reporter gave (`none` for no reason), highest first; `byRule` the sanctions written in the window by
 * Community Rule number, `'uncovered'` last. `chat` is the daily line counter for the window, `null` when nothing was counted in it; `reportsPer1000` is reports filed per 1 000 delivered
 * lines, `null` when no line was delivered or counting began inside the window. `partial` is true when the read hit its row cap inside the window, or when an open report is older than the
 * rows it took (older than {@link INSIGHTS_READ_DAYS}, or cut by the cap): the longest wait is still exact, but the open count and the bands leave that report out. `byRule` is `null` when the
 * store cannot count sanctions by rule (the page says "not available", not "none").
 */
export interface InsightsResult {
  days: InsightsDays;
  from: number;
  to: number;
  reports: { filed: number; decided: number; open: number };
  decision: { decided: number; medianMs: number | null; p90Ms: number | null };
  urgent: { filed: number; decided: number; medianMs: number | null };
  wait: { longestOpenMs: number; backlog: InsightsBacklog };
  byReason: Array<{ reason: string; label: string; count: number }>;
  byOutcome: { actioned: number; dismissed: number; badFaith: number };
  byRule: Array<{ rule: number | 'uncovered'; count: number }> | null;
  chat: { delivered: number; refused: number; reportsPer1000: number | null } | null;
  partial: boolean;
}

/** How many open reports have waited under 1 hour, 1 to 4 hours, 4 hours to a day, a day to 3 days, and 3 days or more (an exact edge belongs to the older band). */
export interface InsightsBacklog {
  under1h: number;
  under4h: number;
  under1d: number;
  under3d: number;
  over3d: number;
}

/** `7`, `30` or `90`, else `RangeError` (never echoing the value). */
export function checkInsightsDays(days: unknown): InsightsDays {
  if (days === 7 || days === 30 || days === 90) return days;
  throw new RangeError('insights: days must be 7, 30 or 90');
}

/** The nearest-rank percentile (`q` from 0 to 1) of an ascending list: the value at rank `ceil(q * n)`. `null` for an empty list. */
export function percentileOf(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1] ?? null;
}

/** The five backlog bands of a list of waits (ms). */
export function backlogOf(ages: readonly number[]): InsightsBacklog {
  const out: InsightsBacklog = { under1h: 0, under4h: 0, under1d: 0, under3d: 0, over3d: 0 };
  for (const age of ages) {
    if (age < HOUR_MS) out.under1h += 1;
    else if (age < 4 * HOUR_MS) out.under4h += 1;
    else if (age < DAY_MS) out.under1d += 1;
    else if (age < 3 * DAY_MS) out.under3d += 1;
    else out.over3d += 1;
  }
  return out;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const byTime = (a: number, b: number): number => a - b;

/** A rule as it is stored (`'3'`, `'uncovered'`, or none) as a number or `'uncovered'`; anything else reads as `'uncovered'`. */
function ruleSlot(rule: string | null): number | 'uncovered' {
  if (rule === null) return 'uncovered';
  try {
    return parseRuleRef(rule);
  } catch {
    return 'uncovered';
  }
}

/**
 * Compute one window. `rows` are the reports the store returned (newest first, at most {@link INSIGHTS_ROW_CAP}; older rows than the window are allowed and only feed the open-report
 * wait), `counts` the daily line counts of the window, `sanctionsByRule` the sanctions written in it, `now` the clock and `days` the window (7, 30 or 90). `labelOf` gives a reason id its
 * label (an unknown id is its own label). `sanctionsByRule` is `null` for a store that cannot count them. `extra.oldestOpenAt` is when the oldest open report in the whole store was filed (`null`
 * when none is open, left out when the caller does not know): an open report older than the rows handed in makes the result `partial` and sets the longest wait. Nothing in the result names a person, a handle, text or a staff member: the function copies only what it counts. `RangeError` for any other `days`.
 */
export function computeInsights(
  rows: readonly InsightRow[],
  counts: readonly ChatDayRow[],
  sanctionsByRule: ReadonlyArray<{ rule: string | null; count: number }> | null,
  now: number,
  days: number,
  labelOf?: (reason: string) => string | undefined,
  extra: { oldestOpenAt?: number | null } = {},
): InsightsResult {
  const window = checkInsightsDays(days);
  const from = now - window * DAY_MS;

  const decisionMs: number[] = [];
  const urgentMs: number[] = [];
  const open: number[] = [];
  const reasons = new Map<string, number>();
  const outcome = { actioned: 0, dismissed: 0, badFaith: 0 };
  let filed = 0;
  let decided = 0;
  let urgentFiled = 0;
  let oldest = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    if (r.createdAt < oldest) oldest = r.createdAt;
    // The wait of what is open now covers every open row handed in, however old; everything else is about the window.
    if (r.status === 'open') open.push(Math.max(0, now - r.createdAt));
    if (r.createdAt < from) continue;
    filed += 1;
    if (r.urgent) urgentFiled += 1;
    const reason = r.reportedReason ?? 'none';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    if (r.status === 'open' || r.actionedAt === null) continue;
    decided += 1;
    const took = Math.max(0, r.actionedAt - r.createdAt);
    decisionMs.push(took);
    if (r.urgent) urgentMs.push(took);
    if (r.badFaith) outcome.badFaith += 1;
    else if (r.status === 'actioned') outcome.actioned += 1;
    else outcome.dismissed += 1;
  }
  decisionMs.sort(byTime);
  urgentMs.sort(byTime);

  const enough = decisionMs.length >= INSIGHTS_MIN_DECIDED;
  const byReason = [...reasons.entries()]
    .map(([reason, count]) => ({ reason, label: reason === 'none' ? 'No reason given' : (labelOf?.(reason) ?? reason), count }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

  const rules = new Map<number | 'uncovered', number>();
  for (const s of sanctionsByRule ?? []) {
    const slot = ruleSlot(s.rule);
    rules.set(slot, (rules.get(slot) ?? 0) + s.count);
  }
  const byRule =
    sanctionsByRule === null
      ? null
      : [...rules.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => (a.rule === 'uncovered' ? 1 : b.rule === 'uncovered' ? -1 : a.rule - b.rule));

  // Where the rows reach: the cap cut everything older than the oldest row it returned; below the cap the read took everything back to its fixed lookback. An open report filed before
  // that point is not in `rows`: its age still sets the longest wait, and the result says it is partial.
  const capped = rows.length >= INSIGHTS_ROW_CAP;
  const reachedBack = capped ? oldest : now - INSIGHTS_READ_DAYS * DAY_MS;
  const openOutside = typeof extra.oldestOpenAt === 'number' && extra.oldestOpenAt < reachedBack;
  const longestOpen = Math.max(open.reduce((m, age) => (age > m ? age : m), 0), openOutside ? Math.max(0, now - (extra.oldestOpenAt as number)) : 0);

  // The line counter: only the days of the window. Counting that began inside the window cannot be compared with its reports, so the rate is withheld.
  const firstDay = dayOf(from);
  const lastDay = dayOf(now);
  const inWindow = counts.filter((c) => c.day >= firstDay && c.day <= lastDay);
  let chat: InsightsResult['chat'] = null;
  if (inWindow.length > 0) {
    const delivered = inWindow.reduce((n, c) => n + c.delivered, 0);
    const refused = inWindow.reduce((n, c) => n + c.refused, 0);
    const first = inWindow.reduce((min, c) => (c.day < min ? c.day : min), inWindow[0]!.day);
    const rate = delivered > 0 && first <= firstDay ? Math.round((filed / delivered) * 1000 * 100) / 100 : null;
    chat = { delivered, refused, reportsPer1000: rate };
  }

  return {
    days: window,
    from,
    to: now,
    reports: { filed, decided, open: open.length },
    decision: { decided, medianMs: enough ? percentileOf(decisionMs, 0.5) : null, p90Ms: enough ? percentileOf(decisionMs, 0.9) : null },
    urgent: { filed: urgentFiled, decided: urgentMs.length, medianMs: urgentMs.length >= INSIGHTS_MIN_URGENT ? percentileOf(urgentMs, 0.5) : null },
    wait: { longestOpenMs: longestOpen, backlog: backlogOf(open) },
    byReason,
    byOutcome: outcome,
    byRule,
    chat,
    // The cap cut the window only when the oldest row it returned is still inside it; and an open report outside the rows leaves the open count and the bands short.
    partial: (capped && oldest >= from) || openOutside,
  };
}
