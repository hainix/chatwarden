import { ProfileError } from './profileError.js';
import type { RuleRef } from './rules.js';
import type { SanctionKind, SubjectId } from './types.js';

// The appeal settings: whether players may appeal a sanction, how many a week, and whether the moderator who made a decision may
// decide its appeal. Pure data and validation, no state and no clock; the service that acts on them comes later. Off until set, so a
// kit that sets nothing behaves exactly as before.

/** The longest statement, in characters. A constant, not a setting: it bounds what is stored. */
export const APPEAL_STATEMENT_MAX = 1000;

/** The allowed whole-number range of `perPlayerPerWeek`, and its default. */
const PER_WEEK_MIN = 1;
const PER_WEEK_MAX = 20;
const PER_WEEK_DEFAULT = 3;

/** The allowed range of `linkTtlMs` (one hour to 365 days) and its default (30 days). */
export const LINK_TTL_MIN_MS = 3_600_000;
export const LINK_TTL_MAX_MS = 31_536_000_000;
const LINK_TTL_DEFAULT_MS = 2_592_000_000;
const CONTACT_MAX = 200;
const WORDS_MAX_LANGUAGES = 16;
const WORDS_MAX_ENTRIES = 80;
const WORD_MAX = 600;
const LANGUAGE_KEY = /^[a-z]{2,3}$/;
const WORD_KEY = /^[a-z][A-Za-z0-9_.]{0,63}$/;
/** True when the text holds a C0 or C1 control character (a newline and a tab included). */
const hasControl = (text: string): boolean => [...text].some((ch) => ch.charCodeAt(0) < 32 || (ch.charCodeAt(0) >= 127 && ch.charCodeAt(0) <= 159));

const KEYS = ['enabled', 'perPlayerPerWeek', 'allowSelfReview', 'linkTtlMs', 'contact', 'emailsOutcome', 'words'] as const;

/** What a moderator may rule on an appeal: the sanction stands, is made lighter, or is lifted. */
export const APPEAL_OUTCOMES = ['uphold', 'reduce', 'revoke'] as const;
export type AppealOutcome = (typeof APPEAL_OUTCOMES)[number];

/**
 * The fixed reasons a moderator gives with a decision (0.2.1): a closed list, so the player is told something true in their own language and the kit can
 * count why appeals are granted. The free-text reason stays private and is never shown. Every outcome offers `context_considered`.
 */
export const APPEAL_REASON_CODES = Object.freeze([
  'rule_applies',
  'evidence_clear',
  'context_considered',
  'first_offence',
  'lighter_fits',
  'mistake',
  'not_a_violation',
] as const);
export type AppealReasonCode = (typeof APPEAL_REASON_CODES)[number];

/** The reason codes each outcome accepts. A code of another outcome is refused as `invalid_reason`. */
export const APPEAL_REASONS: Readonly<Record<AppealOutcome, readonly AppealReasonCode[]>> = Object.freeze({
  uphold: Object.freeze(['rule_applies', 'evidence_clear', 'context_considered'] as const),
  reduce: Object.freeze(['first_offence', 'lighter_fits', 'context_considered'] as const),
  revoke: Object.freeze(['mistake', 'not_a_violation', 'context_considered'] as const),
});

/** What a decision without a code is stored with. */
export const APPEAL_REASON_DEFAULT: AppealReasonCode = 'context_considered';

/**
 * Where an appeal stands. `open` until decided; `upheld`, `reduced` and `revoked` are the three outcomes; `moot` means the sanction was
 * revoked by someone else while the appeal was open, so nobody ruled on it.
 */
export type AppealStatus = 'open' | 'upheld' | 'reduced' | 'revoked' | 'moot';

/**
 * How appeals run. Every field is optional; a profile without `appeals` has them off.
 */
