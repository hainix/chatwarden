import { describe, expect, it } from 'vitest';
import { PERMISSION_KEYS, PERMISSIONS, resolvePermissions, roleAtLeast } from '../src/index.js';
import type { PermissionKey, Role } from '../src/index.js';
import { world } from './world.js';

// The seven permissions of the urgent lane, the desk and the rooms: appended after the earlier keys, each a moderator's by default.

const SEVEN = ['reports.urgent', 'reports.handoff', 'reports.comment', 'reports.escalate', 'insights.read', 'rooms.read', 'rooms.manage'] as const;

describe('the seven permissions', () => {
  it('default to moderator, are appended in order after the earlier keys, and every earlier key is still there', () => {
    for (const key of SEVEN) expect(PERMISSIONS[key], key).toBe('moderator');
    for (const key of SEVEN) expect(PERMISSION_KEYS.filter((k) => k === key).length, key).toBe(1);
    const at = PERMISSION_KEYS.indexOf('reports.urgent');
    expect(PERMISSION_KEYS.slice(at, at + 7)).toEqual([...SEVEN]);
    for (const old of ['reports.read', 'reports.decide', 'appeals.decide', 'ai.review', 'filters.read', 'legal.hold']) {
      expect(PERMISSION_KEYS.indexOf(old as PermissionKey), old).toBeGreaterThanOrEqual(0);
      expect(PERMISSION_KEYS.indexOf(old as PermissionKey), old).toBeLessThan(at);
    }
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('the permissions option raises (or lowers) any of them; the rest keep their default', () => {
    for (const key of SEVEN) {
      const raised = resolvePermissions({ [key]: 'owner' });
      expect(raised[key], key).toBe('owner');
      for (const other of SEVEN.filter((k) => k !== key)) expect(raised[other], `${key} leaves ${other}`).toBe('moderator');
      expect(resolvePermissions({ [key]: 'senior' })[key]).toBe('senior');
    }
  });

  it('an unknown key is still refused, naming the key; a near miss of each new key too; a bad role is refused', () => {
    expect(() => resolvePermissions({ 'rooms.write': 'owner' } as never)).toThrow(/"rooms\.write"/);
    expect(() => resolvePermissions({ 'report.urgent': 'owner' } as never)).toThrow(/"report\.urgent"/);
    expect(() => resolvePermissions({ 'insights.view': 'owner' } as never)).toThrow(/"insights\.view"/);
    expect(() => resolvePermissions({ 'reports.urgent': 'admin' as Role })).toThrow(/reports\.urgent/);
    expect(() => resolvePermissions({ 'rooms.manage': 3 as never })).toThrow(/rooms\.manage/);
  });

  it('a moderator is enough by default and a raised key needs a senior', () => {
    for (const key of SEVEN) {
      expect(roleAtLeast('moderator', PERMISSIONS[key])).toBe(true);
      expect(roleAtLeast('moderator', resolvePermissions({ [key]: 'senior' })[key])).toBe(false);
      expect(roleAtLeast('senior', resolvePermissions({ [key]: 'senior' })[key])).toBe(true);
    }
  });
});

describe('GET /me can[] over the seven', () => {
  const can = async (w: Awaited<ReturnType<typeof world>>, role: Role): Promise<Record<string, boolean>> =>
    ((await w.call('GET', '/me', { role })).body as { can: Record<string, boolean> }).can;

  it('has the seven keys, true for every role by default', async () => {
    const w = await world();
    for (const role of ['moderator', 'senior', 'owner'] as const) {
      const c = await can(w, role);
      for (const key of SEVEN) expect(c[key], `${role} ${key}`).toBe(true);
    }
  });

  it('follows an override: raised to senior, a moderator loses exactly that key', async () => {
    const w = await world({ permissions: { 'rooms.manage': 'senior', 'reports.urgent': 'owner' } });
    expect(await can(w, 'moderator')).toMatchObject({ 'rooms.manage': false, 'reports.urgent': false, 'rooms.read': true, 'insights.read': true });
    expect(await can(w, 'senior')).toMatchObject({ 'rooms.manage': true, 'reports.urgent': false });
    expect(await can(w, 'owner')).toMatchObject({ 'rooms.manage': true, 'reports.urgent': true });
  });
});
