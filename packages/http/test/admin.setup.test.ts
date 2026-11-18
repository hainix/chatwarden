import { describe, expect, it } from 'vitest';
import { createChatwarden, GAME_KINDS, PRESETS, recommendFor } from '@chatwarden/core';
import type { RawWho } from '@chatwarden/core';
import { adminRoutes, createRouter, PERMISSION_KEYS } from '../src/index.js';
import type { Role } from '../src/index.js';
import { errorOf, SECRET, world } from './world.js';

// The first-run setup routes (0.2.2): GET /setup, POST /setup/dismiss, POST /setup/apply. Owner-only IN CODE (a permission override cannot lower them), not
// scope-aware, no-store. Apply answers exactly as PUT /policy/profile does and audits policy.update.

type W = Awaited<ReturnType<typeof world>>;
const OWNER = { role: 'owner' as const, actor: 'owner_ann' };
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface SetupBody {
  show: boolean;
  dismissedAt: number | null;
  persists: boolean;
  version: number;
  options: Array<{ game: string; preset: string; layer: Record<string, unknown> }>;
}
interface ApplyBody {
  ok: true;
  changed: string[];
  effective: Record<string, unknown> & { teamNotes: Array<{ text: string }> };
  base: unknown;
  layer: { guidelines: { tiers: unknown[] } } & Record<string, unknown>;
  version: number;
  canSave: boolean;
  limits: unknown;
  promptExcluded: unknown;
}

/** A store that cannot save settings: the kit then answers as it does for a custom store written before settings existed. */
const cannotSave = (store: { loadPolicyLayer?: unknown; savePolicyLayer?: unknown }): void => {
  Object.defineProperty(store, 'loadPolicyLayer', { value: undefined, configurable: true });
  Object.defineProperty(store, 'savePolicyLayer', { value: undefined, configurable: true });
};

const setup = async (w: W, o: { role?: Role | null; scope?: readonly string[] } = { role: 'owner' }) => w.call('GET', '/setup', { actor: 'owner_ann', ...o });
const rows = (w: W) => w.routeAudit().filter((r) => r.action === 'policy.update');

describe('GET /setup', () => {
  it('the owner gets show true, dismissedAt null, persists true, version 0 and four options in order, each { game, preset, layer }', async () => {
    const w = await world();
    const res = await setup(w);
    expect(res.status).toBe(200);
    expect(res.headers?.['cache-control']).toBe('no-store');
    const body = res.body as SetupBody;
    expect(Object.keys(body).sort()).toEqual(['dismissedAt', 'options', 'persists', 'show', 'version']);
    expect(body).toMatchObject({ show: true, dismissedAt: null, persists: true, version: 0 });
    expect(body.options.map((o) => o.game)).toEqual(['competitive', 'social', 'kids', 'creator']);
    expect(body.options.map((o) => o.preset)).toEqual(['relaxed', 'standard', 'strict', 'standard']);
    for (const o of body.options) {
      expect(Object.keys(o).sort()).toEqual(['game', 'layer', 'preset']);
      expect(o.layer).toEqual(json(recommendFor(o.game as (typeof GAME_KINDS)[number]).layer));
      expect(Array.isArray((o.layer.guidelines as { tiers: unknown[] }).tiers)).toBe(true);
      expect(Object.hasOwn(o.layer, 'teamNotes'), o.game).toBe(o.game === 'creator');
    }
    expect(w.routeAudit()).toEqual([]);
  });

  it('is the stored version, read after a refresh (a layer another process saved shows show false and its version at once)', async () => {
    const w = await world();
    w.store.savePolicyLayer({ customDuration: false }, 0);
    const body = (await setup(w)).body as SetupBody;
    expect(body).toMatchObject({ show: false, version: 1, options: [] });
  });
});