export interface AppealSettings {
  /** Default false. */
  enabled?: boolean;
  /** Appeals one player may file in any rolling 7 days. 1 to 20, default 3. */
  perPlayerPerWeek?: number;
  /** May the moderator who made the original decision decide the appeal? Default false. For a team of one. */
  allowSelfReview?: boolean;
  /** How long a signed appeal link works, in ms: 3,600,000 (one hour) to 31,536,000,000 (365 days). Default 30 days. Never longer than the sanction stays appealable. */
  linkTtlMs?: number;
  /** Where a player can write to a person: one line of 1 to 200 characters (no control, bidirectional or zero-width character). Shown on the appeal page. Null or left out: none. */
  contact?: string | null;
  /** Does the delivery tell the person by email (through the game) when an appeal is decided? Default false: the page and the notice still show the outcome. */
  emailsOutcome?: boolean;
  /**
   * The game's own words for the appeal page and the delivery text, by language: `{ de: { 'player.appealPage.title': '...' } }`. At most 16 languages (two or three
   * lower-case letters), 80 entries each; a key is a word key (`^[a-z][A-Za-z0-9_.]{0,63}$`), a value 1 to 600 characters with no control character. Only the
   * structure is checked here: a key the kit does not use is ignored when the words are read. Default none.
   */
  words?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * What the kit reads: every field filled in.
 */
export interface ResolvedAppeals {
  enabled: boolean;
  perPlayerPerWeek: number;
  allowSelfReview: boolean;
  linkTtlMs: number;
  contact: string | null;
  emailsOutcome: boolean;
  /** The game's own words by language, deep-frozen. */
  words: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The default `words`: nothing, shared and frozen. */
const NO_WORDS: ResolvedAppeals['words'] = Object.freeze({});

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
 */
export function resolveAppeals(input: AppealSettings | undefined, path = 'appeals'): ResolvedAppeals {
  if (input === undefined) {
    return { enabled: false, perPlayerPerWeek: PER_WEEK_DEFAULT, allowSelfReview: false, linkTtlMs: LINK_TTL_DEFAULT_MS, contact: null, emailsOutcome: false, words: NO_WORDS };
  }
  if (!isPlain(input)) throw new ProfileError(path, 'must be an object');
  for (const k of Object.keys(input)) if (!(KEYS as readonly string[]).includes(k)) throw new ProfileError(`${path}.${k}`, 'is not a known setting');
  const enabled = given(input, 'enabled');
  const perWeek = given(input, 'perPlayerPerWeek');
  const self = given(input, 'allowSelfReview');
  const ttl = given(input, 'linkTtlMs');
  const contact = given(input, 'contact');
  const emails = given(input, 'emailsOutcome');
  const words = given(input, 'words');
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new ProfileError(`${path}.enabled`, 'must be true or false');
  if (perWeek !== undefined && (typeof perWeek !== 'number' || !Number.isSafeInteger(perWeek) || perWeek < PER_WEEK_MIN || perWeek > PER_WEEK_MAX)) {
    throw new ProfileError(`${path}.perPlayerPerWeek`, `must be a whole number from ${PER_WEEK_MIN} to ${PER_WEEK_MAX}`);
  }
  if (self !== undefined && typeof self !== 'boolean') throw new ProfileError(`${path}.allowSelfReview`, 'must be true or false');
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < LINK_TTL_MIN_MS || ttl > LINK_TTL_MAX_MS)) {
    throw new ProfileError(`${path}.linkTtlMs`, `must be a whole number of milliseconds from ${LINK_TTL_MIN_MS} (one hour) to ${LINK_TTL_MAX_MS} (365 days)`);
  }
  if (emails !== undefined && typeof emails !== 'boolean') throw new ProfileError(`${path}.emailsOutcome`, 'must be true or false');
  return {
    enabled: enabled ?? false,
    perPlayerPerWeek: (perWeek as number | undefined) ?? PER_WEEK_DEFAULT,
    allowSelfReview: self ?? false,
    linkTtlMs: (ttl as number | undefined) ?? LINK_TTL_DEFAULT_MS,
    contact: resolveContact(contact, `${path}.contact`),
    emailsOutcome: emails ?? false,
    words: resolveWords(words, `${path}.words`),
  };
}

/** One line for the appeal page, trimmed: 1 to 200 characters, nothing the cleaner would strip and no line break. Null and absent are none. */
function resolveContact(v: unknown, path: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ProfileError(path, 'must be a line of text or null');
  const text = v.trim();
  const length = statementLength(text);
  if (length < 1 || length > CONTACT_MAX || hasControl(text) || normalizeStatement(text) !== text) {
    throw new ProfileError(path, `must be one line of 1 to ${CONTACT_MAX} characters with no control, bidirectional or zero-width character`);
  }
  return text;
}

/** The game's own words: structure only. A deep-frozen copy; nothing of the input is kept by reference. Messages never echo a key or a value. */
function resolveWords(v: unknown, path: string): ResolvedAppeals['words'] {
  if (v === undefined) return NO_WORDS;
  const shape = `must be an object of at most ${WORDS_MAX_LANGUAGES} languages, each an object of at most ${WORDS_MAX_ENTRIES} words`;
  if (!isPlain(v)) throw new ProfileError(path, shape);
  const languages = Object.keys(v);
  if (languages.length > WORDS_MAX_LANGUAGES) throw new ProfileError(path, shape);
  const out: Record<string, Readonly<Record<string, string>>> = {};
  for (const language of languages) {
    if (!LANGUAGE_KEY.test(language)) throw new ProfileError(path, 'a language must be two or three lower-case letters');
    const table: unknown = v[language];
    if (!isPlain(table)) throw new ProfileError(path, shape);
    const keys = Object.keys(table);
    if (keys.length > WORDS_MAX_ENTRIES) throw new ProfileError(path, shape);
    const copy: Record<string, string> = {};
    for (const key of keys) {
      const value: unknown = table[key];
      if (!WORD_KEY.test(key)) throw new ProfileError(path, 'a word key must start with a lower-case letter and use letters, digits, dot and underscore (64 at most)');
      if (typeof value !== 'string' || value.length < 1 || value.length > WORD_MAX || hasControl(value)) {
        throw new ProfileError(path, `a word must be text of 1 to ${WORD_MAX} characters with no control character`);
      }
      copy[key] = value;
    }
    out[language] = Object.freeze(copy);
  }
  return Object.freeze(out);
}

