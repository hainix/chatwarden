import { HISTORY_LOOKBACK_MS, LADDER_TABLE, outcomeLabel } from './ladder.js';
import { MAX_SANCTION_DURATION_MS } from './sanctions.js';
import type { LadderRow, LadderStep } from './ladder.js';
import { CONDUCT_LEVELS } from './types.js';
import type { ConductLevel } from './types.js';
import {
  MAX_REASON_RULES,
  MAX_REPORT_REASONS,
  OTHER_REASON_ID,
  REPORT_FLOWS,
  REPORT_GROUP_MAX,
  REPORT_HINT_MAX,
  REPORT_ID_MAX,
  REPORT_LABEL_MAX,
  REPORT_THANKS_MAX,
  fillReporting,
  isReasonId,
  resolveReporting,
} from './reporting.js';
import type { ReportingSettings, ResolvedReporting } from './reporting.js';
import { deepFreeze } from './freeze.js';
import { mergePace, resolvePace } from './pace.js';
import type { PaceSettings, ResolvedPace } from './pace.js';
import { checkSignalFeeds, resolveSignals } from './signals.js';
import type { ResolvedSignals, SignalFeeds, SignalSettings } from './signals.js';
import { ProfileError } from './profileError.js';

/**
 * A moderation profile is a game's written standard: what each conduct level means, what happens on a first
 * offense, what counts as "repeated", how the ladder escalates, what to do about profanity and how the AI read is
 * instructed. The kit ships three presets; an adopter picks one ({@link resolveProfile} with a name), tweaks one
 * ({@link resolveProfile} with overrides) or writes a complete custom profile ({@link defineProfile}). Every path
 * ends in the same validation, so a profile that exists is a profile the kit can enforce.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** What happens on a first offense. Durations are milliseconds; `null` is permanent. */
export type Outcome =
  | 'none'
  | 'note'
  | 'warning'
  | { kind: 'chat' | 'area' | 'ban'; durationMs: number | null };

/** The built-in word lists to use, and how ordinary swearing is handled. Slurs are separate and always refused. */
export interface ProfanityConfig {
  /** `allow` leaves swearing alone, `star` masks it, `refuse` rejects the line. */
  mode: 'allow' | 'star' | 'refuse';
  /** How starring looks: `'****'`, `'f***'` or `'#$%!'`. */
  style: 'full' | 'keepFirst' | 'grawlix';
  /** Extra words treated as profanity. */
  add: string[];
  /** Words from the built-in list that are allowed here. */
  remove: string[];
  /** If set, ONLY these words count (a fully custom list); `add` and `remove` still apply. */
  only: string[] | null;
  /** Built-in lists to use. */
  languages: string[];
}

/** What a conduct level means in this game, in plain words, with examples. */
export interface LevelDescription {
  meaning: string;
  examples: string[];
}

/** What a guideline tier may cover: a conduct level, or one of the two record-based situations. */
export type GuidelineCover = ConductLevel | 'repeated' | 'after_warning';

/** One tier of the team's own guidelines, in the team's own words. */
export interface GuidelineTier {
  title: string;
  description: string;
  examples: string[];
  /** The conduct levels (and optionally `repeated` and `after_warning`) this tier is about. */
  covers: GuidelineCover[];
  /** Free text. */
  outcome: string;
}

/** The starter Community Rules flavour that goes with the profile. */
export type RulesFlavour = 'relaxed' | 'standard' | 'strict';

/** Everything a moderation profile held in 0.1.1. The two fields added later are on {@link ModerationProfile} and {@link ResolvedProfile}. */
export interface ModerationProfileBase {
  /** `'relaxed'`, `'standard'`, `'strict'` or your own. */
  id: string;
  /** Shown in the Guide and on the public page. */
  name: string;
  /** One line players see: what is fine here, what is not. */
  summary: string;
  /** The first time, with a clean record. `banter` is always `'none'`. */
  firstOffense: Record<ConductLevel, Outcome>;
  /**
   * When notes add up to "repeated": `notes` notes in `windowDays` days (from distinct games if asked), and what
   * then happens. `outcome` must escalate: `'none'` and `'note'` are rejected.
   */
  repeat: { windowDays: number; notes: number; distinctGames: boolean; outcome: Outcome };
  /** Escalation after the first offense. Six rows, steps 0 to 5. */
  ladder: readonly LadderRow[];
  /** Ordinary swearing in chat. */
  profanity: ProfanityConfig;
  /** The plain-language standard given to the AI read with the Community Rules. */
  aiContext: string;
  /** Levels the AI may act on by itself. Only `hostile` and `severe` are allowed. */
  aiAutoAct: ConductLevel[];
  /** The starter Community Rules flavour. */
  rules: RulesFlavour;
  /**
   * Rule numbers where a chat restriction becomes a ban from public rooms and matchmaking (`area`) at the same
   * length. Optional; when missing, `[5, 6]`. Whole numbers from 1; duplicates are removed; `[]` turns the swap off.
   */
  areaRules?: number[];
  /**
   * Rule numbers that always read the severe (high) ladder column, whatever the conduct level. Optional; when
   * missing, `[1]`. Whole numbers from 1; duplicates are removed; `[]` turns it off.
   */
  severeRules?: number[];
  /** What each conduct level means here, with examples. */
  levels: Record<ConductLevel, LevelDescription>;
  /**
   * The team's own guidelines, ordered. Each tier's `outcome` is free text the moderator guide and the AI brief repeat
   * as written; the kit never derives it. If you override an outcome (`firstOffense`), the `repeat` rule or the
   * `ladder`, override `guidelines` to match, or the guide and brief will describe the preset's outcomes instead of
   * yours. Only the player code of conduct derives its outcomes from those fields automatically.
   */
  guidelines: GuidelineTier[];
}

/**
 * A moderation profile as you write it. A profile from 0.1.1 (without `durations` and `customDuration`) is still one: the two
 * fields are optional here and are filled with their defaults wherever the kit reads a profile. What the kit hands back is a
 * {@link ResolvedProfile}, which has both.
 */
export interface ModerationProfile extends ModerationProfileBase {
  /**
   * The lengths a moderator is offered, in milliseconds: sorted from the shortest, no repeats, each from 1 up to 365
   * days (at most {@link MAX_DURATIONS} of them). Permanent is always offered, subject to permission, and is never listed.
   * Default {@link DEFAULT_DURATIONS}: 1 hour, 6 hours, 12 hours, 24 hours, 3 days, 7 days and 30 days. Only the offered
   * list: a decision or a sanction may still name any valid length when `customDuration` is true, and the ladder's own
   * lengths are always allowed.
   */
  durations?: number[];
  /** May a moderator type a length of their own? Default true. When false, only `durations`, permanent and the profile's own lengths are accepted. */
  customDuration?: boolean;
  /**
   * How players report and what they are told: the flow (default one tap, reason optional), the ordered reasons (default
   * grouped and game-style, each mapped to its starter Community Rules) and the thank-you copy. Every field is optional. See
   * {@link ReportingSettings}.
   */
  reporting?: ReportingSettings;
  /**
   * The AI read, in the moderator's hands: `level` 0 is off (the default), 1 reads each report and shows a summary, 2 also
   * recommends; `learn` (default true) lets decided cases teach the read. A level 3 or 4 is refused ("not available yet"). The
   * hub edits this section; the code-side AI option sets the adapter and the highest level it may reach. See {@link AISettings}.
   */
  ai?: Partial<AISettings>;
  /**
   * How a room paces a player's lines: a least gap between them (`slowModeMs`), a burst limit (`burst`) and no repeats
   * (`duplicateWindowMs`). Every setting is off until set, so a profile without `pace` changes nothing. See {@link PaceSettings}.
   * @experimental
   */
  pace?: PaceSettings;
  /**
   * Signals: what the game records about a player (muted by others, kicked, left mid-game). `kinds` and `guards` are declared in code
   * only; `feeds` says where counts may be read (the Person page record, the ladder suggestion, the AI read's context, the queue
   * boost) and is editable in the hub. Nothing is unset-only: a profile without `signals` declares no kinds and has no feeds. A signal
   * never acts. See {@link SignalSettings}.
   * @experimental
   */
  signals?: SignalSettings;
}

