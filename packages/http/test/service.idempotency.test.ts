import { describe, expect, it } from 'vitest';
import type { KitResponse } from '../src/types.js';
import { createIdempotencyStore, fingerprintOf } from '../src/service/idempotency.js';
import { createServiceWrapper } from '../src/service/wrap.js';
import { KEY_A, KEY_B, callerOver, errorCode } from './serviceKit.js';

// S1: Idempotency-Key. In memory, ten minutes, 20 000 entries, scoped to (key, method, path).

const MIN = 60_000;

function world() {
  const clock = { t: 1_800_000_000_000 };
  const { svc } = createServiceWrapper({ keys: [KEY_A, KEY_B], now: () => clock.t, logger: { warn: () => undefined }, rateLimit: { max: 100_000, windowMs: 10_000 } });
  const runs = { n: 0 };
  let next: (() => Promise<KitResponse>) | undefined;
  const handler = async (): Promise<KitResponse> => {
    runs.n += 1;
    if (next !== undefined) return next();
    return { status: 200, body: { run: runs.n } };
  };
  const call = callerOver({
    'POST /lines': svc('POST /lines', handler, { idempotent: true }),
    'POST /other': svc('POST /other', handler, { idempotent: true }),
    'PUT /lines': svc('PUT /lines', handler, { idempotent: true }),
    'POST /plain': svc('POST /plain', handler),
  });
  return { call, clock, runs, setNext: (f: (() => Promise<KitResponse>) | undefined) => (next = f) };
}

describe('idempotency', () => {
  it('same key and body replays the stored status and body with idempotent-replay true and runs the handler once', async () => {
    const w = world();
    const first = await w.call('POST', '/lines', { body: { text: 'hi' }, idempotencyKey: 'k-1' });
    expect(first.status).toBe(200);
    expect(first.headers?.['idempotent-replay']).toBeUndefined();
    const second = await w.call('POST', '/lines', { body: { text: 'hi' }, idempotencyKey: 'k-1' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.headers?.['idempotent-replay']).toBe('true');
    expect(w.runs.n).toBe(1);
    // the key order of the body does not matter (the fingerprint is of the canonical body)
    const third = await w.call('POST', '/lines', { raw: '{"b":1,"a":{"y":2,"x":1}}', idempotencyKey: 'k-2' });
    const fourth = await w.call('POST', '/lines', { raw: '{"a":{"x":1,"y":2},"b":1}', idempotencyKey: 'k-2' });
    expect(fourth.headers?.['idempotent-replay']).toBe('true');
    expect(fourth.body).toEqual(third.body);
    expect(w.runs.n).toBe(2);
  });

  it('a replay carries the current request id and the service headers, not the stored ones', async () => {
    const w = world();
    const first = await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-1', headers: { 'x-request-id': 'first-call' } });
    const second = await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-1', headers: { 'x-request-id': 'second-call' } });
    expect(first.headers?.['x-request-id']).toBe('first-call');
    expect(second.headers?.['x-request-id']).toBe('second-call');
    expect(second.headers?.['chatwarden-api']).toBe('1');
    expect(second.headers?.['cache-control']).toBe('no-store');
  });

  it('a different body is 409 idempotency_mismatch and runs nothing', async () => {
    const w = world();
    await w.call('POST', '/lines', { body: { text: 'hi' }, idempotencyKey: 'k-1' });
    const res = await w.call('POST', '/lines', { body: { text: 'hello' }, idempotencyKey: 'k-1' });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('idempotency_mismatch');
    expect(w.runs.n).toBe(1);
  });

  it('a call in flight is 409 in_progress; once it finishes the same key replays', async () => {
    const w = world();
    let release: (() => void) | undefined;
    w.setNext(
      () =>
        new Promise<KitResponse>((resolve) => {
          release = () => resolve({ status: 200, body: { done: true } });
        }),
    );
    const slow = w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-1' });
    await new Promise((r) => setTimeout(r, 5));
    const during = await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-1' });
    expect(during.status).toBe(409);
    expect(errorCode(during)).toBe('in_progress');
    expect(w.runs.n).toBe(1);
    release?.();
    expect((await slow).status).toBe(200);
    const after = await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-1' });
    expect(after.headers?.['idempotent-replay']).toBe('true');
    expect(after.body).toEqual({ done: true });
    expect(w.runs.n).toBe(1);
  });

  it('a 5xx, 401 and 429 from the handler are not stored (a retry runs again); other answers, a refusal at 200 and a 4xx included, are', async () => {
    const w = world();
    for (const status of [500, 503, 401, 429]) {
      w.setNext(async () => ({ status, body: { error: 'x' } }));
      const before = w.runs.n;
      const a = await w.call('POST', '/lines', { body: { s: status }, idempotencyKey: `k-${status}` });
      const b = await w.call('POST', '/lines', { body: { s: status }, idempotencyKey: `k-${status}` });
      expect(a.status).toBe(status);
      expect(b.status).toBe(status);
      expect(b.headers?.['idempotent-replay'], String(status)).toBeUndefined();
      expect(w.runs.n - before, String(status)).toBe(2);
    }
    w.setNext(async () => ({ status: 200, body: { ok: false, refused: { reason: 'blocked' } } }));
    await w.call('POST', '/lines', { body: { s: 'r' }, idempotencyKey: 'k-r' });
    const replay = await w.call('POST', '/lines', { body: { s: 'r' }, idempotencyKey: 'k-r' });
    expect(replay.headers?.['idempotent-replay']).toBe('true');
    w.setNext(async () => ({ status: 404, body: { error: 'not_found' } }));
    await w.call('POST', '/lines', { body: { s: 'n' }, idempotencyKey: 'k-n' });
    expect((await w.call('POST', '/lines', { body: { s: 'n' }, idempotencyKey: 'k-n' })).headers?.['idempotent-replay']).toBe('true');
  });

  it('a handler that throws is a 500, not stored, and the key is free again', async () => {
    const w = world();
    w.setNext(async () => {
      throw new Error('boom');
    });
    const a = await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-1' });
    expect(a.status).toBe(500);
    w.setNext(undefined);
    const b = await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-1' });
    expect(b.status).toBe(200);
    expect(b.headers?.['idempotent-replay']).toBeUndefined();
  });

  it('after 10 minutes on the fake clock the key is new', async () => {
    const w = world();
    await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-1' });
    w.clock.t += 10 * MIN - 1;
    expect((await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-1' })).headers?.['idempotent-replay']).toBe('true');
    w.clock.t += 2;
    const fresh = await w.call('POST', '/lines', { body: { a: 2 }, idempotencyKey: 'k-1' });
    expect(fresh.status).toBe(200);
    expect(w.runs.n).toBe(2);
  });

  it('keys are scoped to the calling key, method and path', async () => {
    const w = world();
    await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'same' });
    expect((await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'same', key: KEY_B })).headers?.['idempotent-replay']).toBeUndefined();
    expect((await w.call('POST', '/other', { body: { a: 1 }, idempotencyKey: 'same' })).headers?.['idempotent-replay']).toBeUndefined();
    expect((await w.call('PUT', '/lines', { body: { a: 1 }, idempotencyKey: 'same' })).headers?.['idempotent-replay']).toBeUndefined();
    expect(w.runs.n).toBe(4);
    // and each one replays within its own scope
    expect((await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'same', key: KEY_B })).headers?.['idempotent-replay']).toBe('true');
    expect((await w.call('POST', '/other', { body: { a: 1 }, idempotencyKey: 'same' })).headers?.['idempotent-replay']).toBe('true');
  });

  it('a different key on the same body runs again', async () => {
    const w = world();
    await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-1' });
    await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-2' });
    expect(w.runs.n).toBe(2);
  });
});

