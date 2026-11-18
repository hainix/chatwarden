import { describe, expect, expectTypeOf, it } from 'vitest';
import { PERMISSION_KEYS } from '@chatwarden/http/admin';
import type { PermissionKey as HttpPermissionKey } from '@chatwarden/http/admin';
import type { PermissionKey } from '../src/types.js';

// The hub never keeps a permission list of its own: its PermissionKey is the http list's. A key the staff routes add is a key the hub can ask `can` about.

describe('the hub PermissionKey list matches the http list', () => {
  it('is the same type, so a key added to the routes is known to the hub', () => {
    expectTypeOf<PermissionKey>().toEqualTypeOf<HttpPermissionKey>();
    expectTypeOf<'appeals.read'>().toExtend<PermissionKey>();
    expectTypeOf<'appeals.decide'>().toExtend<PermissionKey>();
    expectTypeOf<'appeals.write'>().not.toExtend<PermissionKey>();
  });

  it('the runtime list holds the appeals keys, then the three AI keys (review, pause and automation), contiguous and in order', () => {
    const at = PERMISSION_KEYS.indexOf('appeals.read');
    expect(PERMISSION_KEYS.slice(at, at + 5)).toEqual(['appeals.read', 'appeals.decide', 'ai.review', 'ai.pause', 'automation.write']);
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });
});
