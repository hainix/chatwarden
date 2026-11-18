import { ProfileError } from './profileError.js';

// The name settings: a second check (profanity), optional kept evidence, a way to require a rename, and whether the hub masks a name
// the matcher flags. Pure data and validation. Off until set, except `maskInHub`, which is on: it changes only what the hub shows.

/** Why a name was refused. `name_profane` needs `names.profanity`; `name_reserved` needs `names.reserved` and is the third reason, after the other two. */
export type NameReason = 'name_not_allowed' | 'name_profane' | 'name_reserved';

/** What a name is for: a `player` (a handle) or an `entity` (a clan, guild, team, deck, pet or item the player names). The checks are the same; the kind is the caller's word. */
export type NameKind = 'player' | 'entity';

/** The answer of `cw.names.check`: allowed, or a reason id and the Community Rule it cites; never the text. */
export type NameCheckResult = { ok: true } | { ok: false; reason: NameReason; rule: number };

const FLAGS = ['profanity', 'keepBlocked', 'renames', 'maskInHub'] as const;
const KEYS = [...FLAGS, 'reserved', 'reservedAllow', 'reservedRule'] as const;

/** The most entries in `names.reserved` and in `names.reservedAllow`. */
export const MAX_RESERVED_ENTRIES = 200;
/** The shortest and the longest entry of `names.reserved`, in characters (after trimming). */
export const NAME_ENTRY_MIN = 2;
export const NAME_ENTRY_MAX = 32;
/** The longest name of `names.reservedAllow`, in characters (after trimming). */
export const NAME_ALLOW_MAX = 64;
/** The Community Rule a reserved name cites unless the owner says another: CR 2, the one impersonation and personal info already map to. */
export const DEFAULT_RESERVED_RULE = 2;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * How names are checked and shown. Every field is optional.
 */
export interface NameSettings {
  /** Also refuse a name the profanity filter flags. Default false (a swear word is not a slur; this is for a family game). */
  profanity?: boolean;
  /** Keep a blocked name, with the term it hit, as evidence. Default false: a name check stores nothing. */
  keepBlocked?: boolean;
  /** May a moderator require a rename from the Person page? Default false. */
  renames?: boolean;
  /** Mask a name the matcher flags in the hub until a moderator shows it. Default true. */
  maskInHub?: boolean;
  /**
   * Protected names, for example `admin`, `moderator`, `game master`, or the first name a staff member plays under: at most 200 entries of 2 to 32 characters. A name that reads as one of them (by skeleton, as a whole word: `Mod_Anna`,
   * `M0derator`, `game master`; not `xXmodXx`) is refused `name_reserved`. Empty by default: nothing is reserved until the owner says so. Names only, never chat.
   */
  reserved?: readonly string[];
  /** Names that pass although they read as a reserved one (a real player called like staff): at most 200 exact names of 1 to 64 characters, compared whole by skeleton. Default none. */
  reservedAllow?: readonly string[];
  /** The Community Rule a reserved name cites: an active rule number. Default 2. */
  reservedRule?: number;
}

/**
 * What the kit reads: every field filled in.
 */
