import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as http from '../src/index.js';
import * as fetchModule from '../src/fetch.js';
import type { FetchHandler, FetchOptions, Mounts } from '../src/fetch.js';

// `@chatwarden/http/fetch` runs in a browser, a Worker, Bun and Deno as well as Node: it imports no `node:` module (so no Buffer either), and
// the browser-bundle test bundles it from its built dist. The words for the two Node globals are left out of this module's text altogether, so the
// bundle test's scan for them has nothing to find.

const source = readFileSync(new URL('../src/fetch.ts', import.meta.url), 'utf8');
const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

describe('the module is browser-safe', () => {
  it('imports no node: module and no Buffer, and only the kit modules that are themselves browser-safe', () => {
    expect(code).not.toMatch(/from\s+['"]node:/);
    expect(code).not.toMatch(/import\s*\(/);
    expect(code).not.toMatch(/\bBuffer\b/);
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect([...new Set(imports)].sort()).toEqual(['./body.js', './errors.js', './router.js', './types.js', '@chatwarden/core'].sort());
  });

  it('never names the two Node globals, even in a comment (the bundle test scans for them)', () => {
    expect(source).not.toMatch(/\bprocess\b/);
    expect(source).not.toMatch(/\brequire\b/);
    expect(source).not.toMatch(/\bmodule\.exports\b/);
  });

  it('the browser bundle test bundles it: its entry names the subpath', () => {
    const entry = readFileSync(new URL('../../../scripts/browser-entry.ts', import.meta.url), 'utf8');
    expect(entry).toContain('@chatwarden/http/fetch');
  });
});

describe('exports', () => {
  it('toFetch and the three types are exported from the root and from ./fetch', () => {
    expect(typeof fetchModule.toFetch).toBe('function');
    expect(http.toFetch).toBe(fetchModule.toFetch);
    // The types have no run-time binding.
    for (const name of ['Mounts', 'FetchOptions', 'FetchHandler']) {
      expect(name in http, name).toBe(false);
      expect(name in fetchModule, name).toBe(false);
    }
    const rootText = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(rootText).toMatch(/export \{ toFetch \} from '\.\/fetch\.js'/);
    expect(rootText).toMatch(/export type \{[^}]*\bFetchHandler\b[^}]*\} from '\.\/fetch\.js'/);
    expect(rootText).toMatch(/export type \{[^}]*\bFetchOptions\b[^}]*\} from '\.\/fetch\.js'/);
    expect(rootText).toMatch(/export type \{[^}]*\bMounts\b[^}]*\} from '\.\/fetch\.js'/);
    // They can be named, and mean what the design says.
    const options: FetchOptions = { prefix: '/chatwarden', maxBody: 1024, unmatched: 'pass', remoteAddress: () => undefined };
    const mounts: Mounts = { '/admin': {} };
    const handler: FetchHandler = http.toFetch(mounts, { prefix: options.prefix });
    expect(typeof handler).toBe('function');
  });

  it('package.json has the ./fetch subpath, with types, and the typesVersions entry for CommonJS-era resolution', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>;
      typesVersions: Record<string, Record<string, string[]>>;
    };
    expect(manifest.exports['./fetch']).toEqual({ types: './dist/src/fetch.d.ts', default: './dist/src/fetch.js' });
    expect(manifest.typesVersions['*']?.fetch).toEqual(['dist/src/fetch.d.ts']);
    // The other subpaths are untouched.
    for (const subpath of ['.', './admin', './chat', './express']) expect(manifest.exports[subpath]).toBeDefined();
  });

  it('the vitest alias for the subpath comes before the package root, or the root would swallow it', () => {
    const config = readFileSync(new URL('../../../vitest.config.ts', import.meta.url), 'utf8');
    const fetchAt = config.indexOf("find: '@chatwarden/http/fetch'");
    const rootAt = config.indexOf("find: '@chatwarden/http',");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(rootAt).toBeGreaterThan(fetchAt);
  });
});
