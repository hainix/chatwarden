import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with JSDoc types; the repo tsconfig does not cover scripts/
import { installArgs, isInside, keepTemp, packagesFor, publishedPackages, PROJECTS, renderTemplate, tarballName, TEMP_PREFIX, timeoutFor } from './smoke.mjs';

describe('tarballName', () => {
  it('maps a scoped name the way npm pack names the file', () => {
    expect(tarballName('@chatwarden/core', '0.1.0')).toBe('chatwarden-core-0.1.0.tgz');
    expect(tarballName('@chatwarden/store-sqlite', '0.1.0')).toBe('chatwarden-store-sqlite-0.1.0.tgz');
  });
  it('maps an unscoped name', () => {
    expect(tarballName('plain', '1.2.3-beta.1')).toBe('plain-1.2.3-beta.1.tgz');
  });
  it('is a bare file name: no slash and no @', () => {
    const file: string = tarballName('@chatwarden/http', '0.1.0');
    expect(file.includes('/') || file.includes('@') || file.includes('\\')).toBe(false);
  });
  it('refuses an empty name or version', () => {
    expect(() => tarballName('', '0.1.0')).toThrow();
    expect(() => tarballName('@chatwarden/core', '')).toThrow();
  });
});

describe('publishedPackages', () => {
  const pkg = (name: string, extra: Record<string, unknown> = {}) => ({ name, version: '0.1.0', ...extra });
  it('drops private packages and sorts by name', () => {
    const out = publishedPackages([pkg('@chatwarden/http'), pkg('@chatwarden/example', { private: true }), pkg('@chatwarden/core')]);
    expect(out.map((p: { name: string }) => p.name)).toEqual(['@chatwarden/core', '@chatwarden/http']);
  });
  it('keeps a package with private: false', () => {
    expect(publishedPackages([pkg('@chatwarden/a', { private: false })])).toHaveLength(1);
  });
  it('returns name, version and the tarball file name', () => {
    expect(publishedPackages([pkg('@chatwarden/core')])).toEqual([
      { name: '@chatwarden/core', version: '0.1.0', tarball: 'chatwarden-core-0.1.0.tgz' },
    ]);
  });
  it('throws when nothing is publishable', () => {
    expect(() => publishedPackages([])).toThrow(/no published/i);
    expect(() => publishedPackages([pkg('x', { private: true })])).toThrow(/no published/i);
  });
});

describe('PROJECTS', () => {
  it('pins TypeScript 5.9 for ESM and 5.7 for CJS', () => {
    expect(PROJECTS.esm.typescript).toBe('5.9');
    expect(PROJECTS.cjs.typescript).toBe('5.7');
  });
});

