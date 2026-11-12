import { setRanker } from '../queue.js';
import type { QueueGroup, RankSignals } from '../queue.js';
import type { AiBrief } from '../types.js';

// The AI's part of the queue: the weights, the score and the sort by priority (design section 9), and what the queue chip shows. It loads with the
// rest of the AI's code, when the hub learns the AI is on (a queue holding a read), so a hub with the AI off carries none of it. Loading it is what
// teaches `groupQueue` the `priority` sort (`setRanker` below); it never filters anything.

const freeze = <T extends object>(o: T): Readonly<T> => Object.freeze(o);

/**
 * What the `priority` sort adds up: the wait (0 to 2, whatever the AI said), the open reports beyond the first (0 to 0.5), the AI's read (severity x
 * confidence, 0.7 when stale, 1.2 when unread or flagged) and the reporter signal (clamped to plus or minus 0.5).
 * @experimental
 */
export const RANK_WEIGHTS = freeze({
  severity: freeze({ banter: 0, rude: 1, hostile: 2.5, severe: 5 }),
  confidence: freeze({ low: 0.4, medium: 0.7, high: 1 }),
  /** An unread case, and the floor of a read that a line tried to instruct. */
  neutral: 1.2,
  stale: 0.7,
  waitMax: 2,
  waitHours: 24,
  volumeMax: 0.5,
  volumeExtra: 4,
  reporterClamp: 0.5,
  /** The most the signal-feed conduct term adds or takes (the same clamp as the reporter's). */
  conductClamp: 0.5,
});

/** What a person who meets the queue signal feed (`boosted`) adds to the `priority` score: half a point, the clamp of its seam. @experimental */
export const SIGNAL_BOOST = 0.5;

const known = (table: Readonly<Record<string, number>>, key: string): number | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** One read's weight: severity x confidence (x 0.7 when stale); a flagged read is raised to the neutral weight, never below it. An unknown word counts as neutral. */
function readWeight(b: AiBrief): number {
  const w = RANK_WEIGHTS;
  const sev = known(w.severity, b.severity);
  const conf = known(w.confidence, b.confidence);
  if (sev === undefined || conf === undefined) return w.neutral;
  const weight = sev * conf * (b.stale ? w.stale : 1);
  return b.injectionSuspected ? Math.max(weight, w.neutral) : weight;
}

/** What the queue knows of the AI about a person: the worst read among their open reports, how many have none, and their reporters' mean false-report rate. */
export function readsOf(g: Pick<QueueGroup, 'summaries'>): { ai: AiBrief | null; unread: number; rate: number | null } {
  let ai: AiBrief | null = null;
  let best = -1;
  let unread = 0;
  let rates = 0;
  let sum = 0;
  for (const r of g.summaries ?? []) {
    if (r.status !== 'open') continue;
    const rate = r.reporterAccuracy?.falseRate;
    if (typeof rate === 'number') {
      rates += 1;
      sum += rate;
    }
    if (r.ai == null) unread += 1;
    else if (readWeight(r.ai) > best) {
      best = readWeight(r.ai);
      ai = r.ai;
    }
  }
  return { ai, unread, rate: rates === 0 ? null : sum / rates };
}

/**
 * The hub's reporter signal for the `priority` sort: a reporter whose reports hold up more often than not raises a case, one whose reports mostly
 * do not lowers it (0.5 minus the false-report rate, clamped by the sort to plus or minus half a point). Zero when the server tells nothing.
 * @experimental
 */
export const reporterSignal = (g: QueueGroup): number => {
  const { rate } = readsOf(g);
  return rate === null ? 0 : 0.5 - rate;
};

/**
 * The hub's conduct signal for the `priority` sort: {@link SIGNAL_BOOST} for a person the server marked `boosted` (they meet the queue signal feed),
 * else 0. Staff set the feed in Settings, Advanced, Signals; nothing is shown for it.
 * @experimental
 */
export const conductSignal = (g: QueueGroup): number => (g.boosted === true ? SIGNAL_BOOST : 0);

/** One seam's answer: finite numbers only, clamped to plus or minus `clamp`; anything else (or a throw) adds nothing. */
function said(fn: ((g: QueueGroup) => number) | undefined, g: QueueGroup, clamp: number): number {
  try {
    const got: unknown = fn?.(g);
    return typeof got === 'number' && Number.isFinite(got) ? Math.max(-clamp, Math.min(clamp, got)) : 0;
  } catch {
    return 0;
  }
}

/**
 * The `priority` score of a case at `now`: wait + volume + ai + reporter. A weight, not a filter: nothing is hidden, and after 24 hours any case
 * outranks a fresh unread one. The seam for the triage-speed plan's reporter signal.
 * @experimental
 */
export function priorityScore(g: QueueGroup, now: number, signals: RankSignals = {}): number {
  const w = RANK_WEIGHTS;
  const { ai: brief, unread } = readsOf(g);
  const waited = Math.max(0, now - (g.oldestOpenAt ?? g.firstAt)) / 3_600_000;
  const wait = (w.waitMax * Math.min(waited, w.waitHours)) / w.waitHours;
  const volume = g.open > 1 ? (w.volumeMax * Math.min(g.open - 1, w.volumeExtra)) / w.volumeExtra : 0;
  const read = brief === null ? w.neutral : readWeight(brief);
  const ai = brief !== null && unread === 0 ? read : Math.max(read, w.neutral);
  return wait + volume + ai + said(signals.reporter, g, w.reporterClamp) + said(signals.conduct, g, w.conductClamp);
}

/** The sort `groupQueue` uses for `priority` once this is loaded: the AI fields are set on each group, then the highest score first (ties by person ref). */
function rankGroups(groups: QueueGroup[], options: { signals?: RankSignals; now?: number }): void {
  const at = options.now ?? groups.reduce((m, g) => Math.max(m, g.latestAt), 0);
  for (const g of groups) {
    const { ai, unread, rate } = readsOf(g);
    g.ai = ai;
    g.aiUnread = unread;
    g.reporterFalseRate = rate;
  }
  const signals = options.signals ?? { reporter: reporterSignal, conduct: conductSignal };
  const scores = new Map(groups.map((g) => [g, priorityScore(g, at, signals)]));
  groups.sort((a, b) => (scores.get(b) as number) - (scores.get(a) as number) || (a.person < b.person ? -1 : a.person > b.person ? 1 : 0));
}

/**
 * Teaches `groupQueue` the `priority` sort. The loaders in `queue.ts` call this themselves, so the order never depends on this module's
 * evaluation (a bundler that trusts `sideEffects` may leave that out).
 */
export function installRanker(): void {
  setRanker(rankGroups);
}

// Also on evaluation, so code that imports this module directly gets the sort as before.
installRanker();
