// The breaker (design section 4, "A breaker"). Five consecutive failures, or any `fatal`, stop new calls for five minutes; then
// ONE probe call decides: its success closes the breaker, its failure opens it for another five minutes. While it is open nothing is
// called. A refusal (`declined`) or an unusable answer (`invalid`) is an answer, so it counts as a success here: the provider is up.

/** Consecutive failures that open the breaker. */
export const BREAKER_THRESHOLD = 5;
/** How long an open breaker refuses calls before one probe is let through. */
export const BREAKER_OPEN_MS = 5 * 60_000;

/** Whether a call may be made now: freely, as the one probe, or not at all. */
export type BreakerGate = 'go' | 'probe' | 'no';

/** What the hub shows: `closed` is working, `open` and `half_open` are "unavailable". */
export type BreakerState = 'closed' | 'open' | 'half_open';

export class Breaker {
  private failures = 0;
  private openUntil: number | null = null;
  private probing = false;

  private readonly clock: { now(): number };

  constructor(clock: { now(): number }) {
    this.clock = clock;
  }

  /** Ask to make a call. A `probe` is handed out once; report its end with {@link success}, {@link failure} or {@link release}. */
  gate(): BreakerGate {
    if (this.openUntil === null) return 'go';
    if (this.clock.now() < this.openUntil) return 'no';
    if (this.probing) return 'no';
    this.probing = true;
    return 'probe';
  }

  /** Whether a call could go out now: closed, or half-open with the probe free. Takes nothing (see {@link gate}). */
  available(): boolean {
    if (this.openUntil === null) return true;
    return this.clock.now() >= this.openUntil && !this.probing;
  }

  state(): BreakerState {
    if (this.openUntil === null) return 'closed';
    return this.clock.now() < this.openUntil ? 'open' : 'half_open';
  }

  /** When an open breaker lets the probe through (epoch ms), or null when closed. */
  reopensAt(): number | null {
    return this.openUntil;
  }

  /** A call produced an answer (even a refusal or an unusable one). Closes the breaker. */
  success(): void {
    this.failures = 0;
    this.openUntil = null;
    this.probing = false;
  }

  /** A call failed. `fatal` opens at once; so does a failed probe and the fifth failure in a row. */
  failure(fatal = false): void {
    this.failures += 1;
    if (fatal || this.probing || this.failures >= BREAKER_THRESHOLD) {
      this.openUntil = this.clock.now() + BREAKER_OPEN_MS;
      this.failures = 0;
    }
    this.probing = false;
  }

  /** A probe was handed out but no call came of it (for example the budget stopped it): let the next ask be the probe. */
  release(): void {
    this.probing = false;
  }
}
