import { describe, expect, it } from 'vitest';
import { errorOf, world } from './world.js';

// The `filters` section over HTTP: the existing /policy/profile routes carry it, with no new route. GET shows it in effective, base and
// layer; PUT accepts layer.filters; a bad value is 400 invalid_profile with the layer path; DELETE ?section=filters resets it.

const OFF = { links: null, personalInfo: null, phrases: [], ratio: null, ignore: [], flagCapPerDay: 50 };
const PUT = (body: unknown, role: 'owner' | 'senior' | 'moderator' = 'owner', actor = 'owner_ann') => ({ role, actor, body });
const filters = { links: { action: 'flag', allow: ['example.com'] }, personalInfo: { action: 'mask' }, phrases: [{ id: 'rmt', action: 'count', phrases: ['buy gold'] }] };

interface ProfileBody {
  effective: { filters: unknown };
  base: { filters: unknown };
  layer: { filters?: unknown };
  version: number;
}

describe('filters over /policy/profile', () => {
  it('GET returns filters in effective, base and layer', async () => {
    const { call } = await world({ overrides: { filters: { flagCapPerDay: 9 } } });
    const before = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect(before.effective.filters).toEqual({ ...OFF, flagCapPerDay: 9 });
    expect(before.base.filters).toEqual({ ...OFF, flagCapPerDay: 9 });
    expect(before.layer.filters).toBeUndefined();
    await call('PUT', '/policy/profile', PUT({ layer: { filters: { links: { action: 'refuse' } } }, version: 0, reason: 'no links' }));
    const after = (await call('GET', '/policy/profile')).body as ProfileBody;
    expect((after.effective.filters as { links: { action: string } }).links.action).toBe('refuse');
    expect((after.effective.filters as { flagCapPerDay: number }).flagCapPerDay).toBe(9);
    expect(after.base.filters).toEqual({ ...OFF, flagCapPerDay: 9 });
    expect(after.layer.filters).toEqual({ links: { action: 'refuse' } });
  });

  it('every staff role reads it', async () => {
    const { call } = await world();
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      const res = await call('GET', '/policy/profile', { role });
      expect((res.body as ProfileBody).effective.filters, role).toEqual(OFF);
    }
  });

  it('PUT /policy/profile with filters: 200 and effective.filters', async () => {
    const { call, cw } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ layer: { filters }, version: 0, reason: 'tune the chat' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, version: 1, changed: ['filters'], layer: { filters } });
    expect(cw.profile.filters.links).toMatchObject({ action: 'flag', allow: ['example.com'], rule: 4 });
    expect(cw.profile.filters.phrases.map((p) => p.id)).toEqual(['rmt']);
  });

  it('a PUT is owner only: a senior is 403 and nothing is saved', async () => {
    const { call, cw } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ layer: { filters }, version: 0, reason: 'x' }, 'senior'));
    expect([res.status, errorOf(res)]).toEqual([403, 'forbidden']);
    expect(cw.profile.filters).toEqual(OFF);
  });

  it('409 on a stale version', async () => {
    const { call, cw } = await world();
    await call('PUT', '/policy/profile', PUT({ layer: { filters }, version: 0, reason: 'first' }));
    const res = await call('PUT', '/policy/profile', PUT({ layer: { filters: { flagCapPerDay: 7 } }, version: 0, reason: 'second' }));
    expect([res.status, errorOf(res)]).toEqual([409, 'conflict']);
    expect(cw.profile.filters.flagCapPerDay).toBe(50);
  });

  it.each([
    [{ links: { action: 'count', allow: ['https://example.com'] } }, 'layer.filters.links.allow[0]'],
    [{ links: { action: 'count', allow: ['github.io'] } }, 'layer.filters.links.allow[0]'],
    [{ links: { action: 'count', allow: ['example.com'], deny: ['example.com'] } }, 'layer.filters.links.allow[0]'],
    [{ links: { allow: [] } }, 'layer.filters.links.action'],
    [{ nope: 1 }, 'layer.filters.nope'],
    [{ ratio: { action: 'mask', repeats: { maxRun: 2 } } }, 'layer.filters.ratio.repeats.maxRun'],
    [{ phrases: [{ id: 'A', action: 'count', phrases: ['buy gold'] }] }, 'layer.filters.phrases[0].id'],
    [{ links: { action: 'count', rule: 9999 } }, 'layer.filters.links.rule'],
  ])('400 invalid_profile with the layer path: %j -> %s', async (bad, path) => {
    const { call, cw, routeAudit } = await world();
    const res = await call('PUT', '/policy/profile', PUT({ layer: { filters: bad }, version: 0, reason: 'x' }));
    expect([res.status, errorOf(res), (res.body as { path: string }).path]).toEqual([400, 'invalid_profile', path]);
    expect(cw.policy.get().version).toBe(0);
    expect(routeAudit()).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('example.com');
  });

  it('DELETE ?section=filters resets it, leaving the other sections, and audits policy.reset with sections ["filters"]', async () => {
    const { call, cw, routeAudit } = await world({ overrides: { filters: { flagCapPerDay: 12 } } });
    await call('PUT', '/policy/profile', PUT({ layer: { filters, customDuration: false }, version: 0, reason: 'set' }));
    expect(cw.profile.filters.links).not.toBeNull();
    const res = await call('DELETE', '/policy/profile', { role: 'owner', actor: 'owner_ann', query: { section: 'filters' }, body: { reason: 'back to the default' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, changed: ['filters'] });
    expect(cw.profile.filters).toEqual({ ...OFF, flagCapPerDay: 12 });
    expect(cw.profile.customDuration).toBe(false);
    const rows = routeAudit();
    expect(rows.find((r) => r.action === 'policy.reset')).toMatchObject({ action: 'policy.reset', detail: { sections: ['filters'], reason: 'back to the default' } });
  });

  it('a save of only filters is audited policy.update with sections ["filters"] and no values', async () => {
    const { call, routeAudit } = await world();
    await call('PUT', '/policy/profile', PUT({ layer: { filters: { phrases: [{ id: 'ad', action: 'flag', phrases: ['quissel drakkuun'] }] } }, version: 0, reason: 'adverts' }));
    const rows = routeAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'policy.update', detail: { sections: ['filters'], reason: 'adverts' } });
    expect(JSON.stringify(rows)).not.toContain('quissel');
  });

  it('DELETE with an unknown section is still 400 invalid_query', async () => {
    const { call } = await world();
    const res = await call('DELETE', '/policy/profile', { role: 'owner', query: { section: 'filter' }, body: { reason: 'x' } });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_query']);
  });

  it('the preview route accepts a filters layer, refuses a bad one, and changes nothing', async () => {
    const { call, cw } = await world();
    const ok = await call('POST', '/policy/profile/preview', { role: 'moderator', body: { layer: { filters } } });
    expect(ok.status).toBe(200);
    const bad = await call('POST', '/policy/profile/preview', { role: 'moderator', body: { layer: { filters: { links: { action: 'count', rule: 9999 } } } } });
    expect([bad.status, errorOf(bad)]).toEqual([400, 'invalid_profile']);
    expect(cw.profile.filters).toEqual(OFF);
    expect(cw.policy.get().version).toBe(0);
  });
});
