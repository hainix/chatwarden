import { describe, expect, it } from 'vitest';
import { appealLandingRoutes, createRouter, playerRoutes } from '@chatwarden/http';
import { clientAddressOf } from '../src/clientAddress.js';
import { errorOf, identifyFromHeaders } from './playerWorld.js';
import { landingWorld } from './landingWorld.js';

// Who a landing request is limited as (0.2.1, R2 important 2). The limits are always per token. An address limit applies only when a real client address is known: the socket peer when no
// proxy is configured, or the address a trusted proxy reports (`trustProxy` = how many proxies are in front, read from the right of X-Forwarded-For). An unknown address is never one shared
// bucket. These tests play a reverse proxy: every request has the proxy as its socket peer and carries the real client in x-forwarded-for.

const PROXY = '10.0.0.2';
const xff = (...chain: string[]): Record<string, string> => ({ 'x-forwarded-for': chain.join(', ') });
const SHARED = 'chatwarden.landing_shared_address';

describe('clientAddressOf', () => {
  const req = (headers: Record<string, string>, remoteAddress?: string) => ({ method: 'GET', path: '/appeal', query: {}, headers, body: undefined, ...(remoteAddress === undefined ? {} : { remoteAddress }) });

  it('with no proxy setting it is the socket peer and never a header', () => {
    expect(clientAddressOf(req(xff('203.0.113.7'), PROXY), undefined)).toBe(PROXY);
    expect(clientAddressOf(req(xff('203.0.113.7'), PROXY), 0)).toBe(PROXY);
    expect(clientAddressOf(req({}, undefined), undefined)).toBeUndefined();
    expect(clientAddressOf(req(xff('203.0.113.7')), undefined)).toBeUndefined();
  });

  it('with one trusted proxy it is the right-most entry; with two it is the second from the right', () => {
    expect(clientAddressOf(req(xff('203.0.113.7'), PROXY), 1)).toBe('203.0.113.7');
    expect(clientAddressOf(req(xff('6.6.6.6', '203.0.113.7'), PROXY), 1)).toBe('203.0.113.7');
    expect(clientAddressOf(req(xff('6.6.6.6', '203.0.113.7', '10.0.0.9'), PROXY), 2)).toBe('203.0.113.7');
    expect(clientAddressOf(req(xff('2001:db8::7'), PROXY), 1)).toBe('2001:db8::7');
  });

  it('with a proxy setting but no usable header it is unknown, never the proxy peer', () => {
    expect(clientAddressOf(req({}, PROXY), 1)).toBeUndefined();
    expect(clientAddressOf(req(xff('203.0.113.7'), PROXY), 2)).toBeUndefined();
    expect(clientAddressOf(req({ 'x-forwarded-for': '' }, PROXY), 1)).toBeUndefined();
    expect(clientAddressOf(req(xff('not an address'), PROXY), 1)).toBeUndefined();
    expect(clientAddressOf(req(xff('203.0.113.7', ''), PROXY), 1)).toBeUndefined();
    expect(clientAddressOf(req({ 'x-forwarded-for': 'a'.repeat(500) }, PROXY), 1)).toBeUndefined();
  });
});