/**
 * The AI levels and the casebook switch, as the profile holds them. The level in force is also bounded by the adapter and the
 * maximum level given in code, and is 0 when no adapter is configured.
 * @experimental
 */
export interface AISettings {
  /** 0 off, 1 read, 2 recommend. 3 and 4 are not available yet. */
  level: 0 | 1 | 2;
  /** Whether decided cases may be kept as pseudonymised examples for later reads. Default true. */
  learn: boolean;
  /**
   * The most provider calls the AI may make in a UTC day, a second guard beside the spend cap in code (an adapter that reports no cost
   * cannot run unbounded). A whole number from 1 to 100 000; default 5 000.
   */
  dailyCalls: number;
}

/** The default and the largest value of {@link AISettings.dailyCalls}. */
export const AI_DAILY_CALLS_DEFAULT = 5000;
export const AI_DAILY_CALLS_MAX = 100_000;

/**
 * What `defineProfile`, `resolveProfile`, `applyPolicyLayer`, `cw.profile` and `cw.policy.get()` return: a validated, deep-frozen
 * profile with `durations` and `customDuration` filled in. It is a {@link ModerationProfile}, so it can be passed wherever one is
 * taken.
 */
export interface ResolvedProfile extends ModerationProfileBase {
  /**
   * The lengths a moderator is offered, in milliseconds: sorted from the shortest, no repeats, each from 1 up to 365
   * days (at most {@link MAX_DURATIONS} of them). Permanent is always offered, subject to permission, and is never listed.
   * Default {@link DEFAULT_DURATIONS}: 1 hour, 6 hours, 12 hours, 24 hours, 3 days, 7 days and 30 days. Only the offered
   * list: a decision or a sanction may still name any valid length when `customDuration` is true, and the ladder's own
   * lengths are always allowed.
   */
  durations: number[];
  /** May a moderator type a length of their own? When false, only `durations`, permanent and the profile's own lengths are accepted. */
  customDuration: boolean;
  /** The reporting settings in force, every field filled in. */
  reporting: ResolvedReporting;
  /** The AI settings in force, every field filled in. */
  ai: AISettings;
  /** The pace settings in force, every field filled in (`null` is off). @experimental */
  pace: ResolvedPace;
  /** The signal settings in force: the declared kinds merged over the built-ins, the guards filled in, the feeds as given. @experimental */
  signals: ResolvedSignals;
}

/** @deprecated The same as {@link ModerationProfile}, which now has the two fields optional. */
export type ProfileInput = ModerationProfile;

/** Like `Partial`, all the way down. Arrays are replaced, not merged; `null` is a value. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Overrides for {@link resolveProfile}. Any field; arrays replace the preset's array whole. */
export type ProfileOverrides = DeepPartial<ModerationProfile>;

export { ProfileError };

// ---------------------------------------------------------------------------------------------------------------
// Validation

const TOP_KEYS = [
  'id',
  'name',
  'summary',
  'firstOffense',
  'repeat',
  'ladder',
  'profanity',
  'aiContext',
  'aiAutoAct',
  'rules',
  'areaRules',
  'severeRules',
  'durations',
  'customDuration',
  'reporting',
  'ai',
  'pace',
  'signals',
  'levels',
  'guidelines',
] as const;
/** Top-level keys that may be left out (the kit falls back to its defaults). */
const RULE_LIST_KEYS: readonly string[] = ['areaRules', 'severeRules'];
const OPTIONAL_TOP_KEYS: readonly string[] = [...RULE_LIST_KEYS, 'durations', 'customDuration', 'reporting', 'ai', 'pace', 'signals'];
const AI_KEYS = ['level', 'learn', 'dailyCalls'] as const;
/** The most rule numbers `areaRules` or `severeRules` may list. */
export const MAX_RULE_LIST = 100;
const REPEAT_KEYS = ['windowDays', 'notes', 'distinctGames', 'outcome'] as const;
const PROFANITY_KEYS = ['mode', 'style', 'add', 'remove', 'only', 'languages'] as const;
const OUTCOME_KEYS = ['kind', 'durationMs'] as const;
const LEVEL_KEYS = ['meaning', 'examples'] as const;
const ROW_KEYS = ['step', 'lowMedium', 'high'] as const;
const CELL_KEYS = ['kind', 'durationMs', 'label'] as const;
const TIER_KEYS = ['title', 'description', 'examples', 'covers', 'outcome'] as const;
const RULES_FLAVOURS: readonly string[] = ['relaxed', 'standard', 'strict'];
const PROFANITY_MODES: readonly string[] = ['allow', 'star', 'refuse'];
const PROFANITY_STYLES: readonly string[] = ['full', 'keepFirst', 'grawlix'];
const OUTCOME_WORDS: readonly string[] = ['none', 'note', 'warning'];
const OUTCOME_KINDS: readonly string[] = ['chat', 'area', 'ban'];
const CELL_KINDS: readonly string[] = ['chat', 'area', 'ban', 'warning'];
const AI_ACT_LEVELS: readonly string[] = ['hostile', 'severe'];
const LADDER_ROWS = 6;
const WORD_MAX = 40;
const MAX_DEPTH = 24;

/**
 * The longest any duration may be: 365 days, the same cap `decide` and `applySanction` enforce (one source of truth), so a
 * suggested outcome or an automatic timeout can never name a length the moderator's own decision would refuse.
 */
export const MAX_DURATION_MS = MAX_SANCTION_DURATION_MS;
/** The longest `repeat.windowDays`: the history lookback (90 days), since the record reaches back no further. */
export const MAX_WINDOW_DAYS = HISTORY_LOOKBACK_MS / DAY;

/** The most lengths `durations` may list: a picker with more than this is not a picker. */
export const MAX_DURATIONS = 50;

/** The lengths offered when a profile does not say: 1 hour, 6 hours, 12 hours, 24 hours, 3 days, 7 days and 30 days. */
export const DEFAULT_DURATIONS: readonly number[] = Object.freeze([HOUR, 6 * HOUR, 12 * HOUR, DAY, 3 * DAY, 7 * DAY, 30 * DAY]);

function fail(path: string, reason: string): never {
  throw new ProfileError(path, reason);
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function obj(v: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isPlain(v)) return fail(path, 'must be an object');
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`${path}.${k}`, 'is not a known setting');
  for (const k of keys) if (!optional.includes(k) && !Object.hasOwn(v, k)) fail(`${path}.${k}`, 'is required');
  return v;
}

