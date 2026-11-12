import { ProfileError } from './profileError.js';
import type { RuleRef } from './rules.js';
import type { SanctionKind, SubjectId } from './types.js';

// The appeal settings: whether players may appeal a sanction, how many a week, and whether the moderator who made a decision may
// decide its appeal. Pure data and validation, no state and no clock; the service that acts on them comes later. Off until set, so a
// kit that sets nothing behaves exactly as before.

/** The longest statement, in characters. A constant, not a setting: it bounds what is stored. @experimental */
export const APPEAL_STATEMENT_MAX = 1000;

/** The allowed whole-number range of `perPlayerPerWeek`, and its default. */
const PER_WEEK_MIN = 1;
const PER_WEEK_MAX = 20;
const PER_WEEK_DEFAULT = 3;

const KEYS = ['enabled', 'perPlayerPerWeek', 'allowSelfReview'] as const;

/** What a moderator may rule on an appeal: the sanction stands, is made lighter, or is lifted. @experimental */
export const APPEAL_OUTCOMES = ['uphold', 'reduce', 'revoke'] as const;
export type AppealOutcome = (typeof APPEAL_OUTCOMES)[number];

/**
 * Where an appeal stands. `open` until decided; `upheld`, `reduced` and `revoked` are the three outcomes; `moot` means the sanction was
 * revoked by someone else while the appeal was open, so nobody ruled on it.
 * @experimental
 */
export type AppealStatus = 'open' | 'upheld' | 'reduced' | 'revoked' | 'moot';

/**
 * How appeals run. Every field is optional; a profile without `appeals` has them off.
 * @experimental
 */
export interface AppealSettings {
  /** Default false. */
  enabled?: boolean;
  /** Appeals one player may file in any rolling 7 days. 1 to 20, default 3. */
  perPlayerPerWeek?: number;
  /** May the moderator who made the original decision decide the appeal? Default false. For a team of one. */
  allowSelfReview?: boolean;
}

/**
 * What the kit reads: every field filled in.
 * @experimental
 */
