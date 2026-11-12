import { describe, expect, it } from 'vitest';
import { errorOf, world } from './world.js';

// The `pace` section over HTTP: the existing /policy/profile routes carry it, with no new route. GET shows it in effective, base and
// layer; PUT accepts layer.pace; a bad value is 400 invalid_profile with the layer path; DELETE ?section=pace resets it.

const OFF = { slowModeMs: null, burst: null, duplicateWindowMs: null };
const PUT = (body: unknown, role: 'owner' | 'senior' | 'moderator' = 'owner', actor = 'owner_ann') => ({ role, actor, body });
const pace = { slowModeMs: 2000, burst: { lines: 5, windowMs: 10_000 }, duplicateWindowMs: 15_000 };

interface ProfileBody {
  effective: { pace: unknown };
  base: { pace: unknown };
  layer: { pace?: unknown };
  version: number;
}

describe('pace over /policy/profile', () => {
  it('GET returns pace in effective, base and layer', async () => {
    const { call } = await world({ overrides: { pace: { duplicateWindowMs: 9000 } } });
    const before = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(before.effective.pace).toEqual({ ...OFF, duplicateWindowMs: 9000 });
    expect(before.base.pace).toEqual({ ...OFF, duplicateWindowMs: 9000 });
    expect(before.layer.pace).toBeUndefined();
    await call('PUT', '/policy/profile', PUT({ layer: { pace: { slowModeMs: 2000 } }, version: 0, reason: 'a quiet room' }));
    const after = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(after.effective.pace).toEqual({ ...OFF, slowModeMs: 2000, duplicateWindowMs: 9000 });
    expect(after.base.pace).toEqual({ ...OFF, duplicateWindowMs: 9000 });
    expect(after.layer.pace).toEqual({ slowModeMs: 2000 });
  });

  it('every staff role reads it', async () => {
    const { call } = await world();
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      const res = await call('GET', '/policy/profile', { role });
      expect((res.body as ProfileBody).effective.pace, role).toEqual(OFF);
    }
  });

  it('PUT /policy/profile with pace: 200 and effective.pace', async () => {
    const { call, cw } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ layer: { pace }, version: 0, reason: 'tournament night' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, version: 1, changed: ['pace'], effective: { pace }, layer: { pace } });
    expect(cw.profile.pace).toEqual(pace);
  });

  it('a PUT is owner only: a senior is 403 and nothing is saved', async () => {
    const { call, cw } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ layer: { pace }, version: 0, reason: 'x' }, 'senior'));
    expect([res.status, errorOf(res)]).toEqual([403, 'forbidden']);
    expect(cw.profile.pace).toEqual(OFF);
  });

  it('409 on a stale version', async () => {
    const { call } = await world();
    await call('PUT', '/policy/profile', PUT({ layer: { pace }, version: 0, reason: 'first' }));
    const res = await call('PUT', '/policy/profile', PUT({ layer: { pace: { slowModeMs: 3000 } }, version: 0, reason: 'second' }));
    expect([res.status, errorOf(res)]).toEqual([409, 'conflict']);
    const body = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(body.effective.pace).toEqual(pace);
  });

  it.each([
    [{ burst: { lines: 1, windowMs: 5000 } }, 'layer.pace.burst.lines'],
    [{ nope: 1 }, 'layer.pace.nope'],
    [{ slowModeMs: 10 }, 'layer.pace.slowModeMs'],
    [{ burst: { lines: 5 } }, 'layer.pace.burst.windowMs'],
  ])('400 invalid_profile with the layer path: %j -> %s', async (bad, path) => {
    const { call, cw, routeAudit } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ layer: { pace: bad }, version: 0, reason: 'x' }));
    expect([res.status, errorOf(res), (res.body as { path: string }).path]).toEqual([400, 'invalid_profile', path]);
    expect(cw.policy.get().version).toBe(0);
    expect(routeAudit()).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('10,');
  });

  it('DELETE ?section=pace resets it, leaving the other sections, and audits policy.reset with sections ["pace"]', async () => {
    const { call, cw, routeAudit } = await world({ overrides: { pace: { slowModeMs: 1500 } } });
    await call('PUT', '/policy/profile', PUT({ layer: { pace, customDuration: false }, version: 0, reason: 'set' }));
    expect(cw.profile.pace).toEqual(pace);
    const res = await call('DELETE', '/policy/profile', { role: 'owner', actor: 'owner_ann', query: { section: 'pace' }, body: { reason: 'back to the default' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, changed: ['pace'] });
    expect(cw.profile.pace).toEqual({ ...OFF, slowModeMs: 1500 });
    expect(cw.profile.customDuration).toBe(false);
    const rows = routeAudit();
    expect(rows.find((r) => r.action === 'policy.reset')).toMatchObject({ action: 'policy.reset', detail: { sections: ['pace'], reason: 'back to the default' } });
  });

  it('a save of only pace is audited policy.update with sections ["pace"] and no values', async () => {
    const { call, routeAudit } = await world();
    await call('PUT', '/policy/profile', PUT({ layer: { pace: { slowModeMs: 123456 } }, version: 0, reason: 'quiet room' }));
    const rows = routeAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'policy.update', detail: { sections: ['pace'], reason: 'quiet room' } });
    expect(JSON.stringify(rows)).not.toContain('123456');
  });

  it('DELETE with an unknown section is still 400 invalid_query', async () => {
    const { call } = await world();
    const res = await call('DELETE', '/policy/profile', { role: 'owner', query: { section: 'pacing' }, body: { reason: 'x' } });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_query']);
  });

  it('the preview route accepts a pace layer and changes nothing', async () => {
    const { call, cw } = await world();
    const res = await call('POST', '/policy/profile/preview', { role: 'moderator', body: { layer: { pace } } });
    expect(res.status).toBe(200);
    expect(cw.profile.pace).toEqual(OFF);
    expect(cw.policy.get().version).toBe(0);
  });
});