function text(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(path, 'must be a non-empty string');
  return v;
}

function oneOf(v: unknown, path: string, allowed: readonly string[], reason: string): string {
  if (typeof v !== 'string' || !allowed.includes(v)) fail(path, reason);
  return v;
}

function positiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

function duration(v: unknown, path: string): void {
  if (v !== null && (!positiveInt(v) || v > MAX_DURATION_MS)) {
    fail(path, 'must be a whole number of milliseconds above 0 and at most 365 days, or null for permanent');
  }
}

function stringList(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) return fail(path, 'must be a list');
  return v;
}

function textList(v: unknown, path: string): void {
  stringList(v, path).forEach((item, i) => text(item, `${path}[${i}]`));
}

function word(v: unknown, path: string): void {
  if (typeof v !== 'string' || v.length < 1 || v.length > WORD_MAX || /\s/.test(v)) {
    fail(path, `must be a single word of 1 to ${WORD_MAX} characters with no spaces`);
  }
}

function wordList(v: unknown, path: string): void {
  stringList(v, path).forEach((item, i) => word(item, `${path}[${i}]`));
}

function ruleList(v: unknown, path: string): void {
  const list = stringList(v, path);
  if (list.length > MAX_RULE_LIST) fail(path, `must list at most ${MAX_RULE_LIST} rule numbers`);
  list.forEach((item, i) => {
    if (!positiveInt(item)) fail(`${path}[${i}]`, 'must be a whole rule number from 1');
  });
}

function outcome(v: unknown, path: string): void {
  if (typeof v === 'string') {
    oneOf(v, path, OUTCOME_WORDS, "must be 'none', 'note', 'warning' or a chat, area or ban restriction");
    return;
  }
  if (!isPlain(v)) return fail(path, "must be 'none', 'note', 'warning' or a chat, area or ban restriction");
  const o = obj(v, path, OUTCOME_KEYS);
  oneOf(o['kind'], `${path}.kind`, OUTCOME_KINDS, "must be 'chat', 'area' or 'ban'");
  duration(o['durationMs'], `${path}.durationMs`);
}

function validateDurations(v: unknown, path: string): void {
  if (!Array.isArray(v)) return fail(path, 'must be a list of lengths');
  if (v.length > MAX_DURATIONS) fail(path, `must list at most ${MAX_DURATIONS} lengths`);
  v.forEach((item: unknown, i) => {
    if (!positiveInt(item) || item > MAX_DURATION_MS) {
      fail(`${path}[${i}]`, 'must be a whole number of milliseconds above 0 and at most 365 days');
    }
  });
  for (let i = 1; i < v.length; i += 1) {
    if ((v[i] as number) <= (v[i - 1] as number)) fail(path, 'must be sorted from the shortest, with no repeats');
  }
}

function validateLadder(v: unknown, path: string): void {
  if (!Array.isArray(v) || v.length !== LADDER_ROWS) fail(path, `must have exactly ${LADDER_ROWS} rows, steps 0 to 5`);
  v.forEach((rowValue: unknown, i) => {
    const rowPath = `${path}[${i}]`;
    const row = obj(rowValue, rowPath, ROW_KEYS);
    if (row['step'] !== i) fail(`${rowPath}.step`, `must be ${i}: rows run in order from step 0 to 5`);
    for (const col of ['lowMedium', 'high'] as const) {
      const cellPath = `${rowPath}.${col}`;
      const cell = obj(row[col], cellPath, CELL_KEYS);
      oneOf(cell['kind'], `${cellPath}.kind`, CELL_KINDS, "must be 'chat', 'area', 'ban' or 'warning'");
      if (cell['kind'] === 'warning') {
        if (cell['durationMs'] !== null) fail(`${cellPath}.durationMs`, 'must be null for a warning');
      } else {
        duration(cell['durationMs'], `${cellPath}.durationMs`);
      }
      text(cell['label'], `${cellPath}.label`);
    }
  });
}

function validateGuidelines(v: unknown, path: string): void {
  if (!Array.isArray(v)) return fail(path, 'must be a list of tiers');
  const covered = new Set<string>();
  v.forEach((tierValue: unknown, i) => {
    const tp = `${path}[${i}]`;
    const t = obj(tierValue, tp, TIER_KEYS);
    text(t['title'], `${tp}.title`);
    text(t['description'], `${tp}.description`);
    textList(t['examples'], `${tp}.examples`);
    const covers = t['covers'];
    if (!Array.isArray(covers) || covers.length === 0) fail(`${tp}.covers`, 'must list at least one thing the tier covers');
    covers.forEach((c: unknown, j) => {
      const cp = `${tp}.covers[${j}]`;
      oneOf(c, cp, [...CONDUCT_LEVELS, 'repeated', 'after_warning'], "must be a conduct level, 'repeated' or 'after_warning'");
      if (typeof c === 'string') {
        if (covered.has(c)) fail(cp, 'is already covered by another tier: each may be covered once');
        covered.add(c);
      }
    });
    text(t['outcome'], `${tp}.outcome`);
  });
  for (const level of CONDUCT_LEVELS) {
    if (!covered.has(level)) fail(path, `must cover every conduct level exactly once; ${level} is not covered`);
  }
}

const REPORTING_KEYS = ['flow', 'reasons', 'thanks'] as const;
const REASON_KEYS = ['id', 'label', 'hint', 'group', 'rules', 'asksNote', 'enabled'] as const;
const REASON_OPTIONAL: readonly string[] = ['hint', 'group', 'rules', 'asksNote', 'enabled'];

/** A line of text of `min` to `max` characters (not blank when `min` is 1). */
function lineOf(v: unknown, path: string, min: 0 | 1, max: number): void {
  if (typeof v !== 'string' || (min === 1 && v.trim() === '') || v.length > max) {
    fail(path, min === 1 ? `must be text of 1 to ${max} characters` : `must be text of at most ${max} characters`);
  }
}

/** The `ai` section, in input shape (both fields optional). Levels 3 and 4 are designed but not built, so they are refused by name. */
function validateAI(v: unknown, path: string): void {
  const ai = obj(v, path, AI_KEYS, AI_KEYS);
  if (Object.hasOwn(ai, 'level')) {
    const level = ai['level'];
    if (level === 3 || level === 4) fail(`${path}.level`, 'AI levels 3 and 4 are not available yet');
    if (level !== 0 && level !== 1 && level !== 2) fail(`${path}.level`, 'must be 0 (off), 1 (read) or 2 (recommend)');
  }
  if (Object.hasOwn(ai, 'learn') && typeof ai['learn'] !== 'boolean') fail(`${path}.learn`, 'must be true or false');
  if (Object.hasOwn(ai, 'dailyCalls')) {
    const n = ai['dailyCalls'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > AI_DAILY_CALLS_MAX) {
      fail(`${path}.dailyCalls`, `must be a whole number of calls from 1 to ${AI_DAILY_CALLS_MAX}`);
    }
  }
}

