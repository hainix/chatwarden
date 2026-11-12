// The quick-key guard (a case accepts an act key a moment after it appeared) reads a monotonic clock, `performance.now()`, not the hub's
// `now`. Tests move it here: `advanceGuardTime(ms)` is "that long has passed on the machine", and the world's clock moving forward
// (`w.clock.t += 1000`, which every test already uses for "time passes") moves it too. A frozen hub clock does not freeze the guard.

// The clock is frozen at the moment a test file starts and moves only when a test moves it, so "299 ms after the case appeared" is exact.
let offset = 0;
const base = performance.now();
performance.now = () => base + offset;

/** Time passes on the monotonic clock. */
export function advanceGuardTime(ms: number): void {
  offset += ms;
}