describe('permission boundaries: owner only, in code, not scope-aware', () => {
  const CALLS = [
    ['GET /setup', 'GET', '/setup', undefined],
    ['POST /setup/dismiss', 'POST', '/setup/dismiss', {}],
    ['POST /setup/apply', 'POST', '/setup/apply', { game: 'social', version: 0 }],
  ] as const;

  it.each(CALLS)('%s: a senior and a moderator get 403 forbidden, no authz 401, and nothing is written', async (_n, method, path, body) => {
    const w = await world();
    for (const role of ['moderator', 'senior'] as const) {
      const res = await w.call(method, path, { role, ...(body === undefined ? {} : { body }) });
      expect([res.status, errorOf(res)], role).toEqual([403, 'forbidden']);
    }
    expect((await w.call(method, path, { role: null, ...(body === undefined ? {} : { body }) })).status).toBe(401);
    expect(w.cw.policy.get().version).toBe(0);
    expect(w.cw.policy.setup().show).toBe(true);
    expect(w.routeAudit()).toEqual([]);
    const ok = await w.call(method, path, { ...OWNER, ...(body === undefined ? {} : { body }) });
    expect(ok.status).toBe(200);
  });

  it.each(CALLS)('%s: still 403 for a senior and a moderator in a world that lowered every permission to moderator', async (_n, method, path, body) => {
    const lowered = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'moderator'])) as Record<string, Role>;
    const w = await world({ permissions: lowered });
    for (const role of ['moderator', 'senior'] as const) {
      const res = await w.call(method, path, { role, ...(body === undefined ? {} : { body }) });
      expect([res.status, errorOf(res)], role).toEqual([403, 'forbidden']);
    }
    expect(w.cw.policy.get().version).toBe(0);
  });

  it.each(CALLS)('%s: a scoped caller (a scope is only valid on a moderator or senior) is 403 forbidden, even where every permission is lowered', async (_n, method, path, body) => {
    const lowered = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'moderator'])) as Record<string, Role>;
    const w = await world({ permissions: lowered });
    for (const role of ['moderator', 'senior'] as const) {
      const res = await w.call(method, path, { role, scope: ['team-a'], ...(body === undefined ? {} : { body }) });
      expect([res.status, errorOf(res)], role).toEqual([403, 'forbidden']);
    }
    expect(w.cw.policy.get().version).toBe(0);
    expect(w.routeAudit()).toEqual([]);
  });

  it.each(CALLS.filter((c) => c[1] === 'POST'))('%s: authorization comes before body validation', async (_n, method, path) => {
    const w = await world();
    expect((await w.call(method, path, { role: 'moderator', raw: '{nope' })).status).toBe(403);
    expect((await w.call(method, path, { role: null, raw: '{nope' })).status).toBe(401);
  });
});

describe('what hides the panel', () => {
  it('after a policy save the same GET has show false and options []', async () => {
    const w = await world();
    expect(((await setup(w)).body as SetupBody).show).toBe(true);
    expect((await w.call('PUT', '/policy/profile', { ...OWNER, body: { layer: { customDuration: false }, version: 0, reason: 'tune' } })).status).toBe(200);
    expect((await setup(w)).body).toMatchObject({ show: false, version: 1, options: [] });
  });

  it('a dismiss hides it too', async () => {
    const w = await world();
    await w.call('POST', '/setup/dismiss', { ...OWNER, body: {} });
    expect((await setup(w)).body).toMatchObject({ show: false, version: 0, options: [] });
  });

  it('a kit over a store that cannot save settings has show false and no options', async () => {
    const w = await world({ editStore: cannotSave });
    expect((await setup(w)).body).toMatchObject({ show: false, version: 0, options: [] });
  });
});

describe('POST /setup/dismiss', () => {
  it('answers 200 { ok: true, show: false, dismissedAt, persists: true }, no-store, and writes no audit row', async () => {
    const w = await world();
    const res = await w.call('POST', '/setup/dismiss', { ...OWNER, body: {} });
    expect(res.status).toBe(200);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ ok: true, show: false, dismissedAt: w.clock.t, persists: true });
    expect(w.routeAudit()).toEqual([]);
    expect(w.cw.policy.get().version).toBe(0);
  });

  it('an absent body and an empty one are both fine; the first dismissal keeps its time', async () => {
    const w = await world();
    const first = await w.call('POST', '/setup/dismiss', OWNER);
    expect(first.status).toBe(200);
    const at = (first.body as { dismissedAt: number }).dismissedAt;
    w.clock.t += 5000;
    const second = await w.call('POST', '/setup/dismiss', { ...OWNER, body: {} });
    expect(second.body).toEqual({ ok: true, show: false, dismissedAt: at, persists: true });
  });

  it('is persisted: a second app over the same store still shows false', async () => {
    const w = await world();
    await w.call('POST', '/setup/dismiss', { ...OWNER, body: {} });
    const cw2 = await createChatwarden({ store: w.store, secret: SECRET, platform: { identify: (ctx) => ctx as RawWho }, clock: w.clock, retention: false });
    const router = createRouter(adminRoutes(cw2, { authorize: () => ({ actor: 'owner_ann', role: 'owner' }) }));
    const res = await router({ method: 'GET', path: '/setup', query: {}, headers: {}, body: undefined });
    expect(res.body).toMatchObject({ show: false, persists: true, options: [] });
    expect((res.body as SetupBody).dismissedAt).not.toBeNull();
  });

  it('any extra key is 400 invalid_request and dismisses nothing; a body that is not an object is too', async () => {
    const w = await world();
    for (const body of [{ x: 1 }, { game: 'kids' }, { dismissedAt: 5 }]) {
      const res = await w.call('POST', '/setup/dismiss', { ...OWNER, body });
      expect([res.status, errorOf(res)], JSON.stringify(body)).toEqual([400, 'invalid_request']);
    }
    for (const raw of ['[]', '5', '"x"', '{nope']) {
      expect((await w.call('POST', '/setup/dismiss', { ...OWNER, raw })).status, raw).toBe(400);
    }
    expect(w.cw.policy.setup().show).toBe(true);
  });
});

