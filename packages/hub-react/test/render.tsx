import { render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Hub } from '../src/Hub.js';
import type { HubProps } from '../src/Hub.js';
import { memoryRouter } from '../src/router.js';
import type { HubWorld } from './world.js';

export interface RenderOptions extends Partial<Omit<HubProps, 'client'>> {
  /** The hub path to start on (default `/`). */
  path?: string;
  /**
   * Put keyboard focus on the hub's root, as a click on its empty space would (default true). A hub answers keys only while focus is
   * inside it, so a test that presses shortcuts starts there. Pass false to start with focus on the page.
   */
  focus?: boolean;
}

/** The hub's root element: where a key press that the hub should hear is sent, and what has focus after a click on its empty space. */
export const hubRoot = (): HTMLElement => document.querySelector('.cw-hub') as HTMLElement;

/** Renders the hub over a test world, on a memory router and the world's clock. */
export function renderHub(w: HubWorld, options: RenderOptions = {}) {
  const { path, focus = true, ...props } = options;
  const router = props.router ?? memoryRouter(path ?? '/');
  const user = userEvent.setup();
  const utils = render(<Hub client={w.client} router={router} now={w.now} mode="detailed" {...props} />);
  if (focus) utils.container.querySelector<HTMLElement>('.cw-hub')?.focus();
  return { ...utils, user, router };
}
