import { describe, expect, it } from 'vitest';
import { adminRoutes, createRouter } from '../src/index.js';
import { world } from './world.js';

// Staff data is per caller, so no admin response may be cached by a shared cache: every one, success or error, carries
// `cache-control: no-store`.

const cc = (res: { headers?: Record<string, string> }): string | undefined => res.headers?.['cache-control'];

describe('admin responses are cache-control: no-store', () => {
  it('on successes across the route groups, including /me', async () => {
    const w = await world();
    for (const path of ['/me', '/reports', '/gaps', '/terms', '/policy']) {
      const res = await w.call('GET', path, { role: 'owner' });
      expect(res.status, path).toBe(200);
      expect(cc(res), path).toBe('no-store');
    }
    const audit = await w.call('GET', '/audit', { role: 'senior' });
    expect(audit.status).toBe(200);
    expect(cc(audit)).toBe('no-store');
  });

  it('on 401 (no authz) for several routes', async () => {
    const w = await world();
    for (const path of ['/me', '/reports', '/gaps', '/audit', '/policy']) {
      const res = await w.call('GET', path, { role: null });
      expect(res.status, path).toBe(401);
      expect(cc(res), path).toBe('no-store');
    }
  });

  it('on 403 (role too low)', async () => {
    const w = await world();
    const res = await w.call('GET', '/audit', { role: 'moderator' });
    expect(res.status).toBe(403);
    expect(cc(res)).toBe('no-store');
    const close = await w.call('POST', '/gaps/g1/close', { role: 'moderator', body: { status: 'not_a_rule' } });
    expect(close.status).toBe(403);
    expect(cc(close)).toBe('no-store');
  });

  it('on 404 and 400 from a handler', async () => {
    const w = await world();
    const missing = await w.call('GET', '/reports/nope', { role: 'moderator' });
    expect(missing.status).toBe(404);
    expect(cc(missing)).toBe('no-store');
    const bad = await w.call('POST', '/sanctions', { role: 'moderator', raw: '{nope' });
    expect(bad.status).toBe(400);
    expect(cc(bad)).toBe('no-store');
  });

  it('on a 500 (an actor the audit trail cannot hold)', async () => {
    const { cw, live } = await world();
    const router = createRouter(adminRoutes(cw, { authorize: () => ({ actor: 'Ann Smith', role: 'owner' }), terms: live }));
    const res = await router({ method: 'GET', path: '/me', query: {}, headers: {}, body: undefined });
    expect(res.status).toBe(500);
    expect(cc(res)).toBe('no-store');
  });

  it('gives each response its own headers object (no shared mutable state)', async () => {
    const w = await world();
    const a = await w.call('GET', '/me', { role: 'owner' });
    const b = await w.call('GET', '/me', { role: 'moderator' });
    expect(a.headers).not.toBe(b.headers);
  });
});