/** What a player sees of an appeal. No staff field, no reason, no id of a sanction or a person. */
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
 */
export type AppealRefusal =
  | 'off' // appeals are not enabled
  | 'not_found' // not the caller's notice, or no such notice (the same answer, so ids cannot be probed)
  | 'not_appealable' // the caller's notice, but not a sanction in their record
  | 'statement_invalid' // empty after cleaning, or over APPEAL_STATEMENT_MAX characters
  | 'already_appealed' // this sanction has had its appeal
  | 'rate'; // perPlayerPerWeek reached

export type AppealFileResult = { ok: true; appeal: PlayerAppeal } | { ok: false; refused: AppealRefusal; retryAfterMs?: number }; // retryAfterMs on 'rate'

/** The most UTF-16 units of raw text the cleaner will look at: far past the cap, so a huge paste is refused without being worked through. */
const STATEMENT_RAW_MAX = APPEAL_STATEMENT_MAX * 20;

// Line and paragraph separators and the C1 next-line become a newline; a tab becomes a space.
const NEWLINES = /\r\n|[\r\u0085\u2028\u2029]/g;
// Control characters other than newline (tab is handled before), bidirectional controls and marks, zero-width and invisible format
// characters, the soft hyphen, the Mongolian vowel separator, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the braille blank
// (U+2800), the combining grapheme joiner (U+034F), the variation selectors (U+FE00 to U+FE0E; U+FE0F, the emoji presentation selector, is kept: it is common and harmless) and the interlinear annotation marks
// (U+FFF9 to U+FFFB). Each draws nothing, so a statement made of them would look blank to the staff reader.
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const STRIPPED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2800\u3164\ufe00-\ufe0e\ufeff\uffa0\ufff9-\ufffb]/g;
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
 */
export function normalizeStatement(input: unknown): string {
  if (typeof input !== 'string' || input.length > STATEMENT_RAW_MAX) return '';
  const text = input
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
  // U+FE0F is kept inside a text, but it draws nothing: a statement of nothing else is as blank as any other invisible one.
  return /^[\s️]*$/.test(text) ? '' : text;
}

/** The length of a cleaned statement in characters (code points), the unit {@link APPEAL_STATEMENT_MAX} counts in. */
export function statementLength(text: string): number {
  return [...text].length;
}

/** The four sanction kinds an appeal can concern, lightest first: a reduction must go to a lower kind, or to the same kind and shorter. */
export const SANCTION_KIND_ORDER = ['warning', 'chat', 'area', 'ban'] as const;

/**
 * A moderator's ruling on an appeal.
 */
export interface AppealDecision {
  appealId: string;
  outcome: AppealOutcome;
  /** A staff ref the audit trail accepts. */
  actor: string;
  /** Private, 1 to 500 characters after trimming. Never shown to the player. */
  reason: string;
  /**
   * The fixed reason, one of {@link APPEAL_REASONS} for the outcome. OPTIONAL in 0.2.1 so the release is additive: a decision without one is stored with
   * `context_considered` (the hub always sends one). A code that is not a string, not in the closed list or not offered for this outcome is refused as
   * `invalid_reason` before anything is read from the store. The free-text `reason` stays required and private.
   */
  reasonCode?: AppealReasonCode;
  /** `reduce` only: the lighter outcome that replaces the sanction. A warning has no length (`null`). */
  to?: { kind: 'warning' | 'chat' | 'area' | 'ban'; durationMs: number | null };
}

export type AppealDecideResult =
  | { ok: true; status: 'upheld' | 'reduced' | 'revoked'; replacementGroupId?: string }
  | { ok: false; error: 'not_found' | 'already_decided' | 'invalid' | 'invalid_reason' | 'same_decider' | 'gone' };

/** Below this many sanctions in the window a rule has no rate. */
export const APPEAL_STATS_MIN_SANCTIONS = 10;
/** A rule whose rate is at or above this is `elevated`. */
export const APPEAL_RATE_ELEVATED = 0.15;
/** A rule whose rate is at or above this is `high`. */
export const APPEAL_RATE_HIGH = 0.3;

