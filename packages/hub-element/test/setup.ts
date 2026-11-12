import { afterEach } from 'vitest';
import { setGuardClock } from '../../hub-react/src/case/actGuard.js';

// Vitest runs without globals: take every element off the page, and the page back to a blank hash, between tests.
afterEach(async () => {
  // (The SSR test runs in Node, where there is no page to clean.)
  if (typeof document === 'undefined') return;
  document.body.replaceChildren();
  document.head.querySelectorAll('style').forEach((s) => s.remove());
  window.location.hash = '';
  // A disconnect unmounts in a microtask; let it finish before the next test starts.
  await Promise.resolve();
});

// axe and the hub probe <canvas>; jsdom does not implement it.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
}

// The hub's act guard turns away a quick key or a decision click on a case that appeared less than 300 ms ago, and these tests click the
// moment the hub has drawn. Every test here is about something else, so the guard's own clock (not the global `performance.now()`)
// reads a second later each time: a case is always old enough. The guard itself is tested in hub-react (act-guards, quick-actions).
let reads = 0;
const base = performance.now();
setGuardClock(() => base + ++reads * 1000);