/** The `reporting` section, in input shape (every field optional, a reason needing only an id and a label). */
function validateReporting(v: unknown, path: string): void {
  const rep = obj(v, path, REPORTING_KEYS, REPORTING_KEYS);
  if (Object.hasOwn(rep, 'flow')) oneOf(rep['flow'], `${path}.flow`, REPORT_FLOWS, "must be 'one_tap', 'reason_first' or 'reason_required'");
  if (Object.hasOwn(rep, 'thanks')) lineOf(rep['thanks'], `${path}.thanks`, 1, REPORT_THANKS_MAX);
  if (!Object.hasOwn(rep, 'reasons')) return;

  const rp = `${path}.reasons`;
  const list = stringList(rep['reasons'], rp);
  if (list.length < 1 || list.length > MAX_REPORT_REASONS) fail(rp, `must list 1 to ${MAX_REPORT_REASONS} reasons`);
  const seen = new Set<string>();
  list.forEach((item: unknown, i) => {
    const ip = `${rp}[${i}]`;
    const reason = obj(item, ip, REASON_KEYS, REASON_OPTIONAL);
    const id = reason['id'];
    if (!isReasonId(id)) {
      fail(`${ip}.id`, `must be a lowercase slug of 1 to ${REPORT_ID_MAX} letters, digits, _ and -, and not 'none'`);
    }
    if (seen.has(id)) fail(`${ip}.id`, 'is used by another reason');
    seen.add(id);
    lineOf(reason['label'], `${ip}.label`, 1, REPORT_LABEL_MAX);
    if (Object.hasOwn(reason, 'hint')) lineOf(reason['hint'], `${ip}.hint`, 0, REPORT_HINT_MAX);
    if (Object.hasOwn(reason, 'group')) lineOf(reason['group'], `${ip}.group`, 0, REPORT_GROUP_MAX);
    if (Object.hasOwn(reason, 'rules')) {
      const rules = stringList(reason['rules'], `${ip}.rules`);
      if (rules.length > MAX_REASON_RULES) fail(`${ip}.rules`, `must list at most ${MAX_REASON_RULES} rule numbers`);
      rules.forEach((n: unknown, j) => {
        if (!positiveInt(n)) fail(`${ip}.rules[${j}]`, 'must be a whole rule number from 1');
      });
    }
    for (const key of ['asksNote', 'enabled'] as const) {
      if (Object.hasOwn(reason, key) && typeof reason[key] !== 'boolean') fail(`${ip}.${key}`, 'must be true or false');
    }
  });
  const on = (r: unknown): boolean => !isPlain(r) || r['enabled'] !== false;
  if (!list.some(on)) fail(rp, 'must have at least one reason switched on');
  const otherAt = list.findIndex((r) => isPlain(r) && r['id'] === OTHER_REASON_ID);
  if (otherAt === -1) fail(rp, `must keep the '${OTHER_REASON_ID}' reason: it can be relabelled but not removed`);
  if (!on(list[otherAt])) fail(`${rp}[${otherAt}].enabled`, `must stay on: '${OTHER_REASON_ID}' is the fallback reason`);
}

/**
 * Check a profile of unknown shape, throwing {@link ProfileError} (with the field path) at the first problem. The
 * message names the field and the rule, never the value, since a value may be chat text.
 */
export function validateProfile(value: unknown): asserts value is ModerationProfile {
  const p = obj(value, 'profile', TOP_KEYS, OPTIONAL_TOP_KEYS);
  text(p['id'], 'profile.id');
  text(p['name'], 'profile.name');
  text(p['summary'], 'profile.summary');
  text(p['aiContext'], 'profile.aiContext');
  oneOf(p['rules'], 'profile.rules', RULES_FLAVOURS, "must be 'relaxed', 'standard' or 'strict'");
  for (const key of RULE_LIST_KEYS) if (Object.hasOwn(p, key)) ruleList(p[key], `profile.${key}`);

  const first = obj(p['firstOffense'], 'profile.firstOffense', CONDUCT_LEVELS);
  for (const level of CONDUCT_LEVELS) outcome(first[level], `profile.firstOffense.${level}`);
  if (first['banter'] !== 'none') fail('profile.firstOffense.banter', "must be 'none': banter never punishes");
  if (first['severe'] === 'none' || first['severe'] === 'note') {
    fail('profile.firstOffense.severe', "must act: 'warning' or a chat, area or ban restriction, since severe conduct is acted on at once");
  }

  const repeat = obj(p['repeat'], 'profile.repeat', REPEAT_KEYS);
  if (!positiveInt(repeat['windowDays']) || repeat['windowDays'] > MAX_WINDOW_DAYS) {
    fail(
      'profile.repeat.windowDays',
      `must be a whole number of days from 1 to ${MAX_WINDOW_DAYS}: the record only reaches back ${MAX_WINDOW_DAYS} days`,
    );
  }
  if (!positiveInt(repeat['notes'])) fail('profile.repeat.notes', 'must be a whole number ≥ 1');
  if (typeof repeat['distinctGames'] !== 'boolean') fail('profile.repeat.distinctGames', 'must be true or false');
  outcome(repeat['outcome'], 'profile.repeat.outcome');
  if (repeat['outcome'] === 'none' || repeat['outcome'] === 'note') {
    fail('profile.repeat.outcome', "must escalate: 'warning' or a chat, area or ban restriction");
  }

  validateLadder(p['ladder'], 'profile.ladder');

  // Both are optional (a 0.1.1 profile has neither); when present they are checked.
  if (Object.hasOwn(p, 'durations')) validateDurations(p['durations'], 'profile.durations');
  if (Object.hasOwn(p, 'customDuration') && typeof p['customDuration'] !== 'boolean') fail('profile.customDuration', 'must be true or false');
  if (Object.hasOwn(p, 'reporting')) validateReporting(p['reporting'], 'profile.reporting');
  if (Object.hasOwn(p, 'ai')) validateAI(p['ai'], 'profile.ai');
  if (Object.hasOwn(p, 'pace')) resolvePace(p['pace'] as PaceSettings, 'profile.pace');
  if (Object.hasOwn(p, 'signals')) resolveSignals(p['signals'] as SignalSettings, 'profile.signals');

  const prof = obj(p['profanity'], 'profile.profanity', PROFANITY_KEYS);
  oneOf(prof['mode'], 'profile.profanity.mode', PROFANITY_MODES, "must be 'allow', 'star' or 'refuse'");
  oneOf(prof['style'], 'profile.profanity.style', PROFANITY_STYLES, "must be 'full', 'keepFirst' or 'grawlix'");
  wordList(prof['add'], 'profile.profanity.add');
  wordList(prof['remove'], 'profile.profanity.remove');
  if (prof['only'] !== null) wordList(prof['only'], 'profile.profanity.only');
  wordList(prof['languages'], 'profile.profanity.languages');

  stringList(p['aiAutoAct'], 'profile.aiAutoAct').forEach((level, i) =>
    oneOf(level, `profile.aiAutoAct[${i}]`, AI_ACT_LEVELS, "must be 'hostile' or 'severe': banter and rude are never acted on automatically"),
  );

  const levels = obj(p['levels'], 'profile.levels', CONDUCT_LEVELS);
  for (const level of CONDUCT_LEVELS) {
    const lp = `profile.levels.${level}`;
    const l = obj(levels[level], lp, LEVEL_KEYS);
    text(l['meaning'], `${lp}.meaning`);
    textList(l['examples'], `${lp}.examples`);
  }

  validateGuidelines(p['guidelines'], 'profile.guidelines');
}

