import { expect } from 'vitest';
import { routerTransport } from '@chatwarden/hub-react';
import { waitFor, within } from '@testing-library/dom';
import { defineChatwardenHub } from '../src/index.js';
import type { ChatwardenHubElement } from '../src/index.js';
import type { HubWorld } from './world.js';

// Test helpers: mount the element the way a page does, and reach inside its shadow root (Testing Library's `screen` looks at the
// page, which is exactly where the hub must not be).

export const TAG = 'chatwarden-hub';

/** An element on the page, with attributes, and (before it connects) properties. Registers the default tag once. */
export function mount(attrs: Record<string, string> = {}, props: { client?: ChatwardenHubElement['client']; t?: ChatwardenHubElement['t'] } = {}): ChatwardenHubElement {
  defineChatwardenHub();
  const el = document.createElement(TAG) as ChatwardenHubElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (props.client !== undefined) el.client = props.client;
  if (props.t !== undefined) el.t = props.t;
  document.body.append(el);
  return el;
}

/** Queries inside the element's shadow root. */
export function inside(el: Element) {
  if (el.shadowRoot === null) throw new Error('the element has no open shadow root');
  // The element draws its hub inside one <div> in the shadow root; Testing Library wants an element, not the root itself.
  const container = [...el.shadowRoot.children].find((c) => c.tagName === 'DIV');
  if (container === undefined) throw new Error('the element has not drawn yet');
  return within(container as HTMLElement);
}

/** The hub has shown its first screen (it asked who is signed in and drew the top bar). */
export async function hubShown(el: Element): Promise<void> {
  await waitFor(() => expect(el.shadowRoot?.querySelector('.cw-body')).not.toBeNull(), { timeout: 5000 });
}

export interface FetchCall {
  url: string;
  method: string;
  keepalive: boolean;
  body: unknown;
}

/** A `fetch` that answers from the real staff routes mounted at `prefix`, and keeps what it was asked. */
export function fetchFor(w: HubWorld, prefix = '/admin') {
  const transport = routerTransport(w.handle);
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://page.test');
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url: url.pathname + url.search, method: init.method ?? 'GET', keepalive: init.keepalive === true, body });
    if (!url.pathname.startsWith(prefix)) return new Response('not found', { status: 404 });
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const res = await transport({ method: init.method ?? 'GET', path: url.pathname.slice(prefix.length), query, ...(body === undefined ? {} : { body }), ...(init.keepalive === true ? { keepalive: true } : {}) });
    return new Response(res.body === null ? null : JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

/** Moves the page's hash and lets the hash router hear it. */
export function goTo(path: string): void {
  window.location.hash = `#${path}`;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** The Undo window passes at once: the page hides, and a held decision is sent on the spot. */
export function pageHides(): void {
  window.dispatchEvent(new Event('pagehide'));
}

export const decides = (w: HubWorld) => w.sent.filter((r) => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path));
