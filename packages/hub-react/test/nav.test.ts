import { describe, expect, it } from 'vitest';
import { permissionFor } from '../src/nav.js';
import type { Route } from '../src/router.js';

// A route opens only for the role that holds its permission; the shell gates on this and the server is the second lock.
describe('permissionFor', () => {
  it.each<[Route, string | null]>([
    [{ name: 'overview' }, null],
    [{ name: 'notFound', path: '/x' }, null],
    [{ name: 'reports', status: 'open' }, 'reports.read'],
    [{ name: 'report', id: 'a' }, 'reports.read'],
    [{ name: 'person', ref: 'p' }, 'history.read'],
    [{ name: 'actions' }, 'history.read'],
    [{ name: 'audit' }, 'audit.read'],
    [{ name: 'appeals' }, 'appeals.read'],
    [{ name: 'appeal', id: 'a' }, 'appeals.read'],
  ])('%j needs %s', (route, permission) => {
    expect(permissionFor(route)).toBe(permission);
  });
});
