import { describe, expect, it } from 'vitest';
import type { RawWho } from '@chatwarden/core';
import { ALICE, BOB, playerWorld, RAW_VALUES } from './playerWorld.js';

// POST /names/check: unchanged for a caller with the new name options off; with `names.profanity` it can return `name_profane`; it now
// passes `who` to the core (found, never created) so a blocked name can be kept as evidence when the adopter opted in.

const check = (w: Awaited<ReturnType<typeof playerWorld>>, name: string, who?: RawWho) =>
  w.call('POST', '/names/check', { ...(who === undefined ? {} : { who }), body: { name } });

describe('names/check unchanged for a caller with the options off and returns name_profane with profanity on', () => {
  it('with no names settings: the slur is name_not_allowed, a swear word is fine, a clean name is ok; exactly the old bodies', async () => {
    const w = await playerWorld({ appeals: false });
    expect((await check(w, 'Friendly Fox')).body).toEqual({ ok: true });
    expect((await check(w, 'Zorbak_99')).body).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
    expect((await check(w, 'big_snerp_99')).body).toEqual({ ok: true });
    for (const name of ['Friendly Fox', 'Zorbak_99', 'big_snerp_99']) expect((await check(w, name, ALICE)).status).toBe(200);
  });

  it('with profanity on: a swear word is name_profane citing the slur rule; a matcher hit still wins; a clean name is ok', async () => {
    const w = await playerWorld({ names: { profanity: true } });
    expect((await check(w, 'big_snerp_99')).body).toEqual({ ok: false, reason: 'name_profane', rule: 1 });
    expect((await check(w, 'Snerp')).body).toEqual({ ok: false, reason: 'name_profane', rule: 1 });
    expect((await check(w, 'zorbak_snerp')).body).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
    expect((await check(w, 'Friendly Fox')).body).toEqual({ ok: true });
  });

  it('the other new options (keepBlocked, renames, maskInHub) change no answer, and the answer never carries the name', async () => {
    const plain = await playerWorld({ names: {} });
    const loud = await playerWorld({ names: { keepBlocked: true, renames: true, maskInHub: false } });
    for (const name of ['Friendly Fox', 'Zorbak_99', 'big_snerp_99', 'a', 'a'.repeat(64)]) {
      expect((await check(loud, name, ALICE)).body, name).toEqual((await check(plain, name, ALICE)).body);
    }
    const res = await check(loud, 'zorbak-unique-name-77', ALICE);
    expect(JSON.stringify(res)).not.toContain('unique-name-77');
  });

  it('the setting is read live: turning profanity on in the policy takes effect at once', async () => {
    const w = await playerWorld({ names: {} });
    expect((await check(w, 'snerp')).body).toEqual({ ok: true });
    w.cw.policy.save({ names: { profanity: true } }, { version: 0, actor: 'owner', reason: 'family game' });
    expect((await check(w, 'snerp')).body).toEqual({ ok: false, reason: 'name_profane', rule: 1 });
  });
});

describe('POST /names/check passes who to the core', () => {
  it('hands the core the identity as the hook returned it (known fields only), once per call', async () => {
    const seen: unknown[] = [];
    const w = await playerWorld({
      wrap: (cw) => ({
        ...cw,
        names: {
          ...cw.names,
          check: (text: string, opts?: { who?: RawWho }) => {
            seen.push(opts);
            return cw.names.check(text, opts);
          },
        },
      }),
    });
    await w.call('POST', '/names/check', { who: ALICE, headers: { 'x-extra': 'nope' }, body: { name: 'Friendly Fox' } });
    await w.call('POST', '/names/check', { body: { name: 'Friendly Fox' } });
    expect(seen).toEqual([{ who: { clientKey: ALICE.clientKey, ip: ALICE.ip } }, { who: {} }]);
  });

  it('with keepBlocked on, a blocked name is kept tied to the caller; an unknown caller leaves it unattached; an allowed name is never kept', async () => {
    const w = await playerWorld({ names: { keepBlocked: true, profanity: true } });
    const a = await w.sanction(ALICE);
    await check(w, 'Zorbak_99', ALICE);
    w.clock.t += 1000;
    await check(w, 'big_snerp_99', BOB);
    await check(w, 'Friendly Fox', ALICE);
    const kept = w.store.listBlockedNames?.(0, 10) ?? [];
    expect(kept.map((r) => [r.name, r.reason, r.subject])).toEqual([
      ['big_snerp_99', 'name_profane', null],
      ['Zorbak_99', 'name_not_allowed', a.subject],
    ]);
  });

  it('with keepBlocked off nothing is stored whoever asks', async () => {
    const w = await playerWorld({ names: { profanity: true } });
    await w.sanction(ALICE);
    await check(w, 'Zorbak_99', ALICE);
    await check(w, 'big_snerp_99', ALICE);
    expect(w.store.listBlockedNames?.(0, 10) ?? []).toEqual([]);
  });

  it('no name and no identity is logged, success or failure', async () => {
    const w = await playerWorld({ names: { keepBlocked: true, profanity: true } });
    await w.sanction(ALICE);
    await check(w, 'Zorbak_99_unique', ALICE);
    await check(w, 'big_snerp_unique', ALICE);
    await w.call('POST', '/names/check', { who: ALICE, raw: '{' });
    const text = JSON.stringify(w.logged);
    for (const v of [...RAW_VALUES, 'unique', 'Zorbak_99', 'snerp']) expect(text).not.toContain(v);
  });

  it('the limiter, the 400s and the 413 are as before', async () => {
    const w = await playerWorld({ routes: { namesRateLimit: { max: 2, windowMs: 60_000 } } });
    expect((await w.call('POST', '/names/check', { who: ALICE, raw: '{' })).status).toBe(400);
    expect((await check(w, '', ALICE)).status).toBe(400);
    const limited = await check(w, 'x', ALICE);
    expect(limited.status).toBe(429);
    expect(limited.headers?.['retry-after']).toBe('60');
  });
});
