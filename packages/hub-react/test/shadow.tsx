import { render, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Hub } from '../src/Hub.js';
import type { HubProps } from '../src/Hub.js';
import { HubProvider } from '../src/provider.js';
import type { HubProviderOptions } from '../src/provider.js';
import { memoryRouter } from '../src/router.js';
import type { HubWorld } from './world.js';

// Mounts like an adopter who puts the hub (or a piece) in a shadow root of their own: Testing Library's `screen` looks at the
// document, which is exactly where nothing of the hub is, so everything here goes through the shadow root.

const hosts: HTMLElement[] = [];

/** A shadow root on a new element in `parent` (default: the page's body). Removed after each test by `removeShadowHosts`. */
export function shadowRootIn(parent: ParentNode = document.body): ShadowRoot {
  const host = document.createElement('div');
  parent.append(host);
  hosts.push(host);
  return host.attachShadow({ mode: 'open' });
}

export function removeShadowHosts(): void {
  for (const host of hosts.splice(0)) host.remove();
}

/** Renders `ui` in a container inside `shadow` (a new shadow root on the page, unless one is given). */
export function renderInShadow(ui: ReactNode, shadow: ShadowRoot = shadowRootIn()) {
  const container = document.createElement('div');
  shadow.append(container);
  const utils = render(ui, { container });
  return { ...utils, shadow, container, q: within(container), user: userEvent.setup() };
}

export function hubInShadow(w: HubWorld, options: Partial<Omit<HubProps, 'client'>> & { shadow?: ShadowRoot; path?: string } = {}) {
  const { shadow, path, ...props } = options;
  const router = props.router ?? memoryRouter(path ?? '/');
  return { router, ...renderInShadow(<Hub client={w.client} router={router} now={w.now} mode="detailed" {...props} />, shadow) };
}

export function piecesInShadow(w: HubWorld, ui: ReactNode, options: HubProviderOptions & { shadow?: ShadowRoot } = {}) {
  const { shadow, ...rest } = options;
  return renderInShadow(
    <HubProvider client={w.client} now={w.now} mode="detailed" {...rest}>
      {ui}
    </HubProvider>,
    shadow,
  );
}

/** The element that has focus inside `shadow` (null when focus is elsewhere). */
export const focusedIn = (shadow: ShadowRoot): Element | null => shadow.activeElement;
