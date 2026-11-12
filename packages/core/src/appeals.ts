import { ProfileError } from './profileError.js';

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
