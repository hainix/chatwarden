// The gates (design 5, 6.3). Pure: numbers in, verdicts out. No store, no clock but the `now` it is handed, no writer, and no import beyond this folder's
// own types. The model never sees any of it (ruling 5); the service computes the counts from the store and passes them in, so nothing here can be
// fed a number by a client.

const DAY_MS = 86_400_000;
/** The recent window of G5, in days. A constant: the counts the store aggregates are over exactly this. */
const RECENT_DAYS = 30;
/** G6: a rule with fewer sanctions than this has no appeals rate, so the gate passes (one appeal in five is not a rate). */
const APPEALS_MIN_SANCTIONS = 10;
/** G7 and its cooling: an AI-applied sanction in the cell revoked on appeal stops the cell for this long. */
const APPEAL_COOLING_DAYS = 30;
/** G8 and its cooling: a reviewer undoing an action as "not a violation" stops the cell for this long, and two such undos closer than this fail the pair rule. */
const UNDO_COOLING_DAYS = 14;
/** The 95% two-sided normal quantile every bound uses unless a caller says otherwise. */
const Z95 = 1.96;
/** Slack for comparing a count ratio with a configured rate (0.9 must equal 90 of 100 whatever the float says). */
const EPS = 1e-12;

/**
 * The numbers a gate may be moved by, in code (design 5.4). Every one is held inside {@link AI_GATE_BANDS}; the hub cannot move any.
 * @experimental
 */
export interface AiGateConfig {
  /** The window every count is over, in days. */
  windowDays: number;
  /** G1: qualifying decisions made by people. */
  volume: number;
  /** G2: distinct deciding moderators. */
  moderators: number;
  /** G2: days from the first to the last decision. */
  spanDays: number;
  /** G3: the lower 95% (Wilson) bound of clean agree over qualifying. */
  agreementLower: number;
  /** G4: the upper 95% (Wilson) bound of hard overrides over qualifying. */
  overrideUpper: number;
  /** G5: qualifying decisions in the last 30 days. */
  recentCount: number;
  /** G5: the raw clean-agree rate over them. */
  recentRate: number;
  /** G6: the rule-wide revoke rate on appeal must be below this. */
  appealsRate: number;
  /** G8: the keep gate applies once this many of the cell's actions were reviewed. */
  reviewedMin: number;
  /** G8: the upper 95% (Wilson) bound of "undone as not a violation" over the reviewed. */
  keepUpper: number;
}

/**
 * The defaults of design 5.2. Frozen.
 * @experimental
 */
export const AI_GATE_DEFAULTS: Readonly<AiGateConfig> = Object.freeze({
  windowDays: 90,
  volume: 100,
  moderators: 2,
  spanDays: 14,
  agreementLower: 0.9,
  overrideUpper: 0.05,
  recentCount: 5,
  recentRate: 0.9,
  appealsRate: 0.05,
  reviewedMin: 20,
  keepUpper: 0.05,
});

/**
 * The inclusive band each number may be moved inside (design 5.4). Frozen. The ceilings of acting (24 hours, the kinds, the evidence rule, "do not
 * automate", "never a ban", "only people review") are not here: they have no band and are constants checked elsewhere.
 * @experimental
 */
export const AI_GATE_BANDS: Readonly<Record<keyof AiGateConfig, Readonly<{ min: number; max: number }>>> = Object.freeze({
  windowDays: Object.freeze({ min: 30, max: 365 }),
  volume: Object.freeze({ min: 50, max: 1000 }),
  moderators: Object.freeze({ min: 1, max: 10 }),
  spanDays: Object.freeze({ min: 7, max: 90 }),
  agreementLower: Object.freeze({ min: 0.85, max: 0.99 }),
  overrideUpper: Object.freeze({ min: 0.01, max: 0.08 }),
  recentCount: Object.freeze({ min: 3, max: 50 }),
  recentRate: Object.freeze({ min: 0.85, max: 1 }),
  appealsRate: Object.freeze({ min: 0.01, max: 0.1 }),
  reviewedMin: Object.freeze({ min: 10, max: 200 }),
  keepUpper: Object.freeze({ min: 0.01, max: 0.08 }),
});

