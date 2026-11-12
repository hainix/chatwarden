import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as root from '../src/index.js';
import * as admin from '../src/admin-entry.js';
import type { Me as AdminMe, MeFeatures as AdminMeFeatures } from '../src/admin-entry.js';
import type { Me, MeFeatures } from '../src/index.js';

// `@chatwarden/http/admin` is the entry a browser bundles. It carries the staff API and what it needs, and nothing that
// imports a Node builtin: no player routes, no webhooks, no Express adapter.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every file the entry reaches through relative imports and re-exports. */
function reach(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    const text = readFileSync(file, 'utf8');
    seen.set(file, text);
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(join(dirname(file), (m[1] as string).replace(/\.js$/, '.ts')));
    }
  }
  return seen;
}

describe('@chatwarden/http/admin entry', () => {
  it('exports the staff API, the router, the errors, the roles and the permissions', () => {
    for (const name of [
      'adminRoutes',
      'createRouter',
      'matchRoute',
      'HttpError',
      'NotFoundError',
      'ValidationError',
      'errorResponse',
      'withErrors',
      'ROLES',
      'PERMISSION_KEYS',
      'PERMISSIONS',
      'resolvePermissions',
      'roleAtLeast',
      'guard',
      'requireRole',
      'parseJson',
      'BODY_MAX_BYTES',
      'reportRoutes',
      'sanctionRoutes',
      'gapRoutes',
      'termRoutes',
      'policyRoutes',
      'auditRoutes',
      'createAdminContext',
      'DEFAULT_GAME_NAME',
      'AuditFailedError',
      'BadActorError',
    ]) {
      expect(name in admin, name).toBe(true);
    }
  });

  it('exports MeFeatures (the shape of GET /me features) as a type, the same one the root gives, so a browser hub can name it', () => {
    expectTypeOf<AdminMeFeatures>().toEqualTypeOf<MeFeatures>();
    expectTypeOf<AdminMe['features']>().toEqualTypeOf<Me['features']>();
    expectTypeOf<AdminMeFeatures>().toEqualTypeOf<{ appeals: boolean; renames: boolean; keepBlocked: boolean }>();
    // A type has no run-time binding in either entry; the entry file says it by name.
    expect('MeFeatures' in admin).toBe(false);
    const text = readFileSync(join(SRC, 'admin-entry.ts'), 'utf8');
    expect(text).toMatch(/export type \{[^}]*\bMeFeatures\b[^}]*\} from '\.\/admin\/index\.js'/);
  });

  it('shares identity with the root export: the same functions and classes, not copies', () => {
    for (const name of Object.keys(admin) as Array<keyof typeof admin>) {
      expect((root as Record<string, unknown>)[name], name).toBe(admin[name]);
    }
  });

  it('exports nothing from the player routes, the webhooks or the Express adapter', () => {
    for (const name of [
      'playerRoutes',
      'CODE_OF_CONDUCT_CSP',
      'webhookIn',
      'webhooksOut',
      'sign',
      'verify',
      'ReplayCache',
      'SIGNATURE_HEADER',
      'TIMESTAMP_HEADER',
      'DELIVERY_HEADER',
      'MIN_SECRET_LENGTH',
      'QUEUE_MAX',
      'healthRoutes',
      'toExpress',
      'expressRouter',
      'sanctionFingerprint',
      'VERSION',
    ]) {
      expect(name in admin, name).toBe(false);
    }
  });

  it('keeps the root export unchanged: everything it exported is still there', () => {
    for (const name of [
      'VERSION',
      'ROLES',
      'matchRoute',
      'createRouter',
      'errorResponse',
      'HttpError',
      'NotFoundError',
      'ValidationError',
      'withErrors',
      'BODY_MAX_BYTES',
      'parseJson',
      'guard',
      'requireRole',
      'PERMISSION_KEYS',
      'PERMISSIONS',
      'resolvePermissions',
      'roleAtLeast',
      'adminRoutes',
      'auditRoutes',
      'AuditFailedError',
      'BadActorError',
      'createAdminContext',
      'DEFAULT_GAME_NAME',
      'gapRoutes',
      'policyRoutes',
      'reportRoutes',
      'sanctionRoutes',
      'termRoutes',
      'CODE_OF_CONDUCT_CSP',
      'playerRoutes',
      'healthRoutes',
      'ATTEMPT_TIMEOUT_MS',
      'BACKOFF_BASE_MS',
      'DELIVERY_HEADER',
      'MAX_RETRIES',
      'MIN_SECRET_LENGTH',
      'QUEUE_MAX',
      'REPLAY_CACHE_SIZE',
      'ReplayCache',
      'RETRY_AFTER_CAP_MS',
      'RETRY_AFTER_FLOOR_MS',
      'SIGNATURE_HEADER',
      'SIGNATURE_WINDOW_MS',
      'TIMESTAMP_HEADER',
      'sign',
      'verify',
      'webhookIn',
      'webhooksOut',
    ]) {
      expect(name in root, name).toBe(true);
    }
    expect('compileRoutes' in root).toBe(false);
    expect('compileRoutes' in admin).toBe(false);
  });

  it('reaches no file that imports a Node builtin or uses Buffer', () => {
    const files = reach(join(SRC, 'admin-entry.ts'));
    const names = [...files.keys()].map((f) => f.slice(SRC.length + 1).replaceAll('\\', '/'));
    expect(names).toContain('admin/index.ts');
    expect(names).toContain('router.ts');
    for (const bad of ['player.ts', 'express.ts', 'webhooks/in.ts', 'webhooks/out.ts', 'webhooks/sign.ts', 'webhooks/fingerprint.ts', 'index.ts']) {
      expect(names, bad).not.toContain(bad);
    }
    for (const [file, text] of files) {
      const code = text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/['"]node:/);
      expect(code, file).not.toMatch(/\bBuffer\b/);
      expect(code, file).not.toMatch(/\bfrom\s+['"](?:crypto|fs|path|http|https|stream|util|os)['"]/);
    }
  });

  it('can build and answer a staff request end to end through the entry alone', async () => {
    const { createChatwarden } = await import('@chatwarden/core');
    const { MemoryStore } = await import('@chatwarden/store-memory');
    const cw = await createChatwarden({ store: new MemoryStore(), secret: 'entry-secret', platform: { identify: (ctx) => ctx as never } });
    const handle = admin.createRouter(admin.adminRoutes(cw, { authorize: () => ({ actor: 'demo-mod', role: 'owner' }) }));
    const res = await handle({ method: 'GET', path: '/me', query: {}, headers: {}, body: undefined });
    expect(res.status).toBe(200);
    expect((res.body as { actor: string }).actor).toBe('demo-mod');
    const reports = await handle({ method: 'GET', path: '/reports', query: {}, headers: {}, body: undefined });
    expect(reports.status).toBe(200);
  });
});