describe('the header', () => {
  it('a malformed Idempotency-Key (65 characters, a space, empty) is 400 invalid_idempotency_key; the handler does not run', async () => {
    const w = world();
    for (const key of ['a'.repeat(65), 'has space', '', 'sl/ash', 'café']) {
      const res = await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: key });
      expect(res.status, JSON.stringify(key)).toBe(400);
      expect(errorCode(res)).toBe('invalid_idempotency_key');
    }
    expect(w.runs.n).toBe(0);
  });

  it('a key of 1 and of 64 characters of the set is accepted', async () => {
    const w = world();
    for (const key of ['a', 'A_b.c:d-9'.padEnd(64, 'z')]) expect((await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: key })).status).toBe(200);
  });

  it('without the header the handler runs every time', async () => {
    const w = world();
    for (let i = 0; i < 3; i++) await w.call('POST', '/lines', { body: { a: 1 } });
    expect(w.runs.n).toBe(3);
  });

  it('on a route that is not idempotent the header is ignored, even a malformed one', async () => {
    const w = world();
    for (let i = 0; i < 2; i++) {
      const res = await w.call('POST', '/plain', { body: { a: 1 }, idempotencyKey: 'k-1' });
      expect(res.status).toBe(200);
      expect(res.headers?.['idempotent-replay']).toBeUndefined();
    }
    expect((await w.call('POST', '/plain', { body: { a: 1 }, idempotencyKey: 'has space' })).status).toBe(200);
    expect(w.runs.n).toBe(3);
  });

  it('a bad body with a good key is the body error (400), and the key is then free for the corrected body', async () => {
    const w = world();
    const bad = await w.call('POST', '/lines', { raw: '{nope', idempotencyKey: 'k-1' });
    expect(bad.status).toBe(400);
    expect((await w.call('POST', '/lines', { body: { a: 1 }, idempotencyKey: 'k-1' })).status).toBe(200);
  });
});

