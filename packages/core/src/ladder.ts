import type { ModerationProfile, Outcome } from './profile.js';
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
  /**
   * The room (game) the action came from, or null when none was recorded (an automatic timeout, a direct sanction
   * with no room, a row written before rooms were stored). Private to staff; Task 4's "repeated, from distinct games"
   * reads it.
   */
  roomId: string | null;
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
    roomId: row.roomId,
  };
}

/**
 * The step one action reaches. A note is 0: it is on the record but moves
 * nothing. A warning is 1. A chat or area restriction is 2 under 7 days (auto timeouts included) and 3 from 7 days. A ban is 3 under 7 days, 4 from 7 days up to 30, 5 from 30 days. Anything
 * permanent is 5. A revoked record keeps its own step here; `recordStep` is what leaves it out.
 */
export function actionStep(a: ActionRecord): LadderStep {
  if (a.kind === 'note') return 0;
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
 * more non-revoked warnings (notes are not warnings and add nothing). 0 for nothing.
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
  /** Suggested for `banter` and `rude` conduct. */
  lowMedium: LadderCell;
  /**
   * Suggested for `hostile` conduct once the record holds a warning or a restriction (step 1 or more), for `severe`
   * conduct, and whenever the rule is one of the profile's `severeRules` (default CR 1).
   */
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
 * the same table the suggestion reads. A profile's `areaRules` (default 5 and 6) swap a chat cell for a ban from public rooms and matchmaking
 * (`area`) at the same length (see {@link suggest}); the table itself holds the unswapped cells.
 */
export const LADDER_TABLE: readonly LadderRow[] = Object.freeze([
  Object.freeze({ step: 0, lowMedium: WARNING, high: CHAT_7D }),
  Object.freeze({ step: 1, lowMedium: CHAT_24H, high: CHAT_7D }),
  Object.freeze({ step: 2, lowMedium: CHAT_7D, high: BAN_7D }),
  Object.freeze({ step: 3, lowMedium: BAN_7D, high: BAN_30D }),
  Object.freeze({ step: 4, lowMedium: BAN_30D, high: BAN_PERM }),
  Object.freeze({ step: 5, lowMedium: BAN_PERM, high: BAN_PERM }),
] as const satisfies readonly LadderRow[]);

/** The rules that swap a chat restriction for a ban from public rooms, when a profile does not say. */
const DEFAULT_AREA_RULES: readonly number[] = Object.freeze([5, 6]);
/** The rules that always read the severe (high) column, when a profile does not say. */
const DEFAULT_SEVERE_RULES: readonly number[] = Object.freeze([1]);

/** What {@link suggest} knows about the incident in front of the moderator, beyond the record. */
export interface SuggestContext {
  /**
   * The room (game) the incident came from. The repeat rule counts this incident as one more note, and with
   * `distinctGames` it needs to know whether that is a different game from the earlier notes. When it is missing
   * (or null), an earlier note never pairs with this incident, so the rule is judged on the earlier notes alone.
   *
   * When the profile's `repeat.distinctGames` is true, the caller MUST pass the incident's `roomId`, or note
   * escalation never fires: without it this incident cannot count as a different game.
   */
  roomId?: string | null;
}

/** One suggested next action, with the plain reason a moderator can read out. Carries no identifier. */
export interface Suggestion {
  outcome: Outcome;
  /** Moderator-facing, e.g. `'Note'`, `'Warning'`, `'Restrict chat 24 hours'`, `'No action'`. */
  label: string;
  /** One plain sentence naming the profile and the reason. */
  why: string;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** A length in the largest whole unit: `permanent`, `24 hours`, `7 days`, `1 hour`, `30 minutes`. */
export function lengthLabel(durationMs: number | null): string {
  if (durationMs === null) return 'permanent';
  if (durationMs % DAY_MS === 0) {
    const d = durationMs / DAY_MS;
    return d === 1 ? '24 hours' : plural(d, 'day');
  }
  if (durationMs % HOUR_MS === 0) return plural(durationMs / HOUR_MS, 'hour');
  if (durationMs % 60_000 === 0) return plural(durationMs / 60_000, 'minute');
  return plural(Math.ceil(durationMs / 1000), 'second');
}

/** The moderator-facing name of an outcome: `No action`, `Note`, `Warning`, `Restrict chat 24 hours`, `Full ban permanent`. */
export function outcomeLabel(o: Outcome): string {
  if (o === 'none') return 'No action';
  if (o === 'note') return 'Note';
  if (o === 'warning') return 'Warning';
  const len = lengthLabel(o.durationMs);
  if (o.kind === 'chat') return `Restrict chat ${len}`;
  if (o.kind === 'area') return `Ban from public rooms ${len}`;
  return `Full ban ${len}`;
}

function cellOutcome(c: LadderCell): Outcome {
  if (c.kind === 'warning' || c.kind === 'note') return c.kind;
  return { kind: c.kind, durationMs: c.durationMs };
}

const KIND_RANK = { chat: 0, area: 1, ban: 2 } as const;

/** Orders outcomes by how hard they bite: none < note < warning < restrictions by ladder step, then length, then kind. */
function strength(o: Outcome): readonly [number, number, number] {
  if (o === 'none') return [-1, 0, 0];
  if (o === 'note') return [0, 0, 0];
  if (o === 'warning') return [1, 0, 0];
  const step = actionStep({ kind: o.kind, durationMs: o.durationMs, startsAt: 0, revoked: false, automated: false, roomId: null });
  return [step, o.durationMs ?? Number.POSITIVE_INFINITY, KIND_RANK[o.kind]];
}

/** True when `a` bites at least as hard as `b`. */
function atLeast(a: Outcome, b: Outcome): boolean {
  const x = strength(a);
  const y = strength(b);
  for (let i = 0; i < 3; i += 1) {
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    if (xi !== yi) return xi > yi;
  }
  return true;
}

interface Pick {
  outcome: Outcome;
  /** A ladder cell's own label, kept while the outcome is unchanged. */
  label: string | null;
}

/** The stronger of two picks; on a tie the second wins (callers pass the ladder cell second to keep its label). */
function stronger(a: Pick, b: Pick): Pick {
  return atLeast(b.outcome, a.outcome) ? b : a;
}

function plainPick(outcome: Outcome): Pick {
  return { outcome, label: null };
}

function cellPick(cell: LadderCell): Pick {
  return { outcome: cellOutcome(cell), label: cell.label };
}

function copyOutcome(o: Outcome): Outcome {
  return typeof o === 'string' ? o : { kind: o.kind, durationMs: o.durationMs };
}

const LEVEL_NOUN: Record<ConductLevel, string> = {
  banter: 'banter',
  rude: 'aggressive message',
  hostile: 'hostile conduct',
  severe: 'severe conduct',
};

function lowerFirst(s: string): string {
  return `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
}

function verbPhrase(o: Outcome, label: string): string {
  if (o === 'none') return 'is not acted on';
  if (o === 'note') return 'is noted';
  if (o === 'warning') return 'gets a warning';
  return `is met with: ${lowerFirst(label)}`;
}

/**
 * Whether the repeat rule is met, counting this incident as one more note. Revoked notes and notes older than
 * `windowDays` (measured from `startsAt`, inclusive at the boundary) are left out. At least one earlier note is
 * always needed, so a rule of "1 note" means "any earlier note", never this incident alone. With `distinctGames` it
 * counts distinct games: an earlier note with no room is an unknown game and never counts, the earlier notes' rooms
 * are deduplicated, and this incident adds one only when its own room is known and not already among them.
 */
function repeatMet(profile: ModerationProfile, live: readonly ActionRecord[], now: number, roomId: string | null): boolean {
  const since = now - profile.repeat.windowDays * DAY_MS;
  const prior = live.filter((r) => r.kind === 'note' && r.startsAt >= since);
  if (!profile.repeat.distinctGames) return prior.length >= 1 && prior.length + 1 >= profile.repeat.notes;
  const games = new Set<string>();
  for (const r of prior) if (r.roomId !== null && r.roomId !== '') games.add(r.roomId);
  const earlier = games.size;
  if (roomId !== null) games.add(roomId);
  return earlier >= 1 && games.size >= profile.repeat.notes;
}

/**
 * What the moderator should do here, and why, under a profile. It selects and applies nothing; show it as one line.
 *
 * - `banter` is never acted on, whatever the record or the rule.
 * - `severe` (and any non-banter incident under one of the profile's `severeRules`, default CR 1) is acted on at once:
 *   the stronger of `firstOffense.severe` and the ladder's high column for the record's step.
 * - Otherwise, with a clean record (step 0): the first-offense outcome for the level, unless this incident, counted
 *   as one more note, meets the profile's `repeat` rule over the non-revoked notes inside `windowDays`. Then the
 *   outcome is the stronger of `repeat.outcome` and the first-offense outcome (an escalation never goes below the
 *   first offense).
 * - With a warning or restriction on the record (step 1 or more): `rude` reads the ladder's low/medium column for the
 *   step and `hostile` reads the high column, each never below the first-offense outcome for the level. Notes no
 *   longer matter.
 * - A chat restriction becomes a ban from public rooms and matchmaking (`area`) at the same length under the
 *   profile's `areaRules` (default CR 5 and 6). A warning or a full ban is left alone.
 * - A null level reads as `hostile`.
 *
 * Returns a fresh object each call. Throws `RangeError` for a level that is not a {@link ConductLevel} (for example a
 * K2 `'high'`).
 */
export function suggest(
  profile: ModerationProfile,
  records: readonly ActionRecord[],
  level: ConductLevel | null,
  rule: RuleRef,
  now: number,
  context: SuggestContext = {},
): Suggestion {
  if (level !== null && !CONDUCT_LEVELS.includes(level)) {
    throw new RangeError('suggest: level must be banter, rude, hostile, severe or null');
  }
  const read: ConductLevel = level ?? 'hostile';
  const name = profile.name;
  if (read === 'banter') {
    return {
      outcome: 'none',
      label: outcomeLabel('none'),
      why: `${name} profile: banter is not moderated, so no action is suggested.`,
    };
  }

  const severeRules = profile.severeRules ?? DEFAULT_SEVERE_RULES;
  const areaRules = profile.areaRules ?? DEFAULT_AREA_RULES;
  const severe = read === 'severe' || (typeof rule === 'number' && severeRules.includes(rule));
  const effective: ConductLevel = severe ? 'severe' : read;

  const step = recordStep(records);
  const row = profile.ladder[step];
  if (row === undefined) throw new RangeError('suggest: the profile ladder has no row for this record');
  const first = plainPick(profile.firstOffense[effective]);

  let pick: Pick;
  let reason: string;
  if (severe) {
    pick = stronger(first, cellPick(row.high));
    reason = `severe conduct is acted on at once, never below the first-offense outcome or the ladder step for the record: ${lowerFirst(pick.label ?? outcomeLabel(pick.outcome))}`;
  } else if (step >= 1) {
    pick = stronger(first, cellPick(read === 'hostile' ? row.high : row.lowMedium));
    reason = `the record already holds a warning or a restriction, so the ladder's next step applies: ${lowerFirst(pick.label ?? outcomeLabel(pick.outcome))}`;
  } else {
    const live = records.filter((r) => !r.revoked);
    const roomId = context.roomId === undefined || context.roomId === '' ? null : context.roomId;
    if (repeatMet(profile, live, now, roomId)) {
      pick = stronger(first, plainPick(profile.repeat.outcome));
      const games = profile.repeat.distinctGames ? ' from different games' : '';
      reason = `${plural(profile.repeat.notes, 'note')} in ${plural(profile.repeat.windowDays, 'day')}${games} counts as repeated: ${lowerFirst(outcomeLabel(pick.outcome))}`;
    } else {
      pick = first;
      const verb = verbPhrase(pick.outcome, outcomeLabel(pick.outcome));
      reason = live.some((r) => r.kind === 'note')
        ? `the earlier notes do not yet add up to a repeat, so the ${LEVEL_NOUN[effective]} ${verb}`
        : `first ${LEVEL_NOUN[effective]} with a clean record ${verb}`;
    }
  }

  let outcome = copyOutcome(pick.outcome);
  let label = pick.label ?? outcomeLabel(outcome);
  let areaNote = '';
  if (typeof outcome !== 'string' && outcome.kind === 'chat' && typeof rule === 'number' && areaRules.includes(rule)) {
    outcome = { kind: 'area', durationMs: outcome.durationMs };
    label = outcomeLabel(outcome);
    areaNote = ' (this rule bans from public rooms instead of restricting chat)';
  }
  return { outcome, label, why: `${name} profile: ${reason}${areaNote}.` };
}
