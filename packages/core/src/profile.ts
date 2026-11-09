import { HISTORY_LOOKBACK_MS, LADDER_TABLE } from './ladder.js';
import type { LadderRow } from './ladder.js';
import { CONDUCT_LEVELS } from './types.js';
import type { ConductLevel } from './types.js';

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

export interface ModerationProfile {
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

/** Like `Partial`, all the way down. Arrays are replaced, not merged; `null` is a value. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Overrides for {@link resolveProfile}. Any field; arrays replace the preset's array whole. */
export type ProfileOverrides = DeepPartial<ModerationProfile>;

/** A profile that fails validation. `path` names the field (`'profile.firstOffense.banter'`); the message never echoes a value. */
export class ProfileError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`${path} ${reason}`);
    this.name = 'ProfileError';
    this.path = path;
  }
}

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
  'levels',
  'guidelines',
] as const;
/** Top-level keys that may be left out (the kit falls back to its defaults). */
const OPTIONAL_TOP_KEYS: readonly string[] = ['areaRules', 'severeRules'];
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

/** The longest any duration may be: 100 years, so later date arithmetic cannot overflow. */
export const MAX_DURATION_MS = 3_153_600_000_000;
/** The longest `repeat.windowDays`: the history lookback (90 days), since the record reaches back no further. */
export const MAX_WINDOW_DAYS = HISTORY_LOOKBACK_MS / DAY;

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
    fail(path, 'must be a whole number of milliseconds above 0 and at most 100 years, or null for permanent');
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
  stringList(v, path).forEach((item, i) => {
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
  for (const key of OPTIONAL_TOP_KEYS) if (Object.hasOwn(p, key)) ruleList(p[key], `profile.${key}`);

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

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const item of Object.values(v)) deepFreeze(item);
  }
  return v;
}

/** Drop repeated numbers from `areaRules` and `severeRules` (first one wins, order kept) before they are validated. */
function dedupeRuleLists(copy: unknown): void {
  if (!isPlain(copy)) return;
  for (const key of OPTIONAL_TOP_KEYS) {
    const list = copy[key];
    if (Array.isArray(list)) setOwn(copy, key, list.filter((item: unknown, i) => list.findIndex((other: unknown) => Object.is(other, item)) === i));
  }
}

/** Copy, validate and freeze. Nothing returned shares structure with the input. */
function finalize(value: unknown): ModerationProfile {
  const copy = clone(value);
  dedupeRuleLists(copy);
  validateProfile(copy);
  return deepFreeze(copy);
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
export const PRESETS: Readonly<Record<'relaxed' | 'standard' | 'strict', ModerationProfile>> = Object.freeze({
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
): ModerationProfile {
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
 * Validate a complete custom profile. Nothing is merged. Returns a deep-frozen copy, so editing the object you
 * passed afterwards cannot change a profile that was already checked. Throws {@link ProfileError}.
 */
export function defineProfile(p: ModerationProfile): ModerationProfile {
  return finalize(p);
}
