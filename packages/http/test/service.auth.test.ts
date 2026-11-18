import { describe, expect, it } from 'vitest';
import { createHookAuth, createKeyAuth, parseKeys } from '../src/service/auth.js';
import { createServiceWrapper } from '../src/service/wrap.js';
import type { ServiceWrapperOptions } from '../src/service/wrap.js';
import type { KitRequest } from '../src/types.js';
import { KEY_A, KEY_B, KEY_C, callerOver, errorCode } from './serviceKit.js';

// S1: the service keys. Fake keys only; a test never prints one.

const keyOf = (n: number, length = 40): string => `k${n}`.padEnd(length, 'x');

function table(over: Partial<ServiceWrapperOptions> = {}) {
  const clock = { t: 1_800_000_000_000 };
  const { svc } = createServiceWrapper({ keys: [KEY_A], now: () => clock.t, logger: { warn: () => undefined }, ...over });
  const call = callerOver({ 'GET /ping': svc('GET /ping', () => ({ status: 200, body: { pong: true } })) });
  return { call, clock };
}

describe('keys', () => {
  it('1 and 5 accepted; 0, 6, a 31-character key, a 257-character key, a character outside the set and a duplicate refused with RangeError that never echoes a key', () => {
    expect(parseKeys([keyOf(1)])).toEqual([keyOf(1)]);
    expect(parseKeys([1, 2, 3, 4, 5].map((n) => keyOf(n)))).toHaveLength(5);
    expect(parseKeys([keyOf(1, 32)])).toHaveLength(1);
    expect(parseKeys([keyOf(1, 256)])).toHaveLength(1);
    expect(parseKeys([`${'a'.repeat(30)}-._~+/=`])).toHaveLength(1);
    const secret = 'SECRETMARK';
    const bad: unknown[] = [
      [],
      [1, 2, 3, 4, 5, 6].map((n) => keyOf(n)),
      [`${secret}${'a'.repeat(21)}`],
      [`${secret}${'a'.repeat(247)}`],
      [`${secret}${'a'.repeat(25)} ${'b'.repeat(10)}`],
      [`${secret}${'a'.repeat(30)}!`],
      [`${secret}${'a'.repeat(30)}é`],
      [keyOf(1), keyOf(1)],
      [`${secret}${'a'.repeat(30)}`, `${secret}${'a'.repeat(30)}`],
      'not-a-list',
      undefined,
      null,
      [5],
      [null],
      [''],
    ];
    for (const keys of bad) {
      let message = '';
      try {
        parseKeys(keys);
      } catch (e) {
        expect(e).toBeInstanceOf(RangeError);
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(keys)).not.toBe('');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('aaaaaaaa');
    }
  });

  it('returns a copy: changing the list the caller passed does not change the keys in force', () => {
    const given = [keyOf(1)];
    const parsed = parseKeys(given);
    given.push(keyOf(2));
    expect(parsed).toEqual([keyOf(1)]);
  });
});

