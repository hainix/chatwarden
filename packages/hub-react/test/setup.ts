import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
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

// The settings and admin screens load on demand: the first time a test file opens one, its code is fetched and compiled, which on a
// busy machine (a whole package running in parallel) can take longer than Testing Library's one second. A longer wait costs nothing
// when the screen is there in time; it only keeps a loaded machine from failing a test that is right.
configure({ asyncUtilTimeout: 5000 });
