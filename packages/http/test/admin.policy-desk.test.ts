import { describe, expect, it } from 'vitest';
import { errorOf, world } from './world.js';

// The `desk`, `safety` and `rooms` sections over HTTP: the existing /policy/profile routes carry them, with no new route.

const DESK_OFF = { workflow: false, insights: false, surge: { enabled: false, reports: 5, windowMinutes: 10, newAccountDays: 2 } };
const ROOMS_OFF = { defaultModeMs: 1_800_000, emergency: { slowModeMs: 30_000, newAccountDays: 7 }, probation: { enabled: false, ageDays: 2, slowModeMs: 5000 }, unknownAge: 'allow' };
const PUT = (body: unknown, role: 'owner' | 'senior' | 'moderator' = 'owner', actor = 'owner_ann') => ({ role, actor, body });
const layer = {
  desk: { workflow: true, surge: { enabled: true, reports: 8 } },
  safety: { contact: 'Ask Ann on the studio line', resources: [{ label: 'Crisis line', url: 'https://help.example.com' }] },
  rooms: { emergency: { slowModeMs: 2000 } },
};

interface ProfileBody {
  effective: { desk: unknown; safety: { guidance: string; contact: string }; rooms: unknown };
  base: { desk: unknown; rooms: unknown };
  layer: Record<string, unknown>;
  version: number;
}

describe('desk, safety and rooms over /policy/profile', () => {
  it('GET returns the three in effective and base and none in an empty layer', async () => {
    const { call } = await world();
    const body = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(body.effective.desk).toEqual(DESK_OFF);
    expect(body.effective.rooms).toEqual(ROOMS_OFF);
    expect(body.effective.safety.contact).toBe('');
    expect(body.effective.safety.guidance.length).toBeGreaterThan(100);
    expect(body.base.desk).toEqual(DESK_OFF);
    expect(Object.keys(body.layer)).toEqual([]);
  });

  it('PUT with the three sections: 200, changed in section order, effective reads them', async () => {
    const { call, cw } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ layer, version: 0, reason: 'set up the desk' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, version: 1, changed: ['desk', 'safety', 'rooms'], layer });
    expect(cw.profile.desk.workflow).toBe(true);
    expect(cw.profile.desk.surge).toMatchObject({ enabled: true, reports: 8 });
    expect(cw.profile.rooms.emergency.slowModeMs).toBe(2000);
    expect(cw.profile.safety.resources).toEqual([{ label: 'Crisis line', detail: '', url: 'https://help.example.com' }]);
  });

  it('a PUT is owner only: a senior is 403 and nothing is saved', async () => {
    const { call, cw } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ layer, version: 0, reason: 'x' }, 'senior'));
    expect([res.status, errorOf(res)]).toEqual([403, 'forbidden']);
    expect(cw.profile.desk).toEqual(DESK_OFF);
  });

  it('409 on a stale version', async () => {
    const { call, cw } = await world();
    await call('PUT', '/policy/profile', PUT({ layer: { desk: { insights: true } }, version: 0, reason: 'first' }));
    const res = await call('PUT', '/policy/profile', PUT({ layer: { desk: { workflow: true } }, version: 0, reason: 'second' }));
    expect([res.status, errorOf(res)]).toEqual([409, 'conflict']);
    expect(cw.profile.desk.workflow).toBe(false);
  });

  it.each([
    [{ rooms: { emergency: { slowModeMs: 999 } } }, 'layer.rooms.emergency.slowModeMs'],
    [{ desk: { surge: { reports: 2 } } }, 'layer.desk.surge.reports'],
    [{ safety: { resources: [{ label: 'x', url: 'http://zorbak.example/' }] } }, 'layer.safety.resources[0].url'],
    [{ safety: { contact: 'c'.repeat(301) } }, 'layer.safety.contact'],
    [{ desk: { nope: 1 } }, 'layer.desk.nope'],
  ])('400 invalid_profile with the layer path: %j -> %s', async (bad, path) => {
    const { call, cw, routeAudit } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ layer: bad, version: 0, reason: 'x' }));
    expect([res.status, errorOf(res), (res.body as { path: string }).path]).toEqual([400, 'invalid_profile', path]);
    expect(cw.policy.get().version).toBe(0);
    expect(routeAudit()).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('zorbak');
  });

  it.each(['desk', 'safety', 'rooms'])('DELETE ?section=%s resets it and audits policy.reset with that section only', async (section) => {
    const { call, cw, routeAudit } = await world();
    await call('PUT', '/policy/profile', PUT({ layer: { ...layer, customDuration: false }, version: 0, reason: 'set' }));
    const res = await call('DELETE', '/policy/profile', { role: 'owner', actor: 'owner_ann', query: { section }, body: { reason: 'back to default' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, changed: [section] });
    expect(Object.keys(cw.policy.get().layer)).not.toContain(section);
    expect(cw.profile.customDuration).toBe(false);
    expect(routeAudit().find((r) => r.action === 'policy.reset')).toMatchObject({ detail: { sections: [section], reason: 'back to default' } });
  });

  it('an audited save names the sections and holds no value', async () => {
    const { call, routeAudit } = await world();
    await call('PUT', '/policy/profile', PUT({ layer: { safety: { contact: 'quissel at the vlemmo desk' } }, version: 0, reason: 'contact' }));
    const rows = routeAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'policy.update', detail: { sections: ['safety'], reason: 'contact' } });
    expect(JSON.stringify(rows)).not.toContain('quissel');
  });

  it('the preview accepts a desk layer, refuses a bad one and saves nothing', async () => {
    const { call, cw } = await world();
    const ok = await call('POST', '/policy/profile/preview', { role: 'moderator', body: { layer: { rooms: { defaultModeMs: 60_000 } } } });
    expect(ok.status).toBe(200);
    const bad = await call('POST', '/policy/profile/preview', { role: 'moderator', body: { layer: { rooms: { defaultModeMs: 1 } } } });
    expect([bad.status, errorOf(bad)]).toEqual([400, 'invalid_profile']);
    expect(cw.profile.rooms).toEqual(ROOMS_OFF);
  });
});
