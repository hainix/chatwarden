import { describe, expect, it } from 'vitest';
import { ChatwardenHubElement, defineChatwardenHub } from '../src/index.js';

// Registering the element: once, by default as <chatwarden-hub>, safe to do twice, and under another name for a page that
// already uses the default.

describe('defineChatwardenHub', () => {
  it('registers <chatwarden-hub> and returns the element class', () => {
    const cls = defineChatwardenHub();
    expect(customElements.get('chatwarden-hub')).toBe(cls);
    expect(cls).toBe(ChatwardenHubElement);
    expect(document.createElement('chatwarden-hub')).toBeInstanceOf(ChatwardenHubElement);
  });

  it('is idempotent: a second call returns the same class and does not throw', () => {
    const a = defineChatwardenHub();
    const b = defineChatwardenHub();
    expect(b).toBe(a);
    expect(() => defineChatwardenHub('chatwarden-hub')).not.toThrow();
  });

  it('returns whatever already owns the tag, without throwing and without replacing it', () => {
    class Other extends HTMLElement {}
    customElements.define('cw-taken-by-someone', Other);
    expect(defineChatwardenHub('cw-taken-by-someone')).toBe(Other);
    expect(customElements.get('cw-taken-by-someone')).toBe(Other);
  });

  it('registers under another tag name, and the package can serve several names', () => {
    const a = defineChatwardenHub('cw-hub-one');
    const b = defineChatwardenHub('cw-hub-two');
    expect(customElements.get('cw-hub-one')).toBe(a);
    expect(customElements.get('cw-hub-two')).toBe(b);
    expect(document.createElement('cw-hub-one')).toBeInstanceOf(ChatwardenHubElement);
    expect(document.createElement('cw-hub-two')).toBeInstanceOf(ChatwardenHubElement);
    // A second call for the same custom name is still a no-op.
    expect(defineChatwardenHub('cw-hub-one')).toBe(a);
  });

  it('still lets an invalid tag name throw (the browser says why), rather than hiding it', () => {
    expect(() => defineChatwardenHub('nodash')).toThrow();
  });

  it('observes exactly the documented attributes', () => {
    expect([...ChatwardenHubElement.observedAttributes].sort()).toEqual(['base-url', 'game-name', 'locale', 'mode', 'router', 'shortcuts', 'theme']);
  });
});
