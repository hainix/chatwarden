export const VERSION = '0.1.5';

import { ChatwardenHubElement } from './element.js';

export { ChatwardenHubElement } from './element.js';
export type { CwDecidedDetail, CwNavigateDetail } from './element.js';
export type { HubElementConfig } from './config.js';

/** The tag `defineChatwardenHub` registers when you give it none. */
export const DEFAULT_TAG = 'chatwarden-hub';

let baseUsed = false;

/**
 * Registers the hub element under `tagName` (default `chatwarden-hub`) and returns its class. Safe to call twice, and safe when a
 * script tag already registered it: a tag that is taken is left alone and what owns it is returned. An invalid tag name throws, as
 * `customElements.define` does. Where there is no custom element registry (a server), nothing is registered.
 */
export function defineChatwardenHub(tagName: string = DEFAULT_TAG): typeof ChatwardenHubElement {
  if (typeof customElements === 'undefined') return ChatwardenHubElement;
  const existing = customElements.get(tagName);
  if (existing !== undefined) return existing as typeof ChatwardenHubElement;
  // A class can be registered under one name only: the first name gets the class itself, any other gets a subclass.
  const cls = baseUsed ? class extends ChatwardenHubElement {} : ChatwardenHubElement;
  customElements.define(tagName, cls);
  baseUsed = true;
  return cls;
}

declare global {
  interface HTMLElementTagNameMap {
    'chatwarden-hub': ChatwardenHubElement;
  }
}