const WHOLE: ReadonlySet<keyof AiGateConfig> = new Set(['windowDays', 'volume', 'moderators', 'spanDays', 'recentCount', 'reviewedMin']);

/**
 * Check a partial config against the bands and fill it from the defaults. Throws a plain `RangeError` naming the field (never the value) for an
 * unknown field, a value that is not a finite number, a fraction in a whole-number field, or a number outside its band. Reads own properties only;
 * an `undefined` field is the default. The result is frozen and shares nothing with the input.
 * @experimental
 */
export function checkGateConfig(partial?: Partial<AiGateConfig>): AiGateConfig {
  const out: AiGateConfig = { ...AI_GATE_DEFAULTS };
  if (partial === undefined) return Object.freeze(out);
  for (const key of Object.keys(partial)) {
    if (!Object.hasOwn(AI_GATE_BANDS, key)) throw new RangeError(`ai.act.gates.${key} is not a gate setting`);
    const field = key as keyof AiGateConfig;
    const v: unknown = partial[field];
    if (v === undefined) continue;
    const band = AI_GATE_BANDS[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < band.min || v > band.max || (WHOLE.has(field) && !Number.isInteger(v))) {
      throw new RangeError(`ai.act.gates.${field} is outside its band`);
    }
    out[field] = v;
  }
  return Object.freeze(out);
}

function checkCounts(k: number, n: number): void {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || n < 0 || k < 0 || k > n) throw new RangeError('wilson: the count must be a whole number from 0 to n');
}

function wilson(k: number, n: number, z: number): [number, number] {
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const scale = 1 + z2 / n;
  return [(centre - spread) / scale, (centre + spread) / scale];
}

/**
 * The lower bound of the Wilson score interval for `successes` of `n` (z defaults to 1.96, 95%). `n` 0 gives 0. Throws a `RangeError` for a count that
 * is not a whole number from 0 to `n`.
 * @experimental
 */
export function wilsonLower(successes: number, n: number, z: number = Z95): number {
  checkCounts(successes, n);
  if (n === 0) return 0;
  return Math.min(1, Math.max(0, wilson(successes, n, z)[0]));
}

/**
 * The upper bound of the Wilson score interval for `events` of `n` (z defaults to 1.96). `n` 0 gives 1. Throws like {@link wilsonLower}.
 * @experimental
 */
export function wilsonUpper(events: number, n: number, z: number = Z95): number {
  checkCounts(events, n);
  if (n === 0) return 1;
  return Math.min(1, Math.max(0, wilson(events, n, z)[1]));
}

/**
 * What the store aggregates for one cell and window (design 5.1). Every number is a count of decided reports; there is no identifier in it.
 * @experimental
 */
export interface AiCellCounts {
  qualifying: number;
  cleanAgree: number;
  hardOverride: number;
  reduced: number;
  deciders: number;
  firstAt: number | null;
  lastAt: number | null;
  recent: { n: number; cleanAgree: number };
  reviewed: { n: number; confirmed: number; hardUndo: number; lastHardUndoAt: number | null; secondLastHardUndoAt: number | null };
}

/**
 * What `cw.appeals.stats` and the AI-act revoke time give (design 5.2 G6 and G7). Revokes only; reduces are carried apart and never count.
 * @experimental
 */
export interface AiAppealFacts {
  /** False when in-kit appeals are absent or disabled: both appeals checks then fail (`no_appeals`). */
  available: boolean;
  ruleSanctions: number;
  ruleRevokes: number;
  ruleReduces: number;
  /** The newest revoke on appeal of an AI sanction in this cell, or null. */
  actRevokeAt: number | null;
}

