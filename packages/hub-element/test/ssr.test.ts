// @vitest-environment node
import { describe, expect, it } from 'vitest';

// A bundler that renders pages on a server imports the package there too: that must not throw, and defining must be a no-op
// (there is no custom element registry on a server).

describe('imported where there is no DOM', () => {
  it('imports, and defineChatwardenHub returns the class without registering anything', async () => {
    expect(typeof HTMLElement).toBe('undefined');
    const mod = await import('../src/index.js');
    expect(typeof mod.ChatwardenHubElement).toBe('function');
    expect(mod.defineChatwardenHub()).toBe(mod.ChatwardenHubElement);
    expect(mod.VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