describe('behind a trusted proxy', () => {
  it('each client has its own read bucket: one client over the limit does not stop another', async () => {
    const w = await landingWorld({ routeOptions: { trustProxy: 1 } });
    const s = await w.sanctioned();
    // no token on these: they count against the address only
    for (let i = 0; i < 60; i++) expect((await w.page(undefined, { remoteAddress: PROXY, headers: xff('203.0.113.1') })).status, `get ${i + 1}`).toBe(404);
    expect((await w.page(undefined, { remoteAddress: PROXY, headers: xff('203.0.113.1') })).status).toBe(429);
    expect((await w.page(s.token, { remoteAddress: PROXY, headers: xff('203.0.113.2') })).status).toBe(200);
    expect((await w.page(undefined, { remoteAddress: PROXY, headers: xff('203.0.113.2') })).status).toBe(404);
  });

  it('a spoofed left-most entry buys nothing: the proxy appended the real client on the right', async () => {
    const w = await landingWorld({ routeOptions: { trustProxy: 1 } });
    for (let i = 0; i < 60; i++) await w.page(undefined, { remoteAddress: PROXY, headers: xff(`6.6.6.${i}`, '203.0.113.1') });
    expect((await w.page(undefined, { remoteAddress: PROXY, headers: xff('6.6.6.99', '203.0.113.1') })).status).toBe(429);
  });

  it('two proxies in front: the second from the right is the client', async () => {
    const w = await landingWorld({ routeOptions: { trustProxy: 2 } });
    for (let i = 0; i < 60; i++) await w.page(undefined, { remoteAddress: PROXY, headers: xff('203.0.113.1', '10.0.0.9') });
    expect((await w.page(undefined, { remoteAddress: PROXY, headers: xff('203.0.113.1', '10.0.0.9') })).status).toBe(429);
    expect((await w.page(undefined, { remoteAddress: PROXY, headers: xff('203.0.113.5', '10.0.0.9') })).status).toBe(404);
  });

  it('writes: 10 an hour per client, other clients behind the same proxy unaffected', async () => {
    const w = await landingWorld({ routeOptions: { trustProxy: 1 } });
    for (let i = 0; i < 10; i++) expect((await w.postJson({ junk: 1 }, { remoteAddress: PROXY, headers: xff('203.0.113.1') })).status).toBe(400);
    expect((await w.postJson({ junk: 1 }, { remoteAddress: PROXY, headers: xff('203.0.113.1') })).status).toBe(429);
    expect((await w.postJson({ junk: 1 }, { remoteAddress: PROXY, headers: xff('203.0.113.2') })).status).toBe(400);
  });

  it('the token limits still apply behind the proxy: the same token from many clients is limited at 10 writes and 60 reads', async () => {
    const w = await landingWorld({ routeOptions: { trustProxy: 1 } });
    const s = await w.sanctioned();
    for (let i = 0; i < 10; i++) expect((await w.postJson({ t: s.token, statement: '' }, { remoteAddress: PROXY, headers: xff(`203.0.113.${i + 10}`) })).status).toBe(400);
    expect((await w.postJson({ t: s.token, statement: '' }, { remoteAddress: PROXY, headers: xff('203.0.113.99') })).status).toBe(429);
    for (let i = 0; i < 60; i++) await w.caseJson(s.token, { remoteAddress: PROXY, headers: xff(`198.51.100.${i}`) });
    const over = await w.caseJson(s.token, { remoteAddress: PROXY, headers: xff('198.51.100.200') });
    expect(over.status).toBe(429);
    expect(errorOf(over)).toBe('rate_limited');
  });

  it('a missing or unusable header leaves the address unknown: no shared bucket, only the token limits apply', async () => {
    const w = await landingWorld({ routeOptions: { trustProxy: 1 } });
    const s = await w.sanctioned();
    for (let i = 0; i < 80; i++) expect((await w.page(undefined, { remoteAddress: PROXY })).status, `no header ${i}`).toBe(404);
    for (let i = 0; i < 80; i++) expect((await w.page(undefined, { remoteAddress: PROXY, headers: xff('garbage value') })).status, `garbage ${i}`).toBe(404);
    for (let i = 0; i < 15; i++) expect((await w.postJson({ junk: 1 }, { remoteAddress: PROXY })).status, `post ${i}`).toBe(400);
    expect((await w.page(s.token, { remoteAddress: PROXY })).status).toBe(200);
  });
});

describe('with no proxy setting', () => {
  it('the forwarding header is never read: one peer is one bucket whatever the header says', async () => {
    const w = await landingWorld();
    for (let i = 0; i < 60; i++) await w.page(undefined, { remoteAddress: PROXY, headers: xff(`203.0.113.${i}`) });
    expect((await w.page(undefined, { remoteAddress: PROXY, headers: xff('203.0.113.250') })).status).toBe(429);
    // a different peer is its own bucket
    expect((await w.page(undefined, { remoteAddress: '198.51.100.1' })).status).toBe(404);
  });

  it('with no address at all, nothing is shared: reads of different tokens are never limited together, the same token is limited per token', async () => {
    const w = await landingWorld({ routeOptions: { landingReadRateLimit: { max: 2, windowMs: 60_000 } } });
    const a = await w.sanctioned();
    const b = await w.sanctioned();
    expect((await w.page(a.token)).status).toBe(200);
    expect((await w.page(a.token)).status).toBe(200);
    expect((await w.page(a.token)).status).toBe(429);
    expect((await w.caseJson(a.token)).status).toBe(429);
    // another token is not in that bucket
    expect((await w.page(b.token)).status).toBe(200);
    expect((await w.page(b.token)).status).toBe(200);
    expect((await w.page(b.token)).status).toBe(429);
    // and no token and no address is not limited at all
    for (let i = 0; i < 10; i++) expect((await w.page(undefined)).status).toBe(404);
  });

  it('with no address, 100 reads of 100 different tokens are never answered 429', async () => {
    const w = await landingWorld();
    for (let i = 0; i < 100; i++) expect((await w.page(`forged.${i}`)).status, `read ${i}`).toBe(404);
    for (let i = 0; i < 100; i++) expect((await w.caseJson(`forged.${i}`)).status, `json ${i}`).toBe(404);
  });

  it('with no address, writes are limited per token (10 an hour) and malformed bodies without a token are not limited together', async () => {
    const w = await landingWorld();
    const a = await w.sanctioned();
    const b = await w.sanctioned();
    for (let i = 0; i < 10; i++) expect((await w.postJson({ t: a.token, statement: '' })).status).toBe(400);
    expect((await w.postJson({ t: a.token, statement: '' })).status).toBe(429);
    expect((await w.postJson({ t: b.token, statement: '' })).status).toBe(400);
    for (let i = 0; i < 30; i++) expect((await w.postJson({ junk: 1 })).status, `junk ${i}`).toBe(400);
    for (let i = 0; i < 30; i++) expect((await w.postForm({ t: `forged.${i}` })).status, `form ${i}`).toBe(303);
  });

  it('the read limit is per token too when the address is known: the same token from many peers is limited', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    for (let i = 0; i < 60; i++) expect((await w.page(s.token, { remoteAddress: `198.51.100.${i}` })).status).toBe(200);
    expect((await w.page(s.token, { remoteAddress: '198.51.100.200' })).status).toBe(429);
    // the hour reopens it
    w.advance(w.HOUR);
    expect((await w.page(s.token, { remoteAddress: '198.51.100.200' })).status).toBe(200);
  });
});