describe('POST /setup/apply', () => {
  const apply = (w: W, body: unknown, o: { role?: Role; actor?: string } = {}) => w.call('POST', '/setup/apply', { ...OWNER, ...o, body });

  it("{ game: 'kids', version: 0 }: 200, the strict preset in force, whole-form guidelines stored, version 1, one policy.update row with the default reason", async () => {
    const w = await world();
    const res = await apply(w, { game: 'kids', version: 0 });
    expect(res.status).toBe(200);
    expect(res.headers?.['cache-control']).toBe('no-store');
    const body = res.body as ApplyBody;
    expect(Object.keys(body).sort()).toEqual(['base', 'canSave', 'changed', 'effective', 'layer', 'limits', 'ok', 'promptExcluded', 'version']);
    expect(body.ok).toBe(true);
    // the ladder is shared by the three presets: stored, but not listed
    expect(body.changed).toEqual(['firstOffense', 'repeat', 'guidelines', 'aiContext']);
    expect(body.version).toBe(1);
    expect(body.canSave).toBe(true);
    for (const k of ['ladder', 'firstOffense', 'repeat', 'guidelines', 'aiContext'] as const) expect(body.effective[k], k).toEqual(json(PRESETS.strict[k]));
    expect(Array.isArray(body.layer.guidelines.tiers)).toBe(true);
    expect(body.layer.guidelines.tiers).toEqual(json(PRESETS.strict.guidelines));
    expect(Object.keys(body.layer).sort()).toEqual(['aiContext', 'firstOffense', 'guidelines', 'ladder', 'repeat']);
    expect(rows(w)).toEqual([
      {
        id: expect.any(String),
        at: w.clock.t,
        actor: 'owner_ann',
        role: 'owner',
        action: 'policy.update',
        detail: { sections: ['firstOffense', 'repeat', 'guidelines', 'aiContext'], reason: 'Applied the recommended principles for kids games' },
      },
    ]);
    // the state the answer carries is what GET /policy/profile says now
    const state = (await w.call('GET', '/policy/profile', OWNER)).body as Record<string, unknown>;
    expect(state.effective).toEqual(body.effective);
    expect(state.layer).toEqual(body.layer);
    expect(state.promptExcluded).toEqual(body.promptExcluded);
  });

  it('a reason in the body is the one recorded, and the actor is who the auth hook says', async () => {
    const w = await world();
    expect((await apply(w, { game: 'competitive', version: 0, reason: 'Our league is competitive' }, { actor: 'owner_zed' })).status).toBe(200);
    expect(rows(w)).toHaveLength(1);
    expect(rows(w)[0]).toMatchObject({ actor: 'owner_zed', detail: { reason: 'Our league is competitive' } });
    expect((rows(w)[0]!.detail as { sections: string[] }).sections).toEqual(expect.arrayContaining(['guidelines', 'aiContext']));
  });

  it('every game applies over the default profile: the recommended preset is in force', async () => {
    for (const game of GAME_KINDS) {
      const w = await world();
      const res = await apply(w, { game, version: 0 });
      expect(res.status, game).toBe(200);
      const want = PRESETS[recommendFor(game).preset];
      const eff = (res.body as ApplyBody).effective;
      for (const k of ['ladder', 'firstOffense', 'repeat', 'guidelines', 'aiContext'] as const) expect(eff[k], `${game} ${k}`).toEqual(json(want[k]));
    }
  });

  it("creator: the note is in effective.teamNotes and in GET /policy's moderator guide under Team notes; the other three games leave teamNotes empty", async () => {
    const w = await world();
    const res = await apply(w, { game: 'creator', version: 0 });
    expect((res.body as ApplyBody).effective.teamNotes.map((n) => n.text)).toEqual(['Protect the creator and their guests from targeted abuse']);
    expect((res.body as ApplyBody).changed).toEqual(['teamNotes']);
    const policy = (await w.call('GET', '/policy', OWNER)).body as { documents: { moderatorGuide: string }; profile: { teamNotes: Array<{ text: string }> } };
    expect(policy.documents.moderatorGuide).toContain('Team notes');
    expect(policy.documents.moderatorGuide).toContain('Protect the creator and their guests from targeted abuse');
    expect(policy.profile.teamNotes).toEqual([{ text: 'Protect the creator and their guests from targeted abuse' }]);
    for (const game of ['competitive', 'social', 'kids'] as const) {
      const other = await world();
      const body = (await apply(other, { game, version: 0 })).body as ApplyBody;
      expect(body.effective.teamNotes, game).toEqual([]);
      const guide = ((await other.call('GET', '/policy', OWNER)).body as { documents: { moderatorGuide: string } }).documents.moderatorGuide;
      expect(guide, game).not.toContain('Team notes');
    }
  });

  it('keeps another section of an existing layer', async () => {
    const w = await world();
    await w.call('PUT', '/policy/profile', { ...OWNER, body: { layer: { reporting: { thanks: 'Thanks for telling us' } }, version: 0, reason: 'seed' } });
    const before = ((await w.call('GET', '/policy/profile', OWNER)).body as { layer: { reporting: unknown } }).layer.reporting;
    const res = await apply(w, { game: 'kids', version: 1 });
    expect(res.status).toBe(200);
    const body = res.body as ApplyBody;
    expect(body.version).toBe(2);
    expect(body.layer.reporting).toEqual(before);
    expect(body.changed).not.toContain('reporting');
    expect(body.effective.guidelines).toEqual(json(PRESETS.strict.guidelines));
  });

  it('after apply the first-run state is show false', async () => {
    const w = await world();
    await apply(w, { game: 'social', version: 0 });
    expect((await setup(w)).body).toMatchObject({ show: false, version: 1, options: [] });
  });

  it('a stale version is 409 conflict and writes nothing (version unchanged, no audit row)', async () => {
    const w = await world();
    await w.call('PUT', '/policy/profile', { ...OWNER, body: { layer: { customDuration: false }, version: 0, reason: 'seed' } });
    const before = rows(w).length;
    for (const version of [0, 5]) {
      const res = await apply(w, { game: 'kids', version });
      expect([res.status, errorOf(res)], String(version)).toEqual([409, 'conflict']);
    }
    expect(w.cw.policy.get().version).toBe(1);
    expect(w.cw.policy.get().layer).toEqual({ customDuration: false });
    expect(rows(w)).toHaveLength(before);
  });

  it('an unknown game, a missing game, a non-number or negative version, a blank reason and an extra key are 400 invalid_request, and nothing is written', async () => {
    const w = await world();
    const bad: unknown[] = [
      { game: 'nope', version: 0 },
      { game: 'Kids', version: 0 },
      { version: 0 },
      { game: 5, version: 0 },
      { game: null, version: 0 },
      { game: 'kids' },
      { game: 'kids', version: '0' },
      { game: 'kids', version: -1 },
      { game: 'kids', version: 1.5 },
      { game: 'kids', version: 0, reason: '   ' },
      { game: 'kids', version: 0, reason: 5 },
      { game: 'kids', version: 0, actor: 'someone_else' },
      { game: 'kids', version: 0, layer: {} },
      {},
    ];
    for (const body of bad) {
      const res = await apply(w, body);
      expect([res.status, errorOf(res)], JSON.stringify(body)).toEqual([400, 'invalid_request']);
    }
    for (const raw of ['[]', '5', '{nope']) expect((await w.call('POST', '/setup/apply', { ...OWNER, raw })).status, raw).toBe(400);
    expect(w.cw.policy.get().version).toBe(0);
    expect(rows(w)).toEqual([]);
  });

  it('over a store that cannot save it is 501 not_supported, with no audit row', async () => {
    const w = await world({ editStore: cannotSave });
    const res = await apply(w, { game: 'kids', version: 0 });
    expect([res.status, errorOf(res)]).toEqual([501, 'not_supported']);
    expect(rows(w)).toEqual([]);
  });

  it('a creator apply over a layer with 30 notes is 400 invalid_profile at layer.teamNotes', async () => {
    const w = await world();
    const notes = Array.from({ length: 30 }, (_, i) => ({ text: `note ${i}` }));
    await w.call('PUT', '/policy/profile', { ...OWNER, body: { layer: { teamNotes: notes }, version: 0, reason: 'seed' } });
    const res = await apply(w, { game: 'creator', version: 1 });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_profile']);
    expect(res.body).toMatchObject({ path: 'layer.teamNotes' });
    expect(w.cw.policy.get().version).toBe(1);
  });

  it('does not take the permission policy.write: a world that lowers it to moderator still keeps apply owner-only', async () => {
    const w = await world({ permissions: { 'policy.write': 'moderator' } });
    expect((await apply(w, { game: 'kids', version: 0 }, { role: 'moderator' })).status).toBe(403);
    expect((await apply(w, { game: 'kids', version: 0 })).status).toBe(200);
  });
});
