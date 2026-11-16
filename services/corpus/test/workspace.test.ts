import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (...p: string[]) => readFileSync(new URL(`../../../${p.join('/')}`, import.meta.url), 'utf8');
const json = <T>(...p: string[]) => JSON.parse(read(...p)) as T;

interface Manifest {
  name: string;
  private?: boolean;
  version: string;
  workspaces?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe('the workspace builds with tsc -b and lints', () => {
  it('is a private workspace at 0.0.0 with only wrangler and the Workers types as dev dependencies', () => {
    const pkg = json<Manifest>('services', 'corpus', 'package.json');
    expect(pkg.name).toBe('@chatwarden/corpus-service');
    expect(pkg.private).toBe(true);
    expect(pkg.version).toBe('0.0.0');
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual(['@cloudflare/workers-types', 'wrangler']);
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@chatwarden/matcher']);
  });

  it('is in the root workspaces, the root project references, the kit test project and the changeset ignore list', () => {
    expect(json<Manifest>('package.json').workspaces).toContain('services/*');
    const refs = json<{ references: { path: string }[] }>('tsconfig.json').references.map((r) => r.path);
    expect(refs).toContain('services/corpus');
    expect(refs).toContain('services/corpus/types-check');
    expect(read('vitest.config.ts')).toContain("'services/*/test/**/*.test.ts'");
    expect(json<{ ignore: string[] }>('.changeset', 'config.json').ignore).toContain('@chatwarden/corpus-service');
  });

  it('keeps the service out of every published-package step: no packages/ entry, no release script names it', () => {
    const rootPkg = json<Manifest>('package.json');
    expect(JSON.stringify(rootPkg.scripts)).not.toContain('services');
    expect(read('.github', 'workflows', 'release.yml')).not.toContain('corpus-service');
  });

  it('has a wrangler.jsonc with placeholders only: no account id, no real database id, no secret value', () => {
    const text = read('services', 'corpus', 'wrangler.jsonc');
    expect(text).toContain('REPLACE_AT_DEPLOY');
    expect(text).not.toMatch(/account_id/);
    expect(text).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/);
    expect(text).not.toMatch(/\b[0-9a-f]{32}\b/);
    expect(text).not.toMatch(/"(COUNTER_SECRET|TURNSTILE_SECRET)"\s*:/);
  });

  it('compiles with tsc -b (the source, the tests and the Workers-types conformance check)', () => {
    const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
    const run = spawnSync(process.execPath, [tsc, '-b', 'services/corpus', 'services/corpus/types-check'], { cwd: root, encoding: 'utf8' });
    expect(run.stdout + run.stderr).toBe('');
    expect(run.status).toBe(0);
  }, 240_000);

  it('lints clean', () => {
    const eslint = fileURLToPath(new URL('../../../node_modules/eslint/bin/eslint.js', import.meta.url));
    const run = spawnSync(process.execPath, [eslint, 'services/corpus'], { cwd: root, encoding: 'utf8' });
    expect(run.stdout + run.stderr).toBe('');
    expect(run.status).toBe(0);
  }, 240_000);
});
