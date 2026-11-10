import { MAX_LEN, RATE_LIMIT, RATE_WINDOW_MS } from './chat.js';
import { MAX_DURATION_MS, ProfileError } from './profile.js';
import type { DeepPartial } from './profile.js';
import { REPORTS_PER_DAY, SUSPEND_AFTER, SUSPEND_WINDOW_MS } from './reports.js';
import {
  REPEAT_LOOKBACK_MS,
  REPEAT_RESTRICT_MS,
  STRIKE_FIRST_RESTRICT_MS,
  STRIKE_WINDOW_MS,
  STRIKES_TO_RESTRICT,
} from './strikes.js';

/**
 * The numbers the kit enforces that are not part of a moderation profile: how long a chat line may be, how fast a
 * person may chat, when the slur filter times someone out, how many reports a person may file, and whether the
 * reporter hears the outcome. The defaults are the values Moxgate has always run with.
 */
export interface Limits {
  /** Longest chat line, in characters after trimming. Default 200. */
  chatMaxLength: number;
  /** Chat rate per `roomId:seatId`: at most `count` lines in any `windowMs`. Default 3 per 5 000 ms. */
  chatRate: { count: number; windowMs: number };
  /**
   * The automatic slur filter. `count` blocked lines inside `windowMs` earn a chat timeout of `firstMs`, or of
   * `repeatMs` when the person's previous automatic timeout started within `repeatLookbackMs`.
   * Default 3 inside 1 hour; 30 minutes; 24 hours; 7 days.
   */
  strikes: { count: number; windowMs: number; firstMs: number; repeatMs: number; repeatLookbackMs: number };
  /**
   * Reports. A person may file `perDay` in any 24 hours. `suspendAfter` reports dismissed as bad faith within
   * `suspendWindowMs` (counted from the decision) suspend them from reporting. Default 10, 3, 30 days.
   */
  reports: { perDay: number; suspendAfter: number; suspendWindowMs: number };
  /** Whether an upheld decision tells the person who reported ("action taken"). Default true. */
  reporterFeedback: boolean;
}

/** What you may pass as `limits`: any field, groups included (`{ strikes: { count: 2 } }` keeps the rest). */
export type LimitsInput = DeepPartial<Limits>;

function deepFreeze<T extends object>(value: T): T {
  for (const v of Object.values(value)) if (typeof v === 'object' && v !== null) deepFreeze(v);
  return Object.freeze(value);
}

/** The defaults, frozen. The service constants (`MAX_LEN`, `STRIKES_TO_RESTRICT`, ...) are these same numbers. */
export const LIMITS_DEFAULTS: Readonly<Limits> = deepFreeze({
  chatMaxLength: MAX_LEN,
  chatRate: { count: RATE_LIMIT, windowMs: RATE_WINDOW_MS },
  strikes: {
    count: STRIKES_TO_RESTRICT,
    windowMs: STRIKE_WINDOW_MS,
    firstMs: STRIKE_FIRST_RESTRICT_MS,
    repeatMs: REPEAT_RESTRICT_MS,
    repeatLookbackMs: REPEAT_LOOKBACK_MS,
  },
  reports: { perDay: REPORTS_PER_DAY, suspendAfter: SUSPEND_AFTER, suspendWindowMs: SUSPEND_WINDOW_MS },
  reporterFeedback: true,
} satisfies Limits);

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

type Check = (value: unknown, path: string) => unknown;

/** A nested group: checked even when not given, so the result never shares an object with the defaults. */
const nested = (check: Check): Check & { nested: true } => Object.assign(check, { nested: true as const });

/**
 * `input` with only known keys, each checked by its function. A scalar that is missing or `undefined` is "not
 * given" and takes the default.
 */
function group(
  input: unknown,
  path: string,
  fields: Record<string, Check>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  if (input === undefined) input = {};
  if (!isPlain(input)) throw new ProfileError(path, 'must be an object');
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(fields, key)) throw new ProfileError(`${path}.${key}`, 'is not a known setting');
  }
  const out: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(fields)) {
    const given = Object.hasOwn(input, key) ? input[key] : undefined;
    out[key] = given === undefined && !('nested' in check) ? defaults[key] : check(given, `${path}.${key}`);
  }
  return out;
}

const count = (v: unknown, path: string): number => {
  if (!positiveInt(v)) throw new ProfileError(path, 'must be a whole number above 0');
  return v;
};

const duration = (v: unknown, path: string): number => {
  if (!positiveInt(v) || v > MAX_DURATION_MS) {
    throw new ProfileError(path, 'must be a whole number of milliseconds above 0 and at most 365 days');
  }
  return v;
};

const flag = (v: unknown, path: string): boolean => {
  if (typeof v !== 'boolean') throw new ProfileError(path, 'must be true or false');
  return v;
};

/**
 * Merge `input` onto the defaults and validate the result: every number is a whole number above 0, every duration
 * is also at most 365 days, `reporterFeedback` is a boolean, and an unknown key at any depth is refused. Groups
 * merge key by key, so `{ strikes: { count: 2 } }` keeps the other strike settings.
 *
 * Throws {@link ProfileError} naming the field (`limits.strikes.count`); the message never echoes the value.
 * Returns a deep-frozen copy that shares nothing with the input or the defaults.
 */
export function resolveLimits(input?: LimitsInput): Limits {
  const d = LIMITS_DEFAULTS;
  const out = group(
    input,
    'limits',
    {
      chatMaxLength: count,
      chatRate: nested((v, p) => group(v, p, { count, windowMs: duration }, d.chatRate)),
      strikes: nested((v, p) =>
        group(
          v,
          p,
          { count, windowMs: duration, firstMs: duration, repeatMs: duration, repeatLookbackMs: duration },
          d.strikes,
        ),
      ),
      reports: nested((v, p) =>
        group(v, p, { perDay: count, suspendAfter: count, suspendWindowMs: duration }, d.reports),
      ),
      reporterFeedback: flag,
    },
    d as unknown as Record<string, unknown>,
  );
  return deepFreeze(out as unknown as Limits);
}
