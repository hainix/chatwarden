import type { RuleRef } from './rules.js';
import { CONDUCT_LEVELS } from './types.js';
import type { ConductLevel, SanctionKind, SanctionRow, Store, SubjectId } from './types.js';
import type { SubjectIndex } from './subjects.js';

/**
 * The escalation ladder: what a person's recent record suggests as the next action. Pure functions over a
 * history; nothing here selects or applies anything, it only names a suggestion.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How far back a prior action counts, measured from its `startsAt`. */
export const HISTORY_LOOKBACK_MS = 90 * DAY_MS;

/** One prior action in a person's history. Derived from a sanction row; carries no identifier. */
export interface ActionRecord {
  kind: SanctionKind;
  /** `endsAt - startsAt`; null when permanent. A warning is recognised by `kind`, not by this. */
  durationMs: number | null;
  startsAt: number;
  revoked: boolean;
  automated: boolean;
}

/** A step on the ladder. 0 is "nothing on record". */
export type LadderStep = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * The canonical person's actions over the last 90 days (`startsAt >= now - HISTORY_LOOKBACK_MS`, inclusive),
 * across every alias that has been merged into them. Revoked rows are included, flagged `revoked`.
 */
export function historyOf(store: Store, subjects: SubjectIndex, subject: SubjectId, now: number): ActionRecord[] {
  const root = subjects.canonical(subject);
  const out: ActionRecord[] = [];
  for (const row of store.loadSubjectActions(now - HISTORY_LOOKBACK_MS)) {
    if (row.targetType !== 'subject' || subjects.canonical(row.value) !== root) continue;
    out.push(toRecord(row));
  }
  return out;
}

function toRecord(row: SanctionRow): ActionRecord {
  return {
    kind: row.kind,
    durationMs: row.endsAt === null ? null : row.endsAt - row.startsAt,
    startsAt: row.startsAt,
    revoked: row.revokedAt !== undefined && row.revokedAt !== null,
    automated: row.automated,
  };
}

/**
 * The step one action reaches. A warning is 1. A chat or area restriction is 2 under 7 days (auto timeouts
 * included) and 3 from 7 days. A ban is 3 under 7 days, 4 from 7 days up to 30, 5 from 30 days. Anything
 * permanent is 5. A revoked record keeps its own step here; `recordStep` is what leaves it out.
 */
export function actionStep(a: ActionRecord): LadderStep {
  if (a.kind === 'warning') return 1;
  if (a.durationMs === null) return 5;
  if (a.kind === 'ban') {
    if (a.durationMs >= 30 * DAY_MS) return 5;
    if (a.durationMs >= 7 * DAY_MS) return 4;
    return 3;
  }
  return a.durationMs >= 7 * DAY_MS ? 3 : 2;
}

/**
 * A record's step: the highest `actionStep` over its non-revoked actions, and at least 2 once it holds two or
 * more non-revoked warnings. 0 for nothing.
 */
export function recordStep(records: readonly ActionRecord[]): LadderStep {
  let step: LadderStep = 0;
  let warnings = 0;
  for (const r of records) {
    if (r.revoked) continue;
    if (r.kind === 'warning') warnings += 1;
    const s = actionStep(r);
    if (s > step) step = s;
  }
  if (warnings >= 2 && step < 2) step = 2;
  return step;
}

/** One suggested action. */
export interface LadderCell {
  kind: SanctionKind;
  durationMs: number | null;
  /** Moderator-facing, e.g. `'Restrict chat 24 hours'`. */
  label: string;
}

/** One row of the ladder table. */
export interface LadderRow {
  step: LadderStep;
  /** Suggested for `banter`, `rude` and `hostile` conduct. */
  lowMedium: LadderCell;
  /** Suggested for `severe` conduct, or whenever the rule is CR 1. */
  high: LadderCell;
}

function cell(kind: SanctionKind, durationMs: number | null, label: string): LadderCell {
  return Object.freeze({ kind, durationMs, label });
}
const WARNING = cell('warning', null, 'Warning');
const CHAT_24H = cell('chat', DAY_MS, 'Restrict chat 24 hours');
const CHAT_7D = cell('chat', 7 * DAY_MS, 'Restrict chat 7 days');
const BAN_7D = cell('ban', 7 * DAY_MS, 'Full ban 7 days');
const BAN_30D = cell('ban', 30 * DAY_MS, 'Full ban 30 days');
const BAN_PERM = cell('ban', null, 'Full ban permanent');

/**
 * The ladder, one row per record step: the feature contract's 12 cells, kept in one constant so the Guide renders
 * the same table the suggestion reads. Rules 5 and 6 swap a chat cell for a ban from public rooms and matchmaking (`area`) at the same length
 * (see `suggestAction`); the table itself holds the unswapped cells.
 */
export const LADDER_TABLE: readonly LadderRow[] = Object.freeze([
  Object.freeze({ step: 0, lowMedium: WARNING, high: CHAT_7D }),
  Object.freeze({ step: 1, lowMedium: CHAT_24H, high: CHAT_7D }),
  Object.freeze({ step: 2, lowMedium: CHAT_7D, high: BAN_7D }),
  Object.freeze({ step: 3, lowMedium: BAN_7D, high: BAN_30D }),
  Object.freeze({ step: 4, lowMedium: BAN_30D, high: BAN_PERM }),
  Object.freeze({ step: 5, lowMedium: BAN_PERM, high: BAN_PERM }),
] as const satisfies readonly LadderRow[]);

function lengthLabel(durationMs: number | null): string {
  if (durationMs === null) return 'permanent';
  if (durationMs % DAY_MS === 0) {
    const d = durationMs / DAY_MS;
    return d === 1 ? '24 hours' : `${d} days`;
  }
  return `${durationMs / HOUR_MS} hours`;
}

/**
 * The next action a record suggests. It never selects anything; the caller shows it as one line.
 *
 * - The column: `'severe'` reads the high column; so does rule 1 (CR 1), whatever the conduct level. A null level
 *   is `hostile`. `'banter'`, `'rude'` and `'hostile'` read the low/medium column.
 * - A level that is not a {@link ConductLevel} (for example a K2 `'high'`) throws `RangeError` rather than quietly
 *   reading the mild column.
 * - Rules 5 and 6 turn a chat suggestion into a ban from public rooms and matchmaking (`area`) at the same length. A warning or a full
 *   ban is left alone.
 *
 * Returns a fresh object each call. Throws `RangeError` for a step outside 0..5 or an unknown conduct level.
 */
export function suggestAction(
  step: LadderStep,
  level: ConductLevel | null,
  rule: RuleRef,
): { kind: SanctionKind; durationMs: number | null; label: string } {
  const row = Number.isInteger(step) ? LADDER_TABLE[step] : undefined;
  if (row === undefined) throw new RangeError('suggestAction: step must be an integer from 0 to 5');
  if (level !== null && !CONDUCT_LEVELS.includes(level)) {
    throw new RangeError('suggestAction: level must be banter, rude, hostile, severe or null');
  }
  const picked = rule === 1 || level === 'severe' ? row.high : row.lowMedium;
  if (picked.kind === 'chat' && (rule === 5 || rule === 6)) {
    return {
      kind: 'area',
      durationMs: picked.durationMs,
      label: `Ban from public rooms ${lengthLabel(picked.durationMs)}`,
    };
  }
  return { kind: picked.kind, durationMs: picked.durationMs, label: picked.label };
}
