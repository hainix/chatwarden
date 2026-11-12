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
