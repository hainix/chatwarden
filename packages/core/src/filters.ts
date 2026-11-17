import { lowerKeepLength } from './filters/fold.js';
import { SHARED_HOSTING_SUFFIXES } from './filters/lists.js';
import { parsePattern } from './filters/phrases.js';
import { deepFreeze } from './freeze.js';
import { ProfileError } from './profileError.js';

// The chat filter settings: what an owner switches on (links, personal info, phrases, caps and repeats), each block with an action and the
// Community Rule it cites. Pure data and validation, no state and no clock; the scanners are in filters/ and the engine that composes
// them is filters/engine.ts. Everything is off until set. Errors are ProfileError with the path of the field, never echoing a value.

/** What a hit does to the line: only count it, file a report for a person to decide, hide the part, or refuse the line. */
export const FILTER_ACTIONS = ['count', 'flag', 'mask', 'refuse'] as const;
export type FilterAction = (typeof FILTER_ACTIONS)[number];

/** The limits every list is held to, so compile and check cost is bounded. */
export const FILTER_LIMITS = {
  /** Domains on each of `allow` and `deny`. */
  domains: 100,
  /** Phrase rules. */
  rules: 20,
  patternsPerRule: 100,
  patternsTotal: 500,
  labelChars: 40,
  ignoreEntries: 50,
  ignoreChars: 60,
  flagCapMin: 1,
  flagCapMax: 500,
  flagCapDefault: 50,
  newAccountDaysMax: 365,
} as const;

/** The Community Rule a block cites when it names none. */
export const FILTER_RULE_DEFAULTS = { links: 4, personalInfo: 2, phrases: 4, ratio: 4 } as const;

/** The numbers a ratio check uses when it is switched on and gives none. */
export const RATIO_DEFAULTS = {
  caps: { minLetters: 12, maxPercent: 70 },
  repeats: { maxRun: 6 },
  emoji: { max: 8 },
  mentions: { max: 3 },
} as const;

export const PERSONAL_KINDS = ['phone', 'email', 'card', 'contact'] as const;
export type PersonalKind = (typeof PERSONAL_KINDS)[number];

/**
 * The filters, as an owner writes them. Every field is optional; a block is on when it is present and off when it is absent or `null`.
 * Nothing is on until an owner turns it on. See the design note for what each block reads.
 * @experimental
 */
export interface FilterSettings {
  links?: LinkSettings | null;
  personalInfo?: PersonalInfoSettings | null;
  /** Up to 20 rules. Replaced whole by a layer. */
  phrases?: PhraseRuleSettings[];
  ratio?: RatioSettings | null;
  /** Phrases removed from a line before any filter reads it ("1 2 3 4 5 6 7 8 9", "e.g."). Up to 50, each 1 to 60 characters. */
  ignore?: string[];
  /** The most `flag` reports the filters file in one UTC day. 1 to 500, default 50. Past it a `flag` counts only. */
  flagCapPerDay?: number;
}

/** @experimental */
export interface LinkSettings {
  action: FilterAction;
  /** A Community Rule number; default 4. */
  rule?: number;
  /** Up to 100 domains; an entry matches the host and its subdomains, and `=name` matches that host only. */
  allow?: string[];
  /** Up to 100 domains, matched the same way. */
  deny?: string[];
  /** A link on neither list. Default 'act'. */
  unlisted?: 'act' | 'allow';
  /** The built-in invite links (Discord, Telegram, WhatsApp, ...). Default true. */
  invites?: boolean;
  /** The built-in URL shorteners. Default true. */
  shorteners?: boolean;
  /** Links from an account younger than this many days are acted on even if `unlisted` is 'allow' (the allow list still passes). 1 to 365, default null (off). Needs `signals.accountAgeDays`. */
  newAccountDays?: number | null;
}

/** @experimental */
export interface PersonalInfoSettings {
  action: FilterAction;
  /** Default 2. */
  rule?: number;
  /** Default all four. */
  kinds?: PersonalKind[];
  /** Default 'formatted'. */
  phone?: 'formatted' | 'any';
  /** A street address by heuristic. Only ever counts or flags (never hides or refuses). Default null (off). */
  address?: 'count' | 'flag' | null;
}

