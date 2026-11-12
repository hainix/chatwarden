import { describe, expect, it } from 'vitest';
import { errorOf, world } from './world.js';

// The `appeals` and `names` sections over HTTP: the existing /policy/profile routes carry them, with no new route. GET shows them in
// effective, base and layer; PUT accepts layer.appeals and layer.names; a bad value is 400 invalid_profile with the layer path;
// DELETE ?section= resets one.

const APPEALS_OFF = { enabled: false, perPlayerPerWeek: 3, allowSelfReview: false };
const NAMES_OFF = { profanity: false, keepBlocked: false, renames: false, maskInHub: true };
const PUT = (body: unknown, role: 'owner' | 'senior' | 'moderator' = 'owner', actor = 'owner_ann') => ({ role, actor, body });

interface ProfileBody {
  effective: { appeals: unknown; names: unknown };
  base: { appeals: unknown; names: unknown };
  layer: { appeals?: unknown; names?: unknown };
  version: number;
}

describe('appeals and names over /policy/profile', () => {
  it('GET returns both in effective, base and layer, off by default', async () => {
    const { call } = await world();
    const before = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(before.effective.appeals).toEqual(APPEALS_OFF);
    expect(before.effective.names).toEqual(NAMES_OFF);
    expect(before.base.appeals).toEqual(APPEALS_OFF);
    expect(before.layer.appeals).toBeUndefined();
    expect(before.layer.names).toBeUndefined();
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      const res = await call('GET', '/policy/profile', { role });
      expect((res.body as ProfileBody).effective.appeals, role).toEqual(APPEALS_OFF);
    }
  });

  it('PUT /policy/profile with appeals and names: 200, effective and layer show them, and a code value is the base', async () => {
    const { call, cw } = await world({ overrides: { appeals: { perPlayerPerWeek: 6 } } });
    const res = await call('PUT', '/policy/profile', PUT({ layer: { appeals: { enabled: true }, names: { renames: true } }, version: 0, reason: 'open the inbox' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      version: 1,
      changed: ['appeals', 'names'],
      effective: { appeals: { enabled: true, perPlayerPerWeek: 6, allowSelfReview: false }, names: { ...NAMES_OFF, renames: true } },
      layer: { appeals: { enabled: true }, names: { renames: true } },
    });
    expect((res.body as ProfileBody).base.appeals).toEqual({ ...APPEALS_OFF, perPlayerPerWeek: 6 });
    expect(cw.profile.appeals.enabled).toBe(true);
  });

  it('a PUT is owner only: a senior is 403 and nothing is saved', async () => {
    const { call, cw } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ layer: { appeals: { enabled: true } }, version: 0, reason: 'x' }, 'senior'));
    expect([res.status, errorOf(res)]).toEqual([403, 'forbidden']);
    expect(cw.profile.appeals).toEqual(APPEALS_OFF);
  });

  it('409 on a stale version', async () => {
    const { call } = await world();
    await call('PUT', '/policy/profile', PUT({ layer: { appeals: { enabled: true } }, version: 0, reason: 'first' }));
    const res = await call('PUT', '/policy/profile', PUT({ layer: { names: { renames: true } }, version: 0, reason: 'second' }));
    expect([res.status, errorOf(res)]).toEqual([409, 'conflict']);
    const body = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(body.effective.names).toEqual(NAMES_OFF);
    expect(body.effective.appeals).toMatchObject({ enabled: true });
  });

  it.each([
    [{ appeals: { perPlayerPerWeek: 21 } }, 'layer.appeals.perPlayerPerWeek'],
    [{ appeals: { perPlayerPerWeek: 0 } }, 'layer.appeals.perPlayerPerWeek'],
    [{ appeals: { enabled: 'yes' } }, 'layer.appeals.enabled'],
    [{ appeals: { nope: 1 } }, 'layer.appeals.nope'],
    [{ names: { renames: 1 } }, 'layer.names.renames'],
    [{ names: { nope: true } }, 'layer.names.nope'],
  ])('400 invalid_profile with the layer path: %j -> %s', async (layer, path) => {
    const { call, cw, routeAudit } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ layer, version: 0, reason: 'x' }));
    expect([res.status, errorOf(res), (res.body as { path: string }).path]).toEqual([400, 'invalid_profile', path]);
    expect(cw.policy.get().version).toBe(0);
    expect(routeAudit()).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('21');
  });

  it('DELETE ?section=appeals and names reset, leaving the other sections, and audit policy.reset with the section', async () => {
    const { call, cw, routeAudit } = await world({ overrides: { appeals: { perPlayerPerWeek: 5 }, names: { profanity: true } } });
    await call('PUT', '/policy/profile', PUT({ layer: { appeals: { enabled: true }, names: { profanity: false }, customDuration: false }, version: 0, reason: 'set' }));
    expect(cw.profile.appeals.enabled).toBe(true);
    expect(cw.profile.names.profanity).toBe(false);
    const a = await call('DELETE', '/policy/profile', { role: 'owner', actor: 'owner_ann', query: { section: 'appeals' }, body: { reason: 'back to the default' } });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ ok: true, changed: ['appeals'] });
    expect(cw.profile.appeals).toEqual({ ...APPEALS_OFF, perPlayerPerWeek: 5 });
    expect(cw.profile.names.profanity).toBe(false);
    const n = await call('DELETE', '/policy/profile', { role: 'owner', actor: 'owner_ann', query: { section: 'names' }, body: { reason: 'and the names' } });
    expect(n.body).toMatchObject({ ok: true, changed: ['names'] });
    expect(cw.profile.names).toEqual({ ...NAMES_OFF, profanity: true });
    expect(cw.profile.customDuration).toBe(false);
    const resets = routeAudit().filter((r) => r.action === 'policy.reset');
    expect(resets).toHaveLength(2);
    expect(resets.map((r) => r.detail)).toEqual(expect.arrayContaining([
      { sections: ['appeals'], reason: 'back to the default' },
      { sections: ['names'], reason: 'and the names' },
    ]));
  });

  it('a save of only appeals is audited policy.update with sections ["appeals"] and no values', async () => {
    const { call, routeAudit } = await world();
    await call('PUT', '/policy/profile', PUT({ layer: { appeals: { perPlayerPerWeek: 17 } }, version: 0, reason: 'a bigger cap' }));
    const rows = routeAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'policy.update', detail: { sections: ['appeals'], reason: 'a bigger cap' } });
    expect(JSON.stringify(rows)).not.toContain('17');
  });

  it('the preview route accepts both sections and changes nothing', async () => {
    const { call, cw } = await world();
    const res = await call('POST', '/policy/profile/preview', { role: 'moderator', body: { layer: { appeals: { enabled: true }, names: { renames: true } } } });
    expect(res.status).toBe(200);
    expect(cw.profile.appeals.enabled).toBe(false);
    expect(cw.policy.get().version).toBe(0);
  });

  it('DELETE with a section that is not one is still 400 invalid_query', async () => {
    const { call } = await world();
    const res = await call('DELETE', '/policy/profile', { role: 'owner', query: { section: 'appeal' }, body: { reason: 'x' } });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_query']);
  });
});