/** The names of the eight checks, in the order they are evaluated and shown. @experimental */
export type AiGateName = 'volume' | 'breadth' | 'agreement' | 'override' | 'recency' | 'appeals_rule' | 'appeals_acts' | 'keep';

/**
 * One check of a cell. `need` is a fixed code (`'min:100'`, `'lower>=0.90'`), built from the configured number only, never free text.
 * `value` is what was measured, or null when it does not exist (no recent decisions, no rate yet, the keep gate not applying).
 * @experimental
 */
export interface AiGateCheck {
  name: AiGateName;
  ok: boolean;
  value: number | null;
  need: string;
}

/**
 * What {@link evaluateCell} knows about a cell: every check, whether the cell is open, and the cooling latch. It does not know the cell's rule and
 * level (they are not an input); the service names them in {@link AiCellGate}.
 * @experimental
 */
export interface AiCellVerdict {
  /** Every check, in the order of {@link AiGateName}. Never short-circuits, so the dashboard shows all of them. */
  checks: AiGateCheck[];
  /** True when every check is ok and no cooling latch holds. */
  open: boolean;
  /** When the cooling latch ends (epoch ms), or null when none holds now. */
  coolingUntil: number | null;
  coolingCode: 'not_a_violation' | 'appeal_revoked' | null;
}

/** A cell (a rule number and a conduct level) with its verdict. @experimental */
export interface AiCellGate extends AiCellVerdict {
  rule: number;
  level: 'hostile' | 'severe';
}

const atLeast = (v: number, need: number): boolean => v >= need - EPS;
const atMost = (v: number, need: number): boolean => v <= need + EPS;
const below = (v: number, need: number): boolean => v < need - EPS;
const count = (v: number): number => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const two = (v: number): string => v.toFixed(2);

/**
 * Evaluate one cell against every gate at `now`. Pure: the same input gives the same output, nothing is mutated, and it never throws (a malformed
 * count, such as more clean agrees than qualifying decisions, is clamped and can only make the cell harder to open, never easier).
 * @experimental
 */
