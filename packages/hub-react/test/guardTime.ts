// The act guard (a case accepts an act key or a quick click only a moment after it appeared) reads a monotonic clock, `performance.now()`,
// not the hub's `now`. Two modes, per test file:
//
// - Default: every reading is a second later than the one before. Time has always passed since a case appeared, so a test about something
//   else (a decision, a form, a screen) can click and press keys the moment a card shows, as a person who has read it would.
// - Exact (`useExactGuardClock()`, for the files that are about the guard itself): the clock is frozen when the file starts and moves only
//   when a test moves it with `advanceGuardTime(ms)`, so "299 ms after the case appeared" is exact. The world's clock moving forward
//   (`w.clock.t += 1000`, which tests use for "time passes") moves it too. A frozen hub clock does not freeze the guard.

let exact = false;
let offset = 0;
let reads = 0;
const base = performance.now();
performance.now = () => base + offset + (exact ? 0 : ++reads * 1000);

/** The guard clock stands still until the test moves it (for the files that test the guard). */
export function useExactGuardClock(): void {
  exact = true;
}

/** Time passes on the monotonic clock. */
export function advanceGuardTime(ms: number): void {
  offset += ms;
}
