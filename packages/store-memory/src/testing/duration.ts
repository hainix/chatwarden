// A length of time for a script or a clock: a number of milliseconds, or a short string. Nothing here reads a clock.

/**
 * A number of milliseconds, or a string: `'250ms'`, `'5s'`, `'30m'`, `'2h'` or `'7d'` (a decimal is allowed: `'1.5s'`). Anything else is a `RangeError`.
 * @experimental
 */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`;

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const MESSAGE = 'A duration is a number of milliseconds or a string such as 250ms, 10s, 30m, 2h or 7d.';

/**
 * The milliseconds in a {@link Duration}, as a whole number (a fraction of a millisecond rounds). Throws a `RangeError` for a value that is not one:
 * negative, not finite, too large to count exactly, or a string that is not a number and a unit. The message is fixed text: it never echoes the value.
 * @experimental
 */
export function durationMs(d: Duration): number {
  let ms: number;
  if (typeof d === 'number') {
    ms = d;
  } else if (typeof d === 'string') {
    const parsed = PATTERN.exec(d);
    if (parsed === null) throw new RangeError(MESSAGE);
    ms = Number(parsed[1]) * UNITS[parsed[2] as keyof typeof UNITS];
  } else {
    throw new RangeError(MESSAGE);
  }
  const whole = Math.round(ms);
  if (!Number.isFinite(ms) || ms < 0 || !Number.isSafeInteger(whole)) throw new RangeError(MESSAGE);
  return whole;
}
