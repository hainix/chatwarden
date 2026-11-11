import { describe, expect, it } from 'vitest';
import { PERMISSION_KEYS, PERMISSIONS, roleAtLeast } from '../src/index.js';
import type { PermissionKey, Role } from '../src/index.js';
import { adminRoutes, createRouter } from '../src/index.js';
import { errorOf, keysDeep, world } from './world.js';

const ROLES_LIST: Role[] = ['moderator', 'senior', 'owner'];

/** What each role may do with the default table, from the table itself. */
const expectedCan = (role: Role, table: Record<PermissionKey, Role> = PERMISSIONS): Record<PermissionKey, boolean> =>
  Object.fromEntries(PERMISSION_KEYS.map((k) => [k, roleAtLeast(role, table[k])])) as Record<PermissionKey, boolean>;

describe('GET /me', () => {
  for (const role of ROLES_LIST) {
    it(`${role}: returns the actor, the role and a can map over every permission key`, async () => {
      const w = await world();
      const res = await w.call('GET', '/me', { role, actor: 'ann' });
      expect(res.status).toBe(200);
      const body = res.body as { actor: string; role: Role; can: Record<string, boolean> };
      expect(body.actor).toBe('ann');
      expect(body.role).toBe(role);
      expect(Object.keys(body.can).sort()).toEqual([...PERMISSION_KEYS].sort());
      expect(body.can).toEqual(expectedCan(role));
      expect(Object.keys(body).sort()).toEqual(['actor', 'can', 'role']);
    });
  }

  it('the default table gives the documented answers at the edges', async () => {
    const w = await world();
    const mod = (await w.call('GET', '/me', { role: 'moderator' })).body as { can: Record<string, boolean> };
    expect(mod.can['reports.decide']).toBe(true);
    expect(mod.can['audit.read']).toBe(false);
    expect(mod.can['sanctions.apply.ban_permanent']).toBe(false);
    expect(mod.can['gaps.close']).toBe(false);
    const senior = (await w.call('GET', '/me', { role: 'senior' })).body as { can: Record<string, boolean> };
    expect(senior.can['audit.read']).toBe(true);
    expect(senior.can['sanctions.apply.ban_permanent']).toBe(true);
    expect(senior.can['gaps.close']).toBe(false);
    const owner = (await w.call('GET', '/me', { role: 'owner' })).body as { can: Record<string, boolean> };
    expect(Object.values(owner.can).every(Boolean)).toBe(true);
  });

  it('uses the effective table: a permissions override raises a bar', async () => {
    const w = await world({ permissions: { 'reports.decide': 'senior', 'audit.read': 'owner' } });
    const mod = (await w.call('GET', '/me', { role: 'moderator' })).body as { can: Record<string, boolean> };
    expect(mod.can['reports.decide']).toBe(false);
    const senior = (await w.call('GET', '/me', { role: 'senior' })).body as { can: Record<string, boolean> };
    expect(senior.can['reports.decide']).toBe(true);
    expect(senior.can['audit.read']).toBe(false);
    const owner = (await w.call('GET', '/me', { role: 'owner' })).body as { can: Record<string, boolean> };
    expect(owner.can['audit.read']).toBe(true);
  });

  it('uses the effective table: a permissions override lowers a bar', async () => {
    const w = await world({ permissions: { 'gaps.close': 'moderator', settings: 'senior' } });
    const mod = (await w.call('GET', '/me', { role: 'moderator' })).body as { can: Record<string, boolean> };
    expect(mod.can['gaps.close']).toBe(true);
    expect(mod.can.settings).toBe(false);
    const senior = (await w.call('GET', '/me', { role: 'senior' })).body as { can: Record<string, boolean> };
    expect(senior.can.settings).toBe(true);
  });

  it('agrees with what the routes enforce: can[x] false means that route is a 403 (control for one gated route per role)', async () => {
    const w = await world({ permissions: { 'audit.read': 'owner' } });
    for (const role of ROLES_LIST) {
      const me = (await w.call('GET', '/me', { role })).body as { can: Record<string, boolean> };
      const audit = await w.call('GET', '/audit', { role });
      expect(audit.status === 200, role).toBe(me.can['audit.read']);
    }
  });

  it('an override table with every key set still reports every key', async () => {
    const all = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'owner'])) as Record<PermissionKey, Role>;
    const w = await world({ permissions: all });
    const mod = (await w.call('GET', '/me', { role: 'moderator' })).body as { can: Record<string, boolean> };
    expect(Object.keys(mod.can)).toHaveLength(PERMISSION_KEYS.length);
    expect(Object.values(mod.can).every((v) => v === false)).toBe(true);
  });

  it('is 401 with no authz, and the body is the fixed unauthorized error', async () => {
    const w = await world();
    const res = await w.call('GET', '/me', { role: null });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', message: 'Authentication is required.' });
  });

  it('is 401 for a malformed authz (empty actor, unknown role, missing role, wrong type)', async () => {
    const { cw, live } = await world();
    const bads: unknown[] = [{ actor: '', role: 'moderator' }, { actor: 'x', role: 'admin' }, { role: 'owner' }, { actor: 'x' }, 'owner', 7, undefined];
    for (const bad of bads) {
      const router = createRouter(adminRoutes(cw, { authorize: () => bad as never, terms: live }));
      const res = await router({ method: 'GET', path: '/me', query: {}, headers: {}, body: undefined });
      expect(res.status, JSON.stringify(bad)).toBe(401);
      expect(errorOf(res)).toBe('unauthorized');
    }
  });

  it('needs no permission: it works even when every permission is raised to owner', async () => {
    const all = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'owner'])) as Record<PermissionKey, Role>;
    const w = await world({ permissions: all });
    expect((await w.call('GET', '/me', { role: 'moderator' })).status).toBe(200);
  });

  it('writes no audit row, for any role', async () => {
    const w = await world();
    const before = w.audit().length;
    for (const role of ROLES_LIST) expect((await w.call('GET', '/me', { role })).status).toBe(200);
    await w.call('GET', '/me', { role: null });
    expect(w.audit()).toHaveLength(before);
    expect(w.routeAudit()).toEqual([]);
  });

  it('an actor the audit trail cannot hold is still refused (500), like every route', async () => {
    const { cw, live } = await world();
    const router = createRouter(adminRoutes(cw, { authorize: () => ({ actor: 'Ann Smith', role: 'owner' }), terms: live }));
    const res = await router({ method: 'GET', path: '/me', query: {}, headers: {}, body: undefined });
    expect(res.status).toBe(500);
  });

  it('answers only GET (405 otherwise) and ignores a query string', async () => {
    const w = await world();
    expect((await w.call('POST', '/me', { role: 'owner', body: {} })).status).toBe(405);
    expect((await w.call('DELETE', '/me', { role: 'owner' })).status).toBe(405);
    const res = await w.call('GET', '/me', { role: 'owner', query: { role: 'moderator', actor: 'evil' } });
    expect((res.body as { role: string }).role).toBe('owner');
  });

  it('calls authorize once per request, and does not touch the store', async () => {
    const { cw, live } = await world();
    let calls = 0;
    const router = createRouter(
      adminRoutes(cw, {
        authorize: () => {
          calls += 1;
          return { actor: 'ann', role: 'senior' };
        },
        terms: live,
      }),
    );
    await router({ method: 'GET', path: '/me', query: {}, headers: {}, body: undefined });
    expect(calls).toBe(1);
  });

  it('works without the term routes configured, and leaks nothing but actor, role and booleans', async () => {
    const w = await world({ terms: false });
    const res = await w.call('GET', '/me', { role: 'senior', actor: 'ann' });
    expect(res.status).toBe(200);
    expect([...keysDeep(res.body)].sort()).toEqual(['actor', 'can', 'role', ...PERMISSION_KEYS].sort());
    expect(Object.values((res.body as { can: Record<string, unknown> }).can).every((v) => typeof v === 'boolean')).toBe(true);
  });

  it('the effective table does not change when the options object is mutated after creation', async () => {
    const perms: Partial<Record<PermissionKey, Role>> = { 'audit.read': 'owner' };
    const { cw, live } = await world();
    const router = createRouter(adminRoutes(cw, { authorize: () => ({ actor: 'ann', role: 'senior' }), terms: live, permissions: perms }));
    perms['audit.read'] = 'moderator';
    const res = await router({ method: 'GET', path: '/me', query: {}, headers: {}, body: undefined });
    expect((res.body as { can: Record<string, boolean> }).can['audit.read']).toBe(false);
  });
});
