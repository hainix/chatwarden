// Prices as integer micro-dollars per million tokens, so a cost is exact integer arithmetic until the last division: $0.10 per
// million tokens is 100 000 micro-dollars per million. Claude Haiku 5.5 (`claude-haiku-5-5`), for prompts of 100K tokens or fewer,
// as in the design note (section 7). Check the live pricing page before you rely on the numbers; they change.

/** What one million tokens of each kind cost, in micro-dollars (1 = $0.000001). */
export interface PriceTable {
  inputPerMTok: number;
  outputPerMTok: number;
  /** A 5-minute cache write (1.25x input). */
  cacheWrite5mPerMTok: number;
  /** A 1-hour cache write (2x input). */
  cacheWrite1hPerMTok: number;
  /** A cache read (0.1x input). */
  cacheReadPerMTok: number;
}

export const HAIKU_5_5_PRICES: PriceTable = Object.freeze({
  inputPerMTok: 100_000,
  outputPerMTok: 500_000,
  cacheWrite5mPerMTok: 125_000,
  cacheWrite1hPerMTok: 200_000,
  cacheReadPerMTok: 10_000,
});

/** Token counts of one call, split the way they are priced. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** The cost of one call in whole micro-dollars (rounded to the nearest). */
export function costMicros(t: TokenCounts, prices: PriceTable): number {
  const total =
    t.input * prices.inputPerMTok +
    t.output * prices.outputPerMTok +
    t.cacheRead * prices.cacheReadPerMTok +
    t.cacheWrite5m * prices.cacheWrite5mPerMTok +
    t.cacheWrite1h * prices.cacheWrite1hPerMTok;
  return Math.round(total / 1_000_000);
}
