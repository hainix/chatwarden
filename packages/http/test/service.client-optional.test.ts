import { describe, expect, it } from 'vitest';
import { createServiceClient } from '../src/service/client.js';
import type { ServiceClient } from '../src/service/client.js';

// 0.2.1 is additive (R2 minor 3): a `ServiceClient` that an adopter implements or mocks against 0.2.0 still compiles, because the three appeal methods are optional on the interface.
// The client `createServiceClient` returns has them for certain. These are compile-time checks (`npm run typecheck`) with a runtime line each.

type Old = Omit<ServiceClient, 'appealLink' | 'fileAppeal' | 'appeals'>;

describe('ServiceClient and the three appeal methods', () => {
  it('an object with the 0.2.0 methods only is a ServiceClient', () => {
    const old = {} as Old;
    const asClient: ServiceClient = old;
    expect(asClient.appealLink).toBeUndefined();
    expect(asClient.fileAppeal).toBeUndefined();
    expect(asClient.appeals).toBeUndefined();
  });

  it('the client createServiceClient makes has all three, callable without a check', () => {
    const client = createServiceClient({ baseUrl: 'https://service.example', key: 'k'.repeat(40), fetch: (() => Promise.reject(new Error('no network in tests'))) as never });
    const link: (noticeId: string) => Promise<{ url: string | null }> = client.appealLink;
    const file: ServiceClient['handshake'] = client.handshake;
    expect(typeof link).toBe('function');
    expect(typeof file).toBe('function');
    expect(typeof client.fileAppeal).toBe('function');
    expect(typeof client.appeals).toBe('function');
  });
});