describe('one peer for every request, and no proxy setting: warn once', () => {
  const sharedWarnings = (w: Awaited<ReturnType<typeof landingWorld>>) => w.logged.filter(([event]) => event === SHARED);

  it('after 20 requests from one peer in a window it logs chatwarden.landing_shared_address once, by count only, and never again', async () => {
    const w = await landingWorld();
    for (let i = 0; i < 19; i++) await w.page(undefined, { remoteAddress: PROXY, headers: xff(`203.0.113.${i}`) });
    expect(sharedWarnings(w)).toHaveLength(0);
    await w.page(undefined, { remoteAddress: PROXY, headers: xff('203.0.113.99') });
    expect(sharedWarnings(w)).toHaveLength(1);
    const [, detail] = sharedWarnings(w)[0] as [string, Record<string, unknown>];
    expect(Object.keys(detail).sort()).toEqual(['requests']);
    expect(JSON.stringify(sharedWarnings(w)[0])).not.toContain(PROXY);
    for (let i = 0; i < 100; i++) await w.page(undefined, { remoteAddress: PROXY });
    w.advance(w.HOUR * 3);
    for (let i = 0; i < 30; i++) await w.page(undefined, { remoteAddress: PROXY });
    expect(sharedWarnings(w)).toHaveLength(1);
  });

  it('reads and writes both count', async () => {
    const w = await landingWorld();
    for (let i = 0; i < 10; i++) await w.page(undefined, { remoteAddress: PROXY });
    for (let i = 0; i < 10; i++) await w.postJson({ junk: 1 }, { remoteAddress: PROXY });
    expect(sharedWarnings(w)).toHaveLength(1);
  });

  it('two different peers in the window: no warning', async () => {
    const w = await landingWorld();
    for (let i = 0; i < 40; i++) await w.page(undefined, { remoteAddress: i === 7 ? '198.51.100.7' : PROXY });
    expect(sharedWarnings(w)).toHaveLength(0);
  });

  it('a window that ends before the count is reached starts over', async () => {
    const w = await landingWorld();
    for (let i = 0; i < 15; i++) await w.page(undefined, { remoteAddress: PROXY });
    w.advance(w.HOUR + 1);
    for (let i = 0; i < 15; i++) await w.page(undefined, { remoteAddress: PROXY });
    expect(sharedWarnings(w)).toHaveLength(0);
  });

  it('requests with no peer address do not count', async () => {
    const w = await landingWorld();
    for (let i = 0; i < 60; i++) await w.page(undefined);
    expect(sharedWarnings(w)).toHaveLength(0);
  });

  it('with a proxy setting it never warns', async () => {
    const w = await landingWorld({ routeOptions: { trustProxy: 1 } });
    for (let i = 0; i < 40; i++) await w.page(undefined, { remoteAddress: PROXY, headers: xff('203.0.113.1') });
    expect(sharedWarnings(w)).toHaveLength(0);
  });
});

describe('the trustProxy option', () => {
  it('is a whole number of 1 to 10 (0 means none) on appealLandingRoutes and playerRoutes: a RangeError names the option and never the value', async () => {
    const w = await landingWorld();
    for (const bad of [-1, 1.5, 11, '1', true, null, Number.NaN]) {
      for (const make of [() => appealLandingRoutes(w.cw, { trustProxy: bad as never }), () => playerRoutes(w.cw, { identify: identifyFromHeaders, trustProxy: bad as never })]) {
        let message = '';
        try {
          make();
        } catch (err) {
          expect(err).toBeInstanceOf(RangeError);
          message = (err as Error).message;
        }
        expect(message, String(bad)).toContain('trustProxy');
      }
    }
    expect(() => appealLandingRoutes(w.cw, { trustProxy: 0 })).not.toThrow();
    expect(() => appealLandingRoutes(w.cw, { trustProxy: 10 })).not.toThrow();
    expect(() => appealLandingRoutes(w.cw)).not.toThrow();
  });

  it('appealLandingRoutes on its own honours it', async () => {
    const w = await landingWorld();
    const router = createRouter(appealLandingRoutes(w.cw, { trustProxy: 1, now: () => w.clock.t }));
    const get = (client: string) => router({ method: 'GET', path: '/appeal', query: {}, headers: xff(client), body: undefined, remoteAddress: PROXY });
    for (let i = 0; i < 60; i++) await get('203.0.113.1');
    expect((await get('203.0.113.1')).status).toBe(429);
    expect((await get('203.0.113.2')).status).toBe(404);
  });
});