// ---------------------------------------------------------------------------------------------------------------
// Copy, merge, freeze

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty, so a `__proto__` key from parsed JSON becomes a plain own key (and is then rejected as unknown).
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function clone(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return fail('profile', 'is nested too deeply');
  if (Array.isArray(v)) return v.map((item: unknown) => clone(item, depth + 1));
  if (isPlain(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const item = v[k];
      if (item !== undefined) setOwn(out, k, clone(item, depth + 1));
    }
    return out;
  }
  return v;
}

/** Deep-merge `over` onto `base`: objects merge key by key, everything else (arrays, `null`, strings) replaces. */
function merge(base: unknown, over: unknown, depth = 0): unknown {
  if (over === undefined) return clone(base, depth);
  if (depth > MAX_DEPTH) return fail('profile', 'is nested too deeply');
  if (isPlain(base) && isPlain(over)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(base)) setOwn(out, k, merge(base[k], Object.hasOwn(over, k) ? over[k] : undefined, depth + 1));
    for (const k of Object.keys(over)) {
      if (!Object.hasOwn(base, k) && over[k] !== undefined) setOwn(out, k, clone(over[k], depth + 1));
    }
    return out;
  }
  return clone(over, depth);
}

/** Drop repeated numbers from `areaRules` and `severeRules` (first one wins, order kept) before they are validated. */
function dedupeRuleLists(copy: unknown): void {
  if (!isPlain(copy)) return;
  for (const key of RULE_LIST_KEYS) {
    const list = copy[key];
    // Counted before the quadratic de-duplication below, so a huge list is refused without being worked through.
    if (Array.isArray(list) && list.length > MAX_RULE_LIST) fail(`profile.${key}`, `must list at most ${MAX_RULE_LIST} rule numbers`);
    if (Array.isArray(list)) setOwn(copy, key, list.filter((item: unknown, i) => list.findIndex((other: unknown) => Object.is(other, item)) === i));
  }
}

/**
 * Each reason's rule list is counted (a huge one is refused before any work is done) and de-duplicated, as `areaRules` is.
 * Anything that is not the expected shape is left alone for the validator to name.
 */
function dedupeReasonRules(copy: Record<string, unknown>): void {
  const reporting = copy['reporting'];
  if (!isPlain(reporting) || !Array.isArray(reporting['reasons']) || reporting['reasons'].length > MAX_REPORT_REASONS) return;
  (reporting['reasons'] as unknown[]).forEach((reason, i) => {
    if (!isPlain(reason) || !Array.isArray(reason['rules'])) return;
    const rules = reason['rules'] as unknown[];
    if (rules.length > MAX_REASON_RULES) fail(`profile.reporting.reasons[${i}].rules`, `must list at most ${MAX_REASON_RULES} rule numbers`);
    setOwn(reason, 'rules', rules.filter((n, at) => rules.findIndex((other) => Object.is(other, n)) === at));
  });
}

/** The AI settings with every field filled in; a value of the wrong shape is returned as it is, for the validator to name. */
function fillAI(value: unknown): unknown {
  if (value === undefined) return { level: 0, learn: true, dailyCalls: AI_DAILY_CALLS_DEFAULT };
  return isPlain(value) ? { level: 0, learn: true, dailyCalls: AI_DAILY_CALLS_DEFAULT, ...value } : value;
}

/** A profile written before `durations`, `customDuration`, `reporting` and `ai` existed gets their defaults. */
function fillDefaults(copy: unknown): void {
  if (!isPlain(copy)) return;
  setOwn(copy, 'ai', fillAI(copy['ai']));
  if (!Object.hasOwn(copy, 'durations')) setOwn(copy, 'durations', [...DEFAULT_DURATIONS]);
  if (!Object.hasOwn(copy, 'customDuration')) setOwn(copy, 'customDuration', true);
  // A section of the wrong shape is left as it is, for the validator to name; one that checks out is filled in.
  setOwn(copy, 'reporting', fillReporting(copy['reporting']));
  dedupeReasonRules(copy);
}

/** Copy, validate and freeze. Nothing returned shares structure with the input. */
function finalize(value: unknown): ResolvedProfile {
  const copy = clone(value);
  dedupeRuleLists(copy);
  fillDefaults(copy);
  validateProfile(copy);
  // Checked above, so this cannot throw: every pace field is filled in, `null` meaning off.
  if (isPlain(copy)) {
    setOwn(copy, 'pace', resolvePace(copy['pace'] as PaceSettings | undefined, 'profile.pace'));
    setOwn(copy, 'signals', resolveSignals(copy['signals'] as SignalSettings | undefined, 'profile.signals'));
  }
  return deepFreeze(copy as ResolvedProfile);
}

/**
 * A copy of a profile with `durations` and `customDuration` filled in where it has none (a 0.1.1 profile). The input is not
 * changed and the profile is not validated here (`validateProfile` does that). Used by the document functions.
 */
