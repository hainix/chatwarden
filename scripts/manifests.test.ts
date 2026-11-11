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
  optionalDependencies?: Record<string, string>;
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
// The peer range stays at the first release it was written for: a 0.1.0 consumer is not forced to move for a patch...
const PEER_RANGE = '^0.1.0';
// ...except where a package needs what is new in 0.1.2: cw.policy, ResolvedProfile, reporting, reportedReason, addDetail, releaseWhenDone,
// the take-next reason, detailUntil and the store policy, claim, reason and report-detail methods (a store's own types name them, and
// the staff routes and both React packages call them). That floor is raised on purpose, which overrides changesets'
// onlyUpdatePeerDependentsWhenOutOfRange (see RELEASING.md, "When a peer floor must rise"). discord, matcher and profanity use none of it.
const NEW_KIT_RANGE = '^0.1.2';
const NEEDS_NEW_KIT = new Set([
  '@chatwarden/store-memory',
  '@chatwarden/store-sqlite',
  '@chatwarden/http',
  '@chatwarden/hub-react',
  '@chatwarden/player-react',
]);
const ownScope = (n: string): boolean => n.startsWith('@chatwarden/');
const UI_PACKAGES = new Set(['@chatwarden/hub-react', '@chatwarden/player-react', '@chatwarden/hub-element']);
// hub-element bundles React, hub-react and the little of core it needs into its own script, so it peers on none of them (hub-react is an
// optional peer for the types only).
const BUNDLED = new Set(['@chatwarden/hub-element']);
/** The range `pkgName` must declare for its peer `peerName`. */
const peerRangeOf = (pkgName: string, peerName: string): string => {
  if (peerName === '@chatwarden/core') return NEEDS_NEW_KIT.has(pkgName) ? NEW_KIT_RANGE : PEER_RANGE;
  // hub-react calls the staff routes that are new in 0.1.2; hub-element's types are hub-react's.
  if (peerName === '@chatwarden/http' || peerName === '@chatwarden/hub-react') return NEW_KIT_RANGE;
  return PEER_RANGE;
};