describe('the store', () => {
  const at = () => ({ t: 1_800_000_000_000 });

  it('reserve, finish, replay, mismatch and in_progress', () => {
    const clock = at();
    const store = createIdempotencyStore({ now: () => clock.t });
    const first = store.begin('kid|POST|/p', 'k', 'fp1');
    expect(first.kind).toBe('new');
    expect(store.begin('kid|POST|/p', 'k', 'fp1').kind).toBe('in_progress');
    expect(store.begin('kid|POST|/p', 'k', 'fp2').kind).toBe('mismatch');
    if (first.kind === 'new') store.finish(first.token, 200, { ok: true });
    expect(store.begin('kid|POST|/p', 'k', 'fp1')).toMatchObject({ kind: 'replay', status: 200, body: { ok: true } });
    expect(store.begin('kid|POST|/p', 'k', 'fp2').kind).toBe('mismatch');
    expect(store.begin('kid|POST|/q', 'k', 'fp1').kind).toBe('new');
  });

  it('abandon frees a reserved key; finish of a 5xx, 401 or 429 frees it too', () => {
    const clock = at();
    const store = createIdempotencyStore({ now: () => clock.t });
    for (const status of [500, 502, 401, 429]) {
      const r = store.begin('s', `k${status}`, 'fp');
      if (r.kind !== 'new') throw new Error('expected new');
      store.finish(r.token, status, {});
      expect(store.begin('s', `k${status}`, 'fp').kind, String(status)).toBe('new');
    }
    const r = store.begin('s', 'ka', 'fp');
    if (r.kind !== 'new') throw new Error('expected new');
    store.abandon(r.token);
    expect(store.begin('s', 'ka', 'fp').kind).toBe('new');
  });

  it('20 001 keys evict the oldest; the 20 000 newest remain', () => {
    const clock = at();
    const store = createIdempotencyStore({ now: () => clock.t });
    for (let i = 0; i <= 20_000; i++) {
      const r = store.begin('s', `k${i}`, 'fp');
      if (r.kind !== 'new') throw new Error('expected new');
      store.finish(r.token, 200, { i });
      clock.t += 1;
    }
    expect(store.size()).toBeLessThanOrEqual(20_000);
    expect(store.begin('s', 'k0', 'fp').kind).toBe('new');
    expect(store.begin('s', 'k20000', 'fp').kind).toBe('replay');
    expect(store.begin('s', 'k1000', 'fp').kind).toBe('replay');
  });

  it('expired entries are swept when the store is next used, so a quiet key table does not grow', () => {
    const clock = at();
    const store = createIdempotencyStore({ now: () => clock.t });
    for (let i = 0; i < 50; i++) {
      const r = store.begin('s', `k${i}`, 'fp');
      if (r.kind === 'new') store.finish(r.token, 200, {});
    }
    expect(store.size()).toBe(50);
    clock.t += 11 * MIN;
    store.begin('s', 'later', 'fp');
    expect(store.size()).toBe(1);
  });

  it('a custom ttl and capacity are validated (positive whole numbers)', () => {
    expect(() => createIdempotencyStore({ now: () => 0, ttlMs: 0 })).toThrow(RangeError);
    expect(() => createIdempotencyStore({ now: () => 0, max: 1.5 })).toThrow(RangeError);
    expect(createIdempotencyStore({ now: () => 0, ttlMs: 1, max: 1 }).size()).toBe(0);
  });
});

describe('the fingerprint', () => {
  it('is the same for the same canonical body whatever the key order and differs for any change', async () => {
    const a = await fingerprintOf({ b: 1, a: { y: [1, 2], x: 'q' } });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprintOf({ a: { x: 'q', y: [1, 2] }, b: 1 })).toBe(a);
    for (const other of [{ b: 2, a: { y: [1, 2], x: 'q' } }, { b: 1, a: { y: [2, 1], x: 'q' } }, { b: 1, a: { y: [1, 2], x: 'Q' } }, { b: 1 }, [], null, undefined]) {
      expect(await fingerprintOf(other)).not.toBe(a);
    }
    expect(await fingerprintOf(undefined)).toBe(await fingerprintOf(undefined));
    // a number and the string of it differ
    expect(await fingerprintOf({ a: 1 })).not.toBe(await fingerprintOf({ a: '1' }));
  });
});