export interface ResolvedNames {
  profanity: boolean;
  keepBlocked: boolean;
  renames: boolean;
  maskInHub: boolean;
  /** The protected names, trimmed, an exact repeat dropped; a frozen list that stays the same object until the settings change. */
  reserved: readonly string[];
  /** The names that pass, as above. */
  reservedAllow: readonly string[];
  reservedRule: number;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate and fill. Throws ProfileError naming the field (`names.keepBlocked`), never echoing the value. `path` names the settings in
 * the error (default `names`). The result is a new object that shares nothing with the input; each value is read from `input` once.
 */
export function resolveNames(input: NameSettings | undefined, path = 'names'): ResolvedNames {
  const out: ResolvedNames = { profanity: false, keepBlocked: false, renames: false, maskInHub: true, reserved: Object.freeze([]), reservedAllow: Object.freeze([]), reservedRule: DEFAULT_RESERVED_RULE };
  if (input === undefined) return out;
  if (!isPlain(input)) throw new ProfileError(path, 'must be an object');
  for (const k of Object.keys(input)) if (!(KEYS as readonly string[]).includes(k)) throw new ProfileError(`${path}.${k}`, 'is not a known setting');
  for (const k of FLAGS) {
    const v = Object.hasOwn(input, k) ? input[k] : undefined;
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw new ProfileError(`${path}.${k}`, 'must be true or false');
    out[k] = v;
  }
  const reserved = Object.hasOwn(input, 'reserved') ? input['reserved'] : undefined;
  if (reserved !== undefined) out.reserved = nameList(reserved, `${path}.reserved`, NAME_ENTRY_MIN, NAME_ENTRY_MAX);
  const allow = Object.hasOwn(input, 'reservedAllow') ? input['reservedAllow'] : undefined;
  if (allow !== undefined) out.reservedAllow = nameList(allow, `${path}.reservedAllow`, 1, NAME_ALLOW_MAX);
  const rule = Object.hasOwn(input, 'reservedRule') ? input['reservedRule'] : undefined;
  if (rule !== undefined) {
    if (typeof rule !== 'number' || !Number.isSafeInteger(rule) || rule < 1) throw new ProfileError(`${path}.reservedRule`, 'must be a whole number from 1 (the number of an active Community Rule)');
    out.reservedRule = rule;
  }
  return out;
}

/** A list of names: at most {@link MAX_RESERVED_ENTRIES}, each text of `min` to `max` characters once trimmed with no control character. Returns a frozen copy, trimmed, an exact repeat dropped. Never echoes an entry. */
function nameList(v: unknown, path: string, min: number, max: number): readonly string[] {
  if (!Array.isArray(v)) throw new ProfileError(path, 'must be a list of names');
  if (v.length > MAX_RESERVED_ENTRIES) throw new ProfileError(path, `must hold at most ${MAX_RESERVED_ENTRIES} names`);
  const out: string[] = [];
  (v as unknown[]).forEach((item, i) => {
    if (typeof item !== 'string') throw new ProfileError(`${path}[${i}]`, 'must be text');
    const name = item.trim();
    if (name.length < min || name.length > max || CONTROL.test(name)) throw new ProfileError(`${path}[${i}]`, `must be ${min} to ${max} characters with no control character`);
    if (!out.includes(name)) out.push(name);
  });
  return Object.freeze(out);
}

/**
 * The reserved-name rule must be an active Community Rule (checked where the rules are known: at creation and when a layer is saved or previewed). Only when the setting is in use: a list is set, or the rule is not the default,
 * so a game whose own rules retire CR 2 and reserves nothing still starts. Throws ProfileError naming `${path}.reservedRule`.
 */
export function checkNameRules(n: ResolvedNames, isActive: (rule: number) => boolean, path = 'names'): void {
  if ((n.reserved.length > 0 || n.reservedRule !== DEFAULT_RESERVED_RULE) && !isActive(n.reservedRule)) {
    throw new ProfileError(`${path}.reservedRule`, 'must be the number of an active Community Rule');
  }
}

/** Most kept blocked names per person in an hour. */
export const NAME_EVIDENCE_PER_PERSON_HOUR = 5;
/** Most kept blocked names an hour, over everyone, in this process. */
export const NAME_EVIDENCE_PER_HOUR = 200;
/** The window both caps count over: a row leaves it exactly an hour after it was kept. */
export const NAME_EVIDENCE_WINDOW_MS = 3_600_000;
/** Most characters of a blocked name that are kept (a name is short; this bounds what a hostile caller can make the table hold). */
export const NAME_EVIDENCE_MAX_LENGTH = 200;

/** The name with underscores and digits turned into spaces: the second view the profanity filter reads (`big_snerp_99` is `big snerp  `). */
export function profanityView(name: string): string {
  return name.replace(/[_\p{Nd}]/gu, ' ');
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The copy of a blocked name that is kept: NUL removed, a lone surrogate (which a database would not round-trip) replaced by U+FFFD, cut to
 * {@link NAME_EVIDENCE_MAX_LENGTH} characters without leaving half an emoji. Only the first `2 * MAX` characters are even looked at.
 */
export function evidenceName(name: string): string {
  const head = name.slice(0, NAME_EVIDENCE_MAX_LENGTH * 2).replaceAll('\u0000', '').replace(LONE_SURROGATE, '\uFFFD');
  if (head.length <= NAME_EVIDENCE_MAX_LENGTH) return head;
  const cut = head.slice(0, NAME_EVIDENCE_MAX_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The hourly caps on kept blocked names: {@link NAME_EVIDENCE_PER_PERSON_HOUR} per key and {@link NAME_EVIDENCE_PER_HOUR} overall, in memory,
 * over a sliding window. A key is whatever the caller counts a person by. `allow` only asks; `record` counts a row that really was kept, so a
 * failed write never uses the cap. Holds at most 200 timestamps, however many names are probed. A time in the future (the clock moved back)
 * no longer counts.
 */
export class NameEvidenceLimiter {
  private all: number[] = [];
  private readonly by = new Map<string, number[]>();

  allow(key: string, now: number): boolean {
    this.all = this.all.filter((t) => live(t, now));
    if (this.all.length >= NAME_EVIDENCE_PER_HOUR) return false;
    const mine = (this.by.get(key) ?? []).filter((t) => live(t, now));
    return mine.length < NAME_EVIDENCE_PER_PERSON_HOUR;
  }

  record(key: string, now: number): void {
    this.all.push(now);
    for (const [k, stamps] of this.by) {
      const kept = stamps.filter((t) => live(t, now));
      if (kept.length === 0) this.by.delete(k);
      else this.by.set(k, kept);
    }
    this.by.set(key, [...(this.by.get(key) ?? []), now]);
  }
}

const live = (t: number, now: number): boolean => t <= now && now - t < NAME_EVIDENCE_WINDOW_MS;
