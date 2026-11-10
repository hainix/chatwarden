import { describe, expect, it } from 'vitest';
import { PERMISSIONS, resolvePermissions, roleAtLeast, ROLES } from '@chatwarden/http';
import type { PermissionKey, Role } from '@chatwarden/http';

describe('roleAtLeast', () => {
  it('orders owner >= senior >= moderator', () => {
    expect(roleAtLeast('owner', 'owner')).toBe(true);
    expect(roleAtLeast('owner', 'senior')).toBe(true);
    expect(roleAtLeast('owner', 'moderator')).toBe(true);
    expect(roleAtLeast('senior', 'owner')).toBe(false);
    expect(roleAtLeast('senior', 'senior')).toBe(true);
    expect(roleAtLeast('senior', 'moderator')).toBe(true);
    expect(roleAtLeast('moderator', 'owner')).toBe(false);
    expect(roleAtLeast('moderator', 'senior')).toBe(false);
    expect(roleAtLeast('moderator', 'moderator')).toBe(true);
  });

  it('fails closed on a value that is not a role', () => {
    expect(roleAtLeast('admin' as Role, 'moderator')).toBe(false);
    expect(roleAtLeast('owner', 'admin' as Role)).toBe(false);
    expect(roleAtLeast(undefined as unknown as Role, 'moderator')).toBe(false);
    expect(roleAtLeast('toString' as Role, 'moderator')).toBe(false);
  });

  it('re-exports the core role list in order', () => {
    expect([...ROLES]).toEqual(['moderator', 'senior', 'owner']);
  });
});

describe('PERMISSIONS defaults', () => {
  it('has exactly the specified minimum roles', () => {
    expect({ ...PERMISSIONS }).toEqual({
      'reports.read': 'moderator',
      'reports.decide': 'moderator',
      'sanctions.apply': 'moderator',
      'sanctions.apply.ban_permanent': 'senior',
      'sanctions.revoke': 'moderator',
      'history.read': 'moderator',
      'blocked.read': 'moderator',
      'gaps.read': 'moderator',
      'gaps.close': 'owner',
      'terms.read': 'moderator',
      'terms.write': 'moderator',
      'policy.read': 'moderator',
      'audit.read': 'senior',
      settings: 'owner',
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
  });
});

describe('resolvePermissions', () => {
  it('returns the defaults with no overrides', () => {
    expect(resolvePermissions()).toEqual({ ...PERMISSIONS });
    expect(resolvePermissions({})).toEqual({ ...PERMISSIONS });
  });

  it('applies an override and leaves the rest', () => {
    const p = resolvePermissions({ 'terms.write': 'senior', 'audit.read': 'owner' });
    expect(p['terms.write']).toBe('senior');
    expect(p['audit.read']).toBe('owner');
    expect(p['reports.read']).toBe('moderator');
  });

  it('does not mutate the defaults or the input', () => {
    const input = { settings: 'senior' } as const;
    const p = resolvePermissions(input);
    expect(PERMISSIONS.settings).toBe('owner');
    expect(input).toEqual({ settings: 'senior' });
    expect(p).not.toBe(PERMISSIONS);
  });

  it('returns a frozen result', () => {
    expect(Object.isFrozen(resolvePermissions({ settings: 'senior' }))).toBe(true);
  });

  it('ignores an undefined override value', () => {
    expect(resolvePermissions({ settings: undefined }).settings).toBe('owner');
  });

  it('rejects a value that is not a role', () => {
    expect(() => resolvePermissions({ settings: 'admin' as Role })).toThrow(RangeError);
    expect(() => resolvePermissions({ settings: '' as Role })).toThrow(RangeError);
    expect(() => resolvePermissions({ settings: 3 as unknown as Role })).toThrow(RangeError);
    expect(() => resolvePermissions({ settings: null as unknown as Role })).toThrow(RangeError);
    expect(() => resolvePermissions({ settings: 'toString' as Role })).toThrow(RangeError);
  });

  it('rejects an unknown permission key', () => {
    expect(() => resolvePermissions({ 'reports.reed': 'owner' } as never)).toThrow(RangeError);
    expect(() => resolvePermissions({ toString: 'owner' } as never)).toThrow(RangeError);
  });

  it('names an unknown key in the error (adopter config), never a value', () => {
    expect(() => resolvePermissions({ 'reports.reed': 'owner' } as never)).toThrow(/"reports\.reed"/);
    try {
      resolvePermissions({ nope: 'super-secret-value' } as never);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('nope');
      expect((e as Error).message).not.toContain('super-secret-value');
    }
  });

  it('names the key in the error but never the value', () => {
    try {
      resolvePermissions({ settings: 'super-secret-value' as Role });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('settings');
      expect((e as Error).message).not.toContain('super-secret-value');
    }
  });

  it('rejects a non-object', () => {
    expect(() => resolvePermissions('owner' as never)).toThrow(RangeError);
    expect(() => resolvePermissions(null as never)).toThrow(RangeError);
  });

  it('can open every key to every role (a valid override)', () => {
    const all = Object.keys(PERMISSIONS) as PermissionKey[];
    const p = resolvePermissions(Object.fromEntries(all.map((k) => [k, 'moderator'])));
    for (const k of all) expect(p[k]).toBe('moderator');
  });
});