/** @experimental */
export interface PhraseRuleSettings {
  /** `^[a-z][a-z0-9_-]{0,31}$`, unique: it is the counter key. */
  id: string;
  /** Up to 40 characters, shown in the hub and on the queue chip. */
  label?: string;
  action: FilterAction;
  /** Default 4. */
  rule?: number;
  /** 1 to 100 patterns. */
  phrases: string[];
}

/**
 * Caps, repeats, emoji and mentions. With the block present, each check is on with its defaults unless set to `null`; `action: 'mask'`
 * softens the line (lowercases it, shortens a run, cuts the extras) and never hides a span.
 * @experimental
 */
export interface RatioSettings {
  action: FilterAction;
  /** Default 4. */
  rule?: number;
  /** minLetters 8..200 (default 12), maxPercent 50..100 (default 70). */
  caps?: { minLetters?: number; maxPercent?: number } | null;
  /** maxRun 3..50 (default 6). */
  repeats?: { maxRun?: number } | null;
  /** max 1..50 (default 8). */
  emoji?: { max?: number } | null;
  /** max 1..20 (default 3). */
  mentions?: { max?: number } | null;
}

/** @experimental */
export interface ResolvedLinks {
  action: FilterAction;
  rule: number;
  /** Lowercased; a leading `=` is kept. */
  allow: string[];
  deny: string[];
  unlisted: 'act' | 'allow';
  invites: boolean;
  shorteners: boolean;
  newAccountDays: number | null;
}

/** @experimental */
export interface ResolvedPersonalInfo {
  action: FilterAction;
  rule: number;
  kinds: PersonalKind[];
  phone: 'formatted' | 'any';
  address: 'count' | 'flag' | null;
}

/** @experimental */
export interface ResolvedPhraseRule {
  id: string;
  label: string;
  action: FilterAction;
  rule: number;
  phrases: string[];
}

/** @experimental */
export interface ResolvedRatio {
  action: FilterAction;
  rule: number;
  caps: { minLetters: number; maxPercent: number } | null;
  repeats: { maxRun: number } | null;
  emoji: { max: number } | null;
  mentions: { max: number } | null;
}

/**
 * What the kit reads: every field filled in. `links`, `personalInfo` and `ratio` are `null` when off; `phrases` is `[]` when none.
 * @experimental
 */
export interface ResolvedFilters {
  links: ResolvedLinks | null;
  personalInfo: ResolvedPersonalInfo | null;
  phrases: ResolvedPhraseRule[];
  ratio: ResolvedRatio | null;
  ignore: string[];
  flagCapPerDay: number;
}

/** A member-wise change for {@link overlayFilters}: a block's members are each optional (a room edits one member, not the whole block). */
export interface FilterPatch {
  links?: Partial<LinkSettings> | null;
  personalInfo?: Partial<PersonalInfoSettings> | null;
  phrases?: PhraseRuleSettings[];
  ratio?: Partial<RatioSettings> | null;
  ignore?: string[];
  flagCapPerDay?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading values safely

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** An own, defined value, read once: a key left out, `undefined` and an inherited property all read as "not given". */
function given(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** `o` must be a plain object with no key outside `allowed`; a refusal names the key. */
function plain(o: unknown, allowed: readonly string[], path: string, what: string): Record<string, unknown> {
  if (!isPlain(o)) throw new ProfileError(path, what);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ProfileError(`${path}.${k}`, 'is not a known setting');
  return o;
}

function whole(v: unknown, lo: number, hi: number, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < lo || v > hi) throw new ProfileError(path, `must be a whole number from ${lo} to ${hi}`);
  return v;
}

function list(v: unknown, max: number, path: string): unknown[] {
  if (!Array.isArray(v)) throw new ProfileError(path, 'must be a list');
  if (v.length > max) throw new ProfileError(path, `must have at most ${max} entries`);
  // A copy read once, so a getter or a proxy cannot change what was checked.
  return Array.from(v as unknown[]);
}

function actionOf(o: Record<string, unknown>, path: string, required: boolean): FilterAction | undefined {
  const v = given(o, 'action');
  if (v === undefined) {
    if (required) throw new ProfileError(`${path}.action`, 'is required: count, flag, mask or refuse');
    return undefined;
  }
  if (typeof v !== 'string' || !(FILTER_ACTIONS as readonly string[]).includes(v)) throw new ProfileError(`${path}.action`, 'must be count, flag, mask or refuse');
  return v as FilterAction;
}

function ruleOf(o: Record<string, unknown>, path: string): number | undefined {
  const v = given(o, 'rule');
  if (v === undefined) return undefined;
  return whole(v, 1, Number.MAX_SAFE_INTEGER, `${path}.rule`);
}

function boolOf(o: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const v = given(o, key);
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ProfileError(`${path}.${key}`, 'must be true or false');
  return v;
}

/** Copy `value` onto `out[key]` only when it was given. */
function put<T extends object>(out: T, key: string, value: unknown): void {
  if (value !== undefined) (out as Record<string, unknown>)[key] = value;
}

// ---------------------------------------------------------------------------------------------------------------
// Domains

const LABEL = /^[\p{L}\p{N}_-]+$/u;

/** One domain entry, normalised (NFKC, lowercase). `=name` is kept with its `=`. Never echoes the entry. */
function domainOf(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 300) throw new ProfileError(path, 'must be a domain name such as example.com');
  const exact = v.startsWith('=');
  const body = (exact ? v.slice(1) : v).normalize('NFKC').toLowerCase();
  if (body.length === 0 || body.length > 253) throw new ProfileError(path, 'must be a domain name such as example.com');
  const labels = body.split('.');
  if (!exact && labels.length < 2) throw new ProfileError(path, 'must have at least two parts such as example.com (start it with = to match one host exactly)');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63 || !LABEL.test(label)) {
      throw new ProfileError(path, 'must be a plain domain name: letters, digits and hyphens, no scheme, path, port, space or wildcard');
    }
  }
  return exact ? `=${body}` : body;
}