/**
 * One appeal as staff see it in a list. The statement is NOT here (see {@link AppealDetail}); `statementFlagged` says whether it trips the
 * term filter, so the hub can mask it. Carries a staff ref: staff channels only, never send to a player.
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
 * Why a sanction was made, as the moderator who decides its appeal is shown it (0.2.1). One shape per source, built from the sanction's subject row and the report
 * behind it; never text of a line. `decidedBy` says whether a person or the AI made the report's decision; `strikes` is the strike count that tips an automatic
 * restriction (`limits.strikes.count`) and `termId` the term of the strike that tipped it (null on a restriction written before 0.2.1). `other` is a sanction with no
 * report to show (a co-op feed, the API, a direct sanction) or whose report or rows are gone. Staff only.
 */
export type AppealCause =
  | { source: 'report'; reportId: string; decidedBy: 'human' | 'ai' }
  | { source: 'term'; termId: string | null; strikes: number }
  | { source: 'filter'; reportId: string; filterKey: string; decidedBy: 'human' | 'ai' }
  | { source: 'other'; via: 'coop' | 'api' };

/**
 * One appeal in full, for one staff read (audited by the route).
 */
export interface AppealDetail extends AppealSummary {
  /** Why the sanction was made (see {@link AppealCause}). On the detail only: the list does not carry it. */
  cause: AppealCause;
  /** The player's words. Staff only. Null once purged. Masked by the hub when `statementFlagged`. */
  statement: string | null;
  /**
   * Who decided (or, for a moot appeal, who revoked the sanction), when, and why (private; empty for a moot appeal), once it is no longer open. `reasonCode` is the
   * fixed reason (null for an appeal decided before 0.2.1, for one a store kept no code for, and for a moot one).
   */
  decided: { by: string; at: number; reason: string; reasonCode: AppealReasonCode | null; replacementGroupId: string | null } | null;
  /** The report whose decision made the sanction, when known. */
  reportId: string | null;
  /** What the player was shown with the sanction: their own lines, as the notice kept them (already masked where blocked). */
  shown: Array<{ text: string; day: string }>;
}

/**
 * What the appeal page shows for one signed link (0.2.1): the sanction as the player was shown it, whether an appeal can still be filed, the appeal if there is one, and the
 * sanction as it stands now. An allow-list: no notice id, group id, person, key, account, address, staff ref, private reason or statement. The link is the capability; this is
 * all it opens.
 */
export interface AppealCase {
  /** The notice as the player's own notice shows it (the same words and masking), without its id. */
  notice: {
    kind: 'warning' | 'chat' | 'area' | 'ban';
    rule: RuleRef | null;
    ruleLabel: string | null;
    until: number | null;
    refCode: string | null;
    createdAt: number;
    excerpt: Array<{ text: string; day: string }>;
  };
  /** True while an appeal can be filed from this link: the sanction is live and still standing, and has had no appeal. */
  canAppeal: boolean;
  /** The appeal filed for this sanction, if any. `reason` is the fixed reason code of a decision (null while open, and for a decision that kept none). */
  appeal: { status: 'open' | 'upheld' | 'reduced' | 'revoked'; createdAt: number; decidedAt: number | null; reason: AppealReasonCode | null } | null;
  /** The sanction as it stands after the appeal: the original (upheld), the replacement (reduced), or null (open, revoked). */
  standing: { kind: 'warning' | 'chat' | 'area' | 'ban'; until: number | null } | null;
  /** When the link stops working (epoch ms). */
  expiresAt: number;
  /** Whether the person is also told of the outcome by email (the setting; the game sends it). */
  emailsOutcome: boolean;
  /** The line the game gave for help, or null. */
  contact: string | null;
  /** The longest statement (the same as `APPEAL_STATEMENT_MAX`). */
  statementMax: number;
}

/** The answer to `cw.appeals.caseByLink`: the case, or one answer for every link that does not open (forged, expired, off, gone, withdrawn, moot). */
export type AppealCaseResult = { ok: true; case: AppealCase } | { ok: false; reason: 'invalid' };

export interface AppealPage {
  items: AppealSummary[];
  /** An opaque cursor for the next page, or null when this page was not full. */
  next: string | null;
}

/**
 * The appeal counts of one rule over a window. `granted` is REVOKED appeals only: a reduction is a severity dispute, not a false positive,
 * so it is `lightened`, shown beside the rate and never in it.
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

export interface AppealStats {
  windowDays: number;
  /** By rule number, `'uncovered'` last. */
  perRule: AppealRuleStats[];
  overall: { sanctions: number; appealed: number; granted: number; lightened: number; rate: number | null };
}