export interface ResolvedAppeals {
  enabled: boolean;
  perPlayerPerWeek: number;
  allowSelfReview: boolean;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** An own, defined value: a key left out, `undefined` and an inherited property all read as "not given". */
function given(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/**
 * Validate and fill. Throws ProfileError naming the field (`appeals.perPlayerPerWeek`), never echoing the value. `path` names the
 * settings in the error (default `appeals`). The result is a new object that shares nothing with the input; each value is read from
 * `input` once.
 * @experimental
 */
export function resolveAppeals(input: AppealSettings | undefined, path = 'appeals'): ResolvedAppeals {
  if (input === undefined) return { enabled: false, perPlayerPerWeek: PER_WEEK_DEFAULT, allowSelfReview: false };
  if (!isPlain(input)) throw new ProfileError(path, 'must be an object');
  for (const k of Object.keys(input)) if (!(KEYS as readonly string[]).includes(k)) throw new ProfileError(`${path}.${k}`, 'is not a known setting');
  const enabled = given(input, 'enabled');
  const perWeek = given(input, 'perPlayerPerWeek');
  const self = given(input, 'allowSelfReview');
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new ProfileError(`${path}.enabled`, 'must be true or false');
  if (perWeek !== undefined && (typeof perWeek !== 'number' || !Number.isSafeInteger(perWeek) || perWeek < PER_WEEK_MIN || perWeek > PER_WEEK_MAX)) {
    throw new ProfileError(`${path}.perPlayerPerWeek`, `must be a whole number from ${PER_WEEK_MIN} to ${PER_WEEK_MAX}`);
  }
  if (self !== undefined && typeof self !== 'boolean') throw new ProfileError(`${path}.allowSelfReview`, 'must be true or false');
  return {
    enabled: enabled ?? false,
    perPlayerPerWeek: (perWeek as number | undefined) ?? PER_WEEK_DEFAULT,
    allowSelfReview: self ?? false,
  };
}

/** What a player sees of an appeal. No staff field, no reason, no id of a sanction or a person. @experimental */
export interface PlayerAppeal {
  id: string;
  /** The notice it was filed from. */
  noticeId: string;
  status: 'open' | 'upheld' | 'reduced' | 'revoked';
  createdAt: number;
  decidedAt: number | null;
}

/**
 * Why a filing was refused. `not_found` is one answer for "not yours", "no such notice" and "malformed", so notice ids cannot be probed.
 * @experimental
 */
export type AppealRefusal =
  | 'off' // appeals are not enabled
  | 'not_found' // not the caller's notice, or no such notice (the same answer, so ids cannot be probed)
  | 'not_appealable' // the caller's notice, but not a sanction in their record
  | 'statement_invalid' // empty after cleaning, or over APPEAL_STATEMENT_MAX characters
  | 'already_appealed' // this sanction has had its appeal
  | 'rate'; // perPlayerPerWeek reached

/** @experimental */
export type AppealFileResult = { ok: true; appeal: PlayerAppeal } | { ok: false; refused: AppealRefusal; retryAfterMs?: number }; // retryAfterMs on 'rate'

/** The most UTF-16 units of raw text the cleaner will look at: far past the cap, so a huge paste is refused without being worked through. */
const STATEMENT_RAW_MAX = APPEAL_STATEMENT_MAX * 20;

// Line and paragraph separators and the C1 next-line become a newline; a tab becomes a space.
const NEWLINES = /\r\n|[\r\u0085\u2028\u2029]/g;
// Control characters other than newline (tab is handled before), bidirectional controls and marks, zero-width and invisible format
// characters, the soft hyphen, the Mongolian vowel separator, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the braille blank
// (U+2800), the combining grapheme joiner (U+034F), the variation selectors (U+FE00 to U+FE0F) and the interlinear annotation marks
// (U+FFF9 to U+FFFB). Each draws nothing, so a statement made of them would look blank to the staff reader.
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const STRIPPED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]/g;
// Beyond the BMP (so this one needs the `u` flag): the tag characters (U+E0000 to U+E007F), which can carry hidden text, and the
// variation selectors supplement (U+E0100 to U+E01EF).
// eslint-disable-next-line no-misleading-character-class
const STRIPPED_ASTRAL = /[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// A surrogate with no partner: it cannot be stored as UTF-8 (SQLite writes U+FFFD, the memory store keeps it), so both are removed first.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Clean a statement before it is counted or stored: line and paragraph separators become newlines and tabs spaces; control, bidirectional
 * and zero-width characters, the soft hyphen, the Hangul fillers, the braille blank, the grapheme joiner, variation selectors, annotation
 * marks, tag characters, NUL and lone surrogates are removed; every line loses its trailing space; runs of blank lines
 * collapse to one; the whole is trimmed. Pure, idempotent, never throws; anything that is not a string, and a string longer than twenty times
 * the cap, gives an empty string (which the filing refuses). Count the result in code points, not UTF-16 units.
 * @experimental
 */
export function normalizeStatement(input: unknown): string {
  if (typeof input !== 'string' || input.length > STATEMENT_RAW_MAX) return '';
  return input
    .replace(NEWLINES, '\n')
    .replace(/\t/g, ' ')
    .replace(LONE_SURROGATE, '')
    .replace(STRIPPED, '')
    .replace(STRIPPED_ASTRAL, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The length of a cleaned statement in characters (code points), the unit {@link APPEAL_STATEMENT_MAX} counts in. */
export function statementLength(text: string): number {
  return [...text].length;
}

/** The four sanction kinds an appeal can concern, lightest first: a reduction must go to a lower kind, or to the same kind and shorter. */
export const SANCTION_KIND_ORDER = ['warning', 'chat', 'area', 'ban'] as const;

/**
 * A moderator's ruling on an appeal.
 * @experimental
 */
export interface AppealDecision {
  appealId: string;
  outcome: AppealOutcome;
  /** A staff ref the audit trail accepts. */
  actor: string;
  /** Private, 1 to 500 characters after trimming. Never shown to the player. */
  reason: string;
  /** `reduce` only: the lighter outcome that replaces the sanction. A warning has no length (`null`). */
  to?: { kind: 'warning' | 'chat' | 'area' | 'ban'; durationMs: number | null };
}

/** @experimental */
export type AppealDecideResult =
  | { ok: true; status: 'upheld' | 'reduced' | 'revoked'; replacementGroupId?: string }
  | { ok: false; error: 'not_found' | 'already_decided' | 'invalid' | 'same_decider' | 'gone' };

/** Below this many sanctions in the window a rule has no rate. */
export const APPEAL_STATS_MIN_SANCTIONS = 10;
/** A rule whose rate is at or above this is `elevated`. */
export const APPEAL_RATE_ELEVATED = 0.15;
/** A rule whose rate is at or above this is `high`. */
export const APPEAL_RATE_HIGH = 0.3;

/**
 * One appeal as staff see it in a list. The statement is NOT here (see {@link AppealDetail}); `statementFlagged` says whether it trips the
 * term filter, so the hub can mask it. Carries a staff ref: staff channels only, never send to a player.
 * @experimental
 */
export interface AppealSummary {
  id: string;
  createdAt: number;
  status: AppealStatus;
  /** A staff ref. */
  person: SubjectId;
  /** The sanction. `decidedBy` is who made the original decision (the actor on its row); `''` and the appeal's own times when its rows are gone. */
  sanction: { groupId: string; refCode: string; kind: SanctionKind; rule: RuleRef | null; startsAt: number; endsAt: number | null; decidedBy: string; automated: boolean };
  statementFlagged: boolean;
}

/**
 * One appeal in full, for one staff read (audited by the route).
 * @experimental
 */
export interface AppealDetail extends AppealSummary {
  /** The player's words. Staff only. Null once purged. Masked by the hub when `statementFlagged`. */
  statement: string | null;
  /** Who decided (or, for a moot appeal, who revoked the sanction), when, and why (private; empty for a moot appeal), once it is no longer open. */
  decided: { by: string; at: number; reason: string; replacementGroupId: string | null } | null;
  /** The report whose decision made the sanction, when known. */
  reportId: string | null;
  /** What the player was shown with the sanction: their own lines, as the notice kept them (already masked where blocked). */
  shown: Array<{ text: string; day: string }>;
}

/** @experimental */
export interface AppealPage {
  items: AppealSummary[];
  /** An opaque cursor for the next page, or null when this page was not full. */
  next: string | null;
}

/**
 * The appeal counts of one rule over a window. `granted` is REVOKED appeals only: a reduction is a severity dispute, not a false positive,
 * so it is `lightened`, shown beside the rate and never in it.
 * @experimental
 */
export interface AppealRuleStats {
  rule: number | 'uncovered';
  /** Sanctions given under the rule in the window (warning, chat, area, ban; notes are not counted, a reduction counts once). */
  sanctions: number;
  /** Appeals filed in the window (any outcome, a moot one included). */
  appealed: number;
  /** Revoked on appeal. */
  granted: number;
  /** Reduced on appeal. */
  lightened: number;
  /** granted / sanctions, or null below {@link APPEAL_STATS_MIN_SANCTIONS} sanctions. */
  rate: number | null;
  band: 'normal' | 'elevated' | 'high' | null;
}

/** @experimental */
export interface AppealStats {
  windowDays: number;
  /** By rule number, `'uncovered'` last. */
  perRule: AppealRuleStats[];
  overall: { sanctions: number; appealed: number; granted: number; lightened: number; rate: number | null };
}
