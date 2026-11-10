import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without globals, so Testing Library cannot register its own cleanup: unmount between tests here.
afterEach(() => {
  cleanup();
});

// axe probes <canvas> for colour work; jsdom does not implement it and logs a "not implemented" error each time. (A few test
// files run in the node environment, where there is no canvas to stub.)
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
}
