import { render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Hub } from '../src/Hub.js';
import type { HubProps } from '../src/Hub.js';
import { memoryRouter } from '../src/router.js';
import type { HubWorld } from './world.js';

export interface RenderOptions extends Partial<Omit<HubProps, 'client'>> {
  /** The hub path to start on (default `/`). */
  path?: string;
}

/** Renders the hub over a test world, on a memory router and the world's clock. */
export function renderHub(w: HubWorld, options: RenderOptions = {}) {
  const { path, ...props } = options;
  const router = props.router ?? memoryRouter(path ?? '/');
  const user = userEvent.setup();
  const utils = render(<Hub client={w.client} router={router} now={w.now} mode="detailed" {...props} />);
  return { ...utils, user, router };
}