describe('the consumer projects', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const all = ['@chatwarden/core', '@chatwarden/discord', '@chatwarden/http', '@chatwarden/hub-element', '@chatwarden/hub-react', '@chatwarden/matcher', '@chatwarden/player-react', '@chatwarden/profanity', '@chatwarden/store-memory', '@chatwarden/store-sqlite'].map((name) => ({ name, version: '0.1.2', tarball: tarballName(name, '0.1.2') }));
  it('are ESM, CommonJS and a headless one with no React', () => {
    expect(Object.keys(PROJECTS)).toEqual(['esm', 'cjs', 'headless']);
  });
  it('each has the files its template needs: package.json, tsconfig.json and its scenario', () => {
    for (const [name, p] of Object.entries(PROJECTS) as Array<[string, { scenario: string }]>) {
      for (const f of ['package.json', 'tsconfig.json']) expect(readdirSync(join(root, 'scripts', 'smoke', name)), name).toContain(f);
      expect(readFileSync(join(root, 'scripts', 'smoke', p.scenario), 'utf8').length, p.scenario).toBeGreaterThan(100);
    }
  });
  it('esm and cjs install all ten packages; headless installs only the kit packages hub-react needs, so React never arrives', () => {
    expect(packagesFor('esm', all)).toHaveLength(10);
    expect(packagesFor('cjs', all)).toHaveLength(10);
    expect(packagesFor('headless', all).map((p: { name: string }) => p.name)).toEqual(['@chatwarden/core', '@chatwarden/http', '@chatwarden/hub-react']);
  });
  it('a package the headless project asks for but was not packed is an error, not a quiet skip', () => {
    expect(() => packagesFor('headless', all.filter((p) => p.name !== '@chatwarden/hub-react'))).toThrow(/hub-react/);
  });
  it('headless installs no react, no react-dom, no player-react and no hub-element (each would bring React in)', () => {
    const args: string[] = installArgs('headless', packagesFor('headless', all).map((p: { tarball: string }) => `/t/${p.tarball}`));
    const named = args.filter((a) => !a.startsWith('/t/') && !a.startsWith('-'));
    expect(named).toEqual(['install', '@types/node@22', 'typescript@5.9']);
    // The tarballs are the three kit packages (hub-react itself has "react" in its name, so look at the file names, not a pattern).
    expect(args.filter((a) => a.startsWith('/t/')).map((a) => a.slice(3))).toEqual(['chatwarden-core-0.1.2.tgz', 'chatwarden-http-0.1.2.tgz', 'chatwarden-hub-react-0.1.2.tgz']);
    expect(args).toEqual(expect.arrayContaining(['@types/node@22', 'typescript@5.9']));
  });
  it('esm and cjs also install the types that react-dom/server needs, because the scenario renders the hub on the server', () => {
    for (const project of ['esm', 'cjs']) expect(installArgs(project, ['/t/a.tgz'])).toEqual(expect.arrayContaining(['@types/react@19', '@types/react-dom@19']));
  });
});

describe('installArgs', () => {
  const tarballs = ['/t/chatwarden-core-0.1.0.tgz', '/t/chatwarden-http-0.1.0.tgz'];
  it('installs the tarballs, express 5, its types, node types and the pinned TypeScript', () => {
    const esm = installArgs('esm', tarballs);
    expect(esm[0]).toBe('install');
    expect(esm).toEqual(expect.arrayContaining([...tarballs, 'express@5', '@types/express@5', '@types/node@22', 'typescript@5.9']));
    expect(installArgs('cjs', tarballs)).toContain('typescript@5.7');
    expect(installArgs('cjs', tarballs)).not.toContain('typescript@5.9');
  });
  it('is quiet about audit and funding', () => {
    expect(installArgs('esm', tarballs)).toEqual(expect.arrayContaining(['--no-audit', '--no-fund']));
  });
  it('rejects an unknown project and an empty tarball list', () => {
    expect(() => installArgs('amd', tarballs)).toThrow(/unknown/i);
    expect(() => installArgs('esm', [])).toThrow(/tarball/i);
  });
});

describe('renderTemplate', () => {
  it('replaces every occurrence of a placeholder', () => {
    expect(renderTemplate('a-{{name}}-{{name}}', { name: 'x' })).toBe('a-x-x');
  });
  it('replaces several placeholders and tolerates inner spaces', () => {
    expect(renderTemplate('{{ a }}/{{b}}', { a: '1', b: '2' })).toBe('1/2');
  });
  it('leaves text without placeholders alone', () => {
    expect(renderTemplate('{"a": {"b": 1}}', {})).toBe('{"a": {"b": 1}}');
  });
  it('throws on a placeholder with no value (never ships a literal {{x}})', () => {
    expect(() => renderTemplate('{{missing}}', { other: '1' })).toThrow(/missing/);
  });
  it('does not re-expand a value that itself looks like a placeholder', () => {
    expect(renderTemplate('{{a}}', { a: '{{b}}', b: 'no' })).toBe('{{b}}');
  });
});

describe('timeoutFor', () => {
  it('gives installs (and the build and pack that precede them) 5 minutes', () => {
    expect(timeoutFor('install')).toBe(300_000);
  });
  it('gives runs (typecheck, compile, the scenario) 60 seconds', () => {
    expect(timeoutFor('run')).toBe(60_000);
  });
  it('refuses an unknown kind rather than running without a limit', () => {
    expect(() => timeoutFor('forever')).toThrow(/unknown/i);
    expect(() => timeoutFor(undefined)).toThrow();
  });
});

