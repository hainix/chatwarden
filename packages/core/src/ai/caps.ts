import { AI_ACT_CAP_DEFAULTS } from './gates.js';

// The numbers of acting that are not gates (design 5.4): the caps, the hold before acting, the shadow period and the holdback share. Pure. Every one
// is a number in code, moved only inside its band (`ai.act.caps`); the hub cannot move any. A number outside its band throws at `createChatwarden`.

const H = 3_600_000;
const DAY = 24 * H;

/**
 * What `ai.act.caps` may set. Times are milliseconds.
 */
export interface AiActCaps {
  /** The most AI actions an hour for the whole instance. */
  perHour: number;
  /** The most AI actions in a UTC day for the whole instance. */
  perDay: number;
  /** The shortest time between two AI actions on the same person. */
  perPersonMs: number;
  /** An AI action not reviewed after this long pauses acting (review debt). */
  reviewWithinMs: number;
  /** More unreviewed AI actions than this pause acting (review debt). */
  reviewDebtMax: number;
  /** How long the AI waits after a report before it acts: it closes the reporter's follow-up window. */
  holdMs: number;
  /** The days of shadow before the owner may start acting. */
  shadowDays: number;
  /** The share of eligible cases held back for a person to decide, 0.1 to 0.5. */
  holdbackShare: number;
}

/**
 * The defaults of design 5.4. Frozen.
 */
export const AI_ACT_CAPS_DEFAULTS: Readonly<AiActCaps> = Object.freeze({
  perHour: AI_ACT_CAP_DEFAULTS.perHour,
  perDay: AI_ACT_CAP_DEFAULTS.perDay,
  perPersonMs: DAY,
  reviewWithinMs: AI_ACT_CAP_DEFAULTS.reviewWithinMs,
  reviewDebtMax: AI_ACT_CAP_DEFAULTS.reviewDebtMax,
  holdMs: 10 * 60_000,
  shadowDays: 14,
  holdbackShare: 0.2,
});

/**
 * The inclusive band of each number (design 5.4). Frozen.
 */
export const AI_ACT_CAPS_BANDS: Readonly<Record<keyof AiActCaps, Readonly<{ min: number; max: number }>>> = Object.freeze({
  perHour: Object.freeze({ min: 1, max: 60 }),
  perDay: Object.freeze({ min: 1, max: 500 }),
  perPersonMs: Object.freeze({ min: DAY, max: 7 * DAY }),
  reviewWithinMs: Object.freeze({ min: H, max: 7 * DAY }),
  reviewDebtMax: Object.freeze({ min: 1, max: 100 }),
  holdMs: Object.freeze({ min: 5 * 60_000, max: H }),
  shadowDays: Object.freeze({ min: 7, max: 60 }),
  holdbackShare: Object.freeze({ min: 0.1, max: 0.5 }),
});

const WHOLE: ReadonlySet<keyof AiActCaps> = new Set(['perHour', 'perDay', 'reviewDebtMax', 'shadowDays', 'perPersonMs', 'reviewWithinMs', 'holdMs']);

/**
 * Check a partial set of caps against the bands and fill it from the defaults. Throws a plain `RangeError` naming the field (never the value) for an
 * unknown field, a value that is not a finite number, a fraction in a whole-number field, or a number outside its band. An `undefined` field is the
 * default. The result is frozen and shares nothing with the input.
 */
export function checkActCaps(partial?: Partial<AiActCaps>): AiActCaps {
  const out: AiActCaps = { ...AI_ACT_CAPS_DEFAULTS };
  if (partial === undefined) return Object.freeze(out);
  if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) throw new TypeError('ai.act.caps must be an object');
  for (const key of Object.keys(partial)) {
    if (!Object.hasOwn(AI_ACT_CAPS_BANDS, key)) throw new RangeError(`ai.act.caps.${key} is not a cap`);
    const field = key as keyof AiActCaps;
    const v: unknown = partial[field];
    if (v === undefined) continue;
    const band = AI_ACT_CAPS_BANDS[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < band.min || v > band.max || (WHOLE.has(field) && !Number.isInteger(v))) {
      throw new RangeError(`ai.act.caps.${field} is outside its band`);
    }
    out[field] = v;
  }
  return Object.freeze(out);
}
