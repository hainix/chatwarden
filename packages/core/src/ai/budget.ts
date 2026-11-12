// The spend cap and the call-rate cap (design section 4). The cap is over the UTC day and computed from the stored spend, so it
// survives a restart and is shared by every process on the store; the helpers here only name the day.

const DAY_MS = 24 * 3_600_000;

/** Epoch ms of 00:00 UTC on the day that holds `ms`. */
export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Epoch ms of the next 00:00 UTC after `ms`: when a day's cap resets. */
export function nextUtcMidnight(ms: number): number {
  return startOfUtcDay(ms) + DAY_MS;
}

/** The UTC day as `YYYY-MM-DD`. */
export function utcDayLabel(ms: number): string {
  return new Date(startOfUtcDay(ms)).toISOString().slice(0, 10);
}

/**
 * At most `limit` calls in any `windowMs` (the per-minute cap). In-memory: it guards a burst in this process; the daily spend cap is
 * what the store shares.
 */
export class CallWindow {
  private readonly at: number[] = [];

  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Take a slot at `now`; false (nothing taken) when the window is full. */
  tryTake(now: number): boolean {
    this.trim(now);
    if (this.at.length >= this.limit) return false;
    this.at.push(now);
    return true;
  }

  /** Whether a slot is free at `now`, taking none. */
  peek(now: number): boolean {
    this.trim(now);
    return this.at.length < this.limit;
  }

  /** When a slot is free: `now` if one is, else the moment the oldest call leaves the window. */
  nextFree(now: number): number {
    this.trim(now);
    return this.at.length < this.limit ? now : (this.at[0] as number) + this.windowMs;
  }

  /** Give back the slot taken at `now` (the call was not made after all). */
  giveBack(now: number): void {
    const i = this.at.lastIndexOf(now);
    if (i >= 0) this.at.splice(i, 1);
  }

  private trim(now: number): void {
    while (this.at.length > 0 && (this.at[0] as number) <= now - this.windowMs) this.at.shift();
  }
}