describe('keepTemp', () => {
  it('keeps the temp projects only when SMOKE_KEEP is exactly 1', () => {
    expect(keepTemp({ SMOKE_KEEP: '1' })).toBe(true);
    expect(keepTemp({})).toBe(false);
    expect(keepTemp({ SMOKE_KEEP: '' })).toBe(false);
    expect(keepTemp({ SMOKE_KEEP: '0' })).toBe(false);
    expect(keepTemp({ SMOKE_KEEP: 'true' })).toBe(false);
  });
});

describe('the temp projects live outside the repository', () => {
  it('names its temp directories chatwarden-smoke-*', () => {
    expect(TEMP_PREFIX).toBe('chatwarden-smoke-');
  });
  it('isInside is true for a descendant and for the directory itself, false for siblings and parents', () => {
    expect(isInside('/repo', '/repo/.smoke/esm')).toBe(true);
    expect(isInside('/repo', '/repo')).toBe(true);
    expect(isInside('/repo', '/repo-other/x')).toBe(false);
    expect(isInside('/repo/.smoke', '/repo')).toBe(false);
    expect(isInside('/repo', '/tmp/chatwarden-smoke-abc')).toBe(false);
  });
  it('the OS temp directory is not inside this repository', () => {
    expect(isInside(fileURLToPath(new URL('..', import.meta.url)), tmpdir())).toBe(false);
  });
});

describe('the smoke scenario', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const scenario = readFileSync(join(root, 'scripts', 'smoke', 'scenario.ts'), 'utf8');
  const published = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => JSON.parse(readFileSync(join(root, 'packages', d.name, 'package.json'), 'utf8')) as { name: string; private?: boolean })
    .filter((m) => m.private !== true)
    .map((m) => m.name);

  const headless = readFileSync(join(root, 'scripts', 'smoke', 'headless.ts'), 'utf8');
  it('imports every published package, so a package left out of the smoke run is caught here', () => {
    // The package itself or one of its subpaths (hub-element is imported as its /standalone script).
    for (const name of published) expect(scenario.includes(`from '${name}'`) || scenario.includes(`from '${name}/`), name).toBe(true);
  });
  it('imports the UI entry points: hub-react, hub-react/headless, player-react and hub-element/standalone', () => {
    for (const spec of ['@chatwarden/hub-react', '@chatwarden/hub-react/headless', '@chatwarden/player-react', '@chatwarden/hub-element/standalone']) {
      expect(scenario, spec).toContain(`from '${spec}'`);
    }
  });
  it('really runs them: a server render of the hub, a player client over the player routes, and the element in Node (no registry, no throw)', () => {
    expect(scenario).toContain('renderToString(');
    expect(scenario).toContain('playerClient(');
    expect(scenario).toContain('defineChatwardenHub()');
  });
  it('the headless project imports hub-react/headless and proves React is absent, by resolve and by import', () => {
    expect(headless).toContain("from '@chatwarden/hub-react/headless'");
    expect(headless).toContain("resolve('react')");
    expect(headless).toContain('import(react)');
    expect(headless).toContain("require('@chatwarden/hub-react/headless')");
    // ...and says what the React entry does without React, so the limit is tested, not assumed.
    expect(headless).toContain('import(reactEntry)');
  });
  it('imports and runs every published subpath, including @chatwarden/http/admin (GET /me)', () => {
    for (const sub of ['@chatwarden/http/express', '@chatwarden/http/admin', '@chatwarden/matcher/fixtures']) expect(scenario, sub).toContain(`from '${sub}'`);
    expect(scenario).toMatch(/adminRoutes\(cw,/);
    expect(scenario).toContain("path: '/me'");
  });
  it('runs the scenario on the in-memory store as well as on SQLite', () => {
    expect(scenario).toContain("from '@chatwarden/store-memory'");
    expect(scenario).toMatch(/createMemoryStore\(\)/);
    expect(scenario).toMatch(/openStore\(\{ path: ':memory:' \}\)/);
  });
});
