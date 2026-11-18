import { describe, expect, it } from 'vitest';
import { buildMatcher } from '@chatwarden/matcher';
import { ALICE, playerWorld } from './playerWorld.js';

// M6: `POST /names/check` takes `kind` ('player' or 'entity') and answers `name_reserved`. The matcher here is the real one (its `matchReserved` is what decides); synthetic terms only.

const real = buildMatcher([{ id: 'syn:zorbak', term: 'zorbak', language: 'en', active: true }], []);
const reserved = { names: { reserved: ['admin', 'game master'], reservedAllow: ['Admin Ann'] } };
const world = (over: Record<string, unknown> = {}) => playerWorld({ matcher: real, ...reserved, ...over });
type World = Awaited<ReturnType<typeof world>>;
const check = (w: World, body: unknown) => w.call('POST', '/names/check', { who: ALICE, body });

describe('kind', () => {
  it('player, entity and no kind are the same checks: the slur is name_not_allowed in each', async () => {
    const w = await world();
    for (const body of [{ name: 'Zorbak Clan' }, { name: 'Zorbak Clan', kind: 'player' }, { name: 'Zorbak Clan', kind: 'entity' }]) {
      expect((await check(w, body)).body, JSON.stringify(body)).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
    }
    expect((await check(w, { name: 'Blue Wolves', kind: 'entity' })).body).toEqual({ ok: true });
  });

  it('an unknown kind, and a kind that is not text, are 400 invalid_request', async () => {
    const w = await world();
    for (const kind of ['clan', 'Player', '', 'entity ', 5, null, true, {}, ['entity']]) {
      const res = await check(w, { name: 'Blue Wolves', kind });
      expect(res.status, JSON.stringify(kind)).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_request' });
    }
  });

  it('the kind is checked after the limit (malformed requests count) and before the kit is asked', async () => {
    const w = await world({ routes: { namesRateLimit: { max: 2, windowMs: 60_000 } } });
    expect((await check(w, { name: 'x', kind: 'nope' })).status).toBe(400);
    expect((await check(w, { name: 'x', kind: 'nope' })).status).toBe(400);
    expect((await check(w, { name: 'x' })).status).toBe(429);
  });

  it('a name that is missing or too long is still 400, with or without a kind', async () => {
    const w = await world();
    for (const body of [{ kind: 'entity' }, { name: '', kind: 'entity' }, { name: 'x'.repeat(65), kind: 'entity' }, { name: 5, kind: 'entity' }]) {
      expect((await check(w, body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('name_reserved', () => {
  it('a reserved name answers name_reserved with the reservedRule and nothing else, for a player and for an entity', async () => {
    const w = await world();
    for (const body of [{ name: 'Admin_Anna' }, { name: 'G4me_Master', kind: 'player' }, { name: 'The Admin Guild', kind: 'entity' }]) {
      expect((await check(w, body)).body, JSON.stringify(body)).toEqual({ ok: false, reason: 'name_reserved', rule: 2 });
    }
    expect((await check(await world({ names: { ...reserved.names, reservedRule: 4 } }), { name: 'Admin' })).body).toEqual({ ok: false, reason: 'name_reserved', rule: 4 });
  });

  it('the slur comes first, an allowed name passes, and a clean name is ok', async () => {
    const w = await world();
    expect((await check(w, { name: 'Admin Zorbak' })).body).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
    expect((await check(w, { name: 'Admin Ann' })).body).toEqual({ ok: true });
    expect((await check(w, { name: 'Anna' })).body).toEqual({ ok: true });
    expect((await check(w, { name: 'xXadminXx' })).body).toEqual({ ok: true });
  });

  it('a player cannot skip the reserved check: skipReserved in the body is ignored', async () => {
    const w = await world();
    expect((await check(w, { name: 'Admin', skipReserved: true })).body).toEqual({ ok: false, reason: 'name_reserved', rule: 2 });
    expect((await check(w, { name: 'Admin', kind: 'entity', skipReserved: true })).body).toEqual({ ok: false, reason: 'name_reserved', rule: 2 });
  });

  it('the answer never carries the name or an entry, and no log line does', async () => {
    const w = await world({ names: { reserved: ['SECRET-STAFF-ENTRY'] } });
    const res = await check(w, { name: 'SECRET-STAFF-ENTRY_Anna', kind: 'entity' });
    expect(res.body).toEqual({ ok: false, reason: 'name_reserved', rule: 2 });
    expect(JSON.stringify([res, w.logged])).not.toContain('SECRET');
  });

  it('with nothing reserved the route answers exactly what it did before', async () => {
    const w = await playerWorld({ matcher: real, names: {} });
    expect((await check(w, { name: 'Admin' })).body).toEqual({ ok: true });
    expect((await check(w, { name: 'Admin', kind: 'entity' })).body).toEqual({ ok: true });
  });

  it('the kit is handed the kind and no skipReserved', async () => {
    const seen: unknown[] = [];
    const w = await world({
      wrap: (cw: import('@chatwarden/core').Chatwarden) => ({
        ...cw,
        names: { ...cw.names, check: (text: string, opts?: unknown) => (seen.push(opts), cw.names.check(text, opts as never)) },
      }),
    });
    await check(w, { name: 'Blue', kind: 'entity', skipReserved: true });
    await check(w, { name: 'Blue' });
    expect(seen).toHaveLength(2);
    expect((seen[0] as { kind?: string }).kind).toBe('entity');
    expect(Object.hasOwn(seen[0] as object, 'skipReserved')).toBe(false);
    expect((seen[1] as { kind?: string }).kind).toBeUndefined();
  });
});
