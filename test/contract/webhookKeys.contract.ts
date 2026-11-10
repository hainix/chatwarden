import { expect, it, describe } from 'vitest';
import { purge, WEBHOOK_KEY_TTL_MS } from '@chatwarden/core';
import type { Store } from '@chatwarden/core';

// The contract of the incoming-webhook idempotency key methods of the Store. One suite, run against every Store
// (MemoryStore and SqliteStore) so "both stores agree" is enforced, not just observed.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const FLOOR = NOW - WEBHOOK_KEY_TTL_MS;
const FP = 'f'.repeat(64);
const FP2 = 'e'.repeat(64);

export function webhookKeysContract(name: string, make: () => Store): void {
  describe(`webhook keys contract: ${name}`, () => {
  it('the TTL is 24 hours', () => {
    expect(WEBHOOK_KEY_TTL_MS).toBe(DAY);
  });

  it('reserve inserts a pending row the first time', () => {
    const s = make();
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP)).toEqual({ reserved: true });
  });

  it('a second reserve returns the existing pending row and does not reserve', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR, FP);
    expect(s.reserveWebhookKey('k1', NOW + 1, FLOOR, FP)).toEqual({ reserved: false, state: 'pending', resultJson: null, fingerprint: FP });
  });

  it('complete stores the result; reserve then returns it as done', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR, FP);
    expect(s.completeWebhookKey('k1', '{"groupId":"g"}')).toBe(true);
    expect(s.reserveWebhookKey('k1', NOW + 5, FLOOR, FP)).toEqual({ reserved: false, state: 'done', resultJson: '{"groupId":"g"}', fingerprint: FP });
  });

  it('complete is false for an unknown key and for a key already done (the first result stands)', () => {
    const s = make();
    expect(s.completeWebhookKey('nope', '{}')).toBe(false);
    s.reserveWebhookKey('k1', NOW, FLOOR, FP);
    expect(s.completeWebhookKey('k1', '{"a":1}')).toBe(true);
    expect(s.completeWebhookKey('k1', '{"a":2}')).toBe(false);
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP)).toEqual({ reserved: false, state: 'done', resultJson: '{"a":1}', fingerprint: FP });
  });

  it('release deletes a pending reservation so the key can be reserved again', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR, FP);
    expect(s.releaseWebhookKey('k1')).toBe(true);
    expect(s.releaseWebhookKey('k1')).toBe(false);
    expect(s.reserveWebhookKey('k1', NOW + 1, FLOOR, FP)).toEqual({ reserved: true });
  });

  it('release never deletes a done row', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR, FP);
    s.completeWebhookKey('k1', '{"a":1}');
    expect(s.releaseWebhookKey('k1')).toBe(false);
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP)).toMatchObject({ reserved: false, state: 'done' });
  });

  it('keys are independent', () => {
    const s = make();
    expect(s.reserveWebhookKey('a', NOW, FLOOR, FP)).toEqual({ reserved: true });
    expect(s.reserveWebhookKey('b', NOW, FLOOR, FP)).toEqual({ reserved: true });
    s.completeWebhookKey('a', '{"x":1}');
    expect(s.reserveWebhookKey('b', NOW, FLOOR, FP)).toMatchObject({ state: 'pending' });
  });

  it('keys are case sensitive and exact', () => {
    const s = make();
    expect(s.reserveWebhookKey('Key', NOW, FLOOR, FP)).toEqual({ reserved: true });
    expect(s.reserveWebhookKey('key', NOW, FLOOR, FP)).toEqual({ reserved: true });
    expect(s.reserveWebhookKey('key ', NOW, FLOOR, FP)).toEqual({ reserved: true });
  });

  it('a row older than the floor is replaced by a fresh pending reservation (the key is free again)', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW - DAY - 1, NOW - 2 * DAY, FP);
    s.completeWebhookKey('k1', '{"old":true}');
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP)).toEqual({ reserved: true });
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP)).toEqual({ reserved: false, state: 'pending', resultJson: null, fingerprint: FP });
  });

  it('a row exactly on the floor is still the first one', () => {
    const s = make();
    s.reserveWebhookKey('k1', FLOOR, FLOOR - 1, FP);
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP)).toMatchObject({ reserved: false, state: 'pending' });
  });

  it('purgeWebhookKeys deletes strictly older rows, done or pending, and returns the count', () => {
    const s = make();
    s.reserveWebhookKey('old-done', NOW - DAY - 1, 0, FP);
    s.completeWebhookKey('old-done', '{}');
    s.reserveWebhookKey('old-pending', NOW - 3 * DAY, 0, FP);
    s.reserveWebhookKey('edge', FLOOR, 0, FP);
    s.reserveWebhookKey('new', NOW, 0, FP);
    expect(s.purgeWebhookKeys(FLOOR)).toBe(2);
    expect(s.reserveWebhookKey('edge', NOW, 0, FP)).toMatchObject({ reserved: false });
    expect(s.reserveWebhookKey('new', NOW, 0, FP)).toMatchObject({ reserved: false });
    expect(s.reserveWebhookKey('old-done', NOW, 0, FP)).toEqual({ reserved: true });
    expect(s.purgeWebhookKeys(FLOOR)).toBe(0);
  });

  it('the shared purge removes keys past 24 h and reports them', async () => {
    const s = make();
    s.reserveWebhookKey('old', NOW - DAY - 1, 0, FP);
    s.reserveWebhookKey('edge', NOW - DAY, 0, FP);
    const res = await purge(s, NOW);
    expect(res.webhookKeys).toBe(1);
    expect(s.reserveWebhookKey('edge', NOW, 0, FP)).toMatchObject({ reserved: false });
    expect(s.reserveWebhookKey('old', NOW, 0, FP)).toEqual({ reserved: true });
  });

  it('stores the fingerprint with the row and returns it to every later reserve, pending or done', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR, FP);
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP2)).toEqual({ reserved: false, state: 'pending', resultJson: null, fingerprint: FP });
    s.completeWebhookKey('k1', '{"a":1}');
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP2)).toEqual({ reserved: false, state: 'done', resultJson: '{"a":1}', fingerprint: FP });
  });

  it('a reserve that finds a row never overwrites its fingerprint', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR, FP);
    s.reserveWebhookKey('k1', NOW + 1, FLOOR, FP2);
    s.reserveWebhookKey('k1', NOW + 2, FLOOR, FP2);
    expect(s.reserveWebhookKey('k1', NOW + 3, FLOOR, FP2)).toMatchObject({ fingerprint: FP });
  });

  it('an expired row is replaced with the NEW fingerprint', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW - DAY - 1, 0, FP);
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP2)).toEqual({ reserved: true });
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP)).toMatchObject({ reserved: false, fingerprint: FP2 });
  });

  it('release frees the fingerprint with the row', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR, FP);
    s.releaseWebhookKey('k1');
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP2)).toEqual({ reserved: true });
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP)).toMatchObject({ fingerprint: FP2 });
  });

  it('release of a done key is a no-op: the stored result survives', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR, FP);
    s.completeWebhookKey('k1', '{"keep":"me"}');
    expect(s.releaseWebhookKey('k1')).toBe(false);
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP)).toMatchObject({ state: 'done', resultJson: '{"keep":"me"}' });
  });

  it('the 24 h boundary is exact: a row at createdAt = notBefore is live, one millisecond older is free', () => {
    const s = make();
    s.reserveWebhookKey('edge', FLOOR, 0, FP);
    s.reserveWebhookKey('under', FLOOR - 1, 0, FP);
    expect(s.reserveWebhookKey('edge', NOW, FLOOR, FP)).toMatchObject({ reserved: false });
    expect(s.reserveWebhookKey('under', NOW, FLOOR, FP)).toEqual({ reserved: true });
  });

  it('purge is strict: createdAt = before is kept, createdAt = before - 1 goes', () => {
    const s = make();
    s.reserveWebhookKey('at', 5000, 0, FP);
    s.reserveWebhookKey('below', 4999, 0, FP);
    expect(s.purgeWebhookKeys(5000)).toBe(1);
    expect(s.reserveWebhookKey('at', 5000, 0, FP)).toMatchObject({ reserved: false });
    expect(s.reserveWebhookKey('below', 5000, 0, FP)).toEqual({ reserved: true });
  });

  it('complete rolls back with the transaction: the key is pending again and can be completed', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR, FP);
    expect(() =>
      s.transaction(() => {
        expect(s.completeWebhookKey('k1', '{"a":1}')).toBe(true);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP)).toEqual({ reserved: false, state: 'pending', resultJson: null, fingerprint: FP });
    expect(s.completeWebhookKey('k1', '{"a":2}')).toBe(true);
  });

  it('release rolls back with the transaction: the pending key is still held', () => {
    const s = make();
    s.reserveWebhookKey('k1', NOW, FLOOR, FP);
    expect(() =>
      s.transaction(() => {
        expect(s.releaseWebhookKey('k1')).toBe(true);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP2)).toEqual({ reserved: false, state: 'pending', resultJson: null, fingerprint: FP });
  });

  it('purge rolls back with the transaction: the old rows, done and pending, come back', () => {
    const s = make();
    s.reserveWebhookKey('old-done', NOW - 3 * DAY, 0, FP);
    s.completeWebhookKey('old-done', '{"x":1}');
    s.reserveWebhookKey('old-pending', NOW - 3 * DAY, 0, FP2);
    expect(() =>
      s.transaction(() => {
        expect(s.purgeWebhookKeys(FLOOR)).toBe(2);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.reserveWebhookKey('old-done', NOW, 0, FP2)).toEqual({ reserved: false, state: 'done', resultJson: '{"x":1}', fingerprint: FP });
    expect(s.reserveWebhookKey('old-pending', NOW, 0, FP)).toEqual({ reserved: false, state: 'pending', resultJson: null, fingerprint: FP2 });
  });

  it('writes inside a transaction roll back with it', () => {
    const s = make();
    expect(() =>
      s.transaction(() => {
        s.reserveWebhookKey('k1', NOW, FLOOR, FP);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.reserveWebhookKey('k1', NOW, FLOOR, FP)).toEqual({ reserved: true });
  });
  });
}
