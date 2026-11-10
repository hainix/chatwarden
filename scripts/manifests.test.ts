import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Manifest = {
  name: string;
  version: string;
  description?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = <T>(...parts: string[]): T => JSON.parse(readFileSync(join(root, ...parts), 'utf8')) as T;

const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const published = dirs.map((d) => ({ dir: d, pkg: readJson<Manifest>('packages', d, 'package.json') }));
const names = published.map((p) => p.pkg.name);
// The fixed group moves together; read the version from core instead of hardcoding it, so a release does not break this test.
const VERSION = readJson<Manifest>('packages', 'core', 'package.json').version as string;
// The peer range stays at the first release it was written for: a 0.1.0 consumer is not forced to move for a patch.
const PEER_RANGE = '^0.1.0';
const ownScope = (n: string): boolean => n.startsWith('@chatwarden/');
// The React UI packages are new in this release line: they peer on ^0.1.1 (the first version that has the routes they call)
// until the release changeset raises every peer. The exception is named here, so any other package keeps ^0.1.0.
const UI_PEER_RANGE = '^0.1.1';
const UI_PACKAGES = new Set(['@chatwarden/hub-react']);
const peerRangeOf = (pkgName: string): string => (UI_PACKAGES.has(pkgName) ? UI_PEER_RANGE : PEER_RANGE);

describe('published package set', () => {
  it('is the eight expected packages, none private', () => {
    expect(names.sort()).toEqual(
      [
        '@chatwarden/core',
        '@chatwarden/discord',
        '@chatwarden/http',
        '@chatwarden/hub-react',
        '@chatwarden/matcher',
        '@chatwarden/profanity',
        '@chatwarden/store-memory',
        '@chatwarden/store-sqlite',
      ].sort(),
    );
    for (const { pkg } of published) expect(pkg.private).toBe(false);
  });
});

describe('versions', () => {
  it.each(published.map((p) => [p.pkg.name, p.pkg] as const))('%s is at the shared version', (_n, pkg) => {
    expect(pkg.version).toBe(VERSION);
  });
  it.each(published.map((p) => [p.pkg.name, p.dir, p.pkg.version] as const))('%s exports a VERSION constant equal to its manifest version', (_n, dir, version) => {
    const src = readFileSync(join(root, 'packages', dir, 'src', 'index.ts'), 'utf8').replaceAll('\r\n', '\n');
    expect(/^export const VERSION = '([^']*)';$/m.exec(src)?.[1]).toBe(version);
  });
  it('are identical across the fixed group', () => {
    expect(new Set(published.map((p) => p.pkg.version)).size).toBe(1);
  });
});

describe('descriptions', () => {
  it.each(published.map((p) => [p.pkg.name, p.pkg] as const))('%s has a real description, not a placeholder', (_n, pkg) => {
    const d = pkg.description ?? '';
    expect(d.length, 'long enough to say something').toBeGreaterThanOrEqual(40);
    expect(d.length, 'short enough for a search result').toBeLessThanOrEqual(200);
    expect(d).not.toMatch(/^Chatwarden [\w-]+ package\.?$/);
    expect(d.trim().endsWith('.')).toBe(true);
  });
  it('are all different', () => {
    expect(new Set(published.map((p) => p.pkg.description)).size).toBe(published.length);
  });
});

describe('core is a peer, never a dependency', () => {
  const dependents = published.filter((p) => p.pkg.name !== '@chatwarden/core');
  it('core itself has no @chatwarden peers or dependencies', () => {
    const core = published.find((p) => p.pkg.name === '@chatwarden/core')!.pkg;
    for (const field of [core.dependencies, core.peerDependencies])
      expect(Object.keys(field ?? {}).filter(ownScope)).toEqual([]);
  });
  it('core dev-depends on nothing but store-memory (its tests run on the in-memory store)', () => {
    const core = published.find((p) => p.pkg.name === '@chatwarden/core')!.pkg;
    expect(Object.keys(core.devDependencies ?? {}).filter(ownScope)).toEqual(['@chatwarden/store-memory']);
  });
  it.each(dependents.map((p) => [p.pkg.name, p.pkg] as const))(
    '%s peers on core (^0.1.0, UI packages ^0.1.1) and dev-depends on core 0.1.1',
    (_n, pkg) => {
      expect(pkg.peerDependencies?.['@chatwarden/core']).toBe(peerRangeOf(pkg.name));
      expect(pkg.devDependencies?.['@chatwarden/core']).toBe(VERSION);
      expect(pkg.peerDependenciesMeta?.['@chatwarden/core']).toBeUndefined();
    },
  );
  it.each(published.map((p) => [p.pkg.name, p.pkg] as const))(
    '%s lists no @chatwarden/* under dependencies',
    (_n, pkg) => {
      expect(Object.keys(pkg.dependencies ?? {}).filter(ownScope)).toEqual([]);
    },
  );
});

describe('every @chatwarden peer is linked locally at the exact version', () => {
  it.each(published.map((p) => [p.pkg.name, p.pkg] as const))('%s', (_n, pkg) => {
    for (const peer of Object.keys(pkg.peerDependencies ?? {}).filter(ownScope)) {
      expect(pkg.peerDependencies![peer]).toBe(peerRangeOf(pkg.name));
      expect(pkg.devDependencies?.[peer]).toBe(VERSION);
    }
    for (const dev of Object.keys(pkg.devDependencies ?? {}).filter(ownScope)) {
      expect(names).toContain(dev);
      expect(pkg.devDependencies![dev]).toBe(VERSION);
    }
  });
});

