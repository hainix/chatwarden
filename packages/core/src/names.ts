import { ProfileError } from './profileError.js';

// The name settings: a second check (profanity), optional kept evidence, a way to require a rename, and whether the hub masks a name
// the matcher flags. Pure data and validation. Off until set, except `maskInHub`, which is on: it changes only what the hub shows.

/** Why a name was refused. `name_profane` needs `names.profanity`. @experimental */
export type NameReason = 'name_not_allowed' | 'name_profane';

/** The answer of `cw.names.check`: allowed, or a reason id and the Community Rule it cites; never the text. @experimental */
export type NameCheckResult = { ok: true } | { ok: false; reason: NameReason; rule: number };

const KEYS = ['profanity', 'keepBlocked', 'renames', 'maskInHub'] as const;

/**
 * How names are checked and shown. Every field is optional.
 * @experimental
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
}

/**
 * What the kit reads: every field filled in.
 * @experimental
 */
export interface ResolvedNames {
  profanity: boolean;
  keepBlocked: boolean;
  renames: boolean;
  maskInHub: boolean;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate and fill. Throws ProfileError naming the field (`names.keepBlocked`), never echoing the value. `path` names the settings in
 * the error (default `names`). The result is a new object that shares nothing with the input; each value is read from `input` once.
 * @experimental
 */
export function resolveNames(input: NameSettings | undefined, path = 'names'): ResolvedNames {
  const out: ResolvedNames = { profanity: false, keepBlocked: false, renames: false, maskInHub: true };
  if (input === undefined) return out;
  if (!isPlain(input)) throw new ProfileError(path, 'must be an object');
  for (const k of Object.keys(input)) if (!(KEYS as readonly string[]).includes(k)) throw new ProfileError(`${path}.${k}`, 'is not a known setting');
  for (const k of KEYS) {
    const v = Object.hasOwn(input, k) ? input[k] : undefined;
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw new ProfileError(`${path}.${k}`, 'must be true or false');
    out[k] = v;
  }
  return out;
}

/** The longest private reason a required rename takes, in characters (like a sanction's). */
export const RENAME_REASON_MAX = 500;

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