export function evaluateCell(counts: AiCellCounts, appeals: AiAppealFacts, cfg: AiGateConfig, now: number): AiCellVerdict {
  const n = count(counts.qualifying);
  // A count above the sample is nonsense: it is clamped to the sample, and a sample that does not add up is not trusted at all.
  const consistent = counts.cleanAgree <= counts.qualifying && counts.hardOverride <= counts.qualifying && counts.cleanAgree + counts.hardOverride <= counts.qualifying && counts.recent.cleanAgree <= counts.recent.n && counts.reviewed.hardUndo <= counts.reviewed.n;
  const clean = Math.min(count(counts.cleanAgree), n);
  const hard = Math.min(count(counts.hardOverride), n);
  const checks: AiGateCheck[] = [];

  // G1 volume.
  checks.push({ name: 'volume', ok: n >= cfg.volume, value: n, need: `min:${cfg.volume}` });

  // G2 breadth: distinct deciders, and the days from the first to the last decision (on the exact millisecond).
  const deciders = count(counts.deciders);
  const span = counts.firstAt !== null && counts.lastAt !== null && counts.lastAt >= counts.firstAt ? counts.lastAt - counts.firstAt : -1;
  checks.push({ name: 'breadth', ok: deciders >= cfg.moderators && span >= cfg.spanDays * DAY_MS, value: deciders, need: `deciders>=${cfg.moderators};span>=${cfg.spanDays}d` });

  // G3 agreement and G4 override: the Wilson bounds, separately.
  const lower = wilsonLower(clean, n);
  checks.push({ name: 'agreement', ok: consistent && n > 0 && atLeast(lower, cfg.agreementLower), value: lower, need: `lower>=${two(cfg.agreementLower)}` });
  const upper = wilsonUpper(hard, n);
  checks.push({ name: 'override', ok: consistent && n > 0 && atMost(upper, cfg.overrideUpper), value: upper, need: `upper<=${two(cfg.overrideUpper)}` });

  // G5 recency: enough decisions in the last 30 days, and the raw rate over them.
  const recentN = count(counts.recent.n);
  const recentClean = Math.min(count(counts.recent.cleanAgree), recentN);
  const recentRate = recentN === 0 ? null : recentClean / recentN;
  checks.push({
    name: 'recency',
    ok: consistent && recentRate !== null && recentN >= cfg.recentCount && atLeast(recentRate, cfg.recentRate),
    value: recentRate,
    need: `recent>=${cfg.recentCount};rate>=${two(cfg.recentRate)}`,
  });

  // G6 appeals, rule-wide: revokes over sanctions given under the rule. Fewer than 10 sanctions is no rate, and passes.
  const sanctions = count(appeals.ruleSanctions);
  const revokes = count(appeals.ruleRevokes);
  const ruleRate = !appeals.available || sanctions < APPEALS_MIN_SANCTIONS ? null : revokes / sanctions;
  checks.push({
    name: 'appeals_rule',
    ok: appeals.available && (ruleRate === null || below(ruleRate, cfg.appealsRate)),
    value: ruleRate,
    need: `rate<${two(cfg.appealsRate)};min:${APPEALS_MIN_SANCTIONS}`,
  });

  // G7 appeals, AI actions: an AI-applied sanction in the cell revoked on appeal within 30 days stops the cell.
  const revokeAt = appeals.available ? appeals.actRevokeAt : null;
  const revokeAge = revokeAt === null ? null : now - revokeAt;
  checks.push({ name: 'appeals_acts', ok: appeals.available && (revokeAge === null || revokeAge >= APPEAL_COOLING_DAYS * DAY_MS), value: revokeAge, need: `none:${APPEAL_COOLING_DAYS}d` });

  // G8 keep: once enough of the cell's actions were reviewed, the upper bound of "undone as not a violation", and no two such undos close together.
  const r = counts.reviewed;
  const reviewedN = count(r.n);
  const undone = Math.min(count(r.hardUndo), reviewedN);
  const applies = reviewedN >= cfg.reviewedMin;
  const keepUpper = applies ? wilsonUpper(undone, reviewedN) : null;
  const pairClose = r.lastHardUndoAt !== null && r.secondLastHardUndoAt !== null && r.lastHardUndoAt - r.secondLastHardUndoAt < UNDO_COOLING_DAYS * DAY_MS;
  checks.push({
    name: 'keep',
    ok: !applies || (consistent && keepUpper !== null && atMost(keepUpper, cfg.keepUpper) && !pairClose),
    value: keepUpper,
    need: `upper<=${two(cfg.keepUpper)};pair>${UNDO_COOLING_DAYS}d`,
  });

  // The cooling latch: the later of the two ends that is still ahead of `now`.
  const undoEnd = r.lastHardUndoAt === null ? null : r.lastHardUndoAt + UNDO_COOLING_DAYS * DAY_MS;
  const appealEnd = revokeAt === null ? null : revokeAt + APPEAL_COOLING_DAYS * DAY_MS;
  const undoLive = undoEnd !== null && undoEnd > now;
  const appealLive = appealEnd !== null && appealEnd > now;
  let coolingUntil: number | null = null;
  let coolingCode: AiCellVerdict['coolingCode'] = null;
  if (appealLive && (!undoLive || (appealEnd as number) >= (undoEnd as number))) {
    coolingUntil = appealEnd;
    coolingCode = 'appeal_revoked';
  } else if (undoLive) {
    coolingUntil = undoEnd;
    coolingCode = 'not_a_violation';
  }

  return { checks, open: coolingUntil === null && checks.every((c) => c.ok), coolingUntil, coolingCode };
}

/**
 * The recent window of G5, in days: the `recent` counts the store aggregates are over exactly this many.
 * @experimental
 */
export const AI_RECENT_DAYS = RECENT_DAYS;
