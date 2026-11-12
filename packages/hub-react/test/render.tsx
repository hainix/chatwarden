import { render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Hub } from '../src/Hub.js';
import type { HubProps } from '../src/Hub.js';
import { memoryRouter } from '../src/router.js';
import type { MemoryRouter } from '../src/router.js';
import type { HubWorld } from './world.js';

export interface RenderOptions extends Partial<Omit<HubProps, 'client'>> {
  /** The hub path to start on (default `/`). */
  path?: string;
  /**
   * Ignore every navigation the hub makes by itself. A quick action moves on to the next case (or the team view); a test about the
   * decision on the case it started on keeps the page where it is, with the decision's own notice in the card's place.
   */
  stay?: boolean;
}

/** A memory router that ignores every navigation the hub makes by itself (see `stay`), for a test that mounts the hub some other way. */
export function stayingRouter(initial: string): MemoryRouter {
  return Object.assign(Object.create(memoryRouter(initial)) as MemoryRouter, { navigate: () => undefined });
}

/** Renders the hub over a test world, on a memory router and the world's clock. */
export function renderHub(w: HubWorld, options: RenderOptions = {}) {
  const { path, stay, router: given, ...props } = options;
  const base = given ?? memoryRouter(path ?? '/');
  const router = stay === true ? Object.assign(Object.create(base) as typeof base, { navigate: () => undefined }) : base;
  const user = userEvent.setup();
  const utils = render(<Hub client={w.client} router={router} now={w.now} mode="detailed" {...props} />);
  return { ...utils, user, router };
}