describe('store-memory', () => {
  const mem = (): Manifest => published.find((p) => p.pkg.name === '@chatwarden/store-memory')!.pkg;
  it('peers on core only: no other @chatwarden peer, and no runtime dependency at all', () => {
    expect(Object.keys(mem().peerDependencies ?? {})).toEqual(['@chatwarden/core']);
    expect(mem().dependencies).toBeUndefined();
  });
  it('is the browser-safe store: its manifest mentions no node: builtin as a dependency', () => {
    const all = Object.keys({ ...mem().dependencies, ...mem().peerDependencies });
    expect(all.filter((n) => n.startsWith('node:'))).toEqual([]);
  });
});

describe('matcher peers', () => {
  const byName = (n: string): Manifest => published.find((p) => p.pkg.name === n)!.pkg;
  it('profanity peers on matcher and dev-depends on it', () => {
    const p = byName('@chatwarden/profanity');
    expect(p.peerDependencies?.['@chatwarden/matcher']).toBe(PEER_RANGE);
    expect(p.devDependencies?.['@chatwarden/matcher']).toBe(VERSION);
    expect(p.dependencies?.obscenity).toBeDefined();
  });
  it('store-sqlite peers on matcher (its type import) and dev-depends on it', () => {
    const p = byName('@chatwarden/store-sqlite');
    expect(p.peerDependencies?.['@chatwarden/matcher']).toBe(PEER_RANGE);
    expect(p.devDependencies?.['@chatwarden/matcher']).toBe(VERSION);
    // Required, not optional: the store's .d.ts references matcher types, so a consumer without matcher fails typecheck.
    expect(p.peerDependenciesMeta?.['@chatwarden/matcher']?.optional).not.toBe(true);
  });
  it('matcher keeps obscenity as a regular dependency', () => {
    expect(byName('@chatwarden/matcher').dependencies?.obscenity).toBeDefined();
  });
});

describe('http optional peers', () => {
  const http = published.find((p) => p.pkg.name === '@chatwarden/http')!.pkg;
  it('express ^5 and @types/express ^5 are optional peers', () => {
    expect(http.peerDependencies?.express).toBe('^5.0.0');
    expect(http.peerDependencies?.['@types/express']).toBe('^5.0.0');
    expect(http.peerDependenciesMeta?.express?.optional).toBe(true);
    expect(http.peerDependenciesMeta?.['@types/express']?.optional).toBe(true);
  });
  it('express stays installed for the tests as a dev dependency', () => {
    expect(http.devDependencies?.express).toBeDefined();
    expect(http.devDependencies?.['@types/express']).toBeDefined();
  });
  it('express is not a regular dependency', () => {
    expect(http.dependencies?.express).toBeUndefined();
  });
});

describe('hub-react', () => {
  const hub = (): Manifest & { sideEffects?: unknown; exports?: Record<string, unknown> } =>
    published.find((p) => p.pkg.name === '@chatwarden/hub-react')!.pkg as Manifest & { sideEffects?: unknown; exports?: Record<string, unknown> };
  it('peers on react, react-dom, core and http; bundles none of them', () => {
    expect(Object.keys(hub().peerDependencies ?? {}).sort()).toEqual(['@chatwarden/core', '@chatwarden/http', 'react', 'react-dom']);
    expect(hub().peerDependencies?.react).toBe('^18.3.0 || ^19.0.0');
    expect(hub().peerDependencies?.['react-dom']).toBe('^18.3.0 || ^19.0.0');
    expect(hub().peerDependencies?.['@chatwarden/http']).toBe('^0.1.1');
    expect(hub().dependencies).toBeUndefined();
  });
  it('ships one stylesheet as ./styles.css and lists only it under sideEffects', () => {
    expect(hub().exports?.['./styles.css']).toBe('./src/styles.css');
    expect(hub().sideEffects).toEqual(['./src/styles.css']);
  });
  it('dev-depends on the kit the tests run on and on the test tools, not as peers', () => {
    for (const d of ['@chatwarden/matcher', '@chatwarden/store-memory', 'react', 'react-dom', 'axe-core', 'jsdom', '@testing-library/react', '@testing-library/user-event']) {
      expect(hub().devDependencies?.[d], d).toBeDefined();
    }
  });
});

describe('tiny-chat example', () => {
  const tiny = readJson<Manifest>('examples', 'tiny-chat', 'package.json');
  it('is private and named as the changeset config expects', () => {
    expect(tiny.private).toBe(true);
    expect(tiny.name).toBe('@chatwarden/example-tiny-chat');
  });
  it('depends on every published server package as a regular dependency at the group version (the React UI packages are for a front end)', () => {
    for (const n of names.filter((n) => !UI_PACKAGES.has(n))) expect(tiny.dependencies?.[n]).toBe(VERSION);
  });
});

describe('changesets config', () => {
  const config = readJson<{ fixed: string[][]; ignore: string[]; linked: string[][] }>('.changeset', 'config.json');
  it('versions every @chatwarden package together', () => {
    expect(config.fixed).toEqual([['@chatwarden/*']]);
  });
  it('ignores the example and the landing site (private, never versioned or published)', () => {
    expect(config.ignore).toEqual(['@chatwarden/example-tiny-chat', '@chatwarden/site']);
  });
  it('has no linked groups', () => {
    expect(config.linked).toEqual([]);
  });
  it('ignores only private packages', () => {
    const tiny = readJson<Manifest>('examples', 'tiny-chat', 'package.json');
    const site = readJson<Manifest>('site', 'package.json');
    expect(config.ignore).toEqual([tiny.name, site.name]);
    expect(tiny.private).toBe(true);
    expect(site.private).toBe(true);
    expect(site.name).toBe('@chatwarden/site');
  });
  it('keeps the landing site out of the published package set', () => {
    expect(names).not.toContain('@chatwarden/site');
  });
});