describe('auth', () => {
  it('a correct key passes', async () => {
    const { call } = table();
    const res = await call('GET', '/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
  });

  it('missing header, wrong scheme, wrong key, empty bearer and a key one character off are all 401 unauthorized with www-authenticate and an identical body', async () => {
    const { call } = table();
    const off = `${KEY_A.slice(0, -1)}${KEY_A.endsWith('0') ? '1' : '0'}`;
    const attempts = [
      call('GET', '/ping', { key: null }),
      call('GET', '/ping', { authorization: `Basic ${KEY_A}` }),
      call('GET', '/ping', { authorization: KEY_A }),
      call('GET', '/ping', { key: KEY_B }),
      call('GET', '/ping', { authorization: 'Bearer ' }),
      call('GET', '/ping', { authorization: 'Bearer' }),
      call('GET', '/ping', { authorization: `Bearer  ${KEY_A}` }),
      call('GET', '/ping', { authorization: `Bearer ${KEY_A} extra` }),
      call('GET', '/ping', { key: off }),
      call('GET', '/ping', { key: 'short' }),
      call('GET', '/ping', { key: 'x'.repeat(5000) }),
    ];
    const results = await Promise.all(attempts);
    for (const res of results) {
      expect(res.status).toBe(401);
      expect(errorCode(res)).toBe('unauthorized');
      expect(res.headers?.['www-authenticate']).toBe('Bearer');
      expect(res.body).toEqual(results[0]!.body);
    }
    expect(JSON.stringify(results[0]!.body)).not.toMatch(/key|bearer|scheme/i);
  });

  it('the scheme word is case-insensitive, and a key in a query or another header is no key', async () => {
    const { call } = table();
    expect((await call('GET', '/ping', { authorization: `bearer ${KEY_A}` })).status).toBe(200);
    expect((await call('GET', '/ping', { key: null, headers: { 'x-api-key': KEY_A } })).status).toBe(401);
  });

  it('every configured digest is compared (a spy proves the loop does not stop at a match)', async () => {
    const seen: number[] = [];
    const auth = createKeyAuth({
      keys: [KEY_A, KEY_B, KEY_C],
      compare: (a, b) => {
        seen.push(a.length);
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
        return diff === 0;
      },
    });
    const req = (key: string): KitRequest => ({ method: 'GET', path: '/', query: {}, headers: { authorization: `Bearer ${key}` }, body: undefined });
    // the FIRST key matches: all three are still compared
    await auth.authenticate(req(KEY_A));
    expect(seen).toHaveLength(3);
    seen.length = 0;
    await auth.authenticate(req(KEY_C));
    expect(seen).toHaveLength(3);
    seen.length = 0;
    await expect(auth.authenticate(req('z'.repeat(40)))).rejects.toMatchObject({ code: 'unauthorized' });
    expect(seen).toHaveLength(3);
    for (const length of seen) expect(length).toBe(32);
  });

  it('the kid is the first 8 hex characters of the key digest, the same for the same key and different for another', async () => {
    const auth = createKeyAuth({ keys: [KEY_A, KEY_B] });
    const req = (key: string): KitRequest => ({ method: 'GET', path: '/', query: {}, headers: { authorization: `Bearer ${key}` }, body: undefined });
    const a = await auth.authenticate(req(KEY_A));
    const b = await auth.authenticate(req(KEY_B));
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(b).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(await auth.authenticate(req(KEY_A))).toBe(a);
    expect(a).not.toContain(KEY_A.slice(0, 8));
  });
});

describe('rotation', () => {
  it('two keys both work; removing the old one stops it at once', async () => {
    const auth = createKeyAuth({ keys: [KEY_A, KEY_B] });
    const req = (key: string): KitRequest => ({ method: 'GET', path: '/', query: {}, headers: { authorization: `Bearer ${key}` }, body: undefined });
    await expect(auth.authenticate(req(KEY_A))).resolves.toBeDefined();
    await expect(auth.authenticate(req(KEY_B))).resolves.toBeDefined();
    auth.replaceKeys([KEY_B]);
    await expect(auth.authenticate(req(KEY_A))).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(auth.authenticate(req(KEY_B))).resolves.toBeDefined();
  });

  it('through the routes: a table built with both keys accepts both, one built with the new key alone refuses the old', async () => {
    const both = table({ keys: [KEY_A, KEY_B] });
    expect((await both.call('GET', '/ping', { key: KEY_A })).status).toBe(200);
    expect((await both.call('GET', '/ping', { key: KEY_B })).status).toBe(200);
    const next = table({ keys: [KEY_B] });
    expect((await next.call('GET', '/ping', { key: KEY_A })).status).toBe(401);
    expect((await next.call('GET', '/ping', { key: KEY_B })).status).toBe(200);
  });
});

describe('failures', () => {
  const bad = (call: ReturnType<typeof table>['call'], remoteAddress?: string) => call('GET', '/ping', { key: KEY_B, ...(remoteAddress === undefined ? {} : { remoteAddress }) });

  it('past 20 failures in a minute an invalid token from that address is 429, a correct key still passes, a different address is unaffected', async () => {
    const { call } = table();
    for (let i = 0; i < 20; i++) expect((await bad(call, '198.51.100.1')).status).toBe(401);
    const blocked = await bad(call, '198.51.100.1');
    expect(blocked.status).toBe(429);
    expect(errorCode(blocked)).toBe('rate_limited');
    expect(Number(blocked.headers?.['retry-after'])).toBeGreaterThanOrEqual(1);
    // I-1: a valid key always passes, however many failures the peer has had
    for (let i = 0; i < 5; i++) expect((await call('GET', '/ping', { key: KEY_A, remoteAddress: '198.51.100.1' })).status).toBe(200);
    expect((await call('GET', '/ping', { key: KEY_A, remoteAddress: '198.51.100.2' })).status).toBe(200);
    expect((await bad(call, '198.51.100.1')).status).toBe(429);
  });

  it('a correct key passes after N failures from the same peer, for N well past the limit', async () => {
    const { call } = table();
    for (const n of [20, 21, 50, 200]) {
      const peer = `198.51.100.${100 + (n % 100)}`;
      for (let i = 0; i < n; i++) await bad(call, peer);
      expect((await call('GET', '/ping', { key: KEY_A, remoteAddress: peer })).status, String(n)).toBe(200);
    }
  });

  it('every kind of invalid token is still throttled: wrong key, missing header, wrong scheme, empty bearer, an over-long token', async () => {
    const { call } = table({ authFailureLimit: { max: 3, windowMs: 60_000 } });
    const peer = '198.51.100.30';
    for (let i = 0; i < 3; i++) expect((await bad(call, peer)).status).toBe(401);
    for (const attempt of [
      call('GET', '/ping', { key: KEY_B, remoteAddress: peer }),
      call('GET', '/ping', { key: null, remoteAddress: peer }),
      call('GET', '/ping', { authorization: `Basic ${KEY_A}`, remoteAddress: peer }),
      call('GET', '/ping', { authorization: 'Bearer ', remoteAddress: peer }),
      call('GET', '/ping', { authorization: `Bearer ${'z'.repeat(2000)}`, remoteAddress: peer }),
    ]) expect((await attempt).status).toBe(429);
  });

  it('a correct key between throttled invalid calls from the same peer stays 200 and is not counted', async () => {
    const { call } = table({ authFailureLimit: { max: 2, windowMs: 1000 } });
    const peer = '198.51.100.31';
    await bad(call, peer);
    await bad(call, peer);
    for (let i = 0; i < 10; i++) {
      expect((await bad(call, peer)).status).toBe(429);
      expect((await call('GET', '/ping', { key: KEY_A, remoteAddress: peer })).status).toBe(200);
    }
  });

  it('a rotated-out key retrying in a loop behind one proxy address does not lock out the good key of another server on that address', async () => {
    const { call } = table();
    for (let i = 0; i < 100; i++) await bad(call, '172.17.0.1');
    expect((await call('GET', '/ping', { key: KEY_A, remoteAddress: '172.17.0.1' })).status).toBe(200);
  });

  it('the hook form: a valid caller passes over a throttled peer, an invalid one is 429', async () => {
    const auth = createHookAuth(async (req) => (req.headers['x-user'] === 'ok' ? { actor: 'game', role: 'owner' as const } : null), { failureLimit: { max: 2, windowMs: 60_000 } });
    const req = (user: string): KitRequest => ({ method: 'GET', path: '/', query: {}, headers: { 'x-user': user }, body: undefined, remoteAddress: '192.0.2.50' });
    await auth.authenticate(req('no')).catch(() => undefined);
    await auth.authenticate(req('no')).catch(() => undefined);
    await expect(auth.authenticate(req('no'))).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(auth.authenticate(req('ok'))).resolves.toMatch(/^[0-9a-f]{8}$/);
  });

  it('the answer to a throttled invalid token never echoes the presented token or a configured key', async () => {
    const { call } = table({ authFailureLimit: { max: 1, windowMs: 60_000 } });
    await bad(call, '198.51.100.32');
    const res = await bad(call, '198.51.100.32');
    expect(res.status).toBe(429);
    const text = JSON.stringify(res);
    expect(text).not.toContain(KEY_A);
    expect(text).not.toContain(KEY_B);
  });

  it('the constant-time compare still runs for every key on every request, passing, failing or throttled', async () => {
    let calls = 0;
    const auth = createKeyAuth({
      keys: [KEY_A, KEY_B, KEY_C],
      failureLimit: { max: 1, windowMs: 60_000 },
      compare: (a, b) => {
        calls++;
        return a.length === b.length && a.every((v, i) => v === b[i]);
      },
    });
    const req = (key: string): KitRequest => ({ method: 'GET', path: '/', query: {}, headers: { authorization: `Bearer ${key}` }, body: undefined, remoteAddress: '192.0.2.60' });
    await auth.authenticate(req(KEY_A));
    expect(calls).toBe(3);
    calls = 0;
    await auth.authenticate(req('x'.repeat(40))).catch(() => undefined);
    expect(calls).toBe(3);
    calls = 0;
    await expect(auth.authenticate(req('y'.repeat(40)))).rejects.toMatchObject({ code: 'rate_limited' });
    expect(calls).toBe(3);
    calls = 0;
    await auth.authenticate(req(KEY_B));
    expect(calls).toBe(3);
  });

  it('19 failures leave the correct key working, and a correct call does not count as a failure', async () => {
    const { call } = table();
    for (let i = 0; i < 19; i++) await bad(call, '198.51.100.3');
    for (let i = 0; i < 30; i++) expect((await call('GET', '/ping', { key: KEY_A, remoteAddress: '198.51.100.3' })).status).toBe(200);
  });

  it('with no remoteAddress one shared bucket applies', async () => {
    const { call } = table();
    for (let i = 0; i < 20; i++) await bad(call);
    expect((await bad(call)).status).toBe(429);
    expect((await call('GET', '/ping', { key: KEY_A })).status).toBe(200);
    // an address the adapter did give is its own bucket
    expect((await call('GET', '/ping', { key: KEY_A, remoteAddress: '203.0.113.9' })).status).toBe(200);
  });

  it('the window resets', async () => {
    const { call, clock } = table();
    for (let i = 0; i < 20; i++) await bad(call, '198.51.100.4');
    expect((await bad(call, '198.51.100.4')).status).toBe(429);
    clock.t += 59_000;
    expect((await bad(call, '198.51.100.4')).status).toBe(429);
    clock.t += 1_001;
    expect((await bad(call, '198.51.100.4')).status).toBe(401);
  });

  it('a custom failure limit is validated like checkLimit and applied', async () => {
    const { call } = table({ authFailureLimit: { max: 2, windowMs: 1000 } });
    await bad(call, '198.51.100.5');
    await bad(call, '198.51.100.5');
    expect((await bad(call, '198.51.100.5')).status).toBe(429);
    for (const limit of [{ max: 0, windowMs: 1000 }, { max: 1.5, windowMs: 1000 }, { max: 1, windowMs: 0 }, null, 5]) {
      expect(() => table({ authFailureLimit: limit as never }), JSON.stringify(limit)).toThrow(RangeError);
    }
  });

  it('the bucket table is bounded at 10 000 keys', async () => {
    const auth = createKeyAuth({ keys: [KEY_A] });
    const req = (n: number): KitRequest => ({ method: 'GET', path: '/', query: {}, headers: { authorization: `Bearer ${KEY_B}` }, body: undefined, remoteAddress: `10.${n >> 16}.${(n >> 8) & 255}.${n & 255}` });
    for (let n = 0; n < 10_050; n++) await auth.authenticate(req(n)).catch(() => undefined);
    expect(auth.throttled()).toBeLessThanOrEqual(10_000);
    expect(auth.throttled()).toBeGreaterThan(9_000);
  });

  it('a failure in a window with no later failures leaves nothing behind once the window has passed', async () => {
    const clock = { t: 1_800_000_000_000 };
    const auth = createKeyAuth({ keys: [KEY_A], now: () => clock.t });
    const req: KitRequest = { method: 'GET', path: '/', query: {}, headers: { authorization: `Bearer ${KEY_B}` }, body: undefined, remoteAddress: '192.0.2.1' };
    await auth.authenticate(req).catch(() => undefined);
    expect(auth.throttled()).toBe(1);
    clock.t += 61_000;
    await auth.authenticate({ ...req, remoteAddress: '192.0.2.2' }).catch(() => undefined);
    expect(auth.throttled()).toBe(1);
  });
});

describe('rate limit', () => {
  it('3000 per 10 s per key by default; the next is 429 with retry-after in whole seconds of at least 1', async () => {
    const { call, clock } = table();
    for (let i = 0; i < 3000; i++) {
      const res = await call('GET', '/ping');
      if (res.status !== 200) throw new Error(`call ${i} was ${res.status}`);
    }
    const over = await call('GET', '/ping');
    expect(over.status).toBe(429);
    expect(errorCode(over)).toBe('rate_limited');
    expect(over.headers?.['retry-after']).toBe('10');
    clock.t += 9_500;
    const late = await call('GET', '/ping');
    expect(late.status).toBe(429);
    expect(late.headers?.['retry-after']).toBe('1');
    clock.t += 600;
    expect((await call('GET', '/ping')).status).toBe(200);
  });

  it('a custom limit is validated like checkLimit', async () => {
    const { call } = table({ rateLimit: { max: 2, windowMs: 5000 } });
    expect((await call('GET', '/ping')).status).toBe(200);
    expect((await call('GET', '/ping')).status).toBe(200);
    expect((await call('GET', '/ping')).status).toBe(429);
    for (const limit of [{ max: 0, windowMs: 1 }, { max: 1, windowMs: -1 }, { max: '5', windowMs: 1 }, { max: 1 }, null, 'x']) {
      expect(() => table({ rateLimit: limit as never }), JSON.stringify(limit)).toThrow(RangeError);
    }
  });

  it('two keys have separate buckets', async () => {
    const { call } = table({ keys: [KEY_A, KEY_B], rateLimit: { max: 1, windowMs: 10_000 } });
    expect((await call('GET', '/ping', { key: KEY_A })).status).toBe(200);
    expect((await call('GET', '/ping', { key: KEY_A })).status).toBe(429);
    expect((await call('GET', '/ping', { key: KEY_B })).status).toBe(200);
    expect((await call('GET', '/ping', { key: KEY_B })).status).toBe(429);
  });

  it('an unauthenticated call spends no slot of any key', async () => {
    const { call } = table({ rateLimit: { max: 1, windowMs: 10_000 } });
    for (let i = 0; i < 5; i++) expect((await call('GET', '/ping', { key: null, remoteAddress: `192.0.2.${i}` })).status).toBe(401);
    expect((await call('GET', '/ping')).status).toBe(200);
  });
});

describe('a custom authenticate hook', () => {
  it('stands in for the keys: a returned caller passes, null is 401, a throw is 500 with no detail', async () => {
    const hook = (req: KitRequest) => (req.headers['x-who'] === 'game' ? { actor: 'game-server', role: 'moderator' as const } : null);
    const { call } = table({ keys: hook });
    expect((await call('GET', '/ping', { key: null, headers: { 'x-who': 'game' } })).status).toBe(200);
    expect((await call('GET', '/ping', { key: null })).status).toBe(401);
    const boom = table({
      keys: () => {
        throw new Error('hook failed: secret detail');
      },
    });
    const res = await boom.call('GET', '/ping', { key: null });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret detail');
  });
});
