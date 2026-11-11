import { render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { HubProvider } from '../src/provider.js';
import type { HubProviderOptions } from '../src/provider.js';
import type { HubWorld } from './world.js';

// A piece on its own: no router, no shell. The provider is the only thing above it, on the world's clock.

export function renderPieces(w: HubWorld, ui: ReactNode, options: HubProviderOptions = {}) {
  const user = userEvent.setup();
  const utils = render(
    <HubProvider client={w.client} now={w.now} mode="detailed" {...options}>
      {ui}
    </HubProvider>,
  );
  return { ...utils, user };
}

/** Every address the page was moved to: pieces must never move it. */
export function watchNavigation(): { hash: () => string; pushed: () => number; restore: () => void } {
  const start = window.location.href;
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  let n = 0;
  history.pushState = (...a: Parameters<History['pushState']>) => {
    n += 1;
    push(...a);
  };
  history.replaceState = (...a: Parameters<History['replaceState']>) => {
    n += 1;
    replace(...a);
  };
  return {
    hash: () => window.location.hash,
    pushed: () => n + (window.location.href === start ? 0 : 1),
    restore: () => {
      history.pushState = push;
      history.replaceState = replace;
    },
  };
}
