import { afterEach } from 'vitest';

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