describe('published package set', () => {
  it('is the ten expected packages, none private', () => {
    expect(names.sort()).toEqual(
      [
        '@chatwarden/core',
        '@chatwarden/discord',
        '@chatwarden/http',
        '@chatwarden/hub-element',
        '@chatwarden/hub-react',
        '@chatwarden/matcher',
        '@chatwarden/player-react',
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
  const dependents = published.filter((p) => p.pkg.name !== '@chatwarden/core' && !BUNDLED.has(p.pkg.name));
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
    '%s peers on core at its floor (^0.1.0, or ^0.1.2 where it needs the 0.1.2 kit) and dev-depends on core at the group version',
    (_n, pkg) => {
      expect(pkg.peerDependencies?.['@chatwarden/core']).toBe(peerRangeOf(pkg.name, '@chatwarden/core'));
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
      expect(pkg.peerDependencies![peer]).toBe(peerRangeOf(pkg.name, peer));
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

describe('peer floors', () => {
  const byName = (n: string): Manifest => published.find((p) => p.pkg.name === n)!.pkg;
  it.each([...NEEDS_NEW_KIT])('%s needs core ^0.1.2', (name) => {
    expect(byName(name).peerDependencies?.['@chatwarden/core']).toBe('^0.1.2');
  });
  it.each(['@chatwarden/discord', '@chatwarden/matcher', '@chatwarden/profanity'])('%s uses nothing new in core and keeps ^0.1.0', (name) => {
    expect(byName(name).peerDependencies?.['@chatwarden/core']).toBe('^0.1.0');
  });
  it('hub-react peers on http ^0.1.2 and hub-element on hub-react ^0.1.2 (the routes and types they call are new)', () => {
    expect(byName('@chatwarden/hub-react').peerDependencies?.['@chatwarden/http']).toBe('^0.1.2');
    expect(byName('@chatwarden/hub-element').peerDependencies?.['@chatwarden/hub-react']).toBe('^0.1.2');
  });
  it('every @chatwarden floor is a caret range the group version satisfies, so each can be installed', () => {
    const [maj, min, pat] = VERSION.split('.').map(Number) as [number, number, number];
    for (const { pkg } of published) {
      for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {}).filter(([n]) => ownScope(n))) {
        const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
        expect(m, `${pkg.name} peer ${peer} is a caret range`).not.toBeNull();
        const [a, b, c] = m!.slice(1).map(Number) as [number, number, number];
        expect(a === maj && (b < min || (b === min && c <= pat)), `${pkg.name} peer ${peer} ${range} is satisfied by ${VERSION}`).toBe(true);
      }
    }
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
  it('matcher no longer depends on obscenity at run time: it is a devDependency (the parity and version-pin tests only)', () => {
    const m = byName('@chatwarden/matcher');
    // The packed matcher must not pull obscenity (and its English word list, issue #8) into a consumer's install.
    expect(m.dependencies?.obscenity).toBeUndefined();
    expect(m.peerDependencies?.obscenity).toBeUndefined();
    expect(m.optionalDependencies?.obscenity).toBeUndefined();
    expect(m.devDependencies?.obscenity).toBe('^0.4.6');
  });
  it('profanity still needs obscenity at run time (its own filter)', () => {
    expect(byName('@chatwarden/profanity').dependencies?.obscenity).toBeDefined();
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
    expect(hub().peerDependencies?.['@chatwarden/http']).toBe(NEW_KIT_RANGE);
    expect(hub().dependencies).toBeUndefined();
  });
  it('ships the stylesheet as ./styles.css and the optional font as ./font.css, and lists only those under sideEffects', () => {
    expect(hub().exports?.['./styles.css']).toBe('./src/styles.css');
    expect(hub().exports?.['./font.css']).toBe('./font.css');
    expect(hub().sideEffects).toEqual(['./src/styles.css', './font.css']);
  });
  it('marks react and react-dom as optional peers, so the headless entry installs without React (and the kit peers stay required)', () => {
    const meta = hub().peerDependenciesMeta ?? {};
    expect(meta.react).toEqual({ optional: true });
    expect(meta['react-dom']).toEqual({ optional: true });
    expect(meta['@chatwarden/core']?.optional).not.toBe(true);
    expect(meta['@chatwarden/http']?.optional).not.toBe(true);
    // Still declared, with their ranges: the React hub needs them.
    expect(hub().peerDependencies?.react).toBe('^18.3.0 || ^19.0.0');
    expect(hub().peerDependencies?.['react-dom']).toBe('^18.3.0 || ^19.0.0');
  });
  it('exports the headless controller as ./headless, from dist, with types, and nothing else from it', () => {
    expect(hub().exports?.['./headless']).toEqual({ types: './dist/src/headless/index.d.ts', default: './dist/src/headless/index.js' });
    // A subpath that is ESM and types only: no `require` condition, no CSS, no side effects.
    expect(Object.keys(hub().exports?.['./headless'] as object)).toEqual(['types', 'default']);
    // ...and older module resolution (node10) finds the types through typesVersions.
    expect((hub() as { typesVersions?: unknown }).typesVersions).toEqual({ '*': { headless: ['dist/src/headless/index.d.ts'] } });
  });
  it('dev-depends on the kit the tests run on and on the test tools, not as peers', () => {
    for (const d of ['@chatwarden/matcher', '@chatwarden/store-memory', 'react', 'react-dom', 'axe-core', 'jsdom', '@testing-library/react', '@testing-library/user-event']) {
      expect(hub().devDependencies?.[d], d).toBeDefined();
    }
  });
});

describe('player-react', () => {
  const player = (): Manifest & { sideEffects?: unknown; exports?: Record<string, unknown> } =>
    published.find((p) => p.pkg.name === '@chatwarden/player-react')!.pkg as Manifest & { sideEffects?: unknown; exports?: Record<string, unknown> };
  it('peers on react, react-dom and core only, at the hub ranges; bundles none of them', () => {
    expect(Object.keys(player().peerDependencies ?? {}).sort()).toEqual(['@chatwarden/core', 'react', 'react-dom']);
    expect(player().peerDependencies?.react).toBe('^18.3.0 || ^19.0.0');
    expect(player().peerDependencies?.['react-dom']).toBe('^18.3.0 || ^19.0.0');
    expect(player().peerDependencies?.['@chatwarden/core']).toBe(NEW_KIT_RANGE);
    expect(player().dependencies).toBeUndefined();
  });
  it('ships the stylesheet as ./styles.css and lists only it under sideEffects', () => {
    expect(player().exports?.['./styles.css']).toBe('./src/styles.css');
    expect(player().sideEffects).toEqual(['./src/styles.css']);
  });
  it('dev-depends on the kit the tests run on, on hub-react for the transport type check, and on the test tools, not as peers', () => {
    for (const d of ['@chatwarden/http', '@chatwarden/store-memory', '@chatwarden/hub-react', 'react', 'react-dom', 'axe-core', 'jsdom', '@testing-library/react', '@testing-library/user-event']) {
      expect(player().devDependencies?.[d], d).toBeDefined();
    }
  });
});

describe('hub-element', () => {
  const element = (): Manifest & { sideEffects?: unknown; exports?: Record<string, unknown>; files?: string[] } =>
    published.find((p) => p.pkg.name === '@chatwarden/hub-element')!.pkg as Manifest & { sideEffects?: unknown; exports?: Record<string, unknown>; files?: string[] };
  it('bundles React, react-dom, hub-react and the part of core it needs: no react peer, no dependency, hub-react only as an optional peer for the types', () => {
    expect(Object.keys(element().peerDependencies ?? {})).toEqual(['@chatwarden/hub-react']);
    expect(element().peerDependencies?.['@chatwarden/hub-react']).toBe(NEW_KIT_RANGE);
    expect(element().peerDependenciesMeta?.['@chatwarden/hub-react']).toEqual({ optional: true });
    expect(element().dependencies).toBeUndefined();
  });
  it('ships the module as . and the self-registering script as ./standalone, each with types, and lists the script under sideEffects', () => {
    expect(element().exports?.['.']).toEqual({ types: './dist/src/index.d.ts', default: './dist/index.js' });
    expect(element().exports?.['./standalone']).toEqual({ types: './dist/src/standalone.d.ts', default: './dist/hub-element.js' });
    expect(element().sideEffects).toEqual(['./dist/hub-element.js']);
  });
  it('builds its scripts in prepack, after tsc, and ships both', () => {
    expect((element() as { scripts?: Record<string, string> }).scripts?.prepack).toBe('tsc -b && node build/build.mjs');
    expect(element().files).toContain('dist/hub-element.js');
    expect(element().files).toContain('dist/index.js');
    expect(element().files).toContain('dist/THIRD_PARTY_NOTICES.txt');
  });
  it('dev-depends on what it bundles and on the tools that build and test it, not as peers', () => {
    for (const d of ['@chatwarden/core', '@chatwarden/http', '@chatwarden/hub-react', '@chatwarden/matcher', '@chatwarden/store-memory', 'react', 'react-dom', 'esbuild', 'jsdom', 'playwright', '@testing-library/dom', '@testing-library/user-event']) {
      expect(element().devDependencies?.[d], d).toBeDefined();
    }
  });
});

describe('tiny-chat example', () => {
  const tiny = readJson<Manifest>('examples', 'tiny-chat', 'package.json');
  it('is private and named as the changeset config expects', () => {
    expect(tiny.private).toBe(true);
    expect(tiny.name).toBe('@chatwarden/example-tiny-chat');
  });
  it('depends on every published server package as a regular dependency at the group version (the React packages are for a front end)', () => {
    for (const n of names.filter((n) => !UI_PACKAGES.has(n))) expect(tiny.dependencies?.[n]).toBe(VERSION);
  });
  it('serves the hub from @chatwarden/hub-element, the one script tag that needs no React build, and so does not depend on the React packages', () => {
    expect(tiny.dependencies?.['@chatwarden/hub-element']).toBe(VERSION);
    expect(tiny.dependencies?.['@chatwarden/hub-react']).toBeUndefined();
    expect(tiny.dependencies?.['@chatwarden/player-react']).toBeUndefined();
    expect(tiny.dependencies?.react).toBeUndefined();
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