const bare = (entry: string): string => (entry.startsWith('=') ? entry.slice(1) : entry);

function domainList(v: unknown, path: string, shared: boolean): string[] {
  const out = list(v, FILTER_LIMITS.domains, path).map((entry, i) => {
    const at = `${path}[${i}]`;
    const d = domainOf(entry, at);
    // Allowing a suffix where anyone can publish a page would allow every user's page.
    if (shared && !d.startsWith('=') && SHARED_HOSTING_SUFFIXES.includes(d)) {
      throw new ProfileError(at, 'is a shared hosting domain where anyone can publish: allow one page by writing =name.example instead');
    }
    return d;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Checking (sparse, normalised, shares nothing with the input)

const LINK_KEYS = ['action', 'rule', 'allow', 'deny', 'unlisted', 'invites', 'shorteners', 'newAccountDays'] as const;
const PERSONAL_KEYS = ['action', 'rule', 'kinds', 'phone', 'address'] as const;
const PHRASE_KEYS = ['id', 'label', 'action', 'rule', 'phrases'] as const;
const RATIO_KEYS = ['action', 'rule', 'caps', 'repeats', 'emoji', 'mentions'] as const;
const FILTER_KEYS = ['links', 'personalInfo', 'phrases', 'ratio', 'ignore', 'flagCapPerDay'] as const;
const PHRASE_ID = /^[a-z][a-z0-9_-]{0,31}$/;

function checkLinks(input: unknown, path: string, requireAction: boolean): Partial<ResolvedLinks> {
  const o = plain(input, LINK_KEYS, path, 'must be an object or null');
  const out: Partial<ResolvedLinks> = {};
  put(out, 'action', actionOf(o, path, requireAction));
  put(out, 'rule', ruleOf(o, path));
  const allow = given(o, 'allow');
  const deny = given(o, 'deny');
  if (allow !== undefined) out.allow = domainList(allow, `${path}.allow`, true);
  if (deny !== undefined) out.deny = domainList(deny, `${path}.deny`, false);
  if (out.allow !== undefined && out.deny !== undefined) {
    const denied = new Set(out.deny.map(bare));
    out.allow.forEach((entry, i) => {
      if (denied.has(bare(entry))) throw new ProfileError(`${path}.allow[${i}]`, 'is also on the deny list');
    });
  }
  const unlisted = given(o, 'unlisted');
  if (unlisted !== undefined) {
    if (unlisted !== 'act' && unlisted !== 'allow') throw new ProfileError(`${path}.unlisted`, "must be 'act' or 'allow'");
    out.unlisted = unlisted;
  }
  put(out, 'invites', boolOf(o, 'invites', path));
  put(out, 'shorteners', boolOf(o, 'shorteners', path));
  const days = given(o, 'newAccountDays');
  if (days !== undefined) out.newAccountDays = days === null ? null : whole(days, 1, FILTER_LIMITS.newAccountDaysMax, `${path}.newAccountDays`);
  return out;
}

function checkPersonal(input: unknown, path: string, requireAction: boolean): Partial<ResolvedPersonalInfo> {
  const o = plain(input, PERSONAL_KEYS, path, 'must be an object or null');
  const out: Partial<ResolvedPersonalInfo> = {};
  put(out, 'action', actionOf(o, path, requireAction));
  put(out, 'rule', ruleOf(o, path));
  const kinds = given(o, 'kinds');
  if (kinds !== undefined) {
    const items = list(kinds, PERSONAL_KINDS.length, `${path}.kinds`);
    if (items.length === 0) throw new ProfileError(`${path}.kinds`, 'must list at least one kind: phone, email, card or contact');
    const seen = new Set<string>();
    out.kinds = items.map((k, i) => {
      if (typeof k !== 'string' || !(PERSONAL_KINDS as readonly string[]).includes(k)) throw new ProfileError(`${path}.kinds[${i}]`, 'must be phone, email, card or contact');
      if (seen.has(k)) throw new ProfileError(`${path}.kinds[${i}]`, 'is listed twice');
      seen.add(k);
      return k as PersonalKind;
    });
  }
  const phone = given(o, 'phone');
  if (phone !== undefined) {
    if (phone !== 'formatted' && phone !== 'any') throw new ProfileError(`${path}.phone`, "must be 'formatted' or 'any'");
    out.phone = phone;
  }
  const address = given(o, 'address');
  if (address !== undefined) {
    if (address !== null && address !== 'count' && address !== 'flag') throw new ProfileError(`${path}.address`, "must be 'count', 'flag' or null: an address heuristic never hides or refuses a line");
    out.address = address;
  }
  return out;
}

function checkPhrases(input: unknown, path: string): ResolvedPhraseRule[] {
  const items = list(input, FILTER_LIMITS.rules, path);
  const ids = new Set<string>();
  let total = 0;
  return items.map((item, i) => {
    const rp = `${path}[${i}]`;
    const o = plain(item, PHRASE_KEYS, rp, 'must be an object');
    const id = given(o, 'id');
    if (typeof id !== 'string' || !PHRASE_ID.test(id)) throw new ProfileError(`${rp}.id`, 'must be 1 to 32 characters: a lowercase letter, then lowercase letters, digits, - or _');
    if (ids.has(id)) throw new ProfileError(`${rp}.id`, 'is used by another rule');
    ids.add(id);
    const label = given(o, 'label');
    if (label !== undefined && (typeof label !== 'string' || label.trim().length === 0 || label.length > FILTER_LIMITS.labelChars)) {
      throw new ProfileError(`${rp}.label`, `must be 1 to ${FILTER_LIMITS.labelChars} characters`);
    }
    const action = actionOf(o, rp, true) as FilterAction;
    const rule = ruleOf(o, rp);
    const raw = given(o, 'phrases');
    if (raw === undefined) throw new ProfileError(`${rp}.phrases`, 'is required: a list of 1 to 100 patterns');
    const patterns = list(raw, FILTER_LIMITS.patternsPerRule, `${rp}.phrases`);
    if (patterns.length === 0) throw new ProfileError(`${rp}.phrases`, 'must list at least one pattern');
    total += patterns.length;
    if (total > FILTER_LIMITS.patternsTotal) throw new ProfileError(`${rp}.phrases`, `has too many patterns: at most ${FILTER_LIMITS.patternsTotal} in all`);
    const clean = patterns.map((p, j) => {
      const parsed = parsePattern(p);
      if (!parsed.ok) throw new ProfileError(`${rp}.phrases[${j}]`, parsed.reason);
      return (p as string).trim();
    });
    return { id, label: label === undefined ? id : (label as string), action, rule: rule ?? FILTER_RULE_DEFAULTS.phrases, phrases: clean };
  });
}

function checkRatio(input: unknown, path: string, requireAction: boolean): Partial<ResolvedRatio> {
  const o = plain(input, RATIO_KEYS, path, 'must be an object or null');
  const out: Partial<ResolvedRatio> = {};
  put(out, 'action', actionOf(o, path, requireAction));
  put(out, 'rule', ruleOf(o, path));
  const sub = (key: 'caps' | 'repeats' | 'emoji' | 'mentions', keys: readonly string[], ranges: Record<string, [number, number]>): void => {
    const v = given(o, key);
    if (v === undefined) return;
    if (v === null) {
      (out as Record<string, unknown>)[key] = null;
      return;
    }
    const sp = `${path}.${key}`;
    const s = plain(v, keys, sp, 'must be an object or null');
    const clean: Record<string, number> = {};
    for (const k of keys) {
      const n = given(s, k);
      if (n !== undefined) clean[k] = whole(n, ranges[k]![0], ranges[k]![1], `${sp}.${k}`);
    }
    (out as Record<string, unknown>)[key] = clean;
  };
  sub('caps', ['minLetters', 'maxPercent'], { minLetters: [8, 200], maxPercent: [50, 100] });
  sub('repeats', ['maxRun'], { maxRun: [3, 50] });
  sub('emoji', ['max'], { max: [1, 50] });
  sub('mentions', ['max'], { max: [1, 20] });
  return out;
}

function checkIgnore(input: unknown, path: string): string[] {
  return list(input, FILTER_LIMITS.ignoreEntries, path).map((entry, i) => {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > FILTER_LIMITS.ignoreChars) {
      throw new ProfileError(`${path}[${i}]`, `must be 1 to ${FILTER_LIMITS.ignoreChars} characters`);
    }
    return lowerKeepLength(entry);
  });
}

/** What {@link checked} returns: the settings given, validated and normalised, with the blocks as partial resolved objects. */
interface Sparse {
  links?: Partial<ResolvedLinks> | null;
  personalInfo?: Partial<ResolvedPersonalInfo> | null;
  phrases?: ResolvedPhraseRule[];
  ratio?: Partial<ResolvedRatio> | null;
  ignore?: string[];
  flagCapPerDay?: number;
}

function checked(input: unknown, path: string, requireAction = true): Sparse {
  const o = plain(input, FILTER_KEYS, path, 'must be an object');
  const out: Sparse = {};
  const links = given(o, 'links');
  if (links !== undefined) out.links = links === null ? null : checkLinks(links, `${path}.links`, requireAction);
  const personal = given(o, 'personalInfo');
  if (personal !== undefined) out.personalInfo = personal === null ? null : checkPersonal(personal, `${path}.personalInfo`, requireAction);
  const phrases = given(o, 'phrases');
  if (phrases !== undefined) out.phrases = checkPhrases(phrases, `${path}.phrases`);
  const ratio = given(o, 'ratio');
  if (ratio !== undefined) out.ratio = ratio === null ? null : checkRatio(ratio, `${path}.ratio`, requireAction);
  const ignore = given(o, 'ignore');
  if (ignore !== undefined) out.ignore = checkIgnore(ignore, `${path}.ignore`);
  const cap = given(o, 'flagCapPerDay');
  if (cap !== undefined) out.flagCapPerDay = whole(cap, FILTER_LIMITS.flagCapMin, FILTER_LIMITS.flagCapMax, `${path}.flagCapPerDay`);
  return out;
}

/**
 * Check the shape and ranges of `input` and return what is set, as a new object that shares nothing with it: a key is present only when
 * it was given a value (`null` included), and each value was read from `input` exactly once. Throws ProfileError.
 * @experimental
 */
export function checkFilters(input: FilterSettings, path = 'filters'): FilterSettings {
  const s = checked(input, path);
  const out: FilterSettings = {};
  // The blocks come back as the members that were given, not filled in (a caller that keeps an override keeps what was said).
  if (s.links !== undefined) out.links = s.links as LinkSettings | null;
  if (s.personalInfo !== undefined) out.personalInfo = s.personalInfo as PersonalInfoSettings | null;
  if (s.phrases !== undefined) out.phrases = s.phrases.map((r) => ({ ...r, phrases: [...r.phrases] }));
  if (s.ratio !== undefined) out.ratio = s.ratio as RatioSettings | null;
  if (s.ignore !== undefined) out.ignore = [...s.ignore];
  if (s.flagCapPerDay !== undefined) out.flagCapPerDay = s.flagCapPerDay;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Filling

function fillLinks(s: Partial<ResolvedLinks>): ResolvedLinks {
  return {
    action: s.action as FilterAction,
    rule: s.rule ?? FILTER_RULE_DEFAULTS.links,
    allow: [...(s.allow ?? [])],
    deny: [...(s.deny ?? [])],
    unlisted: s.unlisted ?? 'act',
    invites: s.invites ?? true,
    shorteners: s.shorteners ?? true,
    newAccountDays: s.newAccountDays ?? null,
  };
}

function fillPersonal(s: Partial<ResolvedPersonalInfo>): ResolvedPersonalInfo {
  return {
    action: s.action as FilterAction,
    rule: s.rule ?? FILTER_RULE_DEFAULTS.personalInfo,
    kinds: [...(s.kinds ?? PERSONAL_KINDS)],
    phone: s.phone ?? 'formatted',
    address: s.address ?? null,
  };
}

/** A ratio check left out is on with its defaults; `null` is off. */
function fillRatio(s: Partial<ResolvedRatio>): ResolvedRatio {
  const d = RATIO_DEFAULTS;
  return {
    action: s.action as FilterAction,
    rule: s.rule ?? FILTER_RULE_DEFAULTS.ratio,
    caps: s.caps === null ? null : { minLetters: s.caps?.minLetters ?? d.caps.minLetters, maxPercent: s.caps?.maxPercent ?? d.caps.maxPercent },
    repeats: s.repeats === null ? null : { maxRun: s.repeats?.maxRun ?? d.repeats.maxRun },
    emoji: s.emoji === null ? null : { max: s.emoji?.max ?? d.emoji.max },
    mentions: s.mentions === null ? null : { max: s.mentions?.max ?? d.mentions.max },
  };
}

const clonePhrases = (rules: readonly ResolvedPhraseRule[]): ResolvedPhraseRule[] => rules.map((r) => ({ ...r, phrases: [...r.phrases] }));

function fill(s: Sparse): ResolvedFilters {
  return {
    links: s.links === undefined || s.links === null ? null : fillLinks(s.links),
    personalInfo: s.personalInfo === undefined || s.personalInfo === null ? null : fillPersonal(s.personalInfo),
    phrases: clonePhrases(s.phrases ?? []),
    ratio: s.ratio === undefined || s.ratio === null ? null : fillRatio(s.ratio),
    ignore: [...(s.ignore ?? [])],
    flagCapPerDay: s.flagCapPerDay ?? FILTER_LIMITS.flagCapDefault,
  };
}

/**
 * Validate and fill. Throws ProfileError naming the field (`filters.links.allow[3]`), never echoing the value. `path` names the settings
 * in the error (default `filters`). The result is a new object that shares nothing with the input.
 * @experimental
 */
export function resolveFilters(input: FilterSettings | undefined, path = 'filters'): ResolvedFilters {
  return input === undefined ? fill({}) : fill(checked(input, path));
}

/** A copy of resolved filters that shares nothing with `r`. */
function cloneResolved(r: ResolvedFilters): ResolvedFilters {
  return {
    links: r.links === null ? null : fillLinks(r.links),
    personalInfo: r.personalInfo === null ? null : fillPersonal(r.personalInfo),
    phrases: clonePhrases(r.phrases),
    ratio: r.ratio === null ? null : fillRatio(r.ratio),
    ignore: [...r.ignore],
    flagCapPerDay: r.flagCapPerDay,
  };
}

/**
 * `over` on top of `base`: a field left out inherits, `null` turns a block off, a block or a list that is given replaces the base's whole
 * (never merged by member). `over` is validated (a ProfileError with the path). Neither argument is changed or shared with the result.
 * @experimental
 */
export function mergeFilters(base: ResolvedFilters, over: FilterSettings, path = 'filters'): ResolvedFilters {
  const set = checked(over, path);
  const out = cloneResolved(base);
  if (set.links !== undefined) out.links = set.links === null ? null : fillLinks(set.links);
  if (set.personalInfo !== undefined) out.personalInfo = set.personalInfo === null ? null : fillPersonal(set.personalInfo);
  if (set.phrases !== undefined) out.phrases = clonePhrases(set.phrases);
  if (set.ratio !== undefined) out.ratio = set.ratio === null ? null : fillRatio(set.ratio);
  if (set.ignore !== undefined) out.ignore = [...set.ignore];
  if (set.flagCapPerDay !== undefined) out.flagCapPerDay = set.flagCapPerDay;
  return out;
}

/**
 * A room's own view: `patch` laid over `base` member by member (a room that wants "links off for new guests" sets one member, not the
 * whole block). A patch on a block that is off leaves it off unless the patch names an `action`; `null` turns a block off; lists replace
 * whole. Validated like any setting; neither argument is changed or shared with the result.
 * @experimental
 */
export function overlayFilters(base: ResolvedFilters, patch: FilterPatch, path = 'filters'): ResolvedFilters {
  const set = checked(patch, path, false);
  const out = cloneResolved(base);
  if (set.links !== undefined) {
    if (set.links === null) out.links = null;
    else if (out.links !== null || set.links.action !== undefined) out.links = fillLinks(checkLinks({ ...(out.links ?? {}), ...set.links }, `${path}.links`, true));
  }
  if (set.personalInfo !== undefined) {
    if (set.personalInfo === null) out.personalInfo = null;
    else if (out.personalInfo !== null || set.personalInfo.action !== undefined) {
      out.personalInfo = fillPersonal(checkPersonal({ ...(out.personalInfo ?? {}), ...set.personalInfo }, `${path}.personalInfo`, true));
    }
  }
  if (set.ratio !== undefined) {
    if (set.ratio === null) out.ratio = null;
    else if (out.ratio !== null || set.ratio.action !== undefined) out.ratio = fillRatio(checkRatio({ ...(out.ratio ?? {}), ...set.ratio }, `${path}.ratio`, true));
  }
  if (set.phrases !== undefined) out.phrases = clonePhrases(set.phrases);
  if (set.ignore !== undefined) out.ignore = [...set.ignore];
  if (set.flagCapPerDay !== undefined) out.flagCapPerDay = set.flagCapPerDay;
  return out;
}

/** Is any block on? When none is, the chat path builds nothing for filters. */
export function filtersActive(f: ResolvedFilters): boolean {
  return f.links !== null || f.personalInfo !== null || f.ratio !== null || f.phrases.length > 0;
}

/** Every Community Rule number the filters cite, with the path that names it (for the check against the rules in force). */
export function filterRulePaths(f: ResolvedFilters, path = 'filters'): Array<{ path: string; rule: number }> {
  const out: Array<{ path: string; rule: number }> = [];
  if (f.links !== null) out.push({ path: `${path}.links.rule`, rule: f.links.rule });
  if (f.personalInfo !== null) out.push({ path: `${path}.personalInfo.rule`, rule: f.personalInfo.rule });
  f.phrases.forEach((p, i) => out.push({ path: `${path}.phrases[${i}].rule`, rule: p.rule }));
  if (f.ratio !== null) out.push({ path: `${path}.ratio.rule`, rule: f.ratio.rule });
  return out;
}

/** Throws ProfileError naming the first rule that is not active, as `autoRestrictRule` is checked at creation. */
export function checkFilterRules(f: ResolvedFilters, isActive: (rule: number) => boolean, path = 'filters'): void {
  for (const r of filterRulePaths(f, path)) {
    if (!isActive(r.rule)) throw new ProfileError(r.path, 'must be the number of an active Community Rule');
  }
}

/**
 * Values the hub offers behind "Use suggested values". Never applied by themselves. `rmt` is a template the owner edits.
 * @experimental
 */
export const FILTER_SUGGESTIONS: Readonly<Record<'relaxed' | 'standard' | 'strict' | 'rmt', FilterSettings>> = deepFreeze({
  relaxed: {},
  standard: { links: { action: 'flag' }, personalInfo: { action: 'mask' } },
  strict: { links: { action: 'refuse' }, personalInfo: { action: 'mask' }, ratio: { action: 'mask' } },
  rmt: {
    phrases: [
      {
        id: 'rmt',
        label: 'Selling gold and accounts',
        action: 'flag',
        // Two patterns: the whole list in one would be over the 80 character limit.
        phrases: ['buy|sell|selling|buying|cheap ~ gold|gp|coins|accounts', 'buy|sell|selling|buying|cheap ~ boost|boosting|powerleveling'],
      },
    ],
  },
});

export { SHARED_HOSTING_SUFFIXES };
