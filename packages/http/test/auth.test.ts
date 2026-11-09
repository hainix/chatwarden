import { describe, expect, it, vi } from 'vitest';
import { guard, HttpError, requireRole, resolvePermissions, withErrors } from '@chatwarden/http';
import type { Authz, KitRequest, KitResponse, Role } from '@chatwarden/http';

const req = (): KitRequest => ({ method: 'GET', path: '/x', query: {}, headers: {}, body: undefined });
const ok = (): KitResponse => ({ status: 200, body: { ok: true } });
const catchErr = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('requireRole', () => {
  it('returns the authz when the role is enough', () => {
    const authz = { actor: 'ann', role: 'senior' as Role };
    expect(requireRole(authz, 'audit.read')).toBe(authz);
    expect(requireRole({ actor: 'o', role: 'owner' }, 'settings')).toEqual({ actor: 'o', role: 'owner' });
    expect(requireRole({ actor: 'm', role: 'moderator' }, 'reports.read').actor).toBe('m');
  });

  it('throws 401 for null', () => {
    const e = catchErr(() => requireRole(null, 'reports.read'));
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(401);
    expect((e as HttpError).code).toBe('unauthorized');
  });

  it('throws 403 for a role that is too low, 401 only for no authz', () => {
    const e = catchErr(() => requireRole({ actor: 'm', role: 'moderator' }, 'audit.read'));
    expect((e as HttpError).status).toBe(403);
    expect((e as HttpError).code).toBe('forbidden');
    expect((catchErr(() => requireRole({ actor: 's', role: 'senior' }, 'gaps.close')) as HttpError).status).toBe(403);
    expect(
      (catchErr(() => requireRole({ actor: 'm', role: 'moderator' }, 'sanctions.apply.ban_permanent')) as HttpError).status,
    ).toBe(403);
  });

  it('honours a permission override', () => {
    const perms = resolvePermissions({ 'terms.write': 'senior', 'gaps.close': 'senior' });
    expect((catchErr(() => requireRole({ actor: 'm', role: 'moderator' }, 'terms.write', perms)) as HttpError).status).toBe(403);
    expect(requireRole({ actor: 's', role: 'senior' }, 'terms.write', perms).role).toBe('senior');
    expect(requireRole({ actor: 's', role: 'senior' }, 'gaps.close', perms).role).toBe('senior');
    // The default still applies without the override.
    expect((catchErr(() => requireRole({ actor: 's', role: 'senior' }, 'gaps.close')) as HttpError).status).toBe(403);
  });

  it('fails closed on a malformed authz (401)', () => {
    for (const bad of [
      { actor: 'x', role: 'admin' },
      { actor: '', role: 'owner' },
      { actor: 5, role: 'owner' },
      { role: 'owner' },
      { actor: 'x' },
      'owner',
      42,
      undefined,
    ]) {
      expect((catchErr(() => requireRole(bad as never, 'reports.read')) as HttpError).status).toBe(401);
    }
  });

  it('fails closed on an unknown permission key (403)', () => {
    expect((catchErr(() => requireRole({ actor: 'o', role: 'owner' }, 'nope' as never)) as HttpError).status).toBe(403);
  });
});

describe('guard', () => {
  it('authenticates, checks the role and then runs the handler with the authz', async () => {
    const handler = vi.fn((_r: KitRequest, _p: Record<string, string>, a: Authz) => ({
      status: 200,
      body: a.actor,
    }));
    const g = guard({ authenticate: () => ({ actor: 'ann', role: 'senior' }) }, 'audit.read', handler);
    const res = await g(req(), { id: 'p' });
    expect(res).toEqual({ status: 200, body: 'ann' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[1]).toEqual({ id: 'p' });
  });

  it('401 (null authz): the handler is not called', async () => {
    const handler = vi.fn(ok);
    const g = withErrors(guard({ authenticate: () => null }, 'reports.read', handler));
    const res = await g(req(), {});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', message: 'Authentication is required.' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('403 (role too low): the handler is not called', async () => {
    const handler = vi.fn(ok);
    const g = withErrors(guard({ authenticate: () => ({ actor: 'm', role: 'moderator' }) }, 'audit.read', handler));
    const res = await g(req(), {});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden', message: 'You do not have permission to do this.' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts an async authenticate and awaits it', async () => {
    const handler = vi.fn(ok);
    const g = guard({ authenticate: async () => ({ actor: 'o', role: 'owner' }) }, 'settings', handler);
    expect((await g(req(), {})).status).toBe(200);
    const denied = withErrors(guard({ authenticate: async () => null }, 'settings', handler));
    expect((await denied(req(), {})).status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('checks the permissions override', async () => {
    const handler = vi.fn(ok);
    const perms = resolvePermissions({ 'reports.read': 'senior' });
    const g = withErrors(
      guard({ authenticate: () => ({ actor: 'm', role: 'moderator' }), permissions: perms }, 'reports.read', handler),
    );
    expect((await g(req(), {})).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('validates the permissions map once, at construction', () => {
    const handler = vi.fn(ok);
    const authenticate = (): Authz => ({ actor: 'o', role: 'owner' });
    expect(() => guard({ authenticate, permissions: { settings: 'admin' as Role } }, 'settings', handler)).toThrow(RangeError);
    expect(() => guard({ authenticate, permissions: { nope: 'owner' } as never }, 'settings', handler)).toThrow(RangeError);
  });

  it('accepts partial overrides and applies them over the defaults', async () => {
    const handler = vi.fn(ok);
    const as = (role: Role) => ({
      authenticate: () => ({ actor: 'a', role }),
      permissions: { 'terms.write': 'senior' as Role },
    });
    expect((await withErrors(guard(as('moderator'), 'terms.write', handler))(req(), {})).status).toBe(403);
    expect((await withErrors(guard(as('senior'), 'terms.write', handler))(req(), {})).status).toBe(200);
    // A key not overridden keeps its default.
    expect((await withErrors(guard(as('moderator'), 'reports.read', handler))(req(), {})).status).toBe(200);
    expect((await withErrors(guard(as('senior'), 'settings', handler))(req(), {})).status).toBe(403);
  });

  it('is not affected by later mutation of the options object it was given', async () => {
    const handler = vi.fn(ok);
    const overrides: { settings?: Role } = { settings: 'senior' };
    const g = withErrors(
      guard({ authenticate: () => ({ actor: 's', role: 'senior' }), permissions: overrides }, 'settings', handler),
    );
    overrides.settings = 'owner';
    expect((await g(req(), {})).status).toBe(200);
  });

  it('a throwing authenticate becomes a 500 with no detail, handler not called', async () => {
    const handler = vi.fn(ok);
    const warn = vi.fn();
    const g = withErrors(
      guard(
        {
          authenticate: () => {
            throw new Error('db password=hunter2');
          },
        },
        'reports.read',
        handler,
      ),
      { warn },
    );
    const res = await g(req(), {});
    expect(res).toEqual({ status: 500, body: { error: 'internal' } });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('hunter2');
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes the request to authenticate', async () => {
    const authenticate = vi.fn(() => ({ actor: 'a', role: 'owner' as Role }));
    const g = guard({ authenticate }, 'settings', ok);
    const r = req();
    await g(r, {});
    expect(authenticate).toHaveBeenCalledWith(r);
  });
});