export function withDurationDefaults(p: ModerationProfile): ResolvedProfile {
  return {
    ...p,
    durations: p.durations ?? [...DEFAULT_DURATIONS],
    customDuration: p.customDuration ?? true,
    reporting: resolveReporting(p.reporting),
    ai: { level: 0, learn: true, dailyCalls: AI_DAILY_CALLS_DEFAULT, ...p.ai },
    pace: resolvePace(p.pace),
    signals: resolveSignals(p.signals),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Presets

/** The conduct table from the standards doc: shared by all three presets, since the levels mean the same thing. */
const LEVELS: Record<ConductLevel, LevelDescription> = {
  banter: {
    meaning: 'Trash talk, salt, jokes about play, profanity not aimed at a person, a single mild insult',
    examples: ['ez', 'loser', "you're an idiot", 'lol you\'re trash at this', 'damn it'],
  },
  rude: {
    meaning: 'Aggressive, profane abuse aimed at a player, isolated',
    examples: ['go f— yourself'],
  },
  hostile: {
    meaning: 'Sustained or repeated aggression: several insults, picking a fight, following someone across games',
    examples: ['three insults in one game', 'insulting the same player again next game'],
  },
  severe: {
    meaning: 'Threats, hate or slurs, attacks on who someone is, sexual harassment, doxxing, serious harassment',
    examples: ['any slur', "I'll find you", 'anything about race or religion as an attack'],
  },
};

/**
 * Strict reads the table differently: here a mild insult is not banter, it is rude. Banter is only salt and jokes
 * about play, with no insults and no swearing; any insult or swearing aimed at a player is rude. Hostile and severe
 * mean the same as everywhere else.
 */
const STRICT_LEVELS: Record<ConductLevel, LevelDescription> = {
  banter: {
    meaning: 'Friendly salt and jokes about play, with no insults and no swearing',
    examples: ['ez', 'gg', 'bad play', 'lol'],
  },
  rude: {
    meaning: 'Any insult or swearing aimed at a player, even once',
    examples: ['loser', "you're an idiot", 'go f— yourself'],
  },
  hostile: LEVELS.hostile,
  severe: LEVELS.severe,
};

const DEFAULT_PROFANITY: ProfanityConfig = {
  mode: 'star',
  style: 'full',
  add: [],
  remove: [],
  only: null,
  languages: ['en'],
};

const RELAXED: ModerationProfile = {
  id: 'relaxed',
  name: 'Relaxed',
  summary: 'Trash talk is part of the game. Harassment, threats and hate are not.',
  firstOffense: {
    banter: 'none',
    rude: 'note',
    hostile: 'warning',
    severe: { kind: 'chat', durationMs: 7 * DAY },
  },
  repeat: { windowDays: 30, notes: 2, distinctGames: true, outcome: 'warning' },
  ladder: LADDER_TABLE,
  profanity: { ...DEFAULT_PROFANITY, mode: 'star' },
  aiContext:
    'This is a competitive game for adults, and trash talk is part of it. Read salt, jokes about play and a single ' +
    'mild insult as banter, and take no action. Read one aggressive, profane line aimed at a player as rude: it ' +
    'is recorded, nothing more. Read several insults, picking a fight or following someone across games as ' +
    'hostile. Read threats, hate, slurs, attacks on who someone is, sexual harassment and doxxing as severe. ' +
    'Judge the pattern across the reported lines, not one heated moment, and when unsure choose the milder level.',
  aiAutoAct: ['severe'],
  rules: 'relaxed',
  areaRules: [5, 6],
  severeRules: [1],
  durations: [...DEFAULT_DURATIONS],
  customDuration: true,
  levels: LEVELS,
  guidelines: [
    {
      title: 'Minor, isolated',
      description:
        'Trash talk, salt and jokes about play, including a single mild insult. This is part of the game and is not moderated.',
      examples: ['ez', 'loser', 'lol you\'re trash at this'],
      covers: ['banter'],
      outcome: 'No action. Nothing is recorded.',
    },
    {
      title: 'Aggressive but isolated',
      description:
        'One aggressive, profane line aimed at a player, with no pattern behind it. The player is not told and nothing is restricted, but staff keep a record.',
      examples: ['go f— yourself'],
      covers: ['rude'],
      outcome: 'A note on the record, kept for staff only.',
    },
    {
      title: 'Repeated hostility',
      description:
        'Several insults in one game, picking a fight, or aggression that continues across games. Two recorded incidents from different games within 30 days count as repeated.',
      examples: ['three insults in one game', 'insulting the same player again next game'],
      covers: ['hostile', 'repeated'],
      outcome: 'A warning: be respectful.',
    },
    {
      title: 'After a warning',
      description: 'The behaviour continues after the player has been warned.',
      examples: [],
      covers: ['after_warning'],
      outcome: 'Timeouts, then bans, stepping up with each action.',
    },
    {
      title: 'Severe',
      description:
        'Threats, hate or slurs, attacks on who someone is, sexual harassment, doxxing and other serious harassment. These are acted on straight away, whatever the record.',
      examples: ['any slur', "I'll find you"],
      covers: ['severe'],
      outcome: 'Immediate action: chat restricted for 7 days, then bans.',
    },
  ],
};

const STANDARD: ModerationProfile = {
  id: 'standard',
  name: 'Standard',
  summary: "Keep it friendly. Personal insults, harassment and hate aren't allowed.",
  firstOffense: {
    banter: 'none',
    rude: 'warning',
    hostile: { kind: 'chat', durationMs: DAY },
    severe: { kind: 'chat', durationMs: 7 * DAY },
  },
  repeat: { windowDays: 30, notes: 2, distinctGames: false, outcome: { kind: 'chat', durationMs: DAY } },
  ladder: LADDER_TABLE,
  profanity: { ...DEFAULT_PROFANITY, mode: 'star' },
  aiContext:
    'This is a game for general audiences, and the aim is a friendly space. Read salt, jokes about play and a ' +
    'single mild insult as banter, and take no action. Read aggressive, profane abuse aimed at a player as ' +
    'rude, even once. Read several insults, picking a fight or following someone across games as hostile. ' +
    'Read threats, hate, slurs, attacks on who someone is, sexual harassment and doxxing as severe. Judge the ' +
    'pattern across the reported lines, and when unsure choose the milder level.',
  aiAutoAct: ['severe'],
  rules: 'standard',
  areaRules: [5, 6],
  severeRules: [1],
  durations: [...DEFAULT_DURATIONS],
  customDuration: true,
  levels: LEVELS,
  guidelines: [
    {
      title: 'Banter',
      description:
        'Trash talk, salt and jokes about play, including a single mild insult. Fine here, and not moderated.',
      examples: ['ez', 'loser', 'damn it'],
      covers: ['banter'],
      outcome: 'No action. Nothing is recorded.',
    },
    {
      title: 'Personal abuse',
      description: 'Aggressive, profane abuse aimed at a player, even once.',
      examples: ['go f— yourself'],
      covers: ['rude'],
      outcome: 'A warning.',
    },
    {
      title: 'Sustained or repeated hostility',
      description:
        'Several insults, picking a fight, or aggression that continues across games. Two recorded incidents within 30 days count as repeated.',
      examples: ['three insults in one game', 'insulting the same player again next game'],
      covers: ['hostile', 'repeated'],
      outcome: 'Chat restricted for 24 hours.',
    },
    {
      title: 'After a warning',
      description: 'The behaviour continues after the player has been warned.',
      examples: [],
      covers: ['after_warning'],
      outcome: 'Longer restrictions, then bans, stepping up with each action.',
    },
    {
      title: 'Severe',
      description:
        'Threats, hate or slurs, attacks on who someone is, sexual harassment, doxxing and other serious harassment.',
      examples: ['any slur', "I'll find you"],
      covers: ['severe'],
      outcome: 'Chat restricted for 7 days at once, then bans.',
    },
  ],
};

/**
 * Strict is for younger players and families. Two points the standards table cannot say in an {@link Outcome}:
 * - Its ladder is the same K2 table as the other presets; what makes strict strict is `firstOffense`, `repeat`
 *   (any earlier note is repeated, and then chat is restricted for 24 hours) and refusing profanity. The ladder carries
 *   no per-preset floor.
 * - The table's rude first offense is "warning + chat 1 h". An Outcome is one action, so it is the 1 hour chat
 *   restriction, the stronger of the two. The window for "any note" is the same 30 days as the other presets.
 */
const STRICT: ModerationProfile = {
  id: 'strict',
  name: 'Strict',
  summary: 'Be kind. No swearing, insults or bullying.',
  firstOffense: {
    banter: 'none',
    rude: { kind: 'chat', durationMs: HOUR },
    hostile: { kind: 'chat', durationMs: DAY },
    severe: { kind: 'ban', durationMs: 7 * DAY },
  },
  repeat: { windowDays: 30, notes: 1, distinctGames: false, outcome: { kind: 'chat', durationMs: DAY } },
  ladder: LADDER_TABLE,
  profanity: { ...DEFAULT_PROFANITY, mode: 'refuse' },
  aiContext:
    'This is a game for younger players and families, and the aim is a kind space. Read only friendly salt and ' +
    'jokes about play ("ez", "gg", "bad play") as banter, and take no action; swearing that is not aimed at anyone is ' +
    'stopped before it is sent and is not a violation. Read any insult or swearing aimed at a player, even a mild one such as ' +
    '"loser", as rude. Read several insults, bullying, picking a fight or following ' +
    'someone across games as hostile. Read threats, hate, slurs, attacks on who someone is, sexual harassment ' +
    'and doxxing as severe. Judge the pattern across the reported lines, and when unsure choose the milder level.',
  aiAutoAct: ['hostile', 'severe'],
  rules: 'strict',
  areaRules: [5, 6],
  severeRules: [1],
  durations: [...DEFAULT_DURATIONS],
  customDuration: true,
  levels: STRICT_LEVELS,
  guidelines: [
    {
      title: 'Banter',
      description:
        'Friendly salt and jokes about play, with no insults. Swearing that is not aimed at anyone is stopped before it is sent, and that is not a violation.',
      examples: ['ez', 'gg', 'bad play', 'lol'],
      covers: ['banter'],
      outcome: 'No action. Nothing is recorded.',
    },
    {
      title: 'Rudeness',
      description:
        'Any insult or swearing aimed at a player, even once. Any earlier note on the record makes it repeated.',
      examples: ['loser', "you're an idiot", 'go f— yourself'],
      covers: ['rude', 'repeated'],
      outcome:
        'First time: chat restricted for 1 hour. Repeated (any earlier note on the record): chat restricted for 24 hours.',
    },
    {
      title: 'Bullying',
      description: 'Several insults, picking a fight, or aggression that continues across games.',
      examples: ['three insults in one game', 'insulting the same player again next game'],
      covers: ['hostile'],
      outcome: 'Chat restricted for 24 hours.',
    },
    {
      title: 'After a warning',
      description: 'The behaviour continues after the player has been warned.',
      examples: [],
      covers: ['after_warning'],
      outcome: 'Longer restrictions, then bans, stepping up with each action.',
    },
    {
      title: 'Severe',
      description:
        'Threats, hate or slurs, attacks on who someone is, sexual harassment, doxxing and other serious harassment.',
      examples: ['any slur', "I'll find you"],
      covers: ['severe'],
      outcome: 'A 7 day ban at once.',
    },
  ],
};

/** The three presets, complete, valid and deep-frozen. Values are the standards doc's tables. */
export const PRESETS: Readonly<Record<'relaxed' | 'standard' | 'strict', ResolvedProfile>> = Object.freeze({
  relaxed: finalize(RELAXED),
  standard: finalize(STANDARD),
  strict: finalize(STRICT),
});

/** The name of a built-in preset. */
export type PresetName = keyof typeof PRESETS;

// ---------------------------------------------------------------------------------------------------------------
// Public API

/**
 * Start from a preset (by name, or any profile) and override any field. The overrides are deep-merged onto a copy:
 * objects merge key by key, so overriding one nested field keeps its siblings; arrays (`aiAutoAct`,
 * `profanity.add`, `ladder`, `guidelines`) are replaced whole, never concatenated; `null` is a value
 * (`profanity.only: null`); `undefined` means "not given". The merged result is validated, and the returned
 * profile is a deep-frozen copy that shares nothing with the preset or the overrides.
 *
 * Throws {@link ProfileError} for an unknown preset name, an unknown key at any depth, or any invalid value.
 */
export function resolveProfile(
  preset: ModerationProfile | PresetName,
  overrides: ProfileOverrides = {},
): ResolvedProfile {
  let base: ModerationProfile;
  if (typeof preset === 'string') {
    if (!Object.hasOwn(PRESETS, preset)) return fail('preset', "must be 'relaxed', 'standard', 'strict' or a profile");
    base = PRESETS[preset];
  } else {
    base = preset;
  }
  return finalize(merge(base, overrides));
}

/**
 * Validate a complete custom profile. Nothing is merged (a profile that leaves out `durations` or `customDuration` gets
 * their defaults). Returns a deep-frozen copy, so editing the object you passed afterwards cannot change a profile that
 * was already checked. Throws {@link ProfileError}.
 */
export function defineProfile(p: ModerationProfile): ResolvedProfile {
  return finalize(p);
}

// ---------------------------------------------------------------------------------------------------------------
// The policy layer: what a moderator may edit at runtime

/**
 * The parts of a profile the hub may edit, and the order they are listed in. Everything else (identity, the written
 * levels, the AI context, profanity handling) stays in code: changing profanity means rebuilding the filter.
 */
export const POLICY_SECTIONS = ['durations', 'customDuration', 'ladder', 'firstOffense', 'repeat', 'areaRules', 'severeRules', 'guidelines', 'reporting', 'ai', 'pace', 'signals'] as const;
export type PolicySection = (typeof POLICY_SECTIONS)[number];

/** One ladder cell as the editor sends it: the label may be left out and is then generated ("Restrict chat 6 hours"). */
export interface PolicyCell {
  kind: 'chat' | 'area' | 'ban' | 'warning';
  durationMs: number | null;
  label?: string;
}

/** One ladder row as the editor sends it. */
export interface PolicyLadderRow {
  step: LadderStep;
  lowMedium: PolicyCell;
  high: PolicyCell;
}

/**
 * The stored edits: a deep-partial of the editable sections. An object section merges key by key onto the profile
 * (`firstOffense`, `repeat`); a list replaces the profile's list whole (`durations`, `ladder` as all 6 rows, `areaRules`,
 * `severeRules`). `guidelines` is positional: entry `i` holds the new `outcome` text of the profile's guideline tier `i`,
 * and `null` leaves that tier as it is. A layer that touches anything else is refused.
 */
export interface PolicyLayer {
  durations?: number[];
  customDuration?: boolean;
  ladder?: PolicyLadderRow[];
  firstOffense?: Partial<Record<ConductLevel, Outcome>>;
  repeat?: Partial<ModerationProfile['repeat']>;
  areaRules?: number[];
  severeRules?: number[];
  guidelines?: Array<{ outcome: string } | null>;
  /** The reporting settings: `flow` and `thanks` replace the profile's; `reasons` replaces the whole list. Each is optional; a reason needs only `id` and `label`. */
  reporting?: ReportingSettings;
  /** The AI settings: `level` (0 off, 1 read, 2 recommend), `learn` and `dailyCalls` (the owner's ceiling on calls in a UTC day, a whole number from 1 to 100 000). Each is optional and merges onto the profile's. Levels 3 and 4 are refused. */
  ai?: Partial<AISettings>;
  /**
   * The pace settings: each field is optional and merges onto the profile's (a field left out inherits, `null` turns it off, a value sets
   * it); `burst` replaces whole. @experimental
   */
  pace?: PaceSettings;
  /**
   * The signal feeds: only `feeds` may be edited (the kinds and the guards are declared in code). The layer's `feeds` REPLACE the
   * profile's wholesale, like every other section: a feed left out is off. A feed names declared kinds only. @experimental
   */
  signals?: { feeds?: SignalFeeds };
}

/** The longest outcome text a layer may set on a guideline tier. */
export const MAX_GUIDELINE_OUTCOME = 1000;

/** The label generated for a ladder cell with none, or null when the cell is not valid (the validator names why). */
function generatedLabel(kind: unknown, durationMs: unknown): string | null {
  if (typeof kind !== 'string' || !CELL_KINDS.includes(kind)) return null;
  if (kind === 'warning') return 'Warning';
  if (durationMs !== null && !(positiveInt(durationMs) && durationMs <= MAX_DURATION_MS)) return null;
  return outcomeLabel({ kind: kind as 'chat' | 'area' | 'ban', durationMs });
}

function withLabel(cell: unknown): unknown {
  if (!isPlain(cell) || Object.hasOwn(cell, 'label')) return cell;
  return { ...cell, label: generatedLabel(cell['kind'], cell['durationMs']) ?? '-' };
}

function ladderOverride(v: unknown): unknown {
  if (!Array.isArray(v)) return fail('profile.ladder', `must have exactly ${LADDER_ROWS} rows, steps 0 to 5`);
  return v.map((row: unknown) => (isPlain(row) ? { ...row, lowMedium: withLabel(row['lowMedium']), high: withLabel(row['high']) } : row));
}

function guidelinesOverride(base: ModerationProfile, v: unknown): unknown {
  if (!Array.isArray(v)) return fail('profile.guidelines', 'must be a list of outcome texts, one per guideline tier');
  if (v.length > base.guidelines.length) fail('profile.guidelines', 'has more entries than the profile has guideline tiers');
  return base.guidelines.map((tier, i) => {
    const entry: unknown = v[i];
    if (entry === undefined || entry === null) return clone(tier);
    const path = `profile.guidelines[${i}]`;
    if (!isPlain(entry)) return fail(path, 'must be an object with an outcome, or null');
    if (!Object.hasOwn(entry, 'outcome')) fail(`${path}.outcome`, 'is required');
    for (const k of Object.keys(entry)) if (k !== 'outcome') fail(`${path}.${k}`, 'is not an editable setting');
    const outcomeText = entry['outcome'];
    if (typeof outcomeText !== 'string' || outcomeText.trim() === '') return fail(`${path}.outcome`, 'must be a non-empty string');
    if (outcomeText.length > MAX_GUIDELINE_OUTCOME) fail(`${path}.outcome`, `must be at most ${MAX_GUIDELINE_OUTCOME} characters`);
    return { ...(clone(tier) as Record<string, unknown>), outcome: outcomeText };
  });
}

/** An outcome written as an object must say both `kind` and `durationMs`: a layer is self-contained, never half merged onto the base. */
function wholeOutcome(v: unknown, path: string): void {
  if (!isPlain(v)) return;
  if (!Object.hasOwn(v, 'kind')) fail(`${path}.kind`, 'is required');
  if (!Object.hasOwn(v, 'durationMs')) fail(`${path}.durationMs`, 'is required');
}

/**
 * A layer's `signals` may hold only `feeds`, and every feed must name kinds the profile declares. The feeds themselves are not put in
 * the overrides: they replace the profile's wholesale, which the deep merge would not do, so `applyPolicyLayer` sets them after it.
 */
function layerSignals(base: ModerationProfile, value: unknown): void {
  if (!isPlain(value)) return fail('profile.signals', 'must be an object');
  for (const k of Object.keys(value)) {
    if (k !== 'feeds') fail(`profile.signals.${k}`, 'is not an editable setting: kinds and guards are declared in code');
  }
  const feeds = Object.hasOwn(value, 'feeds') ? value['feeds'] : undefined;
  checkSignalFeeds(feeds as SignalFeeds | undefined, resolveSignals(base.signals, 'profile.signals').kinds, { signalsMs: Infinity }, 'profile.signals.feeds');
}

/** Put the layer's signal feeds in place of the merged profile's (a feed the layer leaves out is off). */
function replaceSignalFeeds(merged: unknown, layer: unknown): void {
  if (!isPlain(merged) || !isPlain(layer) || !Object.hasOwn(layer, 'signals') || !isPlain(layer['signals'])) return;
  const feeds = Object.hasOwn(layer['signals'], 'feeds') ? layer['signals']['feeds'] : undefined;
  const section = isPlain(merged['signals']) ? merged['signals'] : {};
  setOwn(section, 'feeds', feeds === undefined ? {} : clone(feeds));
  setOwn(merged, 'signals', section);
}

function layerToOverrides(base: ModerationProfile, layer: unknown): Record<string, unknown> {
  if (!isPlain(layer)) return fail('profile', 'must be an object');
  for (const key of Object.keys(layer)) {
    if (!(POLICY_SECTIONS as readonly string[]).includes(key)) fail(`profile.${key}`, 'is not an editable setting');
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(layer)) {
    const value = layer[key];
    if (value === undefined) continue;
    if (key === 'firstOffense' && isPlain(value)) {
      for (const level of Object.keys(value)) wholeOutcome(value[level], `profile.firstOffense.${level}`);
    }
    if (key === 'repeat' && isPlain(value)) wholeOutcome(value['outcome'], 'profile.repeat.outcome');
    if (key === 'signals') {
      layerSignals(base, value);
      continue;
    }
    if (key === 'pace') {
      // Checked on its own so the error names layer.pace..., then merged here so `burst` replaces whole instead of merging by member.
      resolvePace(value as PaceSettings, 'profile.pace');
      setOwn(out, key, mergePace(resolvePace(base.pace, 'profile.pace'), value as PaceSettings));
    } else if (key === 'ladder') setOwn(out, key, ladderOverride(value));
    else if (key === 'guidelines') setOwn(out, key, guidelinesOverride(base, value));
    else setOwn(out, key, value);
  }
  return out;
}

/** The same error, with the path named from the layer the editor sent (`profile.ladder[2]` is `layer.ladder[2]`). */
function inLayerTerms(err: ProfileError): ProfileError {
  const path = err.path === 'profile' ? 'layer' : err.path.startsWith('profile.') ? `layer.${err.path.slice('profile.'.length)}` : err.path;
  return new ProfileError(path, err.reason, err.code);
}

/**
 * The effective profile: `base` (a preset with the code overrides) with the stored `layer` merged on top, validated. The
 * result is a deep-frozen copy that shares nothing with either. Throws {@link ProfileError} whose `path` starts with
 * `layer` (`layer.profanity`, `layer.ladder[2].high.durationMs`): a layer that touches a setting outside
 * {@link POLICY_SECTIONS}, or one that would make the profile invalid.
 */
export function applyPolicyLayer(base: ModerationProfile, layer: PolicyLayer): ResolvedProfile {
  try {
    const merged = merge(base, layerToOverrides(base, layer));
    replaceSignalFeeds(merged, layer);
    return finalize(merged);
  } catch (err) {
    throw err instanceof ProfileError ? inLayerTerms(err) : err;
  }
}

/** The editable sections a layer holds, in {@link POLICY_SECTIONS} order. */
export function layerSections(layer: unknown): PolicySection[] {
  if (!isPlain(layer)) return [];
  return POLICY_SECTIONS.filter((s) => Object.hasOwn(layer, s));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x: unknown, i) => sameValue(x, b[i]));
  }
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
  }
  return false;
}

/** The sections that differ between two layers (present in one and not the other, or with other values), in order. */
export function changedSections(before: unknown, after: unknown): PolicySection[] {
  const a = isPlain(before) ? before : {};
  const b = isPlain(after) ? after : {};
  return POLICY_SECTIONS.filter((s) => {
    const inA = Object.hasOwn(a, s);
    const inB = Object.hasOwn(b, s);
    return inA !== inB || (inA && !sameValue(a[s], b[s]));
  });
}

/** A deep-frozen copy of a plain value (a stored layer, handed out read-only). */
export function frozenCopy<T>(v: T): T {
  return deepFreeze(clone(v)) as T;
}
